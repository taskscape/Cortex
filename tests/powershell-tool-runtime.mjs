import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scenario = process.argv[2] ?? "happy";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "matbot-powershell-test-"));
const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
const originalTmpDir = process.env.TMPDIR;
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
process.env.TMPDIR = tempRoot;

const { powershellTool } = await import("../local-agent/matbot/packages/plugins/powershell/src/index.ts");

function restoreTempEnvironment() {
  for (const [name, value] of [["TEMP", originalTemp], ["TMP", originalTmp], ["TMPDIR", originalTmpDir]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function collect(input) {
  const events = [];
  for await (const event of powershellTool.executor.execute(input, {
    callId: "powershell-integration-test",
    signal: new AbortController().signal,
    session: {
      id: "s",
      version: "v",
      status: "active",
      contexts: [],
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })) {
    events.push(event);
  }
  return events;
}

async function assertNoTemporaryScripts() {
  const scriptsDir = path.join(tempRoot, "matbot-powershell");
  let entries = [];
  try { entries = await readdir(scriptsDir); } catch { /* no scripts were written */ }
  assert.deepEqual(entries.filter(entry => entry.endsWith(".ps1")), [], "the generated .ps1 file should be removed after execution");
}

async function expectMissing(target) {
  await assert.rejects(access(target));
}

async function runHappyPath() {
  const workdir = path.join(tempRoot, "working directory");
  await mkdir(workdir, { recursive: true });
  const events = await collect({
    script: [
      'Write-Output "cwd=$((Get-Location).Path)"',
      'Write-Output "env=$env:MATBOT_PS_TEST"',
      'Write-Output "policy=$env:PSExecutionPolicyPreference"',
      'Write-Output "script=$PSCommandPath"',
    ].join("\n"),
    cwd: workdir,
    env: { MATBOT_PS_TEST: "ok" },
    timeout: 10_000,
  });
  const result = events.find(event => event.type === "result");
  assert.ok(result, `expected success result, got ${JSON.stringify(events)}`);
  assert.equal(result.value.exitCode, 0);
  assert.match(result.value.stdout, /env=ok/);
  assert.match(result.value.stdout, /policy=Bypass/i);
  assert.match(result.value.stdout, new RegExp(`cwd=${workdir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  assert.match(result.value.stdout, new RegExp(`script=${path.join(tempRoot, "matbot-powershell").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  await assertNoTemporaryScripts();
}

async function runInjectionIsolation() {
  const workdir = path.join(tempRoot, "cwd;still-a-directory");
  const sentinel = path.join(tempRoot, "unexpected-injection.txt");
  await mkdir(workdir, { recursive: true });
  const payload = `; New-Item -ItemType File -Force -Path '${sentinel.replace(/'/g, "''")}'`;
  const events = await collect({
    script: 'Write-Output "literal=$env:MATBOT_PS_LITERAL"',
    cwd: workdir,
    env: { MATBOT_PS_LITERAL: payload },
    timeout: 10_000,
  });
  const result = events.find(event => event.type === "result");
  assert.ok(result, `expected success result, got ${JSON.stringify(events)}`);
  assert.match(result.value.stdout, /literal=; New-Item -ItemType File/);
  await expectMissing(sentinel);
  await assertNoTemporaryScripts();
}

async function runTimeout() {
  const sentinel = path.join(tempRoot, "timeout-should-not-reach.txt");
  const startedAt = Date.now();
  const events = await collect({
    script: [
      'Write-Output "started"',
      "Start-Sleep -Seconds 10",
      `New-Item -ItemType File -Force -Path '${sentinel.replace(/'/g, "''")}'`,
    ].join("\n"),
    timeout: 250,
  });
  const elapsed = Date.now() - startedAt;
  const error = events.find(event => event.type === "error");
  assert.ok(error, `expected a timeout error, got ${JSON.stringify(events)}`);
  assert.match(error.message, /timed out after 250ms/i);
  assert.equal(events.some(event => event.type === "result"), false, "a timed-out PowerShell process must not report success");
  assert.ok(elapsed < 5_000, `PowerShell timeout took ${elapsed}ms`);
  await expectMissing(sentinel);
  await assertNoTemporaryScripts();
}

try {
  if (scenario === "happy") await runHappyPath();
  else if (scenario === "injection") await runInjectionIsolation();
  else if (scenario === "timeout") await runTimeout();
  else throw new Error(`Unknown PowerShell test scenario: ${scenario}`);
  console.log(`powershell tool ${scenario} integration passes`);
} finally {
  restoreTempEnvironment();
  await rm(tempRoot, { recursive: true, force: true });
}
