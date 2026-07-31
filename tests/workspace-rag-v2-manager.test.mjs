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
const { reciprocalRankFusion } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/retrieval.ts"
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

function testEmbedder(delayMs = 0) {
  return {
    info: {
      backend: "test",
      model: "test-multilingual",
      dimensions: 32,
      signature: "test-v1",
      maxTokens: 512,
    },
    async embed(texts, _purpose, signal) {
      if (delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
      }
      return texts.map(text => embedding(text));
    },
  };
}

function refs(root, docs) {
  return {
    workspace: { id: "workspace-v2", name: "V2", configDir: root },
    context: { id: "contracts", name: "Contracts", paths: [docs] },
  };
}

test("workspace RAG V2 publishes a three-level hybrid index and returns verified evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "msa.md"), [
    "# Master Services Agreement",
    "",
    "## Termination",
    "",
    "The contractor may terminate for convenience by giving thirty days written notice.",
    "",
    "## Liability",
    "",
    "Liability is limited to fees paid during the preceding twelve months.",
  ].join("\n"));
  await writeFile(path.join(docs, "polish.md"), [
    "# Umowa ramowa",
    "",
    "## Wypowiedzenie",
    "",
    "Wykonawca może wypowiedzieć umowę z zachowaniem trzydziestodniowego okresu wypowiedzenia.",
  ].join("\n"));

  const repository = new MemoryRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, testEmbedder());
  t.after(() => manager.close());
  const { workspace, context } = refs(root, docs);
  const job = manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const status = await manager.status("primary", workspace, context);

  assert.equal(status.activeGenerationId, job.generationId);
  assert.equal(status.activeState, "active_hybrid_complete");
  assert.equal(status.job.state, "active_hybrid_complete");
  assert.equal(status.job.processedFiles, 2);

  const result = await manager.search(
    workspace,
    context,
    "Can the contractor terminate for convenience?",
    { limit: 4 },
  );
  assert.ok(result.evidence.length >= 1);
  assert.match(result.evidence[0].text, /terminate for convenience/i);
  assert.equal(result.evidence[0].contentSha256.length, 64);
  assert.ok(result.evidence[0].byteRange.to > result.evidence[0].byteRange.from);
  assert.ok(result.evidence[0].lineRange.to >= result.evidence[0].lineRange.from);
  assert.ok(repository.storedHits.some(hit => hit.hit.retriever === "passage_lexical"));

  const firstEvidence = result.evidence[0];
  const fetchedRange = await manager.fetchSourceRange(
    workspace,
    context,
    firstEvidence.documentVersionId,
    firstEvidence.byteRange.from,
    firstEvidence.byteRange.to,
  );
  assert.equal(fetchedRange.text, firstEvidence.text);
  const fetchedLines = await manager.fetchLines(
    workspace,
    context,
    firstEvidence.documentVersionId,
    firstEvidence.lineRange.from,
    firstEvidence.lineRange.to,
  );
  assert.match(fetchedLines.text, /terminate for convenience/i);
  const grep = await manager.grepDocuments(
    workspace,
    context,
    [firstEvidence.documentVersionId],
    "terminate.{0,80}convenience",
    10,
  );
  assert.ok(grep.matches.length >= 1);
  assert.equal(repository.regexRuns.length, 1);
  assert.equal(repository.regexRuns[0].patternHash.length, 64);
  await assert.rejects(
    manager.grepDocuments(
      workspace,
      context,
      [firstEvidence.documentVersionId],
      "(a+)+",
      10,
    ),
    /prohibited/,
  );
  const evaluation = await manager.evaluate(workspace, context, [{
    id: "termination-eval",
    category: "exact",
    query: "Can the contractor terminate for convenience?",
    judgments: [{ passageId: firstEvidence.passageId, relevance: 3 }],
  }], 4);
  assert.equal(evaluation.metrics.cases, 1);
  assert.equal(evaluation.metrics.recallAtK, 1);
  assert.equal(evaluation.metrics.evidenceFaithfulness, 0.25);
  assert.equal(repository.evaluationRuns.length, 1);

  const retrievalVariants = [
    "flat_dense_baseline",
    "lexical_only",
    "dense_only",
    "hybrid_rrf",
    "hybrid_translated",
    "hybrid_reranked",
    "hierarchical",
    "hierarchical_lazy",
  ];
  for (const variant of retrievalVariants) {
    const variantResult = await manager.search(
      workspace,
      context,
      "contractor terminate convenience",
      { limit: 4, variant },
    );
    assert.ok(variantResult.evidence.length > 0, `${variant} returns evidence`);
  }
  await manager.evaluate(workspace, context, [{
    id: "lexical-ablation",
    category: "exact",
    query: "contractor terminate convenience",
    judgments: [{ passageId: firstEvidence.passageId, relevance: 3 }],
  }], 4, "lexical_only");
  assert.equal(repository.evaluationRuns.at(-1).configuration.variant, "lexical_only");

  const crossLanguage = await manager.search(
    workspace,
    context,
    "termination notice under the agreement",
    { limit: 4 },
  );
  assert.ok(crossLanguage.evidence.some(item => /wypowied/i.test(item.text) || /termination/i.test(item.text)));

  const beforeEviction = await repository.validateGeneration(
    workspace.id, context.id, job.generationId,
  );
  const eviction = await manager.evictColdPassageEmbeddings(workspace, context, 1);
  const afterEviction = await repository.validateGeneration(
    workspace.id, context.id, job.generationId,
  );
  assert.equal(eviction.evicted, 1);
  assert.equal(afterEviction.lexicalReady, beforeEviction.lexicalReady);
  assert.equal(afterEviction.passageEmbeddings, beforeEviction.passageEmbeddings - 1);
  const afterEvictionSearch = await manager.search(
    workspace, context, "contractor terminate convenience", { limit: 3 },
  );
  assert.ok(afterEvictionSearch.evidence.length >= 1, "lexical evidence survives derivative eviction");
});

