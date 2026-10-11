/**
 * Session listing cost: the sidebar's list must cost the number of sessions, not their size.
 *
 * This test ensures:
 * - Listing sessions reads each session file once; later listings read only the sessions that
 *   changed, whether this store wrote them or another writer on the same directory did
 * - The listing is identical to the one produced by reading every session in full, including the
 *   archived filter, untitled sessions, long previews and unreadable files
 * - The capability reaches the session tool through the capture-safe store proxy, and a store
 *   without it is still listed correctly
 * - `queryProjected` filters, sorts and pages over the projected values, hands out frozen values,
 *   keeps nothing from a call that failed, and does not re-read a corrupt file until it changes
 * - The store's own writes are reflected even on a filesystem that cannot tell two writes of a
 *   file apart, including a write that lands while a listing is running
 *
 * Assumptions:
 * - The real FilesystemStore and session tool are exercised against a temporary directory
 * - `fs.promises.readFile` and `fs.promises.stat` are wrapped to count reads of session files
 *   and to simulate a filesystem with indistinguishable file identities; the store looks both up
 *   at call time, so wrapping them after import is effective
 */
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { makeSwappable } = await import("../local-agent/matbot/packages/core/plugin-api/src/index.ts");
const { FilesystemStore } = await import("../local-agent/matbot/packages/plugins/storage/filesystem/src/store.ts");
const { makeSessionTools } = await import("../local-agent/matbot/packages/plugins/sessions/src/tools.ts");

const realReadFile = fsPromises.readFile;
const realStat = fsPromises.stat;
let reads = [];
let statOverride;
fsPromises.readFile = (target, ...rest) => {
  if (String(target).endsWith(".json")) reads.push(path.basename(String(target)));
  return realReadFile(target, ...rest);
};
fsPromises.stat = (target, ...rest) => (statOverride ? statOverride(target, rest) : realStat(target, ...rest));

async function temporaryDirectory(t, label) {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), `cortex-session-list-${label}-`));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

let clock = Date.parse("2026-01-01T00:00:00.000Z");
function nextTimestamp() {
  clock += 60_000;
  return new Date(clock).toISOString();
}

/** A session whose stored size is dominated by its conversation, as real ones are. */
function session(id, { title, text = `question from ${id}`, status = "active", bulk = 20_000 } = {}) {
  const now = nextTimestamp();
  return {
    id,
    version: `v-${id}-${clock}`,
    ownerPrincipalId: "tester",
    status,
    contexts: [],
    messages: [
      { id: `${id}-m0`, role: "marker", createdAt: now, traceId: "t", content: [{ type: "marker", creator: "test", data: {} }] },
      { id: `${id}-m1`, role: "user", createdAt: now, traceId: "t", content: [{ type: "text", text }] },
      { id: `${id}-m2`, role: "assistant", createdAt: now, traceId: "t", content: [{ type: "text", text: "x".repeat(bulk) }] },
    ],
    createdAt: now,
    updatedAt: now,
    ...(title !== undefined ? { title } : {}),
  };
}

async function list(store, input = {}) {
  const [tool] = makeSessionTools(store);
  const events = [];
  for await (const event of tool.executor.execute({ action: "list", ...input }, {})) events.push(event);
  assert.equal(events.length, 1, `expected one event, got ${JSON.stringify(events)}`);
  assert.equal(events[0].type, "result", `listing failed: ${JSON.stringify(events[0])}`);
  return events[0].value;
}

/** The same documents, behind a store that offers nothing beyond the basic contract. */
function withoutProjection(store) {
  return {
    get: id => store.get(id),
    set: (id, value) => store.set(id, value),
    cas: (id, expected, next) => store.cas(id, expected, next),
    delete: (id, expectedVersion) => store.delete(id, expectedVersion),
    query: q => store.query(q),
  };
}

