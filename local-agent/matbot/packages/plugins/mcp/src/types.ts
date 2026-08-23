/** Config for one local MCP server spawned as a child process speaking JSON-RPC over stdio. */
export interface MCPServerConfigLocal {
  /** Unique short server id; prefixes its proxy tool names. */
  type:     'local';
  name:     string;
  command:  string;
  args?:    string[];
  env?:     Record<string, string>;
}

/** Persistence document listing all configured local servers. */
export interface MCPPersistedLocal {
  servers: MCPServerConfigLocal[];
}
