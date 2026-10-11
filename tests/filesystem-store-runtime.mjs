import assert from "node:assert/strict";
import fsPromises, { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const { FilesystemStore } = await import("../local-agent/matbot/packages/plugins/storage/filesystem/src/store.ts");
const { plugin: sourceRegistryPlugin } = await import("../local-agent/matbot/packages/plugins/source-registry/src/index.ts");

function doc(id, extra = {}) {
  return { id, version: randomUUID(), ...extra };
}

// Record ids minted by the Cortex plugins carry a `<prefix>:<hash>` shape. The filesystem store has
// to persist them on Windows too, where `:` cannot appear in a file name.
async function idsWithSeparatorsRoundTrip(root) {
  const store = new FilesystemStore(path.join(root, "sources"));
  const id = "source:3a462d3898f02ec74b7056e239c681c0";

  await store.set(id, doc(id, { uri: "C:/docs/readme.md" }));
  const stored = await store.get(id);
  assert.equal(stored.id, id);
  assert.equal(stored.uri, "C:/docs/readme.md");

  const queried = await store.query({});
  assert.equal(queried.items.length, 1, "query must see records whose id needed encoding");
  assert.equal(queried.items[0].id, id);

  const next = doc(id, { uri: "C:/docs/changed.md" });
  const cas = await store.cas(id, stored.version, next);
  assert.equal(cas.ok, true);
  assert.equal((await store.get(id)).uri, "C:/docs/changed.md");

  assert.equal(await store.delete(id, next.version), true);
  assert.equal(await store.get(id), null);
}

// Encoding must stay injective: ids that differ only in the characters being encoded must not share
// a file, and a plain id must keep the file name it has always had.
async function encodingIsCollisionFree(root) {
  const dir = path.join(root, "encoding");
  const store = new FilesystemStore(dir);
  const ids = ["source:abc", "source%3Aabc", "source-abc", "sou/rce:abc", "źródło:abc"];

  for (const id of ids) await store.set(id, doc(id));
  for (const id of ids) assert.equal((await store.get(id)).id, id, `lost record for id ${id}`);

  const files = (await readdir(dir)).filter(name => name.endsWith(".json"));
  assert.equal(files.length, ids.length, `expected one file per id, got ${files.join(", ")}`);
  assert.ok(files.includes("source-abc.json"), "file-safe ids must keep their plain file name");

  const all = await store.query({});
  assert.deepEqual(all.items.map(item => item.id).sort(), [...ids].sort());
}

// An id longer than a file name may be falls back to a digest; it must still round-trip.
async function overlongIdsRoundTrip(root) {
  const store = new FilesystemStore(path.join(root, "long"));
  const long = `path:${"a:b".repeat(200)}`;
  await store.set(long, doc(long));
  assert.equal((await store.get(long)).id, long);
  assert.equal((await store.query({})).items.length, 1);
}

async function emptyIdIsRejected(root) {
  const store = new FilesystemStore(path.join(root, "empty"));
  await assert.rejects(() => store.set("", doc("")), /Invalid store id/);
}

// The scenario that failed in the WebUI: indexing a folder registers each markdown file as a source,
// and the registry persists those records through whatever StorageBackend is in force.
async function sourceRegistryPersistsThroughFilesystemStore(root) {
  const stores = new Map();
  const servicesByKey = new Map();
  const services = {
    configPath: path.join(root, "workspace", "matbot.yaml"),
    createStore(namespace) {
      if (!stores.has(namespace)) stores.set(namespace, new FilesystemStore(path.join(root, "registry", namespace)));
      return stores.get(namespace);
    },
    async register(key, value) {
      servicesByKey.set(key, value);
      this[key] = value;
    },
    get(key) {
      return servicesByKey.get(key);
    },
    tools: { register() {} },
    hooks: { register() {} },
  };

  await sourceRegistryPlugin.setup(services);
  const registry = services.SourceRegistry;

  const source = await registry.upsertSource({
    workspaceId: "default",
    connectorType: "workspace-rag",
    externalId: "workspace-rag:default:C:/docs/readme.md",
    uri: "C:/docs/readme.md",
    title: "readme.md",
    sourceKind: "document",
    schemaOrDocumentType: "markdown",
    healthState: "healthy",
  });
  assert.match(source.id, /^source:[0-9a-f]{32}$/);

  const version = await registry.upsertVersion({ sourceId: source.id, contentHash: "hash-1" });
  assert.equal(version.sourceId, source.id);
  await registry.recordHealth({ sourceId: source.id, state: "healthy", message: "Indexed." });

  assert.equal((await registry.getSource(source.id)).uri, "C:/docs/readme.md");
  const listed = await registry.querySources();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, source.id);
  assert.equal(listed[0].uri, "C:/docs/readme.md");
}

