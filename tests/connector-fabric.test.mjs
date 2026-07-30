/**
 * Connector fabric validation ensures that data connector access is properly
 * controlled through grants and permissions.
 *
 * This test ensures:
 * - Connector grants define what data sources a user/group can access
 * - Access requests are validated against the configured grants
 * - Unauthorized access attempts are rejected
 * - The grants system supports hierarchical or nested permission models
 * - Connector identity is properly established for audit purposes
 *
 * Assumptions:
 * - The connector-fabric plugin implements a grant-based access control system
 * - The runtime script tests various access scenarios (allowed and denied)
 * - The grants are stored and can be queried by the plugin
 * - Success is indicated by a specific stdout message about connector grants
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

/**
 * Validates that the connector fabric runtime correctly enforces connector grants
 * and access control under the Matbot TypeScript loader.
 *
 * This test ensures:
 * - The connector fabric plugin loads and executes correctly under the Matbot runtime
 * - Connector grants define access permissions for data sources
 * - Access requests are validated against the configured grants
 * - Unauthorized access attempts are rejected
 *
 * Assumptions:
 * - The connector-fabric plugin implements a grant-based access control system
 * - The runtime script tests various access scenarios (allowed and denied)
 * - The plugin correctly enforces access control rules
 * - Success is indicated by the runtime output containing the expected success message
 */
test("connector-fabric runtime flow passes under the Matbot TypeScript loader", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/connector-fabric-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout + stderr, /connector-fabric enforces connector grants/);
});
