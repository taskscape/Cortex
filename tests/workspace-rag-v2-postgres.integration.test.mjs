import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const requireFromMatbot = createRequire(
  path.resolve("local-agent/matbot/packages/plugins/workspace-rag/package.json"),
);
const { Pool } = requireFromMatbot("pg");

const enabled = process.env.CORTEX_RAG_V2_POSTGRES_INTEGRATION === "1";
const integration = enabled ? test : test.skip;

function embedding(text, dimensions = 32) {
  const vector = new Array(dimensions).fill(0);
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const digest = createHash("sha256").update(token).digest();
    vector[digest.readUInt16BE(0) % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

integration("workspace RAG V2 PostgreSQL publishes lexical and pgvector generations", async t => {
  const schema = `workspace_rag_v2_test_${process.pid}`;
  process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA = schema;
  const { PostgresRagV2Repository } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts"
  );
  const { WorkspaceRagV2Manager } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts"
  );

  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-postgres-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "supply.md"), [
    "---",
    "collection_id: supply-contracts",
    "collection_title: Supply Contracts",
    "---",
    "# Supply Agreement",
    "",
    "## Delivery",
    "",
    "The supplier shall deliver all components within fourteen calendar days.",
    "",
    "## Payment",
    "",
    "Payment is due within thirty days of a valid invoice.",
  ].join("\n"));

  const poolConfig = process.env.CORTEX_RAG_POSTGRES_URL
    ? { connectionString: process.env.CORTEX_RAG_POSTGRES_URL }
    : {
        host: process.env.CORTEX_RAG_POSTGRES_HOST || "127.0.0.1",
        port: Number(process.env.CORTEX_RAG_POSTGRES_PORT || 5432),
        database: process.env.CORTEX_RAG_POSTGRES_DB || "mem0",
        user: process.env.CORTEX_RAG_POSTGRES_USER || "mem0",
        password: process.env.CORTEX_RAG_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
      };
  const cleanup = new Pool(poolConfig);
  const repository = new PostgresRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, {
    info: { backend: "test", model: "test", dimensions: 32, signature: "test-pg-v1" },
    async embed(texts) { return texts.map(text => embedding(text)); },
  }, undefined, {
    summarizerSignature: "test-pg-summary-v1",
    async summarize(input) {
      return `Semantic ${input.level} routing summary for ${input.title}: ${input.text}`;
    },
  });
  t.after(async () => {
    await manager.close().catch(() => undefined);
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(root, { recursive: true, force: true });
  });

  const workspace = { id: "postgres-workspace", name: "Postgres", configDir: root };
  const context = { id: "agreements", name: "Agreements", paths: [docs] };
  const job = manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  await manager.waitForSummaries();
  const fingerprints = await repository.listFingerprints(workspace.id, context.id);
  assert.equal(fingerprints[0].summarySignature, "test-pg-summary-v1");
  const status = await manager.status("primary", workspace, context);
  assert.equal(status.job.state, "active_hybrid_complete");
  assert.equal(status.activeGenerationId, job.generationId);

  const result = await manager.search(
    workspace,
    context,
    "When must the supplier deliver components?",
    { limit: 3 },
  );
  assert.ok(result.evidence.length >= 1);
  assert.match(result.evidence[0].text, /fourteen calendar days/i);
  const evidence = result.evidence[0];
  const lines = await manager.fetchLines(
    workspace,
    context,
    evidence.documentVersionId,
    evidence.lineRange.from,
    evidence.lineRange.to,
  );
  assert.match(lines.text, /fourteen calendar days/i);
  const grep = await manager.grepDocuments(
    workspace,
    context,
    [evidence.documentVersionId],
    "deliver.{0,80}fourteen",
    10,
  );
  assert.ok(grep.matches.length >= 1);
  const evaluation = await manager.evaluate(workspace, context, [{
    id: "delivery-eval",
    category: "exact",
    query: "When must the supplier deliver components?",
    judgments: [{ passageId: evidence.passageId, relevance: 3 }],
  }], 3);
  assert.equal(evaluation.metrics.recallAtK, 1);
  const beforeEviction = await repository.validateGeneration(
    workspace.id, context.id, job.generationId,
  );
  const eviction = await manager.evictColdPassageEmbeddings(workspace, context, 1);
  const afterEviction = await repository.validateGeneration(
    workspace.id, context.id, job.generationId,
  );
  assert.equal(eviction.evicted, 1);
  assert.equal(afterEviction.passageEmbeddings, beforeEviction.passageEmbeddings - 1);
  assert.equal(afterEviction.lexicalReady, beforeEviction.lexicalReady);

  const counts = await cleanup.query(`
    SELECT
      (SELECT COUNT(*) FROM "${schema}".documents) AS documents,
      (SELECT COUNT(*) FROM "${schema}".collections) AS collections,
      (SELECT COUNT(*) FROM "${schema}".routing_summaries) AS routing_summaries,
      (SELECT COUNT(*) FROM "${schema}".sections) AS sections,
      (SELECT COUNT(*) FROM "${schema}".passages) AS passages,
      (SELECT COUNT(*) FROM "${schema}".unit_embeddings_32) AS embeddings,
      (SELECT COUNT(*) FROM "${schema}".retrieval_evidence) AS retrieval_evidence,
      (SELECT COUNT(*) FROM "${schema}".evaluation_runs) AS evaluation_runs,
      (SELECT MAX(version) FROM "${schema}".schema_migrations) AS schema_version
  `);
  assert.equal(Number(counts.rows[0].documents), 1);
  assert.equal(Number(counts.rows[0].collections), 1);
  assert.ok(Number(counts.rows[0].routing_summaries) >= 4);
  assert.ok(Number(counts.rows[0].sections) >= 2);
  assert.ok(Number(counts.rows[0].passages) >= 2);
  assert.ok(Number(counts.rows[0].embeddings) >= 3);
  assert.ok(Number(counts.rows[0].retrieval_evidence) >= 1);
  assert.equal(Number(counts.rows[0].evaluation_runs), 1);
  assert.equal(Number(counts.rows[0].schema_version), 7);
  assert.deepEqual(await repository.listReferencedContentHashes(), new Set([fingerprints[0].contentSha256]));

  await unlink(path.join(docs, "supply.md"));
  manager.startIngestion(workspace, context, "configuration");
  await manager.waitForIngestion(workspace.id, context.id);
  const gc = await repository.pruneOrphans(
    workspace.id,
    context.id,
    new Date(Date.now() + 60_000).toISOString(),
  );
  assert.equal(gc.deletionsSkipped, false);
  assert.equal(gc.documentsDeleted, 1);
  assert.ok(gc.sectionsDeleted >= 2);
  assert.ok(gc.passagesDeleted >= 2);
  assert.ok(gc.embeddingsDeleted >= 1);
  assert.ok(await repository.pruneRetiredGenerations(
    workspace.id,
    context.id,
    new Date(Date.now() + 60_000).toISOString(),
  ) >= 1);

  await repository.purgeContext(workspace.id, context.id);
  await repository.purgeContext(workspace.id, context.id);
  const afterPurge = await cleanup.query(`
    SELECT
      (SELECT COUNT(*) FROM "${schema}".publications) AS publications,
      (SELECT COUNT(*) FROM "${schema}".documents) AS documents,
      (SELECT COUNT(*) FROM "${schema}".sections) AS sections,
      (SELECT COUNT(*) FROM "${schema}".passages) AS passages,
      (SELECT COUNT(*) FROM "${schema}".unit_embeddings_32) AS embeddings,
      (SELECT COUNT(*) FROM "${schema}".ingestion_jobs) AS ingestion_jobs,
      (SELECT COUNT(*) FROM "${schema}".retrieval_evidence) AS retrieval_evidence,
      (SELECT COUNT(*) FROM "${schema}".evaluation_runs) AS evaluation_runs
  `);
  assert.equal(Number(afterPurge.rows[0].publications), 0);
  assert.equal(Number(afterPurge.rows[0].documents), 0);
  assert.equal(Number(afterPurge.rows[0].sections), 0);
  assert.equal(Number(afterPurge.rows[0].passages), 0);
  assert.equal(Number(afterPurge.rows[0].embeddings), 0);
  assert.equal(Number(afterPurge.rows[0].ingestion_jobs), 0);
  assert.ok(Number(afterPurge.rows[0].retrieval_evidence) >= 1, "retrieval audit evidence is retained");
  assert.equal(Number(afterPurge.rows[0].evaluation_runs), 1, "evaluation audit history is retained");
});

