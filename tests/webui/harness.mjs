import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const staticRoot = path.join(root, "local-agent/matbot/packages/plugins/frontend/web/static");
const port = Number(process.env.MATBOT_WEBUI_TEST_PORT ?? 19787);

const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let sessionSeq = 1;
let traceSeq = 1;
const sessions = new Map();
const hidden = new Set();
const busy = new Map();
const sessionStreams = new Map();
const globalStreams = new Set();
const pendingPrompts = new Map();
const runningTurns = new Map();

const files = new Map([
  ["brief.md", Buffer.from("# Brief\nInitial workspace file.", "utf8")]
]);

const skills = new Map([
  ["Panel Etiquette", {
    name: "Panel Etiquette",
    content: "# Panel Etiquette\nAsk each expert for evidence and disagreement.",
    catalogue: true,
    knowledge: {
      summary: "How to run expert-panel conversations.",
      entities: ["expert_panel", "experts"],
      tags: ["panel", "orchestration"]
    }
  }]
]);

const triggers = new Map([
  ["trigger-panel", {
    id: "trigger-panel",
    tool: "skill_action",
    params: { action: "use", name: "Panel Etiquette" },
    conditions: [{ kind: "ephemeral", rule: "MATCH when the user asks for expert panel etiquette." }]
  }]
]);

const loadedPlugins = [
  {
    name: "@local-agent/expert-panel",
    specifier: "./plugins/expert-panel",
    description: "Tool-based multi-expert orchestration.",
    types: ["tools"],
    tools: [{ name: "expert_panel", description: "Run the configured panel of experts." }]
  },
  {
    name: "@matatbread/matbot-tool-workspace",
    specifier: "./packages/plugins/workspace",
    description: "Workspace file management.",
    types: ["tools"],
    tools: [{ name: "workspace_action", description: "Read, write, list, and delete workspace files." }]
  },
  {
    name: "@matatbread/matbot-skills",
    specifier: "./packages/plugins/skills",
    description: "Skills and skill editor support.",
    types: ["tools", "service:SkillManager"],
    tools: [{ name: "skill_action", description: "Manage skills." }]
  }
];

const localPlugins = [
  {
    specifier: "./packages/plugins/storage/google-drive",
    name: "@matatbread/matbot-storage-google-drive",
    description: "Google Drive storage backend.",
    matbotRuntime: ["browser"]
  },
  {
    specifier: "./packages/plugins/background",
    name: "@matatbread/matbot-tool-background",
    description: "Run prompts in detached background processes.",
    matbotRuntime: ["node"]
  }
];

