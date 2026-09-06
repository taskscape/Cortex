/**
 * Token-bucket rate limiter allowing a fixed number of units per second.
 */

/** Maximum wall-clock wait scheduled for a single consume slice. */
const MAX_SINGLE_WAIT_MS = 30_000;

/**
 * Rate limiter that spaces consumption out at a fixed units-per-second rate.
 *
 * Consumers are serialized: each reservation extends the earliest time the
 * next grant may start, so queued callers wait behind all prior
 * reservations.
 */
export class RagV2RateLimiter {
  private nextAvailableAt = 0;
  private readonly unitsPerSecond: number;

  /**
   * Creates a limiter with a fixed per-second allowance.
   * @param unitsPerSecond - Sustained units permitted per second; zero or negative disables limiting entirely.
   * @throws Never.
   */
  constructor(unitsPerSecond: number) {
    this.unitsPerSecond = unitsPerSecond;
  }

  /**
   * Waits until `units` are available at the configured rate. Requests larger
   * than one wait window are split into sequential slices so no single wait
   * is scheduled more than {@link MAX_SINGLE_WAIT_MS} ahead. An aborted wait
   * releases its unused reservation so later consumers are not starved.
   * @param units - Units to consume.
   * @param signal - Abort signal cancelling the wait.
   * @returns Resolves once all units have been granted.
   * @throws Error - When the signal is already aborted or aborts while waiting; the abort reason is rethrown.
   */
  async consume(units: number, signal?: AbortSignal): Promise<void> {
    if (this.unitsPerSecond <= 0 || units <= 0) return;
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Workspace RAG V2 rate-limited operation cancelled.');
    }
    const maxSlice = Math.max(1, Math.floor(this.unitsPerSecond * MAX_SINGLE_WAIT_MS / 1_000));
    let remaining = Math.ceil(units);
    while (remaining > 0 && !signal?.aborted) {
      const slice = Math.min(remaining, maxSlice);
      await this.consumeSlice(slice, signal);
      remaining -= slice;
    }
    if (signal?.aborted) throw abortReason(signal);
  }

  /**
   * Reserves and waits out one slice of the budget.
   *
   * The reservation extends the limiter's next-available time before
   * waiting, so concurrent consumers queue behind it; an aborted wait
   * rewinds the unused reservation.
   * @param units - Units in this slice, at most one wait window's worth.
   * @param signal - Abort signal cancelling the wait.
   * @returns Resolves once the slice's reservation has elapsed.
   * @throws Error - When the signal aborts during the wait; the abort reason is rethrown.
   */
  private async consumeSlice(units: number, signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextAvailableAt);
    const reservedMs = Math.ceil(units / this.unitsPerSecond * 1_000);
    this.nextAvailableAt = scheduledAt + reservedMs;
    const delay = scheduledAt - now;
    if (delay <= 0) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        }, delay);
        const abort = () => {
          clearTimeout(timer);
          reject(abortReason(signal!));
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
    } catch (error) {
      // The reservation was never used; hand the budget back. Approximate
      // when other consumers queued after us, but strictly better than the
      // permanent throughput loss of burning it.
      this.nextAvailableAt = Math.max(now, this.nextAvailableAt - reservedMs);
      throw error;
    }
  }
}

/**
 * Normalizes an abort into an Error for rejection.
 * @param signal - The aborted signal.
 * @returns The signal's `reason` when it is an Error; otherwise a generic cancellation Error.
 * @throws Never.
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Workspace RAG V2 rate-limited operation cancelled.');
}
