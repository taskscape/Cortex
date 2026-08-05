import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { plugin } = await import("../local-agent/matbot/packages/plugins/workflow-governance/src/index.ts");

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

  async query(query = {}) {
    let items = [...this.docs.values()];
    if (query.where !== undefined) items = items.filter(item => matches(item, query.where));
    return { items, total: items.length };
  }
}

function fieldValue(item, field) {
  let value = item;
  for (const part of Array.isArray(field) ? field : [field]) {
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
    callId: "workflow-draft-only-test",
    signal: new AbortController().signal,
    session: {
      id: "workflow-draft-only-session",
      version: "1",
      ownerPrincipalId: "system",
      status: "active",
      contexts: [],
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    vault: { async resolve(value) { return value; } },
    async prompt() { throw new Error("No prompt expected in workflow compiler test."); },
    async loadPlugin() { throw new Error("No plugin load expected in workflow compiler test."); },
    async unloadPlugin() { return false; },
  })) {
    events.push(event);
  }
  const error = events.find(event => event.type === "error");
  if (error !== undefined) throw new Error(error.message);
  return events.find(event => event.type === "result")?.value;
}

function createWorkflowFixture() {
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
  };
  return { services, tools, hooks };
}

test("WCD-1/2/3/5/6/7/8 draft-only compilation persists deterministically and can later publish", async () => {
  const { services, tools } = createWorkflowFixture();
  await plugin.setup(services);

  const workflowTool = tools.get("workflow_action");
  const registry = services.WorkflowRegistry;
  assert.ok(workflowTool, "workflow_action should be registered");
  assert.ok(registry, "WorkflowRegistry should be registered");

  const compileInput = {
    action: "compile",
    workspaceId: "draft-only-workspace",
    name: "Draft-only customer follow-up",
    purpose: "Prepare a governed follow-up for {{customerId}} and {{caseId}}.",
    transcript: "Use the supplied customer and case identifiers to prepare a reviewable draft.",
    publish: false,
  };
  const drafted = await collectTool(workflowTool, compileInput);
  const workflowId = registry.stableWorkflowId(compileInput.workspaceId, compileInput.name);

  assert.equal(drafted.compilation.status, "drafted");
  assert.equal(drafted.published, undefined);
  assert.equal(drafted.dryRun, undefined);
  assert.equal(drafted.compilation.workflowId, undefined);
  assert.equal(drafted.compilation.workflowVersion, undefined);
  assert.deepEqual(drafted.compilation.sampleInputs, { customerId: "sample", caseId: "sample" });
  assert.deepEqual(drafted.definition.inputSchema.required, ["customerId", "caseId"]);
  assert.equal(drafted.compilation.compilerVersion, "deterministic-workflow-compiler-v1");
  assert.match(drafted.compilation.inputHash, /^[a-f0-9]{64}$/);

  const storedDraft = await collectTool(workflowTool, {
    action: "get_compilation",
    compilationId: drafted.compilation.id,
  });
  assert.equal(storedDraft.compilation.id, drafted.compilation.id);
  assert.equal(storedDraft.compilation.inputHash, drafted.compilation.inputHash);
  assert.equal(await registry.getDefinition(workflowId), null);
  assert.deepEqual(await registry.queryDefinitions(), []);
  assert.deepEqual(await registry.queryVersions(), []);

  const repeatedDraft = await collectTool(workflowTool, compileInput);
  assert.equal(repeatedDraft.compilation.id, drafted.compilation.id);
  assert.equal(repeatedDraft.compilation.inputHash, drafted.compilation.inputHash);

  // There is no separate publish action: the existing compiler publishes the
  // persisted draft when it is recompiled with the same input and publish=true.
  const published = await collectTool(workflowTool, { ...compileInput, publish: true });
  assert.equal(published.compilation.id, drafted.compilation.id);
  assert.equal(published.compilation.status, "published");
  assert.equal(published.compilation.inputHash, drafted.compilation.inputHash);
  assert.equal(published.published.definition.id, workflowId);
  assert.equal(published.compilation.workflowId, workflowId);
  assert.equal(published.compilation.workflowVersion, published.published.definition.version);
  assert.deepEqual(await registry.getDefinition(workflowId), published.published.definition);
  assert.deepEqual(await registry.getVersion(published.published.version.id), published.published.version);
});

test("WCD-4 draft compilation persists validation errors and compiler warnings for inspection", async () => {
  const { services, tools } = createWorkflowFixture();
  await plugin.setup(services);

  const drafted = await collectTool(tools.get("workflow_action"), {
    action: "compile",
    workspaceId: "draft-validation-workspace",
    name: "Draft validation probe",
    approvalGates: [{ id: "invalid-gate", type: "unsupported-gate" }],
    publish: false,
    dryRun: true,
  });

  assert.equal(drafted.compilation.status, "drafted");
  assert.ok(drafted.compilation.validation.some(error => (
    error.path === "$.approvalGates[0].type" && /Unsupported approval gate type/.test(error.message)
  )));
  assert.ok(drafted.compilation.warnings.includes(
    "No tool calls were supplied; compiled workflow will only validate inputs and evidence.",
  ));
  assert.ok(drafted.compilation.warnings.includes(
    "No source ids were supplied; compiled workflow has no required evidence yet.",
  ));
  assert.ok(drafted.compilation.warnings.includes(
    "dryRun was requested without publish=true; no run was created.",
  ));
});
