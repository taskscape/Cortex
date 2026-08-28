import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");

process.env.CORTEX_RAG_DISABLE_CUDA = "true";
delete process.env.CORTEX_RAG_V2_MODE;
process.env.CORTEX_RAG_V2_STORAGE = "memory";

const { plugin } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts"
);

async function execute(tool, value) {
  const events = [];
  for await (const event of tool.executor.execute(value, {
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  const error = events.find(event => event.type === "error");
  if (error) throw new Error(error.message);
  return events.find(event => event.type === "result")?.value;
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs} ms`);
}

test("workspace_rag is V2-only, auto-reconciles configured folders, and exposes unified status", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-plugin-"));
  t.after(async () => {
    await plugin.teardown?.();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  const docs = path.join(root, "docs");
  await mkdir(workspace, { recursive: true });
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(workspace, "matbot.yaml"), "plugins:\n  - workspace-rag\n");
  await writeFile(path.join(docs, "contract.md"), [
    "# Distribution Agreement",
    "",
    "## Termination",
    "",
    "The distributor may terminate after sixty days written notice.",
  ].join("\n"));

  const tools = new Map();
  const registry = new Map();
  await plugin.setup({
    configPath: path.join(workspace, "matbot.yaml"),
    isSubAgent: () => false,
    async register(key, value) { registry.set(key, value); },
    get(key) { return registry.get(key); },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    hooks: { register() {} },
  });
  const tool = tools.get("workspace_rag");
  assert.ok(tool);
  for (const action of [
    "ingestion_start",
    "ingestion_pause",
    "ingestion_resume",
    "ingestion_cancel",
    "ingestion_retry",
    "ingestion_status",
    "reconcile_now",
    "corpus_census",
    "v2_search",
    "backend_gate_evaluate",
    "embedding_evict",
    "gc",
  ]) {
    assert.ok(tool.inputSchema.properties.action.enum.includes(action), `${action} must be exposed`);
  }

  const configured = await execute(tool, { action: "configure", contextName: "Contracts", paths: [docs] });
  assert.equal(configured.status.mode, "primary");
  assert.equal(configured.status.watcher.watchedRoots, 1);
  const census = await execute(tool, { action: "corpus_census" });
  assert.equal(census.files, 1);
  const status = await execute(tool, { action: "ingestion_wait" });
  assert.equal(status.activeState, "active_hybrid_complete");
  assert.equal(status.summaries.enabled, false);
  assert.equal(status.job.trigger, "configuration");
  assert.equal(status.job.addedFiles, 1);
  assert.equal(status.job.discoveryComplete, true);
  assert.equal(status.watcher.state, "active");
  assert.equal(status.indexedDocuments, 1, "status reports the documents held in the database");
  assert.equal(status.job.totalFiles, 1, "the denominator is counted before the scan starts");
  assert.equal(status.job.resumedFiles, 0);
  assert.equal(status.job.publishedCheckpoints, 0, "a corpus below the checkpoint interval publishes once");

  const missingRoot = path.join(root, "missing-root");
  await execute(tool, { action: "configure", contextName: "Contracts", paths: [docs, missingRoot] });
  const skippedRoot = await execute(tool, { action: "ingestion_wait" });
  assert.equal(skippedRoot.activeState, "active_hybrid_complete");
  assert.deepEqual(skippedRoot.job.skippedPaths, [path.resolve(missingRoot)]);
  assert.equal(skippedRoot.watcher.state, "active");
  assert.match(skippedRoot.message, /skipped 1 unavailable configured path/i);

  const reindexed = await execute(tool, { action: "reindex_now" });
  assert.equal(reindexed.job.trigger, "manual");
  assert.equal(reindexed.available, true);
  assert.equal(reindexed.job.changedFiles, 1, "reindex_now forces the V2 derivative pipeline");
  const reconciled = await execute(tool, { action: "reconcile_now" });
  assert.equal(reconciled.job.trigger, "manual");
  assert.equal(reconciled.job.unchangedFiles, 1, "reconcile_now uses incremental fingerprints");
  assert.equal(reconciled.job.changedFiles, 0);
  const gc = await execute(tool, { action: "gc" });
  assert.equal(gc.deletionsSkipped, false);
  assert.ok((await execute(tool, { action: "status" })).lastGc.completedAt);

  const explicit = await execute(tool, {
    action: "v2_search",
    query: "How much notice is required to terminate?",
    limit: 3,
  });
  assert.ok(explicit.evidence.length >= 1);
  assert.equal(explicit.answerability.status, "sufficient");
  assert.match(explicit.evidence[0].text, /sixty days written notice/i);

  const missing = await execute(tool, {
    action: "v2_search",
    query: "What does ZXQ-NOT-PRESENT-991 require?",
    limit: 3,
  });
  assert.equal(missing.answerability.status, "insufficient");
  assert.equal(missing.answerability.abstained, true);
  assert.deepEqual(missing.evidence, []);

  const primary = await execute(tool, {
    action: "search",
    query: "distributor terminate sixty days",
    limit: 3,
  });
  assert.ok(primary.hits.some(hit => hit.documentVersionId && hit.startLine));

  const generationBeforeWatch = primary.generationId ?? reconciled.activeGenerationId;
  await writeFile(path.join(docs, "contract.md"), [
    "# Distribution Agreement",
    "",
    "## Termination",
    "",
    "The distributor may terminate after ninety days written notice. WATCHED-NOTICE-90.",
  ].join("\n"));
  const watched = await waitUntil(async () => {
    const next = await execute(tool, { action: "status" });
    return next.activeGenerationId !== generationBeforeWatch
      && next.job?.trigger === "watch"
      && next.job?.state?.startsWith("active_")
      ? next
      : undefined;
  });
  assert.equal(watched.job.changedFiles, 1);
  assert.equal(watched.watcher.pendingChanges, false);
  assert.ok(watched.watcher.lastEventAt);
  const watchedSearch = await execute(tool, {
    action: "search", query: "WATCHED-NOTICE-90", limit: 3,
  });
  assert.ok(watchedSearch.hits.some(hit => /ninety days written notice/i.test(hit.text)));
});

test("workspace_rag off mode disables V2 commands without exposing an alternate index", async t => {
  process.env.CORTEX_RAG_V2_MODE = "off";
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-off-"));
  t.after(async () => {
    await plugin.teardown?.();
    process.env.CORTEX_RAG_V2_MODE = "primary";
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "matbot.yaml"), "plugins:\n  - workspace-rag\n");
  const tools = new Map();
  const registry = new Map();
  await plugin.setup({
    configPath: path.join(workspace, "matbot.yaml"),
    isSubAgent: () => false,
    async register(key, value) { registry.set(key, value); },
    get(key) { return registry.get(key); },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    hooks: { register() {} },
  });
  const tool = tools.get("workspace_rag");
  const status = await execute(tool, { action: "status" });
  assert.equal(status.mode, "off");
  assert.equal(status.available, false);
  assert.equal(status.backend, "unavailable");
  assert.equal(status.watcher.state, "stopped");
  assert.deepEqual(await execute(tool, { action: "search", query: "anything" }), { hits: [] });
  await assert.rejects(() => execute(tool, { action: "reindex_now" }), /disabled/i);
});
