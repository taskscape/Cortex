import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_MAX_JSON_BYTES = 1_000_000;

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
 * before the request completes, so in-flight work can be cancelled.
 *
 * @param request - The incoming request to observe.
 * @returns A signal that is aborted with a disconnect error if the client goes away.
 */
export function requestAbortSignal(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error("HTTP client disconnected."));
  };
  if (request.aborted) abort();
  request.once("aborted", abort);
  request.once("close", () => {
    if (!request.complete) abort();
  });
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
 * status from an {@link HttpError}, otherwise 500.
 *
 * @param response - The server response to write to.
 * @param error - The thrown value to report; its message (or string form) is
 * returned as the `error` field of the JSON payload.
 */
export function sendJsonError(response: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
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
