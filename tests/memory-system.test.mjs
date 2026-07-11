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
