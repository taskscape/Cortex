import assert from "node:assert/strict";

const { plugin } = await import("../local-agent/matbot/packages/plugins/workflow-governance/src/index.ts");
const { plugin: sourceRegistryPlugin } = await import("../local-agent/matbot/packages/plugins/source-registry/src/index.ts");
const { plugin: connectorFabricPlugin } = await import("../local-agent/matbot/packages/plugins/connector-fabric/src/index.ts");

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
    case "or":
      return filter.clauses.some(clause => matches(item, clause));
    default:
      return true;
  }
}

async function collectTool(tool, input) {
  const events = [];
  for await (const event of tool.executor.execute(input, {
    callId: "test-call",
    signal: new AbortController().signal,
    session: { id: "session", version: "1", ownerPrincipalId: "system", status: "active", contexts: [], messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    vault: { async resolve(value) { return value; } },
    async prompt() { throw new Error("No prompt in test."); },
    async loadPlugin() { throw new Error("No plugin load in test."); },
    async unloadPlugin() { return false; },
  })) {
    events.push(event);
  }
  const error = events.find(event => event.type === "error");
  if (error !== undefined) return { error: error.message };
  return events.find(event => event.type === "result")?.value;
}

async function runToolCallHooks(hooks, toolCall) {
  for (const hook of hooks.filter(item => item.on === "toolcall").sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))) {
    const result = await hook.handler({
      session: { id: "session", version: "1", ownerPrincipalId: "system", status: "active", contexts: [], messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      toolCall,
      tool: { name: toolCall.name, description: "", inputSchema: {}, executor: { async *execute() {} } },
      config: { provider: "test" },
      signal: new AbortController().signal,
      removeHook() {},
    });
    if (result?.rejectTool !== undefined) return result.rejectTool.message;
  }
  return null;
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
    },
    hooks: {
      register(hook) {
        hooks.push(hook);
      },
    },
    Vault: {
      async resolve(value) { return value; },
    },
  };

  await sourceRegistryPlugin.setup(services);
  await connectorFabricPlugin.setup(services);
  await plugin.setup(services);

  const workflowTool = tools.get("workflow_action");
  assert.ok(workflowTool, "workflow_action should be registered");
  assert.ok(services.WorkflowRegistry, "WorkflowRegistry should be registered");
  assert.ok(services.WorkflowRunner, "WorkflowRunner should be registered");

  const invalidDefinition = await collectTool(workflowTool, {
    action: "validate",
    definition: {
      workspaceId: "default",
      name: "Bad Workflow",
      inputSchema: { type: "string" },
    },
  });
  assert.equal(invalidDefinition.valid, false);
  assert.ok(invalidDefinition.errors.some(error => error.path === "$.inputSchema.type"));

  const source = await services.SourceRegistry.upsertSource({
    workspaceId: "default",
    connectorType: "workspace-rag",
    connectorInstanceId: "connector-instance:workspace-rag:local",
    externalId: "doc:ticket-123",
    uri: "memory://ticket-123",
    title: "Ticket 123",
    sourceKind: "document",
    sensitivity: "internal",
    permissionState: "allowed",
    trustLevel: "high",
    citationPolicy: "cite_path",
    healthState: "healthy",
    stalenessState: "stale",
    knownLimitations: [],
    lastObservedAt: new Date().toISOString(),
    lastSuccessfulReadAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  const version = await services.SourceRegistry.upsertVersion({
    sourceId: source.id,
    contentHash: "abc123",
    provenance: { activityId: "test-source" },
  });

  const draft = await collectTool(workflowTool, {
    action: "draft",
    definition: {
      workspaceId: "default",
      name: "Ticket Followup",
      inputSchema: {
        type: "object",
        required: ["ticketId"],
        properties: {
          ticketId: { type: "string" },
        },
      },
      allowedSourceIds: [source.id],
      allowedConnectorInstanceIds: ["connector-instance:file-broker:local"],
      allowedTools: ["file_broker_action"],
      requiredEvidence: [{ name: "ticket", minCitations: 1 }],
      riskLevel: "high",
      approvalGates: [
        { id: "approve-action", type: "action" },
        { id: "approve-stale-source", type: "stale_source" },
        { id: "approve-risk", type: "risk", requiredRiskLevel: "high" },
      ],
      dryRunDefault: true,
      tests: [{ name: "ticket id required", inputs: { ticketId: "T-123" }, expected: { status: "waiting_for_approval" } }],
      successMetrics: ["approved_action_rate"],
    },
  });
  assert.deepEqual(draft.validation, []);
  assert.equal(draft.definition.name, "Ticket Followup");
  assert.equal(draft.version.workflowId, draft.definition.id);

  const failedRun = await collectTool(workflowTool, {
    action: "start",
    workspaceId: "default",
    workflowId: draft.definition.id,
    mode: "approval_gated",
    inputs: {},
  });
  assert.equal(failedRun.status, "failed");
  const failedInspection = await collectTool(workflowTool, { action: "inspect_run", runId: failedRun.id });
  assert.ok(failedInspection.events.some(event => event.eventType === "input_validation_failed"));

  const dryRun = await collectTool(workflowTool, {
    action: "dry_run",
    workspaceId: "default",
    workflowId: draft.definition.id,
    inputs: { ticketId: "T-123" },
    evidenceSourceIds: [source.id],
    proposedActions: [{
      toolName: "file_broker_action",
      input: { action: "write", path: "outbox/followup.txt", content: "hello" },
      capability: "write",
      connectorInstanceId: "connector-instance:file-broker:local",
      sourceIds: [source.id],
      reason: "Draft follow-up",
    }],
  });
  assert.equal(dryRun.mode, "dry_run");
  assert.equal(dryRun.status, "succeeded");
  assert.equal(dryRun.proposedActions.length, 1);
  assert.equal(dryRun.proposedActions[0].status, "proposed");
  assert.equal(dryRun.executedActions.length, 0);
  assert.equal(dryRun.evidenceSourceVersions[0].sourceVersionId, version.id);

  const dryRunReject = await runToolCallHooks(hooks, {
    id: "tool-call-dry",
    name: "file_broker_action",
    input: { action: "write", workflowRunId: dryRun.id, path: "outbox/followup.txt", content: "hello" },
  });
  assert.match(dryRunReject, /dry_run/);

  const started = await collectTool(workflowTool, {
    action: "start",
    workspaceId: "default",
    workflowId: draft.definition.id,
    mode: "approval_gated",
    inputs: { ticketId: "T-123" },
    evidenceSourceIds: [source.id],
    proposedActions: [{
      toolName: "file_broker_action",
      input: { action: "write", path: "outbox/followup.txt", content: "hello" },
      capability: "write",
      connectorInstanceId: "connector-instance:file-broker:local",
      sourceIds: [source.id],
      confidence: 0.9,
      costEstimateUsd: 0.01,
    }],
  });
  assert.equal(started.status, "waiting_for_approval");

  const pending = await collectTool(workflowTool, { action: "list_approvals" });
  const runApprovals = pending.approvals.filter(approval => approval.runId === started.id);
  assert.ok(runApprovals.length >= 3, "action, risk, and stale-source approvals should be requested");

  const blockedOutsideTool = await services.WorkflowRunner.evaluateToolPolicy(
    "workspace_rag",
    { action: "search", workflowRunId: started.id },
  );
  assert.equal(blockedOutsideTool.allowed, false);
  assert.match(blockedOutsideTool.reason, /does not allow tool/);

  const approved = await collectTool(workflowTool, {
    action: "approve",
    runId: started.id,
    reason: "Approved in test",
  });
  assert.equal(approved.run.status, "succeeded");
  assert.equal(approved.run.proposedActions[0].status, "approved");

  const allowedAfterApproval = await services.WorkflowRunner.evaluateToolPolicy(
    "file_broker_action",
    { action: "write", workflowRunId: started.id, path: "outbox/followup.txt", content: "hello" },
  );
  assert.equal(allowedAfterApproval.allowed, true);

  await services.WorkflowRunner.recordToolResult(started.id, "file_broker_action", { ok: true, sourceIds: [source.id] }, false, 12);
  const inspection = await collectTool(workflowTool, { action: "inspect_run", runId: started.id });
  assert.equal(inspection.run.executedActions.length, 1);
  assert.deepEqual(inspection.events.map(event => event.sequence), inspection.events.map((_, index) => index + 1));
  assert.ok(inspection.events.some(event => event.eventType === "tool_executed"));

  const accesses = await services.SourceRegistry.accessEvents(source.id);
  assert.ok(accesses.some(event => event.workflowRunId === dryRun.id));
  assert.ok(accesses.some(event => event.workflowRunId === started.id));
}

await main();
console.log("workflow-governance records event-sourced runs, approvals, evidence, and policy blocks");
