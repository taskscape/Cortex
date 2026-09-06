import type { MatbotPluginSpec, MatbotMachine, PluginSettings } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makePluginSettings, type SettingsDoc } from '@matatbread/matbot-core';
import { BrowserStorageBackend, assertBrowserRealm } from './storage-backend.js';
import { type ExtraPlugins } from './plugin-tool.js';

const EXTRA_KEY = 'extra-plugins';

/**
 * The browser defaults plugin. Supplies the platform storage backend (IndexedDB + OPFS) and the
 * browser `plugin` management tool — the browser analogue of the node app's filesystem stores and
 * built-in `plugin` tool, but shipped as a plugin (not core), so the web build is assembled purely
 * from plugins over a platform-neutral core.
 *
 * Because the browser has no matbot.yaml, this plugin also owns the durable list of *user-added*
 * plugins: `add`/`remove` persist into its own settings (IndexedDB), and `setup()` replays them on
 * boot via `services.loadPlugin`, so a session's installed plugins survive a realm reload.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest:   { description: 'Browser defaults: IndexedDB + OPFS storage backend and the browser plugin manager.' },

  storageBackend: {
    open: (dotData: string) => BrowserStorageBackend.open(dotData),
  },

  /**
   * Activate the browser defaults: refuse non-browser realms, become the active StorageBackend
   * when the boot pre-scan did not already open this plugin's backend, publish the persisted
   * user-added plugin list (pinned to the concrete local IndexedDB store so it survives later
   * backend swaps), and replay that list via `services.loadPlugin` — stale specifiers are
   * warned and skipped so boot never aborts.
   * @param services - Machine passed to the plugin's setup.
   * @returns Resolves once registration and replay complete.
   * @throws Error - Re-thrown from assertBrowserRealm when not running in a browser; replay
   *          failures are swallowed by design.
   */
  async setup(services: MatbotMachine): Promise<void> {
    // Browser-only: on node this throws, the loader logs and skips the plugin, and the host keeps its
    // real (filesystem) backend — no dead config.
    assertBrowserRealm();

    // Hot-load path: if we weren't activated by the boot pre-scan, become the backend now so all
    // stores (including the settings store this plugin uses below) land in IndexedDB.
    if (!(services.StorageBackend instanceof BrowserStorageBackend)) {
      await services.register('StorageBackend', await BrowserStorageBackend.open(''));
    }

    // Bind the extras list to the backend that is active *now* (the local IndexedDB default), captured
    // concretely so it survives a later StorageBackend swap. `services.settings()` goes through the
    // swappable store proxy, so if a plugin swaps the backend during its own load (e.g. the Google
    // Drive backend, mid-`add`), the post-load write would land in the *new* backend while boot reads
    // the default and never finds it — that plugin would silently fail to persist itself into the
    // auto-load list, and `remove` would write to the wrong store too. Capturing the concrete store
    // (BrowserStorageBackend caches per namespace, so this is the very same IndexedDB store/doc the
    // proxy used — no migration, no data move) pins the list to local storage regardless of swaps.
    // The namespace is this plugin's name, matching what `services.settings()` used before.
    const backend = services.StorageBackend;
    const settings: PluginSettings = backend !== undefined
      ? makePluginSettings(backend.createStore<SettingsDoc>('settings'), services.self?.name ?? 'matbot-browser')
      : services.settings();
    const extras: ExtraPlugins = {
      /**
       * Read the persisted user-added plugin specifiers.
       * @returns The stored specifiers in insertion order, or an empty array when none stored.
       * @throws Error - Propagates settings-store failures.
       */
      async list() {
        return (await settings.get<string[]>(EXTRA_KEY)) ?? [];
      },
      /**
       * Append a specifier to the persisted list; already-present specifiers are ignored
       * (idempotent).
       * @param specifier Specifier to persist.
       * @returns Resolves once the list is written, or found to already contain the specifier.
       * @throws Error - Propagates settings-store failures.
       */
      async add(specifier: string) {
        const cur = (await settings.get<string[]>(EXTRA_KEY)) ?? [];
        if (!cur.includes(specifier)) await settings.set(EXTRA_KEY, [...cur, specifier]);
      },
      /**
       * Drop a specifier from the persisted list (no-op when absent).
       * @param specifier Specifier to forget.
       * @returns Resolves once the updated list is written.
       * @throws Error - Propagates settings-store failures.
       */
      async remove(specifier: string) {
        const cur = (await settings.get<string[]>(EXTRA_KEY)) ?? [];
        await settings.set(EXTRA_KEY, cur.filter(s => s !== specifier));
      },
    };

    await services.register('BrowserPluginPersistence',extras);

    // Replay user-added plugins from a previous realm. Failures are warned and skipped — a stale
    // specifier (a URL that 404s now) must not abort boot.
    for (const specifier of await extras.list()) {
      try {
        await services.loadPlugin(specifier);
      } catch (e) {
        console.warn(`[matbot-browser] Could not replay persisted plugin "${specifier}":`, e);
      }
    }
  },
};
