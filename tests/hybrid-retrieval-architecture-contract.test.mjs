import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const documentPath = path.resolve("docs/hybrid-retrieval-architecture.md");

test("hybrid retrieval migration plan has an executable completed-activity contract", async () => {
  const document = await readFile(documentPath, "utf8");
  for (let phase = 0; phase <= 5; phase++) {
    assert.match(document, new RegExp(`### Phase ${phase}:`), `Phase ${phase} is documented`);
  }
  const migrationPlan = document.slice(document.indexOf("## Migration Plan"));
  assert.doesNotMatch(
    migrationPlan,
    /^- \[ \]/gmu,
    "no migration activity may be marked complete while retaining an unchecked item",
  );
  const completed = migrationPlan.match(/^- \[x\]/gmu) ?? [];
  assert.ok(completed.length >= 35, `expected at least 35 explicit completed activities, found ${completed.length}`);

  for (const decision of [
    "document → section → passage",
    "Streaming",
    "immutable",
    "PostgreSQL",
    "pgvector",
    "Reciprocal Rank Fusion",
    "multilingual",
    "Lazy",
    "OpenSearch",
    "filesystem watcher",
  ]) {
    assert.match(document, new RegExp(decision, "iu"), `key decision ${decision} remains explicit`);
  }
});

test("hybrid retrieval implementation evidence files exist", async () => {
  for (const relative of [
    "local-agent/matbot/packages/plugins/workspace-rag/src/v2/census.ts",
    "local-agent/matbot/packages/plugins/workspace-rag/src/v2/object-store.ts",
    "local-agent/matbot/packages/plugins/workspace-rag/src/v2/parser.ts",
    "local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts",
    "local-agent/matbot/packages/plugins/workspace-rag/src/v2/retrieval.ts",
    "local-agent/matbot/packages/plugins/workspace-rag/src/v2/late-interaction.ts",
    "local-agent/matbot/packages/plugins/workspace-rag/src/v2/search-backend.ts",
    "local-agent/docker/mem0/Dockerfile.workspace-rag-reranker",
    "tests/workspace-rag-v2-parser.test.mjs",
    "tests/workspace-rag-v2-manager.test.mjs",
    "tests/workspace-rag-v2-postgres.integration.test.mjs",
    "tests/workspace-rag-v2-opensearch-adapter.test.mjs",
    "tests/workspace-rag-reranker-app.test.mjs",
  ]) {
    await access(path.resolve(relative));
  }
});
