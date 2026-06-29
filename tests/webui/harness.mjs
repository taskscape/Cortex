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
let workspaceSeq = 1;
let rememberedFactSeq = 1;
const rememberedFacts = new Map();

const files = new Map([
  ["brief.md", Buffer.from("# Brief\nInitial workspace file.", "utf8")]
]);

const workspaces = [
  {
    id: "default",
    name: "Default",
    configPath: "matbot.yaml",
    createdAt: now(),
    updatedAt: now(),
    active: true
  }
];
let workspaceRagConfig = {
  activeContextId: "default",
  contexts: [
    { id: "default", name: "Default", paths: ["C:\\Projects\\Cortex\\docs"] }
  ]
};
let workspaceRagStatus = {
  workspaceId: "default",
  contextName: "Default",
  paths: activeRagContext().paths,
  state: "idle",
  totalFiles: 2,
  processedFiles: 2,
  percent: 100,
  message: "Indexed 2 markdown file(s).",
  nvidiaAvailable: false,
  accelerated: false,
  accelerator: "cpu"
};

function activeRagContext() {
  return workspaceRagConfig.contexts.find(context => context.id === workspaceRagConfig.activeContextId) ?? workspaceRagConfig.contexts[0];
}

function workspaceRagConfigResponse() {
  const context = activeRagContext();
  return {
    ...workspaceRagConfig,
    contextName: context.name,
    paths: context.paths
  };
}

function setWorkspaceRagStatusForActive(overrides = {}) {
  const context = activeRagContext();
  workspaceRagStatus = {
    ...workspaceRagStatus,
    contextName: context.name,
    paths: context.paths,
    ...overrides
  };
}

sessions.set("s0", {
  id: "s0",
  version: "v1",
  status: "active",
  title: "Conversation s0",
  messages: [],
  contexts: [],
  createdAt: now(),
  updatedAt: now()
});

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
    name: "@local-agent/file-broker-client",
    specifier: "./plugins/file-broker",
    description: "Client for the local file-broker HTTP service.",
    types: ["tools"],
    tools: [{ name: "file_broker_action", description: "List, read, and write host files through file-broker." }]
  },
  {
    name: "@matatbread/matbot-workspace-rag",
    specifier: "./packages/plugins/workspace-rag",
    description: "Workspace-scoped markdown RAG ingestion.",
    types: ["tools", "knowledge", "hooks"],
    tools: [{ name: "workspace_rag", description: "Configure workspace markdown RAG." }]
  },
  {
    name: "@matatbread/matbot-skills",
    specifier: "./packages/plugins/skills",
    description: "Skills and skill editor support.",
    types: ["tools", "service:SkillManager"],
    tools: [{ name: "skill_action", description: "Manage skills." }]
  },
  {
    name: "@matatbread/matbot-cognition",
    specifier: "./packages/plugins/cognition",
    description: "Memory and remembered facts.",
    types: ["tools"],
    tools: [
      { name: "remember_fact", description: "Store durable remembered facts." },
      { name: "remembered_facts_action", description: "Inspect and manage remembered facts." },
      { name: "dream_time", description: "Run one memory consolidation pass." },
      { name: "ask_inner_voice", description: "Ask the configured inner voice critic." },
      { name: "cognition_config", description: "Configure cognition providers." }
    ]
  },
  {
    name: "@matatbread/matbot-rumsfeld",
    specifier: "./packages/plugins/rumsfeld",
    description: "Context lookup over memory and knowledge.",
    types: ["tools"],
    tools: [{ name: "contextual_search", description: "Load local context for unknown terms." }]
  }
];

const expertConfigs = [
  {
    id: "design",
    title: "Design Expert",
    description: "Product experience, interaction quality, and visual design.",
    tags: ["design", "ux"]
  },
  {
    id: "finance",
    title: "Finance Expert",
    description: "Budget, value, and operational finance.",
    tags: ["finance"]
  },
  {
    id: "engineering",
    title: "Engineering Expert",
    description: "Architecture, implementation risk, and maintainability.",
    tags: ["engineering"]
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
    matbotRuntime: ["node"],
    types: ["tools"],
    tools: [{ name: "background_prompt", description: "Run a prompt in the background." }]
  }
];

