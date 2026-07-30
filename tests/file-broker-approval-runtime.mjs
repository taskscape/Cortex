import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(url, childState) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`file-broker did not become healthy\n${childState.stderr}`);
}

const temp = await mkdtemp(path.join(os.tmpdir(), "cortex-file-broker-approval-"));
const allowed = path.join(temp, "allowed");
const readOnly = path.join(temp, "read-only");
const outside = path.join(temp, "outside");
const backups = path.join(temp, "backups");
const port = await freePort();
let child;
const childState = { stderr: "" };

try {
  await mkdir(allowed, { recursive: true });
  await mkdir(readOnly, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(allowed, "deploy.ps1"), "before\n", "utf8");
  await writeFile(path.join(readOnly, "locked.txt"), "unchanged\n", "utf8");
  await mkdir(path.join(allowed, "blocked"), { recursive: true });
  await writeFile(path.join(allowed, "blocked", "secret.txt"), "do not touch\n", "utf8");
  await writeFile(path.join(outside, "sentinel.ps1"), "outside\n", "utf8");
  const workspacesPath = path.join(temp, "workspaces.json");
  const policyPath = path.join(temp, "policy.json");
  await writeFile(workspacesPath, JSON.stringify({
    roots: [
      { path: allowed, mode: "read-write", type: "test" },
      { path: readOnly, mode: "read-only", type: "test" },
    ]
  }), "utf8");
  await writeFile(policyPath, JSON.stringify({
    deniedPathFragments: ["\\blocked\\"],
    highRiskExtensions: [".ps1"],
    maxReadBytes: 10_000,
    backupRoot: backups
  }), "utf8");

  child = spawn(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "local-agent/file-broker/src/server.ts",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FILE_BROKER_PORT: String(port),
      WORKSPACES_CONFIG: workspacesPath,
      SECURITY_POLICY_CONFIG: policyPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", chunk => { childState.stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, childState);

  const invalidContract = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: path.join(allowed, "not-written.txt"), content: { not: "text" } }),
  });
  assert.equal(invalidContract.status, 400, "write input must remain data, not an executable/object payload");

  const lowRiskTarget = path.join(allowed, "notes", "résumé.md");
  const lowRisk = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: lowRiskTarget, content: "First line\r\nZażółć gęślą jaźń\n" }),
  });
  assert.equal(lowRisk.status, 200);
  const lowRiskResult = await lowRisk.json();
  assert.equal(lowRiskResult.highRisk, false);
  assert.equal(lowRiskResult.backupPath, undefined, "new files have no previous version to back up");
  assert.match(lowRiskResult.diff, /^--- .+\n\+\+\+ .+/);
  assert.match(lowRiskResult.diff, /\+Zażółć gęślą jaźń/);
  assert.equal(await readFile(lowRiskTarget, "utf8"), "First line\r\nZażółć gęślą jaźń\n");
  assert.deepEqual(await readdir(backups).catch(() => []), [], "a low-risk create must not manufacture a backup");

  const target = path.join(allowed, "deploy.ps1");
  const denied = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: target, content: "after\n" }),
  });
  assert.equal(denied.status, 409);
  assert.equal(await readFile(target, "utf8"), "before\n");
  assert.deepEqual(await readdir(backups).catch(() => []), [], "an unapproved write must not create a backup artifact");

  const approved = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: target, content: "after\n", approved: true }),
  });
  assert.equal(approved.status, 200);
  const result = await approved.json();
  assert.equal(result.highRisk, true);
  assert.match(result.diff, /-before/);
  assert.match(result.diff, /\+after/);
  assert.equal(await readFile(result.backupPath, "utf8"), "before\n");

  const approvedAgain = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: target, content: "after twice\n", approved: true }),
  });
  assert.equal(approvedAgain.status, 200);
  const secondResult = await approvedAgain.json();
  assert.notEqual(secondResult.backupPath, result.backupPath, "each approved overwrite needs its own attributable backup");
  assert.equal(await readFile(secondResult.backupPath, "utf8"), "after\n");
  assert.match(secondResult.diff, /-after/);
  assert.match(secondResult.diff, /\+after twice/);

  // Backups must remain distinct even when high-risk requests overlap. Without
  // a collision-resistant name, same-millisecond writes could overwrite one
  // another's recovery point.
  const concurrentWrites = await Promise.all([
    fetch(`${baseUrl}/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target, content: "parallel writer one\n", approved: true }),
    }),
    fetch(`${baseUrl}/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target, content: "parallel writer two\n", approved: true }),
    }),
  ]);
  assert.deepEqual(concurrentWrites.map(response => response.status).sort(), [200, 200]);
  const concurrentResults = await Promise.all(concurrentWrites.map(response => response.json()));
  const concurrentBackupPaths = concurrentResults.map(result => result.backupPath);
  assert.equal(new Set(concurrentBackupPaths).size, 2, "each concurrent approved overwrite retains its own snapshot");
  for (const backupPath of concurrentBackupPaths) {
    assert.ok(backupPath);
    assert.ok((await readFile(backupPath, "utf8")).length > 0);
  }

  const restoreTarget = path.join(allowed, "restore.ps1");
  await writeFile(restoreTarget, "recover this exact version\n", "utf8");
  const overwriteForRestore = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: restoreTarget, content: "changed version\n", approved: true }),
  });
  assert.equal(overwriteForRestore.status, 200);
  const restoreResult = await overwriteForRestore.json();
  assert.equal(await readFile(restoreResult.backupPath, "utf8"), "recover this exact version\n");
  await copyFile(restoreResult.backupPath, restoreTarget);
  assert.equal(await readFile(restoreTarget, "utf8"), "recover this exact version\n", "a backup is a byte-for-byte recovery artifact");

  const envTarget = path.join(allowed, ".env");
  const envUnapproved = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: envTarget, content: "TOKEN=do-not-write-without-approval\n" }),
  });
  assert.equal(envUnapproved.status, 409, ".env writes are high risk even when not listed as an extension");
  await assert.rejects(() => readFile(envTarget, "utf8"), { code: "ENOENT" });
  const envApproved = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: envTarget, content: "TOKEN=approved\n", approved: true }),
  });
  assert.equal(envApproved.status, 200);
  const envResult = await envApproved.json();
  assert.equal(envResult.highRisk, true);
  assert.equal(envResult.backupPath, undefined);
  assert.equal(await readFile(envTarget, "utf8"), "TOKEN=approved\n");

  const readOnlyWrite = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: path.join(readOnly, "locked.txt"), content: "must stay unchanged\n", approved: true }),
  });
  assert.equal(readOnlyWrite.status, 403);
  assert.equal(await readFile(path.join(readOnly, "locked.txt"), "utf8"), "unchanged\n");

  const traversal = await fetch(`${baseUrl}/write`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: path.join(allowed, "..", "outside", "sentinel.ps1"), content: "traversal\n", approved: true }),
  });
  assert.equal(traversal.status, 403);
  assert.equal(await readFile(path.join(outside, "sentinel.ps1"), "utf8"), "outside\n");

  const policyDenied = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: path.join(allowed, "blocked", "secret.txt"), content: "escaped policy\n", approved: true }),
  });
  assert.equal(policyDenied.status, 403);
  assert.equal(await readFile(path.join(allowed, "blocked", "secret.txt"), "utf8"), "do not touch\n");

  let junctionCreated = true;
  const linked = path.join(allowed, "linked");
  try {
    await symlink(outside, linked, "junction");
  } catch {
    junctionCreated = false;
  }
  if (junctionCreated) {
    const escaped = await fetch(`${baseUrl}/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(linked, "sentinel.ps1"), content: "escaped\n", approved: true }),
    });
    assert.equal(escaped.status, 403);
    assert.equal(await readFile(path.join(outside, "sentinel.ps1"), "utf8"), "outside\n");
  }

  /**
   * T3-E2E-047: File broker runtime with high-risk write approval and junction resolution
   *
   * Validates that the file broker correctly rejects unapproved high-risk writes,
   * validates low-risk/read-only policies, preserves restorable backups, and resolves junctions.
   *
   * This test ensures:
   * - High-risk writes (e.g., .ps1 files, existing files) require explicit approval
   * - Low-risk writes (e.g., new files) don't require approval
   * - Backups are created for high-risk writes and can be used for restoration
   * - Concurrent high-risk writes get distinct backup filenames (no collision)
   * - Read-only directories cannot be written to
   * - Path traversal via junctions is blocked
   * - Policy-denied paths (e.g., .blocked/) are rejected
   *
   * Assumptions:
   * - The file broker service correctly implements write approval and security policies
   * - The test creates a temporary environment with various file types and paths
   * - Success is indicated by the runtime output containing the expected success message
   */
  console.log("T3-E2E-047 file-broker rejects unapproved high-risk writes, validates low-risk/read-only policies, preserves restorable backups, and resolves junctions");
} finally {
  if (child && !child.killed) child.kill();
  await rm(temp, { recursive: true, force: true });
}
