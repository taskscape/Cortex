import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { plugin } = await import("../local-agent/matbot/plugins/expert-panel/src/index.ts");

class Store {
  constructor() {
    this.docs = new Map();
  }

  async get(id) {
    return this.docs.get(id) ?? null;
  }

  async set(id, value) {
    this.docs.set(id, value);
  }

  async query() {
    return { items: [...this.docs.values()], total: this.docs.size };
  }
}

async function execute(tool, input, provider) {
  const events = [];
  const context = { signal: new AbortController().signal };
  if (provider !== undefined) context.provider = provider;

  for await (const event of tool.executor.execute(input, context)) events.push(event);

  const error = events.find(event => event.type === "error");
  assert.equal(error, undefined, error?.message);
  return events.find(event => event.type === "result")?.value;
}

/**
 * T3-E2E-022: Expert panel provider resolution fallback chain
 *
 * Validates that the expert panel correctly resolves the provider for each expert
 * by following the priority chain: expert pin -> turn provider -> panel default.
 * The test exercises synthesis scenarios where the synthesis provider also follows
 * the fallback chain.
 *
 * This test ensures:
 * - Expert-level provider configuration (expert pin) takes precedence
 * - Turn-level provider is used when expert pin is null
 * - Panel default provider is used when both expert pin and turn provider are null
 * - Synthesis correctly inherits from the turn provider when available
 * - Synthesis falls back to panel default when turn provider is unavailable
 * - Unavailable configured providers continue through the documented chain
 * - Fallbacks emit an audit log and return provider-resolution metadata
 *
 * Assumptions:
 * - The expert-panel plugin implements a provider resolution chain
 * - The test creates experts with different provider configurations
 * - Success is indicated by the correct provider being used for each expert
 *   and for synthesis operations
 */
