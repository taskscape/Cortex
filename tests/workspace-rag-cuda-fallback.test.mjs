import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startHttpSidecar } from "./helpers/http-sidecar.mjs";

await import("../local-agent/matbot/apps/cli/register.js");
const { plugin } = await import("../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts");

const CUDA_ENV = [
  "CORTEX_RAG_CUDA_EMBEDDING_URL",
  "CORTEX_RAG_EMBEDDING_URL",
  "CORTEX_RAG_DISABLE_CUDA",
  "CORTEX_RAG_V2_MODE",
  "CORTEX_RAG_V2_STORAGE",
  "CORTEX_WORKSPACES_FILE",
];

function saveEnvironment() {
  return new Map(CUDA_ENV.map(name => [name, process.env[name]]));
}

function restoreEnvironment(saved) {
  for (const name of CUDA_ENV) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function invoke(tool, input) {
  const events = [];
  for await (const event of tool.executor.execute(input, { signal: new AbortController().signal })) events.push(event);
  const result = events.find(event => event.type === "result");
  assert.ok(result, `expected workspace_rag result, got ${JSON.stringify(events)}`);
  return result.value;
}

async function statusForHealth(healthResponse) {
  const sidecar = await startHttpSidecar({
    "GET /health": () => healthResponse,
  });
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-cuda-fallback-"));
  const saved = saveEnvironment();
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "matbot.yaml"), "plugins:\n  - ./packages/plugins/workspace-rag\n", "utf8");

    process.env.CORTEX_RAG_CUDA_EMBEDDING_URL = sidecar.url;
    process.env.CORTEX_RAG_V2_MODE = "primary";
    process.env.CORTEX_RAG_V2_STORAGE = "memory";
    delete process.env.CORTEX_RAG_EMBEDDING_URL;
    delete process.env.CORTEX_RAG_DISABLE_CUDA;
    delete process.env.CORTEX_WORKSPACES_FILE;

    const tools = new Map();
    const registrations = new Map();
    await plugin.setup({
      configPath: path.join(workspace, "matbot.yaml"),
      isSubAgent: () => false,
      async register(key, value) { registrations.set(key, value); },
      get(key) { return registrations.get(key); },
      tools: { register(tool) { tools.set(tool.name, tool); } },
      hooks: { register() {} },
    });
    const tool = tools.get("workspace_rag");
    assert.ok(tool, "workspace-rag should register its tool after a failed CUDA probe");
    const status = await invoke(tool, { action: "status" });
    // The manager starts one background scan at setup.  Join it before removing
    // this disposable workspace so its diagnostic log cannot race test cleanup.
    await invoke(tool, { action: "reindex_now" });
    return { status, sidecarUrl: sidecar.url };
  } finally {
    await plugin.teardown?.();
    restoreEnvironment(saved);
    await Promise.all([sidecar.close(), rm(root, { recursive: true, force: true })]);
  }
}

test("CUDA launch failures retain the sidecar diagnostic and safely use CPU embeddings", async () => {
  const unavailable = await statusForHealth({
    body: {
      ok: true,
      cudaAvailable: false,
      device: "cpu",
      model: "sentence-transformers/all-MiniLM-L6-v2",
      profile: "plain-v1",
      signature: "test-minilm-signature",
      dimensions: 384,
      batchSize: 8,
      normalized: true,
      queryPrefix: "",
      documentPrefix: "",
      message: "CUDA is not available to PyTorch.",
    },
  });
  assert.equal(unavailable.status.embeddingBackend, "hash-cpu");
  assert.equal(unavailable.status.accelerator, "cpu");
  assert.equal(unavailable.status.cudaAvailable, false);
  assert.equal(unavailable.status.cudaServiceUrl, unavailable.sidecarUrl);
  assert.match(unavailable.status.accelerationMessage, /CUDA is not available to PyTorch/);

  const invalidContract = await statusForHealth({
    body: {
      ok: true,
      cudaAvailable: true,
      device: "test-gpu",
      model: "intfloat/multilingual-e5-base",
      profile: "e5-asymmetric-v1",
      signature: "broken-e5-signature",
      dimensions: 768,
      batchSize: 8,
      normalized: true,
      queryPrefix: "query: ",
      documentPrefix: "",
    },
  });
  assert.equal(invalidContract.status.embeddingBackend, "hash-cpu");
  assert.equal(invalidContract.status.cudaAvailable, false);
  assert.match(invalidContract.status.accelerationMessage, /E5 embedding service must report/);

  const httpFailure = await statusForHealth({ status: 503, body: { detail: "CUDA worker unavailable" } });
  assert.equal(httpFailure.status.embeddingBackend, "hash-cpu");
  assert.equal(httpFailure.status.cudaAvailable, false);
  assert.match(httpFailure.status.accelerationMessage, /Embedding service returned HTTP 503/);
});
