import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { plugin } = await import("../local-agent/matbot/plugins/expert-panel/src/index.ts");

class RecordingStore {
  constructor() {
    this.docs = new Map();
    this.writes = [];
    this.queries = [];
  }

  async get(id) {
    return this.docs.get(id) ?? null;
  }

  async set(id, value) {
    this.writes.push({ id, value });
    this.docs.set(id, value);
  }

  async query(query = {}) {
    this.queries.push(query);
    let items = [...this.docs.values()];
    if (query.where) items = items.filter(item => matches(item, query.where));
    if (Array.isArray(query.sort)) {
      for (const sort of [...query.sort].reverse()) {
        items.sort((left, right) => String(fieldValue(left, sort.field) ?? "")
          .localeCompare(String(fieldValue(right, sort.field) ?? "")) * (sort.dir === "desc" ? -1 : 1));
      }
    }
    const total = items.length;
    if (typeof query.limit === "number") items = items.slice(0, query.limit);
    return { items, total };
  }
}

function fieldValue(value, field) {
  let current = value;
  for (const part of Array.isArray(field) ? field : [field]) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function matches(value, filter) {
  if (filter.op === "eq") return fieldValue(value, filter.field) === filter.value;
  if (filter.op === "and") return filter.clauses.every(clause => matches(value, clause));
  if (filter.op === "or") return filter.clauses.some(clause => matches(value, clause));
  return true;
}

async function execute(tool, input) {
  const events = [];
  for await (const event of tool.executor.execute(input, {
    provider: "test",
    signal: new AbortController().signal,
  })) events.push(event);
  const error = events.find(event => event.type === "error");
  if (error) throw new Error(error.message);
  return events.find(event => event.type === "result")?.value;
}

test("expert reviews persist structured consensus, risks, and links to durable external records", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-expert-review-persistence-"));
  const configPath = path.join(root, "experts.json");
  const expertIds = ["finance", "security", "legal"];
  await Promise.all(expertIds.map(id => mkdir(path.join(root, id))));
  await Promise.all(expertIds.map(id => writeFile(
    path.join(root, id, "evidence.md"),
    `PERSISTENCE_CANARY evidence for ${id}`,
    "utf8",
  )));
  await writeFile(configPath, JSON.stringify({
    defaultProvider: "test",
    experts: expertIds.map(id => ({
      id,
      title: `${id} expert`,
      description: `${id} review`,
      roots: [id],
      systemPrompt: `${id} system`,
    })),
  }), "utf8");

  const previousConfig = process.env.EXPERT_PANEL_CONFIG;
  process.env.EXPERT_PANEL_CONFIG = configPath;
  t.after(async () => {
    if (previousConfig === undefined) delete process.env.EXPERT_PANEL_CONFIG;
    else process.env.EXPERT_PANEL_CONFIG = previousConfig;
    await rm(root, { recursive: true, force: true });
  });

  const reviews = new RecordingStore();
  const tools = new Map();
  const calls = [];
  const services = {
    providers: new Map([["test", {}]]),
    createStore(namespace) {
      assert.equal(namespace, "expert_panel_reviews");
      return reviews;
    },
    async register(key, value) {
      this[key] = value;
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
      },
    },
    async singleTurn(request) {
      calls.push(request);
      if (/orchestrating agent/i.test(request.system)) {
        return { text: "Panel synthesis: do not automate until the blocker is resolved.", usage: { inputTokens: 3, outputTokens: 2 } };
      }
      if (request.system === "finance system") {
        return { text: "Approve. The financial evidence supports the proposal.", usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (request.system === "security system") {
        return { text: "Risk: unauthorised escalation. Blocker: access control review is incomplete; do not approve.", usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return { text: "Risk: agreement terms need review. Mitigation: attach a signed addendum.", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };

  await plugin.setup(services);
  const tool = tools.get("expert_panel");
  assert.ok(tool);

  const reviewed = await execute(tool, {
    action: "review",
    question: "PERSISTENCE_CANARY: should the follow-up be automated?",
    experts: expertIds,
    mode: "review",
    reviewMode: "full_approval_review",
    targetType: "decision_dossier",
    targetId: "dossier-42",
    dossierId: "dossier-42",
    workflowId: "workflow-7",
    workflowRunId: "workflow-run-8",
    synthesize: true,
  });
  const review = reviewed.review;

  assert.equal(review.targetType, "decision_dossier");
  assert.equal(review.targetId, "dossier-42");
  assert.equal(review.dossierId, "dossier-42");
  assert.equal(review.workflowId, "workflow-7");
  assert.equal(review.workflowRunId, "workflow-run-8");
  assert.equal(review.status, "rejected");
  assert.match(review.synthesis, /do not automate/i);
  assert.ok(review.consensus.some(item => /mixed recommendations/i.test(item)));
  assert.ok(review.disagreements.some(item => /block: security/.test(item)));
  assert.ok(review.blockers.some(item => /access control review/i.test(item)));
  assert.ok(review.mitigations.some(item => /signed addendum/i.test(item)));
  assert.ok(review.experts.every(expert => expert.approvalChecklist.some(item => /approval authority confirmed/i.test(item))));
  assert.ok(review.riskRegister.some(item => item.ownerExpertId === "security" && item.severity === "high"));
  assert.ok(review.experts.every(expert => expert.evidenceIds.length === 1 && expert.confidence > 0.65));
  assert.deepEqual(reviews.writes.map(write => write.id), [review.id]);
  assert.strictEqual(reviews.docs.get(review.id), review);
  assert.ok(calls.every(call => call.provider === "test"));

  const retrieved = await execute(tool, { action: "get_review", reviewId: review.id });
  assert.deepEqual(retrieved.review, review);

  const alertReview = await execute(tool, {
    action: "review",
    question: "PERSISTENCE_CANARY: assess the alert.",
    experts: ["finance"],
    targetType: "alert",
    targetId: "alert-9",
    synthesize: false,
  });
  assert.equal(alertReview.review.targetType, "alert");
  assert.equal(alertReview.review.targetId, "alert-9");

  const dossierReviews = await execute(tool, {
    action: "list_reviews",
    query: {
      where: { op: "eq", field: "targetType", value: "decision_dossier" },
      sort: [{ field: "createdAt", dir: "desc" }],
      limit: 1,
    },
  });
  assert.deepEqual(dossierReviews.reviews.map(item => item.id), [review.id]);
  assert.equal(reviews.queries.at(-1).where.value, "decision_dossier");
});
