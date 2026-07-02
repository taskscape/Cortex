import assert from "node:assert/strict";

const { plugin } = await import("../local-agent/matbot/packages/plugins/source-registry/src/index.ts");

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
    if (Array.isArray(q.sort)) {
      for (const sort of [...q.sort].reverse()) {
        items.sort((left, right) => {
          const a = fieldValue(left, sort.field);
          const b = fieldValue(right, sort.field);
          const dir = sort.dir === "desc" ? -1 : 1;
          return String(a ?? "").localeCompare(String(b ?? "")) * dir;
        });
      }
    }
    const total = items.length;
    if (typeof q.limit === "number") items = items.slice(0, q.limit);
    return { items, total };
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
    case "neq":
      return fieldValue(item, filter.field) !== filter.value;
    case "and":
      return filter.clauses.every(clause => matches(item, clause));
    case "or":
      return filter.clauses.some(clause => matches(item, clause));
    default:
      return true;
  }
}

async function collectTool(tool, input) {
  const events = [];
  for await (const event of tool.executor.execute(input, { signal: new AbortController().signal })) {
    events.push(event);
  }
  return events.find(event => event.type === "result")?.value;
}

async function main() {
  const stores = new Map();
  const servicesByKey = new Map();
  const tools = new Map();
  const services = {
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
  };

  await plugin.setup(services);
  const registry = services.SourceRegistry;
  assert.ok(registry, "SourceRegistry service should be registered");
  assert.ok(tools.get("source_action"), "source_action tool should be registered");
  assert.ok(tools.get("source_health_action"), "source_health_action tool should be registered");

  const identity = {
    workspaceId: "default",
    connectorType: "workspace-rag",
    externalId: "default:/docs/source.md",
  };
  const sourceId = registry.stableSourceId(identity);
  assert.equal(registry.stableSourceId(identity), sourceId);
  assert.notEqual(registry.stableSourceId({ ...identity, externalId: "default:/docs/other.md" }), sourceId);

  const staleSource = await registry.upsertSource({
    ...identity,
    uri: "C:/docs/source.md",
    title: "source.md",
    sourceKind: "document",
    freshnessSlaSeconds: 1,
    lastSuccessfulReadAt: "2020-01-01T00:00:00.000Z",
    citationPolicy: "cite_path",
    healthState: "healthy",
  });
  assert.equal(staleSource.id, sourceId);
  assert.equal(staleSource.stalenessState, "stale");

  const versionA = await registry.upsertVersion({
    sourceId,
    contentHash: "abc",
    observedAt: "2026-01-01T00:00:00.000Z",
    provenance: { activityId: "test:scan" },
  });
  const versionB = await registry.upsertVersion({
    sourceId,
    contentHash: "abc",
    observedAt: "2026-01-01T00:00:00.000Z",
    provenance: { activityId: "test:scan" },
  });
  assert.equal(versionA.id, versionB.id);

  await registry.recordHealth({ sourceId, state: "degraded", message: "read failed" });
  assert.equal((await registry.getSource(sourceId)).healthState, "degraded");
  await registry.recordAccess({ sourceId, action: "retrieve", allowed: true });

  servicesByKey.set("ConnectorRegistry", {
    async queryInstances() {
      return [{
        id: "connector-instance:workspace-rag:local",
        displayName: "Local Workspace RAG",
        type: "workspace-rag",
        workspaceId: "local",
        healthState: "healthy",
      }];
    },
    async healthEvents(connectorInstanceId) {
      assert.equal(connectorInstanceId, "connector-instance:workspace-rag:local");
      return [{
        connectorInstanceId,
        state: "degraded",
        checkedAt: "2026-01-02T00:00:00.000Z",
        message: "index scan lagging",
      }];
    },
  });

  const citation = await registry.resolveCitation(sourceId, versionA.id);
  assert.match(citation.text, /source\.md/);
  assert.equal(citation.versionId, versionA.id);

  const sourceTool = tools.get("source_action");
  const stale = await collectTool(sourceTool, { action: "stale", workspaceId: "default" });
  assert.equal(stale.sources.length, 1);
  assert.equal(stale.sources[0].id, sourceId);

  const events = await collectTool(sourceTool, { action: "events", sourceId });
  assert.equal(events.access.length, 1);
  assert.equal(events.health.length, 1);

  const healthTool = tools.get("source_health_action");
  const report = await collectTool(healthTool, { action: "report", workspaceId: "default" });
  assert.equal(report.totalSources, 1);
  assert.equal(report.staleSources, 1);
  assert.equal(report.unhealthySources, 1);
  assert.equal(report.warningCount, 2);
  assert.equal(report.criticalCount, 0);
  assert.equal(report.findings.length, 2);
  assert.deepEqual(report.findings.map(finding => finding.issueType).sort(), ["degraded", "stale"]);
  assert.equal(report.findings[0].sourceVersionId, versionA.id);
  assert.equal(report.connectorHealth.length, 1);
  assert.equal(report.connectorHealth[0].healthState, "degraded");

  const warnings = await collectTool(healthTool, { action: "warnings", workspaceId: "default" });
  assert.equal(warnings.warningCount, 2);
  assert.equal(warnings.findings.length, 2);
  assert.equal(warnings.connectorHealth.length, 1);

  const reports = await collectTool(healthTool, { action: "reports", workspaceId: "default" });
  assert.equal(reports.reports.length, 1);
}

await main();
console.log("source-registry stores stable source ids, versions, freshness, citations, events, and health reports");
