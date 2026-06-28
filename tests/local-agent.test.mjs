import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { indexRoot } from "../local-agent/file-index/dist/indexer.js";
import { emptyStore } from "../local-agent/file-index/dist/store.js";
import { searchChunks } from "../local-agent/file-index/dist/search.js";
import { evaluateAccess } from "../local-agent/file-broker/dist/policy.js";
import { writeTextFile } from "../local-agent/file-broker/dist/file-writer.js";
import { mergeRankAndDeduplicate } from "../local-agent/matbot/plugins/hybrid-knowledge-index/dist/ranking.js";

test("file index stores searchable text with path metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-agent-index-"));
  await writeFile(path.join(root, "notes.md"), "Matbot should retrieve durable memory from Mem0.", "utf8");

  try {
    const store = await indexRoot({
      root,
      excludedPatterns: [],
      maxFileBytes: 100_000
    }, emptyStore());

    const results = searchChunks(store.chunks, "durable memory", 5);
    assert.equal(results.length, 1);
    assert.match(results[0].snippet, /durable memory/i);
    assert.equal(results[0].relativePath, "notes.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file broker blocks writes outside configured roots and allows project writes", () => {
  const workspaces = {
    roots: [{ path: "C:\\Projects", mode: "read-write", type: "projects" }],
    excludedPatterns: []
  };
  const policy = {
    deniedPathFragments: ["\\.ssh\\"],
    highRiskExtensions: [".env"],
    maxReadBytes: 1000,
    backupRoot: "backups"
  };

  assert.equal(evaluateAccess("C:\\Windows\\system.ini", "write", workspaces, policy).allowed, false);
  assert.equal(evaluateAccess("C:\\Projects\\Bot\\README.md", "write", workspaces, policy).allowed, true);
  assert.equal(evaluateAccess("C:\\Projects\\Bot\\.env", "write", workspaces, policy).highRisk, true);
});

test("file writer creates a backup and a diff for overwrites", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-agent-write-"));
  const target = path.join(root, "sample.txt");
  const backupRoot = path.join(root, "backups");
  await writeFile(target, "before\n", "utf8");

  try {
    const result = await writeTextFile(target, "after\n", backupRoot);
    assert.ok(result.backupPath);
    assert.match(result.diff, /-before/);
    assert.match(result.diff, /\+after/);
    assert.equal(await readFile(target, "utf8"), "after\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hybrid ranking deduplicates entries", () => {
  const ranked = mergeRankAndDeduplicate([
    { content: "same", source: "file-index", metadata: { path: "a", score: 2 } },
    { content: "same", source: "file-index", metadata: { path: "a", score: 2 } },
    { content: "memory", source: "mem0", metadata: { score: 1 } }
  ]);

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].content, "same");
});
