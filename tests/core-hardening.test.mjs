import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import("../local-agent/matbot/packages/core/plugin-api/src/index.ts");
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "core-hardening-test", type: "user" }));

const { LookupKnowledgeIndex } = await import("../local-agent/matbot/packages/core/knowledge/src/lookup-knowledge-index.ts");
const { HookRegistry } = await import("../local-agent/matbot/packages/core/plugin-api/src/index.ts");
const { runSession } = await import("../local-agent/matbot/packages/core/runner/src/runner.ts");
const { createSessionRunner } = await import("../local-agent/matbot/packages/core/runner/src/session-runner.ts");
const { registerPlugin, setupPlugin, teardownPlugins, unloadPlugin } = await import("../local-agent/matbot/packages/core/runner/src/registry.ts");
const { makePluginSettings } = await import("../local-agent/matbot/packages/core/runner/src/settings.ts");
const { SystemContextRegistryImpl } = await import("../local-agent/matbot/packages/core/runner/src/system-context.ts");
const { VaultImpl } = await import("../local-agent/matbot/packages/core/security/src/vault.ts");
const { parseSSE } = await import("../local-agent/matbot/packages/core/providers/_base/src/sse.ts");
const { fetchWithRetry } = await import("../local-agent/matbot/packages/core/providers/_base/src/http-retry.ts");
const { applySort } = await import("../local-agent/matbot/packages/core/storage/_base/src/query/sort.ts");
const { default: http } = await import("node:http");

process.on("unhandledRejection", error => {
  throw error;
});

