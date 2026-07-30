import assert from "node:assert/strict";

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
  const error = events.find(event => event.type === "error");
  if (error !== undefined) throw new Error(error.message);
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

  await sourceRegistryPlugin.setup(services);
  await contextGraphPlugin.setup(services);

  const graph = services.ContextGraph;
  const registry = services.SourceRegistry;
  const graphTool = tools.get("context_graph_action");
  assert.ok(graph, "ContextGraph service should be registered");
  assert.ok(graphTool, "context_graph_action should be registered");

  const source = await registry.upsertSource({
    workspaceId: "default",
    connectorType: "workspace-rag",
    connectorInstanceId: "connector-instance:workspace-rag:local",
    externalId: "default:/docs/ops-123.md",
    uri: "docs/ops-123.md",
    title: "OPS-123 Followup",
    sourceKind: "document",
    sensitivity: "internal",
    permissionState: "allowed",
    trustLevel: "high",
    citationPolicy: "cite_path",
    healthState: "degraded",
    stalenessState: "stale",
    knownLimitations: ["Marked degraded for graph retrieval warning coverage."],
    lastObservedAt: new Date().toISOString(),
    lastSuccessfulReadAt: "2026-01-01T00:00:00.000Z",
  });
  const version = await registry.upsertVersion({
    sourceId: source.id,
    contentHash: "ops-123-v1",
    observedAt: "2026-07-03T10:00:00.000Z",
    provenance: { activityId: "test-context-graph" },
  });

  const run = await collectTool(graphTool, {
    action: "extract_source",
    sourceId: source.id,
    sourceVersionId: version.id,
    text: [
      "# Escalation Plan",
      "Contact alice@example.com about OPS-123 and https://example.com/runbook.",
      "Related file C:\\Projects\\Cortex\\docs\\runbook.md.",
      "Review date 2026-07-03 and table public.orders.",
    ].join("\n"),
  });
  assert.equal(run.status, "succeeded");
  assert.equal(run.sourceVersionId, version.id);
  assert.ok(run.entityCount >= 6);
  assert.ok(run.relationshipCount >= 5);

  const ticketHits = await collectTool(graphTool, {
    action: "search_entities",
    workspaceId: "default",
    terms: ["OPS-123"],
  });
  assert.ok(ticketHits.entities.some(entity => entity.type === "ticket" && entity.identifiers.issueKey === "OPS-123"));

  const aliceA = await graph.upsertEntity({
    workspaceId: "default",
    type: "person",
    canonicalName: "Alice Example",
    identifiers: { email: "alice@example.com" },
  });
  const aliceB = await graph.upsertEntity({
    workspaceId: "default",
    type: "person",
    canonicalName: " alice   example ",
    aliases: ["A. Example"],
    identifiers: { employeeId: "E-100" },
  });
  assert.equal(aliceB.id, aliceA.id);
  assert.equal(aliceB.identifiers.email, "alice@example.com");
  assert.equal(aliceB.identifiers.employeeId, "E-100");
  assert.ok(aliceB.aliases.includes("A. Example"));

  const task = await graph.upsertEntity({
    workspaceId: "default",
    type: "task",
    canonicalName: "Follow up with operations",
  });
  const relationshipA = await graph.assertRelationship({
    workspaceId: "default",
    subjectEntityId: aliceA.id,
    predicate: "owns_task",
    objectEntityId: task.id,
    sourceId: source.id,
    sourceVersionId: version.id,
    confidence: 0.92,
    evidenceSpan: { text: "Alice owns the followup." },
  });
  const relationshipB = await graph.assertRelationship({
    workspaceId: "default",
    subjectEntityId: aliceA.id,
    predicate: "owns_task",
    objectEntityId: task.id,
    sourceId: source.id,
    sourceVersionId: version.id,
    confidence: 0.92,
  });
  assert.equal(relationshipB.id, relationshipA.id);
  const duplicateCheck = (await graph.queryRelationships()).filter(relationship => relationship.id === relationshipA.id);
  assert.equal(duplicateCheck.length, 1);

  const gate = await graph.upsertEntity({ workspaceId: "default", type: "decision", canonicalName: "Operations approval gate" });
  const outcome = await graph.upsertEntity({ workspaceId: "default", type: "outcome", canonicalName: "Escalation completed" });
  const hopOne = await graph.assertRelationship({
    workspaceId: "default", subjectEntityId: task.id, predicate: "requires", objectEntityId: gate.id,
    sourceId: source.id, sourceVersionId: version.id, confidence: 2, evidenceSpan: { text: "The task requires the approval gate." },
  });
  const hopTwo = await graph.assertRelationship({
    workspaceId: "default", subjectEntityId: gate.id, predicate: "enables", objectEntityId: outcome.id,
    sourceId: source.id, sourceVersionId: version.id, confidence: -1, evidenceSpan: { text: "Approval enables escalation completion." },
  });
  assert.equal(hopOne.confidence, 1, "confidence is bounded at one");
  assert.equal(hopTwo.confidence, 0, "confidence is bounded at zero");
  const multiHop = await graph.pathSearch(aliceA.id, outcome.id, { maxDepth: 3, maxPaths: 5 });
  assert.ok(multiHop.some(path => path.relationships.map(relationship => relationship.id).join(",") === [relationshipA.id, hopOne.id, hopTwo.id].join(",")));
  const twoHopNeighbors = await graph.neighbors(task.id, { depth: 2, maxRelationships: 10 });
  assert.ok(twoHopNeighbors.entities.some(entity => entity.id === outcome.id));

  const retrieve = await collectTool(graphTool, {
    action: "retrieve",
    workspaceId: "default",
    terms: ["alice", "ops"],
    maxDepth: 2,
    maxRelationships: 20,
  });
  assert.ok(retrieve.facts.some(fact => fact.relationship.id === relationshipA.id));
  assert.ok(retrieve.facts.some(fact => fact.sourceVersionId === version.id));
  assert.ok(retrieve.warnings.some(warning => /health is degraded/.test(warning)));
  assert.ok(retrieve.facts.some(fact => fact.sourceStalenessState === "stale"));
  assert.ok(retrieve.facts.some(fact => /docs\/ops-123\.md/.test(fact.citationText)));

  const deniedSource = await registry.upsertSource({
    workspaceId: "default",
    connectorType: "workspace-rag",
    externalId: "default:/docs/denied.md",
    uri: "docs/denied.md",
    title: "Denied Account",
    sourceKind: "document",
    sensitivity: "restricted",
    permissionState: "denied",
    citationPolicy: "cite_path",
    healthState: "healthy",
    stalenessState: "fresh",
  });
  const deniedEntity = await graph.upsertEntity({
    workspaceId: "default",
    type: "customer",
    canonicalName: "Denied Account",
    sensitivity: "restricted",
  });
  const deniedTask = await graph.upsertEntity({
    workspaceId: "default",
    type: "task",
    canonicalName: "Denied Renewal",
    sensitivity: "restricted",
  });
  const deniedRelationship = await graph.assertRelationship({
    workspaceId: "default",
    subjectEntityId: deniedEntity.id,
    predicate: "has_private_task",
    objectEntityId: deniedTask.id,
    sourceId: deniedSource.id,
    confidence: 0.99,
  });
  const deniedRetrieve = await collectTool(graphTool, {
    action: "retrieve",
    workspaceId: "default",
    terms: ["Denied"],
    maxDepth: 2,
  });
  assert.ok(!deniedRetrieve.facts.some(fact => fact.relationship.id === deniedRelationship.id));

  const paths = await collectTool(graphTool, {
    action: "path_search",
    startEntityId: aliceA.id,
    targetEntityId: task.id,
    maxDepth: 2,
  });
  assert.equal(paths.paths.length, 1);
  assert.equal(paths.paths[0].relationships[0].id, relationshipA.id);

  const projectionLog = await collectTool(graphTool, { action: "projection_log" });
  assert.ok(projectionLog.operations.some(operation => operation.operationType === "merge_entity" && /MERGE \(e:CortexEntity/.test(operation.cypher)));
  assert.ok(projectionLog.operations.some(operation => (
    operation.operationType === "merge_relationship" &&
    operation.parameters.sourceVersionId === version.id &&
    operation.status === "queued"
  )));

  const accessEvents = await registry.accessEvents(source.id);
  assert.ok(accessEvents.some(event => event.action === "retrieve" && event.allowed === true));

  const extractionList = await collectTool(graphTool, { action: "list" });
  assert.ok(extractionList.extractionRuns.some(item => item.id === run.id && item.sourceVersionId === version.id));
}

await main();
console.log("context-graph extracts source-backed relationships, dedupes assertions, filters denied sources, retrieves graph facts, and records projection operations");
