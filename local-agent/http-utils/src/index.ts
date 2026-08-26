import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_MAX_JSON_BYTES = 1_000_000;
const DEFAULT_TOKEN_HEADER = "x-cortex-token";

/**
 * An error carrying an HTTP status code, thrown by request-handling helpers so
 * endpoints can respond with the appropriate status via {@link sendJsonError}.
 */
export class HttpError extends Error {
  /**
   * Creates a new HTTP error.
   *
   * @param status - The HTTP status code to send to the client.
   * @param message - Human-readable error description.
   */
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** Options controlling how a JSON request body is read and validated. */
export interface ReadJsonOptions<T> {
  /** Maximum accepted body size in bytes; defaults to 1,000,000. */
  maxBytes?: number;
  /** Optional type guard applied after parsing; failure yields HTTP 400. */
  validate?: (value: unknown) => value is T;
}

/**
 * Reads and parses the request body as JSON with size and content-type guards.
 *
 * @param request - The incoming HTTP request whose body is consumed.
 * @param options - Optional size limit and validation guard.
 * @returns The parsed (and optionally validated) body value.
 * @throws HttpError 415 if Content-Type is present but not application/json.
 * @throws HttpError 413 if the body exceeds `maxBytes`.
 * @throws HttpError 400 if the body is not valid JSON or fails validation.
 */
export async function readJsonBody<T>(request: IncomingMessage, options: ReadJsonOptions<T> = {}): Promise<T> {
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_JSON_BYTES);
  const contentType = request.headers["content-type"];
  if (contentType !== undefined && !contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, `JSON body exceeds the ${maxBytes}-byte limit.`);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new HttpError(413, `JSON body exceeds the ${maxBytes}-byte limit.`);
    chunks.push(buffer);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
  if (options.validate !== undefined && !options.validate(value)) {
    throw new HttpError(400, "Request JSON does not match the endpoint contract.");
  }
  return value as T;
}

/**
 * Creates an {@link AbortSignal} that aborts when the HTTP client disconnects
 * before the request completes, so in-flight work can be cancelled. The
 * internal listeners are removed once the request closes, including on normal
 * completion, so keep-alive connections do not accumulate listeners.
 *
 * @param request - The incoming request to observe.
 * @returns A signal that is aborted with a disconnect error if the client goes away.
 */
export function requestAbortSignal(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => {
    cleanup();
    if (!controller.signal.aborted) controller.abort(new Error("HTTP client disconnected."));
  };
  const onClose = (): void => {
    if (!request.complete) {
      abort();
      return;
    }
    cleanup();
  };
  const cleanup = (): void => {
    request.removeListener("aborted", abort);
    request.removeListener("close", onClose);
  };
  if (request.aborted) {
    abort();
    return controller.signal;
  }
  request.once("aborted", abort);
  request.once("close", onClose);
  return controller.signal;
}

/**
 * Serialises a payload as JSON and writes it to the response with a status
 * code and JSON content-type headers, then ends the response.
 *
 * @param response - The server response to write to.
 * @param status - HTTP status code to send.
 * @param payload - Value serialised with `JSON.stringify`.
 */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

/**
 * Sends a JSON error body derived from an unknown thrown value: uses the
 * message and status from an {@link HttpError}; anything else is logged
 * server-side (it may contain absolute paths or other internal detail) and
 * reported to the client with a generic 500 message.
 *
 * @param response - The server response to write to.
 * @param error - The thrown value to report; only {@link HttpError} messages
 * are returned to the client in the `error` field of the JSON payload.
 */
export function sendJsonError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  console.error("[http-utils] request failed:", error);
  sendJson(response, 500, { error: "Internal server error." });
}

/**
 * Checks that the request's `Host` header names the loopback origin
 * (`127.0.0.1`, `localhost`, or `[::1]`, each with an optional port), as a
 * defense against DNS-rebinding attacks against localhost-only services.
 *
 * @param request - The incoming HTTP request whose Host header is inspected.
 * @throws HttpError 403 when the Host header is missing or foreign.
 */
export function assertLoopbackRequest(request: IncomingMessage): void {
  const header = request.headers.host;
  if (header === undefined || !isLoopbackHost(header)) {
    throw new HttpError(403, "Forbidden.");
  }
}

/**
 * Checks that the request carries the configured shared secret. When no token
 * is configured (undefined or empty), every request is accepted so existing
 * local workflows keep working without configuration.
 *
 * @param request - The incoming HTTP request whose token header is inspected.
 * @param token - The required shared secret, or undefined to disable checks.
 * @param headerName - Header carrying the secret; defaults to `x-cortex-token`.
 * @throws HttpError 401 when a token is configured but missing or mismatched.
 */
export function assertSharedToken(request: IncomingMessage, token: string | undefined, headerName = DEFAULT_TOKEN_HEADER): void {
  if (!token) return;
  const presented = request.headers[headerName];
  if (typeof presented !== "string" || !tokensEqual(presented, token)) {
    throw new HttpError(401, "Unauthorized.");
  }
}

function isLoopbackHost(hostHeader: string): boolean {
  const host = hostHeader.trim().toLowerCase();
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.includes(":") ? host.slice(0, host.lastIndexOf(":")) : host;
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Type guard for plain JSON objects.
 *
 * @param value - Value to test.
 * @returns True if the value is a non-null object that is not an array.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
