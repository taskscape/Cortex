import { expect, test } from "@playwright/test";

async function openPlugins(page) {
  await page.locator('[data-section="plugins"] .sidebar-heading').click();
}

async function openSkills(page) {
  await page.locator('[data-section="skills"] .sidebar-heading').click();
}

async function openExperts(page) {
  await page.locator("#expert-toggle-btn").click();
}

async function openMemorySection(page) {
  await page.locator('[data-section="memory"] .sidebar-heading').click();
}

async function inputMetaTypography(locator) {
  return locator.evaluate(el => {
    const style = getComputedStyle(el);
    return {
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight
    };
  });
}

test("model label and expert selector use the same input meta typography", async ({ page }) => {
  await page.goto("/");

  const modelLabel = page.locator("#input-meta .input-meta-label", { hasText: "Model:" });
  const expertMenu = page.locator("#expert-menu");
  const expertToggle = page.locator("#expert-toggle-btn");
  const modelTypography = await inputMetaTypography(modelLabel);

  expect(await inputMetaTypography(expertMenu)).toEqual(modelTypography);
  expect(await inputMetaTypography(expertToggle)).toEqual(modelTypography);

  await expertToggle.click();
  expect(await inputMetaTypography(expertToggle)).toEqual(modelTypography);

  await page.locator("#expert-enabled").check();
  expect(await inputMetaTypography(expertToggle)).toEqual(modelTypography);
});

test("loads the shell, providers, conversations, files, plugins, and skills", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop sidebar coverage");
  await page.goto("/");

  await expect(page).toHaveTitle(/Cortex/);
  await expect(page.locator("h1")).toContainText("Cortex");
  await expect(page.locator("#input-meta")).toContainText("Model:");
  await expect(page.locator("#provider-select")).toContainText("openai");
  await expect(page.locator("#provider-select")).toContainText("Local");
  await expect(page.locator("#provider-select")).toContainText("panel-test");
  await expect(page.locator("#provider-select")).toHaveCSS("border-top-style", "solid");
  await expect(page.locator("#provider-select")).toHaveCSS("border-radius", "10px");
  await expect(page.locator("#provider-select")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator("#input-meta #expert-toggle-btn")).toContainText("Experts");
  await expect(page.locator("#input-row #expert-toggle-btn")).toHaveCount(0);
  await expect(page.locator("#expert-toggle-btn")).toHaveCSS("border-top-style", "solid");
  await expect(page.locator("#expert-toggle-btn")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator("#session-list")).toContainText(/Conversation/);
  await expect(page.locator("#file-list")).toContainText("brief.md");

  await openPlugins(page);
  await expect(page.locator("#plugin-list")).toContainText("@local-agent/expert-panel");
  await expect(page.locator("#plugin-list")).toContainText("expert_panel");
  await expect(page.locator("#plugin-list")).toContainText("@local-agent/file-broker-client");
  await expect(page.locator("#plugin-list")).toContainText("file_broker_action");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-workspace-rag");
  await expect(page.locator("#plugin-list")).toContainText("workspace_rag");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-source-registry");
  await expect(page.locator("#plugin-list")).toContainText("source_health_action");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-connector-fabric");
  await expect(page.locator("#plugin-list")).toContainText("connector_action");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-structured-data");
  await expect(page.locator("#plugin-list")).toContainText("structured_data_action");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-workflow-governance");
  await expect(page.locator("#plugin-list")).toContainText("workflow_action");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-context-graph");
  await expect(page.locator("#plugin-list")).toContainText("context_graph_action");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-storage-google-drive");
  await expect(page.locator(".plugin-incompatible")).toContainText("google-drive");
  await expect(page.locator("#workspace-toggle-btn")).toBeInViewport();

  await openSkills(page);
  await expect(page.locator("#skill-list")).toContainText("Panel Etiquette");
});

test("default file broker tool reads host files through the WebUI transport", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop direct file-broker coverage");
  await page.goto("/");

  const result = await page.evaluate(async () => window.matbotTransport.callTool("file_broker_action", {
    action: "read",
    path: "C:\\Projects\\Cortex\\readme.md"
  }));

  expect(result.ok).toBe(true);
  expect(result.content).toContain("Broker harness host read");
  expect(result.content).toContain("C:\\Projects\\Cortex\\readme.md");
});

