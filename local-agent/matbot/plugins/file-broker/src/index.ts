/** Subset of tool context this plugin consumes: approval metadata and cancellation. */
interface ToolContext {
  approval?: { permission: string; patterns: readonly string[] };
  signal: AbortSignal;
}

/** Events a tool executor may yield: a final result value or an error. */
type ToolEvent =
  | { type: "result"; value: unknown }
  | { type: "error"; message: string; code?: number | string };

/** Async executor contract for a tool. */
interface ToolExecutor {
  execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent>;
}

/** Tool descriptor registered with the host's tool registry. */
interface Tool {
  permission?: { action: string; patterns(input: unknown): string[]; requiresApproval(input: unknown): boolean };
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executor: ToolExecutor;
}

/** Registry the plugin registers its tools with. */
interface ToolRegistry {
  register(tool: Tool): void;
}

/** Host services surface this plugin relies on. */
interface MatbotMachine {
  FileAccessSelection?: {mode:"local"|"http"};
  HostFileAccess?: Pick<FileBrokerClient, "health" | "list" | "read" | "write">;
  tools: ToolRegistry;
}

/** Plugin entry-point contract expected by the matbot loader. */
interface MatbotPluginSpec {
  apiVersion: string;
  setup(services: MatbotMachine): Promise<void> | void;
}

/** The four actions the `file_broker_action` tool supports. */
type FileBrokerAction = "health" | "list" | "read" | "write";

/** Discriminated, validated input for one {@link FileBrokerAction}. */
type FileBrokerInput =
  | { action: "health" }
  | { action: "list"; path: string }
  | { action: "read"; path: string }
  | { action: "write"; path: string; content: string; approved?: boolean };

/** Options for constructing a {@link FileBrokerClient}. */
export interface FileBrokerClientOptions {
  /** Base URL of the local file-broker service. */
  baseUrl: string;
  token?: string;
}

/**
 * Error thrown when the file-broker service responds with a non-OK HTTP status,
 * carrying the status code and parsed response payload.
 */
export class FileBrokerRequestError extends Error {
  /**
   * @param status HTTP status code returned by the broker.
   * @param payload Parsed JSON body of the error response (or `{ text }` fallback).
   * @param message Human-readable error description.
   */
  constructor(
    readonly status: number,
    readonly payload: unknown,
    message: string
  ) {
    super(message);
    this.name = "FileBrokerRequestError";
  }
}

/**
 * HTTP client for the local file-broker service: health checks plus list/read/write
 * access to host filesystem paths inside the broker's configured roots.
 */
export class FileBrokerClient {
  /**
   * Creates a client bound to the broker's base URL.
   * @param options Client options; only `baseUrl` is required.
   */
  constructor(private readonly options: FileBrokerClientOptions) {}

  /**
   * Check broker availability.
   * @param signal Optional cancellation signal.
   * @returns The parsed /health response payload.
   * @throws {@link FileBrokerRequestError} on non-OK status; Error on network failure.
   */
  health(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/health", { signal });
  }

  /**
   * List a directory served by the broker.
   * @param filePath Absolute or configured-root-relative directory path.
   * @param signal Optional cancellation signal.
   * @returns The parsed /list response payload.
   * @throws {@link FileBrokerRequestError} on non-OK status; Error on network failure.
   */
  list(filePath: string, signal?: AbortSignal): Promise<unknown> {
    const url = this.url("/list");
    url.searchParams.set("path", filePath);
    return this.requestUrl("GET", url, { signal });
  }

  /**
   * Read a text file served by the broker.
   * @param filePath Absolute or configured-root-relative file path.
   * @param signal Optional cancellation signal.
   * @returns The parsed /read response payload.
   * @throws {@link FileBrokerRequestError} on non-OK status; Error on network failure.
   */
  read(filePath: string, signal?: AbortSignal): Promise<unknown> {
    const url = this.url("/read");
    url.searchParams.set("path", filePath);
    return this.requestUrl("GET", url, { signal });
  }

  /**
   * Write text content to a broker-served path (policy-checked server-side; returns
   * a unified diff plus backup path when an existing file is overwritten).
   * @param filePath Absolute or configured-root-relative file path.
   * @param content Text content to write.
   * @param approved Whether the write carries explicit user approval (required for high-risk writes).
   * @param signal Optional cancellation signal.
   * @returns The parsed /write response payload.
   * @throws {@link FileBrokerRequestError} on non-OK status; Error on network failure.
   */
  write(filePath: string, content: string, approved: boolean, signal?: AbortSignal): Promise<unknown> {
    return this.request("POST", "/write", {
      signal,
      body: JSON.stringify({ path: filePath, content, approved })
    });
  }

