/**
 * Workspace RAG with its index store unreachable.
 *
 * This test ensures:
 * - When Workspace RAG V2 cannot initialize (PostgreSQL down at startup), creating a context or
 *   changing a context's paths still saves the configuration and returns normally
 * - The background reconcile that cannot start is recorded, not left as an unhandled promise
 *   rejection — which Node treats as fatal, taking the whole Cortex process down
 *
 * Assumptions:
 * - `CORTEX_RAG_POSTGRES_URL` points at a closed loopback port, so initialization fails quickly
 * - Environment is set before the plugin module loads; each test file runs in its own process
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");

process.env.CORTEX_RAG_DISABLE_CUDA = "true";
delete process.env.CORTEX_RAG_V2_MODE;
process.env.CORTEX_RAG_V2_STORAGE = "postgres";
process.env.CORTEX_RAG_POSTGRES_URL = "postgres://cortex:cortex@127.0.0.1:1/unreachable";
process.env.CORTEX_RAG_V2_POOL_CONNECTION_TIMEOUT_MS = "1000";
delete process.env.CORTEX_RAG_V2_MIGRATION_POSTGRES_URL;

const { plugin } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts"
);

const unhandledRejections = [];
process.on("unhandledRejection", reason => { unhandledRejections.push(reason); });

async function execute(tool, value) {
  const events = [];
  for await (const event of tool.executor.execute(value, { signal: new AbortController().signal })) events.push(event);
  const error = events.find(event => event.type === "error");
  if (error) throw new Error(error.message);
  return events.find(event => event.type === "result")?.value;
}

test("changing RAG configuration while the index store is unreachable does not crash the process", { timeout: 60_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-unavailable-"));
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  t.after(async () => {
    console.warn = warn;
    await plugin.teardown?.();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "workspace");
  const docs = path.join(root, "docs");
  const moreDocs = path.join(root, "more-docs");
  await mkdir(workspace, { recursive: true });
  await mkdir(docs, { recursive: true });
  await mkdir(moreDocs, { recursive: true });
  await writeFile(path.join(workspace, "matbot.yaml"), "plugins:\n  - workspace-rag\n");
  await writeFile(path.join(docs, "note.md"), "# Note\n\nBody.\n");

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
  assert.ok(warnings.some(line => /initialization failed/i.test(line)), "the store must actually be unavailable for this test to mean anything");
  const tool = tools.get("workspace_rag");
  assert.ok(tool);

  const created = await execute(tool, { action: "create_context", contextName: "Contracts", paths: [docs] });
  assert.ok(JSON.stringify(created).includes("Contracts"));

  const configured = await execute(tool, { action: "configure", contextName: "Contracts", paths: [docs, moreDocs] });
  assert.ok(JSON.stringify(configured).includes("more-docs"));

  // Unhandled rejections are reported after the microtask queue drains; give them a turn.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(unhandledRejections.map(String), []);
  assert.ok(
    warnings.some(line => /configuration saved, but reconciliation could not start/i.test(line)),
    "the reconcile that could not start must be reported",
  );
});