test("architecture source and connector health tools work through the WebUI transport", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop architecture direct tool coverage");
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const sourceList = await window.matbotTransport.callTool("source_action", { action: "list" });
    const sourceId = sourceList.sources[0].id;
    const citation = await window.matbotTransport.callTool("source_action", { action: "citation", sourceId });
    const sourceEvents = await window.matbotTransport.callTool("source_action", { action: "events", sourceId });
    const healthReport = await window.matbotTransport.callTool("source_health_action", { action: "report", workspaceId: "default" });
    const connectorList = await window.matbotTransport.callTool("connector_action", { action: "list" });
    const connectorHealth = await window.matbotTransport.callTool("connector_action", {
      action: "test_health",
      connectorInstanceId: "connector-instance:workspace-rag:local"
    });
    const connectorAudit = await window.matbotTransport.callTool("connector_action", { action: "list_audit" });
    return { sourceList, citation, sourceEvents, healthReport, connectorList, connectorHealth, connectorAudit };
  });

  expect(result.sourceList.sources[0].id).toBe("source:playwright-architecture-brief");
  expect(result.citation.text).toContain("architecture.md");
  expect(result.sourceEvents.access[0].action).toBe("retrieve");
  expect(result.healthReport.findings.map(finding => finding.issueType).sort()).toEqual(["degraded", "stale"]);
  expect(result.healthReport.connectorHealth[0].healthState).toBe("degraded");
  expect(result.connectorList.definitions.some(definition => definition.id === "connector-definition:workflow-governance")).toBe(true);
  expect(result.connectorList.instances.some(instance => instance.id === "connector-instance:postgres-readonly:local")).toBe(true);
  expect(result.connectorHealth.state).toBe("healthy");
  expect(result.connectorAudit.events[0].redactedInput.approvalToken).toBe("[redacted]");
});

