/**
 * Local (stdio) MCP client resilience: a server's logging, death, or silence must cost one call,
 * never every call that follows.
 *
 * This test ensures:
 * - A server that logs heavily to stderr keeps answering; its stderr is drained, so the server is
 *   not left blocked on a full pipe with every later request timing out
 * - Cancelling a tool call rejects it at once and tells the server to stop working on it
 * - Text whose multi-byte characters straddle output chunks arrives intact
 * - A server that dies mid-call fails that call with the end of its stderr as the reason
 * - A handshake that fails does not leave the server process running
 *
 * Assumptions:
 * - The real client is driven against a scripted stdio server run with the current Node binary
 * - The scripted server writes its start-up logging synchronously, which on a pipe blocks the
 *   process once the pipe is full — the behaviour of real servers this guards against
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { createStdioClient } = await import("../local-agent/matbot/packages/plugins/mcp/src/client.ts");

const SERVER_SOURCE = `
import { writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'ok';
if (process.argv[3]) writeFileSync(process.argv[3], String(process.pid));
const cancelled = [];
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const text = (id, value) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: value }] } });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function handle(message) {
  if (message.method === 'initialize') {
    if (mode === 'refuse') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'handshake refused' } });
      return;
    }
    // A megabyte of start-up logging: more than any pipe buffer holds.
    const noise = 'x'.repeat(1023) + '\\n';
    for (let index = 0; index < 1024; index++) process.stderr.write(noise);
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'scripted', version: '0' } } });
    return;
  }
  if (message.method === 'notifications/cancelled') { cancelled.push(message.params.requestId); return; }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo text.', inputSchema: { type: 'object' } }] } });
    return;
  }
  if (message.method !== 'tools/call') return;
  const { name, arguments: args } = message.params;
  if (name === 'echo') text(message.id, args.text);
  else if (name === 'cancelled') text(message.id, JSON.stringify(cancelled));
  else if (name === 'die') process.stderr.write('fatal: out of cheese\\n', () => process.exit(1));
  // 'hang': never answered.
}
`;

const directory = await mkdtemp(path.join(os.tmpdir(), "cortex-mcp-stdio-"));
const serverPath = path.join(directory, "server.mjs");
await writeFile(serverPath, SERVER_SOURCE, "utf8");
test.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const nodeCommand = `"${process.execPath}"`;

function connect(mode = "ok", pidFile) {
  return createStdioClient(nodeCommand, [serverPath, mode, ...(pidFile ? [pidFile] : [])]);
}

function within(promise, timeoutMs, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${description}`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("a server that logs heavily to stderr keeps answering", async () => {
  const client = await within(connect(), 10_000, "the handshake of a server that logged a megabyte to stderr");
  try {
    const tools = await within(client.listTools(), 5_000, "tools/list");
    assert.deepEqual(tools.map(tool => tool.name), ["echo"]);
    const result = await within(client.callTool("echo", { text: "still here" }), 5_000, "tools/call");
    assert.equal(result.content[0].text, "still here");
  } finally {
    client.close();
  }
});

test("cancelling a tool call rejects it at once and tells the server", async () => {
  const client = await within(connect(), 10_000, "the handshake");
  try {
    const controller = new AbortController();
    const startedAt = Date.now();
    const call = client.callTool("hang", {}, controller.signal);
    setTimeout(() => controller.abort("user-abort"), 100);
    await assert.rejects(within(call, 5_000, "the cancelled call to settle"), /was cancelled/);
    assert.ok(Date.now() - startedAt < 3_000, "a cancelled call must not wait for the request timeout");

    // The connection is still usable, and the server was told which request to drop.
    const report = await within(client.callTool("cancelled", {}), 5_000, "the follow-up call");
    assert.equal(JSON.parse(report.content[0].text).length, 1);

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(client.callTool("echo", { text: "x" }, aborted.signal), /Aborted/);
  } finally {
    client.close();
  }
});

test("multi-byte text split across output chunks arrives intact", async () => {
  const client = await within(connect(), 10_000, "the handshake");
  try {
    // Three bytes per character and far more than one pipe chunk: chunk boundaries cannot all fall
    // between characters.
    const sent = "€".repeat(200_000);
    const result = await within(client.callTool("echo", { text: sent }), 10_000, "the large echo");
    assert.equal(result.content[0].text.length, sent.length);
    assert.equal(result.content[0].text === sent, true, "the echoed text was corrupted in transit");
  } finally {
    client.close();
  }
});

test("a server that dies mid-call fails the call with the end of its stderr", async () => {
  const client = await within(connect(), 10_000, "the handshake");
  try {
    await assert.rejects(
      within(client.callTool("die", {}), 5_000, "the call on a dying server to settle"),
      /exited unexpectedly: [\s\S]*fatal: out of cheese/,
    );
    await assert.rejects(client.callTool("echo", { text: "x" }), /MCP client is closed/);
  } finally {
    client.close();
  }
});

test("a failed handshake does not leave the server process running", async () => {
  const pidFile = path.join(directory, "refused.pid");
  await assert.rejects(within(connect("refuse", pidFile), 10_000, "the refused handshake"), /handshake refused/);
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  const deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  try {
    assert.equal(processExists(pid), false, "the server whose handshake failed was left running");
  } finally {
    if (processExists(pid)) process.kill(pid);
  }
});
