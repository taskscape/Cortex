import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

const {
  createConstantPrincipalCarrier,
  installPrincipalCarrier,
} = await import("../local-agent/matbot/packages/core/plugin-api/src/index.ts");
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "runtime-reliability", type: "user" }));

process.on("unhandledRejection", error => {
  throw error;
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(() => resolve()));
}

async function localMcpSpawnFailureRejects() {
  const { StdioMCPClient } = await import("../local-agent/matbot/packages/plugins/mcp/src/client.ts");
  const client = new StdioMCPClient(`cortex-command-does-not-exist-${randomUUID()}`, []);
  await assert.rejects(client.initialize(), error => {
    assert.match(String(error), /ENOENT|failed|spawn/i);
    return true;
  });
}

async function fileWatchCreatesItsDirectoryAndDetachedFailuresAreContained() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-file-watch-"));
  const filesDir = path.join(root, "not-created-yet", "files");
  const { FilesystemFileStore } = await import("../local-agent/matbot/packages/plugins/files/src/store.ts");
  const store = new FilesystemFileStore(filesDir);
  const ac = new AbortController();
  const iterator = store.watch(ac.signal)[Symbol.asyncIterator]();
  const next = iterator.next();
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fs.stat(filesDir).then(item => item.isDirectory()).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await fs.stat(filesDir)).isDirectory(), true);
    ac.abort();
    assert.equal((await next).done, true);

    const { createWebServer } = await import("../local-agent/matbot/packages/plugins/frontend/web/src/server.ts");
    const web = createWebServer({
      store: { async get() { return null; }, async set() {}, async cas() { return { ok: false, current: null }; } },
      run: { status() { return { busy: false, queued: 0 }; } },
      vault: {},
      async loadPlugin() { throw new Error("not used"); },
      async unloadPlugin() { return false; },
      files: {
        async *watch() { throw new Error("synthetic watch failure"); },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    await web.close();
  } finally {
    ac.abort();
    await iterator.return?.();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function remoteMcpRequestsAreBoundedAndSseReturnsBeforeClose() {
  const { HttpMCPClient } = await import("../local-agent/matbot/packages/plugins/mcp-http/src/client.ts");

  const stalled = createServer((_req, _res) => {});
  const stalledPort = await listen(stalled);
  try {
    const client = new HttpMCPClient(`http://127.0.0.1:${stalledPort}/mcp`, undefined, 50);
    const started = Date.now();
    await assert.rejects(client.listTools(), /timed out after 50ms/);
    assert.ok(Date.now() - started < 1_000, "a stalled MCP request must fail promptly");
  } finally {
    await closeServer(stalled);
  }

  const openResponses = new Set();
  const streaming = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    openResponses.add(res);
    res.on("close", () => openResponses.delete(res));
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } })}\n\n`);
    // Deliberately leave the SSE connection open. A buffered resp.text() implementation hangs here.
  });
  const streamingPort = await listen(streaming);
  try {
    const client = new HttpMCPClient(`http://127.0.0.1:${streamingPort}/mcp`, undefined, 1_000);
    assert.deepEqual(await client.listTools(), []);
  } finally {
    for (const response of openResponses) response.end();
    await closeServer(streaming);
  }
}

async function memoryBrowserCloseIsBounded() {
  const { closeMemoryBrowserServer, createMemoryBrowserServer } = await import(
    "../local-agent/matbot/packages/plugins/memory-browser/src/index.ts"
  );
  const store = {
    async get() { return null; }, async set() {}, async delete() { return false; },
    async cas() { return { ok: false, current: null }; }, async query() { return { items: [], total: 0 }; },
  };
  const server = createMemoryBrowserServer(store, { id: "runtime-reliability", type: "user" });
  const port = await listen(server);
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    "POST /api/memories HTTP/1.1\r\n" +
    "Host: localhost\r\n" +
    "Content-Type: application/json\r\n" +
    "Content-Length: 1000\r\n\r\n{",
  );

  const started = Date.now();
  await closeMemoryBrowserServer(server, 25);
  assert.ok(Date.now() - started < 1_000, "memory-browser teardown must force-close a stalled request");
  socket.destroy();
}

async function fileIndexSkipsFilesThatDisappearMidScan() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-index-race-"));
  const readable = path.join(root, "a-readable.md");
  const vanishing = path.join(root, "z-vanishing.md");
  await fs.writeFile(readable, "# Reachable\nreliability evidence", "utf8");
  await fs.writeFile(vanishing, "# Vanishing", "utf8");

  const originalStat = fs.stat;
  fs.stat = async function patchedStat(filePath, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(vanishing)) await fs.rm(vanishing, { force: true });
    return originalStat.call(this, filePath, ...args);
  };
  try {
    const { indexRoot } = await import("../local-agent/file-index/src/indexer.ts");
    const store = await indexRoot({
      root,
      indexExcludedPatterns: [],
      maxFileBytes: 100_000,
      workspaces: { roots: [{ path: root, mode: "read-write", type: "test" }] },
      policy: { deniedPathFragments: [], highRiskExtensions: [], maxReadBytes: 100_000, backupRoot: "backups" },
    }, { version: 1, updatedAt: new Date(0).toISOString(), chunks: [], skipped: [] });

    assert.ok(store.chunks.some(chunk => chunk.relativePath === "a-readable.md"));
    assert.ok(store.skipped.some(item => item.path === vanishing && item.reason === "unreadable-file: ENOENT"));
  } finally {
    fs.stat = originalStat;
    await fs.rm(root, { recursive: true, force: true });
  }
}

await localMcpSpawnFailureRejects();
await fileWatchCreatesItsDirectoryAndDetachedFailuresAreContained();
await remoteMcpRequestsAreBoundedAndSseReturnsBeforeClose();
await memoryBrowserCloseIsBounded();
await fileIndexSkipsFilesThatDisappearMidScan();

console.log("runtime reliability boundaries reject, recover, and shut down without crashing or hanging");
