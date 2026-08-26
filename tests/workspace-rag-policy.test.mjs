import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");

const { ragV2PolicyFromEnv } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/config.ts"
);

const POLICY_ENV = [
  "CORTEX_RAG_V2_FILE_CONCURRENCY",
  "CORTEX_RAG_V2_EMBED_PIPELINE_DEPTH",
];

function withEnv(values, run) {
  const saved = new Map(POLICY_ENV.map(name => [name, process.env[name]]));
  try {
    for (const name of POLICY_ENV) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("MISSING-02 ingestion throughput policy resolves defaults, overrides, and clamps", () => {
  const defaults = withEnv({}, () => ragV2PolicyFromEnv());
  assert.equal(defaults.fileConcurrency, undefined, "unset file concurrency enables adaptive mode");
  assert.equal(defaults.embedPipelineDepth, 2, "one embedding batch overlaps storage by default");

  const overridden = withEnv({
    CORTEX_RAG_V2_FILE_CONCURRENCY: "4",
    CORTEX_RAG_V2_EMBED_PIPELINE_DEPTH: "6",
  }, () => ragV2PolicyFromEnv());
  assert.equal(overridden.fileConcurrency, 4);
  assert.equal(overridden.embedPipelineDepth, 6);

  const clamped = withEnv({
    CORTEX_RAG_V2_FILE_CONCURRENCY: "99",
    CORTEX_RAG_V2_EMBED_PIPELINE_DEPTH: "0",
  }, () => ragV2PolicyFromEnv());
  assert.equal(clamped.fileConcurrency, 8);
  assert.equal(clamped.embedPipelineDepth, 2, "non-positive values fall back to the default");

  const invalid = withEnv({
    CORTEX_RAG_V2_FILE_CONCURRENCY: "not-a-number",
    CORTEX_RAG_V2_EMBED_PIPELINE_DEPTH: "1.9",
  }, () => ragV2PolicyFromEnv());
  assert.equal(invalid.fileConcurrency, 1);
  assert.equal(invalid.embedPipelineDepth, 1);
});
