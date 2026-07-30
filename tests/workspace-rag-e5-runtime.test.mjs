import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("MISSING-01 runtime sidecar uses E5 prefixes, dimensions, and document/query batches", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import", "./local-agent/matbot/apps/cli/register.js", "tests/workspace-rag-e5-runtime.mjs",
  ], { cwd: process.cwd(), timeout: 60_000, maxBuffer: 1024 * 1024 });
  assert.match(stdout + stderr, /workspace-rag E5 embedding contract passes/);
});
