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
test("MISSING-01 guarded CUDA sidecar reports its health contract", { skip: !cudaEnabled && "set CORTEX_CUDA_INTEGRATION=1 after enabling the disposable Docker lane" }, async t => {
  if (!enabled) t.skip("CUDA requires CORTEX_DOCKER_INTEGRATION=1");
  if (!await dockerAvailable()) t.skip("Docker Compose is unavailable");
  const fixture = await createDockerComposeFixture();
  const envPath = path.join(fixture.root, "cuda.env");
  const overridePath = path.join(fixture.root, "cuda-override.yml");
  const files = [composePath, overridePath];
  t.after(() => fixture.cleanup(files, envPath, ["cuda"]));
  await fixture.write("cuda.env", "WORKSPACE_RAG_EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2\nWORKSPACE_RAG_EMBEDDING_PROFILE=plain-v1\nWORKSPACE_RAG_EMBEDDING_BATCH_SIZE=2\nPOSTGRES_PASSWORD=unused\nNEO4J_PASSWORD=unused\nNEO4J_AUTH=neo4j/unused\n");
  await fixture.write("cuda-override.yml", "services:\n  workspace-rag-cuda:\n    ports: !override\n      - \"127.0.0.1::8000\"\n");
  await fixture.run(composeArgs(envPath, files, ["--profile", "cuda", "up", "-d", "--build", "--force-recreate", "workspace-rag-cuda"]), { timeout: 600_000 });
  const { stdout } = await fixture.run(composeArgs(envPath, files, ["port", "workspace-rag-cuda", "8000"]));
  let endpoint = `http://${stdout.trim().replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
  const health = await (await waitFor(`${endpoint}/health`, "CUDA embedding service")).json();
  assertEmbeddingHealth(health, { profile: "plain-v1", dimensions: 384 });
  if (process.env.CORTEX_CUDA_E5_INTEGRATION !== "1") return;
  await fixture.write("cuda.env", "WORKSPACE_RAG_EMBEDDING_MODEL=intfloat/multilingual-e5-base\nWORKSPACE_RAG_EMBEDDING_PROFILE=e5-asymmetric-v1\nWORKSPACE_RAG_EMBEDDING_BATCH_SIZE=2\nPOSTGRES_PASSWORD=unused\nNEO4J_PASSWORD=unused\nNEO4J_AUTH=neo4j/unused\n");
  await fixture.run(composeArgs(envPath, files, ["--profile", "cuda", "up", "-d", "--build", "--force-recreate", "workspace-rag-cuda"]), { timeout: 900_000 });
  const e5Port = await fixture.run(composeArgs(envPath, files, ["port", "workspace-rag-cuda", "8000"]));
  endpoint = `http://${e5Port.stdout.trim().replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
  // E5 is deliberately opt-in because a cold Hugging Face cache can take
  // several minutes to download and initialise; the surrounding test already
  // permits the longer container lifecycle.
  const e5Health = await (await waitFor(`${endpoint}/health`, "E5 CUDA embedding service", 300_000)).json();
  assertEmbeddingHealth(e5Health, { profile: "e5-asymmetric-v1", dimensions: 768 });
});
