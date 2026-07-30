/**
 * Workspace switching handoff: validates the process handoff when switching between
 * different Cortex workspaces. Each workspace is served by a dedicated Matbot process,
 * and switching workspaces requires cleanly stopping the outgoing process and starting
 * a new one for the target workspace.
 *
 * This test ensures:
 * - The outgoing process releases its HTTP port promptly, even if a request is stuck
 *   mid-request (preventing port bind conflicts)
 * - The workspace registry correctly identifies which process is serving each workspace
 * - The WebUI can reliably determine when a switch has completed vs. when the old
 *   process is still active
 * - The switch operation is atomic and doesn't leave workspaces in an inconsistent state
 *
 * Assumptions:
 * - The Matbot runtime properly implements process shutdown with HTTP connection draining
 * - The workspace registry stores process PID and port information
 * - The runtime script exercises the workspace-switching flow and reports results
 *   via ##RESULT## lines to stdout
 * - Each scenario in the runtime must pass (ok: true) for the overall test to pass
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("workspace switch handoff", { timeout: 120_000 }, async t => {
  let stdout = "", stderr = "", spawnError;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, [
      "--import",
      "./local-agent/matbot/apps/cli/register.js",
      "tests/workspace-switch-runtime.mjs",
    ], { cwd: process.cwd(), timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    ({ stdout = "", stderr = "" } = error);
    spawnError = error;
  }

  const results = stdout.split("\n")
    .filter(line => line.startsWith("##RESULT##"))
    .map(line => JSON.parse(line.slice("##RESULT##".length)));

  if (results.length === 0) {
    assert.fail(`the workspace-switch runtime produced no results.\n${stdout}\n${stderr}\n${spawnError?.message ?? ""}`);
  }

  for (const result of results) {
    await t.test(result.name, () => {
      if (!result.ok) assert.fail(result.error);
    });
  }
});
