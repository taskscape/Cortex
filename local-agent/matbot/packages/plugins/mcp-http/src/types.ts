/** Config for one remote (HTTP/SSE) MCP server, as persisted and passed to {@link createHttpClient}. */
export interface MCPRemoteConfig {
  /** Unique short server id; prefixes its proxy tool names. */
  type:     'remote';
  name:     string;
  endpoint: string;
  headers?: Record<string, string>;
}

/** Persistence document listing all configured remote servers. */
export interface MCPPersistedRemote {
  servers: MCPRemoteConfig[];
}

/** A tool advertised by a remote MCP server. */
export interface MCPToolDef {
  name:         string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** One content part of an MCP tool result. */
export type MCPContentPart =
  | { type: 'text';     text: string }
  | { type: 'image';    data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

/** Result of invoking a tool on an MCP server. */
export interface MCPToolResult {
  content?: MCPContentPart[];
  isError?: boolean;
}

/** Transport-agnostic MCP client. mcp-http provides the HTTP impl; a node plugin can provide stdio. */
export interface MCPClient {
  /** Server-provided usage instructions, set by `initialize` if offered. */
  readonly instructions: string | undefined;
  /** @returns The server's tool definitions. @throws On connection or protocol failure. */
  listTools(): Promise<MCPToolDef[]>;
  /**
   * Invoke a tool on the server.
   * @param name Tool name. @param args Arguments object. @param signal Optional abort signal.
   * @returns The tool result. @throws On connection or protocol failure.
   */
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<MCPToolResult>;
  /** Release the transport (no-op for stateless HTTP). */
  close(): void;
}

/** Summary of one connected remote server, for `list`. */
export interface MCPRemoteServerInfo {
  name:          string;
  endpoint:      string;
  instructions?: string;
  tools:         Array<{ toolName: string; description: string }>;
}

/**
 * The remote-MCP delegation surface, implemented by {@link RemoteMcpManager}. mcp-http registers it
 * under `services.McpRemoteService` when running standalone (e.g. in the browser). The node mcp plugin embeds
 * RemoteMcpManager directly rather than discovering it here, so this service has no in-tree consumer;
 * it remains as a documented seam for any plugin that wants to supply remote MCP without the HTTP code.
 */
export interface McpRemoteService {
  /** Connect a remote MCP server, register its proxy tools, and persist it. */
  add(config: { name: string; endpoint: string; headers?: Record<string, string> }): Promise<{ tools: string[]; instructions?: string }>;
  /** Connected remote servers (for `list`). */
  list(): MCPRemoteServerInfo[];
  /** Whether `name` is a remote server this service manages. */
  has(name: string): boolean;
  /** Disconnect, unregister tools, and forget a remote server. `false` if not managed here. */
  remove(name: string): Promise<boolean>;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** Registered by @matatbread/matbot-mcp-http: manage remote (HTTP/SSE) MCP servers. */
    McpRemoteService?: McpRemoteService;
  }
}
