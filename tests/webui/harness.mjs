import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const staticRoot = path.join(root, "local-agent/matbot/packages/plugins/frontend/web/static");
const memoryBrowserStaticRoot = path.join(root, "local-agent/matbot/packages/plugins/memory-browser/static");
const port = Number(process.env.MATBOT_WEBUI_TEST_PORT ?? 19787);
const memoryBrowserPort = Number(process.env.MATBOT_MEMORY_BROWSER_TEST_PORT ?? port + 1);
const memoryBrowserUrl = `http://127.0.0.1:${memoryBrowserPort}`;

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
const queuedTurns = new Map();
let workspaceSeq = 1;
let rememberedFactSeq = 1;
const rememberedFactsByWorkspace = new Map();
let queryRunSeq = 1;
let workflowRunSeq = 1;
let workflowCompilationSeq = 1;
let expertReviewSeq = 1;
const queryRuns = new Map();
const workflowCompilations = new Map();
const workflowRuns = new Map();
const workflowApprovals = new Map();
const workflowShadowComparisons = new Map();
const expertReviews = new Map();
const evaluationTraces = new Map();
const evaluationSuites = new Map();
const evaluationRuns = new Map();

function seedEvaluationData() {
  evaluationTraces.clear();
  evaluationSuites.clear();
  evaluationRuns.clear();
  evaluationTraces.set("trace:playwright-governed", {
    id: "trace:playwright-governed", version: "trace-version-1", traceId: "trace:playwright-governed", rootTraceId: "trace:playwright-governed",
    workspaceId: "default", sessionId: "session:playwright", status: "ok", startedAt: "2026-07-10T08:00:00.000Z", endedAt: "2026-07-10T08:00:01.250Z", updatedAt: "2026-07-10T08:00:01.250Z",
    durationMs: 1250, spanCount: 5, eventCount: 10, inputTokens: 850, outputTokens: 120, costUsd: 0.032, workflowRunIds: ["run:playwright-governed"]
  });
  evaluationSuites.set("suite:playwright-governed", {
    id: "suite:playwright-governed", version: "suite-version-1", workspaceId: "default", name: "Governed deployment regression", description: "Retrieval, citation, action, policy, and workflow completion release gates.",
    caseIds: ["case:retrieval", "case:policy"], scorerIds: ["scorer:retrieval", "scorer:policy"], passThreshold: 1, createdAt: now(), updatedAt: now()
  });
  evaluationRuns.set("eval-run:playwright", {
    id: "eval-run:playwright", version: "eval-run-version-1", suiteId: "suite:playwright-governed", suiteVersion: "suite-version-1", workspaceId: "default", candidate: "baseline",
    status: "completed", passed: true, score: 0.94, passRate: 1, caseCount: 2, startedAt: "2026-07-10T09:00:00.000Z", updatedAt: "2026-07-10T09:00:02.000Z", finishedAt: "2026-07-10T09:00:02.000Z", traceId: "trace:evaluator-playwright"
  });
}

seedEvaluationData();

const architectureSource = {
  id: "source:playwright-architecture-brief",
  version: "source-record-version-1",
  workspaceId: "default",
  connectorType: "workspace-rag",
  connectorInstanceId: "connector-instance:workspace-rag:local",
  externalId: "default:docs/architecture.md",
  uri: "C:/Projects/Cortex/docs/architecture.md",
  title: "architecture.md",
  sourceKind: "document",
  sensitivity: "internal",
  permissionState: "allowed",
  trustLevel: "high",
  citationPolicy: "cite_path",
  healthState: "unhealthy",
  stalenessState: "stale",
  lastObservedAt: now(),
  lastSuccessfulReadAt: "2026-01-01T00:00:00.000Z",
  knownLimitations: ["Harness source intentionally reports stale/degraded state."]
};
const architectureSourceVersion = {
  id: "source-version:playwright-architecture-brief-v1",
  version: "source-version-record-1",
  sourceId: architectureSource.id,
  contentHash: "playwright-architecture-hash",
  observedAt: "2026-01-01T00:00:00.000Z",
  provenance: { activityId: "playwright:source-registry" }
};

const initialWorkspaceFiles = [
  ["brief.md", Buffer.from("# Brief\nInitial workspace file.", "utf8")]
];
const filesByWorkspace = new Map();

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

function activeHarnessWorkspaceId() {
  return workspaces.find(workspace => workspace.active)?.id ?? "default";
}

function filesForWorkspace(workspaceId = activeHarnessWorkspaceId()) {
  let store = filesByWorkspace.get(workspaceId);
  if (!store) {
    store = new Map(workspaceId === "default"
      ? initialWorkspaceFiles.map(([name, contents]) => [name, Buffer.from(contents)])
      : []);
    filesByWorkspace.set(workspaceId, store);
  }
  return store;
}

function rememberedFactsForWorkspace(workspaceId = activeHarnessWorkspaceId()) {
  let store = rememberedFactsByWorkspace.get(workspaceId);
  if (!store) {
    store = new Map();
    rememberedFactsByWorkspace.set(workspaceId, store);
  }
  return store;
}

function sessionWorkspaceId(sessionId) {
  return sessions.get(sessionId)?.workspaceId ?? activeHarnessWorkspaceId();
}

function queuedTurnsForSession(sessionId) {
  let queue = queuedTurns.get(sessionId);
  if (!queue) {
    queue = [];
    queuedTurns.set(sessionId, queue);
  }
  return queue;
}
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
  cudaAvailable: false,
  accelerated: false,
  accelerator: "cpu",
  embeddingBackend: "hash-cpu",
  embeddingModel: "token-hash-v1",
  embeddingDimensions: 384,
  accelerationMessage: "Using CPU hash vectorizer.",
  storageBackend: "json",
  storageMessage: "Legacy JSON workspace RAG storage active."
};
const workspaceRagStateByWorkspace = new Map();

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
  const nextStatus = {
    ...workspaceRagStatus,
    workspaceId: activeHarnessWorkspaceId(),
    contextName: context.name,
    paths: context.paths,
    ...overrides
  };
  if (nextStatus.state !== "indexing") delete nextStatus.currentFile;
  workspaceRagStatus = nextStatus;
}

function persistWorkspaceRagState(workspaceId = activeHarnessWorkspaceId()) {
  workspaceRagStateByWorkspace.set(workspaceId, {
    config: structuredClone(workspaceRagConfig),
    status: structuredClone(workspaceRagStatus)
  });
}

function restoreWorkspaceRagState(workspaceId, workspaceName = "Workspace") {
  const stored = workspaceRagStateByWorkspace.get(workspaceId);
  if (stored) {
    workspaceRagConfig = structuredClone(stored.config);
    workspaceRagStatus = { ...structuredClone(stored.status), workspaceId };
    return;
  }
  workspaceRagConfig = {
    activeContextId: "default",
    contexts: [{ id: "default", name: workspaceName, paths: [] }]
  };
  workspaceRagStatus = {
    workspaceId,
    contextName: workspaceName,
    paths: [],
    state: "pending",
    totalFiles: 0,
    processedFiles: 0,
    percent: 0,
    message: "No markdown folders configured.",
    nvidiaAvailable: false,
    cudaAvailable: false,
    accelerated: false,
    accelerator: "cpu",
    embeddingBackend: "hash-cpu",
    embeddingModel: "token-hash-v1",
    embeddingDimensions: 384,
    accelerationMessage: "Using CPU hash vectorizer.",
    storageBackend: "json",
    storageMessage: "Legacy JSON workspace RAG storage active."
  };
}

sessions.set("s0", {
  id: "s0",
  version: "v1",
  status: "active",
  title: "Conversation s0",
  workspaceId: "default",
  messages: [],
  contexts: [],
  createdAt: now(),
  updatedAt: now()
});

const initialSkills = [
  ["Inner voice", {
    name: "Inner voice",
    content: "# Inner Voice\nAsk the configured critic to review the response.",
    catalogue: true,
    knowledge: null
  }],
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
];
const skillsByWorkspace = new Map();

const initialTriggers = [
  ["trigger-panel", {
    id: "trigger-panel",
    tool: "skill_action",
    params: { action: "use", name: "Panel Etiquette" },
    conditions: [{ kind: "ephemeral", rule: "MATCH when the user asks for expert panel etiquette." }]
  }]
];
const triggersByWorkspace = new Map();

