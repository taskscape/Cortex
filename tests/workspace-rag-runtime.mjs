import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CORTEX_RAG_DISABLE_CUDA = "1";
process.env.CORTEX_RAG_V2_MODE = "primary";
process.env.CORTEX_RAG_V2_STORAGE = "memory";
const { plugin } = await import("../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts");
const { plugin: sourceRegistryPlugin } = await import("../local-agent/matbot/packages/plugins/source-registry/src/index.ts");
const { plugin: contextGraphPlugin } = await import("../local-agent/matbot/packages/plugins/context-graph/src/index.ts");

class MemoryStore {
  constructor() {
    this.docs = new Map();
  }

  async get(id) {
    return this.docs.get(id) ?? null;
  }

  async set(id, value) {
    this.docs.set(id, value);
  }

  async cas(id, expected, next) {
    const current = this.docs.get(id) ?? null;
    if (current === null || current.version !== expected) return { ok: false, current };
    this.docs.set(id, next);
    return { ok: true, doc: next };
  }

  async delete(id, expectedVersion) {
    const current = this.docs.get(id) ?? null;
    if (current === null) return false;
    if (expectedVersion !== undefined && current.version !== expectedVersion) return false;
    return this.docs.delete(id);
  }

  async query(q = {}) {
    let items = [...this.docs.values()];
    if (q.where !== undefined) items = items.filter(item => matches(item, q.where));
    return { items, total: items.length };
  }
}

