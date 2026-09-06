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
  /** Do not shorten a server Retry-After hint. If it cannot fit the remaining budget, return the response. */
  honorRetryAfterFully?: boolean;
  /** Test/integration injection point; production callers use the platform fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Return false for failures that must not be retried (for example, an authenticated redirect). */
  shouldRetryError?: (error: unknown) => boolean;
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

/**
 * Wait `ms` milliseconds; reject with the signal's abort reason if `signal` fires first (or was
 * already aborted).
 *
 * @param ms - The backoff duration in milliseconds.
 * @param signal - Optional abort signal; aborting rejects the wait early.
 * @returns A promise that resolves after the delay, or rejects with the abort reason.
 * @throws The abort `signal`'s reason when it fires before the delay elapses.
 */
function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = (): void => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Read a response's `Retry-After` header, accepting either delay-seconds or an HTTP-date, and
 * clamp the result to `[0, 60000]` ms.
 *
 * @param res - The response whose header to read.
 * @returns The wait in milliseconds, or `undefined` when the header is absent or unparseable.
 * @throws Never.
 */
function retryAfterMs(res: Response, clamp = true): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) {
    const value = Math.max(secs, 0) * 1000;
    return clamp ? Math.min(value, MAX_RETRY_AFTER_MS) : value;
  }
  const at = Date.parse(raw);
  return Number.isNaN(at)
    ? undefined
    : (clamp ? Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS) : Math.max(at - Date.now(), 0));
}

/**
 * Build the descriptive timeout error thrown when the overall budget is exhausted.
 *
 * @param url - The request URL, echoed into the message.
 * @param timeoutMs - The configured budget in milliseconds, when one was set.
 * @returns The error to throw.
 * @throws Never.
 */
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

  // Header timers must be cleared once fetch returns; they must not later abort a
  // healthy response body. The caller owns the streaming/overall deadline.
  /**
   * Build the init for one attempt, layering a per-attempt slice of the remaining budget as a
   * header timeout over the caller's signal.
   *
   * @param attempt - The 1-based attempt number; later attempts get a proportionally smaller
   *                  slice of the time that is left.
   * @returns The fetch init to use (its signal combines the caller's with the attempt timer),
   *          plus `clear()`, which must run once the headers arrive so the timer can never abort
   *          a healthy response body.
   * @throws Never.
   */
  const attemptInit = (attempt: number): { init: RequestInit; clear(): void } => {
    if (deadline === undefined) return { init, clear() {} };
    const attemptsLeft = Math.max(maxAttempts - attempt + 1, 1);
    const remaining    = Math.max(deadline - Date.now(), 1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutError(url, options.timeoutMs)), Math.max(Math.ceil(remaining / attemptsLeft), 1));
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return { init: { ...init, signal }, clear: () => clearTimeout(timer) };
  };

  /**
   * Whether the overall wall-clock budget has been consumed.
   *
   * @returns True once `Date.now()` has reached the deadline; always false when no budget is set.
   * @throws Never.
   */
  const budgetExhausted = (): boolean => deadline !== undefined && Date.now() >= deadline;

  for (let attempt = 1;; attempt++) {
    init.signal?.throwIfAborted();
    if (budgetExhausted()) throw timeoutError(url, options.timeoutMs);
    let res: Response;
    const request = attemptInit(attempt);
    try {
      try { res = await (options.fetchImpl ?? fetch)(url, request.init); }
      finally { request.clear(); }
    } catch (e) {
      if (init.signal?.aborted || attempt >= maxAttempts || options.shouldRetryError?.(e) === false) throw e;
      if (budgetExhausted()) throw timeoutError(url, options.timeoutMs);
      const backoff = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
      await delay(deadline === undefined ? backoff : Math.min(backoff, Math.max(deadline - Date.now(), 0)), init.signal);
      continue;
    }
    if (!isTransientStatus(res.status) || attempt >= maxAttempts || init.signal?.aborted) {
      return res;
    }
    await res.body?.cancel().catch(() => undefined);
    if (budgetExhausted()) throw timeoutError(url, options.timeoutMs);
    let waitMs = retryAfterMs(res, !options.honorRetryAfterFully) ?? Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    if (deadline !== undefined) {
      const remaining = Math.max(deadline - Date.now(), 0);
      // Returning the transient response lets the adapter classify it with the server's original
      // retry hint. Retrying earlier than a long Retry-After is both impolite and incorrect.
      if (options.honorRetryAfterFully && waitMs > remaining) return res;
      waitMs = Math.min(waitMs, remaining);
    }
    await delay(waitMs, init.signal);
  }
}
