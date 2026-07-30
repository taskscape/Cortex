import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const {
  HIGH_CARDINALITY_NAMESPACES,
  HighCardinalityStorageBackend,
} = await import("../local-agent/matbot/packages/plugins/storage/high-cardinality/src/index.ts");

test("high-cardinality storage migrates source and graph records to SQLite while preserving ordinary filesystem stores", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-high-cardinality-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const dotData = path.join(root, ".data");
  const sourcesDir = path.join(dotData, "sources");
  const sessionsDir = path.join(dotData, "sessions");
  const projectionsDir = path.join(dotData, "context_graph_projection_ops");
  await mkdir(sourcesDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(projectionsDir, { recursive: true });

  const legacySource = { id: "source-legacy", version: "v1", title: "Legacy source" };
  const legacySession = { id: "session-legacy", version: "v1", title: "Legacy session" };
  await writeFile(path.join(sourcesDir, "source-legacy.json"), JSON.stringify(legacySource), "utf8");
  await writeFile(path.join(sessionsDir, "session-legacy.json"), JSON.stringify(legacySession), "utf8");
  for (const [index, updatedAt] of ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"].entries()) {
    await writeFile(path.join(projectionsDir, `legacy-projection-${index}.json`), JSON.stringify({
      id: `legacy-projection-${index}`,
      version: `projection-v${index}`,
      workspaceId: "private",
      operationType: "merge_entity",
      operationHash: `hash-${index}`,
      parameters: { id: "entity-1", updatedAt },
      updatedAt,
    }), "utf8");
  }

  let backend = await HighCardinalityStorageBackend.open(dotData);
  const sources = backend.createStore("sources");
  const sessions = backend.createStore("sessions");
  assert.deepEqual(await sources.get(legacySource.id), legacySource, "legacy source is imported");
  assert.deepEqual(await sessions.get(legacySession.id), legacySession, "ordinary stores retain filesystem data");
  assert.ok(HIGH_CARDINALITY_NAMESPACES.has("context_graph_relationship_assertions"));
  const projectionRows = await backend.createStore("context_graph_projection_ops").query({});
  assert.equal(projectionRows.total, 1, "legacy projection duplicates collapse to one stable target row");
  assert.equal(projectionRows.items[0].updatedAt, "2026-02-01T00:00:00.000Z");
  assert.match(projectionRows.items[0].id, /^context-neo4j-projection:/);

  const updatedSource = { ...legacySource, version: "v2", title: "SQLite source" };
  const newSession = { id: "session-new", version: "v1", title: "Filesystem session" };
  await sources.set(updatedSource.id, updatedSource);
  await sessions.set(newSession.id, newSession);
  await access(path.join(dotData, "high-cardinality.db"));
  await access(path.join(sessionsDir, "session-new.json"));
  assert.equal(
    JSON.parse(await readFile(path.join(sourcesDir, "source-legacy.json"), "utf8")).version,
    "v1",
    "migration retains the legacy recovery copy",
  );
  await backend.close();

  backend = await HighCardinalityStorageBackend.open(dotData);
  assert.deepEqual(
    await backend.createStore("sources").get(updatedSource.id),
    updatedSource,
    "a restart does not overwrite newer SQLite state with retained legacy JSON",
  );
  await backend.close();
});
