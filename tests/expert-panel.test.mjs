/**
 * Expert panel: validates the multi-expert orchestration tool that runs domain experts
 * independently and can synthesize their opinions into a consolidated response.
 *
 * The expert panel plugin provides a single tool that can:
 * - List available experts (finance, security, legal, design, etc.)
 * - Run a selected set of experts on a question (parallel orchestration)
 * - Collect citations from each expert's knowledge source
 * - Synthesize a single consolidated response from all expert inputs
 * - Create and retrieve expert reviews with checklists and risk registers
 *
 * This test ensures:
 * - The plugin registers the "expert_panel" tool correctly
 * - Expert list shows all configured experts without exposing system prompts
 * - Selected experts run in parallel with isolated knowledge retrieval
 * - Each expert's response includes citations from workspace RAG or skills
 * - Synthesis aggregates expert opinions into a single response
 * - Review mode creates structured reviews with approval checklists and risks
 * - Review lifecycle (create, get, list) works correctly
 *
 * Assumptions:
 * - The plugin loads under the Matbot runtime without a full Matbot server
 * - A simple in-memory store is provided to simulate the persistence layer
 * - Expert files (e.g., "panel-probe.md") exist in the knowledge directory
 * - The fake singleTurn() returns predictable responses for deterministic testing
 * - Each expert has access to the same knowledge sources but provides independent input
 */
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

/**
 * Validates that the expert panel correctly reports unknown experts as tool errors
 * when attempting to run with non-existent experts.
 *
 * This test ensures:
 * - Unknown experts (e.g., "nonexistent") are detected and reported as errors
 * - The singleTurn function is not called for unknown experts (optimization)
 * - The error message contains "Unknown expert"
 *
 * Assumptions:
 * - The expert panel plugin has a list of known experts
 * - The test creates a request with an unknown expert
 * - Success is indicated by the error event containing the expected error message
 */
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
