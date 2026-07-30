import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "./helpers/fake-clock.mjs";

await import("../local-agent/matbot/apps/cli/register.js");
const { effectiveStaleness } = await import("../local-agent/matbot/packages/plugins/source-registry/src/index.ts");

test("MISSING-13 source freshness transitions at the SLA boundary without real-time waits", () => {
  const clock = createFakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const base = { lastSuccessfulReadAt: "2026-01-01T00:00:00.000Z", freshnessSlaSeconds: 60 };
  assert.equal(effectiveStaleness(base, clock.now()), "fresh");
  clock.advance(59_999);
  assert.equal(effectiveStaleness(base, clock.now()), "fresh");
  clock.advance(1);
  assert.equal(effectiveStaleness(base, clock.now()), "stale");
  assert.equal(effectiveStaleness({ lastSuccessfulReadAt: base.lastSuccessfulReadAt }, clock.now()), "fresh");
  assert.equal(effectiveStaleness({}, clock.now()), "unknown");
});