// A query reads the whole namespace. Unbounded, that is one open file handle per document at once,
// and reads that fail on the handle limit are dropped as if the files were corrupt.
async function largeNamespaceQueryReadsInBoundedBatches(root) {
  const store = new FilesystemStore(path.join(root, "large"));
  const total = 300;
  for (let index = 0; index < total; index++) await store.set(`doc-${index}`, doc(`doc-${index}`));

  const readFile = fsPromises.readFile;
  let inFlight = 0;
  let peak = 0;
  fsPromises.readFile = async (...args) => {
    peak = Math.max(peak, ++inFlight);
    try { return await readFile(...args); } finally { inFlight--; }
  };
  try {
    const result = await store.query({});
    assert.equal(result.items.length, total);
    assert.equal(new Set(result.items.map(item => item.id)).size, total);
  } finally {
    fsPromises.readFile = readFile;
  }
  assert.ok(peak > 1, "reads should still overlap");
  assert.ok(peak <= 32, `query opened ${peak} documents at once`);
}

// The per-id write lock must not retain an entry for every id the process has ever written.
async function writeLocksAreReleased(root) {
  const store = new FilesystemStore(path.join(root, "locks"));
  await Promise.all(Array.from({ length: 50 }, (_, index) => store.set(`doc-${index}`, doc(`doc-${index}`))));
  const contended = "doc-0";
  await Promise.all(Array.from({ length: 10 }, () => store.set(contended, doc(contended))));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.locks.size, 0);
}

// Windows fails a replace-by-rename while another process (antivirus, indexer) holds the target
// open. That window is milliseconds long, so the save must survive it rather than fail the turn.
async function transientRenameFailureIsRetried(root) {
  if (process.platform !== "win32") return;
  const store = new FilesystemStore(path.join(root, "rename"));
  const id = "session-1";
  await store.set(id, doc(id, { revision: 1 }));

  const rename = fsPromises.rename;
  let failures = 0;
  fsPromises.rename = async (...args) => {
    if (failures < 2) { failures++; throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); }
    return rename(...args);
  };
  try {
    await store.set(id, doc(id, { revision: 2 }));
  } finally {
    fsPromises.rename = rename;
  }
  assert.equal(failures, 2);
  assert.equal((await store.get(id)).revision, 2);

  // A failure that never clears is still reported, and no temp file is left behind.
  fsPromises.rename = async () => { throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); };
  try {
    await assert.rejects(() => store.set(id, doc(id, { revision: 3 })), /EPERM/);
  } finally {
    fsPromises.rename = rename;
  }
  assert.equal((await store.get(id)).revision, 2);
  assert.deepEqual((await readdir(path.join(root, "rename"))).filter(name => name.endsWith(".tmp")), []);
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-filesystem-store-"));
  try {
    await idsWithSeparatorsRoundTrip(root);
    await encodingIsCollisionFree(root);
    await overlongIdsRoundTrip(root);
    await emptyIdIsRejected(root);
    await largeNamespaceQueryReadsInBoundedBatches(root);
    await writeLocksAreReleased(root);
    await transientRenameFailureIsRetried(root);
    await sourceRegistryPersistsThroughFilesystemStore(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
console.log("filesystem store persists prefixed record ids and the source registry survives a real backend");
