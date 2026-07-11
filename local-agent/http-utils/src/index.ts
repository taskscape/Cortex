import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_MAX_JSON_BYTES = 1_000_000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export interface ReadJsonOptions<T> {
  maxBytes?: number;
  validate?: (value: unknown) => value is T;
}

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

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

export function sendJsonError(response: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
