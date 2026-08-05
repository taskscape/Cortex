import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  assert.equal(deleted.id, disposable.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.cleanupPending, undefined);
  assert.ok(deleted.cleanupLog.some(entry => /staged path=/.test(entry)));
  assert.ok(deleted.cleanupLog.some(entry => /registry commit complete/.test(entry)));
  assert.ok(deleted.cleanupLog.some(entry => /purged path=/.test(entry)));
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "must survive");
  assert.equal((await manager.list()).workspaces.some(item => item.id === disposable.id), false);

  const recreated = await manager.create("Delete Exactly");
  assert.equal(recreated.id, disposable.id, "a reused id is safe only after the old owned directory is gone");
  assert.equal((await manager.list()).workspaces.filter(item => item.id === recreated.id).length, 1);
  await manager.delete(recreated.id);

  const rollbackWorkspace = await manager.create("Rollback Probe");
  const rollbackDir = path.join(root, "workspaces", rollbackWorkspace.id);
  await writeFile(path.join(rollbackDir, "rollback.txt"), "must survive rollback", "utf8");
  const rollbackLogs = [];
  const rollbackManager = new FileWorkspaceManager(registryPath, configPath, {
    deletionLogger(message) { rollbackLogs.push(message); },
    deletionHooks: {
      beforeRegistryCommit() { throw new Error("injected registry commit failure"); }
    }
  });
  await assert.rejects(() => rollbackManager.delete(rollbackWorkspace.id), /injected registry commit failure/);
  await access(path.join(rollbackDir, "rollback.txt"));
  assert.equal((await manager.list()).workspaces.some(item => item.id === rollbackWorkspace.id), true);
  assert.ok(rollbackLogs.some(entry => /rolled back path=/.test(entry)));
  assert.ok(rollbackLogs.some(entry => /aborted before commit/.test(entry)));
  await manager.delete(rollbackWorkspace.id);

  const pendingWorkspace = await manager.create("Pending Cleanup Probe");
  const pendingDir = path.join(root, "workspaces", pendingWorkspace.id);
  await writeFile(path.join(pendingDir, "pending.txt"), "pending cleanup", "utf8");
  const pendingLogs = [];
  const pendingManager = new FileWorkspaceManager(registryPath, configPath, {
    deletionLogger(message) { pendingLogs.push(message); },
    deletionHooks: {
      beforePurge() { throw new Error("injected purge failure"); }
    }
  });
  const pending = await pendingManager.delete(pendingWorkspace.id);
  assert.equal(pending.deleted, true);
  assert.equal(pending.cleanupPending, true);
  assert.ok(pending.pendingCleanupPath);
  await assert.rejects(() => access(pendingDir));
  await access(path.join(pending.pendingCleanupPath, "pending.txt"));
  assert.equal((await manager.list()).workspaces.some(item => item.id === pendingWorkspace.id), false);
  assert.ok(pendingLogs.some(entry => /cleanup pending/.test(entry)));
  await rm(pending.pendingCleanupPath, { recursive: true, force: true });

  console.log(`workspace deletion is id-bound, atomic before commit, auditable, cleanup-resilient, and preserves external junction targets${junctionCreated ? "" : " (junction unavailable)"}`);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
