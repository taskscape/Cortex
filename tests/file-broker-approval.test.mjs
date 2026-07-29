import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("T3-E2E-004 high-risk file-broker writes require approval and cannot escape through junctions", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/file-broker-approval-runtime.mjs",
  ], { cwd: process.cwd(), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /file-broker rejects unapproved high-risk writes/);
});