function clonePlugin(plugin) {
  return {
    name: plugin.name,
    specifier: plugin.specifier,
    description: plugin.description,
    types: plugin.types ?? [],
    tools: plugin.tools ?? []
  };
}

function addLoadedPlugin(specifier) {
  if (loadedPlugins.some(plugin => plugin.specifier === specifier || plugin.name === specifier)) {
    const plugin = loadedPlugins.find(item => item.specifier === specifier || item.name === specifier);
    return { ok: true, plugin, message: `Plugin "${plugin.name}" is already loaded.` };
  }
  const plugin = localPlugins.find(item => item.specifier === specifier || item.name === specifier);
  if (!plugin) return { ok: false, error: `Plugin "${specifier}" was not discovered.` };
  if (Array.isArray(plugin.matbotRuntime) && plugin.matbotRuntime.length && !plugin.matbotRuntime.includes("node")) {
    return { ok: false, error: `Plugin "${plugin.name}" cannot run in the node WebUI harness.` };
  }
  const loaded = clonePlugin(plugin);
  loadedPlugins.push(loaded);
  sendGlobal("plugin-changed", { type: "loaded", name: loaded.name, specifier: loaded.specifier });
  for (const tool of loaded.tools ?? []) sendGlobal("tool-changed", { type: "registered", name: tool.name ?? tool });
  return { ok: true, plugin: loaded, message: `Added plugin "${loaded.name}".` };
}

function removeLoadedPlugin(specifier) {
  const index = loadedPlugins.findIndex(plugin => plugin.specifier === specifier || plugin.name === specifier);
  if (index < 0) return { ok: false, error: `Plugin "${specifier}" is not loaded.` };
  const [plugin] = loadedPlugins.splice(index, 1);
  sendGlobal("plugin-changed", { type: "unloaded", name: plugin.name, specifier: plugin.specifier });
  for (const tool of plugin.tools ?? []) sendGlobal("tool-changed", { type: "unregistered", name: tool.name ?? tool });
  return { ok: true, plugin, message: `Removed plugin "${plugin.name}".` };
}

function unwrapToolInvocation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, "$context")) {
    return { input, context: {} };
  }
  return {
    input: Object.hasOwn(input, "input") ? input.input : {},
    context: input.$context && typeof input.$context === "object" && !Array.isArray(input.$context)
      ? input.$context
      : {}
  };
}

function latestTextMessage(sessionId, role = "user") {
  const session = sessions.get(sessionId);
  return [...(session?.messages ?? [])]
    .reverse()
    .find(message => message.role === role && Array.isArray(message.content))
    ?.content
    ?.filter(part => part.type === "text")
    .map(part => part.text)
    .join("\n") ?? "";
}

function extractHarnessFact(text) {
  const memorizedName = /memorize my name:\s*(.+)$/i.exec(text)?.[1]?.trim();
  if (memorizedName) return `The user's name is ${memorizedName}.`;
  const memorizedFact = /memorize(?:\s+this|\s+fact)?:\s*(.+)$/i.exec(text)?.[1]?.trim();
  if (memorizedFact) return memorizedFact;
  const directFact = /(?:direct recall token|direct api code word) is\s+([A-Za-z0-9_-]+)/i.exec(text);
  if (directFact) return `The direct recall token is ${directFact[1]}.`;
  return text.trim();
}

function createHarnessMessage(role, content, traceId, providerName, metadata) {
  return {
    id: `m-${traceId}-${role}-${Math.random().toString(36).slice(2, 8)}`,
    traceId,
    role,
    content,
    createdAt: now(),
    ...(providerName ? { providerName } : {}),
    ...(metadata ? { metadata } : {})
  };
}

function titleFromQuestion(question) {
  const words = String(question || "").trim().split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
  if (!words) return undefined;
  return words.length > 60 ? `${words.slice(0, 60)}...` : words;
}

