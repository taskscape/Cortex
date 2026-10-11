/**
 * WebUI server resilience: failure and slow-consumer paths that must degrade one request or one
 * connection, never the process or the turn.
 *
 * This test ensures:
 * - A static UI file that cannot be read answers the request (404 for a missing file, 500 for any
 *   other failure) instead of leaving it unanswered behind an unhandled rejection
 * - A prompt raised while no viewer is attached is delivered to the viewer that attaches later, so
 *   the turn does not stay parked on a question nobody was shown
 * - An event-stream client that stops reading is disconnected once its backlog passes the cap,
 *   while a client that keeps reading receives every event
 * - A file download is paced by the client and stops reading the file when the client goes away
 * - Prompts raised at the same time by one turn's parallel tool calls are each shown and answered,
 *   and Stop or "give up" settles every one of them, so none is left waiting on a lost answer
 * - A turn that is still producing events while the server shuts down writes nothing to the ended
 *   event stream, which would otherwise be an uncaught exception
 * - A direct tool call, buffered or streamed, is cancelled when its client disconnects
 *
 * Assumptions:
 * - The real web server component is constructed with stub deps on an ephemeral loopback port
 * - `fs.promises.readFile` is wrapped before the server module loads; the module captures the
 *   function at import time, which is what lets one test simulate an unreadable static file
 */
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import test from "node:test";

const realReadFile = fsPromises.readFile;
let staticReadFailure;
fsPromises.readFile = async (target, ...rest) => {
  if (staticReadFailure !== undefined && String(target).includes("/static/")) {
    throw Object.assign(new Error(`${staticReadFailure}: simulated static read failure`), { code: staticReadFailure });
  }
  return realReadFile(target, ...rest);
};

await import("../local-agent/matbot/apps/cli/register.js");

const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import(
  "../local-agent/matbot/packages/core/plugin-api/src/index.ts"
);
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "webui-resilience-test", type: "user" }));

const { createWebServer } = await import(
  "../local-agent/matbot/packages/plugins/frontend/web/src/server.ts"
);

const unhandledRejections = [];
process.on("unhandledRejection", reason => { unhandledRejections.push(reason); });
const uncaughtExceptions = [];
process.on("uncaughtException", error => { uncaughtExceptions.push(error); });

function baseSession(id) {
  const now = new Date().toISOString();
  return { id, version: "v1", ownerPrincipalId: "web-user", status: "active", contexts: [], messages: [], createdAt: now, updatedAt: now };
}

async function startServer(deps = {}) {
  const web = createWebServer({
    store: {
      async get(id) { return baseSession(id); },
      async set() {},
      async cas() { return { ok: false, current: null }; },
      async delete() { return false; },
      async query() { return { items: [], total: 0 }; },
    },
    run: { status() { return { busy: false, running: false, queued: 0 }; } },
    vault: {},
    loadPlugin: async () => { throw new Error("not used"); },
    unloadPlugin: async () => false,
    ...deps,
  });
  await new Promise((resolve, reject) => {
    web.server.once("error", reject);
    web.server.listen(0, "127.0.0.1", resolve);
  });
  return { web, port: web.server.address().port };
}

