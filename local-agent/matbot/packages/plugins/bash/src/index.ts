import type { Tool, ToolEvent, ToolContext, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

export interface DockerConfig {
  image:    string;
  /** Docker --network value. Defaults to Docker's own default (bridge). */
  network?: string;
}

interface BashInput {
  script:   string;
  cwd?:     string;
  env?:     Record<string, string>;
  timeout?: number;
}

// setTimeout wraps delays > 2^31-1 (and < 1) down to ~1ms, so an unsanitized LLM-supplied
// timeout of e.g. 99999999999 would kill the command instantly.
const MAX_TIMEOUT_MS   = 2_147_000_000;
const KILL_GRACE_MS    = 5_000;
const MAX_OUTPUT_BYTES = 1_000_000;

function sanitizeTimeout(timeout: number | undefined): number | undefined {
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
    ? Math.min(Math.trunc(timeout), MAX_TIMEOUT_MS)
    : undefined;
}

// Bridge event-emitter callbacks to an AsyncIterable<ToolEvent>.
function spawnAndStream(
  command: string,
  args:    string[],
  opts:    { cwd?: string; env: Record<string, string>; timeout?: number; signal: AbortSignal },
): AsyncIterable<ToolEvent> {
  const queue: Array<ToolEvent | null> = [];
  let wakeup: (() => void) | null = null;

  const push = (ev: ToolEvent | null): void => {
    queue.push(ev);
    wakeup?.();
    wakeup = null;
  };

  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: false });

  const timeoutMs = sanitizeTimeout(opts.timeout);

  let stopReason: 'timeout' | 'aborted' | 'overflow' | null = null;
  let stopped = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: 'timeout' | 'aborted' | 'overflow'): void => {
    if (stopped) return;
    stopped = true;
    stopReason = reason;
    child.kill('SIGTERM');
    // A child ignoring SIGTERM must not outlive its deadline — escalate to SIGKILL.
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  };

  const killOnAbort = (): void => { stop('aborted'); };
  opts.signal.addEventListener('abort', killOnAbort, { once: true });

  let stdoutAcc = '';
  let stderrAcc = '';
  let totalBytes = 0;
  let finalized = false;

  const onData = (d: Buffer, kind: 'stdout' | 'stderr'): void => {
    if (finalized) return;
    const remaining = MAX_OUTPUT_BYTES - totalBytes;
    const slice = d.length > remaining ? d.subarray(0, Math.max(0, remaining)) : d;
    const chunk = slice.toString();
    if (chunk) {
      if (kind === 'stdout') stdoutAcc += chunk; else stderrAcc += chunk;
      totalBytes += slice.length;
      push({ type: kind, chunk });
    }
    if (d.length > remaining) {
      stop('overflow');
      finalized = true;
      push({ type: 'error', message: `Output exceeded the ${MAX_OUTPUT_BYTES}-byte limit; process killed.`,
        ...(stdoutAcc ? { stdout: stdoutAcc } : {}),
        ...(stderrAcc ? { stderr: stderrAcc } : {}),
      });
      push(null);
    }
  };

  child.stdout?.on('data', (d: Buffer) => onData(d, 'stdout'));
  child.stderr?.on('data', (d: Buffer) => onData(d, 'stderr'));
  child.on('error', (e: Error) => {
    if (finalized) return;
    finalized = true;
    push({ type: 'error', message: e.message });
    push(null);
  });
  child.on('close', (code: number | null) => {
    if (timer !== undefined) clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (finalized) return;
    finalized = true;
    if (stopReason === 'timeout' || stopReason === 'aborted') {
      const why = stopReason === 'timeout' ? `timed out after ${timeoutMs}ms` : 'was aborted';
      push({ type: 'error', message: `Process ${why} and was killed.`,
        ...(stdoutAcc ? { stdout: stdoutAcc } : {}),
        ...(stderrAcc ? { stderr: stderrAcc } : {}),
      });
    } else if (code !== null && code !== 0) {
      push({ type: 'error', message: `Process exited with code ${code}`, code,
        ...(stdoutAcc ? { stdout: stdoutAcc } : {}),
        ...(stderrAcc ? { stderr: stderrAcc } : {}),
      });
    } else {
      push({ type: 'result', value: { exitCode: code ?? 0, stdout: stdoutAcc, stderr: stderrAcc } });
    }
    push(null);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => stop('timeout'), timeoutMs);
  }

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ToolEvent>> {
          while (queue.length === 0) {
            await new Promise<void>(r => { wakeup = r; });
          }
          const item = queue.shift()!;
          if (item === null) {
            if (timer !== undefined) clearTimeout(timer);
            opts.signal.removeEventListener('abort', killOnAbort);
            return { done: true, value: undefined as never };
          }
          return { done: false, value: item };
        },
        async return(): Promise<IteratorResult<ToolEvent>> {
          stop('aborted'); // consumer abandoned us early — don't leave the command running
          if (timer !== undefined) clearTimeout(timer);
          opts.signal.removeEventListener('abort', killOnAbort);
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}

