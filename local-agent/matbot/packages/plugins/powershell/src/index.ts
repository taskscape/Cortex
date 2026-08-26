import type { Tool, ToolEvent, ToolContext, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

interface PowerShellInput {
  script:   string;
  cwd?:     string;
  env?:     Record<string, string>;
  timeout?: number;
}

// setTimeout wraps delays > 2^31-1 (and < 1) down to ~1ms, so an unsanitized LLM-supplied
// timeout of e.g. 99999999999 would kill the script instantly.
const MAX_TIMEOUT_MS   = 2_147_000_000;
const KILL_GRACE_MS    = 5_000;
const MAX_OUTPUT_BYTES = 1_000_000;

function sanitizeTimeout(timeout: number | undefined): number | undefined {
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
    ? Math.min(Math.trunc(timeout), MAX_TIMEOUT_MS)
    : undefined;
}

// Only these variables reach LLM-initiated commands. Never spread process.env: matbot loads
// vault-resolved credentials into it, and every extra variable is one `$env:` read away
// from exfiltration.
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
] as const;

/** Minimal safe default environment built from an explicit allowlist (case-insensitive lookup). */
export function safeDefaultEnv(): Record<string, string> {
  const available = new Map(Object.entries(process.env).map(([k, v]) => [k.toUpperCase(), v]));
  const out: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const v = available.get(key);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Resolve a requested working directory against the tool's base directory and refuse anything
 * that escapes it — including sibling paths that merely share a prefix (`/base` vs `/base-x`).
 */
export function confineWorkspaceCwd(requested: string | undefined, base: string): string {
  const resolvedBase = resolve(base);
  const resolved     = resolve(resolvedBase, requested ?? '.');
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + sep)) {
    throw new Error(`Requested cwd "${requested}" is outside the session workspace.`);
  }
  return resolved;
}

function powershellExecutable(): string {
  return process.platform === 'win32' ? 'powershell.exe' : 'powershell';
}

async function createScriptRun(script: string): Promise<{ dir: string; scriptPath: string }> {
  const base = join(tmpdir(), 'matbot-powershell');
  await mkdir(base, { recursive: true });
  // Per-run mkdtemp: scripts never share one stable, predictable directory across runs.
  const dir        = await mkdtemp(join(base, 'run-'));
  const scriptPath = join(dir, `${randomUUID()}.ps1`);
  await writeFile(scriptPath, script, 'utf8');
  return { dir, scriptPath };
}

// Bridge event-emitter callbacks to an AsyncIterable<ToolEvent>.
function spawnAndStream(
  command: string,
  args:    string[],
  opts:    { cwd?: string; env: Record<string, string>; timeout?: number; signal: AbortSignal },
): AsyncIterable<ToolEvent> {
  const queue: Array<ToolEvent | null> = [];
  let wakeup: (() => void) | null = null;
  let done = false;

  const push = (ev: ToolEvent | null): void => {
    queue.push(ev);
    wakeup?.();
    wakeup = null;
  };

  const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: false });

  const timeoutMs = sanitizeTimeout(opts.timeout);

  let stdoutAcc = '';
  let stderrAcc = '';
  let finalized = false;
  let stopped = false;
  let stopReason: 'timeout' | 'aborted' | 'overflow' | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason: 'timeout' | 'aborted' | 'overflow'): void => {
    if (stopped || finalized) return;
    stopped = true;
    stopReason = reason;
    // On Windows Node maps SIGTERM to TerminateProcess.  Keep the signal named
    // rather than using a shell command so timeout and abort input cannot alter
    // what is executed.
    child.kill('SIGTERM');
    // A child ignoring SIGTERM must not outlive its deadline — escalate.
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  };
  const killOnAbort = (): void => { stop('aborted'); };
  opts.signal.addEventListener('abort', killOnAbort, { once: true });

  let totalBytes = 0;
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
      const why = stopReason === 'timeout'
        ? `timed out after ${timeoutMs ?? 0}ms`
        : 'was aborted';
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

  if (timeoutMs !== undefined) {
    timer = setTimeout(() => stop('timeout'), timeoutMs);
  }

  async function finish(): Promise<void> {
    if (done) return;
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    opts.signal.removeEventListener('abort', killOnAbort);
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
            await finish();
            return { done: true, value: undefined as never };
          }
          return { done: false, value: item };
        },
        async return(): Promise<IteratorResult<ToolEvent>> {
          stop('aborted');
          await finish();
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}

const TOOL_DESCRIPTION =
  'Run a Windows PowerShell script and stream stdout/stderr in real time. ' +
  'Pass any PowerShell script or command in the `script` field; it is written to a temporary .ps1 file ' +
  'and executed as `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <file>`. ' +
  'Output streams line by line as it is produced. A non-zero exit code yields an error event with accumulated stdout/stderr attached. ' +
  'Use for Windows-native file operations, build steps, running tests, package installs, service control, or scheduled local automation. ' +
  'The working directory defaults to the session workspace.';

const INPUT_SCHEMA = {
  type:       'object',
  required:   ['script'],
  properties: {
    script:  { type: 'string', description: 'PowerShell script or command to run from a temporary .ps1 file.' },
    cwd:     { type: 'string', description: 'Working directory, resolved against and confined to the session workspace. Defaults to the session workspace.' },
    env:     { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables to set.' },
    timeout: { type: 'number', description: 'Kill the process after this many milliseconds.' },
  },
} as const;

/**
 * The `powershell` tool. Writes the supplied script to a temporary .ps1 file and runs it with
 * `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <file>`, streaming
 * stdout/stderr events as they are produced. Timeout, abort, and output-overflow all kill the
 * process; a non-zero exit yields an error event carrying accumulated output.
 */
export const powershellTool: Tool = {
  name:        'powershell',
  description: TOOL_DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { script, cwd: cwdInput, env, timeout } = input as PowerShellInput;

      let cwd: string;
      try {
        cwd = confineWorkspaceCwd(cwdInput, ctx.workdir ?? process.cwd());
      } catch (e) {
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
        return;
      }
      await mkdir(cwd, { recursive: true });

      const mergedEnv = { ...safeDefaultEnv(), ...(env ?? {}) };

      const { dir, scriptPath } = await createScriptRun(script);
      try {
        yield* spawnAndStream(powershellExecutable(), [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
        ], {
          ...(timeout !== undefined ? { timeout } : {}),
          env: mergedEnv,
          signal: ctx.signal,
          cwd,
        });
      } finally {
        // Runs on completion, abort, timeout, overflow, and consumer abandonment alike.
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  },
};

/** Plugin spec registering the {@link powershellTool}. */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [powershellTool],
};
