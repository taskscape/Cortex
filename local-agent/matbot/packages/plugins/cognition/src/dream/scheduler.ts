import type { MatbotMachine } from '@matatbread/matbot-plugin-api';
import { resolveDreamFallbackProvider, runDreamTimePass } from './service.js';

const DREAM_TIME_INTERVAL_MS = 60 * 60 * 1000;
const DREAM_TIME_STARTUP_DELAY_MS = 60 * 1000;

/**
 * Resolves after `ms` milliseconds, or as soon as `signal` aborts (resolving immediately if the
 * signal is already aborted when called). Never rejects; the caller distinguishes a completed
 * delay from an abort by checking the signal itself.
 * @param ms How long to wait, in milliseconds.
 * @param signal Cancellation signal that cuts the wait short.
 * @returns Resolves when the delay elapses or the signal aborts, whichever comes first.
 * @throws Never.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const id = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(id);
      resolve();
    }, { once: true });
  });
}

/**
 * Runs one dream-time pass against the first registered provider and logs the run's outcome.
 * Failures are logged and swallowed — the scheduler loop must survive a failing pass — and an
 * aborted signal exits silently without logging, since aborts are shutdown, not faults.
 * @param services The matbot machine used to run the pass.
 * @param signal Cancellation signal for the pass; also silences error logging during shutdown.
 * @returns Resolves when the pass finishes or is abandoned.
 * @throws Never.
 */
async function runScheduledPass(services: MatbotMachine, signal: AbortSignal): Promise<void> {
  try {
    const fallbackProvider = resolveDreamFallbackProvider(services);
    const run = await runDreamTimePass(services, fallbackProvider, signal);
    console.info(
      `[dream/scheduler] dream_time run ${run.id} finished: ${run.outcome}; ` +
      `unassigned remaining=${run.unassignedRemaining}`,
    );
  } catch (e) {
    if (signal.aborted) return;
    console.warn('[dream/scheduler] dream_time run failed:', (e as Error).message ?? e);
  }
}

/**
 * Starts the hourly dream_time scheduler loop (after a one-minute startup delay).
 * No-op in sub-agent processes.
 * @param services The matbot machine used to run dream passes.
 * @returns A stop function that aborts the loop.
 */
export function startDreamTimeScheduler(services: MatbotMachine): () => void {
  if (services.isSubAgent()) return () => undefined;

  const ac = new AbortController();
  void (async () => {
    await sleep(DREAM_TIME_STARTUP_DELAY_MS, ac.signal);
    while (!ac.signal.aborted) {
      await runScheduledPass(services, ac.signal);
      await sleep(DREAM_TIME_INTERVAL_MS, ac.signal);
    }
  })();

  return () => ac.abort();
}