integration("workspace RAG V2 PostgreSQL resumes an interrupted scan and prunes abandoned generations", async t => {
  const schema = `workspace_rag_v2_resume_${process.pid}`;
  process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA = schema;
  process.env.CORTEX_RAG_V2_CHECKPOINT_FILES = "2";
  const { PostgresRagV2Repository } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts"
  );
  const { WorkspaceRagV2Manager } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts"
  );

  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-pg-resume-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  for (const name of ["a", "b", "c", "d", "e", "f"]) {
    await writeFile(
      path.join(docs, `${name}.md`),
      `# Doc ${name}\n\n## Body\n\nThe ${name} answer is PG-RESUME-${name.toLocaleUpperCase()}.`,
      "utf8",
    );
  }
  const poolConfig = process.env.CORTEX_RAG_POSTGRES_URL
    ? { connectionString: process.env.CORTEX_RAG_POSTGRES_URL }
    : {
        host: process.env.CORTEX_RAG_POSTGRES_HOST || "127.0.0.1",
        port: Number(process.env.CORTEX_RAG_POSTGRES_PORT || 5432),
        database: process.env.CORTEX_RAG_POSTGRES_DB || "mem0",
        user: process.env.CORTEX_RAG_POSTGRES_USER || "mem0",
        password: process.env.CORTEX_RAG_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
      };
  const cleanup = new Pool(poolConfig);
  const repository = new PostgresRagV2Repository();
  const embedder = {
    info: { backend: "test", model: "test", dimensions: 32, signature: "test-pg-resume-v1" },
    async embed(texts) { return texts.map(text => embedding(text)); },
  };
  const workspace = { id: "postgres-resume-workspace", name: "Postgres", configDir: root };
  const context = { id: "resume", name: "Resume", paths: [docs] };

  let interruptedManager;
  let reached;
  const reachedFiles = new Promise(resolve => { reached = resolve; });
  interruptedManager = new WorkspaceRagV2Manager(repository, {
    info: embedder.info,
    async embed(texts, purpose, signal) {
      const observed = signal
        ? await interruptedManager.status("primary", workspace, context)
        : undefined;
      if (signal && observed.job.processedFiles >= 3) {
        reached();
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return embedder.embed(texts, purpose, signal);
    },
  });
  const restarted = new WorkspaceRagV2Manager(repository, embedder);
  t.after(async () => {
    delete process.env.CORTEX_RAG_V2_CHECKPOINT_FILES;
    await interruptedManager.close().catch(() => undefined);
    await restarted.close().catch(() => undefined);
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(root, { recursive: true, force: true });
  });

  const interruptedJob = interruptedManager.startIngestion(workspace, context);
  await Promise.race([
    reachedFiles,
    interruptedManager.waitForIngestion(workspace.id, context.id).then(job => {
      throw new Error(`Ingestion ended before the checkpoint probe: ${job?.state}: ${job?.message}`);
    }),
  ]);
  await interruptedManager.cancel(workspace.id, context.id);
  const interruptedStatus = await interruptedManager.status("primary", workspace, context);
  assert.equal(interruptedStatus.job.discoveryComplete, false);
  assert.ok(interruptedStatus.job.publishedCheckpoints >= 1, "a checkpoint publishes mid-scan");
  assert.notEqual(
    interruptedStatus.activeGenerationId,
    interruptedJob.generationId,
    "the interrupted scan keeps its staging generation separate from the published checkpoint",
  );
  assert.ok(interruptedStatus.indexedDocuments >= 2);
  const held = await repository.listFingerprints(
    workspace.id, context.id, interruptedJob.generationId,
  );
  assert.ok(held.length >= interruptedStatus.indexedDocuments, "staging may contain work completed after the latest checkpoint");
  assert.equal(
    held.length,
    interruptedStatus.job.processedFiles,
    "the file that was mid-ingest when the run died never joined the generation",
  );
  assert.ok(
    held.every(value => typeof value.modifiedAt === "string"),
    "stored mtimes come back as ISO strings so the unchanged check can compare them",
  );

  const resumedJob = restarted.startIngestion(workspace, context, "startup");
  await restarted.waitForIngestion(workspace.id, context.id);
  const status = await restarted.status("primary", workspace, context);
  assert.equal(resumedJob.generationId, interruptedJob.generationId, "the restart adopts the generation");
  assert.ok(status.job.resumedFiles >= 3, "completed files are inherited rather than re-ingested");
  assert.equal(status.job.addedFiles + status.job.unchangedFiles, 6);
  assert.ok(status.job.addedFiles < 6, "a restart does not start from zero");
  assert.equal(status.job.state, "active_hybrid_complete");
  assert.equal(status.indexedDocuments, 6);

  const evidence = await restarted.search(workspace, context, "PG-RESUME-A", { limit: 3 });
  assert.ok(evidence.evidence.length >= 1, "inherited work stays searchable");

  const rescan = new WorkspaceRagV2Manager(repository, embedder);
  t.after(() => rescan.close().catch(() => undefined));
  rescan.startIngestion(workspace, context, "startup");
  await rescan.waitForIngestion(workspace.id, context.id);
  const rescanned = await rescan.status("primary", workspace, context);
  assert.equal(rescanned.job.unchangedFiles, 6, "a completed corpus is recognised on the next run");
  assert.equal(rescanned.job.addedFiles, 0);
  assert.equal(rescanned.job.changedFiles, 0, "stored mtimes compare equal across restarts");
  assert.equal(rescanned.indexedDocuments, 6);

  const staging = await cleanup.query(`
    SELECT COUNT(*)::int AS count FROM "${schema}".publications
    WHERE workspace_id = $1 AND context_id = $2 AND state = 'staging'
  `, [workspace.id, context.id]);
  assert.equal(staging.rows[0].count, 0, "no abandoned staging generation is left behind");

  // REL-02: deletion is applied to staging even after an independent checkpoint is active.
  await unlink(path.join(docs, "f.md"));
  let failedGeneration;
  const rebuild = repository.rebuildCollections.bind(repository);
  repository.rebuildCollections = async (...args) => {
    if (args[2] === failedGeneration) {
      const concurrentRead = await rescan.search(workspace, context, "PG-RESUME-F", { variant: "lexical_only" });
      assert.ok(concurrentRead.evidence.some(item => item.text.includes("PG-RESUME-F")));
      throw new Error("synthetic failure after PostgreSQL reconciliation");
    }
    return rebuild(...args);
  };
  const failed = rescan.startIngestion(workspace, context, "manual", [], true);
  failedGeneration = failed.generationId;
  await rescan.waitForIngestion(workspace.id, context.id);
  assert.equal(failed.state, "retryable_failure");
  assert.ok(failed.publishedCheckpoints > 0);
  const active = await repository.activePublication(workspace.id, context.id);
  assert.notEqual(active.generationId, failedGeneration);
  assert.equal((await repository.listFingerprints(workspace.id, context.id)).length, 6);
  repository.rebuildCollections = rebuild;
});