const initialLoadedPlugins = [
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
    name: "@matatbread/matbot-source-registry",
    specifier: "./packages/plugins/source-registry",
    description: "Source identity, freshness, health, citations, and provenance.",
    types: ["tools", "service:SourceRegistry"],
    tools: [
      { name: "source_action", description: "Inspect source records, citations, and source events." },
      { name: "source_health_action", description: "Generate source health reports and warnings." }
    ]
  },
  {
    name: "@matatbread/matbot-connector-fabric",
    specifier: "./packages/plugins/connector-fabric",
    description: "Connector identity, grants, health, sync cursors, and audit.",
    types: ["tools", "service:ConnectorRegistry", "hooks"],
    tools: [{ name: "connector_action", description: "Inspect connectors, grants, health, sync cursors, and audit." }]
  },
  {
    name: "@matatbread/matbot-structured-data",
    specifier: "./packages/plugins/structured-data",
    description: "Governed semantic SQL planning and approved read-only execution.",
    types: ["tools", "service:DataCatalog", "service:SqlPlanner"],
    tools: [{ name: "structured_data_action", description: "Plan, approve, and execute governed SQL queries." }]
  },
  {
    name: "@matatbread/matbot-workflow-governance",
    specifier: "./packages/plugins/workflow-governance",
    description: "Workflow definitions, run ledger, approval gates, shadow comparisons, and compiler.",
    types: ["tools", "service:WorkflowRegistry", "service:WorkflowRunner", "service:WorkflowCompiler", "hooks"],
    tools: [{ name: "workflow_action", description: "Compile, run, inspect, approve, and compare governed workflows." }]
  },
  {
    name: "@matatbread/matbot-evaluation-observability",
    specifier: "./packages/plugins/evaluation-observability",
    description: "End-to-end traces, replay, regression suites, governance metrics, and ROI evidence.",
    types: ["tools", "service:Observability"],
    tools: [{ name: "evaluation_action", description: "Inspect traces, run evaluations, and report ROI." }]
  },
  {
    name: "@matatbread/matbot-context-graph",
    specifier: "./packages/plugins/context-graph",
    description: "Source-backed entity graph, relationship assertions, and graph retrieval.",
    types: ["tools", "service:ContextGraph"],
    tools: [{ name: "context_graph_action", description: "Search, retrieve, and maintain source-backed graph facts." }]
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
    name: "@matatbread/matbot-memory-browser",
    specifier: "./packages/plugins/memory-browser",
    description: "Standalone local browser for remembered facts.",
    types: ["frontend", "tools"],
    tools: [{ name: "open_memory_browser", description: "Return the local URL for the memory browser." }]
  },
  {
    name: "@matatbread/matbot-rumsfeld",
    specifier: "./packages/plugins/rumsfeld",
    description: "Context lookup over memory and knowledge.",
    types: ["tools"],
    tools: [{ name: "contextual_search", description: "Load local context for unknown terms." }]
  }
];

const loadedPluginsByWorkspace = new Map();
const providersByWorkspace = new Map();
const defaultProviders = ["openai", "Local", "panel-test"];

function cloneEntries(entries) {
  return new Map(entries.map(([key, value]) => [key, structuredClone(value)]));
}

function skillsForWorkspace(workspaceId = activeHarnessWorkspaceId()) {
  let store = skillsByWorkspace.get(workspaceId);
  if (!store) {
    store = cloneEntries(initialSkills);
    skillsByWorkspace.set(workspaceId, store);
  }
  return store;
}

function triggersForWorkspace(workspaceId = activeHarnessWorkspaceId()) {
  let store = triggersByWorkspace.get(workspaceId);
  if (!store) {
    store = cloneEntries(initialTriggers);
    triggersByWorkspace.set(workspaceId, store);
  }
  return store;
}

function loadedPluginsForWorkspace(workspaceId = activeHarnessWorkspaceId()) {
  let plugins = loadedPluginsByWorkspace.get(workspaceId);
  if (!plugins) {
    plugins = initialLoadedPlugins.map(plugin => structuredClone(plugin));
    loadedPluginsByWorkspace.set(workspaceId, plugins);
  }
  return plugins;
}

