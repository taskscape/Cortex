import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const model = "intfloat/multilingual-e5-base";
const profile = "e5-asymmetric-v1";
const signature = "e5-test-signature";
const dimensions = 768;
const requests = [];

function vectorFor(text) {
  const vector = new Array(dimensions).fill(0);
  vector[0] = 1;
  vector[1] = text.toLowerCase().includes("aurora") ? 1 : 0;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map(value => value / norm);
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      cudaAvailable: true,
      device: "test-gpu",
      model,
      profile,
      signature,
      dimensions,
      maxTokens: 512,
      normalized: true,
      queryPrefix: "query: ",
      documentPrefix: "passage: ",
    }));
    return;
  }
  if (request.method === "POST" && request.url === "/embed") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model,
      profile,
      signature,
      dimensions,
      inputType: body.inputType,
      embeddings: body.texts.map(vectorFor),
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Mock embedding server did not bind to a TCP port.");

process.env.CORTEX_RAG_CUDA_EMBEDDING_URL = `http://127.0.0.1:${address.port}`;
process.env.CORTEX_RAG_STORAGE = "json";
delete process.env.CORTEX_RAG_DISABLE_CUDA;

const { plugin } = await import("../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts");

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-workspace-rag-e5-"));
  try {
    const workspaceDir = path.join(root, "workspace");
    const docsDir = path.join(root, "docs");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    const configPath = path.join(workspaceDir, "matbot.yaml");
    await writeFile(configPath, "plugins:\n  - ./packages/plugins/workspace-rag\n", "utf8");
    await writeFile(
      path.join(docsDir, "aurora.md"),
      "# Aurora\n\nThe Aurora multilingual retrieval marker is cobalt.",
      "utf8",
    );

    const tools = new Map();
    const servicesByKey = new Map();
    const services = {
      configPath,
      isSubAgent: () => false,
      async register(key, value) {
        servicesByKey.set(key, value);
      },
      get(key) {
        return servicesByKey.get(key);
      },
      tools: {
        register(tool) {
          tools.set(tool.name, tool);
        },
      },
      hooks: {
        register() {},
      },
    };

    await plugin.setup(services);
    const tool = tools.get("workspace_rag");
    assert.ok(tool);
    const toolCtx = { signal: new AbortController().signal };

    const configureEvents = [];
    for await (const event of tool.executor.execute({
      action: "configure",
      contextName: "E5 Probe",
      paths: [docsDir],
    }, toolCtx)) {
      configureEvents.push(event);
    }
    const status = configureEvents.find(event => event.type === "result")?.value.status;
    assert.equal(status.embeddingBackend, "cuda-http");
    assert.equal(status.embeddingModel, model);
    assert.equal(status.embeddingDimensions, dimensions);
    assert.equal(status.embeddingProfile, profile);
    assert.equal(status.embeddingSignature, signature);
    assert.equal(status.embeddingMaxTokens, 512);

    const searchEvents = [];
    for await (const event of tool.executor.execute({
      action: "search",
      query: "Jaki kolor ma znacznik Aurora?",
      limit: 1,
    }, toolCtx)) {
      searchEvents.push(event);
    }
    const search = searchEvents.find(event => event.type === "result")?.value;
    assert.equal(search.hits.length, 1);
    assert.match(search.hits[0].text, /cobalt/);

    assert.ok(requests.some(request => request.inputType === "document"));
    assert.ok(requests.some(request => request.inputType === "query"));
    assert.ok(requests.filter(request => request.inputType === "document").every(request => request.texts.length > 0));

    const index = JSON.parse(await readFile(path.join(workspaceDir, ".data", "workspace-rag", "index.json"), "utf8"));
    assert.ok(index.documents.length > 0);
    assert.equal(index.documents[0].vectorizer.model, model);
    assert.equal(index.documents[0].vectorizer.dimensions, dimensions);
    assert.equal(index.documents[0].vectorizer.signature, signature);

    await plugin.teardown?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log("workspace-rag E5 embedding contract passes");
} finally {
  await plugin.teardown?.();
  await new Promise(resolve => server.close(resolve));
}
