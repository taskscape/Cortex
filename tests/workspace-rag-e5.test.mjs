import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

/**
 * T3-E2E-031: Workspace RAG E5 embedding contract with purpose-aware requests
 *
 * Validates that the RAG system sends purpose-aware embedding requests (with query
 * vs document prefixes) and correctly persists the embedding model signature for
 * future compatibility checks.
 *
 * This test ensures:
 * - Query and document embeddings are sent with their respective prefixes
 * - The embedding signature is persisted and validated
 * - The embedding service is compatible with the configured model
 *
 * Assumptions:
 * - The RAG plugin's workspace_rag tool sends embedding requests to a CUDA service
 * - The test creates a temporary workspace and documents, then triggers indexing
 * - The CUDA service returns the correct embedding signature and model information
 * - Success is indicated by the runtime output containing the expected success message
 */
test("T3-E2E-031 workspace-rag sends purpose-aware requests and persists the embedding signature", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/workspace-rag-e5-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout + stderr, /workspace-rag E5 embedding contract passes/);
});