function providersForWorkspace(workspaceId = activeHarnessWorkspaceId()) {
  return providersByWorkspace.get(workspaceId) ?? defaultProviders;
}

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
  },
  {
    specifier: "./packages/plugins/powershell",
    name: "@matatbread/matbot-tool-powershell",
    description: "Run PowerShell scripts in the session workspace on Windows.",
    matbotRuntime: ["node"],
    types: ["tools"],
    tools: [{ name: "powershell", description: "Run a PowerShell script." }]
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

function addLoadedPlugin(specifier, workspaceId = activeHarnessWorkspaceId()) {
  const loadedPlugins = loadedPluginsForWorkspace(workspaceId);
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

function removeLoadedPlugin(specifier, workspaceId = activeHarnessWorkspaceId()) {
  const loadedPlugins = loadedPluginsForWorkspace(workspaceId);
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

function nextRememberedFactVersion() {
  return `v${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function fieldValue(record, field) {
  if (Array.isArray(field)) return field.reduce((value, key) => value?.[key], record);
  return record?.[field];
}

function matchesRememberedFactFilter(record, filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return true;
  const value = fieldValue(record, filter.field);
  switch (filter.op) {
    case "eq": return value === filter.value;
    case "neq": return value !== undefined && value !== null && value !== filter.value;
    case "lt": return value < filter.value;
    case "lte": return value <= filter.value;
    case "gt": return value > filter.value;
    case "gte": return value >= filter.value;
    case "in": return Array.isArray(filter.value) && filter.value.includes(value);
    case "nin": return value !== undefined && value !== null && Array.isArray(filter.value) && !filter.value.includes(value);
    case "exists": return filter.value ? value !== undefined && value !== null : value === undefined || value === null;
    case "stringContains": return typeof value === "string" && String(value).toLowerCase().includes(String(filter.value ?? "").toLowerCase());
    case "arrayContains": return Array.isArray(value) && value.includes(filter.value);
    case "and": return Array.isArray(filter.clauses) && filter.clauses.every(clause => matchesRememberedFactFilter(record, clause));
    case "or": return Array.isArray(filter.clauses) && filter.clauses.some(clause => matchesRememberedFactFilter(record, clause));
    case "not": return !matchesRememberedFactFilter(record, filter.clause);
    default: return true;
  }
}

function queryRememberedFacts(query = {}, store = rememberedFactsForWorkspace()) {
  let items = [...store.values()];
  if (query.where) items = items.filter(item => matchesRememberedFactFilter(item, query.where));
  if (Array.isArray(query.sort)) {
    items = [...items].sort((a, b) => {
      for (const spec of query.sort) {
        const av = fieldValue(a, spec.field);
        const bv = fieldValue(b, spec.field);
        const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
        if (cmp !== 0) return spec.dir === "desc" ? -cmp : cmp;
      }
      return String(a.id).localeCompare(String(b.id));
    });
  }
  const total = items.length;
  const limit = Number.isInteger(query.limit) ? Math.max(0, query.limit) : total;
  const offset = Math.max(0, Number(query.cursor ?? 0) || 0);
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    total,
    ...(nextOffset < total ? { cursor: String(nextOffset) } : {})
  };
}

function rememberedFactFromData(id, data) {
  const fact = String(data?.fact ?? "").trim();
  if (!fact) return null;
  return {
    ...data,
    id,
    version: nextRememberedFactVersion(),
    fact,
    sessionId: String(data?.sessionId ?? "manual"),
    messageId: String(data?.messageId ?? "manual"),
    createdAt: String(data?.createdAt ?? now())
  };
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
    if (/partial expert failure/i.test(String(input.question)) && id === "finance") {
      return {
        expertId: expert.id,
        title: expert.title,
        error: "Simulated finance expert timeout.",
        citations: [],
        usage: { inputTokens: 3, outputTokens: 0 }
      };
    }
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
    if (/synthesis only failure/i.test(String(input.question))) {
      response.synthesisError = "Simulated synthesis timeout; independent expert evidence remains available.";
    } else {
      response.synthesis = /partial expert failure/i.test(String(input.question))
        ? "Synthesis used the successful experts and excluded Finance Expert after its timeout."
        : `Synthesis for ${requested.join(", ")}.`;
    }
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
    if (typeof opinion.error === "string" && opinion.error) lines.push(`Error: ${opinion.error}`);
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
  if (typeof record.synthesisError === "string" && record.synthesisError) {
    lines.push("", "### Synthesis unavailable", record.synthesisError);
  }
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

function sourceCitation(sourceId = architectureSource.id, versionId = architectureSourceVersion.id) {
  return {
    sourceId,
    versionId,
    text: `${architectureSource.title} (${architectureSource.uri}) observed at ${architectureSourceVersion.observedAt}`
  };
}

function queryResultSource(run) {
  return {
    id: run.resultSourceId,
    version: "query-result-source-version",
    workspaceId: run.workspaceId,
    connectorType: "structured-data",
    connectorInstanceId: "connector-instance:postgres-readonly:local",
    externalId: `query-result:${run.id}`,
    uri: `structured-data://query-runs/${run.id}`,
    title: `Query result ${run.id}`,
    sourceKind: "query_result",
    sensitivity: "internal",
    permissionState: "allowed",
    trustLevel: "medium",
    citationPolicy: "cite_query",
    healthState: "healthy",
    stalenessState: "fresh",
    lastObservedAt: run.executedAt ?? run.updatedAt,
    lastSuccessfulReadAt: run.executedAt ?? run.updatedAt,
    knownLimitations: [`SQL hash: ${run.sqlHash}`]
  };
}

function sourceActionResult(input) {
  const executedRuns = [...queryRuns.values()].filter(run => run.resultSourceId);
  const sources = [
    architectureSource,
    ...executedRuns.map(queryResultSource)
  ];
  if (input.action === "list") return { sources };
  if (input.action === "get") return sources.find(source => source.id === input.id) ?? null;
  if (input.action === "stale") return { sources: [architectureSource] };
  if (input.action === "citation") return sourceCitation(input.sourceId, input.versionId);
  if (input.action === "health") {
    return {
      events: [{
        id: "source-health:playwright",
        version: "source-health-version",
        sourceId: input.sourceId ?? architectureSource.id,
        state: "degraded",
        checkedAt: now(),
        message: "Harness source reports stale/degraded evidence."
      }]
    };
  }
  if (input.action === "events") {
    return {
      access: [{
        id: "source-access:playwright",
        version: "source-access-version",
        sourceId: input.sourceId ?? architectureSource.id,
        action: "retrieve",
        allowed: true,
        timestamp: now(),
        message: "Harness retrieval access event."
      }],
      health: sourceActionResult({ action: "health", sourceId: input.sourceId }).events
    };
  }
  return { error: `Unknown source_action "${input.action}".` };
}

function sourceHealthReport() {
  return {
    id: "source-health-report:playwright",
    version: "source-health-report-version",
    generatedAt: now(),
    totalSources: 1,
    healthySources: 0,
    staleSources: 1,
    unhealthySources: 1,
    warningCount: 2,
    criticalCount: 0,
    workspaceId: "default",
    findings: [
      {
        sourceId: architectureSource.id,
        sourceVersionId: architectureSourceVersion.id,
        severity: "warning",
        issueType: "stale",
        message: "architecture.md is stale."
      },
      {
        sourceId: architectureSource.id,
        sourceVersionId: architectureSourceVersion.id,
        severity: "warning",
        issueType: "degraded",
        message: "architecture.md is degraded."
      }
    ],
    connectorHealth: [{
      connectorInstanceId: "connector-instance:workspace-rag:local",
      displayName: "Local Workspace RAG",
      type: "workspace-rag",
      workspaceId: "default",
      healthState: "degraded",
      checkedAt: now(),
      message: "Harness connector health warning."
    }]
  };
}

function sourceHealthActionResult(input) {
  const report = sourceHealthReport();
  if (input.action === "report") return report;
  if (input.action === "warnings") {
    return {
      reportId: report.id,
      generatedAt: report.generatedAt,
      warningCount: report.warningCount,
      criticalCount: report.criticalCount,
      findings: report.findings,
      connectorHealth: report.connectorHealth
    };
  }
  if (input.action === "connectors") return { connectors: report.connectorHealth };
  if (input.action === "reports") return { reports: [report] };
  return { error: `Unknown source_health_action "${input.action}".` };
}

function connectorDefinitions() {
  return [
    { id: "connector-definition:source-registry", type: "source-registry", displayName: "Source Registry", protocol: "native", capabilities: ["read"] },
    { id: "connector-definition:workspace-rag", type: "workspace-rag", displayName: "Workspace RAG", protocol: "native", capabilities: ["read", "write", "admin"] },
    { id: "connector-definition:postgres-readonly", type: "postgres-readonly", displayName: "Postgres Read-Only", protocol: "postgres", capabilities: ["read"] },
    { id: "connector-definition:workflow-governance", type: "workflow-governance", displayName: "Workflow Governance", protocol: "native", capabilities: ["read", "write", "admin"] },
    { id: "connector-definition:context-graph", type: "context-graph", displayName: "Context Graph", protocol: "native", capabilities: ["read", "write", "admin"] }
  ];
}

function connectorInstances() {
  return [
    { id: "connector-instance:source-registry:local", definitionId: "connector-definition:source-registry", type: "source-registry", workspaceId: "default", displayName: "Local Source Registry", healthState: "healthy" },
    { id: "connector-instance:workspace-rag:local", definitionId: "connector-definition:workspace-rag", type: "workspace-rag", workspaceId: "default", displayName: "Local Workspace RAG", healthState: "degraded" },
    { id: "connector-instance:postgres-readonly:local", definitionId: "connector-definition:postgres-readonly", type: "postgres-readonly", workspaceId: "default", displayName: "Local Postgres Read-Only", healthState: "healthy" },
    { id: "connector-instance:workflow-governance:local", definitionId: "connector-definition:workflow-governance", type: "workflow-governance", workspaceId: "default", displayName: "Local Workflow Governance", healthState: "healthy" },
    { id: "connector-instance:context-graph:local", definitionId: "connector-definition:context-graph", type: "context-graph", workspaceId: "default", displayName: "Local Context Graph", healthState: "healthy" }
  ];
}

function connectorBindings() {
  return [
    { id: "binding:source-action", connectorInstanceId: "connector-instance:source-registry:local", toolName: "source_action", capability: "read", sourceTypes: ["source_record"] },
    { id: "binding:source-health-action", connectorInstanceId: "connector-instance:source-registry:local", toolName: "source_health_action", capability: "read", sourceTypes: ["source_health_report"] },
    { id: "binding:structured-data", connectorInstanceId: "connector-instance:postgres-readonly:local", toolName: "structured_data_action", capability: "read", approvalPolicyId: "structured-data-admin", sourceTypes: ["table", "query_result"] },
    { id: "binding:workflow", connectorInstanceId: "connector-instance:workflow-governance:local", toolName: "workflow_action", capability: "read", approvalPolicyId: "workflow-governance-admin", sourceTypes: ["workflow_definition", "workflow_run", "workflow_approval"] },
    { id: "binding:context-graph", connectorInstanceId: "connector-instance:context-graph:local", toolName: "context_graph_action", capability: "read", approvalPolicyId: "context-graph-write", sourceTypes: ["context_entity", "context_relationship"] }
  ];
}

function connectorActionResult(input) {
  if (input.action === "list") return { definitions: connectorDefinitions(), instances: connectorInstances() };
  if (input.action === "list_tools") return { bindings: connectorBindings() };
  if (input.action === "health") {
    return {
      events: [{
        id: "connector-health:playwright",
        version: "connector-health-version",
        connectorInstanceId: input.connectorInstanceId ?? "connector-instance:workspace-rag:local",
        state: "healthy",
        checkedAt: now(),
        message: "Harness connector health check passed."
      }]
    };
  }
  if (input.action === "test_health") {
    return {
      id: "connector-health:test",
      version: "connector-health-version",
      connectorInstanceId: input.connectorInstanceId,
      state: "healthy",
      checkedAt: now(),
      message: "All exact connector tool bindings are registered.",
      details: { missingTools: [], checkedBy: "connector_action" }
    };
  }
  if (input.action === "list_audit") {
    return {
      events: [{
        id: "connector-audit:playwright",
        version: "connector-audit-version",
        connectorInstanceId: "connector-instance:postgres-readonly:local",
        toolName: "structured_data_action",
        capability: "read",
        principalId: "system",
        inputHash: "audit-input-hash",
        resultStatus: "ok",
        timestamp: now(),
        redactedInput: { action: "execute_query", approvalToken: "[redacted]" },
        sourceIds: [architectureSource.id]
      }]
    };
  }
  return { error: `Unknown connector_action "${input.action}".` };
}

function structuredCatalog() {
  const connection = {
    id: "data-connection:playwright",
    version: "data-connection-version",
    workspaceId: "default",
    displayName: "Harness Warehouse",
    dialect: "postgres",
    readOnly: true,
    connectorInstanceId: "connector-instance:postgres-readonly:local",
    rowLimitDefault: 50,
    timeoutMsDefault: 2500,
    defaultSchema: "public"
  };
  const table = {
    id: "data-table:orders",
    version: "data-table-version",
    workspaceId: "default",
    connectionId: connection.id,
    schemaName: "public",
    tableName: "orders",
    displayName: "Orders",
    primaryKey: ["id"],
    allowed: true,
    sourceId: architectureSource.id
  };
  const columns = [
    { id: "data-column:orders:id", tableId: table.id, name: "id", dataType: "string", role: "identifier", nullable: false },
    { id: "data-column:orders:order_date", tableId: table.id, name: "order_date", dataType: "date", role: "dimension", nullable: false },
    { id: "data-column:orders:status", tableId: table.id, name: "status", dataType: "string", role: "dimension", nullable: false },
    { id: "data-column:orders:amount", tableId: table.id, name: "amount", dataType: "number", role: "measure", nullable: false }
  ];
  const metric = {
    id: "metric:total_revenue",
    version: "metric-version",
    workspaceId: "default",
    name: "total_revenue",
    businessName: "Total Revenue",
    baseTableId: table.id,
    expression: "amount",
    aggregation: "sum",
    allowedDimensions: ["data-column:orders:order_date"],
    allowedFilters: ["data-column:orders:status"],
    sourceId: architectureSource.id
  };
  return { connections: [connection], tables: [table], columns, metrics: [metric], runs: [...queryRuns.values()] };
}

function structuredDataActionResult(input) {
  if (input.action === "catalog") return structuredCatalog();
  if (input.action === "register_connection") return structuredCatalog().connections[0];
  if (input.action === "upsert_table") return structuredCatalog().tables[0];
  if (input.action === "upsert_column") return structuredCatalog().columns[0];
  if (input.action === "upsert_metric") return structuredCatalog().metrics[0];
  if (input.action === "validate_sql") {
    const sql = String(input.sql ?? "");
    const readOnly = /^\s*select\b/i.test(sql);
    const hasExplicitLimit = /\blimit\s+\d+\b/i.test(sql);
    const reasons = [];
    if (!readOnly) reasons.push("Only SELECT statements are allowed.");
    if (!hasExplicitLimit) reasons.push("A row-limited query must include an explicit LIMIT.");
    return { valid: reasons.length === 0, readOnly, hasExplicitLimit, reasons, sqlHash: "sql-hash:playwright" };
  }
  if (input.action === "plan_query") {
    const catalog = structuredCatalog();
    const id = `query-run:playwright-${queryRunSeq++}`;
    const timestamp = now();
    const metricName = String(input.plan?.metricName ?? "total_revenue");
    const isOrdersMetric = metricName === "orders";
    const run = {
      id,
      version: "query-run-version",
      workspaceId: "default",
      dataConnectionId: catalog.connections[0].id,
      principalId: "system",
      status: "planned",
      sql: isOrdersMetric
        ? 'SELECT count(*) AS "orders" FROM "public"."orders" WHERE "status" = $1 LIMIT 50'
        : 'SELECT "order_date" AS "order_date", sum("amount") AS "total_revenue" FROM "public"."orders" WHERE "status" = $1 GROUP BY "order_date" LIMIT 50',
      sqlHash: `sql-hash:playwright:${metricName}`,
      semanticInputs: [`metric:${metricName}`, "data-column:orders:order_date", "data-column:orders:status"],
      parameters: ["paid"],
      sourceIds: [architectureSource.id],
      rowLimit: 50,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    queryRuns.set(id, run);
    return {
      queryRun: run,
      metric: isOrdersMetric
        ? { ...catalog.metrics[0], id: "metric:orders", name: "orders", businessName: "Order Count", aggregation: "count" }
        : catalog.metrics[0],
      table: catalog.tables[0],
      dimensions: [catalog.columns[1]],
      filters: [{ columnId: "data-column:orders:status", op: "eq", value: "paid" }],
      validation: { valid: true, readOnly: true, hasExplicitLimit: true, reasons: [], sqlHash: run.sqlHash },
      rowCapWarning: "Requested limit 200 exceeds row cap 50; using 50."
    };
  }
  if (input.action === "approve_query") {
    const run = queryRuns.get(input.queryRunId);
    if (!run) return { error: `Unknown query run "${input.queryRunId}".` };
    const approved = { ...run, status: "approved", approvalTokenHash: "approval-token-hash", updatedAt: now() };
    queryRuns.set(run.id, approved);
    return { queryRun: approved, approvalToken: `approval-token:${run.id}` };
  }
  if (input.action === "execute_query") {
    const run = queryRuns.get(input.queryRunId);
    if (!run) return { error: `Unknown query run "${input.queryRunId}".` };
    if (input.approvalToken !== `approval-token:${run.id}`) return { error: "Invalid approval token for query execution." };
    const executedAt = now();
    const succeeded = {
      ...run,
      status: "succeeded",
      rowCount: 1,
      executedAt,
      updatedAt: executedAt,
      resultSourceId: `source:query-result:${run.id}`
    };
    queryRuns.set(run.id, succeeded);
    return {
      run: succeeded,
      rows: [{ order_date: "2026-07-03", total_revenue: 1234 }],
      fields: ["order_date", "total_revenue"],
      citation: {
        sourceId: succeeded.resultSourceId,
        text: `Query ${run.id} executed at ${executedAt}. Source tables/metrics: ${run.sourceIds.join(", ")}`
      }
    };
  }
  if (input.action === "runs") return { runs: [...queryRuns.values()] };
  return { error: `Unknown structured_data_action "${input.action}".` };
}

function harnessQueryMatches(record, query) {
  const where = query?.where;
  if (!where || where.op !== "eq" || !where.field) return true;
  return record?.[where.field] === where.value;
}

function harnessWorkflowSlug(value) {
  return String(value || "compiled-followup").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "compiled-followup";
}

function workflowActionResult(input) {
  if (input.action === "compile") {
    const sequence = workflowCompilationSeq++;
    const workspaceId = input.workspaceId ?? input.compile?.workspaceId ?? "default";
    const name = input.name ?? input.compile?.name ?? "Compiled Followup";
    const purpose = input.purpose ?? input.transcript ?? input.compile?.purpose ?? input.compile?.transcript ?? "Compiled governed workflow.";
    const sourceIds = input.sourceIds ?? input.compile?.sourceIds ?? [architectureSource.id];
    const toolCalls = input.toolCalls ?? input.compile?.toolCalls ?? [{ toolName: "file_broker_action", capability: "write", sourceIds }];
    const toolNames = toolCalls.map(call => call.toolName).filter(Boolean);
    const riskLevel = input.riskLevel ?? input.compile?.riskLevel ?? "high";
    const workflowId = `workflow:${harnessWorkflowSlug(name)}-${sequence}`;
    const workflowVersion = `workflow-version:${harnessWorkflowSlug(name)}-${sequence}`;
    const compilationId = `workflow-compilation:playwright-${sequence}`;
    const timestamp = now();
    const approvalGates = input.approvalGates ?? input.compile?.approvalGates ?? [
      { id: "approve-action", type: "action" },
      ...(riskLevel === "high" || riskLevel === "critical"
        ? [{ id: "structured-expert-review", type: "expert_review", requiredRiskLevel: "high" }]
        : [])
    ];
    const proposedActions = toolCalls.map((call, index) => ({
      id: `action:compiled-${sequence}-${index + 1}`,
      toolName: call.toolName,
      capability: call.capability ?? "read",
      status: "proposed",
      requiresApproval: call.capability === "write" || call.capability === "admin",
      sourceIds: call.sourceIds ?? sourceIds,
      reason: call.reason,
      input: call.input ?? {}
    }));
    const definition = {
      id: workflowId,
      version: workflowVersion,
      workspaceId,
      name,
      description: purpose,
      riskLevel,
      inputSchema: { type: "object", additionalProperties: true },
      approvalGates,
      allowedSourceIds: sourceIds,
      allowedConnectorInstanceIds: toolCalls.map(call => call.connectorInstanceId).filter(Boolean),
      allowedTools: toolNames,
      requiredEvidence: sourceIds.length ? [{ name: "compiled-evidence", minCitations: sourceIds.length }] : [],
      successMetrics: input.successMetrics ?? input.compile?.successMetrics ?? ["run completed"],
      dryRunDefault: true,
      tests: []
    };
    const publish = input.publish ?? input.compile?.publish ?? false;
    const runDry = input.dryRun ?? input.compile?.dryRun ?? false;
    let dryRun;
    if (runDry) {
      const runId = `workflow-run:compiled-${workflowRunSeq++}`;
      dryRun = {
        id: runId,
        version: "run-version-1",
        workflowId,
        workflowVersion,
        workspaceId,
        principalId: "principal:playwright",
        mode: "dry_run",
        status: "succeeded",
        inputs: input.sampleInputs ?? input.compile?.sampleInputs ?? {},
        evidenceSourceIds: sourceIds,
        evidenceSourceVersions: sourceIds.map(sourceId => ({ sourceId, sourceVersionId: architectureSourceVersion.id, healthState: "unhealthy", stalenessState: "stale" })),
        proposedActions,
        executedActions: [],
        labels: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      workflowRuns.set(runId, dryRun);
    }
    const compilation = {
      id: compilationId,
      version: "compilation-version-1",
      workspaceId,
      status: runDry ? "dry_run_completed" : (publish ? "published" : "draft"),
      compilerVersion: "deterministic-workflow-compiler-v1",
      inputHash: `input-hash-${sequence}`,
      definition,
      validation: [],
      sourceIds,
      toolNames,
      proposedActions,
      sampleInputs: input.sampleInputs ?? input.compile?.sampleInputs ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(publish ? { workflowId, workflowVersion } : {}),
      ...(dryRun ? { dryRunId: dryRun.id } : {}),
      warnings: []
    };
    workflowCompilations.set(compilationId, compilation);
    return {
      compilation,
      definition,
      validation: [],
      ...(publish ? { published: { definition, version: { id: workflowVersion, workflowId, version: workflowVersion } } } : {}),
      ...(dryRun ? { dryRun } : {})
    };
  }
  if (input.action === "compilations") {
    return { compilations: [...workflowCompilations.values()].filter(item => harnessQueryMatches(item, input.query)) };
  }
  if (input.action === "get_compilation") return { compilation: workflowCompilations.get(input.compilationId) ?? null };
  if (input.action === "start" || input.action === "dry_run") {
    const runId = `workflow-run:playwright-${workflowRunSeq++}`;
    const mode = input.mode ?? (input.action === "dry_run" ? "dry_run" : "approval_gated");
    const timestamp = now();
    const sourceIds = input.evidenceSourceIds ?? [architectureSource.id];
    const run = {
      id: runId,
      version: "run-version-1",
      workflowId: input.workflowId ?? "workflow:compiled-followup",
      workflowVersion: input.workflowVersion ?? "workflow-version:compiled-followup",
      workspaceId: input.workspaceId ?? "default",
      principalId: "principal:playwright",
      mode,
      status: mode === "dry_run" || mode === "shadow" ? "succeeded" : "waiting_for_approval",
      inputs: input.inputs ?? {},
      evidenceSourceIds: sourceIds,
      evidenceSourceVersions: sourceIds.map(sourceId => ({ sourceId, sourceVersionId: architectureSourceVersion.id, healthState: "unhealthy", stalenessState: "stale" })),
      proposedActions: input.proposedActions?.length ? input.proposedActions.map((action, index) => ({
        id: action.id ?? `action:playwright-${index + 1}`,
        toolName: action.toolName,
        capability: action.capability ?? "write",
        status: "proposed",
        requiresApproval: action.requiresApproval ?? true,
        sourceIds: action.sourceIds ?? sourceIds,
        input: action.input ?? {},
        reason: action.reason
      })) : [{ id: "action:playwright-write", toolName: "file_broker_action", capability: "write", status: "proposed", requiresApproval: true, sourceIds, input: {} }],
      executedActions: [],
      labels: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    workflowRuns.set(runId, run);
    if (run.status === "waiting_for_approval") {
      workflowApprovals.set(runId, [
        { id: "approval:action", version: "approval-version-1", runId, workflowId: run.workflowId, gateId: "approve-action", status: "pending", requestedAt: timestamp, updatedAt: timestamp, reason: "Write/admin tool requires approval." },
        { id: "approval:expert-review", version: "approval-version-1", runId, workflowId: run.workflowId, gateId: "structured-expert-review", status: "pending", requestedAt: timestamp, updatedAt: timestamp, reason: "High-risk workflow requires structured expert review." }
      ]);
    }
    return run;
  }
  if (input.action === "list_approvals") return { approvals: [...workflowApprovals.values()].flat().filter(item => harnessQueryMatches(item, input.query)) };
  if (input.action === "approve" || input.action === "reject") {
    const approvals = workflowApprovals.get(input.runId) ?? [];
    if (!approvals.length) return { error: `Unknown workflow run "${input.runId}".` };
    const targetIds = input.approvalId ? new Set([input.approvalId]) : new Set(approvals.map(approval => approval.id));
    const status = input.action === "approve" ? "approved" : "rejected";
    const decidedAt = now();
    const updatedApprovals = approvals.map(approval =>
      targetIds.has(approval.id) ? { ...approval, status, decidedAt, updatedAt: decidedAt, decidedByPrincipalId: "principal:playwright", reason: input.reason ?? approval.reason } : approval
    );
    workflowApprovals.set(input.runId, updatedApprovals);
    const run = workflowRuns.get(input.runId);
    if (run) {
      const hasPending = updatedApprovals.some(approval => approval.status === "pending");
      const hasRejected = updatedApprovals.some(approval => approval.status === "rejected");
      workflowRuns.set(input.runId, { ...run, status: hasPending ? "waiting_for_approval" : (hasRejected ? "failed" : "succeeded"), updatedAt: decidedAt });
    }
    return { run: workflowRuns.get(input.runId) ?? null, approvals: updatedApprovals.filter(approval => targetIds.has(approval.id)) };
  }
  if (input.action === "inspect_run") {
    const run = workflowRuns.get(input.runId) ?? null;
    const approvals = workflowApprovals.get(input.runId) ?? [];
    return {
      run,
      events: run ? [
        { id: `event:${run.id}:created`, version: "event-version-1", runId: run.id, sequence: 1, eventType: "run_created", timestamp: run.createdAt, principalId: run.principalId, payload: { mode: run.mode } },
        { id: `event:${run.id}:evidence`, version: "event-version-1", runId: run.id, sequence: 2, eventType: approvals.length ? "approval_requested" : "run_completed", timestamp: run.updatedAt, principalId: run.principalId, sourceIds: run.evidenceSourceIds, payload: { status: run.status } }
      ] : [],
      approvals
    };
  }
  if (input.action === "compare_shadow_result" || input.action === "label_shadow_result") {
    const run = workflowRuns.get(input.runId);
    if (!run) return { error: `Unknown workflow run "${input.runId}".` };
    const labels = input.labels ?? (input.label ? [input.label] : ["accepted"]);
    const normalized = labels.map(label => String(label).toLowerCase());
    const outcome = normalized.includes("mixed") ? "mixed" : normalized.some(label => label.includes("reject")) ? "rejected" : normalized.some(label => label.includes("accept")) ? "accepted" : "unlabeled";
    const score = outcome === "accepted" ? 1 : outcome === "mixed" ? 0.5 : 0;
    const timestamp = now();
    const comparison = {
      id: `shadow-comparison:${input.runId}`,
      version: "shadow-comparison-version-1",
      runId: input.runId,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      workspaceId: run.workspaceId,
      principalId: run.principalId,
      outcome,
      score,
      humanLabels: labels,
      proposedActionIds: run.proposedActions.map(action => action.id),
      proposedToolNames: run.proposedActions.map(action => action.toolName),
      sourceIds: run.evidenceSourceIds,
      recommendationHash: `shadow-recommendation-hash:${run.id}`,
      comparedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      note: input.note
    };
    workflowShadowComparisons.set(run.id, comparison);
    const updatedRun = { ...run, labels, updatedAt: timestamp };
    workflowRuns.set(run.id, updatedRun);
    return { run: updatedRun, comparison };
  }
  if (input.action === "shadow_report") {
    const comparisons = [...workflowShadowComparisons.values()].filter(item => harnessQueryMatches(item, input.query));
    const count = outcome => comparisons.filter(item => item.outcome === outcome).length;
    const accepted = count("accepted");
    const byWorkflow = [...new Set(comparisons.map(item => item.workflowId))].map(workflowId => {
      const records = comparisons.filter(item => item.workflowId === workflowId);
      const acceptedForWorkflow = records.filter(item => item.outcome === "accepted").length;
      return { workflowId, total: records.length, accepted: acceptedForWorkflow, rejected: records.filter(item => item.outcome === "rejected").length, mixed: records.filter(item => item.outcome === "mixed").length, unlabeled: records.filter(item => item.outcome === "unlabeled").length, acceptanceRate: records.length ? acceptedForWorkflow / records.length : 0 };
    });
    return { summary: { total: comparisons.length, accepted, rejected: count("rejected"), mixed: count("mixed"), unlabeled: count("unlabeled"), acceptanceRate: comparisons.length ? accepted / comparisons.length : 0, byWorkflow }, comparisons };
  }
  if (input.action === "list_runs") return { runs: [...workflowRuns.values()].filter(item => harnessQueryMatches(item, input.query)) };
  return { error: `Unknown workflow_action "${input.action}".` };
}

function evaluationActionResult(input) {
  const traces = [...evaluationTraces.values()].filter(item => harnessQueryMatches(item, input.query));
  const suites = [...evaluationSuites.values()].filter(item => harnessQueryMatches(item, input.query));
  const runs = [...evaluationRuns.values()].filter(item => harnessQueryMatches(item, input.query));
  if (input.action === "traces") return { traces };
  if (input.action === "inspect_trace") {
    const trace = evaluationTraces.get(input.traceId) ?? null;
    if (!trace) return { error: `Unknown trace "${input.traceId}".` };
    return {
      trace,
      spans: [
        { id: "span:agent", spanId: "span:agent", traceId: trace.traceId, kind: "agent", name: "matbot.turn", status: "ok", startedAt: trace.startedAt, durationMs: 1250, attributes: {} },
        { id: "span:llm", spanId: "span:llm", traceId: trace.traceId, parentSpanId: "span:agent", kind: "llm", name: "gen_ai.chat", status: "ok", startedAt: trace.startedAt, durationMs: 640, attributes: { inputTokens: 850, outputTokens: 120, costUsd: 0.032 } },
        { id: "span:retrieval", spanId: "span:retrieval", traceId: trace.traceId, parentSpanId: "span:agent", kind: "retriever", name: "workspace_rag.search", status: "ok", startedAt: trace.startedAt, durationMs: 90, attributes: { retrievedSourceIds: [architectureSource.id] } },
        { id: "span:policy", spanId: "span:policy", traceId: trace.traceId, parentSpanId: "span:agent", kind: "guardrail", name: "connector.policy", status: "ok", startedAt: trace.startedAt, durationMs: 2, attributes: { policyOutcome: "allowed" } },
        { id: "span:tool", spanId: "span:tool", traceId: trace.traceId, parentSpanId: "span:agent", kind: "tool", name: "workflow_action", status: "ok", startedAt: trace.startedAt, durationMs: 130, attributes: {} }
      ],
      events: [],
      scores: []
    };
  }
  if (input.action === "replay") {
    if (!evaluationTraces.has(input.traceId)) return { error: `Unknown trace "${input.traceId}".` };
    return { mode: "playback", writesExecuted: false, trace: evaluationTraces.get(input.traceId), timeline: [{ phase: "start" }, { phase: "end" }] };
  }
  if (input.action === "suites") return { suites };
  if (input.action === "evaluation_runs") return { runs };
  if (input.action === "run_suite") {
    const suite = evaluationSuites.get(input.suiteId);
    if (!suite) return { error: `Unknown evaluation suite "${input.suiteId}".` };
    const id = `eval-run:webui-${evaluationRuns.size + 1}`;
    const run = { id, version: `${id}:v1`, suiteId: suite.id, suiteVersion: suite.version, workspaceId: suite.workspaceId, candidate: input.candidate ?? "webui", status: "completed", passed: true, score: 0.97, passRate: 1, caseCount: suite.caseIds.length, startedAt: now(), updatedAt: now(), finishedAt: now(), traceId: `trace:${id}` };
    evaluationRuns.set(id, run);
    return { run, results: suite.scorerIds.map((scorerId, index) => ({ id: `${id}:score:${index}`, scorerId, passed: true, score: 0.97, rationale: "Harness scorer passed." })) };
  }
  if (input.action === "metrics") return {
    traces: { total: traces.length, completed: traces.length, errors: 0 },
    tokens: { input: 850, output: 120 }, costUsd: 0.032,
    latencyMs: { average: 1250, p50: 1250, p95: 1250, p99: 1250 }, spans: { agent: 1, llm: 1, retriever: 1, guardrail: 1, tool: 1 },
    retrieval: { operations: 1, averageLatencyMs: 90, scoredResults: 2, averageScore: 0.94 },
    citations: { resolved: 1, tracesWithCitations: 1, coverageRate: 1 },
    actions: { attempted: 1, succeeded: 1, failed: 0, successRate: 1 },
    policy: { decisions: 1, denied: 0, denyRate: 0 },
    workflows: { outcomes: 4, verifiedCompleted: 3, failed: 0, escalated: 1, completionRate: 0.75, escalationRate: 0.25, approvalsRequested: 4, approvalsApproved: 3, approvalsRejected: 1, approvalRate: 0.75, averageApprovalWaitMs: 60000 },
    evaluations: { runs: runs.length, passed: runs.filter(run => run.passed).length, passRate: runs.length ? runs.filter(run => run.passed).length / runs.length : 0 }
  };
  if (input.action === "roi") return {
    workspaceId: input.workspaceId ?? "default", verifiedOutcomes: 3, timeSavedHours: 12.5, laborBenefitUsd: 1500, additionalValueUsd: 300,
    operatingCostUsd: 35, fixedCostUsd: 200, totalBenefitUsd: 1800, netBenefitUsd: 1565, roi: 6.6596, paybackOutcomes: 0.39,
    byWorkflow: [{ workflowId: "workflow:invoice-review", verifiedOutcomes: 3, timeSavedHours: 12.5, benefitUsd: 1800 }]
  };
  return { error: `Unknown evaluation_action "${input.action}".` };
}

function contextGraphActionResult(input) {
  const entity = {
    id: "context-entity:acme",
    version: "context-entity-version",
    workspaceId: "default",
    type: "organization",
    canonicalName: "Acme Corp",
    aliases: ["Acme"],
    identifiers: {},
    sensitivity: "internal",
    createdAt: now(),
    updatedAt: now()
  };
  const relationship = {
    id: "context-relationship:acme-ticket",
    version: "context-relationship-version",
    workspaceId: "default",
    subjectEntityId: entity.id,
    predicate: "mentioned_in",
    objectEntityId: "context-entity:ticket-123",
    sourceId: architectureSource.id,
    sourceVersionId: architectureSourceVersion.id,
    confidence: 0.9,
    extractionMethod: "deterministic",
    evidenceSpan: "Acme ticket follow-up",
    createdAt: now(),
    updatedAt: now()
  };
  if (input.action === "retrieve" || input.action === "neighbors" || input.action === "path_search") {
    return {
      entities: [entity],
      facts: [{
        relationship,
        subject: entity,
        object: { ...entity, id: "context-entity:ticket-123", canonicalName: "Ticket 123", type: "artifact" },
        sourceId: architectureSource.id,
        sourceVersionId: architectureSourceVersion.id,
        citation: sourceCitation()
      }],
      warnings: []
    };
  }
  if (input.action === "projection_log") {
    return { operations: [{ id: "projection:acme", operationType: "merge_relationship", workspaceId: "default", sourceId: architectureSource.id }] };
  }
  if (input.action === "list") return { entities: [entity], relationships: [relationship] };
  if (input.action === "upsert_entity") return input.entity ?? entity;
  if (input.action === "assert_relationship") return input.relationship ?? relationship;
  return { error: `Unknown context_graph_action "${input.action}".` };
}

function expertPanelReviewResult(input) {
  const panel = expertPanelResult(input);
  if (panel.error) return panel;
  const id = `expert-review:playwright-${expertReviewSeq++}`;
  const experts = panel.result.experts.map(opinion => ({
    ...opinion,
    recommendation: "approve_with_changes",
    confidence: 0.81,
    evidenceIds: opinion.citations.map(citation => citation.id),
    risks: [`${opinion.title}: stale source may affect the decision.`],
    blockers: [],
    mitigations: [`${opinion.title}: refresh source before automation.`],
    approvalChecklist: [`${opinion.title}: evidence reviewed`, `${opinion.title}: automation rollback path confirmed`]
  }));
  const review = {
    id,
    version: "expert-review-version",
    createdAt: now(),
    updatedAt: now(),
    workspaceId: input.workspaceId ?? activeHarnessWorkspaceId(),
    question: input.question,
    mode: input.mode ?? "review",
    reviewMode: input.reviewMode ?? "pre_automation_review",
    targetType: input.targetType ?? "workflow",
    status: "under_review",
    expertIds: experts.map(expert => expert.expertId),
    experts,
    sourceIds: [architectureSource.id],
    consensus: ["Experts returned mixed implementation cautions."],
    disagreements: [],
    blockers: [],
    mitigations: experts.flatMap(expert => expert.mitigations),
    approvalChecklist: experts.flatMap(expert => expert.approvalChecklist),
    riskRegister: experts.map((expert, index) => ({
      id: `risk:${index}`,
      severity: "medium",
      description: expert.risks[0],
      ownerExpertId: expert.expertId,
      mitigation: expert.mitigations[0]
    })),
    synthesis: panel.result.synthesis,
    targetId: input.targetId,
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    dossierId: input.dossierId
  };
  expertReviews.set(id, review);
  return { result: { review, panel: panel.result } };
}

const server = createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: String(error) });
    else res.end();
  }
});

