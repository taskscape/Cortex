import { spawn } from 'node:child_process';
import process from 'node:process';
import type { MCPClient, MCPToolDef, MCPToolResult } from '@matatbread/matbot-mcp-http';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'matbot', version: '0.1.0' };
const REQUEST_TIMEOUT_MS = 30_000;
// A response is one line. A server that never ends its line would otherwise grow this buffer
// without limit; the cap is far above any real tool result (inline images included).
const MAX_LINE_CHARS = 64 * 1024 * 1024;
// stderr is a server's log channel. It is drained (see the constructor) and only this much of its
// end is kept, to say why a server died.
const STDERR_TAIL_CHARS = 2_000;

/** JSON-RPC 2.0 request carrying a numeric id; responses are matched back by that id. */
interface JsonRpcRequest      { jsonrpc: '2.0'; id: number; method: string; params: unknown }
/** JSON-RPC 2.0 notification: no id is sent and no response is expected. */
interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: unknown }
/** JSON-RPC 2.0 response; `error` carries the server-reported failure when present. */
interface JsonRpcResponse     { jsonrpc: string; id?: unknown; result?: unknown; error?: { code: number; message: string } }

// Simple shell-like tokenizer: respects single and double quotes.
/**
 * Split a command string into tokens using shell-like quoting: single or double quotes group
 * characters (the quote characters themselves are stripped), unquoted whitespace separates
 * tokens. Unterminated quotes still emit the trailing token.
 *
 * @param cmd - The command string to tokenize.
 * @returns The tokens in order of appearance; empty when `cmd` is blank.
 * @throws Never.
 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = '', quote = '';
  for (const ch of cmd) {
    if (quote) { if (ch === quote) quote = ''; else cur += ch; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) { if (cur) { tokens.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** MCP client over a local child process speaking JSON-RPC on stdio. Node-only (child_process). */
export class StdioMCPClient implements MCPClient {
/** Server-provided usage instructions, set by {@link initialize} when the server offers them. */
  instructions: string | undefined;
  private readonly child;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private buf = '';
  private stderrTail = '';
  private dead = false;

  /**
   * Spawn the server process and start reading its stdout.
   *
   * A failed spawn (missing executable, denied access) is not reported here — it arrives
   * asynchronously via the child's `error` event and rejects pending requests.
   *
   * @param command Command to run; shell-like quoting (single/double) is respected.
   * @param extraArgs Extra arguments appended after the command's own.
   * @param env Additional environment variables merged over `process.env`.
   * @throws Never.
   */
  constructor(command: string, extraArgs: string[], env?: Record<string, string>) {
    const parts = tokenize(command);
    const exe   = parts[0] ?? command;
    const args  = [...parts.slice(1), ...extraArgs];
    this.child = spawn(exe, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });

    // A failed spawn (missing executable, denied access, invalid working environment) is reported as
    // an `error` event after spawn() returns. Without a listener Node treats it as an uncaught error
    // and terminates the whole host before createStdioClient() can reject normally.
    this.child.on('error', error => this.fail(error));
    // A server can also disappear between the liveness check and a write. Consume the stream error and
    // reject the same pending requests instead of allowing an EPIPE event to crash the process.
    this.child.stdin?.on('error', error => this.fail(error));

