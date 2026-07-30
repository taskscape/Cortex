import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

test("WebUI honours MATBOT_WEB_PORT and serves install-scoped branding on that listener", async () => {
  const port = await freeLoopbackPort();
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/webui-port-config-runtime.mjs",
    String(port),
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      MATBOT_WEB_PORT: String(port),
      CORTEX_WEBUI_BRANDING_JSON: JSON.stringify({
        productName: "Port Test Cortex",
        title: "Port Test Console",
        brand: "#123abc",
      }),
    },
  });
  assert.match(stdout + stderr, new RegExp(`frontend plugin served configured port ${port}`));
});
