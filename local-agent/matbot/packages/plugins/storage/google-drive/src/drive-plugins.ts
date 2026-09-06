import type { Store, Tool, ToolEvent, ToolContext } from '@matatbread/matbot-plugin-api';
import { getSpecifierForPlugin } from '@matatbread/matbot-core';
import { createBrowserPluginTool } from '@matatbread/matbot-browser';

const DOC_ID = 'manifest';

/**
 * The persisted manifest document: one record in the `plugin-manifest`
 * namespace holding the synced plugin specifiers.
 */
interface ManifestDoc {
  id:         string;
  version:    string;
  specifiers: string[];
}

/**
 * The Drive-synced plugin set, persisted as one doc in the active StorageBackend's `plugin-manifest`
 * namespace (Drive, once this plugin is active). This is *separate* from the browser plugin's local
 * `extra-plugins` list: the local loader is unchanged and keeps managing whatever was installed
 * locally (including this plugin itself), while this set holds what's added once Drive is connected
 * and is restored when the Drive plugin loads. Symmetric ownership — each loader restores its own set.
 *
 * Its shape satisfies the browser plugin tool's `ExtraPlugins` persistence interface, so the very
 * same `plugin` tool can be backed by Drive instead of IndexedDB (see {@link createSyncedPluginTool}).
 */
export class DrivePluginSet {
  private readonly store: Store<ManifestDoc>;

  /**
   * Creates the set over a manifest store.
   * @param store - Store holding the manifest document (the `plugin-manifest`
   *   namespace of the active backend).
   * @throws Never.
   */
  constructor(store: Store<ManifestDoc>) {
    this.store = store;
  }

  /**
   * Reads the synced specifiers from the manifest.
   * @returns The specifiers, or an empty array when the manifest is absent.
   * @throws Propagates store read errors.
   */
  async list(): Promise<string[]> {
    return (await this.store.get(DOC_ID))?.specifiers ?? [];
  }

  /**
   * Adds a plugin specifier to the manifest. No-op when already present;
   * otherwise the whole manifest document is rewritten with a fresh random
   * version — a plain `set`, not a CAS.
   * @param specifier - Plugin specifier to record.
   * @returns Resolves once the manifest is written (immediately when the
   *   specifier is already present).
   * @throws Propagates store read/write errors.
   */
  async add(specifier: string): Promise<void> {
    const cur = await this.list();
    if (cur.includes(specifier)) return;
    await this.store.set(DOC_ID, { id: DOC_ID, version: crypto.randomUUID(), specifiers: [...cur, specifier] });
  }

  /**
   * Removes a plugin specifier from the manifest. The document is rewritten
   * even when the specifier was absent (the filter is then a no-op).
   * @param specifier - Plugin specifier to drop.
   * @returns Resolves once the manifest is written.
   * @throws Propagates store read/write errors.
   */
  async remove(specifier: string): Promise<void> {
    const cur = await this.list();
    await this.store.set(DOC_ID, { id: DOC_ID, version: crypto.randomUUID(), specifiers: cur.filter(s => s !== specifier) });
  }
}

/**
 * The `plugin` tool, **shadowing** the browser build's built-in one (same name, so the model and the
 * frontend `/tools` path can't tell the difference — there is exactly one `plugin` tool, no ambiguous
 * second). It reuses the browser plugin tool factory verbatim but backs persistence with the
 * Drive-synced set, so `add` now syncs the install across machines.
 *
 * Routing is by *which set a plugin belongs to*, derived from the live Drive set (no stored
 * provenance needed while there are just two managers):
 *  - `add` → always the Drive set (that's the sync behaviour).
 *  - `remove`/`reload` → if the target is Drive-synced, act on Drive; **otherwise delegate to the
 *    original (local) tool**. That covers plugins installed locally before Drive was connected *and*
 *    this Google Drive plugin itself (it lives in the local extras, not the Drive set — a Drive
 *    remove couldn't uninstall it, it'd just reload next boot). Delegation, not a silent no-op.
 *  - `list` → annotates each loaded plugin with whether it's Drive-synced or local-only.
 *
 * @param driveSet - The synced manifest store.
 * @param original - The underlying (local) plugin tool, if any; `remove`/
 *   `reload` of non-synced plugins delegate to it.
 * @returns The wrapped tool.
 * @throws Never.
 */
export function createSyncedPluginTool(driveSet: DrivePluginSet, original: Tool | null): Tool {
  const driveTool = createBrowserPluginTool(driveSet);
  return {
    ...driveTool,
    description:
      driveTool.description +
      '\n\nIn this install, `add` saves the plugin to your Google Drive, so it appears on every ' +
      'browser where Drive is connected. `remove`/`reload` of a plugin that is NOT Drive-synced ' +
      '(including the Google Drive plugin itself) is handled locally, on this browser only. `list` ' +
      'marks each plugin as Drive-synced or local-only.',
    executor: {
      /**
       * Routes a plugin tool invocation: `remove`/`reload` of a plugin not in
       * the Drive set delegates to the original tool; `list` annotates each
       * entry with `managedBy`; everything else goes to the Drive-backed tool.
       * @param input - Tool input (`action`, `specifier`).
       * @param ctx - Tool execution context.
       * @yields The delegated or wrapped tool's events.
       * @throws Propagates errors from `driveSet.list()` and the delegated
       *   tools.
       */
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const { action, specifier } = input as { action?: string; specifier?: string };

        if ((action === 'remove' || action === 'reload') && specifier && original) {
          const drive = await driveSet.list();
          const entry = getSpecifierForPlugin(specifier) ?? specifier;
          const inDrive = drive.includes(specifier) || drive.includes(entry);
          if (!inDrive) { yield* original.executor.execute(input, ctx); return; }
        }

        if (action === 'list') {
          const drive = await driveSet.list();
          /**
           * Whether a plugin belongs to the Drive set, checked by name or
           * specifier.
           * @param name - Plugin display name.
           * @param spec - Plugin specifier.
           * @returns True when the Drive manifest lists it.
           * @throws Never.
           */
          const synced = (name: string, spec: string) => drive.includes(spec) || drive.includes(name);
          for await (const ev of driveTool.executor.execute(input, ctx)) {
            if (ev.type === 'result' && ev.value !== null && typeof ev.value === 'object' && 'loaded' in ev.value) {
              const v = ev.value as Record<string, unknown> & { loaded: { name: string; specifier: string }[] };
              const loaded = v.loaded.map(p => ({ ...p, managedBy: synced(p.name, p.specifier) ? 'google-drive (synced across browsers)' : 'local (this browser only)' }));
              yield { type: 'result', value: { ...v, loaded } };
            } else {
              yield ev;
            }
          }
          return;
        }

        yield* driveTool.executor.execute(input, ctx);
      },
    },
  };
}
