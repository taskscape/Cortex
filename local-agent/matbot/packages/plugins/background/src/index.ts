import { spawn, type ChildProcess } from 'node:child_process';
import { execArgv, argv, execPath } from 'node:process';
import { resolve, dirname } from 'node:path';
import { existsSync }       from 'node:fs';
import { pathToFileURL }    from 'node:url';
import { randomUUID }       from 'node:crypto';
import type { Readable }    from 'node:stream';
import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolEvent, ToolContext, FileStore, Store, Principal,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, currentPrincipal } from '@matatbread/matbot-plugin-api';

// ── MIME helpers ──────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
};

/**
 * Map a filename to a MIME type by extension.
 *
 * The extension is taken from the last dot onward and matched case-insensitively against
 * {@link MIME_MAP}. Unknown extensions map to `application/octet-stream`.
 *
 * @param name - Filename whose trailing `.ext` selects the entry; a name with no dot yields the default type.
 * @returns The MIME type for the extension, or "application/octet-stream" when unrecognized.
 * @throws Never.
 */
function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot !== -1 ? name.slice(dot).toLowerCase() : '';
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

// ── Duration helpers ──────────────────────────────────────────────────────────

const DURATION_FACTORS: Record<string, number> = {
  ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000,
};
const MIN_SCHEDULE_INTERVAL_MS = 10_000;

/**
 * Parse a duration string such as "30s", "5m", "1h", or "24h" into milliseconds.
 *
 * Accepts a decimal magnitude followed by one of the units "ms", "s", "m", "h", "d" (see
 * {@link DURATION_FACTORS}). Intervals below {@link MIN_SCHEDULE_INTERVAL_MS} are rejected so
 * recurring schedules cannot fire more often than every 10 seconds.
 *
 * @param s - Duration literal; surrounding whitespace is allowed, a unit is required.
 * @returns The duration in milliseconds.
 * @throws Error - When the string is not a valid duration literal, or the interval is below the 10 second minimum.
 */
function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`Invalid duration "${s}". Use e.g. "30s", "5m", "1h", "24h".`);
  const durationMs = parseFloat(m[1]!) * (DURATION_FACTORS[m[2]!] ?? 1);
  if (!Number.isFinite(durationMs) || durationMs < MIN_SCHEDULE_INTERVAL_MS) {
    throw new Error(`Recurring background intervals must be at least 10s; received "${s}".`);
  }
  return durationMs;
}

/**
 * Render a duration in milliseconds as a compact human-readable string.
 *
 * Prefers the largest unit (d, h, m, s) that divides the value evenly, falling back to a raw
 * millisecond value.
 *
 * @param ms - Duration in milliseconds.
 * @returns A string such as "24h", "5m", "30s", or "750ms".
 * @throws Never.
 */