test("workspace RAG V2 census is bounded, resumable, and forecasts tiered storage without embeddings", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-census-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(path.join(docs, "archive"), { recursive: true });
  const duplicate = [
    "# Agreement",
    "",
    "## Clause 1.1 Notice",
    "",
    "| Party | Notice |",
    "| --- | --- |",
    "| Contractor | thirty days |",
  ].join("\n");
  await writeFile(path.join(docs, "current.md"), duplicate);
  await writeFile(path.join(docs, "archive", "copy.md"), duplicate);
  await writeFile(path.join(docs, "mixed.md"), "# Warunki\n\nTermination następuje po trzydziestu dniach.");

  const manager = new WorkspaceRagV2Manager(new MemoryRagV2Repository(), testEmbedder());
  t.after(() => manager.close());
  const census = await manager.census([docs]);

  assert.equal(census.complete, true);
  assert.equal(census.files, 3);
  assert.ok(census.structures.headings >= 3);
  assert.ok(census.structures.tables >= 2);
  assert.ok(census.exactDuplicateRate > 0.2);
  assert.equal(census.sourceClasses.archive, 1);
  assert.ok(census.projected.documentVectors === 3);
  assert.ok(census.projected.vectorBytes > 0);
  assert.ok(census.percentiles.p50 > 0);
  assert.equal(census.partitionPlan.backend, "postgres-pgvector");
  assert.equal(census.representativeSample.length, 3);

  const resumed = await manager.census([docs], new AbortController().signal, {
    deep: false,
    resumeAfter: census.representativeSample.map(item => item.path).sort()[0],
  });
  assert.ok(resumed.files < census.files);
  assert.equal(resumed.resumedAfter.endsWith(".md"), true);
});

test("workspace RAG V2 promotes routing metadata and enforces document, jurisdiction, and as-of filters", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-filters-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "pl-contract.md"), [
    "---",
    "document_type: contract",
    "jurisdiction: PL",
    "publication_date: 2024-01-01",
    "valid_from: 2024-02-01",
    "valid_to: 2027-12-31",
    "---",
    "# Polish contract",
    "",
    "The supplier must give thirty days notice.",
  ].join("\n"));
  await writeFile(path.join(docs, "us-policy.md"), [
    "---",
    "document_type: policy",
    "jurisdiction: US",
    "publication_date: 2026-01-01",
    "---",
    "# US policy",
    "",
    "The supplier must give ninety days notice.",
  ].join("\n"));

  const repository = new MemoryRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, testEmbedder());
  t.after(() => manager.close());
  const { workspace, context } = refs(root, docs);
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);

  const filtered = await manager.search(workspace, context, "supplier notice", {
    documentTypes: ["contract"],
    jurisdictions: ["PL"],
    asOfDate: "2025-01-01",
    limit: 4,
  });
  assert.ok(filtered.evidence.length >= 1);
  assert.ok(filtered.evidence.every(item => item.sourceUri.endsWith("pl-contract.md")));
  assert.ok(filtered.evidence.some(item => /thirty days/i.test(item.text)));
  assert.deepEqual(filtered.plan.documentTypes, ["contract"]);
  assert.deepEqual(filtered.plan.jurisdictions, ["PL"]);
  assert.equal(filtered.plan.asOfDate, "2025-01-01");

  const expired = await manager.search(workspace, context, "supplier notice", {
    jurisdictions: ["PL"],
    asOfDate: "2028-01-01",
    limit: 4,
  });
  assert.equal(expired.evidence.length, 0);
});

