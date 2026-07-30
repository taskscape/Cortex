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
const documentEmbeddingRequestSizes = [];
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
    if (body.inputType === "document") {
      documentEmbeddingRequestSizes.push(body.texts.length);
      documentEmbeddingTexts.push(...body.texts);
    }
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

async function queuedScanCount(workspace) {
  const logPath = path.join(workspace, ".data", "workspace-rag", "ingestion.log");
  const log = await readFile(logPath, "utf8");
  return (log.match(/"event":"scan_queued"/g) ?? []).length;
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
  for (let index = 1; index < 32; index++) {
    await writeFile(path.join(docs, `state-${index}.md`), `# State ${index}\n\nmarker ${index}`, "utf8");
  }
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
  assert.ok(
    documentEmbeddingRequestSizes.includes(32),
    `expected one cross-file embedding batch of 32 chunks, saw ${documentEmbeddingRequestSizes.join(", ")}`,
  );

  const unicodeBoundaryDocument = `# Unicode\n\n${"a".repeat(1788)}👉 tail marker`;
  assert.equal(
    unicodeBoundaryDocument.charCodeAt(1799),
    0xD83D,
    "the regression fixture must place the emoji's high surrogate at the old chunk boundary",
  );
  const unicodeEmbeddingStart = documentEmbeddingTexts.length;
  await writeFile(path.join(docs, "unicode-boundary.md"), unicodeBoundaryDocument, "utf8");
  await result(tool, { action: "reindex_now" });
  const unicodeStatus = await result(tool, { action: "status" });
  assert.equal(unicodeStatus.state, "idle");
  const unicodeEmbeddingTexts = documentEmbeddingTexts.slice(unicodeEmbeddingStart);
  assert.ok(
    unicodeEmbeddingTexts.some(text => text.includes("👉")),
    "the emoji must remain intact in one embedding chunk",
  );
  assert.ok(
    unicodeEmbeddingTexts.every(text => !hasUnpairedSurrogate(text)),
    "embedding chunks must not contain unpaired UTF-16 surrogates",
  );

  // `start()` intentionally begins a background scan without awaiting it. If
  // it overlaps this first configure call it may legitimately have consumed a
  // queued scan already; measure the two explicit reindexes relative to that
  // settled baseline rather than treating startup work as their follow-up.
  const queuedBeforeExplicitReindex = await queuedScanCount(workspace);

  await writeFile(document, "# State\n\nsecond marker", "utf8");
  holdNextDocumentEmbedding = true;
  const gated = new Promise(resolve => { documentEmbeddingStarted = resolve; });
  const firstReindex = result(tool, { action: "reindex_now" });
  await gated;
  const indexing = await result(tool, { action: "status" });
  assert.equal(indexing.state, "indexing");
  assert.equal(indexing.processedFiles, 0, "progress advances only after the held embedding batch completes");
  const secondReindex = result(tool, { action: "reindex_now" });
  releaseDocumentEmbedding?.();
  await Promise.all([firstReindex, secondReindex]);
  const terminal = await result(tool, { action: "status" });
  assert.equal(terminal.state, "idle");
  assert.equal(terminal.processedFiles, terminal.totalFiles);
  assert.equal(
    (await queuedScanCount(workspace)) - queuedBeforeExplicitReindex,
    1,
    "exactly one follow-up scan is queued for the two explicit overlapping reindex requests",
  );

  await writeFile(document, "# State\n\nthird marker", "utf8");
  failNextDocumentEmbedding = true;
  await result(tool, { action: "reindex_now" });
  const failed = await result(tool, { action: "status" });
  assert.equal(failed.state, "error");
  assert.ok(failed.totalFiles >= 1);
  assert.equal(failed.processedFiles, 0, "a failed embedding batch is not reported as processed");
});

test.after(() => new Promise(resolve => server.close(resolve)));
