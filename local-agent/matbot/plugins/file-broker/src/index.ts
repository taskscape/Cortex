interface ToolContext {
  signal: AbortSignal;
}

type ToolEvent =
  | { type: "result"; value: unknown }
  | { type: "error"; message: string; code?: number | string };

interface ToolExecutor {
  execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executor: ToolExecutor;
}

interface ToolRegistry {
  register(tool: Tool): void;
}

interface MatbotMachine {
  tools: ToolRegistry;
}

interface MatbotPluginSpec {
  apiVersion: string;
  setup(services: MatbotMachine): Promise<void> | void;
}

type FileBrokerAction = "health" | "list" | "read" | "write";

type FileBrokerInput =
  | { action: "health" }
  | { action: "list"; path: string }
  | { action: "read"; path: string }
  | { action: "write"; path: string; content: string; approved?: boolean };

export interface FileBrokerClientOptions {
  baseUrl: string;
}

export class FileBrokerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
    message: string
  ) {
    super(message);
    this.name = "FileBrokerRequestError";
  }
}

export class FileBrokerClient {
  constructor(private readonly options: FileBrokerClientOptions) {}

  health(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/health", { signal });
  }

  list(filePath: string, signal?: AbortSignal): Promise<unknown> {
    const url = this.url("/list");
    url.searchParams.set("path", filePath);
    return this.requestUrl("GET", url, { signal });
  }

  read(filePath: string, signal?: AbortSignal): Promise<unknown> {
    const url = this.url("/read");
    url.searchParams.set("path", filePath);
    return this.requestUrl("GET", url, { signal });
  }

  write(filePath: string, content: string, approved: boolean, signal?: AbortSignal): Promise<unknown> {
    return this.request("POST", "/write", {
      signal,
      body: JSON.stringify({ path: filePath, content, approved })
    });
  }

  private request(method: string, pathname: string, options: { body?: string; signal?: AbortSignal } = {}): Promise<unknown> {
    return this.requestUrl(method, this.url(pathname), options);
  }

  private async requestUrl(method: string, url: URL, options: { body?: string; signal?: AbortSignal } = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: options.body !== undefined ? { "content-type": "application/json" } : undefined,
        body: options.body,
        signal: options.signal
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

  private url(pathname: string): URL {
    return new URL(pathname, this.options.baseUrl);
  }
}

export function createFileBrokerTool(client: FileBrokerClient): Tool {
  return {
    name: "file_broker_action",
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
          description: "Set true only after explicit user approval for high-risk writes."
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
          yield { type: "result", value: await runAction(client, parsed.value, ctx.signal) };
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

export const plugin: MatbotPluginSpec = {
  apiVersion: "0.1",
  setup(services) {
    const client = new FileBrokerClient({ baseUrl: fileBrokerBaseUrl() });
    services.tools.register(createFileBrokerTool(client));
  }
};

export default plugin;

function fileBrokerBaseUrl(): string {
  return process.env.FILE_BROKER_BASE_URL ?? `http://localhost:${process.env.FILE_BROKER_PORT ?? "8878"}`;
}

async function runAction(client: FileBrokerClient, input: FileBrokerInput, signal: AbortSignal): Promise<unknown> {
  switch (input.action) {
    case "health":
      return client.health(signal);
    case "list":
      return client.list(input.path, signal);
    case "read":
      return client.read(input.path, signal);
    case "write":
      return client.write(input.path, input.content, input.approved === true, signal);
  }
}

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

function isFileBrokerAction(value: unknown): value is FileBrokerAction {
  return value === "health" || value === "list" || value === "read" || value === "write";
}

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
