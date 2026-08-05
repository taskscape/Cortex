import assert from "node:assert/strict";

const { plugin } = await import("../local-agent/matbot/packages/plugins/source-registry/src/index.ts");

class MemoryStore {
  constructor() {
    this.docs = new Map();
    this.queryCount = 0;
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
    this.queryCount += 1;
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
  const versionC = await registry.upsertVersion({
    sourceId,
    contentHash: "def",
    observedAt: "2026-01-03T00:00:00.000Z",
    provenance: { activityId: "test:rescan" },
  });
  assert.notEqual(versionC.id, versionA.id, "changed content must retain a distinct source version");

  const healthySource = await registry.upsertSource({
    workspaceId: "default",
    connectorType: "workspace-rag",
    externalId: "default:/docs/healthy.md",
    uri: "C:/docs/healthy.md",
    title: "healthy.md",
    sourceKind: "document",
    citationPolicy: "cite_path",
    healthState: "healthy",
  });
  await registry.upsertVersion({
    sourceId: healthySource.id,
    contentHash: "healthy",
    observedAt: "2026-01-02T00:00:00.000Z",
    provenance: { activityId: "test:scan" },
  });

  await registry.recordHealth({ sourceId, state: "healthy", message: "recovered" });
  await registry.recordHealth({ sourceId, state: "degraded", message: "read failed" });
  await registry.recordHealth({ sourceId, state: "down", message: "connector unavailable" });
  assert.equal((await registry.getSource(sourceId)).healthState, "down");
  const auditTimestamp = "2026-01-04T00:00:00.000Z";
  await registry.recordAccess({ sourceId, action: "read", allowed: true, sourceVersionId: versionC.id, principalId: "source-auditor", timestamp: auditTimestamp });
  await registry.recordAccess({ sourceId, action: "retrieve", allowed: true, sourceVersionId: versionC.id, principalId: "source-auditor" });
  await registry.recordAccess({ sourceId, action: "cite", allowed: true, sourceVersionId: versionC.id, principalId: "source-auditor" });
  await registry.recordAccess({ sourceId, action: "write", allowed: false, principalId: "source-auditor", message: "password=source-secret" });
  await registry.recordAccess({ sourceId, action: "delete", allowed: false, principalId: "source-auditor" });
  await registry.recordAccess({ sourceId, action: "health_check", allowed: true, principalId: "source-auditor" });

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

  const versionStore = stores.get("source_versions");
  const events = await collectTool(sourceTool, { action: "events", sourceId });
  assert.equal(events.access.length, 6);
  assert.equal(events.health.length, 3);
  assert.deepEqual(events.versions.map(version => version.id), [versionA.id, versionC.id]);
  assert.deepEqual(events.health.map(event => event.state), ["healthy", "degraded", "down"]);
  assert.equal((await registry.accessEvents(sourceId)).find(event => event.action === "cite")?.sourceVersionId, versionC.id);
  const accessAudit = await registry.accessEvents(sourceId);
  assert.deepEqual(accessAudit.map(event => event.action), ["read", "retrieve", "cite", "write", "delete", "health_check"]);
  assert.equal(accessAudit[0].timestamp, auditTimestamp);
  assert.ok(accessAudit.every(event => event.principalId === "source-auditor"));
  assert.ok(accessAudit.every(event => event.sourceVersionId === versionC.id || event.action === "write" || event.action === "delete" || event.action === "health_check"));
  assert.doesNotMatch(JSON.stringify(accessAudit), /source-secret/);
  const versionQueriesAfterEvents = versionStore.queryCount;

  const healthTool = tools.get("source_health_action");
  const report = await collectTool(healthTool, { action: "report", workspaceId: "default" });
  assert.equal(report.totalSources, 2);
  assert.equal(report.healthySources, 1);
  assert.equal(report.staleSources, 1);
  assert.equal(report.unhealthySources, 1);
  assert.equal(report.warningCount, 1);
  assert.equal(report.criticalCount, 1);
  assert.equal(report.findings.length, 2);
  assert.deepEqual(report.findings.map(finding => finding.issueType).sort(), ["down", "stale"]);
  assert.equal(report.findings.find(finding => finding.sourceId === sourceId)?.sourceVersionId, versionC.id);
  assert.equal(report.connectorHealth.length, 1);
  assert.equal(report.connectorHealth[0].healthState, "degraded");
  assert.equal(versionStore.queryCount, versionQueriesAfterEvents + 1, "health evaluation should query source versions once");

  const warnings = await collectTool(healthTool, { action: "warnings", workspaceId: "default" });
  assert.equal(warnings.warningCount, 1);
  assert.equal(warnings.findings.length, 2);
  assert.equal(warnings.connectorHealth.length, 1);
  assert.equal(versionStore.queryCount, versionQueriesAfterEvents + 2, "each health evaluation should use one source-version query");

  const reports = await collectTool(healthTool, { action: "reports", workspaceId: "default" });
  assert.equal(reports.reports.length, 1);

  // Cover the report edge cases that are easy to miss when the only unhealthy
  // source is a normal stale/down document: expired evidence, denied access,
  // unknown freshness, and strict workspace filtering all have distinct
  // severity and count semantics.
  const expiredDenied = await registry.upsertSource({
    workspaceId: "default",
    connectorType: "sharepoint",
    externalId: "default:/docs/expired-denied.md",
    uri: "https://example.invalid/expired-denied.md",
    title: "Expired and denied evidence",
    sourceKind: "document",
    citationPolicy: "cite_path",
    healthState: "degraded",
    stalenessState: "expired",
    permissionState: "denied",
  });
  const unknownFreshness = await registry.upsertSource({
    workspaceId: "default",
    connectorType: "mcp",
    externalId: "default:/docs/unknown-freshness.md",
    uri: "https://example.invalid/unknown-freshness.md",
    title: "Unknown freshness evidence",
    sourceKind: "document",
    citationPolicy: "cite_path",
    healthState: "healthy",
  });
  await registry.upsertSource({
    workspaceId: "other-workspace",
    connectorType: "workspace-rag",
    externalId: "other:/docs/private.md",
    uri: "C:/docs/private.md",
    title: "Other workspace source",
    sourceKind: "document",
    citationPolicy: "cite_path",
    healthState: "down",
    stalenessState: "expired",
    permissionState: "denied",
  });

  const connectorSnapshot = await collectTool(healthTool, { action: "connectors" });
  assert.equal(connectorSnapshot.connectors.length, 1);
  assert.equal(connectorSnapshot.connectors[0].healthState, "degraded", "latest connector event overrides its stored state");

  const edgeReport = await collectTool(healthTool, {
    action: "report",
    workspaceId: "default",
    includeUnknownFreshness: true,
  });
  assert.equal(edgeReport.totalSources, 4, "the report must exclude another workspace's source");
  assert.equal(edgeReport.healthySources, 0, "a source without a successful read is not healthy when unknown freshness is requested");
  assert.equal(edgeReport.staleSources, 2);
  assert.equal(edgeReport.unhealthySources, 2);
  assert.equal(edgeReport.warningCount, 4);
  assert.equal(edgeReport.criticalCount, 3);
  assert.deepEqual(
    edgeReport.findings.map(finding => finding.issueType).sort(),
    ["degraded", "down", "expired", "permission_denied", "stale", "unknown_freshness", "unknown_freshness"],
  );
  assert.equal(edgeReport.findings.filter(finding => finding.sourceId === expiredDenied.id).length, 3);
  assert.ok(edgeReport.findings.some(finding => finding.sourceId === unknownFreshness.id && finding.issueType === "unknown_freshness"));
  assert.ok(edgeReport.findings.every(finding => finding.workspaceId === "default"));
}

await main();
console.log("source-registry stores stable source ids, versions, freshness, citations, events, and health reports");
