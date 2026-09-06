import type { MatbotPluginSpec, MatbotMachine, Tool, ToolContext, ToolEvent, ToolRegistry } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION }                from '@matatbread/matbot-plugin-api';
import { createToolInvoker, watchPlugins }                      from '@matatbread/matbot-core';
// Type import also brings the `SkillManager` augmentation of MatbotMachine into scope.
import type { SkillManager }                 from '@matatbread/matbot-skills';
import { createWebServer, defaultWebPrincipal, parseWebBranding } from './server.js';
import type { WorkspaceManager, WorkspaceRagManager, SessionTitler } from './server.js';
import process                               from 'node:process';

let webServer: Awaited<ReturnType<typeof createWebServer>> | undefined;
let toolRegistry: ToolRegistry | undefined;
const port = Number(process.env['MATBOT_WEB_PORT'] ?? 19778); // 19778 is "MB" in hex, a cute easter egg :)
const listenRetryTimeoutMs = Number(process.env['MATBOT_WEB_LISTEN_RETRY_TIMEOUT_MS'] ?? 15000);
/** Host interface the web server binds to (loopback only). */
export const WEB_LISTEN_HOST = '127.0.0.1';

// Mint a shareable URL for a stored file — but only one this server actually serves: a file marked
// `allowed` (default-deny). The path mirrors the GET /files/<namespace>/<name> route in server.ts.
// Registered only when the server is up (below), so the tool is absent when nothing is serving.
const urlForResourceTool: Tool = {
  name: 'url_for_resource',
  description:
    'Return a shareable HTTP URL for a stored file, or null when it is not publicly viewable. Use this ' +
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
     * Resolves a stored file to a server-relative URL served by this frontend.
     *
     * Default-deny: a missing file store, an unknown file, or one not marked `allowed` yields
     * `{ url: null }`. The path mirrors the `GET /files/<namespace>/<name>` route in `server.ts`,
     * with each path segment URI-encoded.
     *
     * @param input - Expected `{ namespace: string, name: string }`; a missing or empty field
     *                yields an `error` event.
     * @param ctx - Tool execution context; `ctx.files` resolves the file handle.
     * @yields A `result` event whose `value.url` is the shareable path or `null`, or an `error`
     *                event for malformed input.
     * @throws Error - If the file store lookup fails; malformed input and unresolvable files are
     *                reported by yielding events instead.
     */
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { namespace, name } = input as { namespace?: string; name?: string };
      if (!namespace || !name) { yield { type: 'error', message: 'url_for_resource requires "namespace" and "name".' }; return; }
      if (!ctx.files) { yield { type: 'result', value: { url: null } }; return; }
      const handle = await ctx.files.getByName(name, namespace);
      if (!handle || !handle.allowed) { yield { type: 'result', value: { url: null } }; return; }
      const path = `${encodeURIComponent(namespace)}/${name.split('/').map(encodeURIComponent).join('/')}`;
      yield { type: 'result', value: { url: `/files/${path}` } };
    },
  },
};


