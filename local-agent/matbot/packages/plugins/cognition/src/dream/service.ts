import type { MatbotMachine } from '@matatbread/matbot-plugin-api';
import { createLlmMerger } from './llmMerger.js';
import { createLlmRanker } from './llmRanker.js';
import { runOnce } from './runOnce.js';
import type { DreamRun } from './types.js';
import { DREAM_MERGER_PROVIDER_KEY, DREAM_RANKER_PROVIDER_KEY } from '../inner-voice/tool.js';

// Process-local mutex. A Promise the next caller awaits; the chain extends with every call and
// settles in order. Manual dream_time calls and the automatic scheduler both come through here.
let runChain: Promise<unknown> = Promise.resolve();

function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = runChain.then(fn, fn);
  runChain = next.catch(() => undefined);
  return next;
}

/**
 * Picks the default provider used by dream ranker/merger when nothing is pinned.
 * @param services The matbot machine.
 * @returns The first registered provider key, or `undefined` if none exist.
 */
export function resolveDreamFallbackProvider(services: MatbotMachine): string | undefined {
  return [...services.providers.keys()][0];
}

/**
 * Runs a single dream-time pass (rank + merge unassigned memories) and persists
 * the resulting DreamRun. Passes are serialised process-wide.
 * @param services The matbot machine.
 * @param fallbackProvider Provider used when no ranker/merger provider is pinned.
 * @param signal Abort signal cancelling the pass.
 * @returns The completed dream run.
 * @throws If no fallback provider is configured or the named one is missing.
 */
export async function runDreamTimePass(
  services: MatbotMachine,
  fallbackProvider: string | undefined,
  signal: AbortSignal,
): Promise<DreamRun> {
  if (fallbackProvider === undefined) {
    throw new Error(
      'dream_time needs a fallback provider. Configure at least one provider, or pin ' +
      'dreamRankerProvider/dreamMergerProvider with cognition_config.',
    );
  }
  if (!services.providers.has(fallbackProvider)) {
    throw new Error(
      `dream_time fallback provider "${fallbackProvider}" is not configured. Configured providers: ` +
      `${[...services.providers.keys()].join(', ') || '(none)'}.`,
    );
  }

  const [rankerPinned, mergerPinned] = await Promise.all([
    services.settings().get<string>(DREAM_RANKER_PROVIDER_KEY),
    services.settings().get<string>(DREAM_MERGER_PROVIDER_KEY),
  ]);
  const rankerProvider = (rankerPinned !== undefined && services.providers.has(rankerPinned)) ? rankerPinned : fallbackProvider;
  const mergerProvider = (mergerPinned !== undefined && services.providers.has(mergerPinned)) ? mergerPinned : fallbackProvider;

  const ranker = createLlmRanker(services, rankerProvider);
  const merger = createLlmMerger(services, mergerProvider);
  const run = await serialise(() => runOnce(services, ranker, merger, signal));

  try {
    const dreamRuns = services.createStore<DreamRun>('dream_runs');
    await dreamRuns.set(run.id, run);
  } catch (e) {
    console.warn('[dream/service] failed to persist DreamRun:', (e as Error).message ?? e);
  }

  return run;
}
