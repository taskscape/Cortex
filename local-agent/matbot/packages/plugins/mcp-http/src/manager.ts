import type { MatbotMachine, PluginSettings } from '@matatbread/matbot-plugin-api';
import type {
  MCPClient, MCPRemoteConfig, MCPToolDef, MCPPersistedRemote, MCPRemoteServerInfo, McpRemoteService,
} from './types.js';
import { createHttpClient } from './client.js';
import { makeProxyTool, proxyToolName } from './proxy-tool.js';

/** One connected remote server: its config, live client, advertised tools, and optional instructions. */
interface ActiveRemote { config: MCPRemoteConfig; client: MCPClient; tools: MCPToolDef[]; instructions?: string }

const PERSIST_KEY = 'servers';

/**
 * Owns the live remote MCP connections, their proxy-tool registrations, and persistence. Implements
 * {@link McpRemoteService} so a more capable plugin can delegate remote work here. Persists through
 * the injected {@link PluginSettings} (store/vault path) — portable, no filesystem.
 */
export class RemoteMcpManager implements McpRemoteService {
  private readonly active = new Map<string, ActiveRemote>();
  private readonly services: MatbotMachine;
  private readonly settings: PluginSettings;

  /**
   * Store the machine and settings used for proxy-tool registration and persistence.
   *
   * @param services The machine used to register/unregister proxy tools.
   * @param settings Persistence for the server list.
   * @throws Never.
   */
  constructor(services: MatbotMachine, settings: PluginSettings) {
    this.services = services;
    this.settings = settings;
  }

  /**
   * Resolve the live client for a server, used as the proxy tools' connection resolver so each
   * invocation targets the current connection.
   *
   * @param name - Server name.
   * @returns The connected {@link MCPClient}, or `undefined` if the server was removed.
   * @throws Never.
   */
  private resolveClient = (name: string): MCPClient | undefined => this.active.get(name)?.client;

  /**
   * Connect to a remote server, list its tools, cache the entry, and register one proxy tool per
   * advertised tool under `mcp__<server>__<tool>`.
   *
   * @param config - The server definition (endpoint and optional headers).
   * @returns The tool definitions the server advertised, in server order.
   * @throws Error - If the connection, initialize handshake, or tool listing fails. Partial
   *           registrations are not rolled back.
   */
  private async connect(config: MCPRemoteConfig): Promise<MCPToolDef[]> {
    const client = await createHttpClient(config);
    const tools  = await client.listTools();
    this.active.set(config.name, {
      config, client, tools,
      ...(client.instructions !== undefined ? { instructions: client.instructions } : {}),
    });
    for (const toolDef of tools) {
      this.services.tools.register(makeProxyTool(config.name, toolDef, this.resolveClient));
    }
    return tools;
  }

  /**
   * Connect a remote MCP server, register its proxy tools, and persist it.
   * @param input Server name, endpoint URL, and optional headers.
   * @returns The registered proxy tool names and any server instructions.
   * @throws If a server with that name is already connected, or the connection/tool listing fails.
   */
  async add(input: { name: string; endpoint: string; headers?: Record<string, string> }): Promise<{ tools: string[]; instructions?: string }> {
    if (this.active.has(input.name)) throw new Error(`An MCP server named "${input.name}" is already connected.`);
    const config: MCPRemoteConfig = {
      type: 'remote', name: input.name, endpoint: input.endpoint,
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
    };
    const tools = await this.connect(config);

    const persisted = (await this.settings.get<MCPPersistedRemote>(PERSIST_KEY)) ?? { servers: [] };
    persisted.servers.push(config);
    await this.settings.set(PERSIST_KEY, persisted);

    const instructions = this.active.get(input.name)?.instructions;
    return {
      tools: tools.map(t => proxyToolName(input.name, t.name)),
      ...(instructions !== undefined ? { instructions } : {}),
    };
  }

  /**
   * Summarize every currently connected remote server.
   *
   * @returns Info for every currently connected server, including proxy tool names, in connection
   *          order; empty when none are connected.
   * @throws Never.
   */
  list(): MCPRemoteServerInfo[] {
    return [...this.active.values()].map(s => ({
      name:     s.config.name,
      endpoint: s.config.endpoint,
      ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
      tools:    s.tools.map(t => ({ toolName: proxyToolName(s.config.name, t.name), description: t.description ?? '' })),
    }));
  }

  /**
   * Report whether a server name is currently connected.
   *
   * @param name Candidate server name.
   * @returns Whether it is currently connected here.
   * @throws Never.
   */
  has(name: string): boolean { return this.active.has(name); }

  /**
   * Disconnect a server, unregister its proxy tools, and remove it from persistence.
   * @param name The server name.
   * @returns `false` if no such server is connected or persisted, otherwise `true`.
   * @throws Never - A missing server is reported by the `false` return, not an error.
   */
  async remove(name: string): Promise<boolean> {
    const persisted = await this.settings.get<MCPPersistedRemote>(PERSIST_KEY);
    const inConfig  = persisted?.servers.some(s => s.name === name) ?? false;
    const server    = this.active.get(name);
    if (server === undefined && !inConfig) return false;

    if (server) {
      server.client.close();
      for (const toolDef of server.tools) this.services.tools.remove(proxyToolName(name, toolDef.name));
      this.active.delete(name);
    }
    if (persisted) {
      persisted.servers = persisted.servers.filter(s => s.name !== name);
      await this.settings.set(PERSIST_KEY, persisted);
    }
    return true;
  }

  /**
   * Reconnect every persisted server (e.g. at plugin setup). Failures are reported per server,
   * never thrown.
   * @param onError Called with each server name and error when its reconnect fails.
   * @returns Nothing; resolves after every persisted server has been attempted.
   * @throws Never.
   */
  async reconnectPersisted(onError: (name: string, err: unknown) => void): Promise<void> {
    const persisted = await this.settings.get<MCPPersistedRemote>(PERSIST_KEY);
    for (const config of persisted?.servers ?? []) {
      try { await this.connect(config); } catch (e) { onError(config.name, e); }
    }
  }

  /**
   * Close every live connection without touching persistence.
   *
   * @returns Nothing.
   * @throws Never.
   */
  closeAll(): void {
    for (const s of this.active.values()) s.client.close();
    this.active.clear();
  }
}
