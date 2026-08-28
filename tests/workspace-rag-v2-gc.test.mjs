import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");

const { WorkspaceRagV2Manager } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts"
);
const { MemoryRagV2Repository } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/memory-repository.ts"
);
const { ragV2GcSettingsFromEnv } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/config.ts"
);
const { RagV2ObjectStore } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/object-store.ts"
);

function embedding(text, dimensions = 32) {
  const vector = new Array(dimensions).fill(0);
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const digest = createHash("sha256").update(token).digest();
    vector[digest.readUInt16BE(0) % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

const embedder = {
  info: {
    backend: "test",
    model: "test-gc",
    dimensions: 32,
    signature: "test-gc-v1",
    maxTokens: 512,
  },
  async embed(texts) {
    return texts.map(text => embedding(text));
  },
};

function terminalJob(previous, overrides = {}) {
  const timestamp = new Date().toISOString();
  return {
    ...previous,
    id: randomUUID(),
    generationId: randomUUID(),
    state: "active_hybrid_complete",
    createdAt: timestamp,
    updatedAt: timestamp,
    discoveryComplete: true,
    cancelRequested: false,
    pauseRequested: false,
    ...overrides,
  };
}

function preserveEnv(t, names) {
  const previous = new Map(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("orphan GC environment settings reject invalid values with documented defaults", t => {
  const names = [
    "CORTEX_RAG_V2_GC_ENABLED",
    "CORTEX_RAG_V2_GC_INTERVAL_MS",
    "CORTEX_RAG_V2_GC_GRACE_MS",
    "CORTEX_RAG_V2_GC_BATCH_SIZE",
    "CORTEX_RAG_V2_RETIRED_GENERATION_TTL_MS",
    "CORTEX_RAG_V2_BLOB_GC_ENABLED",
  ];
  preserveEnv(t, names);
  for (const name of names) process.env[name] = "invalid";
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  t.after(() => { console.warn = originalWarn; });

  assert.deepEqual(ragV2GcSettingsFromEnv(), {
    enabled: true,
    intervalMs: 21_600_000,
    graceMs: 3_600_000,
    batchSize: 2_000,
    retiredGenerationTtlMs: 604_800_000,
    blobGcEnabled: false,
  });
  assert.equal(warnings.length, names.length);
  assert.ok(warnings.every(message => message.startsWith("[workspace-rag-v2] invalid CORTEX_RAG_V2_")));
});

test("orphan GC reclaims removed-folder documents and records cleanup status", async t => {
  preserveEnv(t, [
    "CORTEX_RAG_V2_GC_ENABLED",
    "CORTEX_RAG_V2_GC_GRACE_MS",
    "CORTEX_RAG_V2_RETIRED_GENERATION_TTL_MS",
    "CORTEX_RAG_V2_BLOB_GC_ENABLED",
  ]);
  process.env.CORTEX_RAG_V2_GC_ENABLED = "false";
  process.env.CORTEX_RAG_V2_GC_GRACE_MS = "1";
  process.env.CORTEX_RAG_V2_RETIRED_GENERATION_TTL_MS = "1";
  process.env.CORTEX_RAG_V2_BLOB_GC_ENABLED = "true";

  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-gc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const retainedRoot = path.join(root, "retained");
  const removedRoot = path.join(root, "removed");
  await mkdir(retainedRoot, { recursive: true });
  await mkdir(removedRoot, { recursive: true });
  const retainedPath = path.join(retainedRoot, "keep.md");
  const removedPath = path.join(removedRoot, "drop.md");
  await writeFile(retainedPath, "# Keep\n\nKEEP-GC-EVIDENCE remains searchable.");
  await writeFile(removedPath, "# Drop\n\nDROP-GC-EVIDENCE must be reclaimed.");
  const old = new Date(Date.now() - 60_000);
  await utimes(retainedPath, old, old);
  await utimes(removedPath, old, old);

  const repository = new MemoryRagV2Repository();
  const events = [];
  const manager = new WorkspaceRagV2Manager(
    repository,
    embedder,
    undefined,
    undefined,
    event => events.push(event),
  );
  t.after(() => manager.close());
  const workspace = { id: "gc-workspace", name: "GC", configDir: root };
  const context = { id: "gc-context", name: "GC Context", paths: [retainedRoot, removedRoot] };

  manager.startIngestion(workspace, context, "startup");
  await manager.waitForIngestion(workspace.id, context.id);
  const initial = await repository.listFingerprints(workspace.id, context.id);
  const removedVersion = initial.find(item => item.path.endsWith("/drop.md"))?.documentVersionId;
  const retainedVersion = initial.find(item => item.path.endsWith("/keep.md"))?.documentVersionId;
  assert.ok(removedVersion);
  assert.ok(retainedVersion);
  const removedDocument = await repository.documentVersion(
    workspace.id,
    context.id,
    removedVersion,
    [`workspace:${workspace.id}`],
  );
  await utimes(removedDocument.objectPath, old, old);

  const reduced = { ...context, paths: [retainedRoot] };
  manager.startIngestion(workspace, reduced, "configuration");
  await manager.waitForIngestion(workspace.id, context.id);
  await new Promise(resolve => setTimeout(resolve, 5));

  const result = await manager.garbageCollect(workspace, reduced);
  assert.equal(result.deletionsSkipped, false);
  assert.equal(result.documentsDeleted, 1);
  assert.ok(result.sectionsDeleted >= 1);
  assert.ok(result.passagesDeleted >= 1);
  assert.ok(result.embeddingsDeleted >= 1);
  assert.equal(result.blobsDeleted, 1);
  assert.equal(
    await repository.documentVersion(workspace.id, context.id, removedVersion, [`workspace:${workspace.id}`]),
    undefined,
  );
  assert.ok(await repository.documentVersion(
    workspace.id,
    context.id,
    retainedVersion,
    [`workspace:${workspace.id}`],
  ));
  assert.deepEqual((await repository.listFingerprints(workspace.id, context.id)).map(item => item.documentVersionId), [retainedVersion]);

  const status = await manager.status("primary", workspace, reduced);
  assert.equal(status.lastGc.documentsDeleted, 1);
  assert.ok(status.lastGc.retiredGenerationsDeleted >= 1);
  assert.equal(events.at(-1).result.documentsDeleted, 1);
});

test("managed blob GC retains referenced and fresh objects while deleting capped stale orphans", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-blob-gc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = path.join(root, "sources");
  await mkdir(sources, { recursive: true });
  const store = new RagV2ObjectStore(path.join(root, "store"));
  const records = [];
  for (const [name, content] of [["referenced", "REF-BLOB"], ["stale", "STALE-BLOB"], ["fresh", "FRESH-BLOB"]]) {
    const source = path.join(sources, `${name}.md`);
    await writeFile(source, content);
    records.push(await store.putFile(source));
  }
  const [referenced, stale, fresh] = records;
  const old = new Date(Date.now() - 60_000);
  await utimes(referenced.objectPath, old, old);
  await utimes(stale.objectPath, old, old);

  const deleted = await store.pruneUnreferenced(
    new Set([referenced.contentSha256]),
    new Date(Date.now() - 1_000).toISOString(),
    1,
  );
  assert.equal(deleted, 1);
  assert.ok((await stat(referenced.objectPath)).isFile());
  await assert.rejects(stat(stale.objectPath), /ENOENT/);
  assert.ok((await stat(fresh.objectPath)).isFile());
});

test("orphan GC honors busy, staging-publication, and grace-period safety gates", async t => {
  preserveEnv(t, ["CORTEX_RAG_V2_GC_ENABLED"]);
  process.env.CORTEX_RAG_V2_GC_ENABLED = "false";
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-gc-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  const sourcePath = path.join(docs, "safety.md");
  await writeFile(sourcePath, "# Safety\n\nSTAGING-GC-EVIDENCE must survive.");

  const repository = new MemoryRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, embedder);
  t.after(() => manager.close());
  const workspace = { id: "gc-safety-workspace", name: "Safety", configDir: root };
  const context = { id: "gc-safety-context", name: "Safety", paths: [docs] };
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const fingerprint = (await repository.listFingerprints(workspace.id, context.id))[0];
  const previous = await repository.currentJob(workspace.id, context.id);

  await repository.beginGeneration(workspace.id, context.id, "protected-staging");
  await repository.beginGeneration(workspace.id, context.id, "empty-successor");
  const emptyJob = terminalJob(previous, { id: "empty-job", generationId: "empty-successor" });
  await repository.createJob(emptyJob);
  await repository.reconcileGeneration(emptyJob.id, workspace.id, context.id, "empty-successor");
  await repository.publishGeneration(
    workspace.id,
    context.id,
    "empty-successor",
    "active_hybrid_complete",
  );

  const stagingProtected = await repository.pruneOrphans(
    workspace.id,
    context.id,
    new Date(Date.now() + 60_000).toISOString(),
  );
  assert.equal(stagingProtected.documentsDeleted, 0);
  assert.ok(await repository.documentVersion(
    workspace.id,
    context.id,
    fingerprint.documentVersionId,
    [`workspace:${workspace.id}`],
  ));

  await repository.pruneStagingGenerations(workspace.id, context.id, "empty-successor");
  const busy = terminalJob(emptyJob, { state: "hashing", discoveryComplete: false });
  await repository.createJob(busy);
  const skipped = await repository.pruneOrphans(
    workspace.id,
    context.id,
    new Date(Date.now() + 60_000).toISOString(),
  );
  assert.equal(skipped.deletionsSkipped, true);
  assert.equal(skipped.documentsDeleted, 0);

  await repository.updateJob({ ...busy, state: "active_hybrid_complete", discoveryComplete: true });
  const graceProtected = await repository.pruneOrphans(
    workspace.id,
    context.id,
    new Date(Date.now() - 60_000).toISOString(),
  );
  assert.equal(graceProtected.documentsDeleted, 0);
  const collected = await repository.pruneOrphans(
    workspace.id,
    context.id,
    new Date(Date.now() + 60_000).toISOString(),
  );
  assert.equal(collected.documentsDeleted, 1);
});

test("context purge is idempotent and retains retrieval audit evidence", async t => {
  preserveEnv(t, ["CORTEX_RAG_V2_GC_ENABLED"]);
  process.env.CORTEX_RAG_V2_GC_ENABLED = "false";
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-purge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "purge.md"), "# Purge\n\nPURGE-AUDIT-EVIDENCE is indexed.");

  const repository = new MemoryRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, embedder);
  t.after(() => manager.close());
  const workspace = { id: "purge-workspace", name: "Purge", configDir: root };
  const context = { id: "purge-context", name: "Purge", paths: [docs] };
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const fingerprint = (await repository.listFingerprints(workspace.id, context.id))[0];
  const search = await manager.search(workspace, context, "PURGE-AUDIT-EVIDENCE", { limit: 2 });
  assert.ok(search.evidence.length > 0);
  const storedHitCount = repository.storedHits.length;

  await manager.purgeContext(workspace, context);
  await manager.purgeContext(workspace, context);
  assert.equal(await repository.activePublication(workspace.id, context.id), undefined);
  assert.deepEqual(await repository.listFingerprints(workspace.id, context.id), []);
  assert.equal(
    await repository.documentVersion(
      workspace.id,
      context.id,
      fingerprint.documentVersionId,
      [`workspace:${workspace.id}`],
    ),
    undefined,
  );
  assert.equal(repository.storedHits.length, storedHitCount, "retrieval audit rows are deliberately retained");
});
