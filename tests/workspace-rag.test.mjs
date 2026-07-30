/**
 * T2-E2E-009 / T3-E2E-011: Workspace RAG validates path normalization and the complete
 * markdown ingestion pipeline that embeds documents for semantic search.
 *
 * This test ensures:
 * - File paths are normalized consistently (Windows backslashes, relative paths)
 * - Markdown files are chunked according to the configured strategy
 * - Content is hashed (SHA-256) for deduplication and integrity
 * - Vectors are stored in Postgres with pgvector (dimension-specific tables)
 * - The embedding backend (CPU or CUDA) processes documents correctly
 * - The ingestion state machine (idle, indexing, paused) works correctly
 * - The runtime can query the index and retrieve relevant chunks
 *
 * Assumptions:
 * - Postgres with pgvector is running and accessible
 * - The workspace has some markdown content in its RAG roots
 * - The embedding service (Mem0 or CUDA) is available and responding
 * - The runtime script ingests a known document and queries it
 * - Success is indicated by a specific stdout message about ingestion
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("T2-E2E-009 / T3-E2E-011 / MISSING-03 / MISSING-12 workspace-rag normalizes paths, reconciles reindexing, and manages isolated contexts", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/workspace-rag-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout + stderr, /workspace-rag ingests markdown/);
});
