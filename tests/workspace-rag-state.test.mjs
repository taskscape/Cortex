import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");

const model = "intfloat/multilingual-e5-base";
const dimensions = 768;
let holdNextDocumentEmbedding = false;
let documentEmbeddingStarted;
let releaseDocumentEmbedding;
let failNextDocumentEmbedding = false;

function vectorFor() {
  const vector = new Array(dimensions).fill(0);
  vector[0] = 1;
  return vector;
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true, cudaAvailable: true, device: "test-gpu", model, profile: "e5-asymmetric-v1",
      signature: "state-test", dimensions, maxTokens: 512, batchSize: 7, normalized: true,
      queryPrefix: "query: ", documentPrefix: "passage: ",
    }));
    return;
  }
  if (request.method === "POST" && request.url === "/embed") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (body.inputType === "document" && holdNextDocumentEmbedding) {
      holdNextDocumentEmbedding = false;
      documentEmbeddingStarted?.();
      await new Promise(resolve => { releaseDocumentEmbedding = resolve; });
    }
    if (body.inputType === "document" && failNextDocumentEmbedding) {
      failNextDocumentEmbedding = false;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "intentional embedding outage" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model, profile: "e5-asymmetric-v1", signature: "state-test", dimensions, inputType: body.inputType, embeddings: body.texts.map(vectorFor) }));
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("embedding test sidecar did not bind");
process.env.CORTEX_RAG_CUDA_EMBEDDING_URL = `http://127.0.0.1:${address.port}`;
process.env.CORTEX_RAG_STORAGE = "json";
delete process.env.CORTEX_RAG_DISABLE_CUDA;
const { plugin } = await import("../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts");

async function result(tool, value) {
  const events = [];
  for await (const event of tool.executor.execute(value, { signal: new AbortController().signal })) events.push(event);
  return events.find(event => event.type === "result")?.value;
}

/**
 * Validates that the RAG system correctly reports indexing states, error states,
 * and queues exactly one reindex scan after completing an indexing operation.
 *
 * This test ensures:
 * - RAG reports explicit indexing state (idle, indexing, error)
 * - Error states are properly captured and reported with progress counters
 * - Exactly one follow-up scan is queued after indexing completes
 * - The reindex operation handles errors gracefully while preserving progress
 *
 * Assumptions:
 * - The RAG plugin's workspace_rag tool supports actions: configure, status, reindex_now, cancel
 * - The test creates a temporary workspace and documents, then triggers indexing
 * - The test simulates embedding service failures to test error handling
 * - Success is indicated by the state machine transitions matching the expected pattern
 *   and the log containing exactly one scan_queued event
 */
test("MISSING-01/MISSING-03 RAG reports explicit indexing and error states and queues one reindex", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-state-"));
  t.after(async () => { await plugin.teardown?.(); await rm(root, { recursive: true, force: true }); });
  const workspace = path.join(root, "workspace");
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "matbot.yaml"), "plugins:\n  - ./packages/plugins/workspace-rag\n");
  const document = path.join(docs, "state.md");
  await writeFile(document, "# State\n\nfirst marker", "utf8");
  const tools = new Map();
  const registry = new Map();
  await plugin.setup({
    configPath: path.join(workspace, "matbot.yaml"), isSubAgent: () => false,
    async register(key, value) { registry.set(key, value); }, get(key) { return registry.get(key); },
    tools: { register(tool) { tools.set(tool.name, tool); } }, hooks: { register() {} },
  });
  const tool = tools.get("workspace_rag");
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.action.enum.includes("cancel"), false, "RAG must not advertise unsupported cancellation");
  const initial = await result(tool, { action: "configure", contextName: "State", paths: [docs] });
  assert.equal(initial.status.state, "idle");
  assert.equal(initial.status.processedFiles, initial.status.totalFiles);

  await writeFile(document, "# State\n\nsecond marker", "utf8");
  holdNextDocumentEmbedding = true;
  const gated = new Promise(resolve => { documentEmbeddingStarted = resolve; });
  const firstReindex = result(tool, { action: "reindex_now" });
  await gated;
  const indexing = await result(tool, { action: "status" });
  assert.equal(indexing.state, "indexing");
  assert.ok(indexing.processedFiles <= indexing.totalFiles);
  const secondReindex = result(tool, { action: "reindex_now" });
  releaseDocumentEmbedding?.();
  await Promise.all([firstReindex, secondReindex]);
  const terminal = await result(tool, { action: "status" });
  assert.equal(terminal.state, "idle");
  assert.equal(terminal.processedFiles, terminal.totalFiles);
  const log = await readFile(path.join(workspace, ".data", "workspace-rag", "ingestion.log"), "utf8");
  assert.equal((log.match(/"event":"scan_queued"/g) ?? []).length, 1, "exactly one follow-up scan is queued");

  await writeFile(document, "# State\n\nthird marker", "utf8");
  failNextDocumentEmbedding = true;
  await result(tool, { action: "reindex_now" });
  const failed = await result(tool, { action: "status" });
  assert.equal(failed.state, "error");
  assert.ok(failed.totalFiles >= 1);
  assert.ok(failed.processedFiles >= 1, "failure retains useful progress counters");
});

test.after(() => new Promise(resolve => server.close(resolve)));
