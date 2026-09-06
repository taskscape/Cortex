import type { Tool, ToolEvent, ToolContext, MatbotPluginSpec, MatbotMachine, PluginSettings } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MCPClient, MCPToolDef, MCPRemoteConfig } from '@matatbread/matbot-mcp-http';
import { makeProxyTool, proxyToolName, RemoteMcpManager } from '@matatbread/matbot-mcp-http';
import process from 'node:process';
import type { MCPServerConfigLocal, MCPPersistedLocal } from './types.js';
import { createStdioClient } from './client.js';

/** One connected local server: its config, live client, advertised tools, and optional instructions. */
interface ActiveLocal { config: MCPServerConfigLocal; client: MCPClient; tools: MCPToolDef[]; instructions?: string }

// RemoteMcpManager persists under a fixed 'servers' key; scope it beneath ours so the embedded remote
// store never collides with our local 'servers'. One settings document, two non-overlapping owners.
/**
 * Wrap the plugin's settings in a view whose keys are prefixed with `remote:`, so the embedded
 * {@link RemoteMcpManager} persists under a namespace disjoint from this plugin's own `servers`
 * document.
 *
 * @param base - The plugin's underlying settings backend.
 * @returns A settings view delegating to `base` with every key scoped as `remote:<key>`.
 * @throws Never.
 */
function remoteSettings(base: PluginSettings): PluginSettings {
  const scoped = (key: string): string => `remote:${key}`;
  return {
    get:    <T>(key: string) => base.get<T>(scoped(key)),
    set:    <T>(key: string, value: T) => base.set<T>(scoped(key), value),
    delete: (key: string) => base.delete(scoped(key)),
  };
}

/**
 * The node MCP plugin. It hard-depends on @matatbread/matbot-mcp-http (declared in package.json) and
 * embeds its RemoteMcpManager directly — no second plugin load, no service discovery. It exposes one
 * `mcp_action` tool spanning both transports: local (stdio) servers handled here, remote (HTTP) ones
 * delegated to the embedded manager. Owning the manager outright keeps its whole lifecycle (connect,
 * reconnect, teardown) under this plugin, so there is no order-dependent cleanup between two plugins.
 *
 * @returns The plugin spec; its `setup` registers `mcp_action` and reconnects persisted servers,
 *          its `teardown` closes every connection.
 * @throws Never.
 */
