import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { indexRoot } from "../local-agent/file-index/dist/indexer.js";
import { emptyStore } from "../local-agent/file-index/dist/store.js";
import { searchChunks } from "../local-agent/file-index/dist/search.js";
import { evaluateAccess } from "../local-agent/file-broker/dist/policy.js";
import { writeTextFile } from "../local-agent/file-broker/dist/file-writer.js";
import { createFileBrokerTool, FileBrokerClient } from "../local-agent/matbot/plugins/file-broker/dist/index.js";
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

test("file broker Matbot tool reads host files through the broker service", async () => {
  const requestedPaths = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/read") {
      requestedPaths.push(url.searchParams.get("path"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, content: "broker contents", truncated: false, size: 15 }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const client = new FileBrokerClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const tool = createFileBrokerTool(client);
    const events = [];
    for await (const event of tool.executor.execute({
      action: "read",
      path: "C:\\Projects\\Cortex\\readme.md"
    }, { signal: new AbortController().signal })) {
      events.push(event);
    }

    assert.deepEqual(requestedPaths, ["C:\\Projects\\Cortex\\readme.md"]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "result");
    assert.deepEqual(events[0].value, { ok: true, content: "broker contents", truncated: false, size: 15 });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
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
    knowledgeEntry({ id: "file-index:a", content: "same", sourceType: "file-index", sourceUuid: "a", confidence: 2 }),
    knowledgeEntry({ id: "file-index:a-copy", content: "same", sourceType: "file-index", sourceUuid: "a", confidence: 2 }),
    knowledgeEntry({ id: "mem0:m", content: "memory", sourceType: "mem0", sourceUuid: "m", confidence: 1 })
  ]);

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].content, "same");
});

function knowledgeEntry({ id, content, sourceType, sourceUuid, confidence }) {
  const now = "2026-06-28T00:00:00.000Z";
  const contentHash = `${sourceType}:${sourceUuid}:${content}`;
  return {
    id,
    version: id,
    entities: [],
    tags: [sourceType],
    summary: content,
    content,
    contentHash,
    source: { type: sourceType, uuid: sourceUuid },
    confidence,
    createdAt: now,
    updatedAt: now
  };
}
