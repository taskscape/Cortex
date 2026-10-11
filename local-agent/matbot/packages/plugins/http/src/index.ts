import type { Tool, ToolEvent, ToolContext, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

/** Input accepted by the `http` tool: request target plus optional method, headers, body, and response parsing preference. */
interface HttpInput {
  url:           string;
  method?:       string;
  headers?:      Record<string, string>;
  body?:         string;
  responseType?: 'text' | 'json';
}

const DEFAULT_TIMEOUT_MS = 30_000;

// The body is buffered whole before it is returned, and the URL is the model's choice: without a
// cap one request for a large download exhausts the process's memory. Results above the tool
// output limit are truncated for the model anyway; this only bounds what is held to get there.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Read a response body as UTF-8 text, refusing bodies larger than `maxBytes`.
 *
 * @param res - The response to read.
 * @param maxBytes - Largest body accepted.
 * @returns The decoded body.
 * @throws Error - When the body exceeds `maxBytes` (the download is cancelled) or the stream fails.
 */
async function readBodyText(res: Response, maxBytes: number): Promise<string> {
  if (res.body === null) return '';
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      received += value.byteLength;
      if (received > maxBytes) throw new Error(`response exceeded the ${maxBytes}-byte limit`);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * @param e - The caught value.
 * @returns `e.message` for `Error` instances, otherwise `String(e)`.
 * @throws Never.
 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const executor = {
  async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const { url, method = 'GET', headers = {}, body, responseType = 'text' } = input as HttpInput;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]),
      });
    } catch (e) {
      yield { type: 'error', message: errorMessage(e) };
      return;
    }

    let text: string;
    try {
      text = await readBodyText(res, MAX_RESPONSE_BYTES);
    } catch (e) {
      yield { type: 'error', message: `Failed to read response: ${errorMessage(e)}` };
      return;
    }

    if (!res.ok) {
      yield { type: 'error', message: `HTTP ${res.status}: ${text}`, code: res.status };
      return;
    }

    if (responseType === 'json') {
      try {
        yield { type: 'result', value: JSON.parse(text) as unknown };
      } catch {
        yield { type: 'error', message: `Non-JSON response: ${text.slice(0, 200)}` };
      }
    } else {
      yield { type: 'result', value: text };
    }
  },
};

/**
 * The `http` tool. Performs a single HTTP request via `fetch` and yields the response body as text
 * or parsed JSON. Network errors, non-2xx statuses, and JSON parse failures are reported as error
 * events rather than thrown.
 */
export const httpTool: Tool = {
  name:        'http',
  description: 'Make an HTTP request and return the response body.',
  inputSchema: {
    type:       'object',
    required:   ['url'],
    properties: {
      url:          { type: 'string', description: 'The URL to request.' },
      method:       { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'GET' },
      headers:      { type: 'object', additionalProperties: { type: 'string' } },
      body:         { type: 'string', description: 'Request body for POST/PUT/PATCH.' },
      responseType: { type: 'string', enum: ['text', 'json'], default: 'text' },
    },
  },
  executor,
};

/** Plugin spec registering the {@link httpTool}. */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [httpTool],
};
