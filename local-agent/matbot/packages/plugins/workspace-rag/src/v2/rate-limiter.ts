/**
 * Token-bucket rate limiter allowing a fixed number of units per second.
 */

/** Maximum wall-clock wait scheduled for a single consume slice. */
const MAX_SINGLE_WAIT_MS = 30_000;

export class RagV2RateLimiter {
  private nextAvailableAt = 0;
  private readonly unitsPerSecond: number;

  /**
   * @param unitsPerSecond - Sustained units permitted per second.
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

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Workspace RAG V2 rate-limited operation cancelled.');
}
