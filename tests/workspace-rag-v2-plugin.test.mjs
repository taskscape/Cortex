import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");

process.env.CORTEX_RAG_STORAGE = "json";
process.env.CORTEX_RAG_DISABLE_CUDA = "true";
delete process.env.CORTEX_RAG_V2_MODE;
process.env.CORTEX_RAG_V2_STORAGE = "memory";

const { plugin } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts"
);

async function execute(tool, value) {
  const events = [];
  for await (const event of tool.executor.execute(value, {
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  const error = events.find(event => event.type === "error");
  if (error) throw new Error(error.message);
  return events.find(event => event.type === "result")?.value;
}

test("workspace_rag defaults to V2 primary hybrid search with V1 fallback", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-plugin-"));
  t.after(async () => {
    await plugin.teardown?.();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  const docs = path.join(root, "docs");
  await mkdir(workspace, { recursive: true });
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(workspace, "matbot.yaml"), "plugins:\n  - workspace-rag\n");
  await writeFile(path.join(docs, "contract.md"), [
    "# Distribution Agreement",
    "",
    "## Termination",
    "",
    "The distributor may terminate after sixty days written notice.",
  ].join("\n"));

  const tools = new Map();
  const registry = new Map();
  await plugin.setup({
    configPath: path.join(workspace, "matbot.yaml"),
    isSubAgent: () => false,
    async register(key, value) { registry.set(key, value); },
    get(key) { return registry.get(key); },
    tools: { register(tool) { tools.set(tool.name, tool); } },
    hooks: { register() {} },
  });
  const tool = tools.get("workspace_rag");
  assert.ok(tool);
  for (const action of [
    "ingestion_start",
    "ingestion_pause",
    "ingestion_resume",
    "ingestion_cancel",
    "ingestion_retry",
    "ingestion_status",
    "reconcile_now",
    "corpus_census",
    "v2_search",
    "backend_gate_evaluate",
    "embedding_evict",
  ]) {
    assert.ok(tool.inputSchema.properties.action.enum.includes(action), `${action} must be exposed`);
  }

  await execute(tool, { action: "configure", contextName: "Contracts", paths: [docs] });
  const census = await execute(tool, { action: "corpus_census" });
  assert.equal(census.files, 1);
  const started = await execute(tool, { action: "ingestion_start" });
  assert.equal(started.state, "discovered");
  const status = await execute(tool, { action: "ingestion_wait" });
  assert.equal(status.activeState, "active_hybrid_complete");
  assert.equal(status.summaries.enabled, false);

  const explicit = await execute(tool, {
    action: "v2_search",
    query: "How much notice is required to terminate?",
    limit: 3,
  });
  assert.ok(explicit.evidence.length >= 1);
  assert.equal(explicit.answerability.status, "sufficient");
  assert.match(explicit.evidence[0].text, /sixty days written notice/i);

  const missing = await execute(tool, {
    action: "v2_search",
    query: "What does ZXQ-NOT-PRESENT-991 require?",
    limit: 3,
  });
  assert.equal(missing.answerability.status, "insufficient");
  assert.equal(missing.answerability.abstained, true);
  assert.deepEqual(missing.evidence, []);

  const primary = await execute(tool, {
    action: "search",
    query: "distributor terminate sixty days",
    limit: 3,
  });
  assert.ok(primary.hits.some(hit => hit.documentVersionId && hit.startLine));
});
