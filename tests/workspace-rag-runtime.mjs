import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CORTEX_RAG_DISABLE_CUDA = "1";
process.env.CORTEX_RAG_STORAGE = "json";
const { plugin } = await import("../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts");
const { plugin: sourceRegistryPlugin } = await import("../local-agent/matbot/packages/plugins/source-registry/src/index.ts");

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

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-workspace-rag-"));
  try {
    const workspaceDir = path.join(root, "workspace");
    const docsDir = path.join(root, "docs");
    const financeDir = path.join(root, "finance-docs");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await mkdir(financeDir, { recursive: true });
    const configPath = path.join(workspaceDir, "matbot.yaml");
    await writeFile(configPath, "plugins:\n  - ./packages/plugins/workspace-rag\n", "utf8");
    await writeFile(
      path.join(docsDir, "retrieval-probe.md"),
      "# Retrieval Probe\n\nThe QuasarPump calibration value is 42.\0 Use the amber valve before startup.",
      "utf8",
    );
    await writeFile(
      path.join(financeDir, "finance-probe.md"),
      "# Finance Probe\n\nThe LedgerAlpha reserve ratio is 18 percent. Review cash timing before expansion.",
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
    await plugin.setup(services);
    const registeredTool = tools.get("workspace_rag");
    const sourceTool = tools.get("source_action");
    assert.equal(registeredTool?.name, "workspace_rag");
    assert.equal(sourceTool?.name, "source_action");
    assert.equal(screenHook?.on, "screen");

    const toolCtx = { signal: new AbortController().signal };
    const configureEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "configure",
      contextName: "Probe Knowledge",
      paths: [docsDir],
    }, toolCtx)) {
      configureEvents.push(event);
    }
    const configureResult = configureEvents.find(event => event.type === "result")?.value;
    assert.equal(configureResult.status.state, "idle");
    assert.equal(configureResult.status.percent, 100);
    assert.equal(configureResult.status.accelerator, "cpu");
    assert.equal(configureResult.status.accelerated, false);
    assert.equal(configureResult.status.embeddingBackend, "hash-cpu");
    assert.equal(configureResult.status.currentFile, undefined);

    const idleStatusEvents = [];
    for await (const event of registeredTool.executor.execute({ action: "status" }, toolCtx)) {
      idleStatusEvents.push(event);
    }
    const idleStatusResult = idleStatusEvents.find(event => event.type === "result")?.value;
    assert.equal(idleStatusResult.currentFile, undefined);

    const dbText = await readFile(path.join(workspaceDir, ".data", "workspace-rag", "index.json"), "utf8");
    assert.match(dbText, /QuasarPump/);
    assert.doesNotMatch(dbText, /\\u0000/);
    const sourceListEvents = [];
    for await (const event of sourceTool.executor.execute({ action: "list" }, toolCtx)) {
      sourceListEvents.push(event);
    }
    const sourceListResult = sourceListEvents.find(event => event.type === "result")?.value;
    const retrievalSource = sourceListResult.sources.find(source => source.uri.endsWith("retrieval-probe.md"));
    assert.ok(retrievalSource, "workspace RAG should register indexed markdown as a source");
    assert.equal(retrievalSource.connectorType, "workspace-rag");
    assert.equal(retrievalSource.sourceKind, "document");
    assert.equal(retrievalSource.healthState, "healthy");

    const ingestionLog = await readFile(path.join(workspaceDir, ".data", "workspace-rag", "ingestion.log"), "utf8");
    assert.match(ingestionLog, /"event":"file_sanitized"/);
    assert.match(ingestionLog, /"nulCharsRemoved":1/);

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
console.log("workspace-rag ingests markdown, persists the vector db, searches, and injects turn context");
