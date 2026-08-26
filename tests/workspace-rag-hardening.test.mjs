import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
const { RagV2ObjectStore, RagV2LineIndexWriter } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/object-store.ts"
);
const { RagV2RateLimiter } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/rate-limiter.ts"
);
const { assertSafeRegex } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/regex-evaluator.ts"
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

function testEmbedder() {
  return {
    info: {
      backend: "test",
      model: "test-multilingual",
      dimensions: 32,
      signature: "test-v1",
      maxTokens: 512,
    },
    async embed(texts, _purpose, signal) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      return texts.map(text => embedding(text));
    },
  };
}

test("regex validator rejects nested quantifier groups while keeping safe patterns", () => {
  for (const hostile of ["((a+)b)+c", "(?:x+)*y", "(a|b+)+z", "((a+)++)"]) {
    assert.throws(() => assertSafeRegex(hostile), /prohibited nested quantifier/, hostile);
  }
  for (const safe of [
    "terminate.{0,80}convenience",
    "^\\d{4}-\\d{2}-\\d{2}$",
    "[a-f0-9]+x*",
    "(contract|agreement)",
  ]) {
    assert.doesNotThrow(() => assertSafeRegex(safe), safe);
  }
});

test("memory repository regex evaluation terminates a catastrophic pattern within its time budget", async () => {
  const repository = new MemoryRagV2Repository();
  await repository.initialize({
    backend: "test", model: "test-multilingual", dimensions: 32, signature: "test-v1", maxTokens: 512,
  });
  const documentId = "doc-1";
  const documentVersionId = "doc-version-1";
  const contentSha256 = createHash("sha256").update("payload").digest("hex");
  const document = {
    documentId,
    documentVersionId,
    workspaceId: "w",
    contextId: "c",
    aclTokens: ["workspace:w"],
    path: "catastrophic.md",
    title: "Catastrophic",
    documentType: "markdown",
    parties: [],
    languageDistribution: {},
    byteLength: 40,
    lineCount: 1,
    contentSha256,
    tableOfContents: [],
    routingSummary: "",
    publicationState: "staging",
    objectPath: "/tmp/objects/source.md",
    lineIndexPath: "/tmp/objects/lines.tsv",
    modifiedAt: new Date().toISOString(),
    embeddingState: "queued",
  };
  await repository.beginGeneration("w", "c", "g1");
  await repository.appendPassages([{
    passageId: "passage-1",
    documentId,
    documentVersionId,
    sectionId: "section-1",
    workspaceId: "w",
    contextId: "c",
    ordinal: 1,
    headingPath: [],
    structuralType: "paragraph",
    startByte: 0,
    endByte: 40,
    startLine: 1,
    endLine: 1,
    language: "en",
    languageConfidence: 1,
    languageDistribution: {},
    script: "latn",
    contentSha256,
    tokenCount: 10,
    text: `${"a".repeat(34)}b`,
    lexicalState: "ready",
    embeddingState: "queued",
  }]);
  await repository.finishDocument("g1", document);

  // ^(a|aa)+$ passes the nested-quantifier scan but backtracks exponentially;
  // only the bounded worker executor keeps this from hanging the process.
  const started = Date.now();
  await assert.rejects(
    () => repository.grepDocuments("w", "c", "g1", [documentVersionId], "^(a|aa)+$", ["workspace:w"], 10),
    /time budget/,
  );
  assert.ok(Date.now() - started < 5_000, "evaluation must terminate quickly, not hang");

  const matches = await repository.grepDocuments(
    "w", "c", "g1", [documentVersionId], "a{3}b", ["workspace:w"], 10,
  );
  assert.equal(matches.length, 1);
});

test("rate limiter releases reserved budget when a wait is aborted and rejects pre-aborted signals", async () => {
  const limiter = new RagV2RateLimiter(1); // one unit per second
  await limiter.consume(1); // instant burst; the timeline now runs ~1s ahead
  const controller = new AbortController();
  const slow = limiter.consume(5, controller.signal); // schedules 5s of budget
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort(new Error("caller gave up"));
  await assert.rejects(() => slow, /caller gave up/);

  const started = Date.now();
  await limiter.consume(1);
  const waited = Date.now() - started;
  assert.ok(
    waited < 2_000,
    `released reservation should not delay later consumers (waited ${waited}ms; unreleased would exceed 5s)`,
  );

  const preAborted = new AbortController();
  preAborted.abort(new Error("already cancelled"));
  await assert.rejects(() => limiter.consume(1, preAborted.signal), /already cancelled/);
});

