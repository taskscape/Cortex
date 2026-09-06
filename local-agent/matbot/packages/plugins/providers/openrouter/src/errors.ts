/** A safe, bounded OpenRouter failure. Raw upstream bodies are intentionally never retained. */
export class OpenRouterError extends Error {
  readonly options: { status?: number; code?: string; retryAfter?: string; generationId?: string; receivedOutput?: boolean };
  constructor(
    message: string,
    options: { status?: number; code?: string; retryAfter?: string; generationId?: string; receivedOutput?: boolean } = {},
  ) {
    super(message);
    this.name = 'OpenRouterError';
    this.options = options;
  }
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 500) : undefined;
}

/** Build an actionable safe error from a non-success HTTP response. */
export async function openRouterHttpError(response: Response): Promise<OpenRouterError> {
  let body: unknown;
  try { body = JSON.parse(await response.text()); } catch { /* status-only fallback */ }
  const root = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
  const error = root['error'] !== null && typeof root['error'] === 'object' ? root['error'] as Record<string, unknown> : root;
  const code = boundedText(error['code']) ?? boundedText(error['type']);
  const detail = boundedText(error['message']);
  const action = response.status === 401 ? 'Replace or reselect the OpenRouter key.' :
    response.status === 402 ? 'Check OpenRouter account credits and the per-key cap.' :
    response.status === 403 ? 'Inspect OpenRouter account, routing, or permission restrictions.' :
    [400, 404, 422].includes(response.status) ? 'Correct the model ID, limits, or request option.' :
    [408, 429, 500, 502, 503, 504].includes(response.status) ? 'OpenRouter reported a transient failure; retry after the indicated delay.' :
    'Review the OpenRouter profile and try again.';
  return new OpenRouterError(`OpenRouter request failed (${response.status}${code ? ` ${code}` : ''}): ${detail ?? action}`, {
    status: response.status, ...(code !== undefined ? { code } : {}),
    ...(response.headers.get('retry-after') !== null ? { retryAfter: response.headers.get('retry-after')! } : {}),
  });
}

export function openRouterStreamError(message: string, options: ConstructorParameters<typeof OpenRouterError>[1] = {}): OpenRouterError {
  return new OpenRouterError(`OpenRouter stream failed: ${boundedText(message) ?? 'invalid response'}`, options);
}
