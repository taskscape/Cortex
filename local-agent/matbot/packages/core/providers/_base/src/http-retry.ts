const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS        = 500;
const MAX_DELAY_MS         = 8_000;
const MAX_RETRY_AFTER_MS   = 60_000;

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(raw);
  return Number.isNaN(at)
    ? undefined
    : Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

/**
 * Fetch with bounded retry for transient connect-time failures — network errors and
 * 408/429/5xx responses. Only safe for requests whose streaming begins after the
 * response headers arrive: a stream that dies mid-flight is never retried here.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<Response> {
  for (let attempt = 1;; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (attempt >= maxAttempts || init.signal?.aborted) throw e;
      await delay(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS), init.signal);
      continue;
    }
    if (!isTransientStatus(res.status) || attempt >= maxAttempts || init.signal?.aborted) {
      return res;
    }
    await res.body?.cancel().catch(() => undefined);
    await delay(retryAfterMs(res) ?? Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS), init.signal);
  }
}