integration("workspace RAG V2 PostgreSQL indexes NUL-bearing sources and reconciles deletions past a failing file", async t => {
  const schema = `workspace_rag_v2_nul_${process.pid}`;
  process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA = schema;
  const { PostgresRagV2Repository } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts"
  );
  const { WorkspaceRagV2Manager } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts"
  );

  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-pg-nul-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  const removedPath = path.join(docs, "removed.md");
  // PDF extraction leaves U+0000 where a ligature glyph had no Unicode mapping.
  await writeFile(
    path.join(docs, "extracted.md"),
    "# Pro\0l \0rmy\n\nOferta danej \0rmy PG-NUL-EVIDENCE-771.",
    "utf8",
  );
  await writeFile(path.join(docs, "broken.md"), "# Broken\n\nThis source never registers.", "utf8");
  await writeFile(removedPath, "# Removed\n\nPG-REMOVED-EVIDENCE-772.", "utf8");
  const poolConfig = process.env.CORTEX_RAG_POSTGRES_URL
    ? { connectionString: process.env.CORTEX_RAG_POSTGRES_URL }
    : {
        host: process.env.CORTEX_RAG_POSTGRES_HOST || "127.0.0.1",
        port: Number(process.env.CORTEX_RAG_POSTGRES_PORT || 5432),
        database: process.env.CORTEX_RAG_POSTGRES_DB || "mem0",
        user: process.env.CORTEX_RAG_POSTGRES_USER || "mem0",
        password: process.env.CORTEX_RAG_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
      };
  const cleanup = new Pool(poolConfig);
  const repository = new PostgresRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, {
    info: { backend: "test", model: "test", dimensions: 32, signature: "test-pg-nul-v1" },
    async embed(texts) { return texts.map(text => embedding(text)); },
  }, {
    async register(_workspace, _context, filePath) {
      if (filePath.endsWith("/broken.md")) throw new Error("intentional source registration failure");
      return {};
    },
    async recordFailure() {},
    async markRemoved() {},
  });
  t.after(async () => {
    await manager.close().catch(() => undefined);
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(root, { recursive: true, force: true });
  });

  const workspace = { id: "postgres-nul-workspace", name: "Postgres", configDir: root };
  const context = { id: "extracted", name: "Extracted", paths: [docs] };
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const indexed = await manager.status("primary", workspace, context);
  assert.equal(indexed.job.failedFiles, 1, "only the source that cannot register fails");
  assert.equal(indexed.job.addedFiles, 2);
  const stored = await cleanup.query(`
    SELECT title FROM "${schema}".documents WHERE path LIKE '%/extracted.md'
  `);
  assert.deepEqual(stored.rows, [{ title: "Prol rmy" }]);
  const found = await manager.search(workspace, context, "PG-NUL-EVIDENCE-771", { limit: 3 });
  assert.ok(
    found.evidence.some(value => /Oferta danej rmy PG-NUL-EVIDENCE-771/.test(value.text)),
    "the retrieval audit accepts evidence read back from NUL-bearing source bytes",
  );

  await unlink(removedPath);
  manager.startIngestion(workspace, context, "watch");
  await manager.waitForIngestion(workspace.id, context.id);
  const reconciled = await manager.status("primary", workspace, context);
  assert.equal(reconciled.job.failedFiles, 1, "the same source keeps failing");
  assert.equal(reconciled.job.removedFiles, 1, "a failing file no longer blocks deletion reconciliation");
  assert.deepEqual(
    (await repository.listFingerprints(workspace.id, context.id)).map(value => path.basename(value.path)),
    ["extracted.md"],
  );
  const gone = await manager.search(workspace, context, "PG-REMOVED-EVIDENCE-772", { limit: 3 });
  assert.equal(gone.evidence.some(value => value.text.includes("PG-REMOVED-EVIDENCE-772")), false);
});