function appendSessionMessages(sessionId, messages, shapeSession) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const shaped = shapeSession ? shapeSession(session) : session;
  const next = {
    ...shaped,
    version: `v${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    messages: [...shaped.messages, ...messages],
    updatedAt: now()
  };
  sessions.set(sessionId, next);
  return next;
}

function normaliseExpertPanelBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Request body must be an object." };
  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!question) return { ok: false, error: '"question" is required.' };
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  if (!provider) return { ok: false, error: '"provider" is required.' };
  const mode = value.mode === "review" || value.mode === "debate" || value.mode === "parallel" ? value.mode : "parallel";
  let experts;
  if (Object.hasOwn(value, "experts")) {
    if (!Array.isArray(value.experts)) return { ok: false, error: '"experts" must be an array of expert ids.' };
    experts = value.experts.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean);
  }
  return {
    ok: true,
    body: {
      question,
      provider,
      mode,
      ...(experts !== undefined ? { experts } : {}),
      ...(typeof value.synthesize === "boolean" ? { synthesize: value.synthesize } : {}),
      ...(typeof value.maxCitationsPerExpert === "number" ? { maxCitationsPerExpert: value.maxCitationsPerExpert } : {}),
      ...(typeof value.traceId === "string" && value.traceId.trim() ? { traceId: value.traceId.trim() } : {})
    }
  };
}

function expertUserSummary(question, selected, mode, synthesize) {
  return [
    `Expert panel (${mode})`,
    `Experts: ${selected && selected.length ? selected.join(", ") : "all"}`,
    `Synthesize decision: ${synthesize ? "yes" : "no"}`,
    "",
    question
  ].join("\n");
}

function textValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function expertPanelResult(input) {
  const requested = Array.isArray(input.experts) && input.experts.length
    ? input.experts
    : expertConfigs.map(expert => expert.id);
  const unknown = requested.filter(id => !expertConfigs.some(expert => expert.id === id));
  if (unknown.length) return { error: `Unknown expert(s): ${unknown.join(", ")}` };
  const opinions = requested.map(id => {
    const expert = expertConfigs.find(item => item.id === id);
    return {
      expertId: expert.id,
      title: expert.title,
      answer: `${expert.title} answer for "${input.question}" in ${input.mode ?? "parallel"} mode.`,
      citations: [{
        id: `${expert.id}-source`,
        path: `knowledge/${expert.id}/panel-probe.md`,
        title: "panel-probe.md",
        score: 1
      }],
      usage: { inputTokens: 3, outputTokens: 4 }
    };
  });
  const response = {
    question: input.question,
    mode: input.mode ?? "parallel",
    experts: opinions
  };
  if (input.synthesize !== false) {
    response.synthesis = `Synthesis for ${requested.join(", ")}.`;
  }
  return { result: response };
}

function formatExpertPanelResult(result) {
  const record = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const lines = ["## Expert panel", `Mode: ${textValue(record.mode, "parallel")}`];
  const opinions = Array.isArray(record.experts) ? record.experts : [];
  for (const rawOpinion of opinions) {
    const opinion = rawOpinion && typeof rawOpinion === "object" && !Array.isArray(rawOpinion) ? rawOpinion : {};
    lines.push("", `### ${textValue(opinion.title, textValue(opinion.expertId, "Expert"))}`, textValue(opinion.answer, "(No answer returned.)"));
    const citations = Array.isArray(opinion.citations) ? opinion.citations : [];
    if (citations.length) {
      lines.push("", "Citations:");
      for (const rawCitation of citations) {
        const citation = rawCitation && typeof rawCitation === "object" && !Array.isArray(rawCitation) ? rawCitation : {};
        const title = textValue(citation.title, textValue(citation.id, textValue(citation.path, "source")));
        const suffix = typeof citation.path === "string" && citation.path ? ` - ${citation.path}` : "";
        lines.push(`- ${title}${suffix}`);
      }
    }
  }
  if (typeof record.synthesis === "string" && record.synthesis) lines.push("", "### Synthesis", record.synthesis);
  if (!opinions.length && !record.synthesis) lines.push("", "No expert response was returned.");
  return lines.join("\n");
}

