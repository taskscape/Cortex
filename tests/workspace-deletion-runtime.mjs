import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { FileWorkspaceManager } = await import(
  "../local-agent/matbot/apps/cli/src/index.ts"
);

const root = await mkdtemp(path.join(os.tmpdir(), "cortex-workspace-delete-"));
const configPath = path.join(root, "matbot.yaml");
const registryPath = path.join(root, "cortex-workspaces.test.json");
const outside = path.join(root, "..", `${path.basename(root)}-outside`);

try {
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "sentinel.txt"), "must survive", "utf8");
  await writeFile(configPath, "plugins: []\n", "utf8");
  const manager = new FileWorkspaceManager(registryPath, configPath);

  await assert.rejects(() => manager.delete("default"), /active workspace/);
  const disposable = await manager.create("Delete Exactly");
  await assert.rejects(() => manager.delete("default"), /active workspace/);

  const disposableDir = path.join(root, "workspaces", disposable.id);
  await writeFile(path.join(disposableDir, "owned.txt"), "owned", "utf8");
  let junctionCreated = true;
  try {
    await symlink(outside, path.join(disposableDir, "external-link"), "junction");
  } catch {
    junctionCreated = false;
  }

  const deleted = await manager.delete(disposable.id);
  assert.deepEqual(deleted, { id: disposable.id, deleted: true });
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "must survive");
  assert.equal((await manager.list()).workspaces.some(item => item.id === disposable.id), false);

  const recreated = await manager.create("Delete Exactly");
  assert.equal(recreated.id, disposable.id, "a reused id is safe only after the old owned directory is gone");
  assert.equal((await manager.list()).workspaces.filter(item => item.id === recreated.id).length, 1);
  await manager.delete(recreated.id);

  console.log(`workspace deletion is id-bound, rejects the active workspace, and preserves external junction targets${junctionCreated ? "" : " (junction unavailable)"}`);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
