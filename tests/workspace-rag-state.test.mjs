import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");

const model = "intfloat/multilingual-e5-base";
const dimensions = 768;
let holdNextChangedEmbedding = false;
let changedEmbeddingStarted;
let releaseChangedEmbedding;
const documentEmbeddingTexts = [];

function hasUnpairedSurrogate(text) {
  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return true;
      index++;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

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
    if (body.inputType === "document") documentEmbeddingTexts.push(...body.texts);
    if (
      body.inputType === "document"
      && holdNextChangedEmbedding
      && body.texts.some(text => text.includes("second marker"))
    ) {
      holdNextChangedEmbedding = false;
      changedEmbeddingStarted?.();
      await new Promise(resolve => { releaseChangedEmbedding = resolve; });
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model, profile: "e5-asymmetric-v1", signature: "state-test", dimensions,
      inputType: body.inputType, embeddings: body.texts.map(vectorFor),
    }));
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("embedding test sidecar did not bind");
process.env.CORTEX_RAG_CUDA_EMBEDDING_URL = `http://127.0.0.1:${address.port}`;
process.env.CORTEX_RAG_V2_MODE = "primary";
process.env.CORTEX_RAG_V2_STORAGE = "memory";
delete process.env.CORTEX_RAG_DISABLE_CUDA;

const { plugin } = await import("../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts");

async function result(tool, value) {
  const events = [];
  for await (const event of tool.executor.execute(value, { signal: new AbortController().signal })) events.push(event);
  const error = events.find(event => event.type === "error");
  if (error) throw new Error(error.message);
  return events.find(event => event.type === "result")?.value;
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`condition was not met within ${timeoutMs} ms`);
}

test("MISSING-01/MISSING-03 V2 RAG reports reconciliation, queue, and safe failure states", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-state-"));
  t.after(async () => {
    await plugin.teardown?.();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  const docs = path.join(root, "docs");
  const offline = path.join(root, "docs-offline");
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

  const configured = await result(tool, { action: "configure", contextName: "State", paths: [docs] });
  assert.equal(configured.status.mode, "primary");
  const initial = await result(tool, { action: "ingestion_wait" });
  assert.equal(initial.activeState, "active_hybrid_complete");
  assert.equal(initial.job.discoveryComplete, true);
  assert.equal(initial.job.processedFiles, initial.job.totalFiles);
  assert.equal(initial.watcher.state, "active");
  assert.ok(initial.lastSuccessfulReconcileAt);

  const unicodeBoundaryDocument = `# Unicode\n\n${"a".repeat(1788)}👉 tail marker`;
  assert.equal(unicodeBoundaryDocument.charCodeAt(1799), 0xD83D);
  const unicodeEmbeddingStart = documentEmbeddingTexts.length;
  await writeFile(path.join(docs, "unicode-boundary.md"), unicodeBoundaryDocument, "utf8");
  const unicodeStatus = await result(tool, { action: "reindex_now" });
  assert.equal(unicodeStatus.job.state, "active_hybrid_complete");
  const unicodeInputs = documentEmbeddingTexts.slice(unicodeEmbeddingStart);
  assert.ok(unicodeInputs.some(text => text.includes("👉")));
  assert.ok(unicodeInputs.every(text => !hasUnpairedSurrogate(text)));

  await writeFile(document, "# State\n\nsecond marker", "utf8");
  holdNextChangedEmbedding = true;
  const gated = new Promise(resolve => { changedEmbeddingStarted = resolve; });
  const firstReindex = result(tool, { action: "reindex_now" });
  await gated;
  const active = await result(tool, { action: "status" });
  assert.ok(!active.job.state.startsWith("active_"));
  assert.equal(active.watcher.reconcileQueued, false);

  const secondReindex = result(tool, { action: "reindex_now" });
  await waitUntil(async () => (await result(tool, { action: "status" })).watcher.reconcileQueued);
  releaseChangedEmbedding?.();
  const [firstTerminal, secondTerminal] = await Promise.all([firstReindex, secondReindex]);
  assert.equal(firstTerminal.activeGenerationId, secondTerminal.activeGenerationId);
  assert.equal(firstTerminal.job.state, "active_hybrid_complete");
  assert.equal(firstTerminal.job.trigger, "manual");
  assert.equal(firstTerminal.watcher.pendingChanges, false);

  const activeGenerationId = firstTerminal.activeGenerationId;
  await rename(docs, offline);
  const failed = await result(tool, { action: "reindex_now" });
  assert.equal(failed.job.state, "retryable_failure");
  assert.equal(failed.job.discoveryComplete, false);
  assert.equal(failed.activeGenerationId, activeGenerationId, "an incomplete discovery cannot delete the active corpus");
  assert.match(failed.watcher.lastError, /could not completely discover/i);

  await rename(offline, docs);
  const recovered = await result(tool, { action: "ingestion_retry" });
  assert.equal(recovered.job.state, "active_hybrid_complete");
  assert.equal(recovered.job.trigger, "retry");
  assert.equal(recovered.job.discoveryComplete, true);
  assert.equal(recovered.watcher.lastError, undefined);
});

test.after(() => new Promise(resolve => server.close(resolve)));