function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000  === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000     === 0) return `${ms / 60_000}m`;
  if (ms % 1_000      === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

// ── Schedule types & storage ──────────────────────────────────────────────────

/**
 * A persisted background job definition (single-run or recurring) plus its last-occurrence
 * bookkeeping. Stored in the plugin's "schedules" store; `version` is regenerated on every
 * write so the scheduler loop can detect concurrent mutations between its read and write.
 */
interface Schedule {
  id:         string;
  version:    string;
  prompt:     string;
  intervalMs: number;
  createdAt:  string;
  nextRun:    string;
  active?:    boolean;
  name?:      string;
  output?:    string;
  lastRun?:   string;
  lastStartedAt?: string;
  lastStatus?: 'running' | 'succeeded' | 'failed' | 'launch_failed';
  lastExitCode?: number | null;
  lastSchedulerError?: string;
  lastOccurrenceId?: string;
  runCount?: number;
  provider?:  string;
  // Creator identity, captured at creation and replayed each fire so a recurring job runs as the
  // user who scheduled it. Absent on legacy rows ⇒ the child falls back to its own boot default.
  principal?: Principal;
}

let scheduleStore:   Store<Schedule> | undefined;
let activeConfigPath: string | undefined;
let activeFiles:     FileStore | undefined;
let pluginAc:        AbortController | undefined;
/**
 * Terminal outcome of one background child process, as reported by
 * {@link waitForBackgroundChild}.
 */
interface JobResult { status: 'succeeded' | 'failed' | 'launch_failed'; exitCode: number | null; error?: string; }
const childCompletions = new WeakMap<ChildProcess, Promise<JobResult>>();

/**
 * Observe all child/pipe failure paths; bounded draining also covers children whose pipes stay open.
 *
 * Attaches idempotent `error`, stdin-pipe, `exit`, and `close` handlers to the child and resolves
 * with a {@link JobResult}. Spawn failures (child never got a pid) report `launch_failed`; after
 * `exit`, remaining output pipes are drained for up to `graceMs` before they are destroyed and the
 * result degrades to `failed`. The completion is memoized per child in {@link childCompletions},
 * so every observer of the same child shares one result. When `signal` is given, aborting kills
 * the child (SIGKILL after `graceMs`) and resolves with a cancellation failure; without a signal
 * the promise reflects natural completion. Failures themselves trigger a best-effort kill with
 * the same escalation.
 *
 * @param child - The spawned child process to observe.
 * @param signal - Optional abort signal; aborting terminates the child and resolves early. Omit to wait for natural completion.
 * @param graceMs - Deadline in milliseconds for draining pipes, SIGKILL escalation, and cancellation resolution. Defaults to 2000.
 * @returns A promise that resolves (never rejects) with the job's terminal {@link JobResult}.
 * @throws Never.
 */
export function waitForBackgroundChild(child: ChildProcess, signal?: AbortSignal, graceMs = 2_000): Promise<JobResult> {
  let completion = childCompletions.get(child);
  if (!completion) {
    completion = new Promise<JobResult>(resolve => {
      let settled = false;
      let result: JobResult = { status: 'failed', exitCode: null };
      let timer: ReturnType<typeof setTimeout> | undefined;
      /**
       * Resolve the completion promise exactly once, clearing any pending drain/escalation timer.
       *
       * @returns Nothing.
       * @throws Never.
       */
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      /**
       * Record a failure outcome, kill the child, and schedule pipe destruction.
       *
       * @param error - Error whose message is stored on the result.
       * @param launch - True when the child never started (no pid), producing `launch_failed`.
       * @returns Nothing.
       * @throws Never - The kill and pipe teardown are best-effort.
       */
      const fail = (error: Error, launch = false): void => {
        if (settled) return;
        result = { status: launch ? 'launch_failed' : 'failed', exitCode: null, error: error.message };
        finish();
        try { child.kill(); } catch { /* the process may never have started */ }
        if (child.pid !== undefined) {
          timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
            child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
          }, graceMs);
        }
      };
      /**
       * Keep idempotent error handlers until close: a pipe can fail after exit/error.
       *
       * Child `error` handler; treats a spawn failure (no pid) as launch_failed.
       *
       * @param error - Emitted spawn or runtime error.
       * @returns Nothing.
       * @throws Never.
       */
      const onError = (error: Error): void => fail(error, child.pid === undefined);
      /**
       * stdin pipe `error` handler; any pipe failure after spawn is a job failure.
       *
       * @param error - Emitted pipe error.
       * @returns Nothing.
       * @throws Never.
       */
      const onPipeError = (error: Error): void => fail(error);
      child.on('error', onError);
      child.stdin?.on('error', onPipeError);
      child.stdin?.once('close', () => child.stdin?.removeListener('error', onPipeError));
      child.once('exit', code => {
        if (settled) return;
        result = { status: code === 0 ? 'succeeded' : 'failed', exitCode: code };
        timer = setTimeout(() => {
          result = { ...result, status: 'failed', error: 'Background output pipes did not close before the drain deadline.' };
          child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
          finish();
        }, graceMs);
        // Test doubles and ignored stdio have nothing to drain.
        if (!child.stdout && !child.stderr) finish();
      });
      child.once('close', code => {
        if (timer) clearTimeout(timer);
        if (!settled) result = { status: code === 0 ? 'succeeded' : 'failed', exitCode: code };
        finish();
        child.removeListener('error', onError);
      });
    });
    childCompletions.set(child, completion);
  }
  if (!signal) return completion;
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * Abort handler: kill the child now, then escalate to SIGKILL and resolve with a
     * cancellation failure once the grace deadline passes.
     *
     * @returns Nothing.
     * @throws Never.
     */
    const abort = (): void => {
      try { child.kill(); } catch { /* already gone */ }
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        finish({ status: 'failed', exitCode: null, error: 'Background job cancelled; termination deadline reached.' });
      }, graceMs);
    };
    /**
     * Resolve the abort-wrapped promise once, clearing the kill timer and abort listener.
     *
     * @param result - Final outcome to resolve with.
     * @returns Nothing.
     * @throws Never.
     */
    const finish = (result: JobResult): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    completion.then(finish);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
const activeLoops    = new Map<string, AbortController>();
// One entry per schedule while it is sleeping; aborting it wakes the sleep early.
const sleepControllers = new Map<string, AbortController>();

// ── Spawn helpers ─────────────────────────────────────────────────────────────

// When true, background jobs run in a new process group and survive the parent exiting.
// When false, they are tied to the parent's process group.
const DETACH_BACKGROUND_JOBS = false;

/**
 * Rewrite relative-path exec args into absolute file:// URLs.
 *
 * Relative path args (--import, --require, --loader) resolve against the CWD at launch time,
 * which may differ from dirname(argv[1]). Walk up from the script directory until we find the
 * file, then emit a file:// URL so the child resolves it correctly regardless of its own CWD.
 * Args that cannot be located are passed through unchanged.
 *
 * @param scriptPath - Path of the entry script whose directory anchors the upward search.
 * @returns The exec argv with qualifying relative paths replaced by absolute file:// URLs.
 * @throws Never.
 */