function makeSession(id) {
  return {
    id,
    version: "1",
    ownerPrincipalId: "core-hardening-test",
    status: "active",
    contexts: [],
    messages: [{
      id: `${id}-user`, role: "user", createdAt: new Date().toISOString(), traceId: "",
      content: [{ type: "text", text: "hello" }],
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeProvider(onStream) {
  return {
    name: "test",
    async health() { return { status: "ok" }; },
    async *complete(_outgoing, _config, _tools, signal) {
      yield* onStream(signal);
      yield { type: "done" };
    },
  };
}

class MemoryStore {
  constructor() { this.docs = new Map(); this.writtenVersions = []; }
  async get(id) {
    const doc = this.docs.get(id);
    return doc ? structuredClone(doc) : null;
  }
  async set(id, value) {
    this.writtenVersions.push(value?.version);
    this.docs.set(id, structuredClone(value));
  }
  async cas(id, expected, next) {
    const current = this.docs.get(id) ?? null;
    if (!current || current.version !== expected) return { ok: false, current };
    this.writtenVersions.push(next?.version);
    this.docs.set(id, structuredClone(next));
    return { ok: true, doc: next };
  }
  async delete(id) { return this.docs.delete(id); }
  async query() { return { items: [...this.docs.values()], total: this.docs.size }; }
}

test("knowledge index search skips empty terms instead of hanging", async () => {
  const index = new LookupKnowledgeIndex();
  await index.index({ id: "k1", content: "Alpha stores honey", source: "s" });
  const results = await index.search([{ term: "" }, { term: "HONEY" }], new AbortController().signal);
  assert.deepEqual(results.map(entry => entry.id), ["k1"]);
});

test("session is persisted when a toolcall hook aborts the turn", async () => {
  const store = new MemoryStore();
  const session = makeSession("hook-abort-session");
  await store.set(session.id, session);

  const hooks = new HookRegistry();
  hooks.register({ on: "toolcall", handler: async () => ({ abort: "policy-stop" }) });

  const tool = {
    name: "risky", description: "t", inputSchema: {},
    executor: { async *execute() { yield { type: "result", value: { ok: true } }; } },
  };

  const events = [];
  for await (const event of runSession({
    session,
    config: { provider: "test", traceId: "trace-h1", sessionId: session.id },
    provider: makeProvider(function* () {
      yield { type: "tool-call", id: "call-1", name: "risky", input: {} };
      yield { type: "text-delta", delta: "partial answer" };
    }),
    providerConfig: { name: "test", module: "test", model: "m" },
    tools: new Map([[tool.name, tool]]),
    hooks,
    store,
    signal: new AbortController().signal,
    async loadPlugin() { throw new Error("not used"); },
    async unloadPlugin() { return false; },
  })) events.push(event);

  assert.equal(events.at(-1).type, "aborted");
  const persisted = await store.get(session.id);
  assert.ok(
    persisted.messages.some(m => m.role === "assistant"),
    "the streamed assistant turn must be persisted on a toolcall-hook abort",
  );
});

test("pump prelude failures surface as an error event, not an unhandled rejection", async () => {
  const store = new MemoryStore();
  let gets = 0;
  store.get = async id => {
    gets++;
    if (gets === 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      throw new Error("synthetic storage failure");
    }
    return makeSession(id);
  };

  const runner = createSessionRunner({
    store,
    async resolveProvider() { return null; },
    async loadPlugin() { throw new Error("not used"); },
    async unloadPlugin() { return false; },
  });

  const view = await runner.open({
    sessionId: "h2-session",
    content: [{ type: "text", text: "hi" }],
    provider: "test",
    principal: { id: "core-hardening-test", type: "user" },
    signal: new AbortController().signal,
  });

  const events = [];
  for await (const event of view.events) {
    events.push(event);
    if (event.type === "error") break;
  }
  const errorEvent = events.find(event => event.type === "error");
  assert.ok(errorEvent, "a pump prelude failure must emit an error event");
  assert.match(errorEvent.error, /synthetic storage failure/);
});

test("teardownPlugins attributes errors to the plugin that failed", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    registerPlugin({ apiVersion: "0.1", name: "hardening-first", specifier: "hardening-first", teardown: async () => {} });
    registerPlugin({
      apiVersion: "0.1",
      name: "hardening-second",
      specifier: "hardening-second",
      teardown: async () => { throw new Error("second exploded"); },
    });
    await teardownPlugins();
  } finally {
    console.error = originalError;
  }

  const attributed = errors.find(args => String(args[0]).includes("teardown error"));
  assert.ok(attributed, "a failing teardown must be logged");
  assert.match(String(attributed[0]), /plugin "hardening-second"/);
  assert.equal(JSON.stringify(attributed).includes("hardening-first"), false);
});

test("unloadPlugin clears its teardown timeout timer", async () => {
  registerPlugin({ apiVersion: "0.1", name: "hardening-timer", specifier: "hardening-timer" });

  const services = {
    tools: { removeByPlugin() {}, list() { return []; } },
    hooks: { removeByPlugin() {} },
    systemContext: { removeByPlugin() {} },
    unregister() {},
  };

  const timersCreated = [];
  const timersCleared = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn, ms, ...rest) => {
    const id = originalSetTimeout(fn, ms, ...rest);
    timersCreated.push(id);
    return id;
  });
  globalThis.clearTimeout = (id, ...rest) => {
    if (id !== undefined) timersCleared.push(id);
    return originalClearTimeout(id, ...rest);
  };
  try {
    assert.equal(await unloadPlugin("hardening-timer", services), true);
    await new Promise(resolve => originalSetTimeout(resolve, 20));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  assert.deepEqual(
    [...new Set(timersCreated)].sort(),
    [...new Set(timersCleared)].sort(),
    "every timer created during unloadPlugin must be cleared",
  );
});

test("settings CAS uses unique versions and bounds retries under contention", async () => {
  const store = new MemoryStore();
  const settings = makePluginSettings(store, "hardening-settings");

  await settings.set("alpha", 1);
  await Promise.all([
    settings.set("beta", 2),
    settings.set("gamma", 3),
  ]);

  const doc = await store.get("hardening-settings");
  assert.equal(doc.data.alpha, 1);
  assert.equal(doc.data.beta, 2);
  assert.equal(doc.data.gamma, 3);
  assert.ok(store.writtenVersions.length > 0);
  assert.equal(new Set(store.writtenVersions).size, store.writtenVersions.length, "every written CAS version must be unique");

  const contended = new MemoryStore();
  await contended.set("hardening-settings", { id: "hardening-settings", version: "seed", data: {} });
  contended.cas = async () => ({ ok: false, current: null });
  await assert.rejects(
    () => makePluginSettings(contended, "hardening-settings").set("key", "value"),
    /failed after \d+ concurrent attempts/,
  );
});

test("observability spans record scrubbed tool input and result", async () => {
  const vault = {
    async createSecret() { throw new Error("not used"); },
    async writeSecret() { throw new Error("not used"); },
    hasKey() { return false; },
    async resolve(ref) { return ref; },
    scrub(text) { return text.replaceAll("hunter2", "[REDACTED]"); },
  };
  const spans = [];
  const observability = { async record(event) { spans.push(structuredClone(event)); } };

  const tool = {
    name: "leaky", description: "t", inputSchema: {},
    executor: { async *execute() { yield { type: "result", value: { token: "hunter2" } }; } },
  };

  const events = [];
  let providerCalls = 0;
  for await (const event of runSession({
    session: makeSession("scrub-session"),
    config: { provider: "test", traceId: "trace-m6", sessionId: "scrub-session" },
    provider: makeProvider(function* () {
      if (providerCalls++ === 0) {
        yield { type: "tool-call", id: "call-1", name: "leaky", input: { password: "hunter2" } };
      } else {
        yield { type: "text-delta", delta: "finished" };
      }
    }),
    providerConfig: { name: "test", module: "test", model: "m" },
    tools: new Map([[tool.name, tool]]),
    vault,
    store: new MemoryStore(),
    signal: new AbortController().signal,
    observability,
    async loadPlugin() { throw new Error("not used"); },
    async unloadPlugin() { return false; },
  })) events.push(event);
  assert.equal(events.at(-1).type, "done");

  assert.equal(JSON.stringify(spans).includes("hunter2"), false, "raw secret must not reach the observability sink");
  const toolSpans = spans.filter(span => span.kind === "tool");
  assert.ok(toolSpans.length >= 2);
  assert.match(JSON.stringify(toolSpans.find(span => span.phase === "start")), /\[REDACTED\]/);
  assert.match(JSON.stringify(toolSpans.find(span => span.phase === "end")), /\[REDACTED\]/);
});

test("system-context build isolates a throwing contributor", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let built;
  try {
    const registry = new SystemContextRegistryImpl();
    registry.register(async () => { throw new Error("contributor boom"); }, "broken-plugin");
    registry.register(async () => "solid context", "good-plugin");
    built = await registry.build({ session: makeSession("ctx-session"), signal: new AbortController().signal });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(built, "solid context");
  assert.ok(warnings.some(w => w.includes("contributor boom")));
});

test("vault scrub redacts overlapping secrets fully regardless of insertion order", async () => {
  const vault = new VaultImpl();
  await vault.writeSecret("short", "pass");
  await vault.writeSecret("long", "password123");
  assert.equal(await vault.scrub("password123 and pass"), "[REDACTED] and [REDACTED]");
});

// ── L1: SSE data lines without a space ────────────────────────────────────────

function sseStream(text) {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) { controller.enqueue(encoded); controller.close(); },
  });
}

