import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { FileExpertKnowledge } = await import("../local-agent/matbot/plugins/expert-panel/src/file-knowledge.ts");
const { default: expertPanelPlugin } = await import("../local-agent/matbot/plugins/expert-panel/src/index.ts");

function expert(id, roots) {
  return {
    id,
    title: `${id} expert`,
    description: `${id} test expert`,
    roots,
    systemPrompt: "Use only the configured files.",
  };
}

/**
 * T3-E2E-023: Expert panel file knowledge format support
 *
 * Validates that the expert panel correctly loads knowledge files from all supported
 * text formats (Markdown, MDX, JSON, CSV, TSV, YAML, TXT) while ignoring unsupported
 * formats (PDF) and files that are too large or hidden.
 *
 * This test ensures:
 * - All supported text formats are loaded and indexed
 * - Unsupported formats (e.g., PDF) are ignored
 * - Hidden files (e.g., .hidden.md) are ignored
 * - Oversized files (beyond maxFileBytes) are ignored
 * - The search function correctly retrieves content from all supported formats
 *
 * Assumptions:
 * - The FileExpertKnowledge class loads files from the configured knowledge root
 * - The test creates temporary files in all supported and unsupported formats
 * - Success is indicated by only supported, non-hidden, appropriately-sized files
 *   being loaded and searchable
 */
test("T3-E2E-023 expert knowledge loads every supported text format and ignores unsupported or oversized files", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-expert-knowledge-formats-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const supported = new Map([
    ["brief.md", "# Brief\nFORMAT_CANARY markdown"],
    ["component.mdx", "# Component\nFORMAT_CANARY mdx"],
    ["notes.txt", "FORMAT_CANARY text"],
    ["record.json", '{"topic":"FORMAT_CANARY json"}'],
    ["table.csv", "topic\nFORMAT_CANARY csv"],
    ["table.tsv", "topic\nFORMAT_CANARY tsv"],
    ["config.yaml", "topic: FORMAT_CANARY yaml"],
    ["config.yml", "topic: FORMAT_CANARY yml"],
  ]);
  for (const [name, content] of supported) await writeFile(path.join(root, name), content, "utf8");
  await writeFile(path.join(root, "unsupported.pdf"), "FORMAT_CANARY should not be loaded", "utf8");
  await writeFile(path.join(root, ".hidden.md"), "FORMAT_CANARY should stay hidden", "utf8");
  await writeFile(path.join(root, "too-large.md"), `FORMAT_CANARY${"x".repeat(1_000_001)}`, "utf8");

  const knowledge = new FileExpertKnowledge(expert("formats", [root]));
  const search = await knowledge.searchWithDiagnostics("FORMAT_CANARY", 20, new AbortController().signal);
  const sources = search.sources;

  assert.deepEqual(
    sources.map(source => source.title).sort(),
    [...supported.keys()].sort(),
  );
  assert.ok(sources.every(source => source.path.startsWith(root)));
  assert.ok(sources.every(source => source.content.includes("FORMAT_CANARY")));
  assert.equal(sources.some(source => source.title === "unsupported.pdf"), false);
  assert.equal(sources.some(source => source.title === ".hidden.md"), false);
  assert.equal(sources.some(source => source.title === "too-large.md"), false);
  assert.ok(search.warnings.some(warning => /skipped oversized knowledge file/.test(warning) && /too-large\.md/.test(warning)));
  assert.equal(sources.find(source => source.title === "record.json")?.content, supported.get("record.json"));
  assert.equal(sources.find(source => source.title === "table.csv")?.content, supported.get("table.csv"));
});

/**
 * T3-E2E-024: Expert panel knowledge root isolation
 *
 * Validates that the expert panel correctly isolates knowledge roots for different
 * experts and prevents large files from polluting search results (e.g., by exceeding
 * token limits or degrading performance).
 *
 * This test ensures:
 * - Each expert's knowledge root is isolated from other experts' roots
 * - Large files (beyond token limits) are not included in search results
 * - Experts can only access files within their configured roots
 *
 * Assumptions:
 * - The FileExpertKnowledge class implements root isolation
 * - The test creates experts with separate knowledge roots
 * - Success is indicated by correct root isolation and exclusion of oversized files
 *   from search results
 */