test("governed architecture tools preserve records through the WebUI transport", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop governed architecture direct tool coverage");
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const plan = await window.matbotTransport.callTool("structured_data_action", {
      action: "plan_query",
      plan: {
        workspaceId: "default",
        metricName: "total_revenue",
        dimensions: ["data-column:orders:order_date"],
        filters: [{ columnId: "data-column:orders:status", op: "eq", value: "paid" }],
        limit: 200
      }
    });
    const approval = await window.matbotTransport.callTool("structured_data_action", {
      action: "approve_query",
      queryRunId: plan.queryRun.id
    });
    const executed = await window.matbotTransport.callTool("structured_data_action", {
      action: "execute_query",
      queryRunId: plan.queryRun.id,
      approvalToken: approval.approvalToken
    });
    const sourcesAfterExecution = await window.matbotTransport.callTool("source_action", { action: "list" });

    const compiled = await window.matbotTransport.callTool("workflow_action", {
      action: "compile",
      workspaceId: "default",
      name: "Compiled Followup",
      sourceIds: ["source:playwright-architecture-brief"],
      publish: true,
      dryRun: true
    });
    const started = await window.matbotTransport.callTool("workflow_action", {
      action: "start",
      workspaceId: "default",
      workflowId: compiled.published.definition.id,
      mode: "approval_gated",
      inputs: { ticketId: "T-123" },
      evidenceSourceIds: ["source:playwright-architecture-brief"]
    });
    const approvals = await window.matbotTransport.callTool("workflow_action", { action: "list_approvals" });
    const inspected = await window.matbotTransport.callTool("workflow_action", { action: "inspect_run", runId: started.id });

    const graph = await window.matbotTransport.callTool("context_graph_action", {
      action: "retrieve",
      workspaceId: "default",
      sourceIds: ["source:playwright-architecture-brief"],
      terms: ["Acme"]
    });

    const review = await window.matbotTransport.callTool("expert_panel", {
      action: "review",
      question: "Should this high-risk workflow be approved?",
      experts: ["finance", "engineering"],
      mode: "review",
      reviewMode: "pre_automation_review",
      targetType: "workflow",
      targetId: compiled.published.definition.id,
      workflowId: compiled.published.definition.id,
      workflowRunId: started.id,
      synthesize: true
    });
    const reviewLookup = await window.matbotTransport.callTool("expert_panel", {
      action: "get_review",
      reviewId: review.review.id
    });
    const reviewList = await window.matbotTransport.callTool("expert_panel", { action: "list_reviews" });

    return { plan, approval, executed, sourcesAfterExecution, compiled, started, approvals, inspected, graph, review, reviewLookup, reviewList };
  });

  expect(result.plan.validation.valid).toBe(true);
  expect(result.plan.rowCapWarning).toContain("row cap 50");
  expect(result.approval.queryRun.status).toBe("approved");
  expect(result.executed.run.status).toBe("succeeded");
  expect(result.executed.citation.text).toContain("Source tables/metrics");
  expect(result.sourcesAfterExecution.sources.some(source => source.sourceKind === "query_result")).toBe(true);

  expect(result.compiled.compilation.status).toBe("dry_run_completed");
  expect(result.compiled.published.definition.approvalGates.some(gate => gate.type === "expert_review")).toBe(true);
  expect(result.started.status).toBe("waiting_for_approval");
  expect(result.approvals.approvals.some(approval => approval.gateId === "structured-expert-review")).toBe(true);
  expect(result.inspected.events.map(event => event.sequence)).toEqual([1, 2]);

  expect(result.graph.facts[0].sourceId).toBe("source:playwright-architecture-brief");
  expect(result.graph.facts[0].citation.text).toContain("architecture.md");

  expect(result.review.review.workflowRunId).toBe(result.started.id);
  expect(result.review.review.riskRegister.length).toBeGreaterThan(0);
  expect(result.review.review.approvalChecklist.some(item => item.includes("automation rollback path confirmed"))).toBe(true);
  expect(result.reviewLookup.review.id).toBe(result.review.review.id);
  expect(result.reviewList.reviews.some(review => review.id === result.review.review.id)).toBe(true);
});

test("activates and deactivates compatible local plugins through the plugins panel", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop plugin activation coverage");
  await page.goto("/");
  await openPlugins(page);

  const backgroundInactive = page.locator(".plugin-entry-inactive", { hasText: "@matatbread/matbot-tool-background" });
  await expect(backgroundInactive).toBeVisible();
  await backgroundInactive.hover();
  await expect(backgroundInactive.getByTitle("Add plugin")).toBeVisible();
  await expect(page.locator(".plugin-incompatible", { hasText: "google-drive" }).getByTitle("Add plugin")).toHaveCount(0);

  await backgroundInactive.getByTitle("Add plugin").click();
  await expect(page.locator(".message.assistant").last()).toContainText("Added plugin");
  const backgroundActive = page.locator("details.plugin-entry", { hasText: "@matatbread/matbot-tool-background" });
  await expect(backgroundActive).toContainText("background_prompt");
  await expect(page.locator(".plugin-entry-inactive", { hasText: "@matatbread/matbot-tool-background" })).toHaveCount(0);

  await backgroundActive.hover();
  await backgroundActive.getByTitle("Remove plugin").click();
  await expect(page.locator(".message.assistant").last()).toContainText("Removed plugin");
  await expect(page.locator("details.plugin-entry", { hasText: "@matatbread/matbot-tool-background" })).toHaveCount(0);
  await expect(page.locator(".plugin-entry-inactive", { hasText: "@matatbread/matbot-tool-background" })).toBeVisible();
});