test("line index writer surfaces stream errors instead of crashing the process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-hardening-objectstore-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    const store = new RagV2ObjectStore(root);
    await store.initialize();
    const sourcePath = path.join(root, "docs", "source.md");
    await writeFile(sourcePath, "# Source\n\nbody evidence\n");
    const object = await store.putFile(sourcePath);

    const writer = await store.createLineIndexWriter(object.contentSha256);
    assert.ok(writer instanceof RagV2LineIndexWriter);
    await writer.add(1, 0);
    writer.stream.destroy(new Error("simulated mid-stream failure"));
    await assert.rejects(() => writer.close(), /simulated mid-stream failure/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manager close() stops the lazy embedding worker before closing the repository", { timeout: 15_000 }, async t => {
  const previousEager = process.env.CORTEX_RAG_V2_EAGER_MAX_BYTES;
  const previousAsync = process.env.CORTEX_RAG_V2_ASYNC_MAX_BYTES;
  process.env.CORTEX_RAG_V2_EAGER_MAX_BYTES = "1";
  process.env.CORTEX_RAG_V2_ASYNC_MAX_BYTES = "1";
  t.after(() => {
    if (previousEager === undefined) delete process.env.CORTEX_RAG_V2_EAGER_MAX_BYTES;
    else process.env.CORTEX_RAG_V2_EAGER_MAX_BYTES = previousEager;
    if (previousAsync === undefined) delete process.env.CORTEX_RAG_V2_ASYNC_MAX_BYTES;
    else process.env.CORTEX_RAG_V2_ASYNC_MAX_BYTES = previousAsync;
  });

  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-hardening-lazy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "cold.md"), "# Cold\n\n## Section\n\nThe cold answer is FROZEN-CEDAR-42.\n");

  let activeEmbeds = 0;
  let embedCalls = 0;
  const base = testEmbedder();
  const repository = new MemoryRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, {
    info: base.info,
    async embed(texts, purpose, signal) {
      embedCalls++;
      activeEmbeds++;
      try {
        return await new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }
          const timer = setTimeout(() => resolve(base.embed(texts, purpose, signal)), 25);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error("aborted"));
          }, { once: true });
        });
      } finally {
        activeEmbeds--;
      }
    },
  });

  const workspace = { id: "workspace-v2", name: "V2", configDir: root };
  const context = { id: "contracts", name: "Contracts", paths: [docs] };
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const result = await manager.search(workspace, context, "What is FROZEN-CEDAR-42?", { limit: 2 });
  assert.ok(result.evidence.length >= 1, "search must find the cold passage to trigger lazy promotion");

  for (let attempt = 0; attempt < 50 && activeEmbeds === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const callsBeforeClose = embedCalls;

  await manager.close();

  assert.ok(activeEmbeds === 0, "close() must not return while lazy embeds are in flight");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(embedCalls, callsBeforeClose, "no further embedding work runs after close()");
});

test("evidence assembly fetches ranges by hit.contentSha256 end to end", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-hardening-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "hash-lane.md"), [
    "# Hash lane",
    "",
    "The HASH-LANE-EVIDENCE-77 passage verifies byte-range rehashing.",
  ].join("\n"));

  const repository = new MemoryRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, testEmbedder());
  t.after(() => manager.close());
  const workspace = { id: "workspace-v2", name: "V2", configDir: root };
  const context = { id: "contracts", name: "Contracts", paths: [docs] };
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);

  const result = await manager.search(workspace, context, "HASH-LANE-EVIDENCE-77", { limit: 3 });
  assert.ok(result.evidence.length >= 1, "evidence fetched via contentSha256 must verify and survive");
  const first = result.evidence[0];
  assert.equal(first.contentSha256.length, 64);
  assert.match(first.text, /HASH-LANE-EVIDENCE-77/);
});
