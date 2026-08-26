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

const HEALTH = {
  ok: true,
  cudaAvailable: true,
  device: "test-gpu",
  model: "sentence-transformers/all-MiniLM-L6-v2",
  profile: "plain-v1",
  signature: "embed-contract-signature",
  dimensions: 384,
  batchSize: 8,
  normalized: true,
  queryPrefix: "",
  documentPrefix: "",
};

async function ingestWithSidecar(embedHandler) {
  const sidecar = await startHttpSidecar({
    "GET /health": () => ({ body: HEALTH }),
    "POST /embed": embedHandler,
  });
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-embed-contract-"));
  const saved = saveEnvironment();
  try {
    const workspace = path.join(root, "workspace");
    const docs = path.join(root, "docs");
    await mkdir(workspace, { recursive: true });
    await mkdir(docs, { recursive: true });
    await writeFile(path.join(workspace, "matbot.yaml"), "plugins:\n  - ./packages/plugins/workspace-rag\n", "utf8");
    await writeFile(path.join(docs, "contract.md"), "# Contract\n\nRESPONSE-CONTRACT-EVIDENCE", "utf8");

    process.env.CORTEX_RAG_CUDA_EMBEDDING_URL = sidecar.url;
    process.env.CORTEX_RAG_V2_MODE = "primary";
    process.env.CORTEX_RAG_V2_STORAGE = "memory";
    delete process.env.CORTEX_RAG_EMBEDDING_URL;
    delete process.env.CORTEX_RAG_DISABLE_CUDA;

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
    assert.ok(tool, "workspace-rag should register its tool");
    await invoke(tool, { action: "configure", contextName: "Contract", paths: [docs] });
    const status = await invoke(tool, { action: "reindex_now" });
    return { status, sidecar };
  } finally {
    await plugin.teardown?.();
    restoreEnvironment(saved);
    await Promise.all([sidecar.close(), rm(root, { recursive: true, force: true })]);
  }
}

test("MISSING-02 embedding responses are validated against the launch contract, not the request", async () => {
  // An honest sidecar yields a hybrid index: every computed vector is stored.
  const honest = await ingestWithSidecar(({ raw }) => {
    const body = JSON.parse(raw);
    return {
      body: {
        model: HEALTH.model,
        profile: HEALTH.profile,
        signature: HEALTH.signature,
        dimensions: HEALTH.dimensions,
        inputType: body.inputType,
        embeddings: body.texts.map(() => new Array(HEALTH.dimensions).fill(0.5)),
      },
    };
  });
  assert.equal(honest.status.activeState, "active_hybrid_complete");
  assert.ok(honest.status.job.readyEmbeddings > 0, "honest responses are stored");

  // A sidecar whose /embed payload lies about the model must have its vectors
  // rejected even though the HTTP call succeeded.
  const liar = await ingestWithSidecar(({ raw }) => {
    const body = JSON.parse(raw);
    return {
      body: {
        model: "impostor-model",
        profile: HEALTH.profile,
        signature: HEALTH.signature,
        dimensions: HEALTH.dimensions,
        inputType: body.inputType,
        embeddings: body.texts.map(() => new Array(HEALTH.dimensions).fill(0.5)),
      },
    };
  });
  assert.ok(liar.sidecar.requests.some(request => request.key === "POST /embed"), "the sidecar was consulted");
  assert.equal(liar.status.activeState, "active_lexical", "mismatched vectors are never indexed");
  assert.equal(liar.status.job.readyEmbeddings, 0);
});
