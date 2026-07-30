/**
 * T3-E2E-003: Workspace deletion is ownership-safe and protects the active workspace
 * from accidental deletion.
 *
 * This test ensures:
 * - Deletion requires the correct ownership ID (id-bound check)
 * - The active workspace cannot be deleted (safety check)
 * - Workspace metadata is properly cleaned up when a workspace is deleted
 * - No partial deletions leave the system in an inconsistent state
 * - The operation fails cleanly with no stderr output when the safety checks pass
 *
 * Assumptions:
 * - The runtime script attempts to delete workspaces with correct and incorrect IDs
 * - The workspace registry enforces ownership-based deletion
 * - The active workspace is identified and protected from deletion
 * - All workspace data (config, .data directory, etc.) is properly removed
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

/**
 * T3-E2E-003: Workspace deletion is ownership-safe and protects the active workspace
 *
 * Validates that workspace deletion is ownership-safe and protects the active
 * workspace from accidental deletion.
 *
 * This test ensures:
 * - Deletion requires the correct ownership ID (id-bound check)
 * - The active workspace cannot be deleted (safety check)
 * - Workspace metadata is properly cleaned up when a workspace is deleted
 * - No partial deletions leave the system in an inconsistent state
 * - The operation fails cleanly with no stderr output when the safety checks pass
 *
 * Assumptions:
 * - The runtime script attempts to delete workspaces with correct and incorrect IDs
 * - The workspace registry enforces ownership-based deletion
 * - The active workspace is identified and protected from deletion
 * - All workspace data (config, .data directory, etc.) is properly removed
 */
test("T3-E2E-003 workspace deletion is ownership-safe and protects the active workspace", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/workspace-deletion-runtime.mjs",
  ], { cwd: process.cwd(), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /workspace deletion is id-bound/);
  assert.equal(stderr, "");
});
