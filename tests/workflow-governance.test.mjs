/**
 * E2E-005: Workflow governance validation ensures that workflow executions are
 * properly tracked, approved, and audited through an event-sourced architecture.
 *
 * This test ensures:
 * - Workflow runs are recorded with their inputs, outputs, and metadata
 * - Approval workflows are enforced before workflow execution (if required)
 * - Event sourcing captures the complete history of each workflow run
 * - Workflow state (pending, running, completed, failed) is persisted
 * - Audit trails can be reconstructed from the event log
 *
 * Assumptions:
 * - The runtime script creates a workflow, submits it for approval (if needed),
 *   and verifies the event-sourced recording
 * - Events are stored in a durable append-only log
 * - Success is indicated by a specific stdout message about event-sourced recording
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("E2E-005 workflow-governance runtime flow passes under the Matbot TypeScript loader", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/workflow-governance-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout + stderr, /workflow-governance records event-sourced runs/);
});