const server = createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: String(error) });
    else res.end();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`matbot webui test harness -> http://127.0.0.1:${port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

async function handle(req, res) {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (method === "OPTIONS") return void res.writeHead(204).end();

  if (method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok" });
  if (method === "GET" && url.pathname === "/") return file(res, "text/html; charset=utf-8", "index.html");
  if (method === "GET" && url.pathname === "/app.js") return file(res, "application/javascript; charset=utf-8", "app.js");
  if (method === "GET" && url.pathname === "/http-transport.js") return file(res, "application/javascript; charset=utf-8", "http-transport.js");
  if (method === "GET" && url.pathname === "/favicon.ico") return file(res, "image/svg+xml", "favicon.svg");

  if (method === "GET" && url.pathname === "/events") return openGlobalStream(req, res);

  const sessionEvents = /^\/events\/sessions\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && sessionEvents) return openSessionStream(req, res, decodeURIComponent(sessionEvents[1]));

  if (method === "POST" && url.pathname === "/sessions") {
    const id = `s${sessionSeq++}`;
    sessions.set(id, {
      id,
      version: "v1",
      status: "active",
      title: `Conversation ${id}`,
      messages: [],
      contexts: [],
      createdAt: now(),
      updatedAt: now()
    });
    return json(res, 201, { id });
  }

  const sessionStatus = /^\/sessions\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && sessionStatus) return json(res, 200, { busy: busy.get(decodeURIComponent(sessionStatus[1])) === true });

  const submit = /^\/sessions\/([^/]+)\/submit$/.exec(url.pathname);
  if (method === "POST" && submit) {
    const sessionId = decodeURIComponent(submit[1]);
    const body = await readJson(req);
    const traceId = body.traceId ?? `trace-${traceSeq++}`;
    const session = sessions.get(sessionId);
    if (!session) return json(res, 404, { error: "Session not found" });
    void runTurn(sessionId, traceId, body);
    return json(res, 200, { queued: 0, traceId });
  }

  const abort = /^\/sessions\/([^/]+)\/abort$/.exec(url.pathname);
  if (method === "POST" && abort) {
    const sessionId = decodeURIComponent(abort[1]);
    const run = runningTurns.get(sessionId);
    if (run) {
      run.aborted = true;
      sendSession(sessionId, "aborted", { type: "aborted", reason: "user-abort", session: sessions.get(sessionId), traceId: run.traceId });
      runningTurns.delete(sessionId);
    }
    setBusy(sessionId, false);
    return json(res, 200, { ok: true });
  }

  const prompt = /^\/sessions\/([^/]+)\/prompt$/.exec(url.pathname);
  if (method === "POST" && prompt) {
    const sessionId = decodeURIComponent(prompt[1]);
    const body = await readJson(req);
    const pending = pendingPrompts.get(sessionId);
    if (!pending) return json(res, 409, { error: "No pending prompt for this session" });
    pendingPrompts.delete(sessionId);
    pending.resolve(body.cancel ? "(cancelled)" : body.answer ?? "");
    return json(res, 200, { ok: true });
  }

  const tool = /^\/tools\/([^/]+)$/.exec(url.pathname);
  if (method === "POST" && tool) return handleTool(res, decodeURIComponent(tool[1]), await readJson(req));

  const fileMatch = /^\/files\/workspace\/(.+)$/.exec(url.pathname);
  if (method === "GET" && fileMatch) {
    const name = decodeURIComponent(fileMatch[1]);
    const data = files.get(name);
    if (!data) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return void res.end(data);
  }

  json(res, 404, { error: "Not found" });
}

async function file(res, contentType, name) {
  const body = await readFile(path.join(staticRoot, name), "utf8");
  res.writeHead(200, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function handleTool(res, name, input) {
  if (name === "provider") {
    return json(res, 200, { providers: [{ name: "openai" }, { name: "panel-test" }] });
  }
  if (name === "session_action") {
    if (input.action === "list") {
      return json(res, 200, [...sessions.values()]
        .filter(session => !hidden.has(session.id))
        .map(session => ({
          id: session.id,
          title: session.title,
          preview: session.messages.find(message => message.role === "user")?.content?.[0]?.text ?? ""
        })));
    }
    if (input.action === "get") return json(res, 200, sessions.get(input.sessionId) ?? null);
    if (input.action === "rename") {
      const session = sessions.get(input.sessionId);
      if (session) session.title = input.title;
      return json(res, 200, { ok: true });
    }
    if (input.action === "hide") {
      hidden.add(input.sessionId);
      return json(res, 200, { ok: true });
    }
  }
  if (name === "workspace_action") {
    if (input.action === "list") {
      return json(res, 200, [...files.entries()].map(([fileName, buffer]) => ({ path: fileName, size: buffer.byteLength })));
    }
    if (input.action === "write") {
      const content = input.encoding === "base64" ? Buffer.from(input.content ?? "", "base64") : Buffer.from(input.content ?? "", "utf8");
      files.set(input.path, content);
      sendGlobal("file-changed", { namespace: "workspace", name: input.path, size: content.byteLength });
      return json(res, 200, { path: input.path, bytes: content.byteLength });
    }
    if (input.action === "delete") {
      files.delete(input.path);
      sendGlobal("file-changed", { namespace: "workspace", name: input.path, size: 0 });
      return json(res, 200, { path: input.path });
    }
  }
  if (name === "plugin") {
    if (input.action === "list") return json(res, 200, { loaded: loadedPlugins });
    if (input.action === "discover_local") return json(res, 200, localPlugins);
  }
  if (name === "skill_action") {
    if (input.action === "list") return json(res, 200, { skills: [...skills.values()].map(({ name: skillName }) => ({ name: skillName })) });
    if (input.action === "load") return json(res, 200, { content: skills.get(input.name)?.content ?? "" });
    if (input.action === "metadata") {
      const skill = skills.get(input.name);
      return json(res, 200, { catalogue: skill?.catalogue ?? false, knowledge: skill?.knowledge ?? null });
    }
    if (input.action === "save") {
      const skill = skills.get(input.name) ?? { name: input.name, content: "", catalogue: false, knowledge: null };
      skill.content = input.content ?? skill.content;
      skill.catalogue = input.catalogue === true;
      skills.set(input.name, skill);
      sendGlobal("skill-changed", { type: "saved", name: input.name });
      return json(res, 200, { ok: true });
    }
    if (input.action === "delete") {
      skills.delete(input.name);
      sendGlobal("skill-changed", { type: "deleted", name: input.name });
      return json(res, 200, { ok: true });
    }
  }
  if (name === "trigger_action") {
    if (input.action === "query") {
      return json(res, 200, { triggers: [...triggers.values()].filter(t => t.tool === input.tool && t.params?.name === input.params?.name) });
    }
    if (input.action === "add") {
      const id = `trigger-${triggers.size + 1}`;
      triggers.set(id, { id, tool: input.tool, params: input.params, conditions: input.conditions ?? [] });
      return json(res, 200, { id });
    }
    if (input.action === "update") {
      const trigger = triggers.get(input.id);
      if (trigger) trigger.conditions = input.conditions ?? [];
      return json(res, 200, { ok: true });
    }
    if (input.action === "remove") {
      triggers.delete(input.id);
      return json(res, 200, { ok: true });
    }
  }
  if (name === "session_edit") {
    return json(res, 200, { newSessionId: "forked", currentSessionId: input.sessionId });
  }
  json(res, 404, { error: `Tool "${name}" not found` });
}

async function runTurn(sessionId, traceId, body) {
  const session = sessions.get(sessionId);
  const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content);
  const userMessage = {
    id: `m-${traceId}-u`,
    traceId,
    role: "user",
    content: typeof body.content === "string" ? [{ type: "text", text: body.content }] : [body.content],
    createdAt: now()
  };
  session.messages.push(userMessage);
  setBusy(sessionId, true);
  runningTurns.set(sessionId, { traceId, aborted: false });
  sendSession(sessionId, "queued", { type: "queued", content: userMessage.content, queued: 0, concatQueue: false, traceId, rootTraceId: traceId });
  await sleep(20);

  const run = runningTurns.get(sessionId);
  if (!run || run.aborted) return;

  if (/slow/i.test(content)) {
    sendSession(sessionId, "text-delta", { type: "text-delta", delta: "Starting slow response...", traceId });
    return;
  }

  sendSession(sessionId, "thinking", { type: "thinking", delta: "Checking harness state.", traceId });
  await sleep(10);
  sendSession(sessionId, "tool:start", { type: "tool:start", callId: `call-${traceId}`, name: "expert_panel", input: { question: content }, traceId });
  await sleep(10);
  sendSession(sessionId, "tool:stdout", { type: "tool:stdout", callId: `call-${traceId}`, chunk: "consulting experts\n", traceId });
  sendSession(sessionId, "tool:end", { type: "tool:end", callId: `call-${traceId}`, result: { ok: true }, isError: false, traceId });

  if (/prompt me/i.test(content)) {
    const answer = await requestPrompt(sessionId, traceId);
    sendSession(sessionId, "text-delta", { type: "text-delta", delta: `Prompt answer received: ${answer}`, traceId });
  } else {
    sendSession(sessionId, "text-delta", { type: "text-delta", delta: `Harness response to: ${content}`, traceId });
  }
  sendSession(sessionId, "usage", { type: "usage", inputTokens: 12, outputTokens: 7, traceId });
  const assistant = {
    id: `m-${traceId}-a`,
    traceId,
    role: "assistant",
    content: [{ type: "text", text: /prompt me/i.test(content) ? "Prompt handled." : `Harness response to: ${content}` }],
    createdAt: now()
  };
  session.messages.push(assistant);
  session.updatedAt = now();
  sendSession(sessionId, "done", { type: "done", session, traceId });
  runningTurns.delete(sessionId);
  setBusy(sessionId, false);
}

function requestPrompt(sessionId, traceId) {
  sendSession(sessionId, "prompt", {
    type: "prompt",
    traceId,
    question: "Choose a test answer",
    field: {
      type: "select",
      label: "Choose a test answer",
      options: ["Alpha", "Beta"],
      default: "Alpha",
      allowOther: true
    }
  });
  return new Promise(resolve => pendingPrompts.set(sessionId, { resolve }));
}

function openGlobalStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive"
  });
  res.write(": open\n\n");
  globalStreams.add(res);
  req.on("close", () => globalStreams.delete(res));
}

function openSessionStream(req, res, sessionId) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive"
  });
  res.write(": open\n\n");
  let set = sessionStreams.get(sessionId);
  if (!set) {
    set = new Set();
    sessionStreams.set(sessionId, set);
  }
  set.add(res);
  req.on("close", () => set.delete(res));
}

function setBusy(sessionId, value) {
  busy.set(sessionId, value);
  sendGlobal("session-busy", { sessionId, busy: value });
}

function sendGlobal(event, data) {
  for (const res of globalStreams) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function sendSession(sessionId, event, data) {
  for (const res of sessionStreams.get(sessionId) ?? []) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
