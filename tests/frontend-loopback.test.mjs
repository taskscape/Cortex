import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("T2-E2E-001 documented WebUI boundary is loopback-only", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/frontend-loopback-runtime.mjs"
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    windowsHide: true
  });
  assert.match(stdout + stderr, /frontend binds to loopback and rejects non-loopback connections/);
});