integration("workspace RAG V2 PostgreSQL stores front-matter metadata and filters by document type, jurisdiction, and as-of date", async t => {
  const schema = `workspace_rag_v2_meta_${process.pid}`;
  process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA = schema;
  const { PostgresRagV2Repository } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts"
  );
  const { WorkspaceRagV2Manager } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts"
  );

  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-pg-meta-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "contract-pl.md"), [
    "---",
    "document_type: contract",
    "jurisdiction: PL",
    "governing_law: Polish Civil Code",
    "parties: [Acme Sp. z o.o., Globex GmbH]",
    "publication_date: 2024-01-01",
    "valid_from: 2024-02-01",
    "valid_to: 2027-12-31",
    "---",
    "# Polish contract",
    "",
    "The supplier must give thirty days notice.",
  ].join("\n"));
  await writeFile(path.join(docs, "note.md"), "# Plain note\n\nThe supplier must give sixty days notice.");
  await writeFile(path.join(docs, "policy-us.md"), [
    "---",
    "document_type: policy",
    "jurisdiction: US",
    "publication_date: 2026-01-01",
    "---",
    "# US policy",
    "",
    "The supplier must give ninety days notice.",
  ].join("\n"));
  const poolConfig = process.env.CORTEX_RAG_POSTGRES_URL
    ? { connectionString: process.env.CORTEX_RAG_POSTGRES_URL }
    : {
        host: process.env.CORTEX_RAG_POSTGRES_HOST || "127.0.0.1",
        port: Number(process.env.CORTEX_RAG_POSTGRES_PORT || 5432),
        database: process.env.CORTEX_RAG_POSTGRES_DB || "mem0",
        user: process.env.CORTEX_RAG_POSTGRES_USER || "mem0",
        password: process.env.CORTEX_RAG_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
      };
  const cleanup = new Pool(poolConfig);
  const repository = new PostgresRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, {
    info: { backend: "test", model: "test", dimensions: 32, signature: "test-pg-meta-v1" },
    async embed(texts) { return texts.map(text => embedding(text)); },
  });
  t.after(async () => {
    await manager.close().catch(() => undefined);
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(root, { recursive: true, force: true });
  });

  const workspace = { id: "postgres-meta-workspace", name: "Postgres", configDir: root };
  const context = { id: "filters", name: "Filters", paths: [docs] };
  const storedMetadata = async () => (await cleanup.query(`
    SELECT path, document_type, jurisdiction, governing_law, parties,
      publication_date::text AS publication_date, valid_from::text AS valid_from, valid_to::text AS valid_to
    FROM "${schema}".documents ORDER BY path
  `)).rows.map(row => ({ ...row, path: path.basename(row.path) }));
  const expectedMetadata = [
    {
      path: "contract-pl.md", document_type: "contract", jurisdiction: "PL",
      governing_law: "Polish Civil Code", parties: ["Acme Sp. z o.o.", "Globex GmbH"],
      publication_date: "2024-01-01", valid_from: "2024-02-01", valid_to: "2027-12-31",
    },
    {
      path: "note.md", document_type: "markdown", jurisdiction: null,
      governing_law: null, parties: [],
      publication_date: null, valid_from: null, valid_to: null,
    },
    {
      path: "policy-us.md", document_type: "policy", jurisdiction: "US",
      governing_law: null, parties: [],
      publication_date: "2026-01-01", valid_from: null, valid_to: null,
    },
  ];
  const assertFilters = async () => {
    const filtered = await manager.search(workspace, context, "supplier notice", {
      documentTypes: ["contract"],
      jurisdictions: ["PL"],
      asOfDate: "2025-01-01",
      limit: 4,
    });
    assert.ok(filtered.evidence.length >= 1, "the type and jurisdiction filters match front-matter values");
    assert.ok(filtered.evidence.every(item => item.sourceUri.endsWith("contract-pl.md")));
    assert.ok(filtered.evidence.some(item => /thirty days/i.test(item.text)));
    assert.equal(filtered.evidence[0].documentType, "contract");
    assert.equal(filtered.evidence[0].jurisdiction, "PL");
    const expired = await manager.search(workspace, context, "supplier notice", {
      jurisdictions: ["PL"],
      asOfDate: "2028-01-01",
      limit: 4,
    });
    assert.equal(expired.evidence.length, 0, "valid_to excludes the contract after it lapses");
    const untyped = await manager.search(workspace, context, "supplier notice", {
      documentTypes: ["markdown"],
      limit: 4,
    });
    assert.ok(untyped.evidence.length >= 1);
    assert.ok(untyped.evidence.every(item => item.sourceUri.endsWith("note.md")));
  };

  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  assert.deepEqual(await storedMetadata(), expectedMetadata);
  await assertFilters();

  // Rows written before the metadata columns joined the upsert hold only the
  // placeholder values; a forced reindex of the unchanged files repairs them.
  await cleanup.query(`
    UPDATE "${schema}".documents
    SET document_type = 'markdown', jurisdiction = NULL, governing_law = NULL, parties = '[]'::jsonb,
      publication_date = NULL, valid_from = NULL, valid_to = NULL
  `);
  manager.startIngestion(workspace, context, "manual", [], true);
  await manager.waitForIngestion(workspace.id, context.id);
  assert.deepEqual(await storedMetadata(), expectedMetadata);
  await assertFilters();
});

