import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { powershellTool } = await import("../local-agent/matbot/packages/plugins/powershell/src/index.ts");

const workdir = await mkdtemp(path.join(os.tmpdir(), "matbot-powershell-test-"));

try {
  const events = [];
  for await (const event of powershellTool.executor.execute({
    script: [
      'Write-Output "cwd=$((Get-Location).Path)"',
      'Write-Output "env=$env:MATBOT_PS_TEST"',
    ].join("\n"),
    cwd: workdir,
    env: { MATBOT_PS_TEST: "ok" },
    timeout: 10_000,
  }, {
    callId: "test",
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

  const result = events.find(event => event.type === "result");
  assert.ok(result, `expected result event, got ${JSON.stringify(events)}`);
  assert.equal(result.value.exitCode, 0);
  assert.match(result.value.stdout, /env=ok/);
  assert.match(result.value.stdout, new RegExp(`cwd=${workdir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
} finally {
  await rm(workdir, { recursive: true, force: true });
}

console.log("powershell tool executes scripts with cwd/env support");
