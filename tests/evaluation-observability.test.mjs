import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("evaluation-observability runtime flow passes under the Matbot TypeScript loader", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/evaluation-observability-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CORTEX_MODEL_PRICING_JSON: JSON.stringify({ "test-model": { inputPerMillionUsd: 1, outputPerMillionUsd: 2 } }) },
  });

  assert.match(stdout + stderr, /evaluation-observability records governed evidence/);
});