test("activates powershell plugin and invokes it through the WebUI transport", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop direct PowerShell tool coverage");
  await page.goto("/");
  await openPlugins(page);

  const powershellInactive = page.locator(".plugin-entry-inactive", { hasText: "@matatbread/matbot-tool-powershell" });
  await expect(powershellInactive).toBeVisible();
  await powershellInactive.hover();
  await powershellInactive.getByTitle("Add plugin").click();

  await expect(page.locator(".message.assistant").last()).toContainText("Added plugin");
  const powershellActive = page.locator("details.plugin-entry", { hasText: "@matatbread/matbot-tool-powershell" });
  await expect(powershellActive).toContainText("powershell");

  const result = await page.evaluate(async () => window.matbotTransport.callTool("powershell", {
    script: "Write-Output $env:MATBOT_PS_TEST",
    cwd: "C:\\Projects\\Cortex",
    env: { MATBOT_PS_TEST: "playwright-ok" },
    timeout: 5000
  }));

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("playwright-ok");
  expect(result.stdout).toContain("C:\\Projects\\Cortex");
  expect(result.invocation.executable).toBe("powershell.exe");
  expect(result.invocation.args).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "<temp.ps1>"]);
});

test("workspace selector lists, creates, renames, and switches workspaces", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workspace selector coverage");
  await page.goto("/");

  await expect(page.locator("#workspace-toggle-btn")).toContainText("Default");
  await page.locator("#workspace-toggle-btn").click();
  await expect(page.locator("#workspace-popover")).toHaveClass(/open/);
  await expect(page.locator("#workspace-list")).toContainText("Default");

  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("New workspace");
    await dialog.accept("Research");
  });
  await page.locator("#workspace-new-btn").click();
  await expect(page.locator("#workspace-list")).toContainText("Research");

  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("Rename workspace");
    await dialog.accept("Primary");
  });
  await page.locator("#workspace-rename-btn").click();
  await expect(page.locator("#workspace-toggle-btn")).toContainText("Primary");

  await page.locator(".workspace-option", { hasText: "Research" }).click();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("#workspace-toggle-btn")).toContainText("Research");

  await openPlugins(page);
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-workspace-rag");
  await expect(page.locator("#plugin-list")).toContainText("workspace_rag");

  await page.evaluate(async () => window.matbotTransport.switchWorkspace("default"));
});

test("workspace RAG configuration panel saves paths and shows indexing progress", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workspace RAG coverage");
  await page.goto("/");

  await expect(page.locator("#workspace-context-row")).toHaveCount(0);
  await expect(page.locator("#workspace-toggle-btn #workspace-chevron")).toBeVisible();
  await page.locator("#workspace-config-btn").click();
  await expect(page.locator("#workspace-settings-screen")).toHaveClass(/open/);
  await expect(page.locator("#messages")).not.toBeVisible();
  await expect(page.locator("#input-area")).not.toBeVisible();
  await expect(page.locator("#workspace-context-name")).toHaveValue("Default");
  await expect(page.locator("#workspace-rag-paths")).toHaveValue(/C:\\Projects\\Cortex\\docs/);
  await expect(page.locator("#workspace-rag-status")).toContainText("idle");
  await expect(page.locator("#workspace-rag-status")).toContainText("CPU");
  await expect(page.locator("#workspace-rag-save-btn")).toBeDisabled();
  await expect(page.locator("#workspace-rag-save-btn")).toHaveCSS("background-color", "rgb(208, 213, 221)");
  await expect(page.locator("#workspace-rag-save-btn")).toHaveCSS("color", "rgb(102, 112, 133)");

  await page.locator("#workspace-context-name").fill("Discarded Notes");
  await expect(page.locator("#workspace-rag-save-btn")).toBeEnabled();
  await expect(page.locator("#workspace-rag-save-btn")).toHaveCSS("background-color", "rgb(37, 99, 235)");
  await expect(page.locator("#workspace-rag-save-btn")).toHaveCSS("color", "rgb(255, 255, 255)");
  await page.locator("#workspace-settings-cancel-btn").click();
  await expect(page.locator("#workspace-settings-screen")).not.toHaveClass(/open/);
  await expect(page.locator("#messages")).toBeVisible();

  await page.locator("#workspace-config-btn").click();
  await expect(page.locator("#workspace-settings-screen")).toHaveClass(/open/);
  await expect(page.locator("#workspace-context-name")).toHaveValue("Default");
  await expect(page.locator("#workspace-rag-save-btn")).toBeDisabled();
  await page.locator("#workspace-context-name").fill("Engineering Notes");
  await page.locator("#workspace-rag-paths").fill("C:\\Projects\\Cortex\\docs\nD:\\Knowledge");
  await expect(page.locator("#workspace-rag-save-btn")).toBeEnabled();
  await page.locator("#workspace-rag-save-btn").click();
  await expect(page.locator("#workspace-settings-screen")).toHaveClass(/open/);
  await expect(page.locator("#input-area")).not.toBeVisible();
  await expect(page.locator("#workspace-rag-save-btn")).toBeDisabled();
  await expect(page.locator("#workspace-rag-status")).toContainText("indexing");
  await expect(page.locator("#workspace-rag-status")).toContainText("67%");
  await expect(page.locator("#workspace-rag-current-file")).toContainText("retrieval-probe.md");

  await page.evaluate(async () => window.matbotTransport.callTool("workspace_rag", { action: "reindex_now" }));
  await expect(page.locator("#workspace-rag-status")).toContainText("idle");
  await expect(page.locator("#workspace-rag-current-file")).toHaveText("");
  await expect(page.locator("#workspace-rag-current-file")).toHaveAttribute("title", "");
});

