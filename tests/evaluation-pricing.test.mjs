import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { pricedCost } = await import("../local-agent/matbot/packages/plugins/evaluation-observability/src/index.ts");

/**
 * T3-E2E-029: Model pricing with direct costs, catalog pricing, and cached tokens
 *
 * Validates that the model pricing function correctly calculates costs based on
 * direct costs, catalog pricing, cached input tokens, and handles invalid configurations.
 *
 * This test ensures:
 * - Direct costs are honored when provided
 * - Catalog pricing is used when direct cost is not provided
 * - Cached input tokens are priced differently (cheaper) than regular input tokens
 * - Missing models return a default cost of zero
 * - Invalid configurations are handled gracefully (return zero cost)
 *
 * Assumptions:
 * - The pricedCost() function calculates model costs based on configuration
 * - The test sets up various pricing configurations using CORTEX_MODEL_PRICING_JSON
 * - The test also tests invalid configurations (missing model, non-JSON, negative costs)
 * - Success is indicated by the function returning the expected costs for each case
 */
test("T3-E2E-029 model pricing honours direct cost, catalog pricing, cached input, and invalid configuration", () => {
  const prior = process.env.CORTEX_MODEL_PRICING_JSON;
  try {
    process.env.CORTEX_MODEL_PRICING_JSON = JSON.stringify({
      "model-a": { inputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.5, outputPerMillionUsd: 8 },
    });
    assert.equal(pricedCost({ costUsd: 1.25, model: "model-a", inputTokens: 1 }), 1.25);
    assert.equal(pricedCost({ model: "model-a", inputTokens: 1_000_000, cacheReadTokens: 200_000, outputTokens: 500_000 }), 5.7);
    assert.equal(pricedCost({ model: "missing", inputTokens: 1_000_000 }), 0);
    process.env.CORTEX_MODEL_PRICING_JSON = "not-json";
    assert.equal(pricedCost({ model: "model-a", inputTokens: 1_000_000 }), 0);
    process.env.CORTEX_MODEL_PRICING_JSON = JSON.stringify({ "model-a": { inputPerMillionUsd: -1, outputPerMillionUsd: "bad" } });
    assert.equal(pricedCost({ model: "model-a", inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0);
  } finally {
    if (prior === undefined) delete process.env.CORTEX_MODEL_PRICING_JSON;
    else process.env.CORTEX_MODEL_PRICING_JSON = prior;
  }
});
