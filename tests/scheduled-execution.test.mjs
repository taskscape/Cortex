import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("T3-E2E-005 scheduled execution records one policy-bound occurrence with inherited identity", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/scheduled-execution-runtime.mjs",
  ], { cwd: process.cwd(), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /scheduled child execution preserves principal/);
});
