import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
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

function embedding(text, dimensions = 24) {
  const vector = new Array(dimensions).fill(0);
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const digest = createHash("sha256").update(token).digest();
    vector[digest.readUInt16BE(0) % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

test("workspace RAG V2 multilingual reranker reorders a bounded fused candidate set", async t => {
  let rerankedTexts = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/rerank") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    rerankedTexts = body.texts;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "test-multilingual-reranker",
      scores: body.texts.map(text => text.includes("CORRECT-RERANK") ? 10 : 0),
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.CORTEX_RAG_V2_RERANKER_URL = `http://127.0.0.1:${address.port}`;
  t.after(() => { delete process.env.CORTEX_RAG_V2_RERANKER_URL; });

  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-reranker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "a.md"), "# Notice\n\nNotice is discussed without an answer.");
  await writeFile(path.join(docs, "b.md"), "# Notice\n\nCORRECT-RERANK: Notice is exactly forty-five days.");

  const manager = new WorkspaceRagV2Manager(new MemoryRagV2Repository(), {
    info: { backend: "test", model: "test", dimensions: 24, signature: "rerank-test" },
    async embed(texts) { return texts.map(text => embedding(text)); },
  });
  t.after(() => manager.close());
  const workspace = { id: "rerank-workspace", name: "Rerank", configDir: root };
  const context = { id: "docs", name: "Docs", paths: [docs] };
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const result = await manager.search(workspace, context, "What is the notice period?", { limit: 2 });

  assert.ok(rerankedTexts.length <= 100);
  assert.match(result.evidence[0].text, /CORRECT-RERANK/);
  assert.equal(result.degraded.length, 0);
});

test("workspace RAG V2 keeps fused results when the reranker is unavailable", async t => {
  process.env.CORTEX_RAG_V2_RERANKER_URL = "http://127.0.0.1:1";
  t.after(() => { delete process.env.CORTEX_RAG_V2_RERANKER_URL; });
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-rerank-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "fallback.md"), "# Fallback\n\nFallback evidence remains available.");
  const manager = new WorkspaceRagV2Manager(new MemoryRagV2Repository(), {
    info: { backend: "test", model: "test", dimensions: 24, signature: "fallback-test" },
    async embed(texts) { return texts.map(text => embedding(text)); },
  });
  t.after(() => manager.close());
  const workspace = { id: "fallback-workspace", name: "Fallback", configDir: root };
  const context = { id: "docs", name: "Docs", paths: [docs] };
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  const result = await manager.search(workspace, context, "fallback evidence", { limit: 2 });
  assert.ok(result.evidence.length >= 1);
  assert.ok(result.degraded.some(value => value.includes("reranker unavailable")));
});

