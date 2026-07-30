import assert from "node:assert/strict";

const port = Number(process.argv[2]);
assert.ok(Number.isInteger(port) && port > 0, "a valid generated web port is required");

const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import(
  "../local-agent/matbot/packages/core/plugin-api/src/index.ts"
);
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "webui-port-config-test", type: "user" }));
const { plugin } = await import("../local-agent/matbot/packages/plugins/frontend/web/src/plugin.ts");

const tools = new Map();
const sessions = {
  async get() { return null; },
  async set() {},
  async cas() { return { ok: false, current: null }; },
  async delete() { return false; },
  async query() { return { items: [], total: 0 }; },
};
const services = {
  sessions,
  run: {},
  Vault: {},
  tools: {
    register(tool) { tools.set(tool.name, tool); },
    remove(name) { tools.delete(name); },
    async *watch() {},
  },
  isSubAgent() { return false; },
  registerFrontend() {},
  async loadPlugin() { throw new Error("not used by the configuration probe"); },
  async unloadPlugin() { return false; },
  get() { return undefined; },
};

try {
  await plugin.setup(services);
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const branding = await (await fetch(`${baseUrl}/branding`)).json();
  assert.deepEqual(branding, {
    productName: "Port Test Cortex",
    title: "Port Test Console",
    brand: "#123abc",
  });
  assert.ok(tools.has("url_for_resource"), "the configured listener must complete frontend setup");
} finally {
  await plugin.teardown();
}

console.log(`frontend plugin served configured port ${port}`);
