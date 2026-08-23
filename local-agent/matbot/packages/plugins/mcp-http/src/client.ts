import type { MCPClient, MCPRemoteConfig, MCPToolDef, MCPToolResult } from './types.js';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'matbot', version: '0.1.0' };
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_SSE_BUFFER_CHARS = 1_048_576;

interface JsonRpcRequest  { jsonrpc: '2.0'; id: number; method: string; params: unknown }
interface JsonRpcResponse { jsonrpc: string; id?: unknown; result?: unknown; error?: { code: number; message: string } }

/**
 * MCP client over HTTP — JSON-RPC POST, with optional SSE response framing. Pure `fetch`, so it runs
 * unchanged in the browser and Node. (The stdio transport, which needs child processes, lives in the
 * node-only mcp plugin.)
 */
export class HttpMCPClient implements MCPClient {
  /** Server-provided usage instructions, set by {@link initialize} when the server offers them. */
  instructions: string | undefined;
  private nextId = 1;
  private readonly endpoint: string;
  private readonly extraHeaders: Record<string, string> | undefined;
  private readonly requestTimeoutMs: number;

  /**
   * @param endpoint The MCP server URL (JSON-RPC POST target).
   * @param extraHeaders Extra HTTP headers sent with every request (e.g. auth).
   * @param requestTimeoutMs Per-request timeout in milliseconds; non-positive or non-finite values fall back to the default.
   */
  constructor(endpoint: string, extraHeaders?: Record<string, string>, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.endpoint = endpoint;
    this.extraHeaders = extraHeaders;
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Best-effort MCP initialize handshake; captures the server's `instructions` if offered.
   * Never throws — a stateless server that rejects initialize must not block the connection.
   */
  async initialize(): Promise<void> {
    try {
      const result = await this.post('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities:    {},
        clientInfo:      CLIENT_INFO,
      }) as { instructions?: unknown };
      if (typeof result?.instructions === 'string') this.instructions = result.instructions;
    } catch { /* stateless server / no initialize support */ }
  }

  private async post(method: string, params: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const headers: Record<string, string> = {
      'Content-Type':         'application/json',
      'Accept':               'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...this.extraHeaders,
    };

    const requestAc = new AbortController();
    const forwardAbort = (): void => requestAc.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => {
      requestAc.abort(new Error(`MCP request "${method}" timed out after ${this.requestTimeoutMs}ms`));
    }, this.requestTimeoutMs);

    try {
      const resp = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: requestAc.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`);
      }

      const ct = resp.headers.get('content-type') ?? '';
      if (ct.includes('text/event-stream')) return await this.readSseResponse(resp, id);

      const data = await resp.json() as JsonRpcResponse;
      if (data.error) throw new Error(data.error.message);
      return data.result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async readSseResponse(resp: Response, id: number): Promise<unknown> {
    if (!resp.body) throw new Error('MCP SSE response has no body');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const acceptLine = (line: string): { matched: boolean; result?: unknown } => {
      const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!normalized.startsWith('data:')) return { matched: false };
      const payload = normalized.slice(5).trimStart();
      let msg: JsonRpcResponse;
      try { msg = JSON.parse(payload) as JsonRpcResponse; } catch { return { matched: false }; }
      if (msg.id !== id) return { matched: false };
      if (msg.error) throw new Error(msg.error.message);
      return { matched: true, result: msg.result };
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const accepted = acceptLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (accepted.matched) return accepted.result;
        }
        if (buffer.length > MAX_SSE_BUFFER_CHARS) {
          throw new Error(`MCP SSE response exceeded ${MAX_SSE_BUFFER_CHARS} buffered characters without a matching response`);
        }
      }

      const tail = acceptLine(buffer + decoder.decode());
      if (tail.matched) return tail.result;
      throw new Error('No matching response found in SSE stream');
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  /**
   * List the tools the server exposes via `tools/list`.
   * @returns The tool definitions, or an empty array if none are reported.
   * @throws On HTTP failure, JSON-RPC error response, timeout, or SSE stream failure.
   */
  async listTools(): Promise<MCPToolDef[]> {
    const result = await this.post('tools/list') as { tools?: MCPToolDef[] };
    return result.tools ?? [];
  }

  /**
   * Invoke a tool on the server via `tools/call`.
   * @param name Tool name on the server.
   * @param args Arguments object passed to the tool.
   * @param signal Optional abort signal forwarded to the underlying request.
   * @returns The tool result (content parts and error flag).
   * @throws On HTTP failure, JSON-RPC error response, timeout, or SSE stream failure.
   */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<MCPToolResult> {
    return await this.post('tools/call', { name, arguments: args }, signal) as MCPToolResult;
  }

  /** No-op: HTTP is stateless. */
  close(): void { /* HTTP is stateless */ }
}

/**
 * Create a connected {@link HttpMCPClient} from persisted remote-server config.
 * @param config The endpoint and optional headers for the server.
 * @returns An initialized client ready for `listTools`/`callTool`.
 * @throws If the connection or initialize handshake fails.
 */
export async function createHttpClient(config: MCPRemoteConfig): Promise<HttpMCPClient> {
  const client = new HttpMCPClient(config.endpoint, config.headers);
  await client.initialize();
  return client;
}
