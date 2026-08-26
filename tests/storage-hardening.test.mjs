/**
 * Storage hardening tests (H7, H8, M35, M39).
 *
 * - SQLiteFileStore.put rejects oversized streams while streaming (fail-fast,
 *   before the whole file is buffered).
 * - SQLiteFileStore versions are content-derived: equal-size writes with
 *   distinct content get distinct CAS versions.
 * - SQLiteFileStore.watch returns promptly on a pre-aborted signal.
 * - FilesystemStore.set serialises through the same per-id lock as cas/delete.
 * - skills-node watcher treats transient readdir failures as retryable and
 *   creates a missing skills directory at startup.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";import { join } from "node:path";

await import("../local-agent/matbot/apps/cli/register.js");
const { DatabaseSync } = await import("node:sqlite");
const { SQLiteFileStore } = await import("../local-agent/matbot/packages/plugins/storage/sqlite/src/file-store.ts");
const { FilesystemStore } = await import("../local-agent/matbot/packages/plugins/storage/filesystem/src/store.ts");
const { watchAndImportSkillDir } = await import("../local-agent/matbot/packages/plugins/skills-node/src/watcher.ts");

function chunksOf(bytes, chunkSize) {
  const out = [];
  for (let i = 0; i < bytes; i += chunkSize) out.push(Buffer.alloc(Math.min(chunkSize, bytes - i)));
  return out;
}

async function* streamOf(chunks) {
  for (const c of chunks) yield c;
}

test("sqlite put rejects streams exceeding maxBytes while streaming", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new SQLiteFileStore(db, { maxBytes: 1024 });

  let consumed = 0;
  async function* stream() {
    for (let i = 0; i < 100; i++) {
      consumed++;
      yield Buffer.alloc(64);
    }
  }

  await assert.rejects(() => store.put(undefined, "text/plain", stream()), /maximum size of 1024/);
  // Fail-fast: 100 chunks x 64 B would only cross 1024 B around chunk 17 —
  // if the store buffered everything first this would be ~100.
  assert.ok(consumed < 30, `expected early rejection, consumed ${consumed} chunks`);
  for await (const _ of store.list()) assert.fail("no file should have been written");
});

test("sqlite distinct-content equal-size writes yield distinct CAS versions", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new SQLiteFileStore(db);

  const h1 = await store.put("f", "text/plain", streamOf([Buffer.from("aaaa")]));
  const h2 = await store.put("f", "text/plain", streamOf([Buffer.from("bbbb")]));

  // Legacy size-derived versions would collide here.
  assert.equal(h1.size, h2.size);
  assert.notEqual(h1.version, h2.version);
  assert.notEqual(h1.version, String(h1.size));

  // A handle held across an update is stale: its version must not match current state.
  const current = await store.getByName("f");
  assert.equal(current.id, h2.id);
  assert.notEqual(current.version, h1.version);
  assert.equal(current.version, h2.version);

  // Deterministic: identical content maps to the identical version.
  const h3 = await store.put("f", "text/plain", streamOf([Buffer.from("bbbb")]));
  assert.equal(h3.version, h2.version);
});

test("sqlite watch returns promptly on a pre-aborted signal", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new SQLiteFileStore(db);
  const ctrl = new AbortController();
  ctrl.abort();

  const start = Date.now();
  let events = 0;
  for await (const _ of store.watch(ctrl.signal)) events++;
  assert.ok(Date.now() - start < 500, "watch hung on a pre-aborted signal");
  assert.equal(events, 0);
});

test("filesystem set serialises concurrent writes through the per-id lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsstore-lock-"));
  const store = new FilesystemStore(dir);

  const trace = [];
  store.writeAtomic = async () => {
    trace.push("enter");
    await new Promise(r => setTimeout(r, 10));
    trace.push("exit");
  };

  await Promise.all([
    store.set("doc", { id: "doc", version: "1" }),
    store.set("doc", { id: "doc", version: "2" }),
  ]);

  // Without the per-id lock the two write windows would interleave
  // (enter, enter, ...); the lock forces full serialisation.
  assert.deepEqual(trace, ["enter", "exit", "enter", "exit"]);
});

test("skills-node watcher retries transient readdir failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-watch-"));
  await writeFile(join(dir, "test-skill.md"), "# Test Skill\n\nbody");

  const imported = [];
  const known = new Set();
  const manager = {
    get: name => (known.has(name) ? { name } : undefined),
    importIfAbsent: async (name, content) => { known.add(name); imported.push({ name, content }); },
  };

  let readdirCalls = 0;
  const flakyReaddir = async d => {
    readdirCalls++;
    if (readdirCalls === 1) throw Object.assign(new Error("transient EACCES"), { code: "EACCES" });
    return readdir(d);
  };
  // Simulate fs.watch being unavailable so the watcher exercises its polling path.
  async function* brokenWatch() { throw new Error("watch unavailable"); yield undefined; }

  const ctrl = new AbortController();
  const done = watchAndImportSkillDir(dir, manager, ctrl.signal, 5, {
    readdir: flakyReaddir,
    watch: brokenWatch,
  });

  // The first readdir failure must not kill the watcher: it warns, sleeps, retries,
  // and imports on the successful pass.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`watcher never imported the skill (${readdirCalls} readdir calls)`)), 2000);
    const iv = setInterval(() => {
      if (imported.length > 0) { clearInterval(iv); clearTimeout(timer); resolve(); }
    }, 10);
  });

  ctrl.abort();
  await done;

  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, "Test Skill");
});

test("skills-node watcher creates a missing skills dir at startup", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "skills-watch-")), "created-by-watcher");

  const manager = {
    get: () => undefined,
    importIfAbsent: async () => {},
  };
  const ctrl = new AbortController();
  ctrl.abort(); // pre-aborted: watcher does one setup pass then exits
  async function* brokenWatch() { throw new Error("watch unavailable"); yield undefined; }

  await watchAndImportSkillDir(dir, manager, ctrl.signal, 5, { watch: brokenWatch });

  assert.ok(existsSync(dir), "watcher should mkdir -p the skill dir at startup");
});