    // Decoded by the stream, which carries a character split across two chunks over to the next;
    // decoding each chunk separately corrupts it, and with it the JSON line it belongs to.
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) this.onLine(line);
      }
      if (this.buf.length > MAX_LINE_CHARS) {
        this.buf = '';
        this.fail(new Error(`MCP server sent more than ${MAX_LINE_CHARS} characters without ending a message`));
        this.child.kill('SIGTERM');
      }
    });
    // Servers log to stderr. Left unread, the pipe fills (a few KB to 64 KB depending on the
    // platform) and the server then blocks on its next log line — every call after that times out.
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    this.child.on('close', () => {
      const tail = this.stderrTail.trim();
      this.fail(new Error(`MCP server process exited unexpectedly${tail ? `: ${tail}` : ''}`));
    });
  }

  /**
   * Mark the client dead and reject every pending request with `error`, clearing their timeout
   * timers. Safe to call more than once; later calls find nothing pending.
   *
   * @param error - The reason delivered to each pending request's rejection.
   * @returns Nothing.
   * @throws Never.
   */
  private fail(error: Error): void {
    this.dead = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  /**
   * Handle one stdout line as a JSON-RPC response: parse it, match it to a pending request by
   * numeric `id`, and settle that request. Unparseable lines, non-numeric ids, and unknown ids
   * are silently ignored; an `error` response rejects the request with the server's message.
   *
   * @param line - One raw stdout line (newline already removed).
   * @returns Nothing.
   * @throws Never.
   */
  private onLine(line: string): void {
    let msg: JsonRpcResponse;
    try { msg = JSON.parse(line) as JsonRpcResponse; } catch { return; }
    if (typeof msg.id !== 'number') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  }

  /**
   * Serialize a JSON-RPC message to the server's stdin followed by a newline (newline-delimited
   * JSON-RPC framing).
   *
   * @param msg - The request or notification to send.
   * @returns Nothing.
   * @throws Never - Stdin write failures surface asynchronously through the stdin error handler.
   */
  private write(msg: JsonRpcRequest | JsonRpcNotification): void {
    this.child.stdin?.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Send a JSON-RPC request and resolve with the response's `result` field.
   *
   * @param method - The JSON-RPC method name.
   * @param params - The `params` payload; defaults to an empty object.
   * @param signal - Optional cancellation signal; aborting rejects the request at once and tells
   *          the server to stop working on it.
   * @returns The `result` value of the matching response.
   * @throws Error - Rejects if the client is closed, after the 30 s timeout, on cancellation, on
   *           process failure, or with the server's JSON-RPC error message.
   */
  private request(method: string, params: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error('MCP client is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        if (!this.dead) this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Cancelled by the client.' } });
        reject(new Error(`MCP request "${method}" was cancelled`));
      };
      const unlisten = (): void => signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => { this.pending.delete(id); unlisten(); reject(new Error(`MCP request "${method}" timed out`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: value => { unlisten(); resolve(value); },
        reject:  error => { unlisten(); reject(error); },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * Perform the MCP initialize handshake and send the initialized notification.
   * @returns Nothing; resolves once the handshake result is captured and the notification written.
   * @throws On spawn failure, process exit, timeout, or JSON-RPC error response.
   */
  async initialize(): Promise<void> {
    const result = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }) as { instructions?: unknown };
    if (typeof result?.instructions === 'string') this.instructions = result.instructions;
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /**
   * List the tools the server exposes via `tools/list`.
   * @returns The tool definitions, or an empty array if none are reported.
   * @throws On spawn failure, process exit, timeout, or JSON-RPC error response.
   */
  async listTools(): Promise<MCPToolDef[]> {
    const result = await this.request('tools/list') as { tools?: MCPToolDef[] };
    return result.tools ?? [];
  }

  /**
   * Invoke a tool on the server via `tools/call`.
   * @param name Tool name on the server.
   * @param args Arguments object passed to the tool.
   * @param signal Aborting rejects the call and sends the server a cancellation notice; the
   *        server is not required to act on it.
   * @returns The tool result (content parts and error flag).
   * @throws If already closed or aborted, or on process exit, timeout, or JSON-RPC error response.
   */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<MCPToolResult> {
    if (signal?.aborted) throw new Error('Aborted');
    return await this.request('tools/call', { name, arguments: args }, signal) as MCPToolResult;
  }

  /**
   * Reject all pending requests and terminate the server process with SIGTERM. Idempotent.
   *
   * @returns Nothing.
   * @throws Never.
   */
  close(): void {
    if (!this.dead) this.fail(new Error('MCP client is closed'));
    // Not skipped for a client already marked dead: a failed write marks it dead while the server
    // process itself is still running.
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
  }
}

/**
 * Create a connected {@link StdioMCPClient} for a local server config.
 * @param command Command to run. @param args Extra arguments. @param env Extra environment variables.
 * @returns An initialized client ready for `listTools`/`callTool`.
 * @throws If the process cannot be spawned or the initialize handshake fails/times out.
 */
export async function createStdioClient(command: string, args: string[], env?: Record<string, string>): Promise<StdioMCPClient> {
  const client = new StdioMCPClient(command, args, env);
  try {
    await client.initialize();
  } catch (error) {
    // The caller never receives the client, so nothing else could stop the process it started.
    client.close();
    throw error;
  }
  return client;
}