/**
 * Web frontend plugin: starts the HTTP+SSE chat server on loopback, registers
 * the `url_for_resource` tool, and reports the UI URL as its installation
 * message. No-op in sub-agent processes.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion:  PLUGIN_API_VERSION,

  /**
   * Describes how to reach the web UI once the plugin is installed.
   *
   * @returns A human-readable instruction containing the configured port's URL.
   * @throws Never.
   */
  async installationMessage(): Promise<string> {
    return `Go to http://localhost:${port}/ to access the web interface.`;
  },

  /**
   * Starts the HTTP+SSE server on loopback and registers the URL tool.
   *
   * No-op in sub-agent processes. Builds the server via {@link createWebServer} with per-call
   * service lookups (skills, workspace RAG, session titler, and the principal resolver are resolved
   * lazily so plugin load order never pins a stale `undefined`), then binds `MATBOT_WEB_PORT`
   * (default 19778) on {@link WEB_LISTEN_HOST}. An `EADDRINUSE` bind failure retries every 250 ms
   * until `MATBOT_WEB_LISTEN_RETRY_TIMEOUT_MS` (default 15 s) elapses, then rejects. Only after the
   * server is listening is `url_for_resource` registered, so the tool never advertises URLs for a
   * server that is not serving.
   *
   * @param services - Machine whose services are wired into the server dependencies.
   * @returns Resolves once the server is listening.
   * @throws Error - When `services.sessions` or `services.run` is missing, or the bind fails for a
   *                 reason other than a retryable `EADDRINUSE` (or the retry window expires).
   */
  async setup(services: MatbotMachine) {
    if (services.isSubAgent()) return;

    services.registerFrontend({ name: 'frontend-web' });

    const sessions = services.sessions;
    if (!sessions) throw new Error('frontend-web requires services.sessions');
    const run = services.run;
    if (!run) throw new Error('frontend-web requires services.run');


    webServer = createWebServer({
      store: sessions,
      listProviders:()=>[...services.providers.values()].map(p=>({name:p.name})),
      ...(services.contributions?{contributions:services.contributions}:{}),
      invokeTool: createToolInvoker(services).invoke,
      attachments:()=>services.AttachmentResolver,
      expertSessions:()=>services.ExpertSessions,
      run,
      vault: services.Vault,
      loadPlugin:    services.loadPlugin.bind(services),
      unloadPlugin:  services.unloadPlugin.bind(services),
      watchPlugins,
      tools:         services.tools,
      // Resolve the SkillManager per call, not once here: frontend-web loads before the skills plugin,
      // so a snapshot would capture undefined forever (services.SkillManager is a live registry getter).
      skills:        () => services.SkillManager,
      workspaceRagManager: () => services.get?.('WorkspaceRagManager' as never) as WorkspaceRagManager | undefined,
      sessionTitler:       () => services.get?.('SessionTitler' as never) as SessionTitler | undefined,
      // Look up the resolver per request so an override registered in any load order takes effect.
      resolvePrincipal: (req) => (services.WebPrincipalResolver ?? defaultWebPrincipal)(req),
      branding: parseWebBranding(),
      ...(services.workdir    !== undefined ? { workdir:    services.workdir    } : {}),
      ...(services.files      !== undefined ? { files:      services.files      } : {}),
      ...(services.configPath !== undefined ? { configPath: services.configPath } : {}),
      getWorkspaceManager:()=>services.WorkspaceManager,
      // Per-process identity, minted here rather than derived from the pid so a client can compare it
      // across a restart without caring how the process was launched. The workspace is the config this
      // process actually loaded — not what the registry file claims is active.
      runtime: {
        id: crypto.randomUUID(),
        ...(services.configPath !== undefined ? { workspace: services.configPath } : {}),
      },
    });

    await new Promise<void>((resolve, reject) => {
      const server = webServer!.server;
      const startedAt = Date.now();
      let warned = false;
      let activeListenErrorHandler: ((ex: Error & { code?: string }) => void) | undefined;
      // Attached once, not per attempt: `listen(port, host, cb)` registers cb as a `listening` handler
      // that only fires on success, so a retried listen leaves one behind every time — which is both
      // the MaxListenersExceededWarning and the reason a successful bind after N retries printed the
      // "http://localhost:…" line N times.
      server.once('listening', () => {
        if (activeListenErrorHandler) server.off('error', activeListenErrorHandler);
        process.stderr.write(`[frontend-web] http://localhost:${port}\n`);
        resolve();
      });
      /**
       * Attempts to bind the port, retrying while the address is in use.
       *
       * Each attempt registers {@link onError} for exactly that attempt (so retries never stack
       * handlers) and then calls `server.listen(port, WEB_LISTEN_HOST)`.
       *
       * @returns Nothing.
       * @throws Never - Failures surface through the error handler and the surrounding promise.
       */
      const listen = (): void => {
        /**
         * Handles a bind failure: retries while the address is in use and the retry window is open.
         *
         * Warns once, waits 250 ms, and calls {@link listen} again; any other error — or a still-busy
         * port after the window — rejects the surrounding promise.
         *
         * @param ex - The listen error, inspected for its `code`.
         * @returns Nothing.
         * @throws Never - Failures reject the surrounding promise instead.
         */
        const onError = (ex: Error & { code?: string }): void => {
          activeListenErrorHandler = undefined;
          if (ex.code === 'EADDRINUSE' && Date.now() - startedAt < listenRetryTimeoutMs) {
            if (!warned) {
              warned = true;
              console.warn(`[frontend-web] Port ${port} is already in use. Waiting for it to become available.`);
            }
            setTimeout(listen, 250);
            return;
          }
          reject(ex);
        };
        activeListenErrorHandler = onError;
        server.once('error', onError);
        server.listen(port, WEB_LISTEN_HOST);
      };
      listen();
    });

    // Only advertise URL minting after the server is actually serving.
    if (webServer) { services.tools.register(urlForResourceTool); toolRegistry = services.tools; }
  },

  /**
   * Unregisters the URL tool and closes the web server.
   *
   * Closing ends all SSE streams, resolves pending prompts, and stops the watch loops (see
   * {@link createWebServer}). A no-op when setup never ran.
   *
   * @returns Resolves once the server has closed.
   * @throws Never - Close errors are logged, not thrown.
   */
  async teardown() {
    toolRegistry?.remove('url_for_resource');
    toolRegistry = undefined;
    if (webServer) await webServer.close();
  },
};
