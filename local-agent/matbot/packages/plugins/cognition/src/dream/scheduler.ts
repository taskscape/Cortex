import type { MatbotMachine } from '@matatbread/matbot-plugin-api';
import { resolveDreamFallbackProvider, runDreamTimePass } from './service.js';

const DREAM_TIME_INTERVAL_MS = 60 * 60 * 1000;
const DREAM_TIME_STARTUP_DELAY_MS = 60 * 1000;

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
