import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("runtime reliability boundaries reject, recover, and shut down without crashing or hanging", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/runtime-reliability-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  assert.match(
    stdout + stderr,
    /runtime reliability boundaries reject, recover, and shut down without crashing or hanging/,
  );
});
