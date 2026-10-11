/**
 * Runner resilience: an aborted turn must reach its terminal event whatever its tools do.
 *
 * This test ensures:
 * - A tool that ignores its abort signal cannot pin the turn (and the session's queue behind it):
 *   after the abort grace period the invocation is abandoned, its call is answered with an error
 *   result, and the turn ends `aborted` with paired calls/results persisted
 * - A tool that honours the signal still completes its own cleanup before the turn ends
 * - The session runner frees the session for the next submission after such an abort
 *
 * Assumptions:
 * - The core runner is exercised directly with an in-memory store and a scripted provider
 * - `toolAbortGraceMs` shortens the production grace period (10 s) so the test stays fast
 */
import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import("../local-agent/matbot/packages/core/plugin-api/src/index.ts");
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "runner-resilience-test", type: "user" }));

const { runSession } = await import("../local-agent/matbot/packages/core/runner/src/runner.ts");
const { executeToolInvocation } = await import("../local-agent/matbot/packages/core/runner/src/tool-invocation.ts");

process.on("unhandledRejection", error => {
  throw error;
});

function makeSession(id) {
  const now = new Date().toISOString();
  return {
    id, version: "1", ownerPrincipalId: "runner-resilience-test", status: "active", contexts: [],
    messages: [{ id: `${id}-user`, role: "user", createdAt: now, traceId: "", content: [{ type: "text", text: "hello" }] }],
    createdAt: now, updatedAt: now,
  };
}

class MemoryStore {
  constructor() { this.docs = new Map(); }
  async get(id) { const doc = this.docs.get(id); return doc ? structuredClone(doc) : null; }
  async set(id, value) { this.docs.set(id, structuredClone(value)); }
  async cas(id, expected, next) {
    const current = this.docs.get(id) ?? null;
    if (!current || current.version !== expected) return { ok: false, current };
    this.docs.set(id, structuredClone(next));
    return { ok: true, doc: next };
  }
  async delete(id) { return this.docs.delete(id); }
  async query() { return { items: [...this.docs.values()], total: this.docs.size }; }
}

function toolCallingProvider(toolName) {
  let calls = 0;
  return {
    name: "test",
    async health() { return { status: "ok" }; },
    async *complete() {
      calls++;
      if (calls === 1) yield { type: "tool-call", id: "call-1", name: toolName, input: {} };
      else yield { type: "text-delta", delta: "unreachable after abort" };
      yield { type: "done" };
    },
  };
}

async function runTurnAbortingOnToolStart(tool, graceMs) {
  const store = new MemoryStore();
  const session = makeSession(`session-${tool.name}`);
  await store.set(session.id, session);
  const controller = new AbortController();
  const events = [];
  const started = Date.now();
  for await (const event of runSession({
    session,
    config: { provider: "test", traceId: `trace-${tool.name}`, sessionId: session.id },
    provider: toolCallingProvider(tool.name),
    providerConfig: { name: "test", module: "test", model: "m" },
    tools: new Map([[tool.name, tool]]),
    store,
    signal: controller.signal,
    toolAbortGraceMs: graceMs,
    async loadPlugin() { throw new Error("not used"); },
    async unloadPlugin() { return false; },
  })) {
    events.push(event);
    if (event.type === "tool:start") setTimeout(() => controller.abort("user-abort"), 20);
  }
  return { events, elapsedMs: Date.now() - started, persisted: await store.get(session.id) };
}

test("a tool that ignores its abort signal cannot pin the turn", { timeout: 10_000 }, async () => {
  let entered = false;
  const stuck = {
    name: "stuck", description: "never settles and never looks at ctx.signal", inputSchema: {},
    executor: {
      async *execute() {
        entered = true;
        await new Promise(() => {});
        yield { type: "result", value: { unreachable: true } };
      },
    },
  };

  const { events, elapsedMs, persisted } = await runTurnAbortingOnToolStart(stuck, 100);

  assert.equal(entered, true);
  assert.equal(events.at(-1).type, "aborted");
  assert.equal(events.at(-1).reason, "user-abort");
  assert.ok(elapsedMs < 5_000, `turn took ${elapsedMs}ms to end after abort`);

  const end = events.find(event => event.type === "tool:end");
  assert.equal(end.callId, "call-1");
  assert.equal(end.isError, true);

  const calls = persisted.messages.flatMap(m => m.content).filter(c => c.type === "tool-call").map(c => c.id);
  const results = persisted.messages.flatMap(m => m.content).filter(c => c.type === "tool-result").map(c => c.id);
  assert.deepEqual(calls, ["call-1"]);
  assert.deepEqual(results, ["call-1"], "the abandoned call must still be answered so the history stays submittable");
});

test("a tool that honours its abort signal finishes its own cleanup before the turn ends", { timeout: 10_000 }, async () => {
  let cleanedUp = false;
  const cooperative = {
    name: "cooperative", description: "stops when asked", inputSchema: {},
    executor: {
      async *execute(_input, ctx) {
        try {
          await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
          // Cleanup that takes a moment, well inside the grace period.
          await new Promise(resolve => setTimeout(resolve, 50));
          yield { type: "error", message: "stopped on request" };
        } finally {
          cleanedUp = true;
        }
      },
    },
  };

  const { events, elapsedMs } = await runTurnAbortingOnToolStart(cooperative, 2_000);

  assert.equal(events.at(-1).type, "aborted");
  assert.equal(cleanedUp, true, "cleanup must have run by the time the turn reports its terminal event");
  assert.ok(elapsedMs < 1_500, `a cooperative tool must not wait out the grace period (took ${elapsedMs}ms)`);
});

test("direct tool invocation is released once the abort grace period expires", { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const stuck = {
    name: "stuck_direct", description: "never settles", inputSchema: {},
    executor: { async *execute() { await new Promise(() => {}); yield { type: "result", value: null }; } },
  };
  setTimeout(() => controller.abort("user-abort"), 20);
  const outcome = await executeToolInvocation({
    session: makeSession("direct"),
    config: { provider: "test", traceId: "trace-direct" },
    signal: controller.signal,
    vault: { scrub: text => text, async resolve(ref) { return ref; }, hasKey() { return false; } },
    tool: stuck,
    call: { id: "direct-1", name: stuck.name, input: {} },
    toolAbortGraceMs: 100,
    async loadPlugin() { throw new Error("not used"); },
    async unloadPlugin() { return false; },
  });
  assert.equal(outcome.isError, true);
  assert.match(String(outcome.result.error), /user-abort/);
});
