import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { OpenSearchHybridSearchBackend } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/search-backend.ts"
);
const { evaluateOpenSearchAdoption } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/search-backend.ts"
);
const { RagV2ColbertAdapter } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/late-interaction.ts"
);

test("workspace RAG V2 OpenSearch adapter remains an explicit derivative backend", async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url.endsWith("/_count")) {
      response.end(JSON.stringify({ count: 2 }));
      return;
    }
    if (request.url.endsWith("/_search")) {
      response.end(JSON.stringify({
        hits: {
          hits: [{
            _id: "passage-1",
            _score: 4.2,
            _source: {
              documentId: "document-1",
              documentVersionId: "version-1",
              sectionId: "section-1",
              passageId: "passage-1",
              path: "contract.md",
              title: "Contract",
              headingPath: ["Termination"],
              startByte: 10,
              endByte: 20,
              startLine: 2,
              endLine: 3,
              language: "en",
              text: "termination evidence",
              contentSha256: "a".repeat(64),
            },
          }],
        },
      }));
      return;
    }
    response.end(JSON.stringify({ acknowledged: true, errors: false }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const backend = new OpenSearchHybridSearchBackend({
    baseUrl: `http://127.0.0.1:${address.port}`,
    indexPrefix: "cortex-test",
  });
  const generationId = "generation-1";
  await backend.indexGeneration({
    generationId,
    level: "passage",
    records: [{
      id: "passage-1",
      documentId: "document-1",
      documentVersionId: "version-1",
      sectionId: "section-1",
      passageId: "passage-1",
      workspaceId: "workspace-1",
      contextId: "context-1",
      aclTokens: ["workspace:workspace-1"],
      path: "contract.md",
      title: "Contract",
      headingPath: ["Termination"],
      language: "en",
      text: "termination evidence",
      contentSha256: "a".repeat(64),
      embedding: [1, 0, 0],
    }],
  });
  const validation = await backend.validateGeneration(generationId);
  assert.equal(validation.valid, true);
  assert.equal(validation.records, 6);
  await backend.publishGeneration(generationId);

  const plan = {
    originalQuery: "termination",
    queryLanguage: "en",
    answerLanguage: "en",
    intent: "fact_lookup",
    exactReferences: [],
    quotedPhrases: [],
    entities: [],
    documentTypes: [],
    jurisdictions: [],
    corpusLanguages: ["en"],
    lexicalVariants: [],
    embeddingInstruction: "retrieve",
    authorization: {
      workspaceId: "workspace-1",
      contextId: "context-1",
      principalId: "local-user",
      groupIds: [],
    },
  };
  const scope = {
    workspaceId: "workspace-1",
    contextId: "context-1",
    generationId,
    authorizationTokens: ["workspace:workspace-1"],
    limit: 5,
  };
  const hits = await backend.lexicalSearch(plan, scope);
  assert.equal(hits[0].passageId, "passage-1");
  const searchRequest = requests.find(value => value.url.endsWith("/_search"));
  assert.match(searchRequest.body, /workspaceId/);
  assert.match(searchRequest.body, /aclTokens/);
  assert.ok(requests.some(value => value.url === "/_aliases"));
});

test("OpenSearch promotion requires a measured PostgreSQL trigger and every safety gate", () => {
  const baseline = {
    postgres: {
      lexicalNdcg: 0.72,
      recallAtK: 0.81,
      p95CandidateLatencyMs: 420,
      controlPlaneP95LatencyMs: 180,
      indexBytes: 12_000,
      authorizationLeakageRate: 0,
      citationCorrectness: 1,
    },
    opensearch: {
      lexicalNdcg: 0.88,
      recallAtK: 0.92,
      p95CandidateLatencyMs: 90,
      controlPlaneP95LatencyMs: 100,
      indexBytes: 10_000,
      authorizationLeakageRate: 0,
      citationCorrectness: 1,
    },
    targets: {
      lexicalNdcg: 0.82,
      recallAtK: 0.9,
      p95CandidateLatencyMs: 200,
      maxControlPlaneRegressionMs: 50,
      maxIndexBytes: 20_000,
    },
    nativeHybridBenefit: 0.08,
    minimumMaterialBenefit: 0.05,
    operationalApproval: true,
  };
  const promoted = evaluateOpenSearchAdoption(baseline);
  assert.equal(promoted.recommendation, "promote_opensearch");
  assert.ok(promoted.postgresTriggers.length >= 2);
  assert.deepEqual(promoted.failedSafetyGates, []);

  const unsafe = evaluateOpenSearchAdoption({
    ...baseline,
    opensearch: { ...baseline.opensearch, authorizationLeakageRate: 0.001 },
  });
  assert.equal(unsafe.recommendation, "keep_postgres");
  assert.match(unsafe.failedSafetyGates.join(" "), /authorization leakage/i);

  const noTrigger = evaluateOpenSearchAdoption({
    ...baseline,
    postgres: { ...baseline.opensearch },
    nativeHybridBenefit: 0,
  });
  assert.equal(noTrigger.recommendation, "keep_postgres");
  assert.deepEqual(noTrigger.postgresTriggers, []);
});

test("measurement-gated ColBERT adapter preserves scope and returns manifest-bearing candidates", async t => {
  let received;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      model: "colbert-test",
      hits: [{
        documentId: "document-1",
        documentVersionId: "version-1",
        sectionId: "section-1",
        passageId: "passage-1",
        path: "contract.md",
        title: "Contract",
        headingPath: ["Clause"],
        startByte: 10,
        endByte: 30,
        startLine: 2,
        endLine: 3,
        language: "en",
        text: "late interaction evidence",
        contentSha256: "b".repeat(64),
        score: 0.91,
      }],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const adapter = new RagV2ColbertAdapter(`http://127.0.0.1:${address.port}`);
  const result = await adapter.search("late interaction", {
    workspaceId: "workspace-1",
    contextId: "context-1",
    generationId: "generation-1",
    authorizationTokens: ["workspace:workspace-1"],
    documentIds: ["document-1"],
    limit: 5,
  });
  assert.equal(result.model, "colbert-test");
  assert.equal(result.hits[0].retriever, "late_interaction");
  assert.equal(received.workspaceId, "workspace-1");
  assert.deepEqual(received.authorizationTokens, ["workspace:workspace-1"]);
});
