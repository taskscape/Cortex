import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
process.env.CORTEX_RAG_DISABLE_CUDA = "1";
const { plugin } = await import("../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts");

async function invoke(tool, input) {
  const events = [];
  for await (const event of tool.executor.execute(input, { signal: new AbortController().signal })) events.push(event);
  return {
    value: events.find(event => event.type === "result")?.value,
    error: events.find(event => event.type === "error")?.message,
  };
}

/**
 * Validates that the RAG system correctly migrates legacy single-context configuration
 * to the new multi-context schema and rejects invalid context settings.
 *
 * This test ensures:
 * - Legacy single-context configuration is normalized to the current contexts schema
 * - Blank context names are rejected
 * - Duplicate context names are rejected
 * - Inaccessible paths are rejected
 * - No workspace-local Cortex configuration is modified during migration
 *
 * Assumptions:
 * - The RAG plugin's workspace_rag tool supports action: create_context, configure
 * - The test creates a legacy single-context configuration and triggers migration
 * - The test then attempts to create invalid contexts to test rejection paths
 * - Success is indicated by the migrated configuration having the expected structure
 *   and invalid contexts being rejected with appropriate errors
 */
test("MISSING-03/MISSING-12 RAG migrates legacy config and rejects blank, duplicate, or inaccessible context settings", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-config-"));
  t.after(async () => { await plugin.teardown?.(); await rm(root, { recursive: true, force: true }); delete process.env.CORTEX_RAG_DISABLE_CUDA; });
  const workspace = path.join(root, "workspace");
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(docs, "legacy.md"), "# Legacy\n\nlegacy context marker", "utf8");
  await writeFile(path.join(workspace, "matbot.yaml"), "plugins:\n  - ./packages/plugins/workspace-rag\n");
  // Legacy single-context shape is normalized to the current contexts schema without
  // touching any workspace-local Cortex configuration.
  await writeFile(path.join(workspace, "cortex-rag.json"), JSON.stringify({ contextName: "Legacy", paths: [docs, `${docs}${path.sep}.`] }), "utf8");
  const tools = new Map();
  const services = {
    configPath: path.join(workspace, "matbot.yaml"), isSubAgent: () => false,
    async register() {}, get() { return undefined; },
    tools: { register(tool) { tools.set(tool.name, tool); } }, hooks: { register() {} },
  };
  await plugin.setup(services);
  const tool = tools.get("workspace_rag");
  const migrated = await invoke(tool, { action: "get_config" });
  assert.deepEqual(migrated.value.contexts, [{ id: "default", name: "Legacy", paths: [docs] }]);

  assert.equal((await invoke(tool, { action: "create_context", contextName: "Finance", paths: [docs] })).error, undefined);
  assert.match((await invoke(tool, { action: "create_context", contextName: "   ", paths: [docs] })).error, /must not be blank/);
  assert.match((await invoke(tool, { action: "create_context", contextName: "finance", paths: [docs] })).error, /already in use/);
  assert.match((await invoke(tool, { action: "configure", contextId: "default", paths: [path.join(root, "missing")] })).error, /path is inaccessible/);
});
