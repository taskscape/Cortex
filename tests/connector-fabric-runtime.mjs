import assert from "node:assert/strict";

const { plugin } = await import("../local-agent/matbot/packages/plugins/connector-fabric/src/index.ts");

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
    case "in":
      return filter.value.includes(fieldValue(item, filter.field));
    case "nin":
      return !filter.value.includes(fieldValue(item, filter.field));
    case "and":
      return filter.clauses.every(clause => matches(item, clause));
    case "or":
      return filter.clauses.some(clause => matches(item, clause));
    case "not":
      return !matches(item, filter.clause);
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
  const hooks = [];
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
      resolve(name) {
        return tools.get(name) ?? null;
      },
      list() {
        return [...tools.values()];
      },
    },
    hooks: {
      register(hook) {
        hooks.push(hook);
      },
    },
  };

  await plugin.setup(services);
  const registry = services.ConnectorRegistry;
  assert.ok(registry, "ConnectorRegistry service should be registered");
  assert.ok(tools.get("connector_action"), "connector_action tool should be registered");

  const definitions = await registry.queryDefinitions();
  assert.ok(definitions.some(definition => definition.id === "connector-definition:workspace-rag"));
  assert.ok(definitions.some(definition => definition.id === "connector-definition:mcp"));
  assert.ok(definitions.some(definition => definition.id === "connector-definition:workflow-governance"));
  assert.ok(definitions.some(definition => definition.id === "connector-definition:context-graph"));

  const workspaceRead = await registry.evaluateToolCall({
    toolName: "workspace_rag",
    input: { action: "search", query: "architecture" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(workspaceRead.allowed, true);
  assert.equal(workspaceRead.capability, "read");

  const sourceHealthRead = await registry.evaluateToolCall({
    toolName: "source_health_action",
    input: { action: "warnings" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(sourceHealthRead.allowed, true);
  assert.equal(sourceHealthRead.capability, "read");

  const workspaceWrite = await registry.evaluateToolCall({
    toolName: "workspace_rag",
    input: { action: "configure" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(workspaceWrite.allowed, true);
  assert.equal(workspaceWrite.capability, "write");
  assert.equal(workspaceWrite.approvalPolicyId, "workspace-rag-write");

  const dynamicMcp = await registry.evaluateToolCall({
    toolName: "mcp__github__search_issues",
    input: { q: "connector" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(dynamicMcp.allowed, true);
  assert.equal(dynamicMcp.capability, "admin");

  const structuredPlan = await registry.evaluateToolCall({
    toolName: "structured_data_action",
    input: { action: "plan_query" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(structuredPlan.allowed, true);
  assert.equal(structuredPlan.capability, "read");

  const structuredAdmin = await registry.evaluateToolCall({
    toolName: "structured_data_action",
    input: { action: "upsert_metric" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(structuredAdmin.allowed, true);
  assert.equal(structuredAdmin.capability, "admin");
  assert.equal(structuredAdmin.approvalPolicyId, "structured-data-admin");

  const workflowStart = await registry.evaluateToolCall({
    toolName: "workflow_action",
    input: { action: "start" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(workflowStart.allowed, true);
  assert.equal(workflowStart.capability, "write");
  assert.equal(workflowStart.approvalPolicyId, "workflow-governance-admin");

  const workflowShadowReport = await registry.evaluateToolCall({
    toolName: "workflow_action",
    input: { action: "shadow_report" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(workflowShadowReport.allowed, true);
  assert.equal(workflowShadowReport.capability, "read");

  const workflowShadowCompare = await registry.evaluateToolCall({
    toolName: "workflow_action",
    input: { action: "compare_shadow_result" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(workflowShadowCompare.allowed, true);
  assert.equal(workflowShadowCompare.capability, "write");
  assert.equal(workflowShadowCompare.approvalPolicyId, "workflow-governance-admin");

  const workflowApprove = await registry.evaluateToolCall({
    toolName: "workflow_action",
    input: { action: "approve" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(workflowApprove.allowed, true);
  assert.equal(workflowApprove.capability, "admin");

  const contextRetrieve = await registry.evaluateToolCall({
    toolName: "context_graph_action",
    input: { action: "retrieve", workspaceId: "default", terms: ["ticket"] },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(contextRetrieve.allowed, true);
  assert.equal(contextRetrieve.capability, "read");

  const contextExtract = await registry.evaluateToolCall({
    toolName: "context_graph_action",
    input: { action: "extract_source", sourceId: "source:123", text: "OPS-123" },
    principal: { id: "alice", type: "user" },
  });
  assert.equal(contextExtract.allowed, true);
  assert.equal(contextExtract.capability, "write");
  assert.equal(contextExtract.approvalPolicyId, "context-graph-write");

  await registry.upsertGrant({
    connectorInstanceId: "connector-instance:workspace-rag:local",
    principalId: "system",
    scopes: ["*"],
    allowedTools: ["workspace_rag"],
    deniedTools: ["workspace_rag:search"],
    approvalRules: ["workspace-rag-write"],
  });

  const toolcall = hooks.find(hook => hook.on === "toolcall");
  assert.ok(toolcall, "toolcall policy hook should be registered");
  const rejected = await toolcall.handler({
    session: { id: "s1", messages: [] },
    config: { provider: "test-provider" },
    signal: new AbortController().signal,
    toolCall: { id: "call-denied", name: "workspace_rag", input: { action: "search", query: "blocked" } },
    tool: { name: "workspace_rag" },
    removeHook() {},
  });
  assert.match(rejected.rejectTool.message, /denies tool/);

  const deniedAudits = await registry.auditEvents({
    where: { op: "eq", field: "toolCallId", value: "call-denied" },
  });
  assert.equal(deniedAudits.length, 1);
  assert.equal(deniedAudits[0].status, "denied");
  assert.equal(deniedAudits[0].principalId, "system");

  const toolresult = hooks.find(hook => hook.on === "toolresult");
  assert.ok(toolresult, "toolresult audit hook should be registered");
  const transformed = await toolresult.handler({
    session: { id: "s1", messages: [] },
    config: { provider: "test-provider" },
    signal: new AbortController().signal,
    toolCall: { id: "call-allowed", name: "file_broker_action", input: { action: "write", path: "C:/tmp/a.txt", content: "secret", workflowRunId: "workflow-run:123" } },
    tool: { name: "file_broker_action" },
    result: { ok: true, content: "secret", nested: { sourceId: "source:abc" } },
    isError: false,
    durationMs: 12,
    removeHook() {},
  });
  assert.equal(transformed.result.content, "[redacted]");

  const allowedAudits = await registry.auditEvents({
    where: { op: "eq", field: "toolCallId", value: "call-allowed" },
  });
  assert.equal(allowedAudits.length, 1);
  assert.equal(allowedAudits[0].status, "allowed");
  assert.deepEqual(allowedAudits[0].sourceIds, ["source:abc"]);
  assert.equal(allowedAudits[0].capability, "write");
  assert.equal(allowedAudits[0].workflowRunId, "workflow-run:123");

  const connectorTool = tools.get("connector_action");
  const listedTools = await collectTool(connectorTool, { action: "list_tools", connectorInstanceId: "connector-instance:workspace-rag:local" });
  assert.equal(listedTools.bindings.length, 1);
  assert.equal(listedTools.bindings[0].toolName, "workspace_rag");

  const health = await collectTool(connectorTool, { action: "test_health", connectorInstanceId: "connector-instance:workspace-rag:local" });
  assert.equal(health.state, "degraded");
  assert.match(health.message, /Missing connector tools/);

  const audit = await collectTool(connectorTool, { action: "list_audit" });
  assert.equal(audit.events.length, 2);
}

await main();
console.log("connector-fabric enforces connector grants, seeds local bindings, records audit events, and redacts sensitive fields");
