import { expect, test } from "@playwright/test";

await import("../../local-agent/matbot/apps/cli/register.js");
const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import("../../local-agent/matbot/packages/core/plugin-api/src/index.ts");
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "memory-browser-ui-test", type: "user" }));
const { createMemoryBrowserServer } = await import("../../local-agent/matbot/packages/plugins/memory-browser/src/index.ts");

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
    if (query.sort?.[0]) {
      const { field, dir } = query.sort[0];
      items.sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")) * (dir === "asc" ? 1 : -1));
    }
    const limit = query.limit ?? items.length;
    return { items: items.slice(0, limit), total: items.length };
  }
}

async function start(store) {
  const server = createMemoryBrowserServer(store, { id: "memory-browser-ui-test", type: "user" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("memory browser did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test("MISSING-11 standalone memory browser renders and reconciles cross-tab CAS conflicts", async ({ page }) => {
  const store = new MemoryStore();
  await store.set("shared", {
    id: "shared",
    version: "v1",
    fact: "Shared original",
    sessionId: "session-a",
    messageId: "message-a",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  await store.set("other", {
    id: "other",
    version: "v1",
    fact: "A second browser memory",
    sessionId: "session-b",
    messageId: "message-b",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const service = await start(store);
  const second = await page.context().newPage();

  try {
    const documentResponse = await page.goto(`${service.baseUrl}/`, { waitUntil: "networkidle" });
    expect(documentResponse?.status()).toBe(200);
    expect(documentResponse?.headers()["content-type"] ?? "").toMatch(/^text\/html/);
    await expect(page).toHaveTitle("Cortex Memory Browser");
    await expect(page.locator("h1")).toHaveText("Memories");
    await expect(page.locator(".memory-item", { hasText: "Shared original" })).toBeVisible();
    await expect(page.locator("#count-label")).toHaveText("2 of 2");
    await expect(page.locator("#fact-input")).toHaveValue("Shared original");
    await expect(page.locator("#session-id")).toHaveValue("session-a");

    await second.goto(`${service.baseUrl}/`, { waitUntil: "networkidle" });
    await expect(second.locator("#fact-input")).toHaveValue("Shared original");
    await second.locator("#fact-input").fill("Shared first writer");
    await second.locator("#save-btn").click();
    await expect(second.locator("#status")).toHaveText("Saved.");
    expect((await (await fetch(`${service.baseUrl}/api/memories/shared`)).json()).fact).toBe("Shared first writer");

    await page.locator("#fact-input").fill("Shared stale writer");
    await page.locator("#save-btn").click();
    await expect(page.locator("#status")).toContainText("Version conflict");
    await expect(page.locator("#fact-input")).toHaveValue("Shared first writer");
    await expect(page.locator("#detail-form")).toBeVisible();

    // A stale delete must preserve and refresh the selected record rather than
    // presenting a false success after another tab has changed it.
    const firstWriter = await (await fetch(`${service.baseUrl}/api/memories/shared`)).json();
    const externalUpdate = await fetch(`${service.baseUrl}/api/memories/shared`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected: firstWriter.version, fact: "Shared newer server version" }),
    });
    expect(externalUpdate.status).toBe(200);
    const externalVersion = await externalUpdate.json();
    page.once("dialog", dialog => { void dialog.accept(); });
    await page.locator("#delete-btn").click();
    await expect(page.locator("#status")).toContainText("Delete did not apply");
    await expect(page.locator("#fact-input")).toHaveValue("Shared newer server version");
    await expect(page.locator("#detail-form")).toBeVisible();
    await expect(page.locator(".memory-item")).toHaveCount(2);

    // If another tab really did delete the latest version, the stale page must
    // remove its dead selection instead of leaving an editable ghost record.
    const externalDelete = await fetch(`${service.baseUrl}/api/memories/shared`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected: externalVersion.version }),
    });
    expect(await externalDelete.json()).toEqual({ deleted: true });
    page.once("dialog", dialog => { void dialog.accept(); });
    await page.locator("#delete-btn").click();
    await expect(page.locator("#status")).toContainText("already deleted");
    await expect(page.locator("#detail-form")).toBeHidden();
    await expect(page.locator(".memory-item")).toHaveCount(1);
  } finally {
    await second.close();
    await service.close();
  }
});
