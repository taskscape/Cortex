/**
 * Production memory runtime validation ensures that memory capture, recall,
 * dream-time processing, and workspace isolation all work correctly in the
 * production memory system.
 *
 * This test ensures:
 * - Production memory capture works correctly using the real cognition tool
 * - Memory recall works between conversations within a workspace
 * - Memory is isolated across different workspaces (no cross-contamination)
 * - Dream-time processing works (async memory consolidation after the turn)
 * - Memory browser CAS (compare-and-swap) conflict handling works correctly
 * - The test never modifies production workspace memory (verified via SHA-256 checksums)
 *
 * Assumptions:
 * - The runtime script creates temporary test workspaces and manipulates their memory
 * - Production memory is stored in .data/remembered_facts/, .data/dream_runs/, and
 *   .data/store_tools/ directories (one per workspace)
 * - The productionMemorySnapshot() function computes SHA-256 hashes of all memory files
 *   before and after the test to verify no production data was modified
 * - Success is indicated by a specific stdout message about all checks passing
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
    for (const namespace of ["remembered_facts", "dream_runs", "store_tools"]) {
      for (const file of await filesUnder(path.join(dataRoot, namespace))) {
        const content = await readFile(file);
        snapshot[path.relative(matbotRoot, file)] = createHash("sha256").update(content).digest("hex");
      }
    }
  }
  return snapshot;
}

/**
 * Production memory integration test
 *
 * Validates the complete production memory system including:
 * - Memory capture and storage in .data/remembered_facts/
 * - Memory recall and injection into conversations
 * - Dream-time processing (async consolidation in .data/dream_runs/)
 * - Workspace isolation (no cross-contamination between workspaces)
 * - Memory browser CAS (compare-and-swap) conflict handling
 * - Safety: the test never modifies production workspace memory
 *
 * This test uses SHA-256 checksums of all memory files to verify that no
 * production data was modified during the test run.
 *
 * Assumptions:
 * - The production memory system stores data in .data/ directories under each workspace
 * - The runtime script exercises all memory operations without touching production workspaces
 * - Memory files include remembered_facts, dream_runs, and store_tools
 * - Success is indicated by the runtime output containing the expected success message
 * - The productionMemorySnapshot() function correctly computes file checksums
 */
test("production memory runtime is persistent, workspace-isolated, and test-safe", { timeout: 60_000 }, async () => {
  const before = await productionMemorySnapshot();
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/memory-system-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 45_000,
    maxBuffer: 1024 * 1024,
  });
  const after = await productionMemorySnapshot();

  assert.match(stdout + stderr, /production memory capture, restart, dream-time, browser CAS, and workspace isolation passed/);
  assert.deepEqual(after, before, "production workspace memory changed while the isolated integration test ran");
});
