import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-filesystem-store-"));
  try {
    await idsWithSeparatorsRoundTrip(root);
    await encodingIsCollisionFree(root);
    await overlongIdsRoundTrip(root);
    await emptyIdIsRejected(root);
    await sourceRegistryPersistsThroughFilesystemStore(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
console.log("filesystem store persists prefixed record ids and the source registry survives a real backend");
