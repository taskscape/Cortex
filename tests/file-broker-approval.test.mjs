/**
 * T3-E2E-004: High-risk file-broker writes require explicit approval and cannot
 * escape through symbolic junctions on Windows.
 *
 * This test validates that the file-broker service enforces its security policy
 * for high-risk write operations (writes that modify existing files or create
 * files in sensitive locations). The file-broker requires explicit approval
 * before allowing such operations, and it blocks attempts to bypass this check
 * by using Windows symbolic links or junctions to write outside the allowed roots.
 *
 * Assumptions:
 * - The file-broker service is correctly configured with a security policy that
 *   identifies certain write operations as "high-risk"
 * - The runtime test script simulates an unapproved high-risk write attempt
 * - The file-broker properly validates the operation against its policy and
 *   rejects it with a specific error message
 * - Windows junction/symlink detection is working correctly in the broker
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("T3-E2E-004 / MISSING-06 high-risk file-broker writes require approval and cannot escape through junctions", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/file-broker-approval-runtime.mjs",
  ], { cwd: process.cwd(), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /file-broker rejects unapproved high-risk writes/);
});
