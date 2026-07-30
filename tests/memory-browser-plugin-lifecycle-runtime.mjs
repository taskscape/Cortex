import assert from "node:assert/strict";

const {
  createConstantPrincipalCarrier,
  installPrincipalCarrier,
} = await import("../local-agent/matbot/packages/core/plugin-api/src/index.ts");
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "memory-browser-lifecycle", type: "user" }));

const { plugin } = await import("../local-agent/matbot/packages/plugins/memory-browser/src/index.ts");

class MemoryStore {
  constructor() {
    this.docs = new Map();
  }

  async get(id) {
    return this.docs.get(id) ?? null;
  }

  async set(id, value) {
    this.docs.set(id, value);
  }

  async cas(id, expected, next) {
    const current = this.docs.get(id) ?? null;
    if (current === null || current.version !== expected) return { ok: false, current };
    this.docs.set(id, next);
    return { ok: true, doc: next };
  }

  async delete(id, expected) {
    const current = this.docs.get(id) ?? null;
    if (current === null || (expected !== undefined && current.version !== expected)) return false;
    return this.docs.delete(id);
  }

  async query() {
    const items = [...this.docs.values()];
    return { items, total: items.length };
  }
}

async function execute(tool) {
  const events = [];
  for await (const event of tool.executor.execute({}, {
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

const tools = new Map();
const frontends = [];
await plugin.setup({
  isSubAgent() {
    return false;
  },
  createStore(namespace) {
    assert.equal(namespace, "remembered_facts");
    return new MemoryStore();
  },
  tools: {
    register(tool) {
      tools.set(tool.name, tool);
    },
  },
  registerFrontend(frontend) {
    frontends.push(frontend);
  },
});

const openTool = tools.get("open_memory_browser");
assert.ok(openTool, "open_memory_browser should be registered");
const openEvents = await execute(openTool);
const opened = openEvents.find(event => event.type === "result")?.value;
const expectedPort = Number(process.env.MATBOT_MEMORY_BROWSER_PORT);
assert.ok(Number.isInteger(expectedPort) && expectedPort > 0, "the isolated lifecycle port is required");
assert.deepEqual(opened, { url: `http://127.0.0.1:${expectedPort}` });
assert.deepEqual(frontends, [{ name: "memory-browser" }]);

const health = await fetch(`${opened.url}/api/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: "ok" });

await plugin.teardown();

const closedEvents = await execute(openTool);
assert.match(
  closedEvents.find(event => event.type === "error")?.message ?? "",
  /not running/i,
);
await assert.rejects(fetch(`${opened.url}/api/health`), /fetch failed/i);

console.log("memory-browser plugin opens on its configured loopback port and closes with plugin teardown");
