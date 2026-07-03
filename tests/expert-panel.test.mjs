import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { plugin: expertPanelPlugin } = await import("../local-agent/matbot/plugins/expert-panel/src/index.ts");

test("expert panel runs selected experts with isolated knowledge and synthesis", async () => {
  let registeredTool;
  const calls = [];

  const services = {
    providers: new Map([["openai", {}]]),
    createStore() {
      return new MemoryStore();
    },
    async register(key, value) {
      this[key] = value;
    },
    tools: {
      register(tool) {
        registeredTool = tool;
      }
    },
    async singleTurn(request) {
      calls.push(request);
      return {
        text: `fake response ${calls.length}`,
        usage: { inputTokens: 10, outputTokens: 5 }
      };
    }
  };

  await expertPanelPlugin.setup(services);
  assert.equal(registeredTool?.name, "expert_panel");
  assert.ok(services.ExpertPanel);

  const listEvents = [];
  for await (const event of registeredTool.executor.execute({ action: "list" }, { signal: new AbortController().signal, provider: "openai" })) {
    listEvents.push(event);
  }
  const listResult = listEvents.find(event => event.type === "result");
  assert.ok(listResult.value.experts.some(expert => expert.id === "finance"));
  assert.ok(listResult.value.experts.some(expert => expert.id === "security"));
  assert.ok(listResult.value.experts.some(expert => expert.id === "legal"));
  assert.equal(listResult.value.experts.some(expert => "systemPrompt" in expert), false);

  const events = [];
  const context = { signal: new AbortController().signal, provider: "openai" };
  for await (const event of registeredTool.executor.execute({
    question: "Compare PanelProbeDesign PanelProbeFinance PanelProbeEngineering.",
    experts: ["design", "finance", "engineering"],
    mode: "review",
    maxCitationsPerExpert: 2,
    synthesize: true
  }, context)) {
    events.push(event);
  }

  const resultEvent = events.find(event => event.type === "result");
  assert.ok(resultEvent);
  assert.equal(resultEvent.value.experts.length, 3);
  assert.equal(typeof resultEvent.value.synthesis, "string");

  const design = resultEvent.value.experts.find(expert => expert.expertId === "design");
  const finance = resultEvent.value.experts.find(expert => expert.expertId === "finance");
  const engineering = resultEvent.value.experts.find(expert => expert.expertId === "engineering");

  assert.ok(design.citations.some(citation => citation.title === "panel-probe.md"));
  assert.ok(finance.citations.some(citation => citation.title === "panel-probe.md"));
  assert.ok(engineering.citations.some(citation => citation.title === "panel-probe.md"));

  assert.match(calls[0].prompt, /PanelProbeDesign/);
  assert.match(calls[1].prompt, /PanelProbeFinance/);
  assert.match(calls[2].prompt, /PanelProbeEngineering/);
  assert.match(calls[3].system, /orchestrating agent/i);

  const reviewEvents = [];
  for await (const event of registeredTool.executor.execute({
    action: "review",
    question: "Should workflow workflow-123 send customer escalation follow-up automatically?",
    experts: ["finance", "security", "operations"],
    mode: "review",
    reviewMode: "pre_automation_review",
    targetType: "workflow",
    targetId: "workflow-123",
    workflowId: "workflow-123",
    workflowRunId: "workflow-run-123",
    synthesize: true
  }, context)) {
    reviewEvents.push(event);
  }

  const reviewResult = reviewEvents.find(event => event.type === "result")?.value;
  assert.ok(reviewResult.review.id);
  assert.equal(reviewResult.review.targetType, "workflow");
  assert.equal(reviewResult.review.workflowId, "workflow-123");
  assert.equal(reviewResult.review.workflowRunId, "workflow-run-123");
  assert.equal(reviewResult.review.reviewMode, "pre_automation_review");
  assert.equal(reviewResult.review.experts.length, 3);
  assert.ok(reviewResult.review.experts.every(expert => typeof expert.confidence === "number"));
  assert.ok(reviewResult.review.approvalChecklist.some(item => /automation rollback path confirmed/.test(item)));
  assert.ok(Array.isArray(reviewResult.review.riskRegister));

  const getEvents = [];
  for await (const event of registeredTool.executor.execute({
    action: "get_review",
    reviewId: reviewResult.review.id
  }, context)) {
    getEvents.push(event);
  }
  assert.equal(getEvents.find(event => event.type === "result")?.value.review.id, reviewResult.review.id);

  const listReviewEvents = [];
  for await (const event of registeredTool.executor.execute({ action: "list_reviews" }, context)) {
    listReviewEvents.push(event);
  }
  const reviews = listReviewEvents.find(event => event.type === "result")?.value.reviews;
  assert.ok(reviews.some(review => review.id === reviewResult.review.id));
});

test("expert panel reports unknown experts as tool errors", async () => {
  let registeredTool;
  const services = {
    providers: new Map([["openai", {}]]),
    createStore() {
      return new MemoryStore();
    },
    tools: {
      register(tool) {
        registeredTool = tool;
      }
    },
    async singleTurn() {
      throw new Error("singleTurn should not be called for unknown experts");
    }
  };

  await expertPanelPlugin.setup(services);

  const events = [];
  for await (const event of registeredTool.executor.execute({
    question: "Test",
    experts: ["nonexistent"]
  }, { signal: new AbortController().signal, provider: "openai" })) {
    events.push(event);
  }

  const error = events.find(event => event.type === "error");
  assert.match(error?.message ?? "", /Unknown expert/);
});

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

  async query(query = {}) {
    let items = [...this.docs.values()];
    if (query.where !== undefined) items = items.filter(item => matches(item, query.where));
    return { items, total: items.length };
  }
}

function matches(item, filter) {
  if (filter.op === "eq") return fieldValue(item, filter.field) === filter.value;
  if (filter.op === "and") return filter.clauses.every(clause => matches(item, clause));
  if (filter.op === "or") return filter.clauses.some(clause => matches(item, clause));
  return true;
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
