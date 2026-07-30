import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp(path.join(tmpdir(), "cortex-expert-config-"));
const financeRoot = path.join(root, "finance");
const securityRoot = path.join(root, "security");
const configPath = path.join(root, "experts.json");
await mkdir(financeRoot, { recursive: true });
await mkdir(securityRoot, { recursive: true });
await writeFile(path.join(financeRoot, "finance.md"), "FINANCE_ONLY_CANARY margin plan", "utf8");
await writeFile(path.join(securityRoot, "security.md"), "SECURITY_ONLY_CANARY access review", "utf8");
await writeFile(configPath, JSON.stringify({
  defaultProvider: "test",
  experts: [
    { id: "finance", title: "Finance", description: "Finance analysis", roots: [financeRoot], systemPrompt: "Finance system." },
    { id: "security", title: "Security", description: "Security analysis", roots: [securityRoot], systemPrompt: "Security system." },
  ],
}), "utf8");
process.env.EXPERT_PANEL_CONFIG = configPath;
await import("../local-agent/matbot/apps/cli/register.js");
const { plugin } = await import("../local-agent/matbot/plugins/expert-panel/src/index.ts");

class Store {
  constructor() { this.docs = new Map(); }
  async get(id) { return this.docs.get(id) ?? null; }
  async set(id, value) { this.docs.set(id, value); }
  async query() { return { items: [...this.docs.values()], total: this.docs.size }; }
}

async function execute(tool, input) {
  const events = [];
  for await (const event of tool.executor.execute(input, { provider: "test", signal: new AbortController().signal })) events.push(event);
  const error = events.find(event => event.type === "error");
  if (error) throw new Error(error.message);
  return events.find(event => event.type === "result")?.value;
}

/**
 * Validates that custom expert configuration correctly isolates expert knowledge roots
 * and preserves all three panel modes (parallel, review, debate).
 *
 * This test ensures:
 * - Experts are correctly loaded from configuration with isolated roots
 * - Each expert can only access files within their configured roots
 * - All three panel modes (parallel, review, debate) work correctly
 * - Synthesis works in review and debate modes
 * - Individual expert selection works in parallel mode
 *
 * Assumptions:
 * - The expert-panel plugin loads configuration from a JSON file
 * - The test creates temporary expert configurations with isolated roots
 * - Each expert has a unique knowledge root with specific content markers
 * - Success is indicated by the panel correctly routing to each expert and
 *   generating appropriate synthesis
 */
test("MISSING-04 custom expert configuration isolates roots and preserves all three panel modes", async t => {
  t.after(async () => { delete process.env.EXPERT_PANEL_CONFIG; await rm(root, { recursive: true, force: true }); });
  const tools = new Map();
  const calls = [];
  const stores = new Map();
  const services = {
    providers: new Map([["test", {}]]),
    createStore(name) { if (!stores.has(name)) stores.set(name, new Store()); return stores.get(name); },
    async register(key, value) { this[key] = value; },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    async singleTurn(request) { calls.push(request); return { text: `answer-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } }; },
  };
  await plugin.setup(services);
  const tool = tools.get("expert_panel");
  assert.ok(tool);
  const listed = await execute(tool, { action: "list" });
  assert.deepEqual(listed.experts.map(expert => expert.id), ["finance", "security"]);

  for (const mode of ["parallel", "review", "debate"]) {
    calls.length = 0;
    const result = await execute(tool, { action: "ask", question: "Compare FINANCE_ONLY_CANARY and SECURITY_ONLY_CANARY", mode, synthesize: true });
    assert.equal(result.mode, mode);
    assert.equal(result.experts.length, 2);
    assert.equal(typeof result.synthesis, "string");
    const finance = result.experts.find(expert => expert.expertId === "finance");
    const security = result.experts.find(expert => expert.expertId === "security");
    assert.ok(finance.citations.every(citation => citation.path.startsWith(financeRoot)));
    assert.ok(security.citations.every(citation => citation.path.startsWith(securityRoot)));
    assert.ok(finance.citations.length > 0);
    assert.ok(security.citations.length > 0);
    assert.match(calls[2].system, /orchestrating agent/i);
  }

  const selected = await execute(tool, { action: "ask", question: "FINANCE_ONLY_CANARY", experts: ["finance"], mode: "parallel", synthesize: false });
  assert.deepEqual(selected.experts.map(expert => expert.expertId), ["finance"]);
});
