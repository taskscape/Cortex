import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { validateCudaEmbeddingHealth } = await import("../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts");

/**
 * Validates that the CUDA embedding health validation function correctly validates
 * the embedding service health contract, including model name, profile, dimensions,
 * prefixes, and other required fields.
 *
 * This test ensures:
 * - Valid health responses pass validation for different embedding models
 * - Invalid configurations are properly rejected (wrong dimensions, missing prefixes,
 *   invalid batch size, etc.)
 * - The validation checks all required contract fields
 *
 * Assumptions:
 * - The validateCudaEmbeddingHealth() function validates embedding service health
 *   responses against a contract
 * - The test creates health responses for different models (E5, MiniLM)
 * - The test also creates invalid health responses to test rejection paths
 * - Success is indicated by the validation function returning undefined for valid
 *   responses and throwing errors for invalid ones
 */
test("MISSING-01 CUDA embedding health validates model/profile/dimension/prefix contracts", () => {
  const e5 = {
    ok: true, cudaAvailable: true, model: "intfloat/multilingual-e5-base", dimensions: 768,
    profile: "e5-asymmetric-v1", signature: "e5-signature", batchSize: 32, normalized: true,
    queryPrefix: "query: ", documentPrefix: "passage: ",
  };
  const miniLm = {
    ok: true, cudaAvailable: true, model: "sentence-transformers/all-MiniLM-L6-v2", dimensions: 384,
    profile: "plain-v1", signature: "minilm-signature", batchSize: 32, normalized: true,
    queryPrefix: "", documentPrefix: "",
  };
  assert.equal(validateCudaEmbeddingHealth(e5), undefined);
  assert.equal(validateCudaEmbeddingHealth(miniLm), undefined);
  assert.match(validateCudaEmbeddingHealth({ ...e5, dimensions: 384 }), /768/);
  assert.match(validateCudaEmbeddingHealth({ ...e5, queryPrefix: "" }), /prefixes/);
  assert.match(validateCudaEmbeddingHealth({ ...miniLm, normalized: false }), /normalized/);
  assert.match(validateCudaEmbeddingHealth({ ...miniLm, dimensions: 0 }), /invalid dimensions/);
  assert.match(validateCudaEmbeddingHealth({ ...miniLm, batchSize: 0 }), /invalid batch size/);
});
