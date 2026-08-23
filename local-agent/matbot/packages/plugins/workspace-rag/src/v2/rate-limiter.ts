/**
 * Token-bucket rate limiter allowing a fixed number of units per second.
 */
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
   * Waits until `units` are available at the configured rate.
   * @param units - Units to consume.
   * @param signal - Abort signal cancelling the wait.
   */
  async consume(units: number, signal?: AbortSignal): Promise<void> {
    if (this.unitsPerSecond <= 0 || units <= 0) return;
    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextAvailableAt);
    this.nextAvailableAt = scheduledAt + Math.ceil(units / this.unitsPerSecond * 1_000);
    const delay = scheduledAt - now;
    if (delay <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, delay);
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error('Workspace RAG V2 rate-limited operation cancelled.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}
