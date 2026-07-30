/**
 * E2E-020 / T2-E2E-006: Background scheduling validation ensures that scheduled
 * tasks can be created, managed, and executed without user interaction.
 *
 * This test ensures:
 * - Background schedules validate duration parameters (e.g., minimum interval)
 * - Schedule lifecycle state is persisted (created, running, completed, failed)
 * - Bulk cancellation is prevented for safety (must cancel individually)
 * - Schedules are isolated per workspace (cannot access other workspace schedules)
 * - Scheduled tasks run with the correct principal (user identity)
 * - Schedule state survives runtime restarts
 *
 * Assumptions:
 * - The runtime script creates background schedules, verifies their state, and tests
 *   the cancellation safety mechanism
 * - Schedule state is stored in a durable backend (e.g., filesystem or database)
 * - The workspace isolation boundary prevents cross-workspace schedule access
 * - Success is indicated by a specific stdout message about all checks passing
 */
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
