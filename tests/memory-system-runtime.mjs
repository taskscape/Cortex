import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

const { FilesystemStore } = await import("../local-agent/matbot/packages/plugins/storage/filesystem/src/store.ts");
const { createRememberFactTool } = await import("../local-agent/matbot/packages/plugins/cognition/src/remember/tool.ts");
const { createDreamTimeTool } = await import("../local-agent/matbot/packages/plugins/cognition/src/dream/tool.ts");
const { createMemoryBrowserServer } = await import("../local-agent/matbot/packages/plugins/memory-browser/src/index.ts");
const {
  createConstantPrincipalCarrier,
  installPrincipalCarrier,
} = await import("../local-agent/matbot/packages/core/plugin-api/src/index.ts");

const principal = { id: "memory-system-test", type: "user" };
installPrincipalCarrier(createConstantPrincipalCarrier(principal));

function deterministicProvider(req) {
  if (req.system?.includes("ranking judge")) {
    return {
      text: JSON.stringify({ scores: [{ skill: "User Profile", score: 95, why: "Production memory belongs in the profile." }] }),
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  if (req.system?.includes("merge stage")) {
    const current = /---begin current skill markdown---\n([\s\S]*?)\n---end current skill markdown---/.exec(req.prompt)?.[1] ?? "# User Profile";
    const fact = /Fact to merge[^\n]*:\n([\s\S]*?)\n\nReturn the complete updated markdown\./.exec(req.prompt)?.[1]?.trim() ?? "memory";
    return {
      text: JSON.stringify({ content: `${current}\n\n- ${fact}`, contradictions: [], anomalies: [] }),
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  const explicit = /Remember(?: this)?:\s*(.+)$/im.exec(req.prompt)?.[1]?.trim();
  const fact = explicit || req.prompt.trim();
  return {
    text: JSON.stringify([fact]),
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function createSkillManager() {
  let doc = {
    id: "skill-user-profile",
    version: "v1",
    name: "User Profile",
    content: "# User Profile\n",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    knowledge: {
      contentHash: "profile-hash",
      summary: "Stable facts about the user.",
      entities: ["user"],
      tags: ["personal"],
    },
  };
  return {
    list: () => [{ id: doc.id, name: doc.name }],
    get: name => name === doc.name ? doc : undefined,
    async save(name, content) {
      assert.equal(name, doc.name);
      doc = { ...doc, content, version: `${Date.now()}`, updatedAt: new Date().toISOString() };
      return doc;
    },
  };
}

function createWorkspaceServices(workspaceDir) {
  const stores = new Map();
  const settings = new Map();
  const createStore = namespace => {
    let store = stores.get(namespace);
    if (!store) {
      store = new FilesystemStore(path.join(workspaceDir, ".data", namespace));
      stores.set(namespace, store);
    }
    return store;
  };
  const services = {
    configPath: path.join(workspaceDir, "matbot.yaml"),
    providers: new Map([["fake", { name: "fake" }]]),
    createStore,
    singleTurn: async req => deterministicProvider(req),
    settings: () => ({
      get: async key => settings.get(key),
      set: async (key, value) => { settings.set(key, value); },
      delete: async key => { settings.delete(key); },
    }),
    SkillManager: createSkillManager(),
  };
  services.sessions = createStore("sessions");
  return services;
}

function sessionWithMessage(id, text) {
  const timestamp = new Date().toISOString();
  return {
    id,
    version: "v1",
    status: "active",
    title: id,
    contexts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [{
      id: `${id}-message`,
      traceId: `${id}-trace`,
      role: "user",
      content: [{ type: "text", text }],
      createdAt: timestamp,
    }],
  };
}

function toolContext(session) {
  return {
    callId: `call-${session.id}`,
    session,
    provider: "fake",
    signal: new AbortController().signal,
    vault: {},
    prompt: async () => "",
    loadPlugin: async () => { throw new Error("not used"); },
    unloadPlugin: async () => false,
  };
}

async function collect(tool, input, context) {
  const events = [];
  for await (const event of tool.executor.execute(input, context)) events.push(event);
  return events;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function browserJson(baseUrl, route, init) {
  const response = await fetch(`${baseUrl}${route}`, init);
  return { response, body: await response.json() };
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-memory-system-"));
  try {
    const alphaDir = path.join(root, "workspaces", "alpha");
    const betaDir = path.join(root, "workspaces", "beta");
    await Promise.all([mkdir(alphaDir, { recursive: true }), mkdir(betaDir, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(alphaDir, "matbot.yaml"), "plugins: []\n", "utf8"),
      writeFile(path.join(betaDir, "matbot.yaml"), "plugins: []\n", "utf8"),
    ]);

    const alpha = createWorkspaceServices(alphaDir);
    const beta = createWorkspaceServices(betaDir);
    const alphaSession = sessionWithMessage("alpha-session", "Remember this: Alpha production fact.");
    const betaSession = sessionWithMessage("beta-session", "Remember this: Beta production fact.");
    await alpha.sessions.set(alphaSession.id, alphaSession);
    await beta.sessions.set(betaSession.id, betaSession);

    const alphaRememberEvents = await collect(createRememberFactTool(alpha), {}, toolContext(alphaSession));
    assert.equal(alphaRememberEvents.at(-1)?.type, "marker");
    const alphaFacts = alpha.createStore("remembered_facts");
    const betaFacts = beta.createStore("remembered_facts");
    assert.deepEqual((await alphaFacts.query({})).items.map(item => item.fact), ["Alpha production fact."]);
    assert.equal((await betaFacts.query({})).total, 0);

    // Simulate a process restart: discard services and re-open the same workspace stores.
    const restartedAlpha = createWorkspaceServices(alphaDir);
    assert.deepEqual(
      (await restartedAlpha.createStore("remembered_facts").query({})).items.map(item => item.fact),
      ["Alpha production fact."],
    );

    await collect(createRememberFactTool(beta), {}, toolContext(betaSession));
    assert.deepEqual((await betaFacts.query({})).items.map(item => item.fact), ["Beta production fact."]);
    assert.deepEqual((await restartedAlpha.createStore("remembered_facts").query({})).items.map(item => item.fact), ["Alpha production fact."]);

    // Run the real dream_time tool. The fake provider replaces only ranking/merge judgement.
    const dreamEvents = await collect(createDreamTimeTool(restartedAlpha), {}, toolContext(alphaSession));
    const dreamResult = dreamEvents.find(event => event.type === "result")?.value;
    assert.equal(dreamResult?.outcome, "merged");
    assert.equal(dreamResult?.mergedFactIds.length, 1);
    const processedAlpha = (await restartedAlpha.createStore("remembered_facts").query({})).items[0];
    assert.equal(processedAlpha.dreamSkill, "User Profile");
    assert.equal((await betaFacts.query({})).items[0].dreamSkill, undefined);
    assert.equal((await restartedAlpha.createStore("dream_runs").query({})).total, 1);
    assert.equal((await beta.createStore("dream_runs").query({})).total, 0);

    // Exercise the production memory-browser server and optimistic CAS behavior.
    const alphaServer = createMemoryBrowserServer(restartedAlpha.createStore("remembered_facts"), principal);
    const alphaUrl = await listen(alphaServer);
    const alphaList = await browserJson(alphaUrl, "/api/memories");
    assert.equal(alphaList.response.status, 200);
    assert.equal(alphaList.body.total, 1);
    const alphaDoc = alphaList.body.items[0];

    const conflict = await browserJson(alphaUrl, `/api/memories/${encodeURIComponent(alphaDoc.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected: "stale-version", fact: "must not win" }),
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.current.fact, "Alpha production fact.");

    const saved = await browserJson(alphaUrl, `/api/memories/${encodeURIComponent(alphaDoc.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected: alphaDoc.version, fact: "Alpha production fact, revised." }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.fact, "Alpha production fact, revised.");
    await close(alphaServer);

    // Workspace switching restarts the server with that workspace's store.
    const betaServer = createMemoryBrowserServer(betaFacts, principal);
    const betaUrl = await listen(betaServer);
    const betaList = await browserJson(betaUrl, "/api/memories");
    assert.equal(betaList.body.total, 1);
    assert.deepEqual(betaList.body.items.map(item => item.fact), ["Beta production fact."]);
    assert.ok(!betaList.body.items.some(item => item.fact.includes("Alpha")));
    await close(betaServer);

    console.log("production memory capture, restart, dream-time, browser CAS, and workspace isolation passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