function absoluteExecArgv(scriptPath: string): string[] {
  return execArgv.map((arg, i, arr) => {
    const prev = arr[i - 1];
    if (prev !== undefined && ['--import', '--require', '--loader'].includes(prev)) {
      if (arg.startsWith('./') || arg.startsWith('../')) {
        let dir = dirname(scriptPath);
        while (true) {
          const candidate = resolve(dir, arg);
          if (existsSync(candidate)) return pathToFileURL(candidate).href;
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
    }
    return arg;
  });
}

/**
 * Build the ephemeral YAML config piped to a background child on stdin.
 *
 * The config extends the parent's config file, marks itself ephemeral, optionally pins a
 * provider, and embeds the task prompt as a block scalar. Single quotes in the config path and
 * provider are YAML-escaped; prompt lines are indented to keep the block scalar valid.
 *
 * @param configPath - Path of the parent matbot config the child extends.
 * @param prompt - Task prompt; newlines are preserved via indentation.
 * @param provider - Optional default_provider override for the child; omit to inherit the extended config's default.
 * @returns The YAML document text for the child's `--config -` input.
 * @throws Never.
 */
function buildJobConfig(configPath: string, prompt: string, provider?: string): string {
  const escapedPath = configPath.replace(/'/g, "''");
  const indented    = prompt.split('\n').map(l => '  ' + l).join('\n');
  const providerLine = provider !== undefined ? `default_provider: '${provider.replace(/'/g, "''")}'\n` : '';
  return `extends: '${escapedPath}'\nephemeral: true\n${providerLine}prompt: |\n${indented}\n`;
}

/**
 * Re-emit a readable stream as an async iterable of byte chunks for file upload.
 *
 * @param readable - Node readable (e.g. a child's stdout) to forward chunk by chunk.
 * @returns An async iterable yielding each chunk cast to Uint8Array, in arrival order, ending when the source stream ends.
 * @throws Error - Propagates any error the source stream emits during iteration.
 */
async function* stdoutStream(readable: Readable): AsyncIterable<Uint8Array> {
  for await (const chunk of readable) yield chunk as Uint8Array;
}

/**
 * Spawn a detached matbot child process to run one prompt.
 *
 * The child receives an ephemeral config on stdin (built by {@link buildJobConfig}), runs with
 * `IS_SUB_AGENT=1` so it never arms its own scheduler, and optionally runs as the given principal
 * via `MATBOT_PRINCIPAL` (overriding any identity the parent itself inherited). stdout is either
 * discarded (`stdio ignore`) or piped into the {@link FileStore} at `output` via
 * {@link stdoutStream}; stderr is inherited. The child is unref'd so it cannot hold the parent
 * open, and its completion is observed with {@link waitForBackgroundChild}. A spawn failure is
 * emitted on the child (surfacing as `launch_failed`) rather than thrown.
 *
 * @param configPath - Parent config path the child's ephemeral config extends.
 * @param prompt - Task prompt for the child.
 * @param output - Optional workspace filename to capture the child's stdout into; omit to discard stdout.
 * @param files - File store used to write the captured output; capture is skipped unless both this and `output` are provided.
 * @param provider - Optional provider key pinned in the child's config; omit to inherit.
 * @param principal - Optional creator identity replayed to the child as `MATBOT_PRINCIPAL`; omit to let the child use its boot default.
 * @returns The spawned child, or undefined when the parent's entry-script path (`argv[1]`) is unavailable.
 * @throws Never.
 */
function spawnJob(configPath: string, prompt: string, output?: string, files?: FileStore, provider?: string, principal?: Principal): ChildProcess | undefined {
  const script = argv[1];
  if (script === undefined) return undefined;

  const captureOut = output !== undefined && files !== undefined;
  const child = spawn(
    execPath,
    [...absoluteExecArgv(script), script, '--config', '-'],
    {
      detached: DETACH_BACKGROUND_JOBS,
      windowsHide: true,
      stdio:    ['pipe', captureOut ? 'pipe' : 'ignore', 'inherit'],
      // The env channel carries process identity/mode; the piped config (stdin) carries the task.
      // IS_SUB_AGENT prevents the background plugin in the child from arming its own scheduler loop,
      // which would cascade exponentially. MATBOT_PRINCIPAL delegates the creator's identity so the
      // job runs as them — overriding any identity this parent inherited (e.g. a pod default).
      env: {
        ...process.env,
        IS_SUB_AGENT: '1',
        ...(principal !== undefined ? { MATBOT_PRINCIPAL: JSON.stringify(principal) } : {}),
      },
    },
  );
  void waitForBackgroundChild(child);
  if (!child.stdin) {
    child.emit('error', new Error('Background child has no configuration input pipe.'));
    return child;
  }
  try { child.stdin.end(buildJobConfig(configPath, prompt, provider)); }
  catch (error) { child.stdin.emit('error', error); }

  if (captureOut && child.stdout !== null && output !== undefined && files !== undefined) {
    files.put(output, mimeFromName(output), stdoutStream(child.stdout), { namespace: 'workspace', allowed: true })
      .catch((err: unknown) => process.stderr.write(
        `[background] output capture failed for "${output}": ${err instanceof Error ? err.message : String(err)}\n`,
      ));
  }

  child.unref();
  return child;
}

/** Signature of the background job spawner ({@link spawnJob}), swappable for tests via {@link installBackgroundTestHooks}. */
type BackgroundJobLauncher = typeof spawnJob;
let backgroundJobLauncher: BackgroundJobLauncher = spawnJob;
let startupDelayOverrideMs: number | undefined;

/**
 * Deterministic seam for the runtime integration suite. Production callers do
 * not use this; returning a restore function prevents hooks leaking across
 * tests in the same process.
 *
 * @param hooks - Partial set of overrides; keys left undefined keep the currently installed value.
 * @returns A restore function that reinstates the previous launcher and startup delay; intended to be called once at test end.
 * @throws Never.
 */
export function installBackgroundTestHooks(hooks: {
  launchJob?: BackgroundJobLauncher;
  startupDelayMs?: number;
}): () => void {
  const previousLauncher = backgroundJobLauncher;
  const previousDelay = startupDelayOverrideMs;
  if (hooks.launchJob !== undefined) backgroundJobLauncher = hooks.launchJob;
  if (hooks.startupDelayMs !== undefined) startupDelayOverrideMs = hooks.startupDelayMs;
  return () => {
    backgroundJobLauncher = previousLauncher;
    startupDelayOverrideMs = previousDelay;
  };
}

// ── Scheduler loop ────────────────────────────────────────────────────────────

/**
 * Abortable sleep that resolves early when either signal fires.
 *
 * wakeSignal interrupts the sleep without killing the loop (used by suspend/resume).
 * Pass Infinity for ms to sleep until one of the signals fires. Already-aborted signals resolve
 * immediately; delays beyond the 32-bit setTimeout range are clamped to it.
 *
 * @param ms - Sleep duration in milliseconds, or Infinity to sleep until a signal fires.
 * @param signal - Aborting this signal ends the sleep (loop teardown).
 * @param wakeSignal - Optional wake signal that ends the sleep without aborting the loop; omit to sleep only for `ms` or until `signal` aborts.
 * @returns A promise that resolves once the sleep ends for any of the above reasons.
 * @throws Never.
 */
function sleep(ms: number, signal: AbortSignal, wakeSignal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted || wakeSignal?.aborted) { resolve(); return; }
    /**
     * Shared teardown for timer expiry and both abort signals: clear the timer, drop the
     * listeners, and wake the awaiter.
     *
     * @returns Nothing.
     * @throws Never.
     */
    const cleanup = () => {
      if (id !== undefined) clearTimeout(id);
      signal.removeEventListener('abort', cleanup);
      wakeSignal?.removeEventListener('abort', cleanup);
      resolve();
    };
    const id = isFinite(ms) ? setTimeout(cleanup, Math.min(ms, 2_147_483_647)) : undefined;
    signal.addEventListener('abort', cleanup, { once: true });
    wakeSignal?.addEventListener('abort', cleanup, { once: true });
  });
}