test("workspace RAG V2 backfill streams authoritative and current sources before archives", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-priority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  for (const folder of ["archive", "current", "signed"]) {
    await mkdir(path.join(docs, folder), { recursive: true });
    await writeFile(path.join(docs, folder, `${folder}.md`), `# ${folder}\n\n${folder} evidence`);
  }
  const order = [];
  const manager = new WorkspaceRagV2Manager(
    new MemoryRagV2Repository(),
    testEmbedder(),
    {
      async register(_workspace, _context, sourcePath) {
        order.push(sourcePath.replaceAll("\\", "/"));
        return {};
      },
      async recordFailure() {},
    },
  );
  t.after(() => manager.close());
  const { workspace, context } = refs(root, docs);
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);

  assert.match(order[0], /\/signed\//);
  assert.match(order[1], /\/current\//);
  assert.match(order[2], /\/archive\//);
});

test("workspace RAG V2 cancellation preserves the active publication", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "first.md"), "# First\n\nstable evidence");

  const repository = new MemoryRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, testEmbedder());
  t.after(() => manager.close());
  const { workspace, context } = refs(root, docs);
  const first = manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  assert.equal((await manager.status("primary", workspace, context)).activeGenerationId, first.generationId);

  for (let index = 0; index < 20; index++) {
    await writeFile(path.join(docs, `new-${index}.md`), `# New ${index}\n\n${"slow evidence ".repeat(200)}`);
  }
  const slowManager = new WorkspaceRagV2Manager(repository, testEmbedder(100));
  const second = slowManager.startIngestion(workspace, context);
  await new Promise(resolve => setTimeout(resolve, 25));
  const cancelled = await slowManager.cancel(workspace.id, context.id);

  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.generationId, second.generationId);
  assert.equal(
    (await slowManager.status("primary", workspace, context)).activeGenerationId,
    first.generationId,
    "a cancelled staging generation never replaces the active publication",
  );
  await slowManager.close();
});

test("workspace RAG V2 keeps complete lexical coverage and lazily promotes cold passages", async t => {
  const previousEager = process.env.CORTEX_RAG_V2_EAGER_MAX_BYTES;
  const previousAsync = process.env.CORTEX_RAG_V2_ASYNC_MAX_BYTES;
  process.env.CORTEX_RAG_V2_EAGER_MAX_BYTES = "1";
  process.env.CORTEX_RAG_V2_ASYNC_MAX_BYTES = "2";
  t.after(() => {
    if (previousEager === undefined) delete process.env.CORTEX_RAG_V2_EAGER_MAX_BYTES;
    else process.env.CORTEX_RAG_V2_EAGER_MAX_BYTES = previousEager;
    if (previousAsync === undefined) delete process.env.CORTEX_RAG_V2_ASYNC_MAX_BYTES;
    else process.env.CORTEX_RAG_V2_ASYNC_MAX_BYTES = previousAsync;
  });
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-lazy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "huge-policy.md"), [
    "# Exceptional source",
    "",
    "## Cold section",
    "",
    "The cold-section answer is BLUE-CEDAR-917 and remains lexically searchable.",
  ].join("\n"));

  const repository = new MemoryRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, testEmbedder());
  t.after(() => manager.close());
  const { workspace, context } = refs(root, docs);
  const job = manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const before = await repository.validateGeneration(
    workspace.id,
    context.id,
    job.generationId,
  );
  assert.equal(before.passageEmbeddings, 0);
  assert.equal(before.lexicalReady, before.passages);
  assert.ok(
    ["active_lexical", "active_hybrid_partial"].includes(
      (await manager.status("primary", workspace, context)).activeState,
    ),
  );

  const result = await manager.search(workspace, context, "What is BLUE-CEDAR-917?", { limit: 2 });
  assert.match(result.evidence[0].text, /BLUE-CEDAR-917/);
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = await repository.validateGeneration(
      workspace.id,
      context.id,
      job.generationId,
    );
    if (current.passageEmbeddings > 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const after = await repository.validateGeneration(
    workspace.id,
    context.id,
    job.generationId,
  );
  assert.ok(after.passageEmbeddings > 0);
  assert.ok(after.passageEmbeddings < after.passages, "unselected cold sections remain outside the vector index");
  assert.equal((await manager.status("primary", workspace, context)).activeState, "active_hybrid_partial");
});