const memoryBrowserServer = createServer(async (req, res) => {
  try {
    await handleMemoryBrowser(req, res);
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: String(error) });
    else res.end();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`matbot webui test harness -> http://127.0.0.1:${port}`);
});

memoryBrowserServer.listen(memoryBrowserPort, "127.0.0.1", () => {
  console.log(`memory browser test harness -> ${memoryBrowserUrl}`);
});

function shutdown() {
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(0);
  };
  server.close(done);
  memoryBrowserServer.close(done);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function handle(req, res) {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (method === "OPTIONS") return void res.writeHead(204).end();

  if (method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok" });
  if (method === "POST" && url.pathname === "/__test/reset-memory") {
    for (const run of runningTurns.values()) run.aborted = true;
    sessions.clear();
    hidden.clear();
    busy.clear();
    pendingPrompts.clear();
    runningTurns.clear();
    queuedTurns.clear();
    sessionSeq = 1;
    traceSeq = 1;
    sessions.set("s0", {
      id: "s0",
      version: "v1",
      status: "active",
      title: "Conversation s0",
      workspaceId: "default",
      messages: [],
      contexts: [],
      createdAt: now(),
      updatedAt: now()
    });
    workspaces.splice(0, workspaces.length, {
      id: "default",
      name: "Default",
      configPath: "matbot.yaml",
      createdAt: now(),
      updatedAt: now(),
      active: true
    });
    workspaceSeq = 1;
    rememberedFactsByWorkspace.clear();
    rememberedFactSeq = 1;
    filesByWorkspace.clear();
    skillsByWorkspace.clear();
    triggersByWorkspace.clear();
    loadedPluginsByWorkspace.clear();
    providersByWorkspace.clear();
    workspaceRagStateByWorkspace.clear();
    workspaceRagConfig = {
      activeContextId: "default",
      contexts: [{ id: "default", name: "Default", paths: ["C:\\Projects\\Cortex\\docs"] }]
    };
    workspaceRagStatus = {
      workspaceId: "default",
      contextName: "Default",
      paths: activeRagContext().paths,
      state: "idle",
      totalFiles: 2,
      processedFiles: 2,
      percent: 100,
      message: "Indexed 2 markdown file(s).",
      nvidiaAvailable: false,
      cudaAvailable: false,
      accelerated: false,
      accelerator: "cpu",
      embeddingBackend: "hash-cpu",
      embeddingModel: "token-hash-v1",
      embeddingDimensions: 384,
      accelerationMessage: "Using CPU hash vectorizer.",
      storageBackend: "json",
      storageMessage: "Legacy JSON workspace RAG storage active."
    };
    persistWorkspaceRagState("default");
    queryRuns.clear();
    queryRunSeq = 1;
    workflowCompilations.clear();
    workflowRuns.clear();
    workflowApprovals.clear();
    workflowShadowComparisons.clear();
    workflowRunSeq = 1;
    workflowCompilationSeq = 1;
    expertReviews.clear();
    expertReviewSeq = 1;
    seedEvaluationData();
    return json(res, 200, { ok: true });
  }
  const testSessionEvent = /^\/__test\/sessions\/([^/]+)\/event$/.exec(url.pathname);
  if (method === "POST" && testSessionEvent) {
    const sessionId = decodeURIComponent(testSessionEvent[1]);
    const body = await readJson(req);
    sendSession(sessionId, String(body.event ?? "text-delta"), body.data ?? {});
    return json(res, 200, { ok: true, sessionId });
  }
  const testWorkspaceState = /^\/__test\/workspaces\/([^/]+)\/state$/.exec(url.pathname);
  if (method === "GET" && testWorkspaceState) {
    const id = decodeURIComponent(testWorkspaceState[1]);
    return json(res, 200, {
      exists: workspaces.some(workspace => workspace.id === id),
      sessions: [...sessions.values()].filter(session => session.workspaceId === id).length,
      files: filesByWorkspace.get(id)?.size ?? 0,
      skills: skillsByWorkspace.get(id)?.size ?? 0,
      memories: rememberedFactsByWorkspace.get(id)?.size ?? 0,
      hasRagState: workspaceRagStateByWorkspace.has(id),
      hasPluginState: loadedPluginsByWorkspace.has(id),
      hasProviderState: providersByWorkspace.has(id)
    });
  }
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

  const testWorkspaceProviders = /^\/__test\/workspaces\/([^/]+)\/providers$/.exec(url.pathname);
  if (method === "POST" && testWorkspaceProviders) {
    const id = decodeURIComponent(testWorkspaceProviders[1]);
    if (!workspaces.some(workspace => workspace.id === id)) {
      return json(res, 404, { error: "Workspace not found" });
    }
    const body = await readJson(req);
    if (!Array.isArray(body.providers) || body.providers.some(provider => typeof provider !== "string" || !provider.trim())) {
      return json(res, 400, { error: '"providers" must contain non-empty strings.' });
    }
    providersByWorkspace.set(id, body.providers.map(provider => provider.trim()));
    return json(res, 200, { workspaceId: id, providers: providersForWorkspace(id) });
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
    persistWorkspaceRagState();
    for (const item of workspaces) item.active = item.id === id;
    restoreWorkspaceRagState(id, workspace.name);
    return json(res, 200, { active: id, restarting: true });
  }

  const workspaceDeleteCheck = /^\/workspaces\/([^/]+)\/delete-check$/.exec(url.pathname);
  if (method === "GET" && workspaceDeleteCheck) {
    const id = decodeURIComponent(workspaceDeleteCheck[1]);
    const workspace = workspaces.find(item => item.id === id);
    if (!workspace) return json(res, 404, { error: "Workspace not found" });
    if (workspace.active) return json(res, 409, { error: "Cannot delete the active workspace" });
    return json(res, 200, { ok: true, workspaceId: id });
  }

  const workspaceDelete = /^\/workspaces\/([^/]+)$/.exec(url.pathname);
  if (method === "DELETE" && workspaceDelete) {
    const id = decodeURIComponent(workspaceDelete[1]);
    const index = workspaces.findIndex(item => item.id === id);
    if (index < 0) return json(res, 404, { error: "Workspace not found" });
    if (workspaces[index].active) return json(res, 409, { error: "Cannot delete the active workspace" });
    rememberedFactsByWorkspace.delete(id);
    filesByWorkspace.delete(id);
    skillsByWorkspace.delete(id);
    triggersByWorkspace.delete(id);
    loadedPluginsByWorkspace.delete(id);
    providersByWorkspace.delete(id);
    workspaceRagStateByWorkspace.delete(id);
    for (const [sessionId, session] of sessions) {
      if (session.workspaceId === id) {
        sessions.delete(sessionId);
        hidden.delete(sessionId);
      }
    }
    for (const [reviewId, review] of expertReviews) {
      if (review.workspaceId === id) expertReviews.delete(reviewId);
    }
    workspaces.splice(index, 1);
    return json(res, 200, { ok: true, deleted: id });
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
      workspaceId: activeHarnessWorkspaceId(),
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
    const sessionFiles = filesForWorkspace(session.workspaceId);
    if (body.attachments !== undefined) {
      if (!Array.isArray(body.attachments)) return json(res, 400, { error: '"attachments" must be an array.' });
      if (body.attachments.length > 20) return json(res, 400, { error: "A message can attach at most 20 workspace files." });
      for (const attachment of body.attachments) {
        if (!attachment || attachment.namespace !== "workspace" || typeof attachment.path !== "string") {
          return json(res, 400, { error: 'Each attachment must identify a workspace file with { namespace: "workspace", path }.' });
        }
        if (!sessionFiles.has(attachment.path)) {
          return json(res, 400, { error: `Workspace attachment not found: ${JSON.stringify(attachment.path)}.` });
        }
      }
    }
    if (busy.get(sessionId)) {
      const queue = queuedTurnsForSession(sessionId);
      queue.push({ traceId, body });
      await waitForSessionStream(sessionId);
      const content = typeof body.content === "string" ? [{ type: "text", text: body.content }] : [body.content];
      sendSession(sessionId, "queued", {
        type: "queued",
        content,
        queued: queue.length,
        concatQueue: body.concatQueue === true,
        traceId,
        rootTraceId: traceId
      });
      return json(res, 200, { queued: queue.length, traceId });
    }
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
    const queue = queuedTurnsForSession(sessionId);
    for (const queued of queue.splice(0)) {
      sendSession(sessionId, "cancelled", {
        type: "cancelled",
        reason: "user-abort",
        session: sessions.get(sessionId),
        traceId: queued.traceId
      });
    }
    setBusy(sessionId, false);
    return json(res, 200, { ok: true });
  }

  const testSessionComplete = /^\/__test\/sessions\/([^/]+)\/complete$/.exec(url.pathname);
  if (method === "POST" && testSessionComplete) {
    const sessionId = decodeURIComponent(testSessionComplete[1]);
    const session = sessions.get(sessionId);
    if (!session) return json(res, 404, { error: "session not found" });
    const body = await readJson(req);
    const running = runningTurns.get(sessionId);
    const traceId = running?.traceId ?? String(body.traceId ?? `test-complete-${Date.now()}`);
    const text = String(body.text ?? "Recovered terminal response.");
    if (!session.messages.some(message => message.role === "assistant" && message.traceId === traceId)) {
      session.messages.push({
        id: `m-${traceId}-a`,
        traceId,
        role: "assistant",
        content: [{ type: "text", text }],
        createdAt: now()
      });
    }
    session.updatedAt = now();
    runningTurns.delete(sessionId);
    setBusy(sessionId, false);
    sendSession(sessionId, "done", { type: "done", session, traceId });
    return json(res, 200, { ok: true, traceId });
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
    const data = filesForWorkspace().get(name);
    if (!data) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return void res.end(data);
  }

  json(res, 404, { error: "Not found" });
}

async function handleMemoryBrowser(req, res) {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", memoryBrowserUrl);
  const rememberedFacts = rememberedFactsForWorkspace();
  if (method === "GET" && url.pathname === "/") return memoryBrowserFile(res, "text/html; charset=utf-8", "index.html");
  if (method === "GET" && url.pathname === "/app.js") return memoryBrowserFile(res, "application/javascript; charset=utf-8", "app.js");
  if (method === "GET" && url.pathname === "/style.css") return memoryBrowserFile(res, "text/css; charset=utf-8", "style.css");
  if (method === "GET" && url.pathname === "/api/health") return json(res, 200, { status: "ok" });

  if (method === "GET" && url.pathname === "/api/memories") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const state = url.searchParams.get("state") ?? "all";
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0);
    let items = [...rememberedFacts.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (q) items = items.filter(item => String(item.fact ?? "").toLowerCase().includes(q));
    if (state === "unprocessed") items = items.filter(item => !item.dreamSkill);
    if (state === "processed") items = items.filter(item => Boolean(item.dreamSkill));
    if (state === "ignored") items = items.filter(item => Boolean(item.ignoreUntil));
    const pageItems = items.slice(offset, offset + limit);
    const nextOffset = offset + pageItems.length;
    return json(res, 200, {
      items: pageItems,
      total: items.length,
      ...(nextOffset < items.length ? { cursor: String(nextOffset) } : {})
    });
  }

  if (method === "POST" && url.pathname === "/api/memories") {
    const input = await readJson(req);
    const fact = String(input.fact ?? "").trim();
    if (!fact) return json(res, 400, { error: '"fact" is required.' });
    const id = `fact-${rememberedFactSeq++}`;
    const doc = {
      id,
      version: "v1",
      fact,
      sessionId: String(input.sessionId ?? "manual"),
      messageId: String(input.messageId ?? "manual"),
      createdAt: now()
    };
    rememberedFacts.set(id, doc);
    return json(res, 201, doc);
  }

  const memoryMatch = /^\/api\/memories\/([^/]+)$/.exec(url.pathname);
  if (memoryMatch) {
    const id = decodeURIComponent(memoryMatch[1]);
    const current = rememberedFacts.get(id);
    if (method === "GET") return current ? json(res, 200, current) : json(res, 404, { error: "Memory not found." });

    if (method === "PATCH") {
      const input = await readJson(req);
      if (!current) return json(res, 404, { error: "Memory not found." });
      if (input.expected !== current.version) return json(res, 409, { error: "Version conflict.", current });
      const next = {
        ...current,
        version: `v${Date.now()}`,
        fact: String(input.fact ?? current.fact).trim()
      };
      if (!next.fact) return json(res, 400, { error: '"fact" must be a non-empty string.' });
      if (Object.hasOwn(input, "dreamSkill")) {
        if (input.dreamSkill === null || input.dreamSkill === "") delete next.dreamSkill;
        else next.dreamSkill = String(input.dreamSkill);
      }
      if (Object.hasOwn(input, "ignoreUntil")) {
        if (input.ignoreUntil === null || input.ignoreUntil === "") delete next.ignoreUntil;
        else next.ignoreUntil = String(input.ignoreUntil);
      }
      rememberedFacts.set(id, next);
      return json(res, 200, next);
    }

    if (method === "DELETE") {
      const input = await readJson(req);
      if (current && input.expected !== undefined && input.expected !== current.version) {
        return json(res, 200, { deleted: false });
      }
      const deleted = rememberedFacts.delete(id);
      return json(res, 200, { deleted });
    }
  }

  return json(res, 404, { error: "Not found" });
}