// ── Executors ─────────────────────────────────────────────────────────────────

function createLocalExecutor() {
  return {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { script, cwd: cwdInput, env, timeout } = input as BashInput;
      const cwd = cwdInput ?? ctx.workdir;
      if (cwd !== undefined) await mkdir(cwd, { recursive: true });

      const mergedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) mergedEnv[k] = v;
      }
      if (env) Object.assign(mergedEnv, env);

      yield* spawnAndStream('bash', ['-c', script], {
        ...(cwd     !== undefined ? { cwd }     : {}),
        ...(timeout !== undefined ? { timeout } : {}),
        env: mergedEnv, signal: ctx.signal,
      });
    },
  };
}

function createDockerExecutor(docker: DockerConfig) {
  return {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { script, env, timeout } = input as BashInput;

      const args = ['run', '--rm', '-i'];

      if (docker.network !== undefined) {
        args.push('--network', docker.network);
      }

      // Mount the session workspace so scripts can read/write workspace files.
      const workdir = ctx.workdir ?? process.cwd();
      args.push('-v', `${workdir}:/workspace`, '--workdir', '/workspace');

      // Only pass explicitly provided env vars — do not leak process.env into the container.
      for (const [k, v] of Object.entries(env ?? {})) {
        args.push('-e', `${k}=${v}`);
      }

      args.push(docker.image, 'bash', '-c', script);

      yield* spawnAndStream('docker', args, {
        ...(timeout !== undefined ? { timeout } : {}),
        env: {}, signal: ctx.signal,
      });
    },
  };
}

// ── Tool factory ──────────────────────────────────────────────────────────────

const TOOL_DESCRIPTION =
  'Run a bash script and stream stdout/stderr in real time. ' +
  'Pass any shell command or multi-line script in the `script` field — it is executed as `bash -c <script>`. ' +
  'Output streams line by line as it is produced. A non-zero exit code yields an error event with accumulated stdout/stderr attached. ' +
  'Use for file operations, build steps, running tests, package installs, or any shell automation. ' +
  'The working directory defaults to the session workspace.';

const INPUT_SCHEMA = {
  type:       'object',
  required:   ['script'],
  properties: {
    script:  { type: 'string', description: 'Bash script or command to run (passed to `bash -c`).' },
    cwd:     { type: 'string', description: 'Working directory. Defaults to the session workspace.' },
    env:     { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables to set.' },
    timeout: { type: 'number', description: 'Kill the process after this many milliseconds.' },
  },
} as const;

/**
 * Creates a `bash` tool backed by either a local shell or a Docker container.
 * The tool name and input schema are identical in both cases — callers (including
 * the LLM) cannot distinguish the two implementations.
 */
export function createBashTool(docker?: DockerConfig): Tool {
  return {
    name:        'bash',
    description: TOOL_DESCRIPTION,    inputSchema: INPUT_SCHEMA,
    executor:    docker ? createDockerExecutor(docker) : createLocalExecutor(),
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const bashTool: Tool = createBashTool();

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [bashTool],
};
