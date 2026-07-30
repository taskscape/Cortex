/**
 * E2E-015 / T3-E2E-015: Structured data validation ensures governed SQL execution
 * with approval expiry and proper boundaries.
 *
 * This test ensures:
 * - SQL queries must be explicitly approved before execution (approval workflow)
 * - Approvals have an expiry time and are invalidated after expiration
 * - Generated SQL is governed by the configured boundaries (allowed tables, columns)
 * - The SQL plan is validated against the database schema before execution
 * - Unauthorized or unsafe SQL is rejected (no DROP, ALTER, etc.)
 *
 * Assumptions:
 * - The structured-data plugin implements an approval workflow for SQL generation
 * - The runtime script creates SQL plans and validates them against the governance rules
 * - The approval system stores approvals with expiry timestamps
 * - The database schema is known and the plugin can validate queries against it
 * - Success is indicated by a specific stdout message about governed SQL planning
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("E2E-015 / T3-E2E-015 structured-data runtime enforces approval expiry and governed SQL boundaries", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/structured-data-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout + stderr, /structured-data plans governed SQL/);
});
