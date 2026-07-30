/**
 * Memory recall: validates that facts captured in one conversation are successfully
 * recalled in subsequent conversations within the same workspace, and that facts
 * do not leak across different workspaces (workspace isolation).
 *
 * This test ensures:
 * - A fact mentioned in conversation A is available in conversation B (recall)
 * - Facts stored in workspace 1 do not appear in workspace 2 (isolation)
 * - Memory persists across runtime restarts
 * - The real production memory system (cognition tool, recall hook) works correctly
 * - Test runs never modify production workspace memory (detected via checksums)
 *
 * Assumptions:
 * - The production memory system stores facts in .data/remembered_facts/ as JSON files
 * - The runtime script creates temporary test workspaces and manipulates their memory
 * - The runtime reports each scenario result via ##RESULT## lines to stdout
 * - The productionMemorySnapshot() function computes SHA-256 hashes of all remembered_facts
 *   files before and after the test to verify no production data was modified
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
  let registry = { workspaces: [] };
  try {
    registry = JSON.parse(await readFile(path.join(matbotRoot, "cortex-workspaces.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
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
