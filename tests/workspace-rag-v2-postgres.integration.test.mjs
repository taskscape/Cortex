import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  assert.equal(
    (await repository.listFingerprints(workspace.id, context.id))[0].summarySignature,
    "test-pg-summary-v1",
  );
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
  await reachedFiles;
  await interruptedManager.cancel(workspace.id, context.id);
  const interruptedStatus = await interruptedManager.status("primary", workspace, context);
  assert.equal(interruptedStatus.job.discoveryComplete, false);
  assert.ok(interruptedStatus.job.publishedCheckpoints >= 1, "a checkpoint publishes mid-scan");
  assert.equal(
    interruptedStatus.activeGenerationId,
    interruptedJob.generationId,
    "the interrupted scan leaves a published generation behind",
  );
  assert.ok(interruptedStatus.indexedDocuments >= 2);
  const held = await repository.listFingerprints(
    workspace.id, context.id, interruptedJob.generationId,
  );
  assert.equal(
    held.length,
    interruptedStatus.indexedDocuments,
    "generation-scoped fingerprints match the documents the generation holds",
  );
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
  const appUrl = [
    "postgresql://",
    encodeURIComponent(role),
    ":",
    encodeURIComponent(rolePassword),
    "@",
    ownerConfig.host || "127.0.0.1",
    ":",
    ownerConfig.port || 5432,
    "/",
    encodeURIComponent(ownerConfig.database || "mem0"),
  ].join("");
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