integration("workspace RAG V2 PostgreSQL checks generation membership per candidate instead of driving searches from it", async t => {
  const schema = `workspace_rag_v2_plan_${process.pid}`;
  process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA = schema;
  const { PostgresRagV2Repository } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts"
  );
  const { WorkspaceRagV2Manager } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts"
  );

  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-pg-plan-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "notice.md"), [
    "# Notice periods",
    "",
    "## Supplier",
    "",
    "The supplier must give thirty days notice.",
    "",
    "## Customer",
    "",
    "The customer must give sixty days notice.",
  ].join("\n"));
  const poolConfig = process.env.CORTEX_RAG_POSTGRES_URL
    ? { connectionString: process.env.CORTEX_RAG_POSTGRES_URL }
    : {
        host: process.env.CORTEX_RAG_POSTGRES_HOST || "127.0.0.1",
        port: Number(process.env.CORTEX_RAG_POSTGRES_PORT || 5432),
        database: process.env.CORTEX_RAG_POSTGRES_DB || "mem0",
        user: process.env.CORTEX_RAG_POSTGRES_USER || "mem0",
        password: process.env.CORTEX_RAG_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
      };
  const cleanup = new Pool(poolConfig);
  const repository = new PostgresRagV2Repository();
  const vectorizer = { backend: "test", model: "test", dimensions: 32, signature: "test-pg-plan-v1" };
  const manager = new WorkspaceRagV2Manager(repository, {
    info: vectorizer,
    async embed(texts) { return texts.map(text => embedding(text)); },
  });
  t.after(async () => {
    await manager.close().catch(() => undefined);
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(root, { recursive: true, force: true });
  });

  const workspace = { id: "postgres-plan-workspace", name: "Postgres", configDir: root };
  const context = { id: "plans", name: "Plans", paths: [docs] };
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const publication = await repository.activePublication(workspace.id, context.id);
  const scope = {
    workspaceId: workspace.id,
    contextId: context.id,
    generationId: publication.generationId,
    authorizationTokens: [`workspace:${workspace.id}`],
    limit: 10,
  };
  const queryVector = embedding("supplier notice");

  // Table statistics never describe a generation published after they were
  // gathered, so membership planned as a join is estimated at one row and
  // becomes the driving table: the search then visits every document of the
  // generation instead of using its GIN or HNSW index. Membership must stay a
  // per-candidate subplan whatever the statistics say.
  const membershipScans = plan => {
    const scans = [];
    const visit = (node, inSubPlan) => {
      const nested = inSubPlan || node["Parent Relationship"] === "SubPlan";
      if (node["Relation Name"] === "publication_documents") scans.push(nested);
      for (const child of node.Plans ?? []) visit(child, nested);
    };
    visit(plan, false);
    return scans;
  };
  for (const level of ["document", "section", "passage"]) {
    for (const kind of ["lexical", "dense"]) {
      const parameters = kind === "lexical"
        ? repository.searchParameters({ ...scope, documentIds: ["d"], sectionIds: ["s"] }, "supplier notice")
        : repository.searchParameters(
            { ...scope, documentIds: ["d"], sectionIds: ["s"] },
            `[${queryVector.join(",")}]`,
            vectorizer.signature,
          );
      const explained = await cleanup.query(
        `EXPLAIN (FORMAT JSON) ${repository.searchSql(level, kind)}`,
        parameters,
      );
      const scans = membershipScans(explained.rows[0]["QUERY PLAN"][0].Plan);
      assert.ok(scans.length >= 1, `${level} ${kind} search checks generation membership`);
      assert.ok(scans.every(Boolean), `${level} ${kind} search never joins through generation membership`);
    }
  }

  const passages = await repository.lexicalSearch("passage", "supplier notice", scope);
  assert.equal(passages.length, 1);
  assert.match(passages[0].text, /thirty days notice/);
  const { documentId, sectionId } = passages[0];
  const scoped = { ...scope, documentIds: [documentId], sectionIds: [sectionId] };
  assert.deepEqual(
    (await repository.lexicalSearch("passage", "supplier notice", scoped)).map(hit => hit.passageId),
    [passages[0].passageId],
  );
  assert.deepEqual(
    (await repository.denseSearch("passage", queryVector, vectorizer, scoped)).map(hit => hit.passageId),
    [passages[0].passageId],
    "a section scope narrows vector search to that section's passages",
  );
  assert.deepEqual(
    (await repository.exactSearch(["thirty days"], scoped)).map(hit => hit.passageId),
    [passages[0].passageId],
  );
  assert.deepEqual(await repository.lexicalSearch("passage", "supplier notice", { ...scope, sectionIds: ["missing-section"] }), []);
  assert.equal(
    (await repository.passagesForSection(workspace.id, context.id, publication.generationId, sectionId, false)).length,
    1,
  );

  // A generation the documents were never published in sees none of them.
  const foreign = { ...scope, generationId: "generation-without-members" };
  assert.deepEqual(await repository.lexicalSearch("document", "supplier notice", foreign), []);
  assert.deepEqual(await repository.lexicalSearch("section", "supplier notice", foreign), []);
  assert.deepEqual(await repository.lexicalSearch("passage", "supplier notice", foreign), []);
  assert.deepEqual(await repository.denseSearch("passage", queryVector, vectorizer, foreign), []);
  assert.deepEqual(await repository.exactSearch(["thirty days"], foreign), []);
  assert.deepEqual(
    await repository.passagesForSection(workspace.id, context.id, foreign.generationId, sectionId, false),
    [],
  );
});

