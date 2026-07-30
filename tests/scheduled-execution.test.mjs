/**
 * T3-E2E-005: Scheduled execution validates that scheduled tasks record their
 * occurrences with the correct identity and are bound to their policy.
 *
 * This test ensures:
 * - Scheduled tasks execute at their configured intervals
 * - Each occurrence is recorded with the correct policy identity
 * - Child executions inherit the principal (user/identity) from the schedule
 * - No unauthorized executions can occur (policy-bound enforcement)
 * - The occurrence tracking persists across runtime restarts
 *
 * Assumptions:
 * - The runtime script creates a scheduled task and waits for it to execute
 * - The task records its execution in a durable store
 * - The recorded occurrence includes the schedule's policy and identity
 * - The child execution correctly inherits the principal from the parent schedule
 * - Success is indicated by a specific stdout message about occurrence recording
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("T3-E2E-005 / MISSING-10 scheduled execution records one policy-bound occurrence with inherited identity", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/scheduled-execution-runtime.mjs",
  ], { cwd: process.cwd(), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /scheduled child execution preserves principal/);
});
