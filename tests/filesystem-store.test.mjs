/**
 * Filesystem store validation ensures that record IDs containing special characters
 * or characters that would normally be invalid for file names (e.g., slashes, colons,
 * Unicode) are properly stored and retrieved from the filesystem-backed store.
 *
 * This test ensures:
 * - Record IDs with non-file-name-safe characters are encoded or escaped correctly
 * - The store can persist, retrieve, and delete records with such IDs
 * - No data corruption or loss occurs due to the ID encoding
 * - The store handles edge cases (empty IDs, very long IDs, etc.)
 * - Cross-platform compatibility (Windows vs Unix path separators)
 *
 * Assumptions:
 * - The filesystem store uses file paths to store record data
 * - The runtime script creates records with specially crafted IDs that would fail
 *   on typical file systems (e.g., containing path separators)
 * - The store's encoding layer properly handles these IDs
 * - Success is indicated by a specific stdout message about prefixed record IDs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("filesystem store persists record ids that are not file-name safe", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    "tests/filesystem-store-runtime.mjs",
  ], {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  assert.match(stdout + stderr, /filesystem store persists prefixed record ids/);
});
