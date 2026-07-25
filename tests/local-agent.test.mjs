import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { indexRoot } from "../local-agent/file-index/dist/indexer.js";
import { resolveIndexRoot } from "../local-agent/file-index/dist/index-root.js";
import { emptyStore, loadStore, saveStore } from "../local-agent/file-index/dist/store.js";
import { searchChunks } from "../local-agent/file-index/dist/search.js";
import { evaluateAccess } from "../local-agent/paths/dist/index.js";
import { ReloadingConfig } from "../local-agent/file-broker/dist/config-cache.js";
import { writeTextFile } from "../local-agent/file-broker/dist/file-writer.js";
import { createFileBrokerTool, FileBrokerClient } from "../local-agent/matbot/plugins/file-broker/dist/index.js";
import { mergeRankAndDeduplicate } from "../local-agent/matbot/plugins/hybrid-knowledge-index/dist/ranking.js";
import { Mem0Client } from "../local-agent/matbot/plugins/hybrid-knowledge-index/dist/mem0-client.js";
import {
  workspaceIdFromConfigPath,
  workspaceScopedMem0UserId
} from "../local-agent/matbot/plugins/hybrid-knowledge-index/dist/index.js";

test("file index stores searchable text with path metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-agent-index-"));
  await writeFile(path.join(root, "notes.md"), "Matbot should retrieve durable memory from Mem0.", "utf8");

  try {
    const options = {
      root,
      excludedPatterns: [],
      maxFileBytes: 100_000,
      workspaces: { roots: [{ path: root, mode: "read-write", type: "test" }], excludedPatterns: [] },
      policy: { deniedPathFragments: [], highRiskExtensions: [], maxReadBytes: 100_000, backupRoot: "backups" }
    };
    const store = await indexRoot(options, emptyStore());

    const results = searchChunks(store.chunks, "durable memory", 5);
    assert.equal(results.length, 1);
    assert.match(results[0].snippet, /durable memory/i);
    assert.equal(results[0].relativePath, "notes.md");

    const unchanged = await indexRoot(options, store);
    assert.strictEqual(unchanged.chunks[0], store.chunks[0], "unchanged files reuse their indexed chunks");

    await writeFile(path.join(root, "notes.md"), "Matbot should retrieve current project context from the resident index.", "utf8");
    const changed = await indexRoot(options, unchanged);
    assert.equal(searchChunks(changed.chunks, "project context", 1).length, 1);
    assert.equal(searchChunks(changed.chunks, "durable memory", 1).length, 0);

    const storePath = path.join(root, "index.json");
    await saveStore(storePath, changed);
    await saveStore(storePath, changed);
    assert.equal((await loadStore(storePath)).chunks.length, changed.chunks.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file index rejects index roots outside the configured workspace roots", async () => {
  const configured = await mkdtemp(path.join(os.tmpdir(), "local-agent-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "local-agent-outside-"));
  const nested = path.join(configured, "project");
  await mkdir(nested, { recursive: true });
  const config = { roots: [{ path: configured, mode: "read-write", type: "test" }], excludedPatterns: [] };

  try {
    assert.equal(await resolveIndexRoot(undefined, config), path.resolve(configured));
    assert.equal(await resolveIndexRoot(nested, config), path.resolve(nested), "a subtree of a configured root is allowed");

    await assert.rejects(() => resolveIndexRoot(outside, config), /outside the configured workspace roots/);
    await assert.rejects(() => resolveIndexRoot(path.join(configured, "..", path.basename(outside)), config),
      /outside the configured workspace roots/, "traversal out of a configured root is rejected");
    await assert.rejects(() => resolveIndexRoot(configured, { roots: [], excludedPatterns: [] }),
      /outside the configured workspace roots/, "no configured roots means nothing is indexable");

    // A junction planted inside a configured root must not redirect the walk out of it. Junctions need
    // no elevation on Windows; where the platform or filesystem refuses, the assertion is skipped
    // rather than failing the suite for an unrelated reason.
    const junction = path.join(configured, "escape");
    let junctionCreated = true;
    try { await symlink(outside, junction, "junction"); } catch { junctionCreated = false; }
    if (junctionCreated) {
      await assert.rejects(() => resolveIndexRoot(junction, config),
        /outside the configured workspace roots/, "a junction escaping the root is resolved, not trusted lexically");
    }
  } finally {
    await rm(configured, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("file index applies the broker security policy to every indexed file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-agent-policy-"));
  await mkdir(path.join(root, ".ssh"), { recursive: true });
  await writeFile(path.join(root, "notes.md"), "Ordinary project notes about retrieval.", "utf8");
  // Matches none of the looksLikeSecret patterns, so only the high-risk extension rule keeps it out.
  await writeFile(path.join(root, ".env"), "GITHUB_TOKEN=ghp_notarealtokenvalue\n", "utf8");
  await writeFile(path.join(root, ".ssh", "hosts.md"), "Private host inventory for retrieval.", "utf8");

  try {
    const store = await indexRoot({
      root,
      excludedPatterns: [],
      maxFileBytes: 100_000,
      workspaces: { roots: [{ path: root, mode: "read-write", type: "test" }], excludedPatterns: [] },
      policy: {
        deniedPathFragments: ["\\.ssh\\"],
        highRiskExtensions: [".env", ".pem", ".key"],
        maxReadBytes: 100_000,
        backupRoot: "backups"
      }
    }, emptyStore());

    assert.deepEqual(store.chunks.map(chunk => chunk.relativePath), ["notes.md"]);
    assert.equal(searchChunks(store.chunks, "ghp_notarealtokenvalue", 5).length, 0, "high-risk files never reach /search");
    assert.equal(searchChunks(store.chunks, "host inventory", 5).length, 0, "denied path fragments never reach /search");

    const reasons = new Map(store.skipped.map(entry => [path.basename(entry.path), entry.reason]));
    assert.equal(reasons.get(".env"), "high-risk-file");
    assert.match(reasons.get("hosts.md"), /Denied path fragment matched/);
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

test("file broker config cache reuses unchanged values and reloads changed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "file-broker-config-"));
  const configPath = path.join(root, "config.json");
  let loads = 0;
  await writeFile(configPath, JSON.stringify({ version: 1 }), "utf8");
  const cache = new ReloadingConfig(configPath, async file => {
    loads++;
    return JSON.parse(await readFile(file, "utf8"));
  });
  try {
    const first = await cache.get();
    assert.strictEqual(await cache.get(), first);
    assert.equal(loads, 1);
    await writeFile(configPath, JSON.stringify({ version: 200 }), "utf8");
    assert.equal((await cache.get()).version, 200);
    assert.equal(loads, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("Mem0 identities are isolated for every Cortex workspace", () => {
  const root = path.join(os.tmpdir(), "cortex", "local-agent", "matbot");
  const rootConfig = path.join(root, "matbot.yaml");
  const alphaConfig = path.join(root, "workspaces", "alpha", "matbot.yaml");
  const betaConfig = path.join(root, "workspaces", "beta", "matbot.yaml");

  assert.equal(workspaceIdFromConfigPath(rootConfig), "default");
  assert.equal(workspaceIdFromConfigPath(alphaConfig), "alpha");
  assert.equal(workspaceScopedMem0UserId("local-agent", "default"), "local-agent:workspace:default");
  assert.equal(workspaceScopedMem0UserId("local-agent", "alpha"), "local-agent:workspace:alpha");
  assert.notEqual(
    workspaceScopedMem0UserId("local-agent", workspaceIdFromConfigPath(alphaConfig)),
    workspaceScopedMem0UserId("local-agent", workspaceIdFromConfigPath(betaConfig))
  );
});

test("Mem0 add and search requests carry the workspace-scoped identity", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url?.includes("search") ? JSON.stringify({ results: [] }) : JSON.stringify({}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const client = new Mem0Client({
      baseUrl: `http://127.0.0.1:${address.port}`,
      userId: "local-agent:workspace:alpha",
      workspaceId: "alpha"
    });
    await client.add(knowledgeEntry({ id: "memory-alpha", content: "alpha only", sourceType: "test", sourceUuid: "alpha", confidence: 1 }));
    await client.search("alpha");
    assert.equal(requests[0].user_id, "local-agent:workspace:alpha");
    assert.equal(requests[0].metadata.workspaceId, "alpha");
    assert.equal(requests[1].user_id, "local-agent:workspace:alpha");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
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