test("listing reads each session once, then only the sessions that changed", async t => {
  const directory = await temporaryDirectory(t, "reads");
  const store = new FilesystemStore(directory);
  const ids = Array.from({ length: 12 }, (_unused, index) => `session-${index}`);
  for (const id of ids) await store.set(id, session(id, { title: `Title ${id}` }));

  reads = [];
  const first = await list(store);
  assert.equal(first.length, ids.length);
  assert.equal(reads.length, ids.length, "the first listing reads every session");

  reads = [];
  assert.deepEqual(await list(store), first);
  assert.deepEqual(reads, [], "an unchanged directory is listed without opening a session");

  // This store renames one session.
  const renamed = { ...(await store.get("session-3")), title: "Renamed here", version: "v-renamed", updatedAt: nextTimestamp() };
  await store.set("session-3", renamed);
  reads = [];
  const afterRename = await list(store);
  assert.deepEqual(reads, ["session-3.json"], "only the session that changed is read again");
  assert.equal(afterRename[0].id, "session-3", "the renamed session is now the most recent");
  assert.equal(afterRename[0].title, "Renamed here");

  // Another writer on the same directory — a background job in its own process — changes one
  // session, adds one and removes one. Nothing tells this store; the files do.
  const other = new FilesystemStore(directory);
  await other.set("session-7", { ...(await other.get("session-7")), title: "Changed elsewhere", version: "v-elsewhere", updatedAt: nextTimestamp() });
  await other.set("session-new", session("session-new", { title: "Added elsewhere" }));
  await other.delete("session-0");
  reads = [];
  const afterOther = await list(store);
  assert.deepEqual([...reads].sort(), ["session-7.json", "session-new.json"]);
  assert.equal(afterOther.find(item => item.id === "session-7").title, "Changed elsewhere");
  assert.equal(afterOther[0].id, "session-new");
  assert.equal(afterOther.some(item => item.id === "session-0"), false, "a deleted session leaves the listing");
  assert.equal(afterOther.length, ids.length);

  reads = [];
  assert.deepEqual(await list(store), afterOther);
  assert.deepEqual(reads, []);
});

test("the listing is identical to the one made by reading every session in full", async t => {
  const directory = await temporaryDirectory(t, "equivalence");
  const store = new FilesystemStore(directory);
  await store.set("plain", session("plain", { title: "Plain" }));
  await store.set("untitled", session("untitled"));
  await store.set("archived", session("archived", { title: "Archived", status: "archived" }));
  await store.set("long", session("long", { title: "Long", text: "a very long first question ".repeat(8) }));
  await store.set("needs:encoding", session("needs:encoding", { title: "Encoded id" }));
  await store.set("no-user-turn", { ...session("no-user-turn", { title: "Empty" }), messages: [] });
  await fsPromises.writeFile(path.join(directory, "corrupt.json"), "{ not json");

  for (const input of [{}, { includeArchived: true }, { includeArchived: false }]) {
    const projected = await list(store, input);
    const full = await list(withoutProjection(store), input);
    assert.deepEqual(projected, full, `listing differs for ${JSON.stringify(input)}`);
    assert.deepEqual(JSON.parse(JSON.stringify(projected)), JSON.parse(JSON.stringify(full)), "and serialises identically");
  }

  const visible = await list(store);
  assert.deepEqual(visible.map(item => item.id), ["no-user-turn", "needs:encoding", "long", "untitled", "plain"]);
  assert.deepEqual(Object.keys(visible[0]), ["id", "title", "preview", "updatedAt"]);
  assert.equal(visible.find(item => item.id === "long").preview.length, 61, "previews are still cut at 60 characters plus an ellipsis");
  assert.equal(visible.find(item => item.id === "untitled").title, undefined);
  assert.equal(visible.find(item => item.id === "no-user-turn").preview, "");
  assert.equal((await list(store, { includeArchived: true })).length, 6);
});

test("the session tool finds the capability through the store proxy and works without it", async t => {
  const directory = await temporaryDirectory(t, "proxy");
  const files = new FilesystemStore(directory);
  for (const id of ["a", "b", "c"]) await files.set(id, session(id, { title: id.toUpperCase() }));

  const [proxy, swap] = makeSwappable(files);
  const expected = await list(withoutProjection(files));
  assert.deepEqual(await list(proxy), expected);
  reads = [];
  assert.deepEqual(await list(proxy), expected);
  assert.deepEqual(reads, [], "listing through the proxy uses the store's projections");

  // The backend is swapped for one with only the basic contract.
  swap(withoutProjection(files));
  reads = [];
  assert.deepEqual(await list(proxy), expected);
  assert.equal(reads.length, 3, "a store without the capability is listed by reading its sessions");
});

