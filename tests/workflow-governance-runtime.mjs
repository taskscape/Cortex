import assert from "node:assert/strict";

await import("../local-agent/matbot/apps/cli/register.js");
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
  assert.ok(services.WorkflowCompiler, "WorkflowCompiler should be registered");

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

  const compiled = await collectTool(workflowTool, {
    action: "compile",
    workspaceId: "default",
    name: "Compiled Ticket Followup",
    purpose: "Gather ticket evidence and draft a follow-up for {{ticketId}} owned by {{customerName}}.",
    transcript: "The analyst searched workspace notes, read the ticket source, then drafted a follow-up file for review.",
    sourceIds: [source.id],
    inputHints: [
      { name: "ticketId", type: "string", required: true, sample: "T-123" },
      { name: "customerName", type: "string", required: true, sample: "Acme" },
    ],
    toolCalls: [{
      toolName: "file_broker_action",
      input: { action: "write", path: "outbox/{{ticketId}}-followup.txt", content: "Draft for {{customerName}}" },
      capability: "write",
      connectorInstanceId: "connector-instance:file-broker:local",
      sourceIds: [source.id],
      reason: "Draft compiled follow-up artifact.",
      confidence: 0.76,
      costEstimateUsd: 0.01,
    }],
    publish: true,
    dryRun: true,
  });
  assert.equal(compiled.compilation.status, "dry_run_completed");
  assert.equal(compiled.validation.length, 0);
  assert.equal(compiled.published.definition.name, "Compiled Ticket Followup");
  assert.equal(compiled.published.definition.allowedTools.includes("file_broker_action"), true);
  assert.equal(compiled.published.definition.allowedConnectorInstanceIds.includes("connector-instance:file-broker:local"), true);
  assert.deepEqual(compiled.published.definition.allowedSourceIds, [source.id]);
  assert.deepEqual(compiled.published.definition.inputSchema.required.sort(), ["customerName", "ticketId"]);
  assert.ok(compiled.published.definition.approvalGates.some(gate => gate.type === "action"));
  assert.ok(compiled.published.definition.approvalGates.some(gate => gate.type === "risk"));
  assert.ok(compiled.published.definition.approvalGates.some(gate => gate.type === "expert_review"));
  assert.ok(compiled.published.definition.approvalGates.some(gate => gate.type === "low_confidence"));
  assert.ok(compiled.published.definition.approvalGates.some(gate => gate.type === "cost"));
  assert.equal(compiled.dryRun.mode, "dry_run");
  assert.equal(compiled.dryRun.status, "succeeded");
  assert.equal(compiled.dryRun.proposedActions.length, 1);
  assert.equal(compiled.dryRun.proposedActions[0].input.workflowRunId, compiled.dryRun.id);
  assert.equal(compiled.compilation.dryRunId, compiled.dryRun.id);

  const compiledInspection = await collectTool(workflowTool, { action: "inspect_run", runId: compiled.dryRun.id });
  assert.ok(compiledInspection.events.some(event => event.eventType === "dry_run_completed"));

  const compilationLookup = await collectTool(workflowTool, {
    action: "get_compilation",
    compilationId: compiled.compilation.id,
  });
  assert.equal(compilationLookup.compilation.workflowId, compiled.published.definition.id);

  const compilations = await collectTool(workflowTool, { action: "compilations" });
  assert.ok(compilations.compilations.some(item => item.id === compiled.compilation.id));

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
        { id: "structured-expert-review", type: "expert_review", requiredRiskLevel: "high" },
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

  const shadow = await collectTool(workflowTool, {
    action: "start",
    workspaceId: "default",
    workflowId: draft.definition.id,
    mode: "shadow",
    inputs: { ticketId: "T-123" },
    evidenceSourceIds: [source.id],
    proposedActions: [{
      toolName: "file_broker_action",
      input: { action: "write", path: "outbox/followup.txt", content: "hello" },
      capability: "write",
      connectorInstanceId: "connector-instance:file-broker:local",
      sourceIds: [source.id],
      confidence: 0.91,
    }],
  });
  assert.equal(shadow.mode, "shadow");
  assert.equal(shadow.status, "succeeded");
  assert.equal(shadow.proposedActions[0].status, "proposed");
  assert.equal(shadow.executedActions.length, 0);

  const shadowReject = await services.WorkflowRunner.evaluateToolPolicy(
    "file_broker_action",
    { action: "write", workflowRunId: shadow.id, path: "outbox/followup.txt", content: "hello" },
  );
  assert.equal(shadowReject.allowed, false);
  assert.match(shadowReject.reason, /shadow/);

  const compared = await collectTool(workflowTool, {
    action: "compare_shadow_result",
    runId: shadow.id,
    labels: ["accepted"],
    note: "Human would have sent the proposed follow-up.",
  });
  assert.equal(compared.run.labels.includes("accepted"), true);
  assert.equal(compared.comparison.runId, shadow.id);
  assert.equal(compared.comparison.outcome, "accepted");
  assert.equal(compared.comparison.score, 1);
  assert.deepEqual(compared.comparison.proposedActionIds, [shadow.proposedActions[0].id]);
  assert.deepEqual(compared.comparison.proposedToolNames, ["file_broker_action"]);
  assert.deepEqual(compared.comparison.sourceIds, [source.id]);
  assert.equal(typeof compared.comparison.recommendationHash, "string");

  const shadowReport = await collectTool(workflowTool, { action: "shadow_report" });
  assert.equal(shadowReport.summary.total, 1);
  assert.equal(shadowReport.summary.accepted, 1);
  assert.equal(shadowReport.summary.acceptanceRate, 1);
  assert.equal(shadowReport.comparisons[0].runId, shadow.id);

  const shadowInspection = await collectTool(workflowTool, { action: "inspect_run", runId: shadow.id });
  assert.ok(shadowInspection.events.some(event => event.eventType === "shadow_result_compared"));

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
  assert.ok(runApprovals.length >= 4, "action, risk, stale-source, and expert-review approvals should be requested");
  assert.ok(runApprovals.some(approval => approval.gateId === "structured-expert-review"));

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
