/**
 * Workspace switching: the handoff between the outgoing and incoming process. Runs the scenarios in a
 * child process under the Matbot TypeScript loader (they drive the real `.ts` web server) and reports
 * each as a named subtest.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("workspace switch handoff", { timeout: 120_000 }, async t => {
  let stdout = "", stderr = "", spawnError;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, [
      "--import",
      "./local-agent/matbot/apps/cli/register.js",
      "tests/workspace-switch-runtime.mjs",
    ], { cwd: process.cwd(), timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    ({ stdout = "", stderr = "" } = error);
    spawnError = error;
  }

  const results = stdout.split("\n")
    .filter(line => line.startsWith("##RESULT##"))
    .map(line => JSON.parse(line.slice("##RESULT##".length)));

  if (results.length === 0) {
    assert.fail(`the workspace-switch runtime produced no results.\n${stdout}\n${stderr}\n${spawnError?.message ?? ""}`);
  }

  for (const result of results) {
    await t.test(result.name, () => {
      if (!result.ok) assert.fail(result.error);
    });
  }
});