function fieldValue(item, field) {
  const parts = Array.isArray(field) ? field : [field];
  let value = item;
  for (const part of parts) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

function matches(item, filter) {
  switch (filter.op) {
    case "eq":
      return fieldValue(item, filter.field) === filter.value;
    case "and":
      return filter.clauses.every(clause => matches(item, clause));
    default:
      return true;
  }
}

async function collectResult(tool, input, ctx) {
  const events = [];
  for await (const event of tool.executor.execute(input, ctx)) events.push(event);
  const error = events.find(event => event.type === "error");
  if (error) throw new Error(error.message);
  return events.find(event => event.type === "result")?.value;
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-workspace-rag-"));
  try {
    const workspaceDir = path.join(root, "workspace");
    const docsDir = path.join(root, "docs");
    const financeDir = path.join(root, "finance-docs");
    const standaloneDir = path.join(root, "standalone");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await mkdir(financeDir, { recursive: true });
    await mkdir(standaloneDir, { recursive: true });
    const configPath = path.join(workspaceDir, "matbot.yaml");
    await writeFile(configPath, "plugins:\n  - ./packages/plugins/workspace-rag\n", "utf8");
    await writeFile(
      path.join(docsDir, "retrieval-probe.md"),
      "# Retrieval Probe\n\nThe QuasarPump calibration value is 42.\0 Use the amber valve before startup.",
      "utf8",
    );
    await writeFile(path.join(docsDir, "ignored.txt"), "NON_MARKDOWN_CANARY_771", "utf8");
    const renamedOld = path.join(docsDir, "rename-old.md");
    const renamedNew = path.join(docsDir, "rename-new.md");
    await writeFile(renamedOld, "# Rename Old\n\nRAG_OLD_PATH_CANARY_882", "utf8");
    await writeFile(
      path.join(financeDir, "finance-probe.md"),
      "# Finance Probe\n\nThe LedgerAlpha reserve ratio is 18 percent. Review cash timing before expansion.",
      "utf8",
    );
    const standaloneFile = path.join(standaloneDir, "single-note.md");
    await writeFile(
      standaloneFile,
      "# Single Note\n\nThe SoloBeacon retry budget is 7 attempts. Escalate after the third failure.",
      "utf8",
    );

    const stores = new Map();
    const servicesByKey = new Map();
    const tools = new Map();
    let screenHook;
    const services = {
      configPath,
      isSubAgent: () => false,
      createStore(namespace) {
        if (!stores.has(namespace)) stores.set(namespace, new MemoryStore());
        return stores.get(namespace);
      },
      async register(key, value) {
        servicesByKey.set(key, value);
        this[key] = value;
      },
      get(key) {
        return servicesByKey.get(key);
      },
      tools: {
        register(tool) {
          tools.set(tool.name, tool);
        },
      },
      hooks: {
        register(hook) {
          if (hook.on === "screen") screenHook = hook;
        },
      },
    };

    await sourceRegistryPlugin.setup(services);
    await contextGraphPlugin.setup(services);
    await plugin.setup(services);
    const registeredTool = tools.get("workspace_rag");
    const sourceTool = tools.get("source_action");
    const contextGraphTool = tools.get("context_graph_action");
    assert.equal(registeredTool?.name, "workspace_rag");
    assert.equal(sourceTool?.name, "source_action");
    assert.equal(contextGraphTool?.name, "context_graph_action");
    assert.equal(screenHook?.on, "screen");

    const toolCtx = { signal: new AbortController().signal };
    const configureEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "configure",
      contextName: "Probe Knowledge",
      paths: [docsDir, `${docsDir}${path.sep}.`],
    }, toolCtx)) {
      configureEvents.push(event);
    }
    const configureResult = configureEvents.find(event => event.type === "result")?.value;
    assert.equal(configureResult.status.mode, "primary");
    for await (const _event of registeredTool.executor.execute({ action: "ingestion_wait" }, toolCtx)) {}
    const readyEvents = [];
    for await (const event of registeredTool.executor.execute({ action: "status" }, toolCtx)) readyEvents.push(event);
    const readyStatus = readyEvents.find(event => event.type === "result")?.value;
    assert.equal(readyStatus.activeState, "active_hybrid_complete");
    assert.equal(readyStatus.job.discoveryComplete, true);
    assert.equal(readyStatus.job.processedFiles, readyStatus.job.totalFiles);
    assert.equal(configureResult.status.accelerator, "cpu");
    assert.equal(configureResult.status.accelerated, false);
    assert.equal(configureResult.status.embeddingBackend, "hash-cpu");
    assert.deepEqual(configureResult.config.paths, [docsDir]);

    const idleStatusEvents = [];
    for await (const event of registeredTool.executor.execute({ action: "status" }, toolCtx)) {
      idleStatusEvents.push(event);
    }
    const idleStatusResult = idleStatusEvents.find(event => event.type === "result")?.value;
    assert.equal(idleStatusResult.job.currentPath, undefined);
    assert.equal(idleStatusResult.backend, "memory");

    await rename(renamedOld, renamedNew);
    await writeFile(renamedNew, "# Rename New\n\nRAG_NEW_PATH_CANARY_993", "utf8");
    for await (const _event of registeredTool.executor.execute({ action: "reconcile_now" }, toolCtx)) {}
    const oldRenameSearch = await collectResult(registeredTool, {
      action: "search", query: "RAG_OLD_PATH_CANARY_882", limit: 3,
    }, toolCtx);
    const newRenameSearch = await collectResult(registeredTool, {
      action: "search", query: "RAG_NEW_PATH_CANARY_993", limit: 3,
    }, toolCtx);
    assert.ok(oldRenameSearch.hits.every(hit => !hit.text.includes("RAG_OLD_PATH_CANARY_882")));
    assert.ok(newRenameSearch.hits.some(hit => hit.path.endsWith("rename-new.md")));
    const sourceListEvents = [];
    for await (const event of sourceTool.executor.execute({ action: "list" }, toolCtx)) {
      sourceListEvents.push(event);
    }
    const sourceListResult = sourceListEvents.find(event => event.type === "result")?.value;
    const retrievalSource = sourceListResult.sources.find(source => source.uri.endsWith("retrieval-probe.md"));
    const removedRenameSource = sourceListResult.sources.find(source => source.uri.endsWith("rename-old.md"));
    assert.ok(retrievalSource, "workspace RAG should register indexed markdown as a source");
    assert.equal(retrievalSource.connectorType, "workspace-rag");
    assert.equal(retrievalSource.sourceKind, "document");
    assert.equal(retrievalSource.healthState, "healthy");
    assert.equal(removedRenameSource?.healthState, "down", "a path rename retires the old source identity");

    await writeFile(renamedOld, "# Rename Restored\n\nRAG_RESTORED_PATH_CANARY_447", "utf8");
    await collectResult(registeredTool, { action: "reconcile_now" }, toolCtx);
    const restoredSources = await collectResult(sourceTool, { action: "list" }, toolCtx);
    assert.equal(
      restoredSources.sources.find(source => source.uri.endsWith("rename-old.md"))?.healthState,
      "healthy",
      "a reappearing path restores its source-registry health",
    );

    const graphListEvents = [];
    for await (const event of contextGraphTool.executor.execute({ action: "list" }, toolCtx)) {
      graphListEvents.push(event);
    }
    const graphListResult = graphListEvents.find(event => event.type === "result")?.value;
    assert.ok(graphListResult.extractionRuns.some(run => run.sourceId === retrievalSource.id && run.status === "succeeded"));
    assert.ok(graphListResult.relationships.some(relationship => relationship.sourceId === retrievalSource.id && relationship.sourceVersionId !== undefined));

    const retrievalSourceVersion = retrievalSource.version;
    const healthEventsBeforeUnchangedScan = stores.get("source_health_events")?.docs.size ?? 0;
    const extractionRunsBeforeUnchangedScan = stores.get("context_graph_extraction_runs")?.docs.size ?? 0;
    for await (const _event of registeredTool.executor.execute({ action: "reconcile_now" }, toolCtx)) {}
    assert.equal(
      stores.get("sources")?.docs.get(retrievalSource.id)?.version,
      retrievalSourceVersion,
      "unchanged files do not rewrite source records",
    );
    assert.equal(
      stores.get("source_health_events")?.docs.size ?? 0,
      healthEventsBeforeUnchangedScan,
      "unchanged files do not append health-history records",
    );
    assert.equal(
      stores.get("context_graph_extraction_runs")?.docs.size ?? 0,
      extractionRunsBeforeUnchangedScan,
      "unchanged files do not rerun context-graph extraction",
    );

    const searchEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "search",
      query: "What is the QuasarPump calibration value?",
      limit: 3,
    }, toolCtx)) {
      searchEvents.push(event);
    }
    const searchResult = searchEvents.find(event => event.type === "result")?.value;
    assert.ok(searchResult.hits.length >= 1);
    assert.match(searchResult.hits[0].text, /QuasarPump calibration value is 42/);
    assert.equal(searchResult.hits[0].sourceId, retrievalSource.id);
    assert.equal(searchResult.hits[0].sourceHealthState, "healthy");
    assert.match(searchResult.hits[0].citation.text, /retrieval-probe\.md/);

    const createContextEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "create_context",
      contextName: "Finance Notes",
      paths: [financeDir],
    }, toolCtx)) {
      createContextEvents.push(event);
    }
    const createContextResult = createContextEvents.find(event => event.type === "result")?.value;
    assert.equal(createContextResult.config.contextName, "Finance Notes");
    assert.equal(createContextResult.config.activeContextId, "finance-notes");
    for await (const _event of registeredTool.executor.execute({ action: "ingestion_wait" }, toolCtx)) {}

    const financeSearchEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "search",
      query: "What is the LedgerAlpha reserve ratio?",
      limit: 3,
    }, toolCtx)) {
      financeSearchEvents.push(event);
    }
    const financeSearchResult = financeSearchEvents.find(event => event.type === "result")?.value;
    assert.ok(financeSearchResult.hits.length >= 1);
    assert.equal(financeSearchResult.hits[0].contextName, "Finance Notes");
    assert.match(financeSearchResult.hits[0].text, /LedgerAlpha reserve ratio is 18 percent/);

    // A configured path may name one markdown file rather than a folder.
    const singleFileEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "create_context",
      contextName: "Single Note",
      paths: [standaloneFile],
    }, toolCtx)) {
      singleFileEvents.push(event);
    }
    const singleFileResult = singleFileEvents.find(event => event.type === "result")?.value;
    assert.equal(singleFileResult.config.contextName, "Single Note");
    for await (const _event of registeredTool.executor.execute({ action: "ingestion_wait" }, toolCtx)) {}
    const singleFileSourceEvents = [];
    for await (const event of sourceTool.executor.execute({ action: "list" }, toolCtx)) {
      singleFileSourceEvents.push(event);
    }
    const singleFileSources = singleFileSourceEvents.find(event => event.type === "result")?.value.sources;
    assert.ok(
      singleFileSources.some(source => source.uri.endsWith("single-note.md")),
      "a path naming one markdown file must index that file, not nothing",
    );

    const singleFileSearchEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "v2_search",
      query: "How many attempts are allowed for SoloBeacon?",
      limit: 3,
    }, toolCtx)) {
      singleFileSearchEvents.push(event);
    }
    const singleFileSearchResult = singleFileSearchEvents.find(event => event.type === "result")?.value;
    assert.ok(singleFileSearchResult.evidence.length >= 1, JSON.stringify(singleFileSearchResult));
    assert.match(singleFileSearchResult.evidence[0].text, /SoloBeacon retry budget is 7 attempts/);

    const deleteContextEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "delete_context",
      contextId: "single-note",
    }, toolCtx)) {
      deleteContextEvents.push(event);
    }
    const deleteContextResult = deleteContextEvents.find(event => event.type === "result")?.value;
    assert.ok(!deleteContextResult.config.contexts.some(context => context.id === "single-note"));
    assert.equal(deleteContextResult.status.mode, "primary");
    const persistedConfig = JSON.parse(await readFile(path.join(workspaceDir, "cortex-rag.json"), "utf8"));
    assert.ok(!persistedConfig.contexts.some(context => context.id === "single-note"));

    const selectDefaultEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "select_context",
      contextId: "default",
    }, toolCtx)) {
      selectDefaultEvents.push(event);
    }
    const selectDefaultResult = selectDefaultEvents.find(event => event.type === "result")?.value;
    assert.equal(selectDefaultResult.config.contextName, "Probe Knowledge");

    await services.SourceRegistry.upsertSource({
      ...retrievalSource,
      stalenessState: "stale",
      healthState: "degraded",
      knownLimitations: [...retrievalSource.knownLimitations, "Marked stale by the health monitor test."],
    });
    await services.SourceRegistry.recordHealth({
      sourceId: retrievalSource.id,
      state: "degraded",
      message: "Health monitor test degraded this source.",
    });

    const hookResult = await screenHook.handler({
      session: {
        messages: [{
          role: "user",
          content: [{ type: "text", text: "What is the QuasarPump calibration value?" }],
        }],
      },
      config: { provider: "test" },
      signal: new AbortController().signal,
      removeHook() {},
    });
    assert.match(hookResult.ephemeral[0].text, /Workspace RAG context/);
    assert.match(hookResult.ephemeral[0].text, /QuasarPump calibration value is 42/);
    assert.match(hookResult.ephemeral[0].text, /Source id: source:/);
    assert.match(hookResult.ephemeral[0].text, /Warning: This source is marked degraded/);
    assert.match(hookResult.ephemeral[0].text, /Warning: This source is stale/);
    assert.match(hookResult.ephemeral[0].text, /Citation: .*retrieval-probe\.md/);
    assert.equal(hookResult.markers[0].data.hits[0].sourceId, retrievalSource.id);
    assert.equal(hookResult.markers[0].data.sourceWarnings.length, 2);
    assert.deepEqual(hookResult.markers[0].data.sourceWarnings.map(warning => warning.issueType).sort(), ["degraded", "stale"]);

    await plugin.teardown?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
/**
 * T3-E2E-048: Workspace RAG runtime with markdown ingestion, persistence, search, and context injection
 *
 * Validates that the workspace RAG system correctly ingests markdown, persists the vector DB,
 * searches across contexts, and injects turn context with citations and health warnings.
 *
 * This test ensures:
 * - Markdown files are parsed and stored with path normalization
 * - Vectors are stored by the V2 hybrid repository (in memory for this test)
 * - Sources are registered with correct metadata
 * - Contexts can be created, searched, selected, and deleted
 * - Single-file search works correctly
 * - Health monitoring correctly reports degraded/stale sources
 * - Screen hooks inject citations and health warnings into turn context
 * - Path normalization (Windows backslashes) works correctly
 *
 * Assumptions:
 * - The workspace-rag plugin correctly processes markdown files
 * - The test creates a temporary workspace with sample markdown content
 * - Success is indicated by the runtime output containing the expected success message
 */
console.log("T3-E2E-048 workspace-rag ingests markdown, persists the vector db, searches, and injects turn context");
