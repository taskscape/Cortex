import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CORTEX_RAG_DISABLE_CUDA = "1";
const { plugin } = await import("../local-agent/matbot/packages/plugins/workspace-rag/src/index.ts");

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-workspace-rag-"));
  try {
    const workspaceDir = path.join(root, "workspace");
    const docsDir = path.join(root, "docs");
    const financeDir = path.join(root, "finance-docs");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await mkdir(financeDir, { recursive: true });
    const configPath = path.join(workspaceDir, "matbot.yaml");
    await writeFile(configPath, "plugins:\n  - ./packages/plugins/workspace-rag\n", "utf8");
    await writeFile(
      path.join(docsDir, "retrieval-probe.md"),
      "# Retrieval Probe\n\nThe QuasarPump calibration value is 42. Use the amber valve before startup.",
      "utf8",
    );
    await writeFile(
      path.join(financeDir, "finance-probe.md"),
      "# Finance Probe\n\nThe LedgerAlpha reserve ratio is 18 percent. Review cash timing before expansion.",
      "utf8",
    );

    let registeredTool;
    let screenHook;
    const services = {
      configPath,
      isSubAgent: () => false,
      async register() {},
      tools: {
        register(tool) {
          registeredTool = tool;
        },
      },
      hooks: {
        register(hook) {
          if (hook.on === "screen") screenHook = hook;
        },
      },
    };

    await plugin.setup(services);
    assert.equal(registeredTool?.name, "workspace_rag");
    assert.equal(screenHook?.on, "screen");

    const toolCtx = { signal: new AbortController().signal };
    const configureEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "configure",
      contextName: "Probe Knowledge",
      paths: [docsDir],
    }, toolCtx)) {
      configureEvents.push(event);
    }
    const configureResult = configureEvents.find(event => event.type === "result")?.value;
    assert.equal(configureResult.status.state, "idle");
    assert.equal(configureResult.status.percent, 100);
    assert.equal(configureResult.status.accelerator, "cpu");
    assert.equal(configureResult.status.accelerated, false);
    assert.equal(configureResult.status.embeddingBackend, "hash-cpu");
    assert.equal(configureResult.status.currentFile, undefined);

    const idleStatusEvents = [];
    for await (const event of registeredTool.executor.execute({ action: "status" }, toolCtx)) {
      idleStatusEvents.push(event);
    }
    const idleStatusResult = idleStatusEvents.find(event => event.type === "result")?.value;
    assert.equal(idleStatusResult.currentFile, undefined);

    const dbText = await readFile(path.join(workspaceDir, ".data", "workspace-rag", "index.json"), "utf8");
    assert.match(dbText, /QuasarPump/);

    const searchEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "search",
      query: "What is the QuasarPump calibration value?",
      limit: 3,
    }, toolCtx)) {
      searchEvents.push(event);
    }
    const searchResult = searchEvents.find(event => event.type === "result")?.value;
    assert.ok(searchResult.hits.length >= 1);
    assert.match(searchResult.hits[0].text, /QuasarPump calibration value is 42/);

    const createContextEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "create_context",
      contextName: "Finance Notes",
      paths: [financeDir],
    }, toolCtx)) {
      createContextEvents.push(event);
    }
    const createContextResult = createContextEvents.find(event => event.type === "result")?.value;
    assert.equal(createContextResult.config.contextName, "Finance Notes");
    assert.equal(createContextResult.config.activeContextId, "finance-notes");

    const financeSearchEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "search",
      query: "What is the LedgerAlpha reserve ratio?",
      limit: 3,
    }, toolCtx)) {
      financeSearchEvents.push(event);
    }
    const financeSearchResult = financeSearchEvents.find(event => event.type === "result")?.value;
    assert.ok(financeSearchResult.hits.length >= 1);
    assert.equal(financeSearchResult.hits[0].contextName, "Finance Notes");
    assert.match(financeSearchResult.hits[0].text, /LedgerAlpha reserve ratio is 18 percent/);

    const selectDefaultEvents = [];
    for await (const event of registeredTool.executor.execute({
      action: "select_context",
      contextId: "default",
    }, toolCtx)) {
      selectDefaultEvents.push(event);
    }
    const selectDefaultResult = selectDefaultEvents.find(event => event.type === "result")?.value;
    assert.equal(selectDefaultResult.config.contextName, "Probe Knowledge");

    const hookResult = await screenHook.handler({
      session: {
        messages: [{
          role: "user",
          content: [{ type: "text", text: "What is the QuasarPump calibration value?" }],
        }],
      },
      config: { provider: "test" },
      signal: new AbortController().signal,
      removeHook() {},
    });
    assert.match(hookResult.ephemeral[0].text, /Workspace RAG context/);
    assert.match(hookResult.ephemeral[0].text, /QuasarPump calibration value is 42/);

    await plugin.teardown?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
console.log("workspace-rag ingests markdown, persists the vector db, searches, and injects turn context");
