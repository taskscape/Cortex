import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

await import("../local-agent/matbot/apps/cli/register.js");
const { plugin } = await import("../local-agent/matbot/packages/plugins/evaluation-observability/src/index.ts");
const { CHAT_DIAGNOSTIC_RETENTION_MS, chatDiagnosticFileName } = await import("../local-agent/matbot/packages/plugins/evaluation-observability/src/chat-diagnostics.ts");
const { runSession } = await import("../local-agent/matbot/packages/core/runner/src/runner.ts");

class MemoryStore {
  constructor() { this.docs = new Map(); }
  async get(id) { return this.docs.get(id) ?? null; }
  async set(id, value) { this.docs.set(id, value); }
  async cas(id, expected, next) {
    const current = this.docs.get(id) ?? null;
    if (current === null || current.version !== expected) return { ok: false, current };
    this.docs.set(id, next);
    return { ok: true, doc: next };
  }
  async delete(id, expectedVersion) {
    const current = this.docs.get(id) ?? null;
    if (current === null || (expectedVersion !== undefined && current.version !== expectedVersion)) return false;
    return this.docs.delete(id);
  }
  async query(q = {}) {
    let items = [...this.docs.values()];
    if (q.where) items = items.filter(item => match(item, q.where));
    return { items, total: items.length };
  }
}

