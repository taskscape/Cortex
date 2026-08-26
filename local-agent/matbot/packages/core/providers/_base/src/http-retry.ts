const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS        = 500;
const MAX_DELAY_MS         = 8_000;
const MAX_RETRY_AFTER_MS   = 60_000;

/** Optional knobs for {@link fetchWithRetry}. */
export interface FetchRetryOptions {
  /**
   * Overall wall-clock budget in milliseconds spanning all attempts (including backoff
   * waits). Each attempt gets a per-attempt slice derived from the remaining time, so a
   * hung connection can no longer block a turn indefinitely. When the budget is exhausted
   * the call throws with a descriptive timeout error instead of retrying.
   */
  timeoutMs?: number;
}

/**
 * Whether an HTTP status warrants a retry: 408, 429, or any 5xx.
 *
 * @param status - The response status code.
 * @returns True when the failure is transient.
 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
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

function timeoutError(url: string, timeoutMs: number | undefined): Error {
  return new Error(`Request to ${url} timed out${timeoutMs !== undefined ? ` after ${timeoutMs}ms` : ''}`);
}

/**
 * Fetch with bounded retry for transient connect-time failures — network errors and
 * 408/429/5xx responses. Only safe for requests whose streaming begins after the
 * response headers arrive: a stream that dies mid-flight is never retried here.
 *
 * @param url - The request URL.
 * @param init - Standard fetch init (its `signal`, if any, also cancels pending backoff).
 * @param maxAttempts - Maximum attempts before the last error/response is returned or thrown. Default 3.
 * @param options - Optional extra knobs; `timeoutMs` bounds the total time across all attempts.
 * @returns The final response (success, or a non-transient/exhausted transient failure).
 * @throws The underlying fetch error when a network failure persists past `maxAttempts`, when
 *          `init.signal` aborts, or a timeout error once `options.timeoutMs` is exhausted.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;

  // Compose the caller's signal with an AbortSignal.timeout slice covering this attempt's
  // share of the remaining budget — a hung connection aborts instead of blocking forever.
  const attemptInit = (attempt: number): RequestInit => {
    if (deadline === undefined) return init;
    const attemptsLeft = Math.max(maxAttempts - attempt + 1, 1);
    const remaining    = Math.max(deadline - Date.now(), 1);
    const timer        = AbortSignal.timeout(Math.max(Math.ceil(remaining / attemptsLeft), 1));
    const signal       = init.signal !== undefined && init.signal !== null ? AbortSignal.any([init.signal, timer]) : timer;
    return { ...init, signal };
  };

  const budgetExhausted = (): boolean => deadline !== undefined && Date.now() >= deadline;

  for (let attempt = 1;; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, attemptInit(attempt));
    } catch (e) {
      if (init.signal?.aborted || attempt >= maxAttempts) throw e;
      if (budgetExhausted()) throw timeoutError(url, options.timeoutMs);
      const backoff = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
      await delay(deadline === undefined ? backoff : Math.min(backoff, Math.max(deadline - Date.now(), 0)));
      continue;
    }
    if (!isTransientStatus(res.status) || attempt >= maxAttempts || init.signal?.aborted) {
      return res;
    }
    await res.body?.cancel().catch(() => undefined);
    if (budgetExhausted()) throw timeoutError(url, options.timeoutMs);
    let waitMs = retryAfterMs(res) ?? Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    if (deadline !== undefined) waitMs = Math.min(waitMs, Math.max(deadline - Date.now(), 0));
    await delay(waitMs);
  }
}
