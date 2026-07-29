import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
const outside = path.join(temp, "outside");
const backups = path.join(temp, "backups");
const port = await freePort();
let child;
const childState = { stderr: "" };

try {
  await mkdir(allowed, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(allowed, "deploy.ps1"), "before\n", "utf8");
  await writeFile(path.join(outside, "sentinel.ps1"), "outside\n", "utf8");
  const workspacesPath = path.join(temp, "workspaces.json");
  const policyPath = path.join(temp, "policy.json");
  await writeFile(workspacesPath, JSON.stringify({
    roots: [{ path: allowed, mode: "read-write", type: "test" }]
  }), "utf8");
  await writeFile(policyPath, JSON.stringify({
    deniedPathFragments: [],
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

  const target = path.join(allowed, "deploy.ps1");
  const denied = await fetch(`${baseUrl}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: target, content: "after\n" }),
  });
  assert.equal(denied.status, 409);
  assert.equal(await readFile(target, "utf8"), "before\n");

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

  console.log("file-broker rejects unapproved high-risk writes, backs up exact overwrites, and resolves junctions");
} finally {
  if (child && !child.killed) child.kill();
  await rm(temp, { recursive: true, force: true });
}