integration("workspace RAG V2 PostgreSQL exact-reference search narrows through the trigram index and matches source text only", async t => {
  const schema = `workspace_rag_v2_exact_${process.pid}`;
  process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA = schema;
  const { PostgresRagV2Repository } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts"
  );
  const { WorkspaceRagV2Manager } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts"
  );

  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-pg-exact-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  const rows = Array.from({ length: 400 }, (_, index) =>
    `| Party ${index}${index === 300 ? " ROW-9902" : ""} | ${index + 1} days |`);
  await writeFile(path.join(docs, "notice-table.md"), [
    "# Notice periods",
    "",
    "| Clause HDR-4471 | Notice |",
    "| --- | --- |",
    ...rows,
    "",
  ].join("\n"));
  const poolConfig = process.env.CORTEX_RAG_POSTGRES_URL
    ? { connectionString: process.env.CORTEX_RAG_POSTGRES_URL }
    : {
        host: process.env.CORTEX_RAG_POSTGRES_HOST || "127.0.0.1",
        port: Number(process.env.CORTEX_RAG_POSTGRES_PORT || 5432),
        database: process.env.CORTEX_RAG_POSTGRES_DB || "mem0",
        user: process.env.CORTEX_RAG_POSTGRES_USER || "mem0",
        password: process.env.CORTEX_RAG_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
      };
  const cleanup = new Pool(poolConfig);
  const repository = new PostgresRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, {
    info: { backend: "test", model: "test", dimensions: 32, signature: "test-pg-exact-v1" },
    async embed(texts) { return texts.map(text => embedding(text)); },
  });
  t.after(async () => {
    await manager.close().catch(() => undefined);
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(root, { recursive: true, force: true });
  });

  const workspace = { id: "postgres-exact-workspace", name: "Postgres", configDir: root };
  const context = { id: "exact", name: "Exact", paths: [docs] };
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const publication = await repository.activePublication(workspace.id, context.id);
  const scope = {
    workspaceId: workspace.id,
    contextId: context.id,
    generationId: publication.generationId,
    authorizationTokens: [`workspace:${workspace.id}`],
    limit: 20,
  };

  // The table is too large for one passage; its later chunks repeat the header
  // in `lexical_text` only, which is the column the trigram index covers.
  const repeated = await cleanup.query(`
    SELECT COUNT(*)::int AS count FROM "${schema}".passages
    WHERE lexical_text <> text AND lower(lexical_text) LIKE '%hdr-4471%'
  `);
  assert.ok(repeated.rows[0].count >= 1, "later table chunks repeat the header in their search text");

  // An exact-reference hit claims the reference is inside the cited byte range.
  const header = await repository.exactSearch(["HDR-4471"], scope);
  assert.equal(header.length, 1);
  assert.match(header[0].text, /^\| Clause HDR-4471 \|/);
  const row = await repository.exactSearch(["row-9902"], scope);
  assert.equal(row.length, 1);
  assert.match(row[0].text, /ROW-9902/);
  assert.doesNotMatch(row[0].text, /HDR-4471/);
  assert.equal((await repository.exactSearch(["HDR-4471", "row-9902"], scope)).length, 2);
  assert.deepEqual(await repository.exactSearch(["100%_"], scope), [], "LIKE wildcards in a reference are literal");

  // The trigram index is created on a best-effort basis (pg_trgm is optional).
  const trigramIndex = (await cleanup.query(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`"${schema}".idx_rag_v2_passages_text_trgm`],
  )).rows[0].present;
  if (!trigramIndex) {
    t.diagnostic("pg_trgm is unavailable; skipping the index-usage check");
    return;
  }
  // With every other way of reading passages priced out, the statement can
  // only avoid a sequential scan if its predicate matches the indexed
  // expression. On a real corpus that scan is the whole passages table.
  const planner = await cleanup.connect();
  try {
    await planner.query("SET enable_seqscan = off");
    await planner.query("SET enable_indexscan = off");
    await planner.query("SET enable_nestloop = off");
    const query = repository.exactSearchQuery(["HDR-4471", "row-9902"], scope);
    const explained = await planner.query(`EXPLAIN (FORMAT JSON) ${query.text}`, query.values);
    const nodes = [];
    const visit = node => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
    visit(explained.rows[0]["QUERY PLAN"][0].Plan);
    assert.ok(
      nodes.some(node => node["Index Name"] === "idx_rag_v2_passages_text_trgm"),
      "exact-reference search reads passages through the trigram index",
    );
    assert.equal(
      nodes.some(node => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "passages"),
      false,
      "exact-reference search does not scan every passage",
    );
  } finally {
    planner.release(true);
  }
});

