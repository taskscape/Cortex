import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function runScenario(scenario) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/powershell-tool-runtime.mjs",
    scenario,
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.match(stdout + stderr, new RegExp(`powershell tool ${scenario} integration passes`));
}

test("PowerShell tool executes a temporary script with cwd, environment, and Bypass policy", { skip: process.platform !== "win32" }, async () => {
  await runScenario("happy");
});

test("PowerShell tool keeps cwd and environment values out of shell parsing", { skip: process.platform !== "win32" }, async () => {
  await runScenario("injection");
});

test("PowerShell tool reports a timed-out long-running process as an error and cleans up its script", { skip: process.platform !== "win32" }, async () => {
  await runScenario("timeout");
});

test("PowerShell tool ends a timed-out script together with the processes it started", { skip: process.platform !== "win32" }, async () => {
  await runScenario("tree-timeout");
});

test("PowerShell tool gives a command that reads its input end-of-input instead of an open pipe", { skip: process.platform !== "win32" }, async () => {
  await runScenario("stdin");
});

test("PowerShell tool returns once the script exits even if a process it started keeps the output open", { skip: process.platform !== "win32" }, async () => {
  await runScenario("left-running");
});

test("PowerShell tool stops a script whose call was already cancelled when it started", { skip: process.platform !== "win32" }, async () => {
  await runScenario("pre-aborted");
});

test("PowerShell invocation retains the documented non-interactive, no-profile argument boundary", async () => {
  const source = await readFile("local-agent/matbot/packages/plugins/powershell/src/index.ts", "utf8");
  assert.match(source, /spawn\(command, args, \{ cwd: opts\.cwd, env: opts\.env, shell: false, stdio: \['ignore', 'pipe', 'pipe'\] \}\)/);
  assert.match(source, /'-NoProfile',\s*'-NonInteractive',\s*'-ExecutionPolicy',\s*'Bypass',\s*'-File',\s*scriptPath/s);
});