test("remembered facts persist across conversations and are used in later answers", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop memory coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");

  await page.locator("#input").fill("Memorize my name: Maciej Zagozda");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Harness response");

  const facts = await page.evaluate(async () => window.matbotTransport.callTool("remembered_facts_action", { action: "query", query: {} }));
  expect(facts.items.some(fact => fact.fact.includes("Maciej Zagozda"))).toBeTruthy();

  await page.locator("#new-btn").click();
  await page.locator("#input").fill("What is my name?");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Maciej Zagozda");
});

test("memory sidebar affordance opens the in-page memory browser", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop memory browser coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");

  await page.locator("#input").fill("Memorize this: The memory browser launcher token is Violet.");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Harness response");

  await openMemorySection(page);
  await expect(page.locator("#memory-browser-btn")).toBeVisible();

  const popups = [];
  page.on("popup", popup => popups.push(popup));
  await page.locator("#memory-browser-btn").click();
  await expect(page.locator("#memory-browser-overlay")).toHaveClass(/open/);
  await expect(page.locator("#memory-browser-title")).toHaveText("Memories");

  await page.locator("#memory-browser-search").fill("Violet");
  await page.locator("#memory-browser-search").press("Enter");
  await expect(page.locator("#memory-browser-list")).toContainText("memory browser launcher token is Violet");
  await page.waitForTimeout(100);
  expect(popups).toHaveLength(0);
  await expect(page.locator("#memory-browser-status")).toHaveText("");
});

test("in-page memory browser can create, edit, search, and delete memories", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop memory browser CRUD coverage");
  await page.goto("/");

  await openMemorySection(page);
  await page.locator("#memory-browser-btn").click();
  await expect(page.locator("#memory-browser-overlay")).toHaveClass(/open/);

  await page.locator("#memory-browser-new-fact").fill("The memory browser CRUD probe is Copper.");
  await page.locator("#memory-browser-add").click();
  await expect(page.locator("#memory-browser-panel-status")).toContainText("Added");
  await expect(page.locator("#memory-browser-list")).toContainText("CRUD probe is Copper");
  await expect(page.locator("#memory-browser-fact-input")).toHaveValue("The memory browser CRUD probe is Copper.");

  await page.locator("#memory-browser-fact-input").fill("The memory browser CRUD probe is Copper, revised.");
  await page.locator("#memory-browser-dream-skill").fill("Operations");
  await page.locator("#memory-browser-save").click();
  await expect(page.locator("#memory-browser-panel-status")).toContainText("Saved");
  await expect(page.locator("#memory-browser-state")).toHaveText("processed");

  await page.locator("#memory-browser-search").fill("Copper, revised");
  await page.locator("#memory-browser-search").press("Enter");
  await expect(page.locator("#memory-browser-list")).toContainText("Copper, revised");

  page.once("dialog", dialog => dialog.accept());
  await page.locator("#memory-browser-delete").click();
  await expect(page.locator("#memory-browser-panel-status")).toContainText("Deleted");
  await expect(page.locator("#memory-browser-list")).not.toContainText("Copper, revised");
});

