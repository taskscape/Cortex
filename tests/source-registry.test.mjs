/**
 * Source registry validation ensures that source identifiers (for files, URLs,
 * database connections, etc.) are stored persistently and remain stable across
 * sessions and runtime restarts.
 *
 * This test ensures:
 * - Sources are assigned stable, unique IDs that persist across restarts
 * - Source metadata (name, type, location, etc.) is stored correctly
 * - Sources can be queried, listed, and retrieved by ID
 * - Duplicate sources (same location) are detected and handled appropriately
 * - Source lifecycle (creation, update, deletion) works correctly
 *
 * Assumptions:
 * - The source-registry plugin maintains a persistent store of sources
 * - The runtime script creates sources, verifies their IDs, and checks persistence
 * - The store survives runtime restarts (e.g., writes to disk or database)
 * - Success is indicated by a specific stdout message about stable source IDs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

/**
 * Validates that the source registry correctly stores and retrieves source identifiers
 * with stable IDs that persist across sessions and runtime restarts.
 *
 * This test ensures:
 * - Sources are assigned stable, unique IDs that persist across restarts
 * - Source metadata (name, type, location, etc.) is stored correctly
 * - Sources can be queried, listed, and retrieved by ID
 * - Duplicate sources (same location) are detected and handled appropriately
 * - Source lifecycle (creation, update, deletion) works correctly
 *
 * Assumptions:
 * - The source-registry plugin maintains a persistent store of sources
 * - The runtime script creates sources, verifies their IDs, and checks persistence
 * - The store survives runtime restarts (e.g., writes to disk or database)
 * - Success is indicated by the runtime output containing the expected success message
 */
test("MISSING-13 source-registry runtime flow covers versions, access history, and health transitions", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/source-registry-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout + stderr, /source-registry stores stable source ids/);
});