/**
 * End a schedule's current sleep early by aborting its wake controller.
 *
 * No-op when the schedule is not currently sleeping. Used by suspend/resume/cancel so state
 * changes take effect without waiting out the remaining interval.
 *
 * @param id - Schedule id whose sleep controller should be aborted.
 * @returns Nothing.
 * @throws Never.
 */
function wakeSchedule(id: string): void {
  const wakeAc = sleepControllers.get(id);
  if (wakeAc) { sleepControllers.delete(id); wakeAc.abort(); }
}

const loopPromises = new Set<Promise<void>>();
const schedulerErrors = new Map<string, string>();
const scheduleMutations = new Map<string, Promise<void>>();

/**
 * Run a store mutation for one schedule serialized after any pending mutation for that id.
 *
 * Chains `operation` onto the schedule's pending-mutation tail so concurrent callers cannot
 * interleave read-modify-write cycles on the same schedule row. The tracked tail swallows errors
 * so one failure never poisons later mutations; the rejection still propagates to this caller.
 *
 * @typeParam T - Resolution type of the operation.
 * @param id - Schedule id whose mutations are serialized.
 * @param operation - Async mutation to run; its result (or rejection) becomes this call's outcome.
 * @returns A promise resolving with `operation`'s result.
 * @throws Error - Whatever `operation` rejects with.
 */
async function mutateSchedule<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const pending = (scheduleMutations.get(id) ?? Promise.resolve()).then(operation);
  const tail = pending.then(() => {}, () => {});
  scheduleMutations.set(id, tail);
  try { return await pending; }
  finally { if (scheduleMutations.get(id) === tail) scheduleMutations.delete(id); }
}

/**
 * Start the scheduler loop for one persisted schedule.
 *
 * No-op when the plugin is not set up or a loop for this schedule already runs. The loop reads
 * the schedule each cycle, waits until `nextRun` (an inactive schedule waits indefinitely), then
 * atomically claims the occurrence (marking it running with a fresh occurrence id), launches the
 * job via {@link backgroundJobLauncher}, waits for completion, and records the outcome together
 * with the next due time. Storage access goes through {@link retry} with exponential backoff; a
 * prior occurrence left `running` by a dead host is marked failed with an unknown-effects note
 * rather than replayed. Aborting `pluginAc` ends the loop; the loop self-deregisters on exit.
 *
 * @param sched - Persisted schedule to arm; its `id` identifies both the loop and the store row.
 * @returns Nothing.
 * @throws Never - Loop failures are logged or recorded in {@link schedulerErrors}.
 */