async function file(res, contentType, name) {
  const body = await readFile(path.join(staticRoot, name), "utf8");
  res.writeHead(200, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function memoryBrowserFile(res, contentType, name) {
  const body = await readFile(path.join(memoryBrowserStaticRoot, name), "utf8");
  res.writeHead(200, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function handleTool(res, name, rawInput) {
  const invocation = unwrapToolInvocation(rawInput);
  const input = invocation.input ?? {};
  const context = invocation.context;
  const rememberedFacts = rememberedFactsForWorkspace(
    context.sessionId ? sessionWorkspaceId(context.sessionId) : activeHarnessWorkspaceId()
  );

  if (name === "provider") {
    return json(res, 200, { providers: providersForWorkspace().map(name => ({ name })) });
  }
  if (name === "open_memory_browser") {
    return json(res, 200, { url: memoryBrowserUrl });
  }
  if (name === "session_action") {
    if (input.action === "list") {
      return json(res, 200, [...sessions.values()]
        .filter(session => session.workspaceId === activeHarnessWorkspaceId())
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
    const files = filesForWorkspace(context.sessionId ? sessionWorkspaceId(context.sessionId) : activeHarnessWorkspaceId());
    if (input.action === "list") {
      return json(res, 200, [...files.entries()].map(([fileName, buffer]) => ({ path: fileName, size: buffer.byteLength })));
    }
    if (input.action === "read") {
      const content = files.get(input.path);
      if (!content) return json(res, 404, { error: `Workspace file not found: ${input.path}` });
      return json(res, 200, content.toString(input.encoding === "base64" ? "base64" : "utf8"));
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
  if (name === "powershell") {
    return json(res, 200, {
      exitCode: 0,
      stdout: [
        `script=${input.script ?? ""}`,
        `cwd=${input.cwd ?? ""}`,
        `env=${input.env?.MATBOT_PS_TEST ?? ""}`
      ].join("\n"),
      stderr: "",
      invocation: {
        executable: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "<temp.ps1>"]
      }
    });
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
      setWorkspaceRagStatusForActive({ state: "idle", processedFiles: 3, totalFiles: 3, percent: 100, message: "Indexed 3 markdown file(s)." });
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
  if (name === "source_action") {
    const result = sourceActionResult(input);
    return json(res, result.error ? 400 : 200, result);
  }
  if (name === "source_health_action") {
    const result = sourceHealthActionResult(input);
    return json(res, result.error ? 400 : 200, result);
  }
  if (name === "connector_action") {
    const result = connectorActionResult(input);
    return json(res, result.error ? 400 : 200, result);
  }
  if (name === "structured_data_action") {
    const result = structuredDataActionResult(input);
    return json(res, result.error ? 400 : 200, result);
  }
  if (name === "workflow_action") {
    const result = workflowActionResult(input);
    return json(res, result.error ? 400 : 200, result);
  }
  if (name === "evaluation_action") {
    const result = evaluationActionResult(input);
    return json(res, result.error ? 400 : 200, result);
  }
  if (name === "context_graph_action") {
    const result = contextGraphActionResult(input);
    return json(res, result.error ? 400 : 200, result);
  }
  if (name === "remembered_facts_action") {
    if (input.action === "list") return json(res, 200, { facts: [...rememberedFacts.values()] });
    if (input.action === "query") return json(res, 200, queryRememberedFacts(input.query ?? {}, rememberedFacts));
    if (input.action === "get") return json(res, 200, rememberedFacts.get(input.id) ?? null);
    if (input.action === "set") {
      const id = input.id ? String(input.id) : `fact-${rememberedFactSeq++}`;
      const doc = rememberedFactFromData(id, input.data);
      if (!doc) return json(res, 400, { error: 'set requires data.fact.' });
      rememberedFacts.set(id, doc);
      return json(res, 200, doc);
    }
    if (input.action === "cas") {
      const current = rememberedFacts.get(input.id);
      if (!input.id) return json(res, 400, { error: 'cas requires "id".' });
      if (!input.expected) return json(res, 400, { error: 'cas requires "expected".' });
      if (!input.data) return json(res, 400, { error: 'cas requires "data".' });
      if (!current || current.version !== input.expected) {
        return json(res, 200, { ok: false, current: current ?? null });
      }
      const doc = rememberedFactFromData(input.id, input.data);
      if (!doc) return json(res, 400, { error: 'cas requires data.fact.' });
      rememberedFacts.set(input.id, doc);
      return json(res, 200, { ok: true, doc });
    }
    if (input.action === "delete") {
      const current = rememberedFacts.get(input.id);
      if (current && input.expected !== undefined && input.expected !== current.version) {
        return json(res, 200, { ok: true, deleted: false });
      }
      return json(res, 200, { ok: true, deleted: rememberedFacts.delete(input.id) });
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
    const workspaceId = context.sessionId ? sessionWorkspaceId(context.sessionId) : activeHarnessWorkspaceId();
    const loadedPlugins = loadedPluginsForWorkspace(workspaceId);
    if (input.action === "list") return json(res, 200, { loaded: loadedPlugins });
    if (input.action === "discover_local") return json(res, 200, localPlugins);
    if (input.action === "add") {
      const result = addLoadedPlugin(String(input.specifier ?? input.name ?? ""), workspaceId);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (input.action === "remove" || input.action === "unload") {
      const result = removeLoadedPlugin(String(input.specifier ?? input.name ?? ""), workspaceId);
      return json(res, result.ok ? 200 : 400, result);
    }
  }
  if (name === "expert_panel") {
    const workspaceId = context.sessionId ? sessionWorkspaceId(context.sessionId) : activeHarnessWorkspaceId();
    if (input.action === "list") return json(res, 200, { experts: expertConfigs });
    if (input.action === "get_review") {
      const review = expertReviews.get(input.reviewId);
      return json(res, 200, { review: review?.workspaceId === workspaceId ? review : null });
    }
    if (input.action === "list_reviews") {
      return json(res, 200, { reviews: [...expertReviews.values()].filter(review => review.workspaceId === workspaceId) });
    }
    if (input.action === "review") {
      const review = expertPanelReviewResult({ ...input, workspaceId });
      if (review.error) return json(res, 400, { error: review.error });
      return json(res, 200, review.result);
    }
    const panel = expertPanelResult(input);
    if (panel.error) return json(res, 400, { error: panel.error });
    return json(res, 200, panel.result);
  }
  if (name === "skill_action") {
    const skills = skillsForWorkspace(context.sessionId ? sessionWorkspaceId(context.sessionId) : activeHarnessWorkspaceId());
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
    const triggers = triggersForWorkspace(context.sessionId ? sessionWorkspaceId(context.sessionId) : activeHarnessWorkspaceId());
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
  const rememberedFacts = rememberedFactsForWorkspace(session?.workspaceId ?? activeHarnessWorkspaceId());
  const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content);
  const attachmentRefs = (body.attachments ?? []).map(attachment => ({
    type: "file-ref",
    fileId: `workspace:${attachment.path}`,
    name: attachment.path,
    mimeType: attachment.path.toLowerCase().endsWith(".md") ? "text/markdown" : "application/octet-stream"
  }));
  const userMessage = {
    id: `m-${traceId}-u`,
    traceId,
    role: "user",
    content: [
      ...(typeof body.content === "string" ? [{ type: "text", text: body.content }] : [body.content]),
      ...attachmentRefs
    ],
    createdAt: now(),
    ...(body.provider ? { providerName: body.provider } : {})
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
    const result = action === "add"
      ? addLoadedPlugin(specifier, session.workspaceId)
      : removeLoadedPlugin(specifier, session.workspaceId);
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

  const attachedReadme = attachmentRefs.find(ref => ref.name.toLowerCase() === "readme.md");
  if (attachedReadme && /read|summar/i.test(content)) {
    sendSession(sessionId, "marker", {
      type: "marker",
      content: [{
        type: "marker",
        creator: "workspace-rag",
        data: { hits: [{ path: "C:/RAG-test/README.md", score: 0.94 }] }
      }],
      traceId
    });
    await sleep(10);
    const callId = `call-${traceId}-workspace-read`;
    const input = { action: "read", path: attachedReadme.name };
    sendSession(sessionId, "tool:start", { type: "tool:start", callId, name: "workspace_action", input, traceId });
    await sleep(10);
    const fileContent = filesForWorkspace(session.workspaceId).get(attachedReadme.name)?.toString("utf8") ?? "";
    sendSession(sessionId, "tool:end", {
      type: "tool:end",
      callId,
      result: fileContent,
      isError: false,
      traceId
    });
    const assistantText = `Read attached workspace file ${attachedReadme.name} with workspace_action and summarized ${fileContent.length} characters.`;
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
    createdAt: now(),
    ...(body.provider ? { providerName: body.provider } : {})
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
