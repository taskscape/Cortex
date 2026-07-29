import assert from "node:assert/strict";

const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import(
  "../local-agent/matbot/packages/core/plugin-api/src/index.ts"
);
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "background-scheduling-test", type: "user" }));

const { plugin } = await import("../local-agent/matbot/packages/plugins/background/src/index.ts");

class MemoryStore {
  constructor() {
    this.docs = new Map();
  }
  async get(id) { return this.docs.get(id) ?? null; }
  async set(id, value) { this.docs.set(id, value); }
  async delete(id) { return this.docs.delete(id); }
  async query() { return { items: [...this.docs.values()], total: this.docs.size }; }
}

async function collect(tool, input, context = {}) {
  const events = [];
  for await (const event of tool.executor.execute(input, {
    signal: new AbortController().signal,
    provider: "test-provider",
    configPath: "C:\\disposable\\matbot.yaml",
    ...context,
  })) {
    events.push(event);
  }
  const error = events.find(event => event.type === "error");
  return error ? { error: error.message } : events.find(event => event.type === "result")?.value;
}

function machine(store) {
  return {
    configPath: "C:\\disposable\\matbot.yaml",
    isSubAgent: () => false,
    createStore: () => store,
    files: {
      async put() {}
    }
  };
}

const background = plugin.tools.find(tool => tool.name === "background");
const every = plugin.tools.find(tool => tool.name === "every_action");
assert.ok(background);
assert.ok(every);

const workspaceAStore = new MemoryStore();
let restartScheduleId;
await plugin.setup(machine(workspaceAStore));
try {
  const invalid = await collect(background, { prompt: "invalid", interval: "tomorrow" });
  assert.match(invalid.error, /Invalid duration/);

  const created = await collect(background, {
    prompt: "Run the typed workflow with the minimum required tools.",
    interval: "1d",
    name: "Daily governed workflow",
    output: "scheduled-result.md"
  });
  assert.equal(typeof created.id, "string");
  assert.equal(created.interval, "1d");

  let schedules = await collect(every, { action: "list" });
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].name, "Daily governed workflow");
  assert.equal(schedules[0].active, true);
  assert.equal(schedules[0].output, "scheduled-result.md");
  assert.equal(schedules[0].provider, "test-provider");
  assert.equal(schedules[0].principalId, "background-scheduling-test");

  const suspended = await collect(every, { action: "suspend", id: created.id });
  assert.equal(suspended.suspended, true);
  schedules = await collect(every, { action: "list" });
  assert.equal(schedules[0].active, false);

  const resumed = await collect(every, { action: "resume", id: created.id });
  assert.equal(resumed.resumed, true);
  schedules = await collect(every, { action: "list" });
  assert.equal(schedules[0].active, true);

  const unsafeBulkCancel = await collect(every, { action: "cancel", id: "*" });
  assert.match(unsafeBulkCancel.error, /specific schedule id/);
  assert.equal((await collect(every, { action: "list" })).length, 1);

  const cancelled = await collect(every, { action: "cancel", id: created.id });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(await collect(every, { action: "list" }), []);

  const restartSchedule = await collect(background, {
    prompt: "Run after a safe runtime restart.",
    interval: "2d",
    name: "Restart-safe schedule"
  });
  restartScheduleId = restartSchedule.id;
} finally {
  await plugin.teardown();
}

await plugin.setup(machine(workspaceAStore));
try {
  const restored = await collect(every, { action: "list" });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, restartScheduleId);
  assert.equal(restored[0].name, "Restart-safe schedule");
  await collect(every, { action: "cancel", id: restartScheduleId });
} finally {
  await plugin.teardown();
}

const workspaceBStore = new MemoryStore();
await plugin.setup(machine(workspaceBStore));
try {
  assert.deepEqual(await collect(every, { action: "list" }), []);
} finally {
  await plugin.teardown();
}

console.log("background schedules validate durations, persist lifecycle state, reject unsafe bulk cancellation, and stay workspace-isolated");
