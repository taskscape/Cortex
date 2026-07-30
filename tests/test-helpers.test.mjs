import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "./helpers/fake-clock.mjs";
import { startHttpSidecar } from "./helpers/http-sidecar.mjs";
import { createTempWorkspace } from "./helpers/temp-workspace.mjs";

/**
 * Validates that the deterministic test helpers correctly isolate test paths,
 * fake time, and HTTP sidecar traffic to ensure test determinism and prevent
 * interference between tests.
 *
 * This test ensures:
 * - Temporary workspace paths are unique and not in production directories
 * - Fake clocks advance deterministically and schedule callbacks in the expected order
 * - HTTP sidecars correctly route requests and record them for verification
 *
 * Assumptions:
 * - The createTempWorkspace() function creates unique temporary directories
 * - The createFakeClock() function provides a deterministic clock for testing
 * - The startHttpSidecar() function creates a mock HTTP server for testing
 * - Success is indicated by the test helpers behaving as expected (unique paths,
 *   correct clock behavior, correct routing)
 */
test("MISSING-00 deterministic test helpers isolate paths, time, and sidecar traffic", async t => {
  const fixture = await createTempWorkspace("cortex-helper-");
  t.after(() => fixture.cleanup());
  assert.match(fixture.root, /cortex-helper-/);
  assert.equal(/matbot[\\/]workspaces/i.test(fixture.root), false);

  const clock = createFakeClock(100);
  const calls = [];
  clock.setTimeout(() => calls.push("once"), 10);
  const interval = clock.setInterval(() => calls.push("interval"), 5);
  clock.advance(5);
  clock.advance(5);
  clock.clearInterval(interval);
  assert.deepEqual(calls, ["interval", "once", "interval"]);

  const sidecar = await startHttpSidecar({
    "GET /health": () => ({ body: { ok: true } }),
  });
  t.after(() => sidecar.close());
  assert.deepEqual(await (await fetch(`${sidecar.url}/health`)).json(), { ok: true });
  assert.equal(sidecar.requests[0].key, "GET /health");
});