test("direct cognition tool calls can receive session and provider context", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop direct cognition tool coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");

  await page.locator("#input").fill("The direct recall token is Helix.");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Harness response");

  const sessionId = await page.locator(".session-item.active").getAttribute("data-sid");
  expect(sessionId).toBeTruthy();

  const withoutContextError = await page.evaluate(async () => {
    try {
      await window.matbotTransport.callTool("dream_time", {});
      return "";
    } catch (error) {
      return String(error.message || error);
    }
  });
  expect(withoutContextError).toContain("dream_time needs provider context");

  const rememberResult = await page.evaluate(async sid => window.matbotTransport.callTool("remember_fact", {
    $context: { sessionId: sid, provider: "openai" },
    input: {}
  }), sessionId);
  expect(rememberResult.ok).toBe(true);
  expect(rememberResult.markers?.[0]?.creator).toBe("remember_fact");

  const facts = await page.evaluate(async () => window.matbotTransport.callTool("remembered_facts_action", { action: "query", query: {} }));
  expect(facts.items.some(fact => fact.fact.includes("Helix"))).toBeTruthy();

  const dreamRun = await page.evaluate(async () => window.matbotTransport.callTool("dream_time", {
    $context: { provider: "openai" },
    input: {}
  }));
  expect(dreamRun.provider).toBe("openai");

  const innerVoice = await page.evaluate(async () => window.matbotTransport.callTool("ask_inner_voice", {
    $context: { provider: "openai" },
    input: { prompt: "Critique this direct tool test." }
  }));
  expect(innerVoice.text).toContain("openai");
});

test("contextual search returns remembered facts with workspace RAG context", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop contextual memory coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");

  await page.locator("#input").fill("Memorize this: The QuasarPump owner is Maciej.");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".message.assistant:not(.marker-block)").last()).toContainText("Workspace RAG says");

  const result = await page.evaluate(async () => window.matbotTransport.callTool("contextual_search", {
    terms: [{ term: "QuasarPump", context: "Who owns the QuasarPump and what local RAG context exists?" }]
  }));

  expect(result.name).toBe("remembered_facts");
  expect(result.content).toContain("Remembered facts:");
  expect(result.content).toContain("The QuasarPump owner is Maciej.");
  expect(result.content).toContain("Workspace RAG results");
  expect(result.content).toContain("probe.md");
});

test("workspace RAG markdown context is automatically used during a conversation", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workspace RAG retrieval coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");

  await page.locator("#input").fill("What is the QuasarPump calibration value?");
  await page.keyboard.press("Shift+Enter");

  await expect(page.locator(".marker-block")).toContainText("workspace-rag");
  const answer = page.locator(".message.assistant:not(.marker-block)").last();
  await expect(answer).toContainText("QuasarPump calibration value is 42");
  await expect(answer).toContainText("amber valve");
});