test("parseSSE accepts spec-compliant data lines without a space", async () => {
  const payloads = [];
  for await (const data of parseSSE(sseStream('data: {"a":1}\n\ndata:{"b":2}\n\ndata:[DONE]\n\n'))) {
    payloads.push(data);
  }
  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}']);
});

// ── L2: malformed apiVersion must warn, not silently pass NaN checks ─────────

test("malformed apiVersion warns instead of silently skipping the version check", async () => {
  const { PLUGIN_API_VERSION } = await import("../local-agent/matbot/packages/core/runner/src/plugin.ts");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    registerPlugin({ apiVersion: "0.x", name: "hardening-nanver", specifier: "hardening-nanver" });
    // A well-formed version still passes without the unparseable warning.
    registerPlugin({ apiVersion: PLUGIN_API_VERSION, name: "hardening-goodver", specifier: "hardening-goodver" });
    // A genuine major mismatch still throws.
    assert.throws(() => registerPlugin({ apiVersion: "9.0", name: "hardening-major", specifier: "hardening-major" }), /major/);
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(warnings.some(w => w.includes("unparseable apiVersion \"0.x\"")), warnings.join("\n"));
  assert.equal(warnings.some(w => w.includes("hardening-goodver")), false);

  const services = {
    tools: { removeByPlugin() {}, list() { return []; } },
    hooks: { removeByPlugin() {} },
    systemContext: { removeByPlugin() {} },
    unregister() {},
  };
  await unloadPlugin("hardening-nanver", services);
  await unloadPlugin("hardening-goodver", services);
});

// ── L3: tool collision resolution fails closed ────────────────────────────────

function makeToolsRegistry() {
  const map = new Map();
  return {
    map,
    register(t) { map.set(t.name, t); },
    remove(name) { map.delete(name); },
    resolve(name) { return map.get(name) ?? null; },
    list() { return [...map.values()]; },
    removeByPlugin(pluginName) { for (const [k, v] of map.entries()) if (v.pluginName === pluginName) map.delete(k); },
    watch() { return (async function* () {})(); },
  };
}

function makeMachineServices(store) {
  const tools = makeToolsRegistry();
  return {
    tools,
    createStore() { return store; },
    mounted: { consume() {} },
    hooks: { register() {}, removeByPlugin() {} },
    systemContext: { register() {}, removeByPlugin() {}, build: async () => "" },
    register: async () => {},
    unregister() {},
  };
}