function readField(item, field) {
  const parts = Array.isArray(field) ? field : String(field).split(".");
  let value = item;
  for (const part of parts) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

function match(item, filter) {
  if (filter.op === "eq") return readField(item, filter.field) === filter.value;
  if (filter.op === "and") return filter.clauses.every(clause => match(item, clause));
  return true;
}

async function main() {
  const workspaceDir = await mkdtemp(join(tmpdir(), "cortex-chat-diagnostics-"));
  const chatLogDir = join(workspaceDir, ".data", "chat-diagnostics");
  const oldLog = join(chatLogDir, "expired.jsonl");
  await mkdir(chatLogDir, { recursive: true });
  await writeFile(oldLog, "{\"expired\":true}\n", "utf8");
  const oldDate = new Date(Date.now() - CHAT_DIAGNOSTIC_RETENTION_MS - 1_000);
  await utimes(oldLog, oldDate, oldDate);
  try {
  const stores = new Map();
  const servicesByKey = new Map();
  const tools = new Map();
  let recordedOutcome;
  const workflowRunner = {
    async recordBusinessOutcome(runId, outcomeId, status) { recordedOutcome = { runId, outcomeId, status }; },
  };
  servicesByKey.set("WorkflowRunner", workflowRunner);

  const services = {
    configPath: join(workspaceDir, "matbot.yaml"),
    providers: new Map([["judge", { name: "judge", module: "test", model: "test-model" }]]),
    createStore(namespace) {
      if (!stores.has(namespace)) stores.set(namespace, new MemoryStore());
      return stores.get(namespace);
    },
    async register(key, value) { servicesByKey.set(key, value); this[key] = value; },
    get(key) { return servicesByKey.get(key); },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    async singleTurn() { return { text: JSON.stringify({ score: 0.9, passed: true, rationale: "Grounded and useful." }), usage: { inputTokens: 20, outputTokens: 10 } }; },
  };

  await plugin.setup(services);
  await assert.rejects(() => readFile(oldLog, "utf8"), /ENOENT/);
  const observability = servicesByKey.get("Observability");
  assert.ok(observability);
  assert.ok(tools.get("evaluation_action"));

  const session = {
    id: "session-observe", version: "1", ownerPrincipalId: "user", status: "active", contexts: [],
    messages: [{ id: "user-message", role: "user", content: [{ type: "text", text: "Run the governed action" }], createdAt: new Date().toISOString(), traceId: "trace-observe" }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const sessionStore = new MemoryStore();
  await sessionStore.set(session.id, session);
  let providerCall = 0;
  const provider = {
    name: "test",
    async *complete() {
      providerCall++;
      if (providerCall === 1) {
        yield { type: "tool-call", id: "tool-call-1", name: "test_action", input: { action: "write", password: "should-not-persist" } };
        yield { type: "usage", inputTokens: 10, outputTokens: 2 };
      } else {
        yield { type: "text-delta", delta: "Completed with citation." };
        yield { type: "usage", inputTokens: 8, outputTokens: 4 };
      }
      yield { type: "done" };
    },
    async health() { return { status: "ok" }; },
  };
  const testTool = {
    name: "test_action", description: "test", inputSchema: {},
    executor: { async *execute() { yield { type: "result", value: { ok: true, citation: { sourceId: "source:1", versionId: "version:1" } } }; } },
  };

  const events = [];
  for await (const event of runSession({
    session,
    config: { provider: "test", traceId: "trace-observe", rootTraceId: "root-observe", sessionId: session.id },
    provider,
    providerConfig: { name: "test", module: "test", model: "test-model" },
    tools: new Map([[testTool.name, testTool]]),
    store: sessionStore,
    signal: new AbortController().signal,
    observability,
    async loadPlugin() { throw new Error("not used"); },
    async unloadPlugin() { return false; },
  })) events.push(event);
  assert.equal(events.at(-1).type, "done");

  const chatLog = await readFile(join(chatLogDir, chatDiagnosticFileName(session.id)), "utf8");
  const chatEntries = chatLog.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(chatEntries.some(entry => entry.event.name === "matbot.turn" && entry.event.phase === "start" && entry.event.attributes.request.text === "Run the governed action"));
  assert.ok(chatEntries.some(entry => entry.event.name === "gen_ai.chat" && entry.event.phase === "start" && entry.event.attributes.request.latestHumanText === "Run the governed action"));
  assert.ok(chatEntries.some(entry => entry.event.name === "gen_ai.tool_selection" && entry.event.attributes.decision === "tool_calls_requested"));
  assert.ok(chatEntries.some(entry => entry.event.name === "test_action" && entry.event.phase === "end" && entry.event.attributes.result.ok === true));
  assert.ok(chatEntries.some(entry => entry.event.name === "gen_ai.chat" && entry.event.phase === "end" && entry.event.attributes.response.text === "Completed with citation."));
  assert.equal(chatLog.includes("should-not-persist"), false);
  assert.equal(chatLog.includes("[REDACTED]"), true);

  await observability.record({
    traceId: "trace-observe", rootTraceId: "root-observe", spanId: "retrieval-1", timestamp: new Date().toISOString(),
    phase: "end", kind: "retriever", name: "workspace_rag.search", status: "ok", durationMs: 12,
    attributes: { retrievedSourceIds: ["source:1"], hits: [{ rank: 1, sourceId: "source:1", score: 0.95, citation: { sourceId: "source:1", versionId: "version:1" } }] },
  });
  await observability.record({
    traceId: "trace-observe", rootTraceId: "root-observe", spanId: "policy-1", timestamp: new Date().toISOString(),
    phase: "end", kind: "guardrail", name: "connector.policy", status: "ok", durationMs: 1,
    attributes: { policyOutcome: "allowed" },
  });

  const inspected = await observability.inspectTrace("trace-observe");
  assert.equal(inspected.trace.status, "ok");
  assert.equal(inspected.trace.inputTokens, 18);
  assert.equal(inspected.trace.outputTokens, 6);
  assert.ok(inspected.spans.some(span => span.kind === "llm"));
  assert.ok(inspected.spans.some(span => span.kind === "tool"));
  assert.equal(JSON.stringify(inspected).includes("should-not-persist"), false);
  assert.equal(JSON.stringify(inspected).includes("[REDACTED]"), true);

  const replay = await observability.replayTrace("trace-observe");
  assert.equal(replay.mode, "playback");
  assert.equal(replay.writesExecuted, false);
  assert.ok(replay.timeline.length > 0);

  const created = await observability.upsertSuite({
    workspaceId: "default", name: "Governed regression", passThreshold: 1,
    scorers: [
      { name: "exact output", type: "equals", path: "message", expected: "hello" },
      { name: "retrieval precision", type: "retrieval_precision_at_k", path: "retrievedSourceIds", expected: ["source:1"], threshold: 0.5 },
      { name: "judge usefulness", type: "model_rubric", rubric: "The output is useful and grounded.", provider: "judge", threshold: 0.8 },
    ],
    cases: [{ name: "static governed case", input: { actual: { message: "hello", retrievedSourceIds: ["source:1", "source:2"] } }, expected: {} }],
  });
  const evaluation = await observability.runSuite(created.suite.id, "candidate-1", "judge");
  assert.equal(evaluation.run.status, "completed");
  assert.equal(evaluation.run.passed, true);
  assert.equal(evaluation.results.length, 3);
  assert.ok(evaluation.results.every(result => result.passed));
  assert.ok(evaluation.results.some(result => result.scorerType === "model_rubric" && result.rationale === "Grounded and useful."));

  const baseline = await observability.upsertBaseline({
    workspaceId: "default", workflowId: "workflow:invoice", name: "Manual invoice review",
    manualActiveMinutes: 60, loadedHourlyRateUsd: 120, effectiveFrom: "2026-01-01T00:00:00.000Z", fixedCostUsd: 10,
  });
  await assert.rejects(() => observability.recordOutcome({
    workspaceId: "other", workflowId: "workflow:invoice", workflowRunId: "run:invoice:1", baselineId: baseline.id,
    status: "verified_completed", humanActiveMinutes: 10, reviewMinutes: 5, reworkMinutes: 5,
    additionalValueUsd: 20, occurredAt: new Date().toISOString(), verifiedByPrincipalId: "finance-owner",
  }), /same workspace and workflow/);
  const outcome = await observability.recordOutcome({
    workspaceId: "default", workflowId: "workflow:invoice", workflowRunId: "run:invoice:1", baselineId: baseline.id,
    status: "verified_completed", humanActiveMinutes: 10, reviewMinutes: 5, reworkMinutes: 5,
    additionalValueUsd: 20, occurredAt: new Date().toISOString(), verifiedByPrincipalId: "finance-owner", traceId: "trace-observe",
  });
  assert.deepEqual(recordedOutcome, { runId: "run:invoice:1", outcomeId: outcome.id, status: "verified_completed" });
  const roi = await observability.roi("default");
  assert.equal(roi.verifiedOutcomes, 1);
  assert.ok(Math.abs(roi.timeSavedHours - (40 / 60)) < 0.000001);
  assert.ok(Math.abs(roi.totalBenefitUsd - 100) < 0.000001);
  assert.ok(roi.netBenefitUsd < 100 && roi.netBenefitUsd > 89);

  const metrics = await observability.metrics("default");
  assert.equal(metrics.traces.total >= 2, true);
  assert.equal(metrics.retrieval.operations, 1);
  assert.equal(metrics.citations.resolved >= 1, true);
  assert.equal(metrics.actions.attempted >= 1, true);
  assert.equal(metrics.policy.decisions, 1);
  assert.equal(metrics.workflows.verifiedCompleted, 1);
  assert.equal(metrics.evaluations.runs, 1);
  assert.equal(metrics.evaluations.passRate, 1);

  console.log("evaluation-observability records governed evidence");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

await main();