test("composer expert panel asks all experts and renders synthesis", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop expert-panel coverage");
  await page.goto("/");
  await openExperts(page);

  await expect(page.locator("#expert-popover")).toHaveClass(/open/);
  await expect(page.locator("#expert-panel")).toContainText("Use experts");
  await expect(page.locator("#expert-enabled")).toHaveCSS("border-top-style", "solid");
  await expect(page.locator("#expert-enabled")).toHaveCSS("border-radius", "5px");
  await expect(page.locator("#expert-enabled")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator("#expert-mode")).toHaveCSS("padding-right", "28px");
  await expect(page.locator("#expert-mode")).toHaveCSS("border-radius", "10px");
  const expertModeBackground = await page.locator("#expert-mode").evaluate(el => getComputedStyle(el).backgroundImage);
  expect(expertModeBackground).not.toBe("none");
  await expect(page.locator("#expert-list")).toContainText("Design Expert");
  await expect(page.locator("#expert-list")).toContainText("Finance Expert");
  await expect(page.locator("#expert-list")).toContainText("Engineering Expert");
  await expect(page.locator("#expert-all")).toBeChecked();
  const checkedExpertAllBackground = await page.locator("#expert-all").evaluate(el => getComputedStyle(el).backgroundImage);
  expect(checkedExpertAllBackground).not.toBe("none");

  await page.locator("#expert-enabled").check();
  await page.locator("#expert-mode").selectOption("review");
  await page.locator("#input").fill("Should the panel ship this feature?");
  await page.locator("#send-btn").click();

  await expect(page.locator(".message.user").last()).toContainText("Experts: all");
  const answer = page.locator(".message.assistant").last();
  await expect(answer).toContainText("Design Expert answer");
  await expect(answer).toContainText("Finance Expert answer");
  await expect(answer).toContainText("Engineering Expert answer");
  await expect(answer).toContainText("Synthesis for design, finance, engineering");
  await expect(page.locator("#expert-status")).toContainText("Complete");
  await expect(page.locator("#input")).toHaveValue("");

  const sid = await page.locator(".session-item.active").getAttribute("data-sid");
  const stored = await page.evaluate(async sessionId => {
    const response = await fetch("/tools/session_action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "get", sessionId })
    });
    return response.json();
  }, sid);
  expect(stored.messages.filter(message => message.role === "user").at(-1).content[0].text).toContain("Should the panel ship this feature?");
  expect(stored.messages.filter(message => message.role === "assistant").at(-1).content[0].text).toContain("Synthesis for design, finance, engineering");

  await page.reload();
  await expect(page.locator(".message.user").last()).toContainText("Experts: all");
  const reloadedAnswer = page.locator(".message.assistant").last();
  await expect(reloadedAnswer).toContainText("Design Expert answer");
  await expect(reloadedAnswer).toContainText("Synthesis for design, finance, engineering");
});

test("composer expert panel can run selected experts without synthesis", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop expert-panel coverage");
  await page.goto("/");
  await openExperts(page);

  await page.locator("#expert-enabled").check();
  await page.locator("#expert-all").uncheck();
  await page.locator(".expert-option", { hasText: "Design Expert" }).locator("input").check();
  await page.locator(".expert-option", { hasText: "Engineering Expert" }).locator("input").check();
  await page.locator("#expert-synthesize").uncheck();
  await page.locator("#expert-mode").selectOption("debate");
  await page.locator("#input").fill("Compare only the selected perspectives.");
  await page.locator("#send-btn").click();

  await expect(page.locator(".message.user").last()).toContainText("Experts: design, engineering");
  const answer = page.locator(".message.assistant").last();
  await expect(answer).toContainText("Design Expert answer");
  await expect(answer).toContainText("Engineering Expert answer");
  await expect(answer).not.toContainText("Finance Expert answer");
  await expect(answer).not.toContainText("Synthesis for");
});

test("creates a conversation, sends a message, renders streaming output, tools, and usage", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop chat coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");

  await page.locator("#input").fill("hello panel");
  await page.keyboard.press("Shift+Enter");

  await expect(page.locator(".message.user")).toContainText("hello panel");
  await expect(page.locator(".thinking-block")).toContainText("Checking harness state");
  await expect(page.locator(".tool-block")).toContainText("expert_panel");
  await expect(page.locator(".tool-result")).toContainText('"ok": true');
  await expect(page.locator(".message.assistant")).toContainText("Harness response to: hello panel");
  await expect(page.locator(".token-stats")).toContainText("tokens");
  await expect(page.locator(".token-stats > summary")).toContainText(/\d+(?:\.\d+)?s/);
});

test("handles interactive prompt controls over the session event stream", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop prompt coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");
  await page.locator("#input").fill("prompt me");
  await page.keyboard.press("Shift+Enter");

  await expect(page.locator(".prompt-block")).toContainText("Choose a test answer");
  await expect(page.getByRole("button", { name: "Alpha" })).toHaveCSS("background-color", "rgb(37, 99, 235)");
  await expect(page.getByRole("button", { name: "Alpha" })).toHaveCSS("color", "rgb(255, 255, 255)");
  await page.getByRole("button", { name: "Beta" }).click();
  await expect(page.locator(".message.assistant")).toContainText("Prompt answer received: Beta");
});