function armSchedule(sched: Schedule): void {
  if (!activeConfigPath || !pluginAc || !scheduleStore || activeLoops.has(sched.id)) return;
  // Capture this activation's services so teardown/reload cannot redirect an old loop.
  const store = scheduleStore, configPath = activeConfigPath, files = activeFiles;
  const parentSignal = pluginAc.signal;
  const ac = new AbortController();
  /**
   * Forward a parent-plugin abort to this loop's own controller.
   *
   * @returns Nothing.
   * @throws Never.
   */
  const abort = (): void => ac.abort();
  parentSignal.addEventListener('abort', abort, { once: true });
  activeLoops.set(sched.id, ac);
  let lastError: string | undefined;
  /**
   * Retry an async operation until it succeeds or the loop is aborted, with exponential backoff.
   *
   * Failures are recorded in {@link schedulerErrors} (cleared on success) and warned once;
   * backoff starts at 250ms and doubles per attempt, capped at 30s.
   *
   * @typeParam T - Resolution type of the retried operation.
   * @param operation - Async operation to run; re-invoked from scratch after each failure.
   * @returns A promise resolving with the first successful result.
   * @throws DOMException - AbortError when the loop's abort signal fires between attempts (rejects the returned promise).
   */
  const retry = async <T>(operation: () => Promise<T>): Promise<T> => {
    let attempts = 0;
    for (;;) {
      ac.signal.throwIfAborted();
      try {
        const value = await operation();
        schedulerErrors.delete(sched.id);
        return value;
      } catch (error) {
        ac.signal.throwIfAborted();
        lastError = error instanceof Error ? error.message : String(error);
        schedulerErrors.set(sched.id, lastError);
        if (attempts === 0) console.warn('[background] schedule ' + sched.id + ' storage recovery: ' + lastError);
        await sleep(Math.min(250 * 2 ** Math.min(attempts++, 7), 30_000), ac.signal);
      }
    }
  };
  /**
   * Sleep for a delay, waking early when the schedule is mutated, suspended, or resumed.
   *
   * Installs a wake controller in {@link sleepControllers} for the schedule; when `observed` is
   * given, the stored row is re-read and the sleep ends immediately if its `version` changed
   * while installing (closing the read-to-sleep race with suspend/resume).
   *
   * @param ms - Delay in milliseconds; Infinity is supported.
   * @param observed - Optional schedule snapshot; when its `version` no longer matches the store, the sleep ends immediately.
   * @returns A promise resolving when the delay elapses or the wake/loop signal fires.
   * @throws DOMException - AbortError propagated by the retry wrapper when the loop aborts during the version re-check.
   */
  const wait = async (ms: number, observed?: Schedule): Promise<void> => {
    const wake = new AbortController();
    sleepControllers.set(sched.id, wake);
    // Close the read-to-sleep race with suspend/resume while the wake slot is installed.
    if (observed && (await retry(() => store.get(sched.id)))?.version !== observed.version) wake.abort();
    await sleep(ms, ac.signal, wake.signal);
    if (sleepControllers.get(sched.id) === wake) sleepControllers.delete(sched.id);
  };
  /**
   * Main scheduler loop: repeatedly read the schedule, wait until due, claim the occurrence,
   * launch the job, and record the outcome, until aborted or the row disappears.
   *
   * @returns Nothing.
   * @throws Never - Rejections are logged and recorded in {@link schedulerErrors} by the catch handler below.
   */
  const loop = (async (): Promise<void> => {
    let testStartup = startupDelayOverrideMs !== undefined;
    if (testStartup) await wait(startupDelayOverrideMs!);
    while (!ac.signal.aborted) {
      const stored = await retry(() => store.get(sched.id));
      if (!stored) break;
      if (stored.active === false) { await wait(Infinity, stored); continue; }
      const due = Date.parse(stored.nextRun);
      if (!testStartup && Number.isFinite(due) && due > Date.now()) { await wait(due - Date.now(), stored); continue; }
      testStartup = false;
      const startedAt = new Date().toISOString(), occurrenceId = randomUUID();
      const prepared = await retry(() => mutateSchedule(sched.id, async () => {
        const current = await store.get(sched.id);
        if (!current || current.active === false || ac.signal.aborted) return null;
        // A previous recovery write may have committed before its acknowledgement
        // failed. Honour the new due time instead of launching during that retry.
        if (current.lastOccurrenceId !== occurrenceId && current.nextRun !== stored.nextRun
          && Date.parse(current.nextRun) > Date.now()) return null;
        if (current.lastStatus === 'running' && current.lastOccurrenceId !== occurrenceId) {
          // A prior host died with an uncertain occurrence. Record that uncertainty;
          // never replay its side effects immediately after restart/resume.
          await store.set(current.id, { ...current, version: randomUUID(), lastStatus: 'failed',
            lastSchedulerError: 'Previous occurrence was interrupted; its external effects are unknown.',
            nextRun: new Date(Date.now() + current.intervalMs).toISOString() });
          return null;
        }
        const next: Schedule = { ...current, version: randomUUID(), lastStartedAt: startedAt,
          lastStatus: 'running', lastOccurrenceId: occurrenceId,
          ...(lastError ? { lastSchedulerError: lastError } : {}) };
        await store.set(next.id, next);
        return next;
      }));
      if (!prepared || ac.signal.aborted) continue;
      let outcome: JobResult;
      try {
        const child = backgroundJobLauncher(configPath, prepared.prompt, prepared.output, files, prepared.provider, prepared.principal);
        outcome = child ? await waitForBackgroundChild(child, ac.signal) : { status: 'launch_failed', exitCode: null };
      } catch (error) { outcome = { status: 'launch_failed', exitCode: null, error: String(error) }; }
      const completedAt = new Date().toISOString();
      // Retry recording this same occurrence, rather than launching the job again.
      /**
       * Persist this occurrence's outcome and schedule the next run.
       *
       * A no-op unless the stored row still shows this occurrence id as `running`; writes the
       * completion status, exit code, incremented run count, and next due time. Retried via
       * {@link retry} on normal completion; a single best-effort attempt on shutdown.
       *
       * @returns Nothing.
       * @throws Error - Propagates {@link mutateSchedule} rejections (store failures or loop abort); the surrounding callers retry or catch these.
       */
      const recordCompletion = () => mutateSchedule(sched.id, async () => {
        const current = await store.get(sched.id);
        if (!current || current.lastOccurrenceId !== occurrenceId || current.lastStatus !== 'running') return;
        await store.set(current.id, { ...current, version: randomUUID(), lastRun: completedAt,
          lastStatus: outcome.status, lastExitCode: outcome.exitCode, runCount: (current.runCount ?? 0) + 1,
          nextRun: new Date(Date.parse(completedAt) + current.intervalMs).toISOString(),
          ...(lastError ? { lastSchedulerError: lastError } : {}) });
      });
      if (ac.signal.aborted) {
        // One best-effort terminal write on shutdown; never retry forever during teardown.
        await recordCompletion().catch(error => console.warn('[background] cancelled occurrence persistence failed: ' + String(error)));
      } else {
        await retry(recordCompletion);
      }
    }
  })().catch(error => {
    if (!ac.signal.aborted) { schedulerErrors.set(sched.id, String(error)); console.warn('[background] schedule ' + sched.id + ' stopped: ' + String(error)); }
  }).finally(() => {
    parentSignal.removeEventListener('abort', abort);
    if (activeLoops.get(sched.id) === ac) { activeLoops.delete(sched.id); sleepControllers.delete(sched.id); }
    loopPromises.delete(loop);
  });
  loopPromises.add(loop);
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/** Tool input for the `background` tool, matching the shape documented in its schema. */
interface BackgroundInput { prompt: string; interval?: string | null; name?: string; output?: string; provider?: string; }

/** Discriminated action input for the `every_action` tool: list, suspend, resume, or cancel schedules. */
type EveryAction =
  | { action: 'list' }
  | { action: 'suspend'; id: string }
  | { action: 'resume';  id: string }
  | { action: 'cancel';  id: string };

/**
 * Decide whether a `background` interval input means "run once".
 *
 * "Run once" sentinels accepted in place of omitting interval entirely: undefined, null, or the
 * case-insensitive string "once".
 *
 * @param interval - Raw interval field from the tool input.
 * @returns True when the job should run a single time.
 * @throws Never.
 */
function isRunOnce(interval: string | null | undefined): boolean {
  return interval === undefined || interval === null || interval.trim().toLowerCase() === 'once';
}

const backgroundTool: Tool = {
  name: 'background',
  description: `Run a prompt in a detached background process. With no interval it runs once and
returns immediately; with an interval it becomes a recurring schedule that persists across
restarts (manage it afterwards with the every_action tool — the returned id is the handle).

The background process has access to the same tools and providers. Optionally name a workspace
file to capture the process's stdout; without an output file, stdout is discarded.

When the user asks for something in the background, do not wait for the output — notify them the
task has started (and the output filename, if any); they will check the result themselves later.

  type Background =
    | { prompt: string; output?: string; provider?: string }                                  // run once
    | { prompt: string; interval: string; name?: string; output?: string; provider?: string } // repeat every <interval>

interval is a duration like "30s", "5m", "1h", "24h". Omitting it — or passing "once" or null —
runs the prompt a single time.

When running a task in the background, don't wait for the result - the user will be notified. If they
wanted to see the result, they would have asked for it in the foreground.
`,
  inputSchema: {
    type:       'object',
    required:   ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'The task for the background process to carry out.' },
      interval: {
        type:        'string',
        description: 'Recurrence gap, e.g. "30s", "5m", "1h", "24h". Omit (or pass "once"/null) to run a single time.',
      },
      name: {
        type:        'string',
        description: 'Recurring only: optional human-readable label shown in every_action (list).',
      },
      output: {
        type:        'string',
        description: 'Optional workspace filename to capture stdout into (e.g. "summary.md"). If omitted, stdout is discarded.',
      },
      provider: {
        type:        'string',
        description: 'Provider key to use (e.g. "claude-sonnet-4-6"). Defaults to the provider of the current turn.',
      },
    },
  },
  executor: {
    /**
     * Run one prompt immediately, or create and arm a recurring schedule.
     *
     * Run-once inputs (see {@link isRunOnce}) spawn a detached child via
     * {@link backgroundJobLauncher} and yield a "started" result immediately, optionally naming
     * the stdout capture file; the child's completion is only observed for warning logs.
     * Recurring inputs require plugin setup (config path and schedule store), parse the interval
     * with {@link parseDuration}, persist a new {@link Schedule} carrying the ambient principal
     * as creator, and arm its loop.
     *
     * @param input - Raw tool input cast to {@link BackgroundInput}.
     * @param ctx - Tool context; `configPath` (run-once launch) and `provider` (default provider inheritance) are read.
     * @returns Tool events: a result on success, or an error event when the plugin is not set up, the interval is invalid, or launch fails.
     * @throws Error - Propagates schedule store write failures when creating a recurring schedule; all other failures are yielded as error events.
     */
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { prompt, interval, name, output, provider } = input as BackgroundInput;
      // Default to the provider driving this turn, not the config default — a background task
      // inherits the model that spawned it unless the tool call names one explicitly.
      const effectiveProvider = provider ?? ctx.provider;

      if (isRunOnce(interval)) {
        if (!ctx.configPath) {
          yield { type: 'error', message: 'background requires configPath in context.' };
          return;
        }
        const child = backgroundJobLauncher(ctx.configPath, prompt, output, ctx.files, effectiveProvider, currentPrincipal());
        if (!child) { yield { type: 'error', message: 'Background process could not be launched.' }; return; }
        void waitForBackgroundChild(child).then(result => {
          if (result.status !== 'succeeded') console.warn(`[background] one-off job ${result.status}: ${result.error ?? result.exitCode}`);
        });
        yield { type: 'result', value: { status: 'started', ...(output !== undefined ? { output } : {}) } };
        return;
      }

      if (!activeConfigPath || !scheduleStore) {
        yield { type: 'error', message: 'A recurring background job requires the plugin to be set up with a config path.' };
        return;
      }
      let intervalMs: number;
      try { intervalMs = parseDuration(interval!); }
      catch (e) { yield { type: 'error', message: (e as Error).message }; return; }

      const id  = randomUUID();
      const now = new Date();
      const sched: Schedule = {
        id, version: now.getTime().toString(), prompt, intervalMs, active: true,
        createdAt: now.toISOString(),
        nextRun:   new Date(now.getTime() + intervalMs).toISOString(),
        principal: currentPrincipal(),
        ...(name              !== undefined ? { name              } : {}),
        ...(output            !== undefined ? { output            } : {}),
        ...(effectiveProvider !== undefined ? { provider: effectiveProvider } : {}),
      };
      await scheduleStore.set(sched.id, sched);
      armSchedule(sched);
      yield { type: 'result', value: { id, interval, ...(name !== undefined ? { name } : {}) } };
    },
  },
};