test("queryProjected queries the projected values and keeps nothing from a failed call", async t => {
  const directory = await temporaryDirectory(t, "store");
  const store = new FilesystemStore(directory);
  for (let index = 0; index < 5; index++) {
    await store.set(`doc-${index}`, { id: `doc-${index}`, version: `v${index}`, rank: index, kind: index % 2 === 0 ? "even" : "odd", body: "y".repeat(5_000) });
  }
  const slim = { key: "slim/1", select: doc => ({ id: doc.id, version: doc.version, rank: doc.rank, kind: doc.kind }) };

  const page = await store.queryProjected(slim, { where: { op: "eq", field: "kind", value: "even" }, sort: [{ field: "rank", dir: "desc" }], limit: 2 });
  assert.deepEqual(page.items.map(item => item.id), ["doc-4", "doc-2"]);
  assert.equal(page.total, 3);
  assert.equal(typeof page.cursor, "string");
  const rest = await store.queryProjected(slim, { cursor: page.cursor });
  assert.deepEqual(rest.items.map(item => item.id), ["doc-0"]);
  assert.equal("body" in page.items[0], false, "only the projected fields are returned");
  assert.equal(Object.isFrozen(page.items[0]), true);
  assert.throws(() => { page.items[0].rank = 99; }, TypeError, "a kept value cannot be modified by a caller");

  // A different projection of the same documents is computed and kept separately.
  reads = [];
  const ids = await store.queryProjected({ key: "ids/1", select: doc => ({ id: doc.id, version: doc.version }) }, {});
  assert.equal(reads.length, 5);
  assert.deepEqual(Object.keys(ids.items[0]), ["id", "version"]);
  reads = [];
  await store.queryProjected(slim, {});
  assert.deepEqual(reads, [], "the first projection's values were not disturbed");

  // A projection that fails on one document fails the call, and the call leaves nothing behind.
  const failing = { key: "failing/1", select: doc => { if (doc.id === "doc-3") throw new Error("cannot reduce doc-3"); return { id: doc.id, version: doc.version }; } };
  await assert.rejects(store.queryProjected(failing, {}), /cannot reduce doc-3/);
  failing.select = doc => ({ id: doc.id, version: doc.version });
  // Let whatever the failed call still had in flight settle before counting again.
  await new Promise(resolve => setTimeout(resolve, 50));
  reads = [];
  assert.equal((await store.queryProjected(failing, {})).items.length, 5);
  assert.equal(reads.length, 5, "values computed by the failed call were not kept");

  // A corrupt file is skipped, and not read again until it changes.
  await fsPromises.writeFile(path.join(directory, "broken.json"), "{ not json");
  reads = [];
  assert.equal((await store.queryProjected(slim, {})).items.length, 5);
  assert.deepEqual(reads, ["broken.json"]);
  reads = [];
  assert.equal((await store.queryProjected(slim, {})).items.length, 5);
  assert.deepEqual(reads, [], "an unchanged corrupt file is not re-read");
  await new Promise(resolve => setTimeout(resolve, 20));
  await fsPromises.writeFile(path.join(directory, "broken.json"), JSON.stringify({ id: "broken", version: "v", rank: 9, kind: "odd" }));
  assert.equal((await store.queryProjected(slim, {})).items.length, 6, "once repaired it is listed");

  // An empty or missing namespace lists nothing.
  const empty = new FilesystemStore(path.join(directory, "nothing-here"));
  assert.deepEqual(await empty.queryProjected(slim, {}), { items: [], total: 0 });
});

test("the store's own writes show up even where the filesystem cannot tell two writes apart", async t => {
  const directory = await temporaryDirectory(t, "coarse");
  const store = new FilesystemStore(directory);
  for (const id of ["a", "b", "c"]) await store.set(id, session(id, { title: `first ${id}` }));

  // Every file reports one and the same identity, whatever is written to it.
  const frozenIdentity = { mtimeNs: 1n, size: 1n, ino: 1n };
  let onStat;
  statOverride = async target => {
    await onStat?.(path.basename(String(target)));
    return frozenIdentity;
  };
  t.after(() => { statOverride = undefined; });

  assert.deepEqual((await list(store)).map(item => item.title).sort(), ["first a", "first b", "first c"]);
  reads = [];
  await list(store);
  assert.deepEqual(reads, [], "with identities frozen, nothing looks changed");

  await store.set("b", { ...(await store.get("b")), title: "second b", version: "v-second" });
  reads = [];
  const afterWrite = await list(store);
  assert.deepEqual(reads, ["b.json"], "the store's own write is read again regardless");
  assert.equal(afterWrite.find(item => item.id === "b").title, "second b");

  // A write that lands while a listing is running: the listing has already looked at `a` when the
  // write completes, and is still waiting on `c`.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let looked = 0;
  onStat = async name => {
    looked++;
    if (name === "c.json") await held;
  };
  const running = list(store);
  while (looked < 3) await new Promise(resolve => setImmediate(resolve));
  onStat = undefined;
  await store.set("a", { ...(await store.get("a")), title: "second a", version: "v-second-a" });
  release();
  await running;

  reads = [];
  const afterRace = await list(store);
  assert.deepEqual(reads, ["a.json"], "what the interrupted listing saw of the written session was not kept");
  assert.equal(afterRace.find(item => item.id === "a").title, "second a");
});
