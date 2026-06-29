import type { Tool, ToolEvent, ToolContext, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

interface PowerShellInput {
  script:   string;
  cwd?:     string;
  env?:     Record<string, string>;
  timeout?: number;
}

function powershellExecutable(): string {
  return process.platform === 'win32' ? 'powershell.exe' : 'powershell';
}

async function writeScriptFile(script: string): Promise<string> {
  const dir = join(tmpdir(), 'matbot-powershell');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.ps1`);
  await writeFile(path, script, 'utf8');
  return path;
}

// Bridge event-emitter callbacks to an AsyncIterable<ToolEvent>.
function spawnAndStream(
  command: string,
  args:    string[],
  opts:    { cwd?: string; env: Record<string, string>; timeout?: number; signal: AbortSignal; cleanup: () => Promise<void> },
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

  const killOnAbort = (): void => { child.kill('SIGTERM'); };
  opts.signal.addEventListener('abort', killOnAbort, { once: true });

  let stdoutAcc = '';
  let stderrAcc = '';
  let finalized = false;

  child.stdout?.on('data', (d: Buffer) => {
    const chunk = d.toString();
    stdoutAcc += chunk;
    push({ type: 'stdout', chunk });
  });
  child.stderr?.on('data', (d: Buffer) => {
    const chunk = d.toString();
    stderrAcc += chunk;
    push({ type: 'stderr', chunk });
  });
  child.on('error', (e: Error) => {
    if (finalized) return;
    finalized = true;
    push({ type: 'error', message: e.message });
    push(null);
  });
  child.on('close', (code: number | null) => {
    if (finalized) return;
    finalized = true;
    if (code !== null && code !== 0) {
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
  if (opts.timeout !== undefined) {
    timer = setTimeout(() => child.kill('SIGTERM'), opts.timeout);
  }

  async function finish(): Promise<void> {
    if (done) return;
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    opts.signal.removeEventListener('abort', killOnAbort);
    await opts.cleanup();
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
          child.kill('SIGTERM');
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
    cwd:     { type: 'string', description: 'Working directory. Defaults to the session workspace.' },
    env:     { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables to set.' },
    timeout: { type: 'number', description: 'Kill the process after this many milliseconds.' },
  },
} as const;

export const powershellTool: Tool = {
  name:        'powershell',
  description: TOOL_DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const { script, cwd: cwdInput, env, timeout } = input as PowerShellInput;
      const cwd = cwdInput ?? ctx.workdir;
      if (cwd !== undefined) await mkdir(cwd, { recursive: true });

      const mergedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) mergedEnv[k] = v;
      }
      if (env) Object.assign(mergedEnv, env);

      const scriptPath = await writeScriptFile(script);
      yield* spawnAndStream(powershellExecutable(), [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ], {
        ...(cwd     !== undefined ? { cwd }     : {}),
        ...(timeout !== undefined ? { timeout } : {}),
        env: mergedEnv,
        signal: ctx.signal,
        cleanup: () => rm(scriptPath, { force: true }),
      });
    },
  },
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [powershellTool],
};
