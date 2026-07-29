import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("E2E-020 / T2-E2E-006 background scheduling is persistent, manageable, principal-bound, and workspace-isolated", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/background-scheduling-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    windowsHide: true,
  });
  assert.match(
    stdout + stderr,
    /background schedules validate durations, persist lifecycle state, reject unsafe bulk cancellation, and stay workspace-isolated/
  );
});
