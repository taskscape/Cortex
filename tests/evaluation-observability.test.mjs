/**
 * evaluation-observability: validates the end-to-end flow of the evaluation and
 * observability plugin, which captures traces, supports safe replay, runs regression
 * test suites, and computes model cost accounting and ROI metrics.
 *
 * This test ensures:
 * - The plugin loads correctly under the Matbot TypeScript loader
 * - End-to-end spans are captured and stored
 * - Redacted trace replay works (sensitive data is removed before replay)
 * - Deterministic scorers produce consistent results
 * - Model-based scorers can evaluate outputs
 * - Operational metrics (tokens, latency) are tracked
 * - Cost accounting works with the pricing configuration
 * - Workflow outcomes can be linked to evaluation results
 * - ROI arithmetic is correct (savings vs. costs)
 *
 * Assumptions:
 * - The runtime script simulates a complete evaluation lifecycle
 * - CORTEX_MODEL_PRICING_JSON provides a simple pricing model for cost accounting
 * - The plugin's storage backend (filesystem or database) is accessible
 * - The runtime reports success via a specific stdout message
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

/**
 * T3-E2E-028: Evaluation and observability runtime flow with safe replay and ROI
 *
 * Validates the end-to-end flow of the evaluation and observability plugin, which
 * captures traces, supports safe replay (with credential redaction), runs regression
 * test suites, and computes model cost accounting and ROI metrics.
 *
 * This test ensures:
 * - The plugin loads correctly under the Matbot TypeScript loader
 * - End-to-end spans are captured and stored
 * - Redacted trace replay works (sensitive data is removed before replay)
 * - Deterministic scorers produce consistent results
 * - Model-based scorers can evaluate outputs
 * - Operational metrics (tokens, latency) are tracked
 * - Cost accounting works with the pricing configuration
 * - Workflow outcomes can be linked to evaluation results
 * - ROI arithmetic is correct (savings vs. costs)
 *
 * Assumptions:
 * - The runtime script simulates a complete evaluation lifecycle
 * - CORTEX_MODEL_PRICING_JSON provides a simple pricing model for cost accounting
 * - The plugin's storage backend (filesystem or database) is accessible
 * - The runtime reports success via a specific stdout message
 */
test("T3-E2E-028 evaluation-observability runtime flow covers safe replay, release gates, and ROI", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/evaluation-observability-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CORTEX_MODEL_PRICING_JSON: JSON.stringify({ "test-model": { inputPerMillionUsd: 1, outputPerMillionUsd: 2 } }) },
  });

  assert.match(stdout + stderr, /evaluation-observability records governed evidence/);
});
