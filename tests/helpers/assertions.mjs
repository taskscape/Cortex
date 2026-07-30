import assert from "node:assert/strict";

export function assertEmbeddingHealth(value, expected = {}) {
  assert.equal(value?.ok, true, "embedding health must be OK");
  assert.equal(typeof value?.model, "string");
  assert.ok(value.model.length > 0);
  assert.ok(Number.isInteger(value?.dimensions) && value.dimensions > 0, "embedding dimensions must be positive");
  assert.equal(typeof value?.profile, "string");
  assert.ok(value.profile.length > 0);
  assert.equal(typeof value?.signature, "string");
  assert.ok(value.signature.length > 0);
  assert.equal(value?.normalized, true);
  if (expected.profile !== undefined) assert.equal(value.profile, expected.profile);
  if (expected.dimensions !== undefined) assert.equal(value.dimensions, expected.dimensions);
  if (value.profile === "e5-asymmetric-v1") {
    assert.equal(value.queryPrefix, "query: ");
    assert.equal(value.documentPrefix, "passage: ");
  }
}

export function assertNoSecrets(value, secrets) {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) assert.doesNotMatch(rendered, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
