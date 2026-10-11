/**
 * Session runner replay: what a viewer joining mid-turn is sent must stay small however long the
 * turn has been streaming, and must still add up to exactly what live viewers saw.
 *
 * This test ensures:
 * - A viewer that attaches while an answer is streaming receives the text so far as a handful of
 *   events rather than one per fragment, and the same for a tool's output
 * - Folding never changes content or order: the replayed text equals the live text, fragments of
 *   different tool calls stay separate, and non-streaming events keep their place between them
 * - Live viewers are unaffected: they still receive every fragment as it is produced, and the
 *   fragments they hold are not altered by later folding
 *
 * Assumptions:
 * - The core session runner is exercised directly with an in-memory store and a scripted provider
 *   that streams a fixed number of fragments, calls one tool, and then waits for the test
 */
import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import("../local-agent/matbot/packages/core/plugin-api/src/index.ts");
const principal = { id: "session-replay-test", type: "user" };
installPrincipalCarrier(createConstantPrincipalCarrier(principal));

const { createSessionRunner } = await import("../local-agent/matbot/packages/core/runner/src/session-runner.ts");

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

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Drains an event stream in the background, recording everything it delivers. */
function collect(events) {
  const seen = [];
  const done = (async () => { for await (const event of events) seen.push(event); })();
  return { seen, done };
}

async function until(predicate, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const FRAGMENTS = 3_000;
const OUTPUT_CHUNKS = 500;

test("a viewer joining mid-turn is replayed the stream folded, with nothing lost or reordered", { timeout: 20_000 }, async () => {
  const store = new MemoryStore();
  const now = new Date().toISOString();
  await store.set("s1", { id: "s1", version: "1", ownerPrincipalId: principal.id, status: "active", contexts: [], messages: [], createdAt: now, updatedAt: now });

  const answerStreamed = deferred();
  const releaseTurn = deferred();
  let completions = 0;
  const provider = {
    name: "scripted",
    async health() { return { status: "ok" }; },
    async *complete() {
      completions++;
      if (completions === 1) {
        for (let index = 0; index < FRAGMENTS; index++) yield { type: "thinking", delta: `t${index} ` };
        for (let index = 0; index < FRAGMENTS; index++) yield { type: "text-delta", delta: `w${index} ` };
        yield { type: "tool-call", id: "call-a", name: "chatty", input: { label: "a" } };
        yield { type: "tool-call", id: "call-b", name: "chatty", input: { label: "b" } };
        yield { type: "done" };
        return;
      }
      yield { type: "text-delta", delta: "after " };
      yield { type: "text-delta", delta: "tools" };
      answerStreamed.resolve();
      await releaseTurn.promise;
      yield { type: "done" };
    },
  };
  const chatty = {
    name: "chatty", description: "prints a lot", inputSchema: { type: "object" }, serial: true,
    executor: {
      async *execute(input) {
        for (let index = 0; index < OUTPUT_CHUNKS; index++) yield { type: "stdout", chunk: `${input.label}${index}\n` };
        yield { type: "stderr", chunk: `${input.label}-warning\n` };
        yield { type: "result", value: { ok: true } };
      },
    },
  };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter: provider, config: { name: "scripted", module: "scripted", model: "m" } }),
    tools: {
      list: () => [chatty],
      resolve: name => (name === "chatty" ? chatty : null),
    },
    async loadPlugin() { throw new Error("not used"); },
    async unloadPlugin() { return false; },
  });

  const liveAbort = new AbortController();
  const lateAbort = new AbortController();
  const submitted = await runner.open({
    sessionId: "s1", signal: liveAbort.signal, content: [{ type: "text", text: "go" }], provider: "scripted", principal,
  });
  const live = collect(submitted.events);
  await answerStreamed.promise;
  await until(() => live.seen.filter(event => event.type === "text-delta").length === FRAGMENTS + 2, "the live viewer to catch up");

  // The turn is still running; a second viewer attaches now.
  const late = collect((await runner.open({ sessionId: "s1", signal: lateAbort.signal })).events);
  await until(() => late.seen.some(event => event.type === "text-delta" && event.delta.endsWith("tools")), "the replay to arrive");

  const textOf = (events, type) => events.filter(event => event.type === type).map(event => event.delta).join("");
  const outputOf = (events, type, callId) => events.filter(event => event.type === type && event.callId === callId).map(event => event.chunk).join("");

  // Live viewers still see every fragment, each exactly as it was produced.
  assert.equal(live.seen.filter(event => event.type === "thinking").length, FRAGMENTS);
  assert.equal(live.seen.find(event => event.type === "text-delta").delta, "w0 ");
  assert.equal(live.seen.filter(event => event.type === "tool:stdout").length, OUTPUT_CHUNKS * 2);

  // The late viewer gets the same content in a handful of events.
  assert.ok(late.seen.length < 40, `the replay was ${late.seen.length} events for a turn of ${live.seen.length}`);
  assert.equal(textOf(late.seen, "thinking"), textOf(live.seen, "thinking"));
  assert.equal(textOf(late.seen, "text-delta"), textOf(live.seen, "text-delta"));
  for (const callId of ["call-a", "call-b"]) {
    assert.equal(outputOf(late.seen, "tool:stdout", callId), outputOf(live.seen, "tool:stdout", callId));
    assert.equal(outputOf(late.seen, "tool:stderr", callId), outputOf(live.seen, "tool:stderr", callId));
  }

  // Structure is preserved: the first answer and the one after the tools stay separate, and each
  // call's output sits between its own start and end.
  const shape = late.seen.map(event => (event.callId ? `${event.type}:${event.callId}` : event.type));
  assert.deepEqual(shape.filter(type => type === "text-delta").length, 2);
  for (const callId of ["call-a", "call-b"]) {
    const start = shape.indexOf(`tool:start:${callId}`);
    const end = shape.indexOf(`tool:end:${callId}`);
    assert.ok(start >= 0 && end > start, `call ${callId} is replayed with its start before its end`);
    assert.deepEqual(shape.slice(start + 1, end), [`tool:stdout:${callId}`, `tool:stderr:${callId}`]);
  }
  assert.ok(shape.indexOf("thinking") < shape.indexOf("text-delta"));
  assert.ok(shape.indexOf("text-delta") < shape.indexOf("tool:start:call-a"));
  assert.ok(shape.lastIndexOf("text-delta") > shape.indexOf("tool:end:call-b"));

  releaseTurn.resolve();
  await until(() => live.seen.some(event => event.type === "done"), "the turn to finish");
  assert.ok(late.seen.some(event => event.type === "done"), "the late viewer follows the turn live after the replay");
  liveAbort.abort();
  lateAbort.abort();
  await Promise.all([live.done, late.done]);
});
