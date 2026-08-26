/**
 * Services hardening validation for the file-broker and file-index HTTP
 * surfaces and their shared http-utils helpers.
 *
 * This test ensures:
 * - Both services bind to the loopback interface and answer on 127.0.0.1
 * - Requests with foreign Host headers are rejected with 403 (DNS rebinding)
 * - When CORTEX_FILE_BROKER_TOKEN / CORTEX_FILE_INDEX_TOKEN are set, routes
 *   require a matching x-cortex-token header (401 otherwise); /health stays open
 * - Without tokens configured, existing unauthenticated workflows keep working
 * - Missing query parameters map to 400 instead of 500
 * - sendJsonError hides internal error details (absolute paths) behind a
 *   generic 500 message while keeping HttpError messages intact
 * - requestAbortSignal removes its listeners once a request closes normally
 * - Broker writes are atomic: no temporary files are left behind and
 *   concurrent writers never leave interleaved or partial content
 *
 * Assumptions:
 * - The services are started as child processes on ephemeral ports with
 *   temporary workspace/security configurations, mirroring the runtime tests
 * - Timing-safe token comparison makes header matching side-channel resistant
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HttpError, requestAbortSignal, sendJsonError } from "../local-agent/http-utils/dist/index.js";
import { writeTextFile } from "../local-agent/file-broker/dist/file-writer.js";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startService(entry, env) {
  return spawn(process.execPath, [
    "--import",
    "./local-agent/matbot/apps/cli/register.js",
    entry,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function stopService(child) {
  if (child && !child.killed) child.kill();
}

function requestRaw(port, requestPath, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers,
    }, response => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: data }));
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function writeServiceConfigs(temp) {
  const allowed = path.join(temp, "allowed");
  await mkdir(allowed, { recursive: true });
  const workspacesPath = path.join(temp, "workspaces.json");
  const policyPath = path.join(temp, "policy.json");
  await writeFile(workspacesPath, JSON.stringify({
    roots: [{ path: allowed, mode: "read-write", type: "test" }],
  }), "utf8");
  await writeFile(policyPath, JSON.stringify({
    deniedPathFragments: [],
    highRiskExtensions: [".ps1"],
    maxReadBytes: 100_000,
    backupRoot: path.join(temp, "backups"),
  }), "utf8");
  return { allowed, workspacesPath, policyPath };
}

async function waitForHealth(port, childState) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await requestRaw(port, "/health");
      if (response.status === 200) return;
      // A 403 from Host validation means the server is up but misconfigured.
      if (response.status === 403) throw new Error(`service rejected loopback health check\n${childState.stderr}`);
    } catch {
      // Not listening yet; retry until the deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`service did not become healthy\n${childState.stderr}`);
}

test("hardened services bind loopback, enforce Host checks, tokens, and 400 mapping", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cortex-services-hardening-"));
  const { allowed, workspacesPath, policyPath } = await writeServiceConfigs(temp);
  const port = await freePort();
  const childState = { stderr: "" };
  const child = startService("local-agent/file-broker/src/server.ts", {
    FILE_BROKER_PORT: String(port),
    WORKSPACES_CONFIG: workspacesPath,
    SECURITY_POLICY_CONFIG: policyPath,
  });
  child.stderr.on("data", chunk => { childState.stderr += chunk; });

  try {
    await waitForHealth(port, childState);

    // C2: reachable over the loopback interface.
    const health = await requestRaw(port, "/health");
    assert.equal(health.status, 200);

    // C2: foreign Host headers are rejected (DNS-rebinding defense).
    const foreignHost = await requestRaw(port, "/health", { headers: { host: "attacker.example.com" } });
    assert.equal(foreignHost.status, 403);
    const foreignHostPort = await requestRaw(port, "/list", { headers: { host: "localhost.example.com:8878" }, body: undefined });
    assert.equal(foreignHostPort.status, 403);
    const spoofedLoopbackSuffix = await requestRaw(port, "/list", {
      headers: { host: "127.0.0.1.evil.test" },
    });
    assert.equal(spoofedLoopbackSuffix.status, 403);
    const missingHost = await rawSocketRequest(port, "GET /health HTTP/1.1\r\nConnection: close\r\n\r\n");
    assert.ok(missingHost === 400 || missingHost === 403, `requests without a Host header are rejected (got ${missingHost})`);

    // No token configured: unauthenticated local workflows still work.
    const listOk = await requestRaw(port, `/list?path=${encodeURIComponent(allowed)}`);
    assert.equal(listOk.status, 200);

    // M26: missing query parameter maps to 400, not 500.
    const missingParam = await requestRaw(port, "/list");
    assert.equal(missingParam.status, 400);
    assert.match(JSON.parse(missingParam.body).error, /Missing query parameter: path/);
  } finally {
    await stopService(child);
    await rm(temp, { recursive: true, force: true });
  }
});

test("file-broker enforces the shared-secret token when configured", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cortex-broker-token-"));
  const { allowed, workspacesPath, policyPath } = await writeServiceConfigs(temp);
  const port = await freePort();
  const childState = { stderr: "" };
  const child = startService("local-agent/file-broker/src/server.ts", {
    FILE_BROKER_PORT: String(port),
    WORKSPACES_CONFIG: workspacesPath,
    SECURITY_POLICY_CONFIG: policyPath,
    CORTEX_FILE_BROKER_TOKEN: "broker-secret",
  });
  child.stderr.on("data", chunk => { childState.stderr += chunk; });

  try {
    await waitForHealth(port, childState);

    // Health remains reachable without the token.
    const health = await requestRaw(port, "/health");
    assert.equal(health.status, 200);

    const noToken = await requestRaw(port, `/list?path=${encodeURIComponent(allowed)}`);
    assert.equal(noToken.status, 401);
    const wrongToken = await requestRaw(port, `/list?path=${encodeURIComponent(allowed)}`, {
      headers: { "x-cortex-token": "wrong" },
    });
    assert.equal(wrongToken.status, 401);
    const rightToken = await requestRaw(port, `/list?path=${encodeURIComponent(allowed)}`, {
      headers: { "x-cortex-token": "broker-secret" },
    });
    assert.equal(rightToken.status, 200);
  } finally {
    await stopService(child);
    await rm(temp, { recursive: true, force: true });
  }
});

test("file-index binds loopback, rejects foreign hosts, and enforces its token", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cortex-file-index-hardening-"));
  const { workspacesPath, policyPath } = await writeServiceConfigs(temp);
  const storePath = path.join(temp, "index.json");
  const port = await freePort();
  const childState = { stderr: "" };
  const child = startService("local-agent/file-index/src/server.ts", {
    FILE_INDEX_PORT: String(port),
    FILE_INDEX_STORE: storePath,
    WORKSPACES_CONFIG: workspacesPath,
    SECURITY_POLICY_CONFIG: policyPath,
    CORTEX_FILE_INDEX_TOKEN: "index-secret",
  });
  child.stderr.on("data", chunk => { childState.stderr += chunk; });

  try {
    await waitForHealth(port, childState);

    // Loopback binding works and /health is exempt from the token.
    const health = await requestRaw(port, "/health");
    assert.equal(health.status, 200);

    const foreignHost = await requestRaw(port, "/search", {
      method: "POST",
      headers: { host: "rebind.attacker.test", "content-type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    assert.equal(foreignHost.status, 403);

    const noToken = await requestRaw(port, "/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "anything" }),
    });
    assert.equal(noToken.status, 401);

    const rightToken = await requestRaw(port, "/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cortex-token": "index-secret" },
      body: JSON.stringify({ query: "anything" }),
    });
    assert.equal(rightToken.status, 200);
    assert.deepEqual(JSON.parse(rightToken.body), { ok: true, results: [] });
  } finally {
    await stopService(child);
    await rm(temp, { recursive: true, force: true });
  }
});

test("broker writes are atomic: no temp residue and never partial content", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cortex-broker-atomic-"));
  const target = path.join(temp, "target.txt");

  try {
    await writeFile(target, "before\n", "utf8");
    const first = await writeTextFile(target, "after\n", path.join(temp, "backups"));
    assert.equal(await readFile(target, "utf8"), "after\n");
    assert.ok(first.backupPath);
    assert.deepEqual(await listTempFiles(temp), [], "no temp files survive a successful write");

    // Serialized concurrent writers must leave exactly one full document.
    const contents = ["writer-one ".repeat(50) + "\n", "writer-two ".repeat(80) + "\n"];
    await Promise.all(contents.map(content => writeTextFile(target, content, path.join(temp, "backups"))));
    const finalContent = await readFile(target, "utf8");
    assert.ok(contents.includes(finalContent), "final content must be exactly one writer's payload");
    assert.deepEqual(await listTempFiles(temp), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("sendJsonError logs internal errors server-side and returns a generic 500 message", () => {
  const captured = [];
  const originalError = console.error;
  console.error = (...args) => captured.push(args.map(String).join(" "));
  try {
    const internalResponse = captureResponse();
    sendJsonError(internalResponse, new Error(`ENOENT: no such file C:\\secret\\absolute\\path.txt`));
    assert.equal(internalResponse.captured.status, 500);
    assert.equal(internalResponse.captured.body.error, "Internal server error.");
    assert.equal(internalResponse.captured.body.error.includes("C:\\secret"), false);
    assert.equal(captured.length, 1, "internal detail is logged server-side");
    assert.match(captured[0], /C:\\secret\\absolute\\path\.txt/);

    const httpErrorResponse = captureResponse();
    sendJsonError(httpErrorResponse, new HttpError(400, "Missing query parameter: path"));
    assert.equal(httpErrorResponse.captured.status, 400);
    assert.equal(httpErrorResponse.captured.body.error, "Missing query parameter: path");
  } finally {
    console.error = originalError;
  }
});

test("requestAbortSignal removes its listeners when the request closes normally or aborts", () => {
  const completed = new EventEmitter();
  completed.aborted = false;
  completed.complete = false;
  const completedSignal = requestAbortSignal(completed);
  assert.equal(completed.listenerCount("aborted"), 1);
  assert.equal(completed.listenerCount("close"), 1);
  completed.complete = true;
  completed.emit("close");
  assert.equal(completedSignal.aborted, false, "normal completion must not abort the signal");
  assert.equal(completed.listenerCount("aborted"), 0, "listeners are released on normal completion");
  assert.equal(completed.listenerCount("close"), 0);

  const aborted = new EventEmitter();
  aborted.aborted = false;
  aborted.complete = false;
  const abortedSignal = requestAbortSignal(aborted);
  aborted.emit("aborted");
  assert.equal(abortedSignal.aborted, true);
  assert.equal(aborted.listenerCount("aborted"), 0);
  assert.equal(aborted.listenerCount("close"), 0);

  const preAborted = new EventEmitter();
  preAborted.aborted = true;
  const preAbortedSignal = requestAbortSignal(preAborted);
  assert.equal(preAbortedSignal.aborted, true);
  assert.equal(preAborted.listenerCount("aborted"), 0);
  assert.equal(preAborted.listenerCount("close"), 0);
});

function captureResponse() {
  const captured = { status: 0, body: null };
  return {
    captured,
    writeHead(status) {
      captured.status = status;
    },
    end(body) {
      captured.body = JSON.parse(body);
    },
  };
}

async function listTempFiles(dir) {
  return (await readdir(dir)).filter(name => name.endsWith(".tmp"));
}

function rawSocketRequest(port, rawRequest) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(rawRequest);
    });
    let data = "";
    socket.on("data", chunk => { data += chunk; });
    socket.on("close", () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (match) resolve(Number(match[1])); else reject(new Error(`no HTTP status in response: ${data}`));
    });
    socket.on("error", reject);
  });
}