test("T3-E2E-024 expert knowledge keeps roots isolated and does not let a large matching file leak into results", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-expert-knowledge-isolation-"));
  const financeRoot = path.join(root, "finance");
  const securityRoot = path.join(root, "security");
  await Promise.all([mkdir(financeRoot), mkdir(securityRoot)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(financeRoot, "finance.md"), "FINANCE_ONLY_CANARY margin plan", "utf8");
  await writeFile(path.join(financeRoot, "finance-large.md"), `FINANCE_ONLY_CANARY${"x".repeat(1_000_001)}`, "utf8");
  await writeFile(path.join(securityRoot, "security.md"), "SECURITY_ONLY_CANARY access review", "utf8");

  const finance = new FileExpertKnowledge(expert("finance", [financeRoot]));
  const security = new FileExpertKnowledge(expert("security", [securityRoot]));
  const [financeSources, securitySources] = await Promise.all([
    finance.search("FINANCE_ONLY_CANARY", 10, new AbortController().signal),
    security.search("SECURITY_ONLY_CANARY", 10, new AbortController().signal),
  ]);

  assert.deepEqual(financeSources.map(source => source.title), ["finance.md"]);
  assert.ok(financeSources.every(source => source.path.startsWith(financeRoot)));
  assert.equal(financeSources.some(source => source.path.startsWith(securityRoot)), false);
  assert.deepEqual(securitySources.map(source => source.title), ["security.md"]);
  assert.ok(securitySources.every(source => source.path.startsWith(securityRoot)));
  assert.equal(securitySources.some(source => source.path.startsWith(financeRoot)), false);
});

test("EKI-6 expert panel response warns when a configured knowledge root becomes inaccessible", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-expert-missing-root-"));
  const knowledgeRoot = path.join(root, "knowledge");
  const configPath = path.join(root, "experts.json");
  const priorConfig = process.env.EXPERT_PANEL_CONFIG;
  await mkdir(knowledgeRoot);
  await writeFile(path.join(knowledgeRoot, "brief.md"), "MISSING_ROOT_CANARY", "utf8");
  await writeFile(configPath, JSON.stringify({
    defaultProvider: "test",
    experts: [expert("runtime-root", [knowledgeRoot])]
  }), "utf8");
  process.env.EXPERT_PANEL_CONFIG = configPath;
  t.after(async () => {
    if (priorConfig === undefined) delete process.env.EXPERT_PANEL_CONFIG;
    else process.env.EXPERT_PANEL_CONFIG = priorConfig;
    await rm(root, { recursive: true, force: true });
  });

  const tools = new Map();
  const stores = new Map();
  await expertPanelPlugin.setup({
    providers: new Map([["test", {}]]),
    tools: { register(tool) { tools.set(tool.name, tool); } },
    createStore(name) {
      if (!stores.has(name)) {
        const docs = new Map();
        stores.set(name, {
          async get(id) { return docs.get(id) ?? null; },
          async set(id, value) { docs.set(id, value); },
          async query() { return { items: [...docs.values()], total: docs.size }; }
        });
      }
      return stores.get(name);
    },
    async singleTurn() {
      return { text: "The configured knowledge root could not be read.", usage: { inputTokens: 1, outputTokens: 1 } };
    }
  });

  const tool = tools.get("expert_panel");
  const input = {
    question: "MISSING_ROOT_CANARY",
    experts: ["runtime-root"],
    synthesize: false
  };
  const initialEvents = [];
  for await (const event of tool.executor.execute(input, {
    provider: "test",
    signal: new AbortController().signal
  })) {
    initialEvents.push(event);
  }
  assert.equal(initialEvents.find(event => event.type === "result")?.value.experts[0].citations.length, 1);

  await rm(knowledgeRoot, { recursive: true, force: true });
  const events = [];
  for await (const event of tool.executor.execute(input, {
    provider: "test",
    signal: new AbortController().signal
  })) {
    events.push(event);
  }
  const result = events.find(event => event.type === "result")?.value;
  assert.ok(result);
  assert.deepEqual(result.experts[0].citations, []);
  assert.ok(result.experts[0].warnings.some(warning => (
    /knowledge root is inaccessible/.test(warning) && warning.includes(knowledgeRoot)
  )));
});
