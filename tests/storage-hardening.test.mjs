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

const fileFs = await import('node:fs/promises').then(m => m.default);
const { syncBuiltinESMExports } = await import('node:module');
const { FilesystemFileStore } = await import('../local-agent/matbot/packages/plugins/files/src/store.ts');
async function readHandle(handle) {
  const chunks = []; for await (const chunk of handle.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
for (const phase of ['stream', 'blob-rename', 'manifest-write', 'manifest-rename']) {
  test(`REL-03 failed ${phase} preserves contents and metadata across restart`, async t => {
    const root = await fileFs.mkdtemp(join(tmpdir(), 'cortex-file-transaction-'));
    t.after(() => fileFs.rm(root, { recursive: true, force: true }));
    const store = new FilesystemFileStore(root);
    const before = await store.put('report.txt', 'text/plain', streamOf([Buffer.from('old')]), { allowed: true, namespace: 'workspace' });
    const rename = fileFs.rename, write = fileFs.writeFile;
    fileFs.rename = async (from, to) => {
      if ((phase === 'blob-rename' && String(to).endsWith('.blob')) || (phase === 'manifest-rename' && String(to).endsWith('.meta.json'))) throw new Error('injected rename failure');
      return rename(from, to);
    };
    fileFs.writeFile = async (file, ...args) => {
      if (phase === 'manifest-write' && String(file).includes('.meta.json.')) throw new Error('injected metadata write failure');
      return write(file, ...args);
    };
    syncBuiltinESMExports();
    try {
      async function* data() { yield Buffer.from('new'); if (phase === 'stream') throw new Error('injected stream failure'); }
      await assert.rejects(store.put('report.txt', 'application/json', data(), { allowed: false }), /injected/);
    } finally { fileFs.rename = rename; fileFs.writeFile = write; syncBuiltinESMExports(); }
    const after = await new FilesystemFileStore(root).get('report.txt');
    assert.equal(await readHandle(after), 'old'); assert.equal(after.mimeType, 'text/plain'); assert.equal(after.allowed, true);
    assert.equal(after.version, before.version);
    assert.equal((await fileFs.readdir(join(root, '.cortex-versions'))).length, 1, 'failed writes leave no version or temporary blob');
  });
}

test('REL-03 manifests publish consistent versions, preserve names, and serialize put/delete across instances', async t => {
  const root = await fileFs.mkdtemp(join(tmpdir(), 'cortex-file-versions-'));
  t.after(() => fileFs.rm(root, { recursive: true, force: true }));
  const store = new FilesystemFileStore(root), second = new FilesystemFileStore(root);
  const first = await store.put('folder/report.txt', 'text/plain', streamOf([Buffer.from('first')]));
  const updated = await second.put('folder/report.txt', 'application/json', streamOf([Buffer.from('second')]));
  assert.equal(updated.id, first.id); assert.equal(updated.createdAt, first.createdAt);
  assert.equal(await readHandle(first), 'first'); assert.equal(await readHandle(updated), 'second');
  assert.equal((await store.getByName(first.name)).version, updated.version);
  let release, started;
  const gate = new Promise(r => release = r), begun = new Promise(r => started = r);
  async function* blocked() { started(); await gate; yield Buffer.from('third'); }
  const writing = store.put(first.name, 'text/plain', blocked());
  await begun;
  const deleting = second.delete(first.name);
  release(); await writing; await deleting;
  assert.equal(await store.get(first.name), null);
});

test('REL-03 cleanup retains referenced versions and corrupt metadata is reported', async t => {
  const root = await fileFs.mkdtemp(join(tmpdir(), 'cortex-file-gc-'));
  t.after(() => fileFs.rm(root, { recursive: true, force: true }));
  const store = new FilesystemFileStore(root);
  await store.put('kept', 'text/plain', streamOf([Buffer.from('retained')]));
  const meta = JSON.parse(await fileFs.readFile(join(root, 'kept.meta.json'), 'utf8'));
  const orphan = join(root, '.cortex-versions', '00000000-0000-0000-0000-000000000000.blob');
  await fileFs.writeFile(orphan, 'orphan');
  const old = new Date(Date.now() - 48 * 3600_000);
  await fileFs.utimes(join(root, meta.dataFile), old, old); await fileFs.utimes(orphan, old, old);
  for await (const _ of new FilesystemFileStore(root).list()) {}
  assert.equal(existsSync(orphan), false); assert.equal(existsSync(join(root, meta.dataFile)), true);
  await fileFs.writeFile(join(root, 'broken.meta.json'), '{broken');
  await assert.rejects(store.get('broken'), /Cannot read metadata/);
});

test('REL-03 legacy named and anonymous entries remain readable and migrate on overwrite', async t => {
  const root = await fileFs.mkdtemp(join(tmpdir(), 'cortex-file-legacy-'));
  t.after(() => fileFs.rm(root, { recursive: true, force: true }));
  await fileFs.writeFile(join(root, 'named.txt'), 'legacy named');
  await fileFs.writeFile(join(root, 'named.txt.meta.json'), JSON.stringify({ mimeType: 'text/plain' }));
  await fileFs.writeFile(join(root, 'anon.data'), 'legacy anonymous');
  await fileFs.writeFile(join(root, 'anon.meta.json'), JSON.stringify({ mimeType: 'text/plain', id: 'anon' }));
  const store = new FilesystemFileStore(root);
  assert.equal(await readHandle(await store.get('named.txt')), 'legacy named');
  assert.equal(await readHandle(await store.get('anon')), 'legacy anonymous');
  await store.put('named.txt', 'text/plain', streamOf([Buffer.from('updated')]));
  assert.equal(await readHandle(await store.get('named.txt')), 'updated');
});