integration("workspace RAG V2 enforces RLS through a separate non-owner application role", async t => {
  const ownerConfig = process.env.CORTEX_RAG_POSTGRES_URL
    ? { connectionString: process.env.CORTEX_RAG_POSTGRES_URL }
    : {
        host: process.env.CORTEX_RAG_POSTGRES_HOST || "127.0.0.1",
        port: Number(process.env.CORTEX_RAG_POSTGRES_PORT || 5432),
        database: process.env.CORTEX_RAG_POSTGRES_DB || "mem0",
        user: process.env.CORTEX_RAG_POSTGRES_USER || "mem0",
        password: process.env.CORTEX_RAG_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
      };
  const owner = new Pool(ownerConfig);
  const capability = await owner.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
  if (!capability.rows[0]?.rolsuper) {
    await owner.end();
    t.skip("integration database role cannot create the isolated application role");
    return;
  }
  const schema = `workspace_rag_v2_rls_${process.pid}`;
  const role = `rag_v2_app_${process.pid}`;
  const rolePassword = randomBytes(24).toString("hex");
  await owner.query(`DROP ROLE IF EXISTS "${role}"`);
  await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS`);

  const ownerUrl = ownerConfig.connectionString ?? [
    "postgresql://",
    encodeURIComponent(ownerConfig.user),
    ":",
    encodeURIComponent(ownerConfig.password),
    "@",
    ownerConfig.host,
    ":",
    ownerConfig.port,
    "/",
    encodeURIComponent(ownerConfig.database),
  ].join("");
  // Preserve the endpoint/database/options when the owner uses a connection URL,
  // including the random host port used by disposable test databases.
  const appConnection = new URL(ownerUrl);
  appConnection.username = role;
  appConnection.password = rolePassword;
  const appUrl = appConnection.toString();
  const previous = {
    url: process.env.CORTEX_RAG_POSTGRES_URL,
    migration: process.env.CORTEX_RAG_V2_MIGRATION_POSTGRES_URL,
    schema: process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA,
    required: process.env.CORTEX_RAG_V2_REQUIRE_SEPARATE_DB_ROLES,
  };
  process.env.CORTEX_RAG_POSTGRES_URL = appUrl;
  process.env.CORTEX_RAG_V2_MIGRATION_POSTGRES_URL = ownerUrl;
  process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA = schema;
  process.env.CORTEX_RAG_V2_REQUIRE_SEPARATE_DB_ROLES = "1";

  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-rls-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "private.md"), "# Private\n\nworkspace-scoped evidence");
  const { PostgresRagV2Repository } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts"
  );
  const { WorkspaceRagV2Manager } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts"
  );
  const repository = new PostgresRagV2Repository();
  const manager = new WorkspaceRagV2Manager(repository, {
    info: { backend: "test", model: "test", dimensions: 32, signature: "test-rls-v1" },
    async embed(texts) { return texts.map(text => embedding(text)); },
  });
  t.after(async () => {
    await manager.close().catch(() => undefined);
    await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner.query(`DROP ROLE IF EXISTS "${role}"`);
    await owner.end();
    await rm(root, { recursive: true, force: true });
    if (previous.url === undefined) delete process.env.CORTEX_RAG_POSTGRES_URL;
    else process.env.CORTEX_RAG_POSTGRES_URL = previous.url;
    if (previous.migration === undefined) delete process.env.CORTEX_RAG_V2_MIGRATION_POSTGRES_URL;
    else process.env.CORTEX_RAG_V2_MIGRATION_POSTGRES_URL = previous.migration;
    if (previous.schema === undefined) delete process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA;
    else process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA = previous.schema;
    if (previous.required === undefined) delete process.env.CORTEX_RAG_V2_REQUIRE_SEPARATE_DB_ROLES;
    else process.env.CORTEX_RAG_V2_REQUIRE_SEPARATE_DB_ROLES = previous.required;
  });

  const workspace = { id: "rls-workspace-a", name: "RLS A", configDir: root };
  const context = { id: "private", name: "Private", paths: [docs] };
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const result = await manager.search(workspace, context, "workspace scoped evidence", { limit: 3 });
  assert.ok(result.evidence.length >= 1);
  assert.equal(await repository.activePublication("rls-workspace-b", context.id), undefined);

  const app = new Pool({ connectionString: appUrl });
  const isolated = await app.query(`
    BEGIN;
    SELECT set_config('app.workspace_id', 'rls-workspace-b', TRUE);
    SELECT COUNT(*)::int AS count FROM "${schema}".documents;
    COMMIT;
  `);
  await app.end();
  assert.equal(isolated[2].rows[0].count, 0);
});