test("T3-E2E-022 EPF provider resolution prefers expert pins and falls back through turn and panel defaults", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-expert-provider-fallback-"));
  const knowledgeRoot = path.join(root, "knowledge");
  const configPath = path.join(root, "experts.json");
  const priorConfig = process.env.EXPERT_PANEL_CONFIG;

  await mkdir(knowledgeRoot, { recursive: true });
  await writeFile(path.join(knowledgeRoot, "provider.md"), "PROVIDER_FALLBACK_CANARY", "utf8");
  await writeFile(configPath, JSON.stringify({
    defaultProvider: "panel-default",
    experts: [
      {
        id: "pinned",
        title: "Pinned provider expert",
        description: "Uses an explicitly configured provider.",
        provider: "expert-provider",
        roots: [knowledgeRoot],
        systemPrompt: "Pinned expert system prompt."
      },
      {
        id: "turn-fallback",
        title: "Turn provider expert",
        description: "Uses the current turn provider when its provider is null.",
        provider: null,
        roots: [knowledgeRoot],
        systemPrompt: "Turn fallback expert system prompt."
      },
      {
        id: "default-fallback",
        title: "Panel default expert",
        description: "Uses the panel default when both higher-priority values are null.",
        provider: null,
        roots: [knowledgeRoot],
        systemPrompt: "Panel default expert system prompt."
      },
      {
        id: "unavailable-pin",
        title: "Unavailable provider expert",
        description: "Continues to the turn provider when its configured provider is unavailable.",
        provider: "missing-provider",
        roots: [knowledgeRoot],
        systemPrompt: "Unavailable provider expert system prompt."
      }
    ]
  }), "utf8");
  process.env.EXPERT_PANEL_CONFIG = configPath;
  t.after(async () => {
    if (priorConfig === undefined) delete process.env.EXPERT_PANEL_CONFIG;
    else process.env.EXPERT_PANEL_CONFIG = priorConfig;
    await rm(root, { recursive: true, force: true });
  });

  const calls = [];
  const tools = new Map();
  const stores = new Map();
  const services = {
    providers: new Map([
      ["expert-provider", {}],
      ["turn-provider", {}],
      ["panel-default", {}]
    ]),
    createStore(name) {
      if (!stores.has(name)) stores.set(name, new Store());
      return stores.get(name);
    },
    async register(key, value) {
      this[key] = value;
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
      }
    },
    async singleTurn(request) {
      calls.push(request);
      return { text: `response-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    }
  };

  await plugin.setup(services);
  const tool = tools.get("expert_panel");
  assert.ok(tool);

  const logs = [];
  const originalConsoleInfo = console.info;
  console.info = (...args) => logs.push(args.join(" "));
  t.after(() => { console.info = originalConsoleInfo; });

  const pinned = await execute(tool, { question: "PROVIDER_FALLBACK_CANARY", experts: ["pinned"], synthesize: false }, "turn-provider");
  assert.deepEqual(calls.map(call => call.provider), ["expert-provider"]);
  assert.deepEqual(pinned.experts[0].providerResolution, {
    selectedProvider: "expert-provider",
    source: "expert",
    fallback: false,
    chain: [
      { source: "expert", provider: "expert-provider", available: true },
      { source: "turn", provider: "turn-provider", available: true },
      { source: "panel_default", provider: "panel-default", available: true }
    ]
  });

  calls.length = 0;
  const turnFallback = await execute(tool, { question: "PROVIDER_FALLBACK_CANARY", experts: ["turn-fallback"], synthesize: false }, "turn-provider");
  assert.deepEqual(calls.map(call => call.provider), ["turn-provider"]);
  assert.equal(turnFallback.experts[0].providerResolution.source, "turn");
  assert.equal(turnFallback.experts[0].providerResolution.fallback, true);

  calls.length = 0;
  const defaultFallback = await execute(tool, { question: "PROVIDER_FALLBACK_CANARY", experts: ["default-fallback"], synthesize: false });
  assert.deepEqual(calls.map(call => call.provider), ["panel-default"]);
  assert.equal(defaultFallback.experts[0].providerResolution.source, "panel_default");
  assert.equal(defaultFallback.experts[0].providerResolution.fallback, true);

  calls.length = 0;
  const unavailablePin = await execute(tool, { question: "PROVIDER_FALLBACK_CANARY", experts: ["unavailable-pin"], synthesize: false }, "turn-provider");
  assert.deepEqual(calls.map(call => call.provider), ["turn-provider"]);
  assert.equal(unavailablePin.experts[0].providerResolution.source, "turn");
  assert.deepEqual(unavailablePin.experts[0].providerResolution.chain.slice(0, 2), [
    { source: "expert", provider: "missing-provider", available: false },
    { source: "turn", provider: "turn-provider", available: true }
  ]);

  calls.length = 0;
  const turnSynthesis = await execute(tool, { question: "PROVIDER_FALLBACK_CANARY", experts: ["pinned"], synthesize: true }, "turn-provider");
  assert.deepEqual(calls.map(call => call.provider), ["expert-provider", "turn-provider"]);
  assert.equal(turnSynthesis.synthesisProviderResolution.source, "turn");
  assert.equal(turnSynthesis.synthesisProviderResolution.fallback, false);

  calls.length = 0;
  const defaultSynthesis = await execute(tool, { question: "PROVIDER_FALLBACK_CANARY", experts: ["pinned"], synthesize: true });
  assert.deepEqual(calls.map(call => call.provider), ["expert-provider", "panel-default"]);
  assert.equal(defaultSynthesis.synthesisProviderResolution.source, "panel_default");
  assert.equal(defaultSynthesis.synthesisProviderResolution.fallback, true);

  assert.ok(logs.some(log => /scope=expert:turn-fallback selected=turn-provider source=turn/.test(log)));
  assert.ok(logs.some(log => /scope=expert:default-fallback selected=panel-default source=panel_default/.test(log)));
  assert.ok(logs.some(log => /scope=expert:unavailable-pin.*expert=missing-provider \(unavailable\)/.test(log)));
  assert.ok(logs.some(log => /scope=synthesis selected=panel-default source=panel_default/.test(log)));
});
