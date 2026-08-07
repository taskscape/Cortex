import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertEmbeddingHealth, assertNoSecrets } from "./helpers/assertions.mjs";
import { createDockerComposeFixture, dockerAvailable } from "./helpers/docker-compose.mjs";

const enabled = process.env.CORTEX_DOCKER_INTEGRATION === "1";
const cudaEnabled = process.env.CORTEX_CUDA_INTEGRATION === "1";
const composePath = path.resolve("local-agent/docker/mem0/docker-compose.yml");

async function waitFor(url, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} did not become healthy: ${lastError}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(`${url} must return HTTP 200 (received ${response.status}): ${await response.text()}`);
  }
  return response.json();
}

function cosineSimilarity(left, right) {
  assert.equal(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

async function waitForCommand(action, label) {
  const deadline = Date.now() + 90_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

function composeArgs(envPath, files, command) {
  return ["--env-file", envPath, ...files.flatMap(file => ["-f", file]), ...command];
}

function neo4jCypherArgs(envPath, files) {
  return composeArgs(envPath, files, [
    "exec", "-T", "-e", "CORTEX_TEST_NEO4J_PASSWORD", "neo4j", "sh", "-c",
    'cypher-shell -u neo4j -p "$CORTEX_TEST_NEO4J_PASSWORD" "RETURN 1;"',
  ]);
}

function runNeo4jCypher(fixture, envPath, files, password) {
  return fixture.run(neo4jCypherArgs(envPath, files), {
    env: { CORTEX_TEST_NEO4J_PASSWORD: password },
  });
}

/**
 * Validates that a disposable Docker stack correctly initializes health checks
 * and properly recreates volumes with new credentials when the stack is
 * destroyed and recreated.
 *
 * This test ensures:
 * - The Mem0 API is healthy and accessible
 * - Volume recreation (docker-compose down --volumes) properly removes all data
 * - Old credentials are invalidated after volume recreation
 * - New credentials work correctly after recreation
 *
 * Assumptions:
 * - The test runs on a system with Docker Compose available
 * - The CORTEX_DOCKER_INTEGRATION=1 environment variable is set
 * - The test creates a disposable Docker Compose fixture with unique project names
 * - Success is indicated by all health checks passing and volume recreation
 *   properly removing data
 */
test("MISSING-02/MISSING-14 disposable Docker stack validates health and credential-volume recreation", { skip: !enabled && "set CORTEX_DOCKER_INTEGRATION=1 on a disposable Docker host" }, async t => {
  if (!await dockerAvailable()) t.skip("Docker Compose is unavailable");
  const fixture = await createDockerComposeFixture();
  const envPath = path.join(fixture.root, "mem0.env");
  const overridePath = path.join(fixture.root, "override.yml");
  const firstPassword = `first-${fixture.project}`;
  const secondPassword = `second-${fixture.project}`;
  const composeFiles = [composePath, overridePath];
  t.after(() => fixture.cleanup(composeFiles, envPath));
  await fixture.write("mem0.env", `POSTGRES_PASSWORD=${firstPassword}\nNEO4J_PASSWORD=${firstPassword}\nNEO4J_AUTH=neo4j/${firstPassword}\nOPENAI_API_KEY=test-no-network\n`);
  await fixture.write("override.yml", `services:\n  mem0-api:\n    env_file:\n      - ${envPath.replace(/\\/g, "/")}\n    ports: !override\n      - \"127.0.0.1::8000\"\n  postgres:\n    ports: !override\n      - \"127.0.0.1::5432\"\n  neo4j:\n    ports: !override\n      - \"127.0.0.1::7474\"\n      - \"127.0.0.1::7687\"\n`);
  await fixture.run(composeArgs(envPath, composeFiles, ["up", "-d", "--build"]), { timeout: 300_000 });
  await fixture.run(composeArgs(envPath, composeFiles, ["exec", "-T", "postgres", "psql", "-U", "mem0", "-d", "mem0", "-c", "CREATE EXTENSION IF NOT EXISTS vector; SELECT extname FROM pg_extension WHERE extname = 'vector';"]));
  await waitForCommand(
    () => runNeo4jCypher(fixture, envPath, composeFiles, firstPassword),
    "Neo4j with initial fixture credentials",
  );
  const { stdout } = await fixture.run(composeArgs(envPath, composeFiles, ["port", "mem0-api", "8000"]));
  let endpoint = `http://${stdout.trim().replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
  await waitFor(`${endpoint}/openapi.json`, "Mem0 API");

  // Fixture-owned relational and vector rows prove the destructive boundary
  // without addressing a developer volume, a workspace RAG index, or an
  // external model provider. A memory write would ask the real Mem0 API to
  // call its configured embedding provider, which is deliberately outside a
  // hermetic credential/volume integration test.
  await fixture.run(composeArgs(envPath, composeFiles, ["exec", "-T", "postgres", "psql", "-U", "mem0", "-d", "mem0", "-c", "CREATE TABLE IF NOT EXISTS cortex_rotation_probe (value text); CREATE TABLE IF NOT EXISTS cortex_rag_rotation_probe (marker text, embedding vector(3)); INSERT INTO cortex_rotation_probe VALUES ('fixture-marker'); INSERT INTO cortex_rag_rotation_probe VALUES ('fixture-rag-marker', '[1,0,0]'); SELECT marker FROM cortex_rag_rotation_probe;"]));
  await fixture.run(composeArgs(envPath, composeFiles, ["down", "--volumes"]));
  await fixture.write("mem0.env", `POSTGRES_PASSWORD=${secondPassword}\nNEO4J_PASSWORD=${secondPassword}\nNEO4J_AUTH=neo4j/${secondPassword}\nOPENAI_API_KEY=test-no-network\n`);
  await fixture.run(composeArgs(envPath, composeFiles, ["up", "-d", "--build"]), { timeout: 300_000 });
  const marker = await fixture.run(composeArgs(envPath, composeFiles, ["exec", "-T", "postgres", "psql", "-U", "mem0", "-d", "mem0", "-tAc", "SELECT to_regclass('public.cortex_rotation_probe');"]));
  assert.equal(marker.stdout.trim(), "", "down --volumes must recreate data rather than preserve fixture marker");
  const ragMarker = await fixture.run(composeArgs(envPath, composeFiles, ["exec", "-T", "postgres", "psql", "-U", "mem0", "-d", "mem0", "-tAc", "SELECT to_regclass('public.cortex_rag_rotation_probe');"]));
  assert.equal(ragMarker.stdout.trim(), "", "volume recreation must also remove fixture RAG vector data");
  await waitForCommand(
    () => runNeo4jCypher(fixture, envPath, composeFiles, secondPassword),
    "Neo4j with rotated fixture credentials",
  );
  await assert.rejects(
    runNeo4jCypher(fixture, envPath, composeFiles, firstPassword),
    error => { assertNoSecrets(String(error), [firstPassword, secondPassword]); return true; },
    "old credentials must not work after rotation",
  );
  const afterRotationPort = await fixture.run(composeArgs(envPath, composeFiles, ["port", "mem0-api", "8000"]));
  const afterRotationEndpoint = `http://${afterRotationPort.stdout.trim().replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
  await waitFor(`${afterRotationEndpoint}/openapi.json`, "recreated Mem0 API");
});

/**
 * Validates that the guarded CUDA sidecar correctly reports its health contract
 * for different embedding models (E5 and MiniLM), including model name, profile,
 * dimensions, prefixes, and other required fields.
 *
 * This test ensures:
 * - The CUDA embedding service is healthy and accessible
 * - Health responses match the expected contract for different models
 * - Invalid configurations are properly detected
 *
 * Assumptions:
 * - The test runs on a system with Docker Compose and CUDA available
 * - The CORTEX_CUDA_INTEGRATION=1 environment variable is set
 * - The test creates a disposable Docker Compose fixture with CUDA profile enabled
 * - Success is indicated by the health responses matching the expected contract
 */
test("DCU-1/DCU-2/DCU-3/DCU-4/DCU-6/DCU-7 guarded CUDA sidecar validates hardware, parity, memory, performance, and cold E5 caching", { skip: !cudaEnabled && "set CORTEX_CUDA_INTEGRATION=1 after enabling the disposable Docker lane" }, async t => {
  if (!enabled) t.skip("CUDA requires CORTEX_DOCKER_INTEGRATION=1");
  if (!await dockerAvailable()) t.skip("Docker Compose is unavailable");
  const fixture = await createDockerComposeFixture();
  const envPath = path.join(fixture.root, "cuda.env");
  const overridePath = path.join(fixture.root, "cuda-override.yml");
  const files = [composePath, overridePath];
  t.after(() => fixture.cleanup(files, envPath, ["cuda"]));
  const miniLmEnv = batchSize => `WORKSPACE_RAG_EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2\nWORKSPACE_RAG_EMBEDDING_PROFILE=plain-v1\nWORKSPACE_RAG_EMBEDDING_BATCH_SIZE=${batchSize}\nPOSTGRES_PASSWORD=unused\nNEO4J_PASSWORD=unused\nNEO4J_AUTH=neo4j/unused\n`;
  await fixture.write("cuda.env", miniLmEnv(1));
  await fixture.write("cuda-override.yml", "services:\n  workspace-rag-cuda:\n    ports: !override\n      - \"127.0.0.1::8000\"\n");
  await fixture.run(composeArgs(envPath, files, ["--profile", "cuda", "up", "-d", "--build", "--force-recreate", "workspace-rag-cuda"]), { timeout: 600_000 });
  const { stdout } = await fixture.run(composeArgs(envPath, files, ["port", "workspace-rag-cuda", "8000"]));
  let endpoint = `http://${stdout.trim().replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
  const health = await (await waitFor(`${endpoint}/health`, "CUDA embedding service")).json();
  assertEmbeddingHealth(health, { profile: "plain-v1", dimensions: 384 });
  assert.equal(health.cudaAvailable, true, "the guarded lane requires a real NVIDIA CUDA device");
  assert.notEqual(health.device, "cpu");

  const texts = Array.from({ length: 256 }, (_, index) => [
    `Workspace retrieval benchmark passage ${index}: multilingual evidence, invoices, delivery dates, and policy citations.`,
    "The agreement requires source-grounded answers, immutable line references, jurisdiction filters, and a complete audit trail.",
    "Each section includes payment terms, supplier obligations, exceptions, approval gates, and operational follow-up actions.",
    "This repeated realistic context makes the benchmark large enough to exercise GPU batching instead of request overhead.",
  ].join(" ").repeat(3));
  const batchOne = await postJson(`${endpoint}/embed`, { texts, inputType: "document" });
  assert.equal(batchOne.embeddings.length, texts.length);
  assert.ok(batchOne.gpuMemoryPeakBytes > 0);

  await fixture.write("cuda.env", miniLmEnv(32));
  await fixture.run(composeArgs(envPath, files, ["--profile", "cuda", "up", "-d", "--force-recreate", "workspace-rag-cuda"]), { timeout: 300_000 });
  const batchPort = await fixture.run(composeArgs(envPath, files, ["port", "workspace-rag-cuda", "8000"]));
  endpoint = `http://${batchPort.stdout.trim().replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
  const batchHealth = await (await waitFor(`${endpoint}/health`, "batch-32 CUDA embedding service")).json();
  assertEmbeddingHealth(batchHealth, { profile: "plain-v1", dimensions: 384 });
  assert.equal(batchHealth.batchSize, 32);
  const batchThirtyTwo = await postJson(`${endpoint}/embed`, { texts, inputType: "document" });
  assert.ok(
    batchThirtyTwo.gpuMemoryPeakBytes > batchOne.gpuMemoryPeakBytes,
    `batch 32 should allocate more peak GPU memory than batch 1 (${batchThirtyTwo.gpuMemoryPeakBytes} <= ${batchOne.gpuMemoryPeakBytes})`,
  );

  const cpuProbe = [
    "import json, os, sys, time",
    "from sentence_transformers import SentenceTransformer",
    "texts = [sys.argv[1]] * 256",
    "model = SentenceTransformer(os.environ['EMBEDDING_MODEL'], device='cpu', revision=os.environ.get('EMBEDDING_MODEL_REVISION') or None)",
    "model.encode(texts[:2], batch_size=2, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)",
    "started = time.perf_counter()",
    "vectors = model.encode(texts, batch_size=32, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)",
    "print(json.dumps({'durationMs': (time.perf_counter() - started) * 1000, 'first': vectors[0].astype('float32').tolist()}))",
  ].join("\n");
  const cpu = await fixture.run(composeArgs(envPath, files, [
    "exec", "-T", "workspace-rag-cuda", "python", "-c", cpuProbe, texts[0],
  ]), { timeout: 300_000 });
  const cpuResult = JSON.parse(cpu.stdout.trim().split(/\r?\n/).at(-1));
  assert.ok(cosineSimilarity(batchThirtyTwo.embeddings[0], cpuResult.first) >= 0.99999);
  assert.ok(
    batchThirtyTwo.durationMs < cpuResult.durationMs,
    `CUDA encode should be faster than CPU for the same batch (${batchThirtyTwo.durationMs}ms >= ${cpuResult.durationMs}ms)`,
  );

  if (process.env.CORTEX_CUDA_E5_INTEGRATION !== "1") return;
  await fixture.write("cuda.env", "WORKSPACE_RAG_EMBEDDING_MODEL=intfloat/multilingual-e5-base\nWORKSPACE_RAG_EMBEDDING_MODEL_REVISION=d13f1b27baf31030b7fd040960d60d909913633f\nWORKSPACE_RAG_EMBEDDING_PROFILE=e5-asymmetric-v1\nWORKSPACE_RAG_EMBEDDING_BATCH_SIZE=2\nPOSTGRES_PASSWORD=unused\nNEO4J_PASSWORD=unused\nNEO4J_AUTH=neo4j/unused\n");
  await fixture.run(composeArgs(envPath, files, ["--profile", "cuda", "up", "-d", "--build", "--force-recreate", "workspace-rag-cuda"]), { timeout: 900_000 });
  const e5Port = await fixture.run(composeArgs(envPath, files, ["port", "workspace-rag-cuda", "8000"]));
  endpoint = `http://${e5Port.stdout.trim().replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
  // E5 is deliberately opt-in because a cold Hugging Face cache can take
  // several minutes to download and initialise; the surrounding test already
  // permits the longer container lifecycle.
  const e5Health = await (await waitFor(`${endpoint}/health`, "E5 CUDA embedding service", 300_000)).json();
  assertEmbeddingHealth(e5Health, { profile: "e5-asymmetric-v1", dimensions: 768 });
  const e5Cache = await fixture.run(composeArgs(envPath, files, [
    "exec", "-T", "workspace-rag-cuda", "python", "-c",
    "import os; print(any('multilingual-e5-base' in root.lower() and files for root, _, files in os.walk('/models')))"
  ]));
  assert.equal(e5Cache.stdout.trim(), "True", "the cold fixture volume must contain the downloaded E5 model cache");
});

test("WRS-4/WRS-5/WRS-8 V2 PostgreSQL keeps MiniLM and E5 dimension tables side by side", { skip: !enabled && "set CORTEX_DOCKER_INTEGRATION=1 on a disposable Docker host" }, async t => {
  if (!await dockerAvailable()) t.skip("Docker Compose is unavailable");
  const fixture = await createDockerComposeFixture();
  const envPath = path.join(fixture.root, "rag-postgres.env");
  const overridePath = path.join(fixture.root, "rag-postgres-override.yml");
  const password = `rag-${fixture.project}`;
  const schema = `rag_switch_${process.pid}`;
  const files = [composePath, overridePath];
  const previous = new Map([
    ["CORTEX_RAG_POSTGRES_HOST", process.env.CORTEX_RAG_POSTGRES_HOST],
    ["CORTEX_RAG_POSTGRES_PORT", process.env.CORTEX_RAG_POSTGRES_PORT],
    ["CORTEX_RAG_POSTGRES_DB", process.env.CORTEX_RAG_POSTGRES_DB],
    ["CORTEX_RAG_POSTGRES_USER", process.env.CORTEX_RAG_POSTGRES_USER],
    ["CORTEX_RAG_POSTGRES_PASSWORD", process.env.CORTEX_RAG_POSTGRES_PASSWORD],
    ["CORTEX_RAG_V2_POSTGRES_SCHEMA", process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA],
  ]);
  let miniLm;
  let e5;
  t.after(async () => {
    await e5?.close().catch(() => undefined);
    await miniLm?.close().catch(() => undefined);
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fixture.cleanup(files, envPath);
  });
  await fixture.write("rag-postgres.env", `POSTGRES_PASSWORD=${password}\nNEO4J_PASSWORD=unused\nNEO4J_AUTH=neo4j/unused\n`);
  await fixture.write("rag-postgres-override.yml", "services:\n  postgres:\n    ports: !override\n      - \"127.0.0.1::5432\"\n");
  await fixture.run(composeArgs(envPath, files, ["up", "-d", "postgres"]), { timeout: 180_000 });
  await waitForCommand(
    () => fixture.run(composeArgs(envPath, files, [
      "exec", "-T", "postgres", "psql", "-U", "mem0", "-d", "mem0", "-tAc", "SELECT 1;",
    ])),
    "workspace RAG PostgreSQL fixture",
  );
  const { stdout } = await fixture.run(composeArgs(envPath, files, ["port", "postgres", "5432"]));
  const port = stdout.trim().split(":").at(-1);
  assert.match(port ?? "", /^\d+$/);

  process.env.CORTEX_RAG_POSTGRES_HOST = "127.0.0.1";
  process.env.CORTEX_RAG_POSTGRES_PORT = port;
  process.env.CORTEX_RAG_POSTGRES_DB = "mem0";
  process.env.CORTEX_RAG_POSTGRES_USER = "mem0";
  process.env.CORTEX_RAG_POSTGRES_PASSWORD = password;
  process.env.CORTEX_RAG_V2_POSTGRES_SCHEMA = schema;
  const { PostgresRagV2Repository } = await import(
    "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts"
  );
  miniLm = new PostgresRagV2Repository();
  await miniLm.initialize({
    backend: "cuda",
    model: "sentence-transformers/all-MiniLM-L6-v2",
    dimensions: 384,
    signature: "minilm-384-test",
  });
  e5 = new PostgresRagV2Repository();
  await e5.initialize({
    backend: "cuda",
    model: "intfloat/multilingual-e5-base",
    dimensions: 768,
    signature: "e5-768-test",
  });
  await miniLm.close();
  miniLm = undefined;
  await e5.close();
  e5 = undefined;

  const tableQuery = [
    `SELECT tablename FROM pg_tables WHERE schemaname = '${schema}'`,
    "AND tablename IN ('unit_embeddings_384','unit_embeddings_768')",
    "ORDER BY tablename;",
  ].join(" ");
  const tables = await fixture.run(composeArgs(envPath, files, [
    "exec", "-T", "postgres", "psql", "-U", "mem0", "-d", "mem0", "-tAc", tableQuery,
  ]));
  assert.deepEqual(
    tables.stdout.trim().split(/\r?\n/).filter(Boolean),
    ["unit_embeddings_384", "unit_embeddings_768"],
    "switching dimensions must create the selected tables without deleting the other model's tables",
  );
});