export function createMCPPlugin(): MatbotPluginSpec {
  const localActive = new Map<string, ActiveLocal>();
  let settings: PluginSettings | undefined;
  let remote:   RemoteMcpManager | undefined;
  let registry: MatbotMachine['tools'] | undefined;

  /**
   * Resolve the live client for a local server, used as the proxy tools' connection resolver so
   * each invocation targets the current connection.
   *
   * @param name - Local server name.
   * @returns The connected {@link MCPClient}, or `undefined` if the server was removed.
   * @throws Never.
   */
  const resolveLocalClient = (name: string): MCPClient | undefined => localActive.get(name)?.client;

  /**
   * Spawn a local stdio server, complete the initialize handshake, cache its entry, and register
   * one proxy tool per advertised tool under `mcp__<server>__<tool>`.
   *
   * @param config - The server definition (command, optional args/env).
   * @returns The tool definitions the server advertised, in server order.
   * @throws Error - If the process cannot be spawned, the handshake fails or times out, or tool
   *           listing fails. Partial registrations are not rolled back.
   */
  async function connectLocal(config: MCPServerConfigLocal): Promise<MCPToolDef[]> {
    const client = await createStdioClient(config.command, config.args ?? [], config.env);
    const tools  = await client.listTools();
    localActive.set(config.name, {
      config, client, tools,
      ...(client.instructions !== undefined ? { instructions: client.instructions } : {}),
    });
    for (const t of tools) registry!.register(makeProxyTool(config.name, t, resolveLocalClient));
    return tools;
  }

  /**
   * Input shape of the `mcp_action` tool: connect a local or remote server, list the connected
   * servers, or remove one by name.
   */
  type McpAction =
    | { action: 'add'; name: string; type: 'local';  command: string; args?: string[]; env?: Record<string, string> }
    | { action: 'add'; name: string; type: 'remote'; endpoint: string; headers?: Record<string, string> }
    | { action: 'list' }
    | { action: 'remove'; name: string };

  /**
   * Handle the `add` action: validate the request, connect the server (remote via the embedded
   * {@link RemoteMcpManager}, local via {@link connectLocal}), and persist local configs under the
   * `servers` settings key. Progress is streamed as `stdout` events; the outcome is a `result`
   * event on success or an `error` event on failure.
   *
   * @param raw - The `add` payload, discriminated on `type` (`local` or `remote`).
   * @returns Tool events: `stdout` progress, then a final `result` (message, proxy tool names,
   *          optional server instructions) or `error`.
   * @throws Never - Connection failures are reported as `error` events.
   */
  async function* doAdd(raw: Extract<McpAction, { action: 'add' }>): AsyncIterable<ToolEvent> {
    if (localActive.has(raw.name) || remote!.has(raw.name)) {
      yield { type: 'error', message: `An MCP server named "${raw.name}" is already connected. Remove it first.` };
      return;
    }

    if (raw.type === 'remote') {
      if (!raw.endpoint) { yield { type: 'error', message: 'Remote MCP servers require an "endpoint".' }; return; }
      yield { type: 'stdout', chunk: `Connecting to remote MCP server "${raw.name}"...\n` };
      try {
        const r = await remote!.add({ name: raw.name, endpoint: raw.endpoint, ...(raw.headers !== undefined ? { headers: raw.headers } : {}) });
        yield { type: 'result', value: { message: `Connected. ${r.tools.length} tool(s) registered.`, tools: r.tools, ...(r.instructions !== undefined ? { instructions: r.instructions } : {}) } };
      } catch (e) { yield { type: 'error', message: `Failed to connect to "${raw.name}": ${String(e)}` }; }
      return;
    }

    if (!raw.command) { yield { type: 'error', message: 'Local MCP servers require a "command".' }; return; }
    const config: MCPServerConfigLocal = {
      type: 'local', name: raw.name, command: raw.command,
      ...(raw.args !== undefined ? { args: raw.args } : {}),
      ...(raw.env  !== undefined ? { env:  raw.env  } : {}),
    };
    yield { type: 'stdout', chunk: `Spawning local MCP server "${raw.name}"...\n` };
    let tools: MCPToolDef[];
    try { tools = await connectLocal(config); }
    catch (e) { yield { type: 'error', message: `Failed to connect to "${raw.name}": ${String(e)}` }; return; }

    const persisted = (await settings!.get<MCPPersistedLocal>('servers')) ?? { servers: [] };
    persisted.servers.push(config);
    await settings!.set('servers', persisted);

    const instructions = localActive.get(raw.name)?.instructions;
    yield { type: 'result', value: {
      message: `Connected. ${tools.length} tool(s) registered.`,
      tools: tools.map(t => proxyToolName(raw.name, t.name)),
      ...(instructions !== undefined ? { instructions } : {}),
    } };
  }

  /**
   * Summarize every connected local server.
   *
   * @returns A generator yielding one descriptor per server in connection order: name, type,
   *          command, optional server instructions, and proxy tool names with descriptions.
   * @throws Never.
   */
  function* listLocal(): Generator<unknown> {
    for (const s of localActive.values()) {
      yield {
        name: s.config.name, type: 'local', command: s.config.command,
        ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
        tools: s.tools.map(t => ({ toolName: proxyToolName(s.config.name, t.name), description: t.description ?? '' })),
      };
    }
  }

  /**
   * Handle the `remove` action: confirm via {@link ToolContext.prompt}, then disconnect a remote
   * server through the embedded manager, or close a local one, unregister its proxy tools, and
   * drop it from the persisted `servers` list.
   *
   * @param name - Server name to remove.
   * @param ctx - Tool context; its `prompt` gathers the y/N confirmation.
   * @returns Tool events: a final `result` (cancelled or removed message) or `error` (unknown name).
   * @throws Never.
   */
  async function* doRemove(name: string, ctx: ToolContext): AsyncIterable<ToolEvent> {
    // Remote servers belong to the delegated service; everything else is local.
    if (remote!.has(name)) {
      const confirm = await ctx.prompt(`Remove MCP server "${name}"? [y/N]`, 'N');
      if (!/^y(es)?$/i.test(confirm.trim())) { yield { type: 'result', value: { message: 'Cancelled.' } }; return; }
      const ok = await remote!.remove(name);
      yield { type: 'result', value: { message: ok ? `"${name}" disconnected and removed.` : `No MCP server named "${name}".` } };
      return;
    }

    const persisted = await settings!.get<MCPPersistedLocal>('servers');
    const inConfig  = persisted?.servers.some(s => s.name === name) ?? false;
    if (!localActive.has(name) && !inConfig) { yield { type: 'error', message: `No MCP server named "${name}".` }; return; }

    const confirm = await ctx.prompt(`Remove MCP server "${name}"? [y/N]`, 'N');
    if (!/^y(es)?$/i.test(confirm.trim())) { yield { type: 'result', value: { message: 'Cancelled.' } }; return; }

    const server = localActive.get(name);
    if (server) {
      server.client.close();
      for (const t of server.tools) registry!.remove(proxyToolName(name, t.name));
      localActive.delete(name);
    }
    if (persisted) { persisted.servers = persisted.servers.filter(s => s.name !== name); await settings!.set('servers', persisted); }
    yield { type: 'result', value: { message: `"${name}" disconnected and removed. Its tools have been unregistered.` } };
  }

  const mcpActionTool: Tool = {
    name: 'mcp_action',
    description: `Manage MCP (Model Context Protocol) server connections. An MCP server exposes a set
of tools over a transport; once connected, each is registered under \`mcp__<server>__<tool>\` and is
callable for the rest of the session.

Two transport types:
- **local** — spawns a process on this machine speaking JSON-RPC over stdio
  (e.g. \`npx @modelcontextprotocol/server-github\`, \`uvx mcp-server-fetch\`).
- **remote** — connects to an HTTP endpoint (JSON-RPC over POST, optional SSE).

ACTIONS
  add    — Connect a server and register its tools (validated before saving).
  list   — Show connected servers, their tools, and any server instructions.
  remove — Disconnect a server and forget it; its proxy tools are unregistered.

SHAPE  (TypeScript)
  type McpAction =
    | { action: 'add'; name: string; type: 'local';  command: string; args?: string[]; env?: Record<string,string> }
    | { action: 'add'; name: string; type: 'remote'; endpoint: string; headers?: Record<string,string> }
    | { action: 'list' }
    | { action: 'remove'; name: string };`,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action:   { type: 'string', enum: ['add', 'list', 'remove'], description: 'add: connect a server. list: show servers. remove: disconnect.' },
        name:     { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', description: 'Short lowercase server id (add/remove); becomes the tool-name prefix.' },
        type:     { type: 'string', enum: ['local', 'remote'], description: 'add only: "local" spawns a process via stdio; "remote" connects to an HTTP endpoint.' },
        command:  { type: 'string', description: 'add, local only: command to run (quoted segments respected).' },
        args:     { type: 'array', items: { type: 'string' }, description: 'add, local only: extra arguments appended after the command.' },
        env:      { type: 'object', additionalProperties: { type: 'string' }, description: 'add, local only: environment variables for the server process.' },
        endpoint: { type: 'string', description: 'add, remote only: the MCP HTTP endpoint URL.' },
        headers:  { type: 'object', additionalProperties: { type: 'string' }, description: 'add, remote only: HTTP headers, e.g. {"Authorization":"Bearer …"}.' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const act = input as McpAction;
        switch (act.action) {
          case 'add':    yield* doAdd(act); return;
          case 'list':   yield { type: 'result', value: { servers: [...listLocal(), ...remote!.list().map(s => ({ ...s, type: 'remote' }))] } }; return;
          case 'remove': yield* doRemove(act.name, ctx); return;
          default:       yield { type: 'error', message: `Unknown mcp_action "${(act as { action: string }).action}".` };
        }
      },
    },
  };

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: { description: 'MCP servers (local stdio + remote HTTP). Embeds @matatbread/matbot-mcp-http\'s remote client directly.' },
    // No static tools: mcp_action is registered in setup(), once the embedded RemoteMcpManager exists
    // for its executor to delegate remote work to.

    /**
     * Register `mcp_action`, embed the {@link RemoteMcpManager} over a `remote:`-scoped settings
     * view, and reconnect persisted servers. Remote entries found in this plugin's legacy shared
     * `servers` document are handed to the manager (which re-persists them under its own key);
     * local entries reconnect and stay. A server that fails to reconnect is logged to stderr and
     * its config kept, so a transient outage does not lose it.
     *
     * @param services - Machine services used for tool registration, settings, and the registry.
     * @returns Nothing.
     * @throws Never.
     */
    async setup(services) {
      registry = services.tools;
      settings = services.settings();

      // Embed the remote client directly (hard dependency, satisfied by this package's node_modules).
      // We own it outright — its connect, reconnect, and teardown all run here.
      remote = new RemoteMcpManager(services, remoteSettings(settings));
      registry.register(mcpActionTool);

      // Reconnect remote servers from the manager's own (sub-scoped) store.
      await remote.reconnectPersisted((name, e) =>
        process.stderr.write(`[mcp] Failed to reconnect remote "${name}": ${String(e)}\n`));

      // Reconnect locals, and self-heal the pre-split layout where local *and* remote servers shared
      // our 'servers' key. Remote entries found there are handed to the manager (which re-persists them
      // under its sub-key) and dropped from this list; locals reconnect and stay.
      type PersistedMixed = { servers: Array<MCPServerConfigLocal | MCPRemoteConfig> };
      const persisted = await settings.get<PersistedMixed>('servers');
      if (persisted?.servers?.length) {
        const keep: Array<MCPServerConfigLocal | MCPRemoteConfig> = [];
        for (const config of persisted.servers) {
          try {
            if (config.type === 'remote') {
              if (!remote.has(config.name)) {
                await remote.add({ name: config.name, endpoint: config.endpoint, ...(config.headers !== undefined ? { headers: config.headers } : {}) });
              }
            } else {
              await connectLocal(config);
              keep.push(config);
            }
          } catch (e) {
            process.stderr.write(`[mcp] Failed to reconnect "${config.name}": ${String(e)}\n`);
            keep.push(config);   // keep on failure so a transient outage doesn't lose the config
          }
        }
        if (keep.length !== persisted.servers.length) await settings.set('servers', { servers: keep });
      }
    },

    /**
     * Close every local client and all remote connections. Persisted configs are kept so the
     * next setup reconnects them.
     *
     * @returns Nothing.
     * @throws Never.
     */
    async teardown() {
      for (const s of localActive.values()) s.client.close();
      localActive.clear();
      remote?.closeAll();
    },
  };
}
