/**
 * Workspace-switch handoff guarantees, driven against the real web server.
 *
 * A switch replaces the process serving the browser. Two properties have to hold or the handoff turns
 * into two live runtimes fighting over one port — the old one still answering the browser with the
 * previous workspace's conversations, the new one headless:
 *
 *   1. shutdown must release the port promptly even when a browser is holding connections open;
 *   2. the answer to "which workspace is active" must identify the process that produced it, since the
 *      registry file is written before the handoff and the outgoing process reports the new id too.
 *
 * Each scenario reports one `##RESULT##` line, which the parent test turns into a named subtest.
 */
import assert from "node:assert/strict";
import { request } from "node:http";

const matbot = "../local-agent/matbot";
const { createWebServer } = await import(`${matbot}/packages/plugins/frontend/web/src/server.ts`);
const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import(`${matbot}/packages/core/plugin-api/src/index.ts`);

installPrincipalCarrier(createConstantPrincipalCarrier({ id: "workspace-switch-test", type: "user" }));

const WORKSPACE = {
  id: "alpha", name: "Alpha", configPath: "workspaces/alpha/matbot.yaml",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), active: true,
};

function emptyStore() {
  const items = new Map();
  return {
    async get(id) { return items.get(id) ?? null; },
    async set(id, value) { items.set(id, value); },
    async cas(id, expected, next) {
      const current = items.get(id) ?? null;
      if (current === null || current.version !== expected) return { ok: false, current };
      items.set(id, next);
      return { ok: true, doc: next };
    },
    async delete(id) { return items.delete(id); },
    async query() { return { items: [...items.values()], total: items.size }; },
  };
}

function bootServer(runtimeId) {
  return createWebServer({
    store: emptyStore(),
    run: { submit: () => { throw new Error("not used"); }, subscribe: () => { throw new Error("not used"); } },
    vault: { resolve: async v => v, get: async () => undefined, set: async () => {} },
    loadPlugin: async () => { throw new Error("not used"); },
    unloadPlugin: async () => false,
    ...(runtimeId !== undefined ? { runtime: { id: runtimeId, workspace: WORKSPACE.configPath } } : {}),
    workspaceManager: {
      async current() { return WORKSPACE; },
      async list() { return { active: WORKSPACE.id, workspaces: [WORKSPACE] }; },
      async create() { throw new Error("not used"); },
      async rename() { throw new Error("not used"); },
      async delete() { throw new Error("not used"); },
      async switch() { return { active: WORKSPACE.id, restarting: true }; },
    },
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

// A plain keep-alive GET, leaving the socket pooled afterwards exactly as a browser does.
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const scenarios = [
  {
    name: "the workspace listing identifies the process that answered it",
    async run() {
      const server = bootServer("runtime-one");
      const port = await listen(server.server);
      try {
        const { status, body } = await get(port, "/workspaces");
        assert.equal(status, 200);
        const parsed = JSON.parse(body);
        assert.equal(parsed.active, "alpha");
        assert.equal(parsed.runtime?.id, "runtime-one", "the client cannot detect a completed switch without this");
        assert.equal(parsed.runtime?.workspace, WORKSPACE.configPath, "runtime must report the config it loaded");
      } finally {
        await server.close();
      }
    },
  },

  {
    name: "two runtimes report different identities",
    async run() {
      const first = bootServer("runtime-one");
      const second = bootServer("runtime-two");
      const firstPort = await listen(first.server);
      const secondPort = await listen(second.server);
      try {
        const before = JSON.parse((await get(firstPort, "/workspaces")).body);
        const after = JSON.parse((await get(secondPort, "/workspaces")).body);
        assert.notEqual(before.runtime.id, after.runtime.id);
        // Both report the same active workspace — which is exactly why `active` alone cannot tell the
        // client whether the switch completed.
        assert.equal(before.active, after.active);
      } finally {
        await first.close();
        await second.close();
      }
    },
  },

  {
    name: "shutdown releases the port while a request is stuck mid-body",
    async run() {
      const server = bootServer("runtime-one");
      const port = await listen(server.server);

      // A connection that is neither idle nor finished: the headers promise a body this client never
      // sends, so the handler stays parked reading it. Node drops *idle* keep-alive sockets on close()
      // by itself, but a connection in this state holds the close open indefinitely — and a workspace
      // switch waits on that close before exiting, which is how the outgoing process kept the port.
      const stuck = request({
        host: "127.0.0.1", port, path: "/sessions", method: "POST",
        headers: { "content-type": "application/json", "content-length": "512" },
      });
      stuck.write('{"partial":');
      await new Promise(resolve => setTimeout(resolve, 100));

      const startedAt = Date.now();
      const closedWithin = await Promise.race([
        server.close().then(() => true),
        new Promise(resolve => { const t = setTimeout(() => resolve(false), 5000); t.unref(); }),
      ]);
      stuck.destroy();
      assert.equal(closedWithin, true, `close() hung on a stuck request (${Date.now() - startedAt}ms)`);

      // The point of closing promptly: the replacement can bind.
      const replacement = bootServer("runtime-two");
      await new Promise((resolve, reject) => {
        replacement.server.once("error", reject);
        replacement.server.listen(port, "127.0.0.1", resolve);
      });
      await replacement.close();
    },
  },

  {
    name: "shutdown releases the port while an event stream is open",
    async run() {
      const server = bootServer("runtime-one");
      const port = await listen(server.server);

      // An SSE subscriber never ends on its own; the server has to end it from its side.
      const stream = request({ host: "127.0.0.1", port, path: "/events", method: "GET" });
      stream.end();
      await new Promise(resolve => { stream.once("response", resolve); stream.once("error", resolve); });

      const closedWithin = await Promise.race([
        server.close().then(() => true),
        new Promise(resolve => { const t = setTimeout(() => resolve(false), 5000); t.unref(); }),
      ]);
      stream.destroy();
      assert.equal(closedWithin, true, "close() hung on an open event stream");
    },
  },
];

for (const scenario of scenarios) {
  try {
    await scenario.run();
    console.log(`##RESULT## ${JSON.stringify({ name: scenario.name, ok: true })}`);
  } catch (error) {
    process.exitCode = 1;
    console.log(`##RESULT## ${JSON.stringify({ name: scenario.name, ok: false, error: error?.message ?? String(error) })}`);
  }
}