// ── every_action lifecycle helpers ──────────────────────────────────────────────

/**
 * Set a schedule's active flag, persist it, and (re)arm or wake its loop.
 *
 * On resume, `nextRun` is reset to now when the schedule was suspended or had no armed loop, so
 * the job runs nearly immediately and then on its interval. The mutation is serialized per id
 * via {@link mutateSchedule}.
 *
 * @param id - Schedule id to update.
 * @param active - True to resume, false to suspend.
 * @returns True when the schedule was found and updated; false when no store is configured or the id is unknown.
 * @throws Error - Propagates store failures from the serialized mutation.
 */
async function setActive(id: string, active: boolean): Promise<boolean> {
  const store = scheduleStore;
  if (!store) return false;
  const next = await mutateSchedule(id, async () => {
    const stored = await store.get(id);
    if (!stored) return null;
    const value = { ...stored, active, version: randomUUID(),
      ...(active && (!activeLoops.has(id) || stored.active === false) ? { nextRun: new Date().toISOString() } : {}) };
    await store.set(id, value);
    return value;
  });
  if (!next) return false;
  if (active) armSchedule(next);
  wakeSchedule(id);
  return true;
}

/**
 * Apply {@link setActive} to every persisted schedule.
 *
 * Suspends schedules that are currently active; resumes suspended schedules plus active
 * schedules with no armed loop (e.g. after a restart).
 *
 * @param active - True to resume all, false to suspend all.
 * @returns Ids of schedules actually changed, in store query order.
 * @throws Error - Propagates store failures from the underlying per-id updates.
 */