function collisionTool(name) {
  return {
    name, description: "t", inputSchema: {},
    executor: { async *execute() { yield { type: "result", value: {} }; } },
  };
}

test("tool collision resolution overwrites only on explicit affirmative answers", async () => {
  const store = new MemoryStore();
  const services = makeMachineServices(store);
  const answers = [];
  const prompt = async () => answers.shift();

  const setup = (pluginName, toolName) =>
    setupPlugin({ apiVersion: "0.1", name: pluginName, specifier: pluginName, tools: [collisionTool(toolName)] }, services, prompt);

  const ownerOf = name => services.tools.resolve(name)?.pluginName ?? null;

  await setup("collide-a", "dup");
  assert.equal(ownerOf("dup"), "collide-a");

  answers.push("Keep existing");
  await setup("collide-b", "dup");
  assert.equal(ownerOf("dup"), "collide-a", "explicit keep must preserve the existing tool");

  answers.push("please overwrite it");   // unrecognized free text
  await setup("collide-c", "dup");
  assert.equal(ownerOf("dup"), "collide-a", "unrecognized answers must fail closed");

  answers.push("");                      // empty answer (default not sent)
  await setup("collide-d", "dup");
  assert.equal(ownerOf("dup"), "collide-a", "an empty answer must keep the existing tool");

  answers.push("Overwrite");
  await setup("collide-e", "dup");
  assert.equal(ownerOf("dup"), "collide-e", "an explicit Overwrite replaces the existing tool");

  answers.push("Always overwrite");
  await setup("collide-f", "dup");
  assert.equal(ownerOf("dup"), "collide-f", "Always overwrite persists and replaces");
});

// ── L4: knowledge index id dedup + read-only docs surface ────────────────────

test("knowledge index dedups by id and exposes docs as a read-only snapshot", async () => {
  const index = new LookupKnowledgeIndex();
  await index.index({ id: "same", content: "first version", source: "s" });
  await index.index({ id: "same", content: "second version", source: "s" });
  await index.index({ id: "other", content: "unrelated honey", source: "s" });

  assert.equal([...index.entries()].length, 2);
  const replaced = [...index.entries()].find(e => e.id === "same");
  assert.equal(replaced.content, "second version");
  assert.deepEqual(index.docs.map(e => e.id), ["same", "other"]);
});

// ── M9: fetchWithRetry timeout budget ─────────────────────────────────────────

async function listenForeverUnhandled() {
  const server = http.createServer(() => { /* accept the request but never respond */ });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("fetchWithRetry aborts a hung connection once timeoutMs elapses", async () => {
  const server = await listenForeverUnhandled();
  try {
    const port = server.address().port;
    const started = Date.now();
    await assert.rejects(
      () => fetchWithRetry(`http://127.0.0.1:${port}/hang`, { method: "GET" }, 3, { timeoutMs: 300 }),
      /timed out/,
    );
    assert.ok(Date.now() - started < 5000, "a hung connection must not block indefinitely");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("fetchWithRetry respects the overall timeoutMs budget across status retries", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.statusCode = 500; res.end("nope"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const started = Date.now();
    await assert.rejects(
      () => fetchWithRetry(`http://127.0.0.1:${port}/500`, { method: "GET" }, 50, { timeoutMs: 400 }),
      /timed out/,
    );
    assert.ok(Date.now() - started < 4000);
    assert.ok(hits >= 1, "the request should have reached the server at least once");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("fetchWithRetry succeeds within the budget when the first attempt responds", async () => {
  const server = http.createServer((_req, res) => { res.statusCode = 200; res.end("ok"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const res = await fetchWithRetry(`http://127.0.0.1:${port}/ok`, { method: "GET" }, 3, { timeoutMs: 2000 });
    assert.equal(res.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ── L6: type-aware sort comparison ────────────────────────────────────────────

test("applySort compares booleans numerically, numbers numerically, missing last", () => {
  const docs = [
    { id: "1", flag: true,  n: 2 },
    { id: "2", flag: false, n: 10 },
    { id: "3" },
    { id: "4", flag: false, n: 1 },
  ];
  assert.deepEqual(
    applySort(docs, [{ field: "flag", dir: "asc" }]).map(d => d.id),
    ["2", "4", "1", "3"],
    "booleans must order false < true, with missing values last",
  );
  assert.deepEqual(
    applySort(docs.filter(d => d.n !== undefined), [{ field: "n", dir: "asc" }]).map(d => d.id),
    ["4", "1", "2"],
    "numbers must compare numerically, not lexicographically",
  );
});
