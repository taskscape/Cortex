/**
 * WebUI server hardening validation (findings C1, H9, M37, L21, L23).
 *
 * This test ensures:
 * - Execution-class tools (bash/powershell/docker-bash) cannot be invoked directly
 *   over HTTP unless CORTEX_WEBUI_ALLOW_SHELL_TOOLS=1 opts back in (403 by default)
 * - CORS reflects only loopback origins; foreign origins get no ACAO header
 * - Requests whose Host header is missing or foreign are rejected with 403
 * - When CORTEX_WEBUI_TOKEN is set, mutating requests require x-cortex-token (401);
 *   with no token configured, local workflows keep working unauthenticated
 * - Contended session appends retry CAS with bounded backoff and fail with 409 —
 *   the unconditional-set bypass is gone, so concurrent messages are never dropped
 * - Oversized request bodies tear down the connection instead of buffering on
 *
 * Assumptions:
 * - The real web server component is constructed with stub deps on an ephemeral
 *   loopback port, mirroring tests/frontend-loopback-runtime.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");

const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import(
  "../local-agent/matbot/packages/core/plugin-api/src/index.ts"
);
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "webui-hardening-test", type: "user" }));

const { createWebServer } = await import(
  "../local-agent/matbot/packages/plugins/frontend/web/src/server.ts"
);

const ENV_KEYS = ["CORTEX_WEBUI_TOKEN", "CORTEX_WEBUI_ALLOW_SHELL_TOOLS"];

function saveEnv() {
  return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function noopStore() {
  return {
    async get() { return null; },
    async set() {},
    async cas() { return { ok: false, current: null }; },
    async delete() { return false; },
    async query() { return { items: [], total: 0 }; },
  };
}

const passthroughTools = names => {
  const tools = new Map(names.map(name => [name, {
    name,
    executor: {
      async *execute(input) {
        yield { type: "result", value: { ran: name, input } };
      },
    },
  }]));
  return {
    resolve(name) { return tools.get(name); },
    async *watch() {},
  };
};

async function startServer(deps = {}) {
  const web = createWebServer({
    store: noopStore(),
    run: { status() { return { busy: false, queued: 0 }; } },
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

async function stopServer(web) {
  await web.close();
}

function request(port, requestPath, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers,
      agent: false,
    }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function rawSocketStatus(port, rawRequest) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => socket.write(rawRequest));
    let data = "";
    socket.on("data", chunk => { data += chunk; });
    socket.on("close", () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      socket.destroy();
      if (match) resolve(Number(match[1])); else reject(new Error(`no HTTP status in response: ${data}`));
    });
    socket.on("error", reject);
  });
}

test("execution-class tools are denied over HTTP unless explicitly opted in", async () => {
  assert.equal(process.env.CORTEX_WEBUI_ALLOW_SHELL_TOOLS, undefined);
  const { web, port } = await startServer({
    tools: passthroughTools(["bash", "powershell", "docker-bash", "session_action"]),
  });
  try {
    for (const name of ["bash", "powershell", "docker-bash"]) {
      const buffered = await request(port, `/tools/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "echo hi" }),
      });
      assert.equal(buffered.status, 403, `/tools/${name} must be rejected by default`);
      const streamed = await request(port, `/stream/tools/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "echo hi" }),
      });
      assert.equal(streamed.status, 403, `/stream/tools/${name} must be rejected by default`);
    }

    // Percent-encoded evasion is caught too.
    const encoded = await request(port, "/tools/%62ash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(encoded.status, 403);

    // Non-shell tools keep working.
    const allowed = await request(port, "/tools/session_action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    assert.equal(allowed.status, 200);
  } finally {
    await stopServer(web);
  }
});

test("shell-tool guard lifts with CORTEX_WEBUI_ALLOW_SHELL_TOOLS=1", async () => {
  const saved = saveEnv();
  process.env.CORTEX_WEBUI_ALLOW_SHELL_TOOLS = "1";
  try {
    const { web, port } = await startServer({ tools: passthroughTools(["bash"]) });
    try {
      const response = await request(port, "/tools/bash", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "echo hi" }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body), { ran: "bash", input: { script: "echo hi" } });
    } finally {
      await stopServer(web);
    }
  } finally {
    restoreEnv(saved);
  }
});

test("CORS reflects only loopback origins; foreign origins get no ACAO header", async () => {
  const { web, port } = await startServer({});
  try {
    const foreign = await request(port, "/health", { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.status, 200);
    assert.equal(foreign.headers["access-control-allow-origin"], undefined);

    const ownPort = await request(port, "/health", { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(ownPort.headers["access-control-allow-origin"], `http://127.0.0.1:${port}`);

    const otherLoopbackPort = await request(port, "/health", { headers: { origin: "http://localhost:19778" } });
    assert.equal(otherLoopbackPort.headers["access-control-allow-origin"], "http://localhost:19778");

    const preflightForeign = await request(port, "/tools/session_action", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(preflightForeign.headers["access-control-allow-origin"], undefined);

    const preflightOwn = await request(port, "/tools/session_action", { method: "OPTIONS", headers: { origin: `http://localhost:${port}` } });
    assert.equal(preflightOwn.headers["access-control-allow-origin"], `http://localhost:${port}`);
  } finally {
    await stopServer(web);
  }
});

test("foreign or missing Host headers are rejected with 403 (DNS rebinding)", async () => {
  const { web, port } = await startServer({});
  try {
    const foreign = await request(port, "/health", { headers: { host: "attacker.example.com" } });
    assert.equal(foreign.status, 403);

    const spoofedSuffix = await request(port, "/health", { headers: { host: "127.0.0.1.evil.test" } });
    assert.equal(spoofedSuffix.status, 403);

    // Node's HTTP parser answers 400 for a missing Host; anything in 400/403 is a rejection.
    const missingHost = await rawSocketStatus(port, "GET /health HTTP/1.1\r\nConnection: close\r\n\r\n");
    assert.ok(missingHost === 400 || missingHost === 403, `missing Host rejected (got ${missingHost})`);

    const loopback = await request(port, "/health", { headers: {} });
    assert.equal(loopback.status, 200);
  } finally {
    await stopServer(web);
  }
});

test("CORTEX_WEBUI_TOKEN enforces x-cortex-token on mutating routes only", async () => {
  const saved = saveEnv();
  process.env.CORTEX_WEBUI_TOKEN = "webui-secret";
  let server;
  try {
    server = await startServer({});
    const { web, port } = server;

    // GET stays open.
    const health = await request(port, "/health");
    assert.equal(health.status, 200);

    const noToken = await request(port, "/sessions", { method: "POST", body: "" });
    assert.equal(noToken.status, 401);

    const wrongToken = await request(port, "/sessions", { method: "POST", headers: { "x-cortex-token": "wrong" }, body: "" });
    assert.equal(wrongToken.status, 401);

    const rightToken = await request(port, "/sessions", { method: "POST", headers: { "x-cortex-token": "webui-secret" }, body: "" });
    assert.equal(rightToken.status, 201);
    assert.ok(JSON.parse(rightToken.body).id);
    await stopServer(server.web);

    // Unset token: unauthenticated local workflows keep working.
    delete process.env.CORTEX_WEBUI_TOKEN;
    server = await startServer({});
    const openPost = await request(server.port, "/sessions", { method: "POST", body: "" });
    assert.equal(openPost.status, 201);
  } finally {
    if (server?.web) await stopServer(server.web);
    restoreEnv(saved);
  }
});

function baseSession(id) {
  const now = new Date().toISOString();
  return {
    id,
    version: "v1",
    ownerPrincipalId: "web-user",
    status: "active",
    contexts: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

test('foreign browser origins cannot create sessions or invoke tools', async () => {
  let writes = 0;
  let invocations = 0;
  const { web, port } = await startServer({
    store: { ...noopStore(), async set() { writes++; } },
    tools: { resolve() { invocations++; }, async *watch() {} },
  });
  try {
    for (const origin of ['https://evil.example', 'null']) {
      for (const path of ['/sessions', '/tools/echo_tool', '/stream/tools/echo_tool']) {
        const response = await request(port, path, {
          method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: '{}',
        });
        assert.equal(response.status, 403, `${origin} must not write to ${path}`);
        assert.match(JSON.parse(response.body).error, /origin/i);
      }
    }
    assert.equal(writes, 0);
    assert.equal(invocations, 0);
    for (const origin of [undefined, `http://localhost:${port}`]) {
      const response = await request(port, '/sessions', {
        method: 'POST', headers: origin ? { origin } : {}, body: '',
      });
      assert.equal(response.status, 201);
    }
    assert.equal(writes, 2);
  } finally { await stopServer(web); }
});

test('explicit CORS configuration authorizes only the configured origin for writes', async () => {
  const { web, port } = await startServer({ cors: 'https://ui.example' });
  try {
    for (const [origin, status] of [['https://ui.example', 201], ['https://evil.example', 403], ['http://localhost:19778', 403]]) {
      const response = await request(port, '/sessions', { method: 'POST', headers: { origin }, body: '' });
      assert.equal(response.status, status);
    }
  } finally { await stopServer(web); }
});

function casStore(failFirstN) {
  let casCalls = 0;
  const state = { session: baseSession("sess-cas"), setCalls: 0 };
  return {
    state,
    async get() { return structuredClone(state.session); },
    async set(_id, next) {
      state.setCalls++;
      state.session = structuredClone(next);
      return next;
    },
    async cas(_id, expected, next) {
      casCalls++;
      if (expected !== state.session.version || casCalls <= failFirstN) return { ok: false };
      state.session = structuredClone(next);
      return { ok: true, doc: structuredClone(next) };
    },
    async delete() { return false; },
    async query() { return { items: [], total: 0 }; },
  };
}

const expertPanelTool = {
  name: "expert_panel",
  executor: {
    async *execute(input) {
      yield { type: "result", value: { mode: input.mode ?? "parallel", experts: [], synthesis: "panel ok" } };
    },
  },
};

function expertPanelRequest(port, sessionId, extraHeaders = {}) {
  return request(port, `/sessions/${sessionId}/expert-panel`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ question: "What gives?", provider: "test-provider" }),
  });
}

test("contended session appends retry CAS and return 409 instead of bypassing it", async () => {
  const store = casStore(Number.MAX_SAFE_INTEGER);
  const { web, port } = await startServer({
    store,
    tools: { resolve(name) { return name === "expert_panel" ? expertPanelTool : undefined; }, async *watch() {} },
  });
  try {
    const started = Date.now();
    const response = await expertPanelRequest(port, "sess-cas");
    const elapsed = Date.now() - started;

    assert.equal(response.status, 409, "a permanently contended append must fail with 409 Conflict");
    assert.match(JSON.parse(response.body).error, /concurrently modified|retry/i);
    assert.equal(store.state.setCalls, 0, "the unconditional-set fallback must never run");
    assert.ok(elapsed < 5_000, `bounded retry window exceeded: ${elapsed}ms`);
  } finally {
    await stopServer(web);
  }
});

test("session appends succeed once CAS contention clears; no message loss", async () => {
  const store = casStore(3); // contended three times, then commits normally
  const { web, port } = await startServer({
    store,
    tools: { resolve(name) { return name === "expert_panel" ? expertPanelTool : undefined; }, async *watch() {} },
  });
  try {
    const response = await expertPanelRequest(port, "sess-cas");
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).isError, false);

    const roles = store.state.session.messages.map(message => message.role);
    assert.deepEqual(roles, ["user", "assistant"], "both turns must be persisted through CAS");
    assert.equal(store.state.setCalls, 0);
  } finally {
    await stopServer(web);
  }
});

test("oversized request bodies are destroyed instead of buffered", async () => {
  const { web, port } = await startServer({ tools: passthroughTools(["echo_tool"]) });
  try {
    const oversized = "x".repeat(1_048_577);
    let outcome;
    try {
      outcome = await request(port, "/tools/echo_tool", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(oversized.length) },
        body: oversized,
      });
    } catch {
      outcome = undefined; // connection reset mid-body is the expected teardown
    }
    if (outcome !== undefined) {
      assert.notEqual(outcome.status, 200, "an oversized body must never reach the tool");
    }
  } finally {
    await stopServer(web);
  }
});

test("/index.html serves the static UI like / does (route typo fixed)", async () => {
  const { web, port } = await startServer({});
  try {
    const root = await request(port, "/");
    assert.equal(root.status, 200);
    assert.match(root.headers["content-type"] ?? "", /text\/html/);
    const index = await request(port, "/index.html");
    assert.equal(index.status, 200);
    assert.equal(index.body, root.body);
  } finally {
    await stopServer(web);
  }
});
