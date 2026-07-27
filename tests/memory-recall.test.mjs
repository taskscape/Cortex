/**
 * Memory recall: does a fact stated in one conversation reach the next one, and does it stay inside
 * its own workspace. The scenarios run in a child process under the Matbot TypeScript loader (they
 * drive real `.ts` plugin code), and each reports a `##RESULT##` line that becomes a subtest here, so
 * a regression names the behaviour that broke.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function filesUnder(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(entry => {
      const target = path.join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(target) : [target];
    }));
    return nested.flat();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

// The scenarios must never see, let alone write, a real workspace's memory.
async function productionMemorySnapshot() {
  const matbotRoot = path.join(process.cwd(), "local-agent", "matbot");
  const registry = JSON.parse(await readFile(path.join(matbotRoot, "cortex-workspaces.json"), "utf8"));
  const dataRoots = [path.join(matbotRoot, ".data")];
  for (const workspace of registry.workspaces ?? []) {
    const configPath = path.resolve(matbotRoot, workspace.configPath);
    dataRoots.push(path.join(path.dirname(configPath), ".data"));
  }

  const snapshot = {};
  for (const dataRoot of new Set(dataRoots)) {
    for (const file of await filesUnder(path.join(dataRoot, "remembered_facts"))) {
      snapshot[path.relative(matbotRoot, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
    }
  }
  return snapshot;
}

test("memory recall", { timeout: 120_000 }, async t => {
  const before = await productionMemorySnapshot();

  let stdout = "", stderr = "", spawnError;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, [
      "--import",
      "./local-agent/matbot/apps/cli/register.js",
      "tests/memory-recall-runtime.mjs",
    ], { cwd: process.cwd(), timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    // A failing scenario exits non-zero by design; its ##RESULT## lines are still on stdout and are
    // reported as subtests below. Anything else (a crash before the loop) is surfaced as-is.
    ({ stdout = "", stderr = "" } = error);
    spawnError = error;
  }

  const results = stdout.split("\n")
    .filter(line => line.startsWith("##RESULT##"))
    .map(line => JSON.parse(line.slice("##RESULT##".length)));

  if (results.length === 0) {
    assert.fail(`the recall runtime produced no results.\n${stdout}\n${stderr}\n${spawnError?.message ?? ""}`);
  }

  for (const result of results) {
    await t.test(result.name, () => {
      if (!result.ok) assert.fail(result.error);
    });
  }

  const after = await productionMemorySnapshot();
  assert.deepEqual(after, before, "a real workspace's remembered facts changed while the tests ran");
});