test("workspace RAG V2 caps planned passage vectors for medium files", async t => {
  const previous = {
    eager: process.env.CORTEX_RAG_V2_EAGER_MAX_BYTES,
    async: process.env.CORTEX_RAG_V2_ASYNC_MAX_BYTES,
    cap: process.env.CORTEX_RAG_V2_EAGER_PASSAGE_VECTOR_CAP,
  };
  process.env.CORTEX_RAG_V2_EAGER_MAX_BYTES = "1";
  process.env.CORTEX_RAG_V2_ASYNC_MAX_BYTES = "1000000";
  process.env.CORTEX_RAG_V2_EAGER_PASSAGE_VECTOR_CAP = "2";
  t.after(() => {
    for (const [name, value] of Object.entries({
      CORTEX_RAG_V2_EAGER_MAX_BYTES: previous.eager,
      CORTEX_RAG_V2_ASYNC_MAX_BYTES: previous.async,
      CORTEX_RAG_V2_EAGER_PASSAGE_VECTOR_CAP: previous.cap,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-medium-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "medium.md"), Array.from(
    { length: 12 },
    (_, index) => `## Section ${index}\n\nEvidence token MEDIUM-${index}.`,
  ).join("\n\n"));
  const repository = new MemoryRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, testEmbedder());
  t.after(() => manager.close());
  const { workspace, context } = refs(root, docs);
  const job = manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await repository.validateGeneration(
      workspace.id, context.id, job.generationId,
    );
    if (status.passageEmbeddings >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const validation = await repository.validateGeneration(
    workspace.id, context.id, job.generationId,
  );
  assert.equal(validation.lexicalReady, validation.passages);
  assert.equal(validation.passageEmbeddings, 2);
  assert.ok(validation.passageEmbeddings < validation.passages);
});

test("workspace RAG V2 reuses content-addressed derivatives across duplicate sources", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  const content = "# Duplicate\n\nIdentical derivative content.";
  await writeFile(path.join(docs, "a.md"), content);
  await writeFile(path.join(docs, "b.md"), content);
  let embeddedTexts = 0;
  const base = testEmbedder();
  const repository = new MemoryRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, {
    info: base.info,
    async embed(texts, purpose, signal) {
      embeddedTexts += texts.length;
      return base.embed(texts, purpose, signal);
    },
  });
  t.after(() => manager.close());
  const { workspace, context } = refs(root, docs);
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);

  assert.ok(embeddedTexts <= 4, `duplicate content should reuse derivatives, embedded ${embeddedTexts} texts`);
  const status = await manager.status("primary", workspace, context);
  assert.equal(status.job.processedFiles, 2);
});

test("workspace RAG V2 builds an unchanged corpus as a side-by-side derivative generation when the embedding signature changes", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-signature-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "stable.md"), "# Stable\n\nSignature-specific evidence.");
  const repository = new MemoryRagV2Repository();
  const { workspace, context } = refs(root, docs);

  const firstEmbedder = testEmbedder();
  const first = new WorkspaceRagV2Manager(repository, firstEmbedder);
  const firstJob = first.startIngestion(workspace, context);
  await first.waitForIngestion(workspace.id, context.id);
  assert.equal(
    (await repository.activePublication(workspace.id, context.id)).embeddingSignature,
    "test-v1",
  );
  await first.close();

  let secondEmbedded = 0;
  const second = new WorkspaceRagV2Manager(repository, {
    info: { ...firstEmbedder.info, signature: "test-v2" },
    async embed(texts, purpose, signal) {
      secondEmbedded += texts.length;
      return firstEmbedder.embed(texts, purpose, signal);
    },
  });
  t.after(() => second.close());
  const secondJob = second.startIngestion(workspace, context);
  await second.waitForIngestion(workspace.id, context.id);
  const publication = await repository.activePublication(workspace.id, context.id);
  assert.notEqual(secondJob.generationId, firstJob.generationId);
  assert.equal(publication.embeddingSignature, "test-v2");
  assert.ok(secondEmbedded > 0, "unchanged source receives the new signature derivatives");
  const validation = await repository.validateGeneration(
    workspace.id, context.id, secondJob.generationId,
  );
  assert.equal(validation.passageEmbeddings, validation.passages);
});

test("workspace RAG V2 reciprocal rank fusion preserves retriever reasons", () => {
  const base = {
    level: "passage",
    documentId: "doc",
    documentVersionId: "version",
    sectionId: "section",
    passageId: "passage",
    path: "doc.md",
    title: "Document",
    headingPath: [],
    language: "en",
    text: "evidence",
    contentSha256: "a".repeat(64),
    retrieverScore: 1,
    retrievalReasons: [],
  };
  const fused = reciprocalRankFusion([
    [{ ...base, id: "passage", retriever: "passage_lexical", retrieverRank: 1, retrievalReasons: ["lexical rank 1"] }],
    [{ ...base, id: "passage", retriever: "passage_dense", retrieverRank: 2, retrievalReasons: ["dense rank 2"] }],
  ]);
  assert.equal(fused.length, 1);
  assert.ok(fused[0].fusionScore > 0);
  assert.ok(fused[0].retrievalReasons.includes("lexical rank 1"));
  assert.ok(fused[0].retrievalReasons.includes("dense rank 2"));
  assert.equal(
    fused[0].retrievalReasons.filter(reason => /RRF contribution/.test(reason)).length,
    2,
  );
});
