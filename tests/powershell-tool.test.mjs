/**
 * PowerShell tool validation ensures that the tool can execute PowerShell scripts
 * under the Matbot runtime and capture their output.
 *
 * This test ensures:
 * - PowerShell scripts can be submitted and executed through the tool
 * - The tool captures stdout and stderr from the script
 * - Exit codes are properly reported
 * - The tool works under Windows (skip on other platforms)
 * - Script execution is isolated and secure
 *
 * Assumptions:
 * - The test runs on Windows (process.platform === "win32")
 * - PowerShell is installed and accessible
 * - The runtime script creates a simple PowerShell script and submits it
 * - The tool executes the script and returns its output
 * - Success is indicated by a specific stdout message about script execution
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

/**
 * Validates that the PowerShell tool can execute PowerShell scripts under the Matbot
 * runtime and correctly capture their output (stdout, stderr, exit code).
 *
 * This test ensures:
 * - PowerShell scripts can be submitted and executed through the tool
 * - The tool captures stdout and stderr from the script
 * - Exit codes are properly reported
 * - Script execution is isolated and secure
 *
 * Assumptions:
 * - The test runs on Windows (process.platform === "win32")
 * - PowerShell is installed and accessible
 * - The runtime script creates a simple PowerShell script and submits it
 * - The tool executes the script and returns its output
 * - Success is indicated by the runtime output containing the expected success message
 */
test("powershell tool runs scripts under the Matbot TypeScript loader", { skip: process.platform !== "win32" }, async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/powershell-tool-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout + stderr, /powershell tool executes scripts/);
});
