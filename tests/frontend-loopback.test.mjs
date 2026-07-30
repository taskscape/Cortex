/**
 * T2-E2E-001: WebUI boundary validation ensures that the WebUI binds only to
 * the loopback interface (127.0.0.1) and rejects connections from external hosts.
 *
 * This test ensures:
 * - The WebUI server binds to 127.0.0.1 (loopback) only, not 0.0.0.0
 * - External IP addresses cannot connect to the WebUI
 * - Local connections via 127.0.0.1 are accepted
 * - The security boundary is enforced at the network level
 *
 * Assumptions:
 * - The runtime script creates a test HTTP request to the WebUI from both
 *   loopback and external addresses
 * - The WebUI's network listener is configured with WEB_LISTEN_HOST=127.0.0.1
 * - The server correctly rejects non-loopback connection attempts
 * - Success is indicated by a specific stdout message about loopback binding
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Validates that the WebUI correctly binds only to the loopback interface (127.0.0.1)
 * and rejects connections from external hosts, enforcing the localhost-only security
 * boundary.
 *
 * This test ensures:
 * - The WebUI server binds to 127.0.0.1 (loopback) only, not 0.0.0.0
 * - External IP addresses cannot connect to the WebUI
 * - Local connections via 127.0.0.1 are accepted
 * - The security boundary is enforced at the network level
 *
 * Assumptions:
 * - The runtime script creates a test HTTP request to the WebUI from both
 *   loopback and external addresses
 * - The WebUI's network listener is configured with WEB_LISTEN_HOST=127.0.0.1
 * - The server correctly rejects non-loopback connection attempts
 * - Success is indicated by the runtime output containing the expected success message
 */
test("T2-E2E-001 documented WebUI boundary is loopback-only", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/frontend-loopback-runtime.mjs"
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    windowsHide: true
  });
  assert.match(stdout + stderr, /frontend binds to loopback and rejects non-loopback connections/);
});
