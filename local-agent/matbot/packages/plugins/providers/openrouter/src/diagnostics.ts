import { OPENROUTER_API_ORIGIN } from './config.js';
import { openRouterHttpError } from './errors.js';

/** Result of an explicit authenticated key check. It deliberately does not imply model inference works. */
export interface OpenRouterKeyDiagnostic {
  ok: boolean;
  checkedAt: string;
  limit?: number | null;
  remaining?: number | null;
  error?: string;
}

/** Call OpenRouter's key endpoint only when an operator explicitly requests diagnostics. */
export async function checkOpenRouterKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<OpenRouterKeyDiagnostic> {
  const checkedAt = new Date().toISOString();
  if (!apiKey.trim() || /^\$\{[^}]+\}$/.test(apiKey.trim())) return { ok: false, checkedAt, error: 'OpenRouter API key is missing or unresolved.' };
  try {
    const response = await fetchImpl(`${OPENROUTER_API_ORIGIN}/key`, {
      headers: { authorization: `Bearer ${apiKey}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await openRouterHttpError(response);
    const root = await response.json() as { data?: { limit?: unknown; limit_remaining?: unknown } };
    const data = root?.data;
    return {
      ok: true, checkedAt,
      ...(data?.limit === null ? { limit: null } : typeof data?.limit === 'number' && Number.isFinite(data.limit) ? { limit: data.limit } : {}),
      ...(data?.limit_remaining === null ? { remaining: null } : typeof data?.limit_remaining === 'number' && Number.isFinite(data.limit_remaining) ? { remaining: data.limit_remaining } : {}),
    };
  } catch (error) {
    return { ok: false, checkedAt, error: error instanceof Error ? error.message.slice(0, 500) : 'OpenRouter key check failed.' };
  }
}
