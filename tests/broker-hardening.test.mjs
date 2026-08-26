/**
 * Broker hardening validation for H4 (TOCTOU symlink mitigation), L13
 * (backup retention), and L14 (LCS-based diff).
 *
 * This test ensures:
 * - H4: reads and writes through a symlink/junction whose target leaves the
 *   workspace are rejected by the broker, and `openVerified` refuses a final
 *   path component that is a link even when it resolves *inside* the roots
 *   (the case the policy realpath check alone does not cover)
 * - L13: backup retention keeps at most N most-recent backups per target file,
 *   pruning oldest-first, honouring CORTEX_FILE_BROKER_MAX_BACKUPS
 * - L14: an insertion mid-file produces one small unified hunk instead of a
 *   whole-tail positional +/- replacement
 *
 * Assumptions:
 * - The broker is started as a child process on an ephemeral port with
 *   temporary workspace/security configurations, mirroring services-hardening
 * - Windows directory junctions are creatable without elevation, so link tests
 *   degrade gracefully when junction creation is unavailable
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBackup } from "../local-agent/file-broker/dist/backup.js";
import { createUnifiedDiff } from "../local-agent/file-broker/dist/diff.js";
import { openVerified } from "../local-agent/file-broker/dist/file-writer.js";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function requestJson(port, requestPath, { method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function waitForHealth(port, childState) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await requestJson(port, "/health")).status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`file-broker did not become healthy\n${childState.stderr}`);
}

test("H4: broker rejects read/write through links that escape or are themselves reparse points", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cortex-broker-toctou-"));
  const allowed = path.join(temp, "allowed");
  const outside = path.join(temp, "outside");
  await mkdir(allowed, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "sentinel.txt"), "outside\n", "utf8");
  await writeFile(path.join(allowed, "plain.txt"), "inside\n", "utf8");

  let escaped = false;
  try {
    await symlink(outside, path.join(allowed, "escape"), "junction");
    escaped = true;
  } catch {
    // Junction creation unavailable; fall back to the direct-link unit checks.
  }

  const workspacesPath = path.join(temp, "workspaces.json");
  const policyPath = path.join(temp, "policy.json");
  await writeFile(workspacesPath, JSON.stringify({
    roots: [{ path: allowed, mode: "read-write", type: "test" }],
  }), "utf8");
  await writeFile(policyPath, JSON.stringify({
    deniedPathFragments: [],
    highRiskExtensions: [],
    maxReadBytes: 100_000,
    backupRoot: path.join(temp, "backups"),
  }), "utf8");

  const port = await freePort();
  const childState = { stderr: "" };
  const child = spawn(process.execPath, [
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

  try {
    await waitForHealth(port, childState);

    if (escaped) {
      const linkedSentinel = path.join(allowed, "escape", "sentinel.txt");

      // Policy already resolves links; the verified-handle layer must not
      // regress this rejection.
      const readEscaped = await requestJson(port, `/read?path=${encodeURIComponent(linkedSentinel)}`);
      assert.equal(readEscaped.status, 403);

      const writeEscaped = await requestJson(port, "/write", {
        method: "POST",
        body: { path: linkedSentinel, content: "escaped\n", approved: true },
      });
      assert.equal(writeEscaped.status, 403);
      assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "outside\n",
        "rejected writes must not touch the link target");
    }

    // Sanity: ordinary files still read and write through the verified path.
    const plainRead = await requestJson(port, `/read?path=${encodeURIComponent(path.join(allowed, "plain.txt"))}`);
    assert.equal(plainRead.status, 200);
    assert.equal(plainRead.json.content, "inside\n");
    const plainWrite = await requestJson(port, "/write", {
      method: "POST",
      body: { path: path.join(allowed, "plain.txt"), content: "replaced\n" },
    });
    assert.equal(plainWrite.status, 200);
  } finally {
    if (!child.killed) child.kill();
    await rm(temp, { recursive: true, force: true });
  }
});

test("H4: openVerified rejects a final-component link resolving inside the workspace", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cortex-broker-openverified-"));
  const root = path.join(temp, "root");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "real.txt"), "real\n", "utf8");
  const workspaces = { roots: [{ path: root, mode: "read-write", type: "test" }] };

  try {
    // Ordinary files pass verification.
    const handle = await openVerified(path.join(root, "real.txt"), workspaces);
    await handle.close();

    let linkCreated = false;
    try {
      await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"), "file");
      linkCreated = true;
    } catch {
      try {
        await symlink(root, path.join(root, "link-dir"), "junction");
        linkCreated = true;
      } catch {}
    }

    if (linkCreated) {
      const linkPath = (await readdir(root)).find(name => name !== "real.txt");
      await assert.rejects(
        () => openVerified(path.join(root, linkPath), workspaces),
        error => error.name === "HttpError" && error.status === 403,
        "a final-component reparse point must be refused even inside the roots",
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("L13: backup retention prunes oldest-first beyond CORTEX_FILE_BROKER_MAX_BACKUPS", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cortex-broker-retention-"));
  const previous = process.env.CORTEX_FILE_BROKER_MAX_BACKUPS;
  process.env.CORTEX_FILE_BROKER_MAX_BACKUPS = "2";
  try {
    const target = path.join(temp, "target.txt");
    const backupRoot = path.join(temp, "backups");
    await writeFile(target, "versioned\n", "utf8");

    const created = [];
    for (let round = 0; round < 3; round += 1) {
      created.push(await createBackup(target, backupRoot));
      // Guarantee distinct ISO timestamps so ordering is deterministic.
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const suffix = path.resolve(target).replace(/[:\\\/]/g, "_");
    const remaining = (await readdir(backupRoot)).filter(name => name.endsWith(`_${suffix}`)).sort();
    assert.equal(remaining.length, 2, "only the N most recent backups are retained");
    assert.ok(!remaining.includes(path.basename(created[0])), "the oldest backup is pruned first");
    for (const name of remaining) {
      assert.match(name, new RegExp(`^\\d{4}-`), "retained entries are still timestamped snapshots");
    }

    // Retention is per target file: another file's backups are untouched.
    const otherTarget = path.join(temp, "other.txt");
    await writeFile(otherTarget, "other\n", "utf8");
    const otherBackup = await createBackup(otherTarget, backupRoot);
    assert.ok(otherBackup);
    assert.equal((await readdir(backupRoot)).filter(name => name.endsWith(suffix)).length, 2,
      "pruning never touches other files' backups");
  } finally {
    if (previous === undefined) delete process.env.CORTEX_FILE_BROKER_MAX_BACKUPS;
    else process.env.CORTEX_FILE_BROKER_MAX_BACKUPS = previous;
    await rm(temp, { recursive: true, force: true });
  }
});

test("L14: a mid-file insertion renders as one small hunk, not whole-tail replacement", () => {
  const beforeLines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
  const afterLines = [...beforeLines.slice(0, 10), "inserted-line", ...beforeLines.slice(10)];
  const diff = createUnifiedDiff("sample.txt", beforeLines.join("\n") + "\n", afterLines.join("\n") + "\n");

  assert.match(diff, /^--- sample\.txt\n\+\+\+ sample\.txt\n/);
  const hunks = diff.split("\n").filter(line => line.startsWith("@@"));
  assert.equal(hunks.length, 1, "one change yields exactly one hunk");
  assert.equal(hunks[0], "@@ -8,6 +8,7 @@", "hunk covers three context lines around the insertion");

  assert.ok(diff.includes("+inserted-line"));
  assert.equal(diff.split("\n").filter(line => line.startsWith("-") && !line.startsWith("---")).length, 0,
    "a pure insertion deletes nothing");
  assert.ok(diff.split("\n").length <= 20, "output stays minimal instead of echoing the whole tail");
});

test("L14: edits and deletions produce correctly counted unified hunks", () => {
  const before = ["a", "b", "c", "d"].join("\n");
  const after = ["a", "B", "c", "d"].join("\n");
  const changed = createUnifiedDiff("edit.txt", before, after);
  assert.deepEqual(changed.split("\n").slice(2), ["@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", " d"]);

  const truncated = createUnifiedDiff("del.txt", before, "a");
  assert.match(truncated, /^--- del\.txt/m);
  const deleted = truncated.split("\n").filter(line => line.startsWith("-") && !line.startsWith("---"));
  assert.deepEqual(deleted, ["-b", "-c", "-d"], "trailing deletion lists only removed lines");
});
