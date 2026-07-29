import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import net from "node:net";

const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import(
  "../local-agent/matbot/packages/core/plugin-api/src/index.ts"
);
installPrincipalCarrier(createConstantPrincipalCarrier({ id: "frontend-loopback-test", type: "user" }));

const { createWebServer } = await import(
  "../local-agent/matbot/packages/plugins/frontend/web/src/server.ts"
);
const { WEB_LISTEN_HOST } = await import(
  "../local-agent/matbot/packages/plugins/frontend/web/src/plugin.ts"
);

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connection to ${host}:${port} timed out`));
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const store = {
  async get() { return null; },
  async set() {},
  async delete() { return false; },
  async query() { return { items: [], total: 0 }; }
};

const web = createWebServer({
  store,
  run: {},
  vault: {},
  async loadPlugin() { throw new Error("not used"); },
  async unloadPlugin() { return false; }
});

try {
  assert.equal(WEB_LISTEN_HOST, "127.0.0.1");
  await new Promise((resolve, reject) => {
    web.server.once("error", reject);
    web.server.listen(0, WEB_LISTEN_HOST, resolve);
  });
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  const localhostResponse = await fetch(`http://localhost:${address.port}/health`);
  assert.equal(localhostResponse.status, 200);

  const nonLoopback = Object.values(networkInterfaces())
    .flatMap(entries => entries ?? [])
    .find(entry => entry.family === "IPv4" && !entry.internal)?.address;
  if (nonLoopback) {
    await assert.rejects(
      connect(nonLoopback, address.port),
      /ECONNREFUSED|EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH|timed out/
    );
  }
} finally {
  await web.close();
}

console.log("frontend binds to loopback and rejects non-loopback connections");