  /**
   * Perform a request against a fixed pathname on the broker.
   * @param method HTTP method.
   * @param pathname Path resolved against the configured base URL.
   * @param options Optional JSON body and cancellation signal.
   * @returns The parsed response payload.
   * @throws {@link FileBrokerRequestError} on non-OK status; Error on network failure.
   */
  private request(method: string, pathname: string, options: { body?: string | undefined; signal?: AbortSignal | undefined } = {}): Promise<unknown> {
    return this.requestUrl(method, this.url(pathname), options);
  }

  /**
   * Perform the HTTP call, parse the JSON response, and translate failures. Network
   * errors are rethrown as plain `Error`; non-OK statuses become
   * {@link FileBrokerRequestError} carrying the broker's error/reason message when
   * present.
   * @param method HTTP method.
   * @param url Absolute request URL.
   * @param options Optional JSON body and cancellation signal.
   * @returns The parsed JSON payload (or `{ text }` fallback for non-JSON bodies).
   * @throws {@link FileBrokerRequestError} on non-OK status; Error on network failure.
   */
  private async requestUrl(method: string, url: URL, options: { body?: string | undefined; signal?: AbortSignal | undefined } = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers:{...(options.body!==undefined?{"content-type":"application/json"}:{}),...(this.options.token?{"x-cortex-token":this.options.token}:{})},
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {})
      });
    } catch (error) {
      throw new Error(`File broker request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const text = await response.text();
    const payload = parseJsonResponse(text);

    if (!response.ok) {
      throw new FileBrokerRequestError(
        response.status,
        payload,
        `File broker request failed: HTTP ${response.status}: ${brokerErrorMessage(payload, text)}`
      );
    }

    return payload;
  }

  /**
   * Resolve a broker pathname against the configured base URL.
   * @param pathname Path such as "/health".
   * @returns The absolute request URL.
   * @throws TypeError when the configured base URL is invalid.
   */
  private url(pathname: string): URL {
    return new URL(pathname, this.options.baseUrl);
  }
}

/**
 * Build the `file_broker_action` tool: health/list/read/write against host filesystem
 * paths via the file-broker service, surfacing broker errors as tool error events.
 * @param client Configured client pointing at the local file-broker service.
 * @returns The registered tool descriptor.
 */
export function createFileBrokerTool(client: Pick<FileBrokerClient, "health" | "list" | "read" | "write">): Tool {
  return {
    name: "file_broker_action",
    permission: { action: "file_broker_action", patterns(input) { const parsed = parseInput(input); return parsed.ok ? [parsed.value.action + ("path" in parsed.value ? ":" + parsed.value.path : "") ] : ["*"]; }, requiresApproval(input) { const parsed = parseInput(input); return parsed.ok && parsed.value.action === "write" && parsed.value.approved === true; } },
    description:
      "List, read, and write host filesystem paths through the local file-broker service. " +
      "Use this for exact host paths inside configured roots. Use contextual_search or file-index-backed retrieval to discover paths before reading them. " +
      "Writes are text-only, policy checked by file-broker, and return a unified diff plus backup path when an existing file is overwritten. " +
      "Do not use this for Matbot workspace uploads or generated artifacts; use workspace_action for those.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["health", "list", "read", "write"],
          description: "health: check broker availability. list: list a host directory. read: read a text file. write: write a text file."
        },
        path: {
          type: "string",
          description: "Absolute or configured-root-relative host path. Required for list/read/write."
        },
        content: {
          type: "string",
          description: "Text content to write. Required for action=write."
        },
        approved: {
          type: "boolean",
          default: false,
          description: "Set true to request interactive approval for high-risk writes. The runtime obtains consent; this flag does not grant it."
        }
      }
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const parsed = parseInput(input);
        if (!parsed.ok) {
          yield { type: "error", message: parsed.error };
          return;
        }

        try {
          yield { type: "result", value: await runAction(client, parsed.value, ctx) };
        } catch (error) {
          if (error instanceof FileBrokerRequestError) {
            yield { type: "error", message: error.message, code: error.status };
            return;
          }

          yield { type: "error", message: error instanceof Error ? error.message : String(error) };
        }
      }
    }
  };
}

/**
 * The file-broker plugin: registers the `file_broker_action` tool, which proxies
 * host filesystem list/read/write operations through the local file-broker HTTP
 * service (base URL from `FILE_BROKER_BASE_URL`, defaulting to localhost:8878).
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: "0.1",
  setup(services) {
    const client = new FileBrokerClient({ baseUrl: fileBrokerBaseUrl(),...(process.env.CORTEX_FILE_BROKER_TOKEN?{token:process.env.CORTEX_FILE_BROKER_TOKEN}:{}) });
    const mode=services.FileAccessSelection?.mode??(services.HostFileAccess?'local':'http');
    /**
     * Resolve the active backend per call: the HTTP client in `http` mode, otherwise
     * the host's `HostFileAccess` adapter.
     * @returns The backend implementing the broker operations.
     * @throws Error when local mode is selected but `HostFileAccess` has unloaded.
     */
    const backend=()=>{if(mode==='http')return client;const local=services.HostFileAccess;if(!local)throw new Error('Host file access unavailable; selected local adapter has unloaded');return local;};
    services.tools.register(createFileBrokerTool({health:signal=>backend().health(signal),list:(p,signal)=>backend().list(p,signal),read:(p,signal)=>backend().read(p,signal),write:(p,content,approved,signal)=>backend().write(p,content,approved,signal)}));
  }
};

export default plugin;

/**
 * Resolve the file-broker base URL: `FILE_BROKER_BASE_URL` when set, otherwise
 * `http://localhost:<FILE_BROKER_PORT>` (default port 8878).
 * @returns The base URL string.
 * @throws Never.
 */
function fileBrokerBaseUrl(): string {
  return process.env.FILE_BROKER_BASE_URL ?? `http://localhost:${process.env.FILE_BROKER_PORT ?? "8878"}`;
}

/**
 * Dispatch one validated broker action to the client. Writes require explicit runtime
 * approval: `approved` is only honored when the tool-context approval matches the
 * `file_broker_action` permission and includes the `write:<path>` pattern; requesting
 * approval that was not granted throws.
 * @param client Client (or local adapter) performing the operation.
 * @param input Validated action input.
 * @param ctx Tool context carrying approval metadata and the cancellation signal.
 * @returns The broker's response payload.
 * @throws Error when a high-risk write was requested without granted runtime approval;
 *         {@link FileBrokerRequestError} and network errors propagate from the client.
 */
async function runAction(client: Pick<FileBrokerClient, "health" | "list" | "read" | "write">, input: FileBrokerInput, ctx: ToolContext): Promise<unknown> {
  const signal = ctx.signal;
  switch (input.action) {
    case "health":
      return client.health(signal);
    case "list":
      return client.list(input.path, signal);
    case "read":
      return client.read(input.path, signal);
    case "write":
      const approved = input.approved === true && ctx.approval?.permission === 'file_broker_action' && ctx.approval.patterns.includes('write:' + input.path);
      if (input.approved && !approved) throw new Error('High-risk write requires runtime approval; input approved=true is not consent');
      return client.write(input.path, input.content, approved, signal);
  }
}

/**
 * Validate raw tool input into a {@link FileBrokerInput}: require a known `action`, a
 * non-empty `path` for list/read/write, and string `content` for write. Paths are
 * trimmed; `approved` is normalized to a boolean.
 * @param input Raw executor input.
 * @returns The validated input, or an error message for the caller to surface.
 * @throws Never.
 */
function parseInput(input: unknown): { ok: true; value: FileBrokerInput } | { ok: false; error: string } {
  const value = input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};

  const action = value.action;
  if (!isFileBrokerAction(action)) {
    return { ok: false, error: 'file_broker_action requires "action" to be one of: health, list, read, write.' };
  }

  if (action === "health") {
    return { ok: true, value: { action } };
  }

  const filePath = typeof value.path === "string" ? value.path.trim() : "";
  if (!filePath) {
    return { ok: false, error: `file_broker_action action "${action}" requires "path".` };
  }

  if (action === "write") {
    if (typeof value.content !== "string") {
      return { ok: false, error: 'file_broker_action action "write" requires string "content".' };
    }

    return {
      ok: true,
      value: {
        action,
        path: filePath,
        content: value.content,
        approved: value.approved === true
      }
    };
  }

  return { ok: true, value: { action, path: filePath } };
}

/**
 * Type guard for {@link FileBrokerAction} values.
 * @param value Value to test.
 * @returns True when `value` is one of health/list/read/write.
 * @throws Never.
 */
function isFileBrokerAction(value: unknown): value is FileBrokerAction {
  return value === "health" || value === "list" || value === "read" || value === "write";
}

/**
 * Parse a broker response body, tolerating empty and non-JSON payloads.
 * @param text Raw response body.
 * @returns The parsed JSON, `{}` for an empty body, or `{ text }` wrapping non-JSON.
 * @throws Never.
 */
function parseJsonResponse(text: string): unknown {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

/**
 * Extract a human-readable error message from a broker error payload.
 * @param payload Parsed response body.
 * @param fallback Raw body text used when no structured message is present.
 * @returns The payload's `error` or `reason` string, else the first 300 characters of
 *          the raw body.
 * @throws Never.
 */
function brokerErrorMessage(payload: unknown, fallback: string): string {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === "string" && record.error) {
      return record.error;
    }
    if (typeof record.reason === "string" && record.reason) {
      return record.reason;
    }
  }

  return fallback.slice(0, 300);
}
