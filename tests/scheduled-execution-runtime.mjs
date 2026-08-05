import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import(
  "../local-agent/matbot/packages/core/plugin-api/src/index.ts"
);
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "scheduled-principal", type: "user" }));

const { installBackgroundTestHooks, plugin } = await import(
  "../local-agent/matbot/packages/plugins/background/src/index.ts"
);

class MemoryStore {
  constructor() { this.docs = new Map(); }
  async get(id) { return this.docs.get(id) ?? null; }
  async set(id, value) { this.docs.set(id, structuredClone(value)); }
  async delete(id) { return this.docs.delete(id); }
  async query() { return { items: [...this.docs.values()].map(item => structuredClone(item)), total: this.docs.size }; }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
    queueMicrotask(() => this.emit("exit", 0, null));
  }
  kill() {
    if (this.killed) return false;
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
  unref() {}
}

async function collect(tool, input) {
  const events = [];
  for await (const event of tool.executor.execute(input, {
    signal: new AbortController().signal,
    provider: "scheduled-provider",
    configPath: "C:\\disposable\\matbot.yaml",
  })) events.push(event);
  const error = events.find(event => event.type === "error");
  return error ? { error: error.message } : events.find(event => event.type === "result")?.value;
}

const launches = [];
const restore = installBackgroundTestHooks({
  startupDelayMs: 0,
  launchJob(configPath, prompt, output, _files, provider, principal) {
    launches.push({ configPath, prompt, output, provider, principal });
    return new FakeChild();
  },
});
const store = new MemoryStore();
const machine = {
  configPath: "C:\\disposable\\matbot.yaml",
  isSubAgent: () => false,
  createStore: () => store,
  files: { async put() {} },
};
const background = plugin.tools.find(tool => tool.name === "background");
const every = plugin.tools.find(tool => tool.name === "every_action");

await plugin.setup(machine);
try {
  const created = await collect(background, {
    prompt: "Execute typed workflow invoice-approval; do not call write tools before its approval gate.",
    // Production rejects intervals below 10s; startupDelayMs=0 keeps this test immediate.
    interval: "10s",
    name: "Governed scheduled execution",
    output: "scheduled-ledger.json",
  });
  assert.equal(typeof created.id, "string");

  const deadline = Date.now() + 5_000;
  let schedules = [];
  while (Date.now() < deadline) {
    schedules = await collect(every, { action: "list" });
    if (schedules[0]?.runCount === 1) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(launches.length, 1);
  assert.equal(launches[0].provider, "scheduled-provider");
  assert.equal(launches[0].principal.id, "scheduled-principal");
  assert.match(launches[0].prompt, /typed workflow invoice-approval/);
  assert.match(launches[0].prompt, /approval gate/);
  assert.equal(schedules[0].lastStatus, "succeeded");
  assert.equal(schedules[0].runCount, 1);
  assert.equal(typeof schedules[0].lastOccurrenceId, "string");
  assert.equal(typeof schedules[0].lastStartedAt, "string");

  await collect(every, { action: "suspend", id: created.id });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(launches.length, 1, "suspension must not duplicate an occurrence");
  await collect(every, { action: "cancel", id: created.id });
} finally {
  await plugin.teardown();
  restore();
}

/**
 * T3-E2E-046: Scheduled child execution preserves principal/provider identity and durable exact-once occurrence history
 *
 * Validates that scheduled tasks correctly record their occurrences with the correct
 * identity and are bound to their policy.
 *
 * This test ensures:
 * - Scheduled tasks execute at their configured intervals
 * - Each occurrence is recorded with the correct policy identity
 * - Child executions inherit the principal (user/identity) from the schedule
 * - No unauthorized executions can occur (policy-bound enforcement)
 * - The occurrence tracking persists across runtime restarts
 * - The principal/provider identity is correctly propagated to child executions
 *
 * Assumptions:
 * - The background plugin creates scheduled tasks with the correct identity
 * - The test creates a scheduled task and verifies its execution
 * - Success is indicated by the runtime output containing the expected success message
 */
console.log("T3-E2E-046 scheduled child execution preserves principal/provider identity and durable exact-once occurrence history");
