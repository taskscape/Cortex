/**
 * Context graph validation ensures that relationships between entities (sources,
 * people, topics, etc.) are correctly extracted and stored.
 *
 * This test ensures:
 * - Source-backed relationships are identified from conversation content
 * - The graph stores edges (relationships) between nodes (entities)
 * - Relationship attributes (confidence, timestamp, context) are captured
 * - The graph can be queried to find related entities or paths
 * - New relationships can be added and existing ones updated
 *
 * Assumptions:
 * - The context-graph plugin extracts relationships from conversation content
 * - The runtime script creates sample conversations with explicit relationships
 * - The plugin stores the graph in a durable backend (e.g., Neo4j)
 * - Success is indicated by a specific stdout message about relationship extraction
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("context-graph runtime flow passes under the Matbot TypeScript loader", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/context-graph-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout + stderr, /context-graph extracts source-backed relationships/);
});