test("uploads and deletes workspace files through the files panel", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop files coverage");
  await page.goto("/");

  await page.setInputFiles("#upload-input", {
    name: "playwright-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello from playwright", "utf8")
  });

  const uploaded = page.locator('[data-path="playwright-note.txt"]');
  await expect(uploaded).toContainText("playwright-note.txt");
  await uploaded.hover();
  await uploaded.locator(".file-action-btn").click();
  await expect(uploaded).toHaveCount(0);
});

test("opens skill editor, shows metadata and trigger controls, and saves", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop skill editor coverage");
  await page.addInitScript(() => {
    window.TinyMDE = {
      Editor: class {
        constructor({ textarea }) {
          this.textarea = typeof textarea === "string" ? document.getElementById(textarea) : textarea;
        }
        setContent(value) {
          this.textarea.value = value;
        }
        getContent() {
          return this.textarea.value;
        }
      },
      CommandBar: class {}
    };
  });
  await page.goto("/");
  await openSkills(page);
  await page.locator(".skill-entry", { hasText: "Panel Etiquette" }).click();

  await expect(page.locator("#skill-editor-overlay")).toHaveClass(/open/);
  await expect(page.locator("#skill-editor-title")).toHaveText("Panel Etiquette");

  await page.getByRole("button", { name: "Metadata" }).click();
  await expect(page.locator("#skill-metadata")).toContainText("How to run expert-panel conversations");
  await expect(page.locator("#skill-metadata")).toContainText("expert_panel");
  await expect(page.locator("#skill-editor-save")).toHaveCSS("background-color", "rgb(37, 99, 235)");
  await expect(page.locator("#skill-editor-save")).toHaveCSS("color", "rgb(255, 255, 255)");

  await page.getByRole("button", { name: "Triggers" }).click();
  await expect(page.locator(".trigger-row").first().locator(".trigger-text")).toHaveValue(/MATCH when the user asks/);
  await page.locator("#skill-trigger-add").click();
  await page.locator(".trigger-row").last().locator(".trigger-text").fill("MATCH when this Playwright trigger is saved.");

  await page.locator("#skill-editor-save").click();
  await expect(page.locator("#skill-editor-overlay")).not.toHaveClass(/open/);
});

test("renames, hides, and marks sessions via sidebar controls", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop sidebar action coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  const active = page.locator(".session-item.active");
  await expect(active).toBeVisible();

  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("Rename session");
    await dialog.accept("Renamed in Playwright");
  });
  await active.hover();
  await active.getByTitle("Rename").click();
  await expect(page.locator("#session-list")).toContainText("Renamed in Playwright");

  await page.locator(".session-item", { hasText: "Renamed in Playwright" }).hover();
  await page.locator(".session-item", { hasText: "Renamed in Playwright" }).getByTitle("Hide").click();
  await expect(page.locator("#session-list")).not.toContainText("Renamed in Playwright");
});

test("shows stop control while a turn is busy and aborts the running turn", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop stop-control coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");
  await page.locator("#input").fill("slow response please");
  await page.keyboard.press("Shift+Enter");

  await expect(page.locator("#send-btn")).toHaveClass(/stop-mode/);
  await expect(page.locator("#send-btn")).toHaveCSS("width", "21px");
  await expect(page.locator("#send-btn")).toHaveCSS("height", "21px");
  const stopShadow = await page.locator("#send-btn").evaluate(el => getComputedStyle(el).boxShadow);
  expect(stopShadow).toContain("31, 35, 40");
  expect(stopShadow).not.toContain("220, 38, 38");
  await expect(page.locator("#stop-btn")).toHaveCSS("display", "none");
  await page.locator("#send-btn").click();
  await expect(page.locator("#send-btn")).not.toHaveClass(/stop-mode/);
});

test("mobile layout exposes the sidebar through the burger button", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile-only behavior");

  await page.goto("/");
  await expect(page.locator("body")).not.toHaveClass(/sidebar-open/);
  await page.locator("#burger").click();
  await expect(page.locator("body")).toHaveClass(/sidebar-open/);
  await expect(page.locator("#session-list")).toContainText(/Conversation/);
});