function request(port, requestPath, { method = "GET", headers = {}, body, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, method, headers, agent: false }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response to ${method} ${requestPath} within ${timeoutMs}ms`)));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function waitFor(predicate, description, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error(`timed out waiting for ${description}`)); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

/** Opens an SSE stream and accumulates its text; `close()` drops the connection. */
function openEventStream(port, requestPath) {
  const stream = { text: "", closed: false, close() {} };
  const opened = new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, agent: false }, res => {
      res.setEncoding("utf8");
      res.on("data", chunk => { stream.text += chunk; });
      res.on("close", () => { stream.closed = true; });
      resolve(stream);
    });
    req.on("error", error => { stream.closed = true; reject(error); });
    stream.close = () => req.destroy();
    req.end();
  });
  return opened;
}

test("an unreadable static UI file answers the request instead of crashing the process", async () => {
  const { web, port } = await startServer();
  try {
    assert.equal((await request(port, "/app.js")).status, 200);

    staticReadFailure = "ENOENT";
    const missing = await request(port, "/app.js");
    assert.equal(missing.status, 404);

    staticReadFailure = "EIO";
    const failed = await request(port, "/app.js");
    assert.equal(failed.status, 500);

    staticReadFailure = undefined;
    assert.equal((await request(port, "/health")).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
  } finally {
    staticReadFailure = undefined;
    await web.close();
  }
});

test("a prompt raised with no viewer attached reaches the viewer that attaches later", async () => {
  let submittedPrompt;
  const run = {
    status() { return { busy: true, running: true, queued: 0 }; },
    abort() {},
    cancelTurn() {},
    async open(opts) {
      if ("content" in opts) submittedPrompt = opts.prompt;
      return {
        session: baseSession(opts.sessionId),
        queued: 0,
        traceId: "trace-prompt",
        // A turn that is running but currently silent: nothing to replay, open until aborted.
        events: {
          async *[Symbol.asyncIterator]() {
            if (!opts.signal.aborted) await new Promise(resolve => opts.signal.addEventListener("abort", resolve, { once: true }));
          },
        },
      };
    },
  };
  const { web, port } = await startServer({ run });
  let viewer;
  try {
    const submitted = await request(port, "/sessions/session-prompt/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "delete the build output", provider: "test" }),
    });
    assert.equal(submitted.status, 200);
    assert.equal(typeof submittedPrompt, "function");

    // The tool asks while nobody is watching the session.
    let answer;
    const answered = submittedPrompt({ name: "permission", label: "Allow delete?", type: "select", options: ["allow", "deny"] })
      .then(value => { answer = value; });

    viewer = await openEventStream(port, "/events/sessions/session-prompt");
    await waitFor(() => viewer.text.includes("event: prompt"), "the parked prompt to reach the late viewer", 3_000);
    assert.match(viewer.text, /"question":"Allow delete\?"/);
    assert.equal(answer, undefined);

    const reply = await request(port, "/sessions/session-prompt/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "allow" }),
    });
    assert.equal(reply.status, 200);
    await answered;
    assert.equal(answer, "allow");

    // Answered prompts are not replayed to the next viewer.
    viewer.close();
    await waitFor(() => viewer.closed, "the first viewer to disconnect");
    viewer = await openEventStream(port, "/events/sessions/session-prompt");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(viewer.text.includes("event: prompt"), false);
  } finally {
    viewer?.close();
    await web.close();
  }
});

test("an event-stream client that stops reading is disconnected; a reading client is not", async () => {
  const pending = [];
  let wake;
  const emit = event => { pending.push(event); wake?.(); };
  const tools = {
    resolve() { return undefined; },
    async *watch(signal) {
      for (;;) {
        while (pending.length > 0) yield pending.shift();
        if (signal.aborted) return;
        await new Promise(resolve => {
          wake = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
      }
    },
  };
  const { web, port } = await startServer({ tools });
  // A paused socket never observes the server hanging up, so the disconnect is asserted from the
  // server's side: its open-connection count.
  let connections = 0;
  const countConnections = () => { web.server.getConnections((_error, count) => { connections = count; }); return connections; };
  const stalled = net.connect({ host: "127.0.0.1", port });
  let reader;
  try {
    stalled.on("error", () => {});
    await new Promise(resolve => stalled.once("connect", resolve));
    stalled.write("GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    stalled.pause();

    reader = await openEventStream(port, "/events");
    await waitFor(() => reader.text.includes("event stream open"), "the reading client to attach");
    await waitFor(() => countConnections() === 2, "both clients to be connected");

    // ~64 MiB of events: far past both the loopback socket buffers and the server-side cap.
    const payload = "x".repeat(1024 * 1024);
    const total = 64;
    for (let index = 0; index < total; index++) {
      emit({ type: "registered", name: `tool-${index}`, payload });
      await new Promise(resolve => setImmediate(resolve));
    }

    await waitFor(() => countConnections() === 1, "the stalled client to be disconnected");
    await waitFor(() => reader.text.includes(`"name":"tool-${total - 1}"`), "the reading client to receive every event");
    assert.equal(reader.closed, false);
  } finally {
    stalled.destroy();
    reader?.close();
    await web.close();
  }
});

test("a file download is paced by the client and stops when the client goes away", async () => {
  const chunk = new Uint8Array(64 * 1024);
  const totalChunks = 4_000;
  let pulled = 0;
  let finished = false;
  const files = {
    async getByName() {
      return {
        allowed: true,
        mimeType: "application/octet-stream",
        async *stream() {
          try {
            for (let index = 0; index < totalChunks; index++) {
              pulled++;
              yield chunk;
            }
          } finally {
            finished = true;
          }
        },
      };
    },
  };
  const { web, port } = await startServer({ files });
  const client = net.connect({ host: "127.0.0.1", port });
  try {
    await new Promise(resolve => client.once("connect", resolve));
    client.pause();
    client.write("GET /files/workspace/big.bin HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");

    // The client reads nothing, so the server may only get as far as the socket buffers allow.
    await waitFor(() => pulled > 0, "the download to start");
    await new Promise(resolve => setTimeout(resolve, 300));
    const pulledWhileStalled = pulled;
    assert.ok(pulledWhileStalled < totalChunks / 4, `read ${pulledWhileStalled} of ${totalChunks} chunks for a client that read nothing`);
    assert.equal(finished, false);

    client.destroy();
    await waitFor(() => finished, "the file stream to be released after the client left");
    assert.ok(pulled < totalChunks, "the rest of the file must not be read for a departed client");
  } finally {
    client.destroy();
    await web.close();
  }
});

/** A runner stub whose submit captures the prompt function and whose event streams stay silent. */
function promptCapturingRun(calls = {}) {
  const run = {
    prompt: undefined,
    status() { return { busy: true, running: true, queued: 0 }; },
    abort(sessionId) { (calls.abort ??= []).push(sessionId); },
    cancelTurn(sessionId) { (calls.cancelTurn ??= []).push(sessionId); },
    async open(opts) {
      if ("content" in opts) run.prompt = opts.prompt;
      return {
        session: baseSession(opts.sessionId),
        queued: 0,
        traceId: "trace-prompt",
        events: {
          async *[Symbol.asyncIterator]() {
            if (!opts.signal.aborted) await new Promise(resolve => opts.signal.addEventListener("abort", resolve, { once: true }));
          },
        },
      };
    },
  };
  return run;
}

function postJson(port, requestPath, payload) {
  return request(port, requestPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

test("prompts raised at the same time are each shown and answered in turn", async () => {
  const run = promptCapturingRun();
  const { web, port } = await startServer({ run });
  let viewer;
  try {
    viewer = await openEventStream(port, "/events/sessions/session-two-prompts");
    await waitFor(() => viewer.text.includes("events stream open"), "the viewer to attach");
    assert.equal((await postJson(port, "/sessions/session-two-prompts/submit", { content: "go", provider: "test" })).status, 200);

    // Two tool calls of one parallel batch ask at once: an ask_user and a permission gate.
    const answers = {};
    const first = run.prompt({ name: "colour", label: "Which colour?", type: "text" }).then(value => { answers.first = value; });
    const second = run.prompt({ name: "permission", label: "Allow powershell?", type: "select", options: ["allow", "deny"] })
      .then(value => { answers.second = value; });

    await waitFor(() => viewer.text.includes("Which colour?"), "the first prompt to be shown");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(viewer.text.includes("Allow powershell?"), false, "the second prompt waits for the first");

    assert.equal((await postJson(port, "/sessions/session-two-prompts/prompt", { answer: "green" })).status, 200);
    await first;
    assert.equal(answers.first, "green");
    assert.equal(answers.second, undefined);

    await waitFor(() => viewer.text.includes("Allow powershell?"), "the second prompt to be shown once the first is answered");
    assert.equal((await postJson(port, "/sessions/session-two-prompts/prompt", { answer: "allow" })).status, 200);
    await second;
    assert.equal(answers.second, "allow");

    assert.equal((await postJson(port, "/sessions/session-two-prompts/prompt", { answer: "late" })).status, 409);
    assert.equal(countOf(viewer.text, "event: prompt"), 2);
  } finally {
    viewer?.close();
    await web.close();
  }
});

test("Stop and give-up settle every parked prompt, not only the one on screen", async () => {
  const calls = {};
  const run = promptCapturingRun(calls);
  const { web, port } = await startServer({ run });
  let viewer;
  try {
    viewer = await openEventStream(port, "/events/sessions/session-settle");
    await waitFor(() => viewer.text.includes("events stream open"), "the viewer to attach");
    assert.equal((await postJson(port, "/sessions/session-settle/submit", { content: "go", provider: "test" })).status, 200);

    // Stop: both prompts are released with their defaults.
    const stopped = Promise.all([
      run.prompt({ name: "a", label: "First?", type: "text", default: "one" }),
      run.prompt({ name: "b", label: "Second?", type: "text", default: "two" }),
    ]);
    await waitFor(() => viewer.text.includes("First?"), "the first prompt to be shown");
    assert.equal((await postJson(port, "/sessions/session-settle/abort", {})).status, 200);
    assert.deepEqual(await stopped, ["one", "two"]);
    assert.deepEqual(calls.abort, ["session-settle"]);

    // Give up: both prompts are rejected as cancelled, and the queued one is never shown.
    const outcomes = Promise.allSettled([
      run.prompt({ name: "c", label: "Third?", type: "text" }),
      run.prompt({ name: "d", label: "Fourth?", type: "text" }),
    ]);
    await waitFor(() => viewer.text.includes("Third?"), "the third prompt to be shown");
    assert.equal((await postJson(port, "/sessions/session-settle/prompt", { cancel: true })).status, 200);
    const settled = await outcomes;
    assert.deepEqual(settled.map(outcome => outcome.status), ["rejected", "rejected"]);
    assert.deepEqual(settled.map(outcome => outcome.reason?.name), ["PromptCancelledError", "PromptCancelledError"]);
    assert.deepEqual(calls.cancelTurn, ["session-settle"]);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(viewer.text.includes("Second?"), false);
    assert.equal(viewer.text.includes("Fourth?"), false);
  } finally {
    viewer?.close();
    await web.close();
  }
});

test("a turn still producing events during shutdown does not write to the ended stream", async () => {
  const pending = [];
  let wake;
  const push = event => { pending.push(event); wake?.(); };
  const run = {
    status() { return { busy: true, running: true, queued: 0 }; },
    abort() {},
    cancelTurn() {},
    async open(opts) {
      return {
        session: baseSession(opts.sessionId),
        queued: 0,
        events: {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              while (pending.length > 0) yield pending.shift();
              if (opts.signal.aborted) return;
              await new Promise(resolve => {
                wake = resolve;
                opts.signal.addEventListener("abort", resolve, { once: true });
              });
            }
          },
        },
      };
    },
  };
  const { web, port } = await startServer({ run });
  // A keep-alive client, like a browser: the connection outlives the response the server ends.
  const client = net.connect({ host: "127.0.0.1", port });
  let received = "";
  let closing;
  try {
    client.setEncoding("utf8");
    client.on("data", chunk => { received += chunk; });
    client.on("error", () => {});
    await new Promise(resolve => client.once("connect", resolve));
    client.write("GET /events/sessions/session-shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await waitFor(() => received.includes("events stream open"), "the viewer to attach");

    push({ type: "text-delta", delta: "before", traceId: "t" });
    await waitFor(() => received.includes("before"), "a live event to arrive");

    closing = web.close();
    // The turn keeps going while the server waits out its connections.
    push({ type: "text-delta", delta: "after", traceId: "t" });
    await new Promise(resolve => setTimeout(resolve, 50));
    push({ type: "text-delta", delta: "later", traceId: "t" });
    await closing;
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.deepEqual(uncaughtExceptions.map(error => error.code ?? error.message), []);
    assert.equal(received.includes("after"), false);
  } finally {
    client.destroy();
    await (closing ?? web.close());
  }
});

for (const route of ["/tools/slow", "/stream/tools/slow"]) {
  test(`a direct tool call on ${route} is cancelled when its client disconnects`, async () => {
    let started = false;
    let cancelled = false;
    const slow = { name: "slow", description: "waits until cancelled", inputSchema: { type: "object" }, executor: {} };
    const tools = {
      resolve(name) { return name === "slow" ? slow : undefined; },
      async *watch(signal) {
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      },
    };
    async function* invokeTool(_tool, _input, ctx) {
      started = true;
      if (!ctx.signal.aborted) await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
      cancelled = true;
      yield { type: "error", message: "cancelled" };
    }
    const { web, port } = await startServer({ tools, invokeTool });
    const client = net.connect({ host: "127.0.0.1", port });
    try {
      client.on("error", () => {});
      await new Promise(resolve => client.once("connect", resolve));
      const body = JSON.stringify({});
      client.write(`POST ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
      await waitFor(() => started, "the tool to start");
      // The request body was read long ago; only the connection going away can signal this.
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(cancelled, false, "the tool must keep running while its client is connected");

      client.destroy();
      await waitFor(() => cancelled, "the tool to be cancelled after the client left", 3_000);
    } finally {
      client.destroy();
      await web.close();
    }
  });
}