async function setActiveAll(active: boolean): Promise<string[]> {
  const result = await scheduleStore?.query({});
  const ids: string[] = [];
  for (const doc of result?.items ?? []) {
    if ((doc.active !== false) === active && (!active || activeLoops.has(doc.id))) continue;
    if (await setActive(doc.id, active)) ids.push(doc.id);
  }
  return ids;
}

const everyActionTool: Tool = {
  name: 'every_action',
  description: `Manage recurring background schedules created by the background tool (when given an interval).

ACTIONS
  list    — Show every schedule with its id, interval, next run time, and active state.
  suspend — Pause a schedule (preserved, stops running until resumed).
  resume  — Resume a suspended schedule (runs nearly immediately, then on its interval).
  cancel  — Permanently delete a schedule. Prefer suspend for a temporary pause.

The id is a schedule id from 'list' or from the background tool. For suspend and resume, pass
id "*" to act on ALL schedules at once. cancel requires a specific id — "*" is not accepted
(no bulk delete).

  type EveryAction =
    | { action: 'list' }
    | { action: 'suspend'; id: string }   // id "*" = all
    | { action: 'resume';  id: string }   // id "*" = all
    | { action: 'cancel';  id: string };  // specific id only`,
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action: {
        type:        'string',
        enum:        ['list', 'suspend', 'resume', 'cancel'],
        description: 'list: show all schedules. suspend/resume: pause or re-enable. cancel: permanently delete.',
      },
      id: {
        type:        'string',
        description: 'Schedule id (suspend/resume/cancel). Use "*" with suspend/resume to act on all; cancel needs a specific id.',
      },
    },
  },
  executor: {
    /**
     * Dispatch a lifecycle action against persisted schedules.
     *
     * `list` reports every schedule with its derived `schedulerState`
     * (recovering/suspended/armed/stopped) plus scheduler and last-run diagnostics.
     * `suspend`/`resume` accept the id `*` to act on all schedules. `cancel` aborts any running
     * loop, wakes its sleep, deletes the store row (serialized via {@link mutateSchedule}), and
     * clears scheduler error state; `*` is rejected for cancel (no bulk delete).
     *
     * @param input - Raw tool input cast to {@link EveryAction}.
     * @param _ctx - Unused tool context (required by the executor signature).
     * @returns Tool events: a result per action, or an error event for unknown schedules, unknown actions, and cancel-with-`*`.
     * @throws Error - Propagates store failures from querying, updating, or deleting schedules; action validation failures are yielded as error events.
     */
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const act = input as EveryAction;

      switch (act.action) {
        case 'list': {
          const result = await scheduleStore?.query({});
          const schedules = result?.items ?? [];
          yield {
            type:  'result',
            value: schedules.map((s: Schedule) => ({
              id:       s.id,
              interval: formatDuration(s.intervalMs),
              nextRun:  s.nextRun,
              active:   s.active !== false,
              schedulerState: schedulerErrors.has(s.id) ? 'recovering' : activeLoops.has(s.id) ? (s.active === false ? 'suspended' : 'armed') : 'stopped',
              ...(schedulerErrors.has(s.id) ? { schedulerError: schedulerErrors.get(s.id) } : {}),
              ...(s.lastSchedulerError ? { lastSchedulerError: s.lastSchedulerError } : {}),
              ...(s.name    !== undefined ? { name:    s.name    } : {}),
              ...(s.lastRun !== undefined ? { lastRun: s.lastRun } : {}),
              ...(s.lastStartedAt !== undefined ? { lastStartedAt: s.lastStartedAt } : {}),
              ...(s.lastStatus !== undefined ? { lastStatus: s.lastStatus } : {}),
              ...(s.lastExitCode !== undefined ? { lastExitCode: s.lastExitCode } : {}),
              ...(s.lastOccurrenceId !== undefined ? { lastOccurrenceId: s.lastOccurrenceId } : {}),
              ...(s.runCount !== undefined ? { runCount: s.runCount } : {}),
              ...(s.output  !== undefined ? { output:  s.output  } : {}),
              ...(s.provider !== undefined ? { provider: s.provider } : {}),
              ...(s.principal !== undefined ? { principalId: s.principal.id } : {}),
            })),
          };
          return;
        }

        case 'suspend':
        case 'resume': {
          const active = act.action === 'resume';
          if (act.id === '*') {
            const ids = await setActiveAll(active);
            yield { type: 'result', value: { [act.action === 'resume' ? 'resumed' : 'suspended']: true, count: ids.length, ids } };
            return;
          }
          if (!(await setActive(act.id, active))) {
            yield { type: 'error', message: `Schedule ${act.id} not found.` };
            return;
          }
          yield { type: 'result', value: { [act.action === 'resume' ? 'resumed' : 'suspended']: true, id: act.id } };
          return;
        }

        case 'cancel': {
          if (act.id === '*') {
            yield { type: 'error', message: 'cancel requires a specific schedule id; "*" (all) is not permitted for cancel. Suspend all with { action: "suspend", id: "*" } instead.' };
            return;
          }
          const ac = activeLoops.get(act.id);
          if (ac) { ac.abort(); activeLoops.delete(act.id); }
          wakeSchedule(act.id);
          await mutateSchedule(act.id, async () => { await scheduleStore?.delete(act.id); });
          schedulerErrors.delete(act.id);
          yield { type: 'result', value: { cancelled: true, id: act.id } };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown every_action "${(act as { action: string }).action}". Expected one of: list, suspend, resume, cancel.` };
      }
    },
  },
};

// ── Plugin ────────────────────────────────────────────────────────────────────

/**
 * Plugin exporting the `background` (spawn detached prompt runs / recurring
 * schedules) and `every_action` (list/suspend/resume/cancel schedules) tools.
 * On setup it arms persisted schedule loops unless running as a sub-agent.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools: [backgroundTool, everyActionTool],

  /**
   * Capture plugin services and arm every persisted schedule.
   *
   * No-op without a config path or when running as a sub-agent (a spawned background job must
   * not arm its own scheduler, which would cascade). Creates the `schedules` store and the
   * plugin abort controller, then arms a loop per stored schedule.
   *
   * @param services - Host machine services; `configPath`, `isSubAgent`, `files`, and `createStore` are consumed.
   * @returns Nothing.
   * @throws Error - When the schedules store cannot be created or queried; arming the loops itself does not throw.
   */
  async setup(services: MatbotMachine) {
    if (!services.configPath) return;
    // A spawned background job must not arm its own scheduler — that would cascade.
    if (services.isSubAgent()) return;
    activeConfigPath = services.configPath;
    activeFiles      = services.files;
    scheduleStore    = services.createStore<Schedule>('schedules');
    pluginAc         = new AbortController();
    const result     = await scheduleStore.query({});
    for (const doc of result.items) armSchedule(doc);
  },

  /**
   * Abort all schedule loops and reset plugin state.
   *
   * Aborts the plugin abort controller (ending every loop and in-flight job wait), waits for all
   * loop promises to settle, clears loop/sleep/error tracking, and drops the captured store,
   * config path, file store, and abort controller.
   *
   * @returns Nothing.
   * @throws Never.
   */
  async teardown() {
    pluginAc?.abort();
    await Promise.allSettled([...loopPromises]);
    activeLoops.clear();
    sleepControllers.clear();
    schedulerErrors.clear();
    scheduleStore    = undefined;
    activeConfigPath = undefined;
    activeFiles      = undefined;
    pluginAc         = undefined;
  },
};
