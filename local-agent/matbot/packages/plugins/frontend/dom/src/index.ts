import type { MatbotPluginSpec, MatbotMachine, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { ChatUI } from './ui.js';

// No HTTP server in-process, so a file is addressed by materialising its bytes into a `blob:` URL.
// These are page-scoped and deliberately never revoked — the URL is handed straight to the user/DOM,
// and revoking would break a link still in view; the leak is bounded by the document lifetime.
// Same default-deny gate as the served frontend: only files marked `allowed` get a URL.
const urlForResourceTool: Tool = {
  name: 'url_for_resource',
  description:
    'Return a URL for a stored file the user can open, or null when it is not publicly viewable. Use this ' +
    'to hand the user a link to a file (e.g. a workspace artifact) rather than guessing a path. Only files ' +
    'marked viewable are served — workspace files are (namespace "workspace"); most other namespaces return null.\n\n' +
    'Parameters: { namespace: string, name: string } — `name` is the file path within the namespace (for a ' +
    'workspace file, the same path you wrote it under).',
  inputSchema: {
    type:     'object',
    required: ['namespace', 'name'],
    properties: {
      namespace: { type: 'string', description: 'The file namespace, e.g. "workspace".' },
      name:      { type: 'string', description: 'The file path/name within the namespace.' },
    },
  },
  executor: {
    /**
     * Resolves a stored file to a `blob:` URL the user can open.
     *
     * Default-deny: a missing file store, an unknown file, or one not marked `allowed` yields
     * `{ url: null }` rather than an error. A viewable file is fully materialised into memory (its
     * stream is drained into one `Uint8Array`) because `blob:` URLs are page-scoped and the bytes
     * must exist up front; the read is cancelled via `ctx.signal`.
     *
     * @param input - Expected `{ namespace: string, name: string }`; a missing or empty field
     *                yields an `error` event.
     * @param ctx - Tool execution context: `ctx.files` resolves the file handle, `ctx.signal`
     *                cancels the byte read.
     * @yields A single `result` event whose `value.url` is the `blob:` URL or `null`.
     * @throws Error - If the file store or the file stream fails; malformed input and unresolvable
     *                files are reported by yielding events instead.
     */
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { namespace, name } = input as { namespace?: string; name?: string };
      if (!namespace || !name) { yield { type: 'error', message: 'url_for_resource requires "namespace" and "name".' }; return; }
      if (!ctx.files) { yield { type: 'result', value: { url: null } }; return; }
      const handle = await ctx.files.getByName(name, namespace);
      if (!handle || !handle.allowed) { yield { type: 'result', value: { url: null } }; return; }

      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of handle.stream(ctx.signal)) { chunks.push(chunk); total += chunk.byteLength; }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      yield { type: 'result', value: { url: URL.createObjectURL(new Blob([bytes], { type: handle.mimeType })) } };
    },
  },
};

/**
 * In-process browser frontend. Mounts a chat UI into the DOM and drives `services.run` directly —
 * the same contract a remote frontend uses over HTTP/SSE, minus the wire. The mount point is
 * `#matbot-root` if present, else `document.body`.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest:   { description: 'Browser chat frontend rendering to the DOM (in-process, no server).' },
  tools:      [urlForResourceTool],

  /**
   * Registers the frontend and mounts the chat UI.
   *
   * Registers a `frontend-dom` frontend with the machine, then mounts {@link ChatUI} into the
   * `#matbot-root` element (falling back to `document.body`). Runs under the ambient boot
   * principal — there is no per-request principal in the in-process browser case.
   *
   * @param services - The matbot machine (sessions, runner, providers) the UI drives.
   * @returns Resolves once the UI is mounted and an initial session is selected.
   * @throws Error - Via {@link ChatUI.mount}, when no session exists yet and no sessions store is
   *                available to create one.
   */
  async setup(services: MatbotMachine): Promise<void> {
    services.registerFrontend({ name: 'frontend-dom' });
    const root = document.getElementById('matbot-root') ?? document.body;
    await new ChatUI(services, root).mount();
  },
};
