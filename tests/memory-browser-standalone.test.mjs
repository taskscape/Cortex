import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import("../local-agent/matbot/packages/core/plugin-api/src/index.ts");
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "memory-browser-test", type: "user" }));
const { createMemoryBrowserServer } = await import("../local-agent/matbot/packages/plugins/memory-browser/src/index.ts");

class MemoryStore {
  constructor() { this.docs = new Map(); }
  async get(id) { return this.docs.get(id) ?? null; }
  async set(id, value) { this.docs.set(id, structuredClone(value)); }
  async cas(id, expected, next) {
    const current = this.docs.get(id) ?? null;
    if (!current || current.version !== expected) return { ok: false, current };
    this.docs.set(id, structuredClone(next));
    return { ok: true, doc: next };
  }
  async delete(id, expected) {
    const current = this.docs.get(id) ?? null;
    if (!current || (expected !== undefined && current.version !== expected)) return false;
    return this.docs.delete(id);
  }
  async query(query = {}) {
    let items = [...this.docs.values()];
    if (query.where) items = items.filter(item => matches(item, query.where));
    if (query.sort?.[0]) {
      const { field, dir } = query.sort[0];
      items.sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * (dir === "asc" ? 1 : -1));
    }
    const limit = query.limit ?? items.length;
    return { items: items.slice(0, limit), total: items.length };
  }
}

function matches(item, filter) {
  if (filter.op === "stringContains") return String(item[filter.field] ?? "").toLowerCase().includes(String(filter.value).toLowerCase());
  if (filter.op === "exists") return (item[filter.field] !== undefined) === Boolean(filter.value);
  if (filter.op === "and") return filter.clauses.every(clause => matches(item, clause));
  return true;
}

async function start(store) {
  const server = createMemoryBrowserServer(store, { id: "memory-test", type: "user" });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("memory browser did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

/**
 * Validates that the standalone memory browser correctly provides health checks,
 * filtering, CRUD operations, and version-aware updates (CAS) for memory records.
 *
 * This test ensures:
 * - Health endpoint returns status OK
 * - Filtering works correctly (by state, query text, limit)
 * - Workspace isolation is maintained (each service uses only its injected store)
 * - CRUD operations work (create, read, update, delete)
 * - Version-aware updates (CAS) work correctly (stale writes are rejected)
 *
 * Assumptions:
 * - The createMemoryBrowserServer() function creates a standalone HTTP server
 * - The test creates two separate memory stores (workspace A and workspace B)
 * - The test verifies that workspace A cannot see workspace B's memories
 * - Success is indicated by all HTTP requests returning the expected responses
 */
test("MISSING-11 standalone memory browser provides health, filtering, CRUD, and version-aware updates", async t => {
  const store = new MemoryStore();
  const otherWorkspaceStore = new MemoryStore();
  await store.set("processed", { id: "processed", version: "v1", fact: "Processed alpha", sessionId: "s", messageId: "m", createdAt: "2026-01-01T00:00:00.000Z", dreamSkill: "Operations" });
  await store.set("ignored", { id: "ignored", version: "v1", fact: "Ignored beta", sessionId: "s", messageId: "m", createdAt: "2026-01-02T00:00:00.000Z", ignoreUntil: "2026-12-01T00:00:00.000Z" });
  const service = await start(store);
  t.after(() => service.close());
  const otherWorkspace = await start(otherWorkspaceStore);
  t.after(() => otherWorkspace.close());
  await otherWorkspaceStore.set("other-workspace", { id: "other-workspace", version: "v1", fact: "Workspace B private", sessionId: "b", messageId: "b", createdAt: "2026-01-03T00:00:00.000Z" });

  assert.deepEqual(await (await fetch(`${service.baseUrl}/api/health`)).json(), { status: "ok" });
  const processed = await (await fetch(`${service.baseUrl}/api/memories?state=processed&q=alpha`)).json();
  assert.equal(processed.total, 1);
  assert.equal(processed.items[0].id, "processed");
  const ignored = await (await fetch(`${service.baseUrl}/api/memories?state=ignored`)).json();
  assert.equal(ignored.items[0].id, "ignored");
  const encoded = await (await fetch(`${service.baseUrl}/api/memories?q=${encodeURIComponent("Processed alpha")}&limit=1`)).json();
  assert.equal(encoded.total, 1);
  assert.equal(encoded.items.length, 1);
  const workspaceAList = await (await fetch(`${service.baseUrl}/api/memories?limit=200`)).json();
  assert.ok(!workspaceAList.items.some(item => item.id === "other-workspace"), "a standalone service uses only its injected workspace store");
  const workspaceBList = await (await fetch(`${otherWorkspace.baseUrl}/api/memories?limit=200`)).json();
  assert.deepEqual(workspaceBList.items.map(item => item.id), ["other-workspace"]);

  const invalidCreate = await fetch(`${service.baseUrl}/api/memories`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: "" }) });
  assert.equal(invalidCreate.status, 400);
  const notFound = await fetch(`${service.baseUrl}/api/memories/${encodeURIComponent("missing id")}`);
  assert.equal(notFound.status, 404);

  const create = await fetch(`${service.baseUrl}/api/memories`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: "Manual gamma" }) });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.sessionId, "manual");

  const stale = await fetch(`${service.baseUrl}/api/memories/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected: "stale", fact: "Should not persist" }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).current.fact, "Manual gamma");

  const updatedResponse = await fetch(`${service.baseUrl}/api/memories/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected: created.version, fact: "Manual gamma updated", dreamSkill: "Operations" }) });
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.equal(updated.fact, "Manual gamma updated");
  assert.notEqual(updated.version, created.version);

  const staleDelete = await fetch(`${service.baseUrl}/api/memories/${created.id}?expected=${encodeURIComponent(created.version)}`, { method: "DELETE" });
  assert.deepEqual(await staleDelete.json(), { deleted: false });
  const deleteResponse = await fetch(`${service.baseUrl}/api/memories/${created.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected: updated.version }) });
  assert.deepEqual(await deleteResponse.json(), { deleted: true });
});