function expertPanelUsage(result) {
  const record = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const opinions = Array.isArray(record.experts) ? record.experts : [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const rawOpinion of opinions) {
    const opinion = rawOpinion && typeof rawOpinion === "object" && !Array.isArray(rawOpinion) ? rawOpinion : {};
    const usage = opinion.usage && typeof opinion.usage === "object" && !Array.isArray(opinion.usage) ? opinion.usage : {};
    if (typeof usage.inputTokens === "number") inputTokens += usage.inputTokens;
    if (typeof usage.outputTokens === "number") outputTokens += usage.outputTokens;
  }
  return inputTokens || outputTokens ? { inputTokens, outputTokens } : null;
}

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

  if (method === "GET" && url.pathname === "/workspaces") {
    return json(res, 200, { active: workspaces.find(w => w.active)?.id ?? "default", workspaces });
  }

  if (method === "POST" && url.pathname === "/workspaces") {
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (!name) return json(res, 400, { error: "Workspace name is required" });
    const id = `workspace-${workspaceSeq++}`;
    const workspace = {
      id,
      name,
      configPath: `workspaces/${id}/matbot.yaml`,
      createdAt: now(),
      updatedAt: now(),
      active: false
    };
    workspaces.push(workspace);
    return json(res, 201, workspace);
  }

  const workspaceRename = /^\/workspaces\/([^/]+)\/rename$/.exec(url.pathname);
  if (method === "POST" && workspaceRename) {
    const workspace = workspaces.find(w => w.id === decodeURIComponent(workspaceRename[1]));
    if (!workspace) return json(res, 404, { error: "Workspace not found" });
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (!name) return json(res, 400, { error: "Workspace name is required" });
    workspace.name = name;
    workspace.updatedAt = now();
    return json(res, 200, workspace);
  }

  const workspaceSwitch = /^\/workspaces\/([^/]+)\/switch$/.exec(url.pathname);
  if (method === "POST" && workspaceSwitch) {
    const id = decodeURIComponent(workspaceSwitch[1]);
    const workspace = workspaces.find(w => w.id === id);
    if (!workspace) return json(res, 404, { error: "Workspace not found" });
    for (const item of workspaces) item.active = item.id === id;
    return json(res, 200, { active: id, restarting: true });
  }

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

  const expertPanelSubmit = /^\/sessions\/([^/]+)\/expert-panel$/.exec(url.pathname);
  if (method === "POST" && expertPanelSubmit) {
    const sessionId = decodeURIComponent(expertPanelSubmit[1]);
    const session = sessions.get(sessionId);
    if (!session) return json(res, 404, { error: "Session not found" });
    if (busy.get(sessionId)) return json(res, 409, { error: "Session is busy." });

    const normalised = normaliseExpertPanelBody(await readJson(req));
    if (!normalised.ok) return json(res, 400, { error: normalised.error });
    const body = normalised.body;
    const traceId = body.traceId ?? `trace-${traceSeq++}`;
    const synthesize = body.synthesize !== false;
    const selectedExperts = body.experts?.length ? body.experts : undefined;
    const input = {
      action: "ask",
      question: body.question,
      mode: body.mode ?? "parallel",
      synthesize,
      maxCitationsPerExpert: body.maxCitationsPerExpert ?? 5,
      ...(selectedExperts ? { experts: selectedExperts } : {})
    };
    const userContent = [{
      type: "text",
      text: expertUserSummary(body.question, selectedExperts, input.mode, synthesize)
    }];
    const userMessage = createHarnessMessage(
      "user",
      userContent,
      traceId,
      body.provider,
      { expertPanel: { mode: input.mode, synthesize, experts: selectedExperts ?? "all" } }
    );
    let committed = appendSessionMessages(sessionId, [userMessage], current => {
      if (current.title || current.messages.some(message => message.role === "user")) return current;
      const title = titleFromQuestion(body.question);
      return title ? { ...current, title } : current;
    });
    await waitForSessionStream(sessionId);
    sendSession(sessionId, "queued", { type: "queued", content: userContent, queued: 0, concatQueue: false, traceId, rootTraceId: traceId });
    await sleep(10);

    const panel = expertPanelResult(input);
    const assistantText = panel.error
      ? `Expert panel failed: ${panel.error}`
      : formatExpertPanelResult(panel.result);
    const assistant = createHarnessMessage(
      "assistant",
      [{ type: "text", text: assistantText }],
      traceId,
      body.provider,
      { expertPanel: panel.error ? { error: panel.error } : { result: panel.result } }
    );
    committed = appendSessionMessages(sessionId, [assistant]);
    sendSession(sessionId, "text-delta", { type: "text-delta", delta: assistantText, traceId });
    const usage = expertPanelUsage(panel.result);
    if (usage) sendSession(sessionId, "usage", { type: "usage", ...usage, traceId });
    sendSession(sessionId, "done", { type: "done", session: committed, traceId });
    return json(res, 200, {
      traceId,
      session: committed,
      ...(panel.result ? { result: panel.result, isError: false } : { isError: true, error: panel.error })
    });
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

async function handleTool(res, name, rawInput) {
  const invocation = unwrapToolInvocation(rawInput);
  const input = invocation.input ?? {};
  const context = invocation.context;

  if (name === "provider") {
    return json(res, 200, { providers: [{ name: "openai" }, { name: "Local" }, { name: "panel-test" }] });
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
  if (name === "file_broker_action") {
    if (input.action === "health") {
      return json(res, 200, { ok: true, roots: 1, maxReadBytes: 1000000 });
    }
    if (input.action === "list") {
      return json(res, 200, {
        ok: true,
        entries: [
          { name: "readme.md", path: "C:\\Projects\\Cortex\\readme.md", type: "file", size: 1024 },
          { name: "local-agent", path: "C:\\Projects\\Cortex\\local-agent", type: "directory" }
        ]
      });
    }
    if (input.action === "read") {
      return json(res, 200, {
        ok: true,
        content: `Broker harness host read for ${input.path}.`,
        truncated: false,
        size: 48
      });
    }
    if (input.action === "write") {
      if (/\.env$/i.test(String(input.path ?? "")) && input.approved !== true) {
        return json(res, 409, { error: "High-risk write requires approved=true.", highRisk: true });
      }
      return json(res, 200, {
        ok: true,
        path: input.path,
        backupPath: "C:\\Projects\\Cortex\\local-agent\\file-broker\\backups\\harness.bak",
        diff: `--- ${input.path}\n+++ ${input.path}\n@@\n+${input.content ?? ""}`,
        highRisk: false
      });
    }
  }
  if (name === "workspace_rag") {
    if (input.action === "status") return json(res, 200, workspaceRagStatus);
    if (input.action === "get_config") return json(res, 200, workspaceRagConfigResponse());
    if (input.action === "configure") {
      const contextId = String(input.contextId ?? workspaceRagConfig.activeContextId);
      workspaceRagConfig = {
        ...workspaceRagConfig,
        activeContextId: contextId,
        contexts: workspaceRagConfig.contexts.map(context => context.id === contextId ? {
          ...context,
          name: String(input.contextName ?? context.name),
          paths: Array.isArray(input.paths) ? input.paths.map(String) : context.paths
        } : context)
      };
      const context = activeRagContext();
      setWorkspaceRagStatusForActive({
        state: context.paths.length ? "indexing" : "pending",
        totalFiles: context.paths.length ? 3 : 0,
        processedFiles: context.paths.length ? 2 : 0,
        percent: context.paths.length ? 67 : 0,
        currentFile: context.paths.length ? "C:\\Projects\\Cortex\\docs\\retrieval-probe.md" : "",
        message: context.paths.length ? "Indexing markdown files." : "No markdown folders configured."
      });
      return json(res, 200, { config: workspaceRagConfigResponse(), status: workspaceRagStatus });
    }
    if (input.action === "select_context") {
      const contextId = String(input.contextId ?? "");
      if (!workspaceRagConfig.contexts.some(context => context.id === contextId)) return json(res, 400, { error: `Unknown context ${contextId}` });
      workspaceRagConfig = { ...workspaceRagConfig, activeContextId: contextId };
      setWorkspaceRagStatusForActive({
        state: activeRagContext().paths.length ? "idle" : "pending",
        percent: activeRagContext().paths.length ? 100 : 0,
        message: activeRagContext().paths.length ? "Indexed 2 markdown file(s)." : "No markdown folders configured."
      });
      return json(res, 200, { config: workspaceRagConfigResponse(), status: workspaceRagStatus });
    }
    if (input.action === "create_context") {
      const name = String(input.contextName ?? `Context ${workspaceRagConfig.contexts.length + 1}`).trim() || `Context ${workspaceRagConfig.contexts.length + 1}`;
      const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `context-${workspaceRagConfig.contexts.length + 1}`;
      const uniqueId = workspaceRagConfig.contexts.some(context => context.id === id) ? `${id}-${workspaceRagConfig.contexts.length + 1}` : id;
      workspaceRagConfig = {
        activeContextId: uniqueId,
        contexts: [...workspaceRagConfig.contexts, { id: uniqueId, name, paths: [] }]
      };
      setWorkspaceRagStatusForActive({
        state: "pending",
        totalFiles: 0,
        processedFiles: 0,
        percent: 0,
        message: "No markdown folders configured."
      });
      return json(res, 200, { config: workspaceRagConfigResponse(), status: workspaceRagStatus });
    }
    if (input.action === "reindex_now") {
      workspaceRagStatus = { ...workspaceRagStatus, state: "idle", processedFiles: 3, totalFiles: 3, percent: 100, message: "Indexed 3 markdown file(s)." };
      return json(res, 200, workspaceRagStatus);
    }
    if (input.action === "search") {
      return json(res, 200, {
        hits: [{
          workspaceId: "default",
          contextName: activeRagContext().name,
          path: "C:/Projects/Cortex/docs/probe.md",
          chunkId: "probe:0",
          score: 0.92,
          text: "Workspace RAG probe context."
        }]
      });
    }
  }
  if (name === "remembered_facts_action") {
    if (input.action === "list") return json(res, 200, { facts: [...rememberedFacts.values()] });
    if (input.action === "get") return json(res, 200, rememberedFacts.get(input.id) ?? null);
    if (input.action === "delete") {
      rememberedFacts.delete(input.id);
      return json(res, 200, { ok: true });
    }
  }
  if (name === "remember_fact") {
    if (!context.provider) return json(res, 500, { error: "remember_fact needs provider context" });
    if (!context.sessionId || !sessions.has(context.sessionId)) return json(res, 404, { error: "remember_fact needs a real session context" });
    const latestText = latestTextMessage(context.sessionId);
    if (!latestText.trim()) return json(res, 500, { error: "remember_fact found no latest user message" });
    const fact = extractHarnessFact(latestText);
    const id = `fact-${rememberedFactSeq++}`;
    const session = sessions.get(context.sessionId);
    const message = [...session.messages].reverse().find(item => item.role === "user");
    const doc = { id, version: "v1", fact, sessionId: context.sessionId, messageId: message?.id ?? "manual", createdAt: now() };
    rememberedFacts.set(id, doc);
    return json(res, 200, { ok: true, markers: [{ creator: "remember_fact", data: { facts: [fact], sessionId: context.sessionId } }] });
  }
  if (name === "dream_time") {
    if (!context.provider) return json(res, 500, { error: "dream_time needs provider context" });
    return json(res, 200, {
      id: "dream-run-direct",
      outcome: "no-facts",
      provider: context.provider,
      mergedFactIds: [],
      judgementCalls: []
    });
  }
  if (name === "ask_inner_voice") {
    if (!context.provider) return json(res, 500, { error: "ask_inner_voice has no provider" });
    if (!input.prompt) return json(res, 400, { error: "ask_inner_voice requires prompt" });
    return json(res, 200, {
      text: `Inner voice (${context.provider}) critique: sharpen the framing.`,
      usage: { inputTokens: 9, outputTokens: 7 }
    });
  }
  if (name === "contextual_search") {
    const terms = Array.isArray(input.terms) ? input.terms : [];
    const query = terms.map(term => [term.term, term.context].filter(Boolean).join(" ")).join(" ").toLowerCase();
    const queryTokens = new Set((query.match(/[a-z0-9]+/g) ?? []).filter(token => token.length > 1));
    const remembered = [...rememberedFacts.values()]
      .filter(fact => {
        const factText = fact.fact.toLowerCase();
        return [...queryTokens].some(token => factText.includes(token));
      })
      .slice(0, 5);
    const workspaceRag = {
      contextName: activeRagContext().name,
      path: "C:/Projects/Cortex/docs/probe.md",
      score: 0.92,
      text: "Workspace RAG probe context."
    };
    const parts = [];
    if (remembered.length) parts.push(["Remembered facts:", ...remembered.map(fact => `- ${fact.fact}`)].join("\n"));
    if (/quasarpump|rag|workspace|probe/.test(query)) {
      parts.push([
        `Workspace RAG results (${workspaceRag.contextName}):`,
        `- Source 1: ${workspaceRag.path} (score ${workspaceRag.score.toFixed(3)})`,
        workspaceRag.text
      ].join("\n"));
    }
    if (!parts.length) return json(res, 404, { error: "There is no skill available for the requested operation." });
    return json(res, 200, {
      name: remembered.length ? "remembered_facts" : "workspace_rag",
      content: parts.join("\n\n")
    });
  }
  if (name === "plugin") {
    if (input.action === "list") return json(res, 200, { loaded: loadedPlugins });
    if (input.action === "discover_local") return json(res, 200, localPlugins);
    if (input.action === "add") {
      const result = addLoadedPlugin(String(input.specifier ?? input.name ?? ""));
      return json(res, result.ok ? 200 : 400, result);
    }
    if (input.action === "remove" || input.action === "unload") {
      const result = removeLoadedPlugin(String(input.specifier ?? input.name ?? ""));
      return json(res, result.ok ? 200 : 400, result);
    }
  }
  if (name === "expert_panel") {
    if (input.action === "list") return json(res, 200, { experts: expertConfigs });
    const panel = expertPanelResult(input);
    if (panel.error) return json(res, 400, { error: panel.error });
    return json(res, 200, panel.result);
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
  await waitForSessionStream(sessionId);
  sendSession(sessionId, "queued", { type: "queued", content: userMessage.content, queued: 0, concatQueue: false, traceId, rootTraceId: traceId });
  await sleep(20);

  const run = runningTurns.get(sessionId);
  if (!run || run.aborted) return;

  if (/slow/i.test(content)) {
    sendSession(sessionId, "text-delta", { type: "text-delta", delta: "Starting slow response...", traceId });
    return;
  }

  const addPluginMatch = /^Add the plugin '([^']+)'/i.exec(content);
  const removePluginMatch = /^Remove the plugin '([^']+)'/i.exec(content);
  if (addPluginMatch || removePluginMatch) {
    const action = addPluginMatch ? "add" : "remove";
    const specifier = (addPluginMatch ?? removePluginMatch)[1];
    sendSession(sessionId, "thinking", { type: "thinking", delta: `${action === "add" ? "Adding" : "Removing"} plugin.`, traceId });
    await sleep(10);
    sendSession(sessionId, "tool:start", { type: "tool:start", callId: `call-${traceId}`, name: "plugin", input: { action, specifier }, traceId });
    await sleep(10);
    const result = action === "add" ? addLoadedPlugin(specifier) : removeLoadedPlugin(specifier);
    sendSession(sessionId, "tool:end", { type: "tool:end", callId: `call-${traceId}`, result, isError: !result.ok, traceId });
    const assistantText = result.ok
      ? result.message
      : `Could not ${action} plugin "${specifier}": ${result.error}`;
    sendSession(sessionId, "text-delta", { type: "text-delta", delta: assistantText, traceId });
    const assistant = {
      id: `m-${traceId}-a`,
      traceId,
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      createdAt: now()
    };
    session.messages.push(assistant);
    session.updatedAt = now();
    sendSession(sessionId, "done", { type: "done", session, traceId });
    runningTurns.delete(sessionId);
    setBusy(sessionId, false);
    return;
  }

  const memorizedName = /memorize my name:\s*(.+)$/i.exec(content)?.[1]?.trim();
  if (memorizedName) {
    const id = `fact-${rememberedFactSeq++}`;
    rememberedFacts.set(id, {
      id,
      version: "v1",
      fact: `The user's name is ${memorizedName}.`,
      sessionId,
      messageId: userMessage.id,
      createdAt: now()
    });
  } else {
    const memorizedFact = /memorize(?:\s+this|\s+fact)?:\s*(.+)$/i.exec(content)?.[1]?.trim();
    if (memorizedFact) {
      const id = `fact-${rememberedFactSeq++}`;
      rememberedFacts.set(id, {
        id,
        version: "v1",
        fact: memorizedFact,
        sessionId,
        messageId: userMessage.id,
        createdAt: now()
      });
    }
  }

  sendSession(sessionId, "thinking", { type: "thinking", delta: "Checking harness state.", traceId });
  await sleep(10);
  if (/quasarpump/i.test(content)) {
    sendSession(sessionId, "marker", {
      type: "marker",
      content: [{ type: "marker", creator: "workspace-rag", data: { hits: [{ path: "C:/Projects/Cortex/docs/retrieval-probe.md", score: 0.92 }] } }],
      traceId
    });
  }
  sendSession(sessionId, "tool:start", { type: "tool:start", callId: `call-${traceId}`, name: "expert_panel", input: { question: content }, traceId });
  await sleep(10);
  sendSession(sessionId, "tool:stdout", { type: "tool:stdout", callId: `call-${traceId}`, chunk: "consulting experts\n", traceId });
  sendSession(sessionId, "tool:end", { type: "tool:end", callId: `call-${traceId}`, result: { ok: true }, isError: false, traceId });

  if (/what is my name/i.test(content)) {
    const nameFact = [...rememberedFacts.values()].find(fact => /user's name is/i.test(fact.fact));
    sendSession(sessionId, "text-delta", { type: "text-delta", delta: nameFact ? `Your name is ${nameFact.fact.replace(/^The user's name is\s*/i, "").replace(/\.$/, "")}.` : "I do not have your name stored.", traceId });
  } else if (/quasarpump/i.test(content)) {
    sendSession(sessionId, "text-delta", { type: "text-delta", delta: "Workspace RAG says the QuasarPump calibration value is 42 and the amber valve is required.", traceId });
  } else if (/prompt me/i.test(content)) {
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
    content: [{ type: "text", text: /what is my name/i.test(content)
      ? "Your name is Maciej Zagozda."
      : /quasarpump/i.test(content)
        ? "Workspace RAG says the QuasarPump calibration value is 42 and the amber valve is required."
        : /prompt me/i.test(content) ? "Prompt handled." : `Harness response to: ${content}` }],
    createdAt: now()
  };
  session.messages.push(assistant);
  session.updatedAt = now();
  sendSession(sessionId, "done", { type: "done", session, traceId });
  runningTurns.delete(sessionId);
  setBusy(sessionId, false);
}

async function waitForSessionStream(sessionId) {
  const started = Date.now();
  while ((sessionStreams.get(sessionId)?.size ?? 0) === 0 && Date.now() - started < 500) {
    await sleep(10);
  }
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
