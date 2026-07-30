import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to reserve a test port");
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

/**
 * MBS-1/MBS-8: Memory browser plugin lifecycle with configurable port
 *
 * Validates that the memory browser plugin correctly uses port 19779 by default
 * and can be configured to use a different port, following the Matbot plugin
 * lifecycle (start, stop).
 *
 * This test ensures:
 * - The default port is 19779 (production requirement)
 * - The port can be configured via the MATBOT_MEMORY_BROWSER_PORT environment variable
 * - The plugin correctly starts on the configured port and closes with plugin teardown
 *
 * Assumptions:
 * - The memory browser plugin reads MATBOT_MEMORY_BROWSER_PORT for configuration
 * - The test reserves a port to avoid conflicts
 * - Success is indicated by the plugin starting on the configured port and
 *   the runtime output containing the expected success message
 */
test("MBS-1/MBS-8 open_memory_browser uses port 19779 and follows the Matbot lifecycle", async () => {
  const source = await readFile(path.join(
    process.cwd(),
    "local-agent",
    "matbot",
    "packages",
    "plugins",
    "memory-browser",
    "src",
    "index.ts",
  ), "utf8");
  assert.match(
    source,
    /MATBOT_MEMORY_BROWSER_PORT'\]\s*\?\?\s*19779/,
    "the production default port must remain 19779",
  );

  const port = await reservePort();
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/memory-browser-plugin-lifecycle-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, MATBOT_MEMORY_BROWSER_PORT: String(port) },
  });

  assert.match(stdout + stderr, /memory-browser plugin opens on its configured loopback port and closes with plugin teardown/);
});
