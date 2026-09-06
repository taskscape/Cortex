/**
 * Request and streaming lifetime owned by one provider completion.
 *
 * The signal combines the consumer's abort signal with the deadline controller
 * {@link withCompletionDeadline} installs, so it fires both on caller cancellation and when any
 * timeout expires.
 */
export interface CompletionDeadline {
  /** Aborts on caller cancellation or when the request, idle, or overall deadline expires. */
  signal: AbortSignal;
  /** Milliseconds allowed for the HTTP request to reach the response headers. */
  requestTimeoutMs: number;
  /** Start/reset the idle deadline after headers or a useful SSE payload. */
  progress(): void;
}

/**
 * Read an integer millisecond setting from provider parameters, falling back to a default.
 *
 * @param parameters - Provider parameters; `undefined` or a missing key selects `fallback`.
 * @param key - The parameter key to read.
 * @param fallback - The value used when the key is absent.
 * @returns The setting in milliseconds.
 * @throws Error - When the value is present but not an integer within `[1, 3600000]`.
 */
function timeoutSetting(parameters: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = parameters?.[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3_600_000) {
    throw new Error(`Provider ${key} must be an integer from 1 to 3600000 milliseconds.`);
  }
  return value;
}

/**
 * Run a provider completion under a layered deadline. Four abort sources are combined into one
 * signal: the caller's signal, a per-request header timeout (`requestTimeoutMs`, default
 * 60000 ms), a stream-idle timeout (`streamIdleTimeoutMs`, default 120000 ms) reset by the
 * deadline's `progress()`, and an overall completion timeout (`completionTimeoutMs`, default
 * 600000 ms). All three settings are integer milliseconds in `[1, 3600000]`; every timer is
 * cleared on every exit path. The iterable is lazy — no timer starts until the first pull.
 *
 * @typeParam T - The event type produced by the wrapped completion.
 * @param caller - The consumer's abort signal; combined with the internal deadline controller.
 * @param parameters - Provider parameters consulted for the three timeout keys; `undefined` selects all defaults.
 * @param run - Invoked once with the deadline to produce the completion's events.
 * @returns An async iterable forwarding `run`'s events in order.
 * @throws The combined signal's abort reason when `caller` aborts or any deadline fires; otherwise the error raised by `run`, rethrown unchanged.
 */
export async function* withCompletionDeadline<T>(
  caller: AbortSignal,
  parameters: Record<string, unknown> | undefined,
  run: (deadline: CompletionDeadline) => AsyncIterable<T>,
): AsyncIterable<T> {
  const requestTimeoutMs = timeoutSetting(parameters, 'requestTimeoutMs', 60_000);
  const idleMs = timeoutSetting(parameters, 'streamIdleTimeoutMs', 120_000);
  const totalMs = timeoutSetting(parameters, 'completionTimeoutMs', 600_000);
  const controller = new AbortController();
  const signal = AbortSignal.any([caller, controller.signal]);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const overall = setTimeout(() => controller.abort(new Error(`Provider completion timed out after ${totalMs}ms.`)), totalMs);
  const progress = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error(`Provider stream idle timeout after ${idleMs}ms.`)), idleMs);
  };
  try {
    signal.throwIfAborted();
    yield* run({ signal, requestTimeoutMs, progress });
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(overall);
    if (idle) clearTimeout(idle);
  }
}
