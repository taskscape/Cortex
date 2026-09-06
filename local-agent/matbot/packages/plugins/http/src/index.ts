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
      text = await res.text();
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
