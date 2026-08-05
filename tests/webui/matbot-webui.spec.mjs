import { expect, test } from "@playwright/test";

const uncaughtPageErrors = new WeakMap();

test.beforeEach(async ({ page, request }) => {
  const reset = await request.post("/__test/reset-memory");
  expect(reset.ok(), "test harness memory reset").toBeTruthy();
  const errors = [];
  uncaughtPageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(uncaughtPageErrors.get(page) ?? [], "uncaught browser errors").toEqual([]);
});

async function openPlugins(page) {
  const section = page.locator('[data-section="plugins"]');
  const classes = await section.getAttribute("class");
  if (classes?.includes("collapsed")) {
    await section.locator(".sidebar-heading").click();
  }
}

async function openSkills(page) {
  const section = page.locator('[data-section="skills"]');
  const classes = await section.getAttribute("class");
  if (classes?.includes("collapsed")) {
    await section.locator(".sidebar-heading").click();
  }
}

async function openExperts(page) {
  await page.locator("#expert-toggle-btn").click();
}

async function openArchitecturePanel(page, view) {
  const section = page.locator('[data-section="architecture"]');
  const classes = await section.getAttribute("class");
  if (classes?.includes("collapsed")) {
    await section.locator(".sidebar-heading").click();
  }
  await page.locator(`.architecture-nav-btn[data-architecture-view="${view}"]`).click();
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

test("persists provider and font preferences across reloads", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop preference controls coverage");
  await page.goto("/");

  await page.locator("#provider-select").selectOption("Local");
  const initialSize = await page.locator("body").evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  await page.locator("#fs-up").click();
  const increasedSize = await page.locator("body").evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  expect(increasedSize).toBeGreaterThan(initialSize);

  await page.reload();
  await expect(page.locator("#provider-select")).toHaveValue("Local");
  await expect.poll(() => page.locator("body").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(increasedSize);
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

test("keeps only one Files, Architecture, Plugins, or Skills section expanded", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop sidebar accordion coverage");
  await page.goto("/");

  const expandedSections = page.locator(
    '.sidebar-section:is([data-section="files"], [data-section="architecture"], [data-section="plugins"], [data-section="skills"]):not(.collapsed)'
  );

  await expect(page.locator('[data-section="files"]')).not.toHaveClass(/collapsed/);
  await expect(expandedSections).toHaveCount(1);

  await page.locator('[data-section="architecture"] .sidebar-heading').click();
  await expect(page.locator('[data-section="architecture"]')).not.toHaveClass(/collapsed/);
  await expect(page.locator('[data-section="files"]')).toHaveClass(/collapsed/);
  await expect(expandedSections).toHaveCount(1);

  await page.locator('[data-section="plugins"] .sidebar-heading').click();
  await expect(page.locator('[data-section="plugins"]')).not.toHaveClass(/collapsed/);
  await expect(page.locator('[data-section="architecture"]')).toHaveClass(/collapsed/);
  await expect(expandedSections).toHaveCount(1);

  await page.locator('[data-section="plugins"] .sidebar-heading').click();
  await expect(expandedSections).toHaveCount(0);

  await page.evaluate(() => {
    localStorage.setItem("sidebarSections", JSON.stringify({
      conversations: false,
      files: false,
      architecture: false,
      plugins: false,
      skills: false
    }));
  });
  await page.reload();

  await expect(page.locator('[data-section="files"]')).not.toHaveClass(/collapsed/);
  await expect(page.locator('[data-section="architecture"]')).toHaveClass(/collapsed/);
  await expect(page.locator('[data-section="plugins"]')).toHaveClass(/collapsed/);
  await expect(page.locator('[data-section="skills"]')).toHaveClass(/collapsed/);
  await expect(expandedSections).toHaveCount(1);
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

test("MISSING-13 architecture source and connector health tools work through the WebUI transport", async ({ page, isMobile }) => {
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

test("architecture product panels expose sources, SQL approval, workflow approvals, graph evidence, and review cards", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop architecture panel coverage");
  const architectureListRequests = [];
  page.on("request", request => {
    if (!request.url().includes("/tools/")) return;
    const input = request.postDataJSON();
    if (input?.action !== "list") return;
    const tool = request.url().split("/").at(-1);
    if (tool === "source_action" || tool === "context_graph_action") {
      architectureListRequests.push({ tool, input });
    }
  });
  await page.goto("/");

  const workflowRunId = await page.evaluate(async () => {
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
    return started.id;
  });

  await openArchitecturePanel(page, "sources");
  await expect(page.locator("#architecture-screen")).toBeVisible();
  await expect(page.locator("#architecture-title")).toContainText("Sources");
  await expect(page.locator("#architecture-source-list")).toContainText("architecture.md");
  await expect(page.locator("#architecture-source-detail")).toContainText("Citation");
  await expect(page.locator("#architecture-source-detail")).toContainText("stale");
  await expect(page.locator("#architecture-source-list .architecture-badge", { hasText: "unhealthy" })).toHaveClass(/bad/);

  const sourcesTab = page.getByRole("tab", { name: "Sources" });
  await expect(sourcesTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Sources" })).toBeVisible();
  await sourcesTab.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "SQL Preview" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "SQL Preview" })).toBeVisible();

  await page.locator("#architecture-sql-plan-btn").click();
  await expect(page.locator("#architecture-sql-preview")).toContainText("SELECT");
  await expect(page.locator("#architecture-sql-results")).toContainText("row cap 50");
  await expect(page.locator("#architecture-sql-approve-btn")).toBeEnabled();
  await page.locator("#architecture-sql-approve-btn").click();
  await expect(page.locator("#architecture-sql-execute-btn")).toBeEnabled();
  await page.locator("#architecture-sql-execute-btn").click();
  await expect(page.locator("#architecture-sql-results")).toContainText("total_revenue");
  await expect(page.locator("#architecture-sql-results")).toContainText("Source tables/metrics");

  await page.locator('.architecture-tab[data-architecture-tab="workflows"]').click();
  await page.locator('.workflow-ops-tab[data-workflow-ops-view="approvals"]').click();
  await expect(page.locator("#architecture-approval-list")).toContainText("structured-expert-review");
  await page.locator(`#architecture-approval-list .architecture-item[data-run-id="${workflowRunId}"][data-approval-id="approval:expert-review"]`).click();
  await expect(page.locator("#architecture-approval-detail")).toContainText(workflowRunId);
  await expect(page.locator("#architecture-approval-detail")).toContainText("Proposed Actions");
  await page.locator("#architecture-approval-detail").getByRole("button", { name: "Approve" }).click();
  await expect(page.locator("#architecture-approval-detail")).toContainText("approved");

  await page.locator('.architecture-tab[data-architecture-tab="graph"]').click();
  await expect(page.locator("#architecture-graph-list")).toContainText("Acme Corp");
  await page.locator("#architecture-graph-retrieve").click();
  await expect(page.locator("#architecture-graph-detail")).toContainText("Ticket 123");
  await expect(page.locator("#architecture-graph-detail")).toContainText("architecture.md");

  await page.locator('.architecture-tab[data-architecture-tab="reviews"]').click();
  await page.locator("#architecture-review-run-id").fill(workflowRunId);
  await page.locator("#architecture-review-create-btn").click();
  await expect(page.locator("#architecture-review-list")).toContainText("Should this high-risk workflow be approved?");
  await expect(page.locator("#architecture-review-detail")).toContainText("Finance Expert");
  await expect(page.locator("#architecture-review-detail")).toContainText("automation rollback path confirmed");
  await expect(page.locator("#architecture-review-detail")).toContainText("Risk Register");

  expect(architectureListRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({
      tool: "source_action",
      input: expect.objectContaining({ query: { where: { op: "eq", field: "workspaceId", value: "default" } } })
    }),
    expect.objectContaining({
      tool: "context_graph_action",
      input: expect.objectContaining({ query: { where: { op: "eq", field: "workspaceId", value: "default" } } })
    })
  ]));
});

test("MISSING-15 applies install-scoped branding consistently without unsafe HTML", async ({ page }) => {
  await page.route("**/branding", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    productName: "Northstar", title: "Northstar Console", brand: "#123abc", brandStrong: "#102030", brandSoft: "#eaf1ff",
  }) }));
  await page.goto("/");
  await expect(page.locator("#brand-title")).toHaveText("Northstar");
  await expect(page.locator("#input")).toHaveAttribute("placeholder", "Ask Northstar...");
  await expect(page).toHaveTitle("Northstar Console");
  await expect(page.locator("html")).toHaveCSS("--brand", "#123abc");
});

test("architecture sources render before the health report finishes", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop regression coverage");
  await page.route("**/tools/source_health_action", async route => {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    await route.continue();
  });
  await page.goto("/");

  await openArchitecturePanel(page, "sources");

  await expect(page.locator("#architecture-source-list")).toContainText("architecture.md", { timeout: 2_000 });
  await expect(page.locator("#architecture-source-status")).not.toHaveText("Loading sources...", { timeout: 2_000 });
});

test("architecture SQL actions recover from transient approval and execution failures", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop architecture recovery coverage");
  let failPlanning = true;
  let failApproval = true;
  let failExecution = true;
  await page.route("**/tools/structured_data_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "plan_query" && failPlanning) {
      failPlanning = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary planning failure" }) });
      return;
    }
    if (input.action === "approve_query" && failApproval) {
      failApproval = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary approval failure" }) });
      return;
    }
    if (input.action === "execute_query" && failExecution) {
      failExecution = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary execution failure" }) });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  await openArchitecturePanel(page, "sql");
  await page.locator("#architecture-sql-plan-btn").click();
  await expect(page.locator("#architecture-sql-status")).toContainText("temporary planning failure");
  await expect(page.locator("#architecture-sql-plan-btn")).toBeEnabled();
  await page.locator("#architecture-sql-plan-btn").click();
  await expect(page.locator("#architecture-sql-approve-btn")).toBeEnabled();

  await page.locator("#architecture-sql-approve-btn").click();
  await expect(page.locator("#architecture-sql-status")).toContainText("temporary approval failure");
  await expect(page.locator("#architecture-sql-approve-btn")).toBeEnabled();
  await page.locator("#architecture-sql-approve-btn").click();
  await expect(page.locator("#architecture-sql-execute-btn")).toBeEnabled();

  await page.locator("#architecture-sql-execute-btn").click();
  await expect(page.locator("#architecture-sql-status")).toContainText("temporary execution failure");
  await expect(page.locator("#architecture-sql-execute-btn")).toBeEnabled();
  await page.locator("#architecture-sql-execute-btn").click();
  await expect(page.locator("#architecture-sql-results")).toContainText("total_revenue");
});

test("architecture graph retrieval selects the returned entity instead of stale list state", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop graph result selection coverage");
  await page.route("**/tools/context_graph_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action !== "retrieve") return route.fallback();
    const entity = {
      id: "context-entity:retrieved-customer",
      version: "retrieved-version",
      workspaceId: "default",
      type: "organization",
      canonicalName: "Retrieved Customer",
      aliases: ["RC"],
      sensitivity: "internal",
      updatedAt: new Date().toISOString()
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entities: [entity], facts: [], warnings: [] })
    });
  });

  await page.goto("/");
  await openArchitecturePanel(page, "graph");
  await page.locator("#architecture-graph-search").fill("Retrieved Customer");
  await page.locator("#architecture-graph-retrieve").click();

  await expect(page.locator("#architecture-graph-status")).toContainText("Retrieved 0 fact(s)");
  await expect(page.locator("#architecture-graph-detail").getByRole("heading", { name: "Retrieved Customer" })).toBeVisible();
  await expect(page.locator("#architecture-graph-list .architecture-item.active")).toContainText("Retrieved Customer");

  await page.locator("#architecture-graph-refresh").click();
  await expect(page.locator("#architecture-graph-list")).not.toContainText("Retrieved Customer");
  await expect(page.locator("#architecture-graph-detail").getByRole("heading", { name: "Acme Corp" })).toBeVisible();
});

test("workflow rejection is idempotent under a rapid double click", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow decision coverage");
  let rejectRequests = 0;
  await page.route("**/tools/workflow_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "reject") {
      rejectRequests += 1;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await route.fallback();
  });

  await page.goto("/");
  const runId = await page.evaluate(async () => {
    const compiled = await window.matbotTransport.callTool("workflow_action", {
      action: "compile",
      workspaceId: "default",
      name: "Reject Once",
      sourceIds: ["source:playwright-architecture-brief"],
      publish: true,
      dryRun: true
    });
    const started = await window.matbotTransport.callTool("workflow_action", {
      action: "start",
      workspaceId: "default",
      workflowId: compiled.published.definition.id,
      mode: "approval_gated",
      inputs: {},
      evidenceSourceIds: ["source:playwright-architecture-brief"]
    });
    return started.id;
  });

  await openArchitecturePanel(page, "workflows");
  await page.locator('.workflow-ops-tab[data-workflow-ops-view="approvals"]').click();
  await page.locator(`#architecture-approval-list .architecture-item[data-run-id="${runId}"]`).first().click();
  await expect(page.locator("#architecture-approval-detail").getByRole("button", { name: "Reject" })).toBeEnabled();
  await page.locator("#architecture-approval-detail").evaluate(detail => {
    const button = [...detail.querySelectorAll("button")].find(candidate => candidate.textContent === "Reject");
    button.click();
    button.click();
  });

  await expect(page.locator("#architecture-approval-detail")).toContainText("rejected");
  expect(rejectRequests).toBe(1);
});

test("workflow operations center summarizes library, runs, approvals, and shadow outcomes", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow operations coverage");
  await page.goto("/");

  const seeded = await page.evaluate(async () => {
    const compiled = await window.matbotTransport.callTool("workflow_action", {
      action: "compile",
      workspaceId: "default",
      name: "Invoice Risk Review",
      purpose: "Review invoices against governed evidence.",
      sourceIds: ["source:playwright-architecture-brief"],
      toolCalls: [{ toolName: "file_broker_action", capability: "write", sourceIds: ["source:playwright-architecture-brief"] }],
      riskLevel: "high",
      successMetrics: ["invoice reviewed"],
      publish: true,
      dryRun: true
    });
    const approvalRun = await window.matbotTransport.callTool("workflow_action", {
      action: "start",
      workspaceId: "default",
      workflowId: compiled.published.definition.id,
      workflowVersion: compiled.published.definition.version,
      mode: "approval_gated",
      inputs: { invoiceId: "INV-42" },
      evidenceSourceIds: ["source:playwright-architecture-brief"]
    });
    const shadowRun = await window.matbotTransport.callTool("workflow_action", {
      action: "start",
      workspaceId: "default",
      workflowId: compiled.published.definition.id,
      workflowVersion: compiled.published.definition.version,
      mode: "shadow",
      inputs: { invoiceId: "INV-43" },
      evidenceSourceIds: ["source:playwright-architecture-brief"]
    });
    await window.matbotTransport.callTool("workflow_action", {
      action: "compare_shadow_result",
      runId: shadowRun.id,
      labels: ["accepted"],
      note: "Human reviewer agreed."
    });
    return { compilationId: compiled.compilation.id, workflowId: compiled.published.definition.id, approvalRunId: approvalRun.id, shadowRunId: shadowRun.id };
  });

  await openArchitecturePanel(page, "workflows");
  await expect(page.locator("#architecture-title")).toHaveText("Workflow Operations Center");
  await expect(page.locator("#workflow-ops-workflow-count")).toHaveText("1");
  await expect(page.locator("#workflow-ops-run-count")).toHaveText("3");
  await expect(page.locator("#workflow-ops-pending-count")).toHaveText("2");
  await expect(page.locator("#workflow-ops-acceptance-rate")).toHaveText("100%");
  await expect(page.locator("#workflow-ops-attention")).toContainText("Pending approvals");
  await expect(page.locator("#workflow-ops-recent-runs")).toContainText(seeded.workflowId);

  await page.locator('.workflow-ops-tab[data-workflow-ops-view="library"]').click();
  await page.locator(`#workflow-ops-library-list .architecture-item[data-compilation-id="${seeded.compilationId}"]`).click();
  await expect(page.locator("#workflow-ops-library-detail")).toContainText("Invoice Risk Review");
  await expect(page.locator("#workflow-ops-library-detail")).toContainText("invoice reviewed");
  await expect(page.locator("#workflow-ops-library-detail").getByRole("button", { name: "Start approval-gated run" })).toBeEnabled();

  await page.locator('.workflow-ops-tab[data-workflow-ops-view="runs"]').click();
  await page.locator(`#workflow-ops-run-list .architecture-item[data-run-id="${seeded.approvalRunId}"]`).click();
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("Typed inputs");
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("INV-42");
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("Run Ledger");
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("approval_requested");

  await page.locator('.workflow-ops-tab[data-workflow-ops-view="approvals"]').click();
  await expect(page.locator(`#architecture-approval-list .architecture-item[data-run-id="${seeded.approvalRunId}"]`)).toHaveCount(2);

  await page.locator('.workflow-ops-tab[data-workflow-ops-view="shadow"]').click();
  await expect(page.locator(`#workflow-ops-shadow-list .architecture-item[data-run-id="${seeded.shadowRunId}"]`)).toHaveCount(0);
  await expect(page.locator("#workflow-ops-shadow-list")).toContainText("No unlabeled shadow runs");
  await expect(page.locator("#workflow-ops-shadow-readiness")).toContainText("Accepted");
  await expect(page.locator("#workflow-ops-shadow-readiness")).toContainText("1");
});

test("E2E-016 workflow compiler publishes a library entry and starts an approval-gated run", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow compiler coverage");
  await page.goto("/");
  await openArchitecturePanel(page, "workflows");
  await page.locator('.workflow-ops-tab[data-workflow-ops-view="library"]').click();

  await page.locator("#workflow-ops-compile-name").fill("Customer Escalation Review");
  await page.locator("#workflow-ops-compile-transcript").fill("Review {{customerId}} and propose a governed escalation.");
  await page.locator("#workflow-ops-compile-risk").selectOption("high");
  await page.locator("#workflow-ops-compile-sources").fill("source:playwright-architecture-brief");
  await page.locator("#workflow-ops-compile-tool").fill("file_broker_action");
  await page.locator("#workflow-ops-compile-form").getByRole("button", { name: "Compile workflow" }).click();

  await expect(page.locator("#architecture-workflow-status")).toContainText("compiled, published, and smoke-tested");
  const libraryItem = page.locator("#workflow-ops-library-list .architecture-item", { hasText: "Customer Escalation Review" });
  await expect(libraryItem).toBeVisible();
  await libraryItem.click();
  await expect(page.locator("#workflow-ops-library-detail")).toContainText("structured-expert-review");
  await expect(page.locator("#workflow-ops-workflow-count")).toHaveText("1");

  await page.locator("#workflow-ops-library-search").fill("not-a-workflow");
  await expect(page.locator("#workflow-ops-library-list")).toContainText("No compiled workflows");
  await page.locator("#workflow-ops-library-search").fill("Customer Escalation");
  await expect(libraryItem).toBeVisible();
  await libraryItem.click();

  await page.locator("#workflow-ops-library-detail").getByRole("button", { name: "Start approval-gated run" }).click();
  await expect(page.locator('.workflow-ops-tab[data-workflow-ops-view="runs"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("approval_gated");
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("waiting_for_approval");
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("structured-expert-review");

  await page.locator('.workflow-ops-tab[data-workflow-ops-view="approvals"]').click();
  await expect(page.locator("#architecture-approval-list")).toContainText("Write/admin tool requires approval");
});

test("MISSING-08 workflow shadow lab records a human outcome and refreshes readiness metrics", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow shadow coverage");
  await page.goto("/");
  const shadowRunId = await page.evaluate(async () => {
    const compiled = await window.matbotTransport.callTool("workflow_action", {
      action: "compile",
      workspaceId: "default",
      name: "Shadow Candidate",
      sourceIds: ["source:playwright-architecture-brief"],
      publish: true,
      dryRun: false
    });
    const run = await window.matbotTransport.callTool("workflow_action", {
      action: "start",
      workspaceId: "default",
      workflowId: compiled.published.definition.id,
      mode: "shadow",
      inputs: {},
      evidenceSourceIds: ["source:playwright-architecture-brief"]
    });
    return run.id;
  });

  await openArchitecturePanel(page, "workflows");
  await expect(page.locator("#workflow-ops-acceptance-rate")).toHaveText("0%");
  await page.locator('.workflow-ops-tab[data-workflow-ops-view="shadow"]').click();
  await page.locator(`#workflow-ops-shadow-list .architecture-item[data-run-id="${shadowRunId}"]`).click();
  await expect(page.locator("#workflow-ops-shadow-detail")).toContainText("unlabeled");
  await page.locator("#workflow-ops-shadow-detail").getByRole("button", { name: "Accept" }).click();
  await expect(page.locator("#architecture-workflow-status")).toContainText("recorded as accepted");
  await expect(page.locator(`#workflow-ops-shadow-list .architecture-item[data-run-id="${shadowRunId}"]`)).toHaveCount(0);
  await expect(page.locator("#workflow-ops-shadow-list")).toContainText("No unlabeled shadow runs");
  await expect(page.locator("#workflow-ops-shadow-detail")).toContainText("Select a shadow run");
  await expect(page.locator("#workflow-ops-acceptance-rate")).toHaveText("100%");
});

test("workflow run inspector ignores stale responses after selecting another run", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow stale-selection coverage");
  await page.goto("/");
  const runIds = await page.evaluate(async () => {
    const compiled = await window.matbotTransport.callTool("workflow_action", {
      action: "compile", workspaceId: "default", name: "Run Selection", publish: true, dryRun: false
    });
    const first = await window.matbotTransport.callTool("workflow_action", {
      action: "dry_run", workspaceId: "default", workflowId: compiled.published.definition.id, inputs: { selected: "first" }
    });
    const second = await window.matbotTransport.callTool("workflow_action", {
      action: "dry_run", workspaceId: "default", workflowId: compiled.published.definition.id, inputs: { selected: "second" }
    });
    return { first: first.id, second: second.id };
  });
  await page.route("**/tools/workflow_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "inspect_run" && input.runId === runIds.first) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await route.fallback();
  });

  await openArchitecturePanel(page, "workflows");
  await page.locator('.workflow-ops-tab[data-workflow-ops-view="runs"]').click();
  await page.locator(`#workflow-ops-run-list .architecture-item[data-run-id="${runIds.first}"]`).click();
  await page.locator(`#workflow-ops-run-list .architecture-item[data-run-id="${runIds.second}"]`).click();
  await expect(page.locator("#workflow-ops-run-detail").getByRole("heading", { name: runIds.second })).toBeVisible();
  await expect(page.locator("#workflow-ops-run-detail")).toContainText('"selected": "second"');
  await page.waitForTimeout(300);
  await expect(page.locator("#workflow-ops-run-detail").getByRole("heading", { name: runIds.second })).toBeVisible();
  await expect(page.locator("#workflow-ops-run-detail")).not.toContainText('"selected": "first"');
});

test("workflow operations center keeps partial data usable and refreshes a failed service", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow recovery coverage");
  await page.goto("/");
  await page.evaluate(async () => {
    await window.matbotTransport.callTool("workflow_action", {
      action: "compile", workspaceId: "default", name: "Recovery Workflow", publish: true, dryRun: true
    });
  });
  let failCompilations = true;
  await page.route("**/tools/workflow_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "compilations" && failCompilations) {
      failCompilations = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary compilation service failure" }) });
      return;
    }
    await route.fallback();
  });

  await openArchitecturePanel(page, "workflows");
  await expect(page.locator("#architecture-workflow-status")).toContainText("Loaded with 1 unavailable workflow service");
  await expect(page.locator("#workflow-ops-run-count")).toHaveText("1");
  await page.locator("#architecture-workflow-refresh").click();
  await expect(page.locator("#architecture-workflow-status")).toContainText("1 workflow(s)");
  await page.locator('.workflow-ops-tab[data-workflow-ops-view="library"]').click();
  await expect(page.locator("#workflow-ops-library-list")).toContainText("Recovery Workflow");
});

test("MISSING-09 evaluation observability and ROI panel traces replay regressions and sponsor evidence", async ({ page, isMobile }) => {
  await page.goto("/");
  if (isMobile) await page.locator("#burger").click();

  await openArchitecturePanel(page, "evaluation");
  await expect(page.locator("#architecture-title")).toHaveText("Evaluation, Observability & ROI");
  await expect(page.locator("#evaluation-trace-count")).toHaveText("1");
  await expect(page.locator("#evaluation-pass-rate")).toHaveText("100%");
  await expect(page.locator("#evaluation-completion-rate")).toHaveText("75%");
  await expect(page.locator("#evaluation-net-benefit")).toContainText("1,565");

  const trace = page.locator('#evaluation-trace-list .architecture-item[data-trace-id="trace:playwright-governed"]');
  await expect(trace).toBeVisible();
  await trace.click();
  await expect(page.locator("#evaluation-trace-detail")).toContainText("Span waterfall");
  await expect(page.locator("#evaluation-trace-detail")).toContainText("workspace_rag.search");
  await page.locator("#evaluation-trace-detail").getByRole("button", { name: "Replay trace safely" }).click();
  await expect(page.locator("#architecture-evaluation-status")).toContainText("writes executed: no");

  const suite = page.locator('#evaluation-suite-list .architecture-item[data-suite-id="suite:playwright-governed"]');
  await expect(suite).toBeVisible();
  await suite.click();
  await expect(page.locator("#evaluation-suite-detail")).toContainText("Retrieval, citation, action, policy");
  await page.locator("#evaluation-suite-detail").getByRole("button", { name: "Run regression suite" }).click();
  await expect(page.locator("#architecture-evaluation-status")).toContainText("Evaluation passed");
  await expect(page.locator("#evaluation-suite-detail")).toContainText("webui");

  await expect(page.locator("#evaluation-roi-detail")).toContainText("Verified outcomes");
  await expect(page.locator("#evaluation-roi-detail")).toContainText("workflow:invoice-review");
  await expect(page.locator("#evaluation-roi-detail")).toContainText("Citation coverage");
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

  page.once("dialog", dialog => dialog.accept("Disposable"));
  await page.locator("#workspace-new-btn").click();
  const disposable = page.locator('.workspace-row[data-workspace-id="workspace-2"]');
  await expect(disposable).toContainText("Disposable");

  await disposable.getByRole("button", { name: "Delete Disposable" }).click();
  await expect(page.locator("#workspace-delete-dialog")).toHaveClass(/open/);
  await page.locator("#workspace-delete-cancel").click();
  await expect(disposable).toBeVisible();

  await disposable.getByRole("button", { name: "Delete Disposable" }).click();
  await page.locator("#workspace-delete-confirm").click();
  await expect(disposable).toHaveCount(0);

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

test("MISSING-03/MISSING-12 workspace RAG configuration panel saves paths and shows indexing progress", async ({ page, isMobile }) => {
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

test("workspace settings discard unsaved edits when navigating to another conversation or dialog", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workspace settings coverage");
  await page.goto("/");

  const settings = page.locator("#workspace-settings-screen");
  const contextName = page.locator("#workspace-context-name");
  const openSettings = async () => {
    await page.locator("#workspace-config-btn").click();
    await expect(settings).toHaveClass(/open/);
  };

  await openSettings();
  await contextName.fill("New conversation discard");
  await page.locator("#new-btn").click();
  await expect(settings).not.toHaveClass(/open/);

  await openSettings();
  await expect(contextName).toHaveValue("Default");
  await contextName.fill("Conversation switch discard");
  await page.locator(".session-item:not(.active) .session-label").first().click();
  await expect(settings).not.toHaveClass(/open/);

  await openSettings();
  await expect(contextName).toHaveValue("Default");
  await contextName.fill("Dialog discard");
  await page.locator("#expert-toggle-btn").evaluate(button => button.click());
  await expect(page.locator("#expert-popover")).toHaveClass(/open/);
  await expect(settings).not.toHaveClass(/open/);

  await openSettings();
  await expect(contextName).toHaveValue("Default");
});

test("remembered facts persist across conversations and are used in later answers", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop memory coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");

  await page.locator("#input").fill("Memorize my name: Maciej Zagozda");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Harness response");

  const facts = await page.evaluate(async () => window.matbotTransport.callTool("remembered_facts_action", { action: "query", query: {} }));
  expect(facts.items.some(fact => fact.fact.includes("Maciej Zagozda"))).toBeTruthy();

  await page.locator("#new-btn").click();
  await page.locator("#input").fill("What is my name?");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Maciej Zagozda");
});

test("an immediate message after New waits for the new session", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop session transition coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");
  const previousSessionId = await page.evaluate(() => location.hash.slice(1));

  await page.route("**/sessions", async route => {
    if (route.request().method() === "POST") {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    await route.continue();
  });

  await page.locator("#new-btn").click();
  await page.locator("#input").fill("Immediate new-session message");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Immediate new-session message");

  const newSessionId = await page.evaluate(() => location.hash.slice(1));
  expect(newSessionId).not.toBe(previousSessionId);
  const [previousSession, newSession] = await page.evaluate(async sessionIds => Promise.all(
    sessionIds.map(sessionId => window.matbotTransport.callTool("session_action", { action: "get", sessionId }))
  ), [previousSessionId, newSessionId]);
  expect(previousSession.messages.some(message => message.content?.[0]?.text === "Immediate new-session message")).toBeFalsy();
  expect(newSession.messages.some(message => message.content?.[0]?.text === "Immediate new-session message")).toBeTruthy();
});

test("remembered facts are isolated between Cortex workspaces", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop cross-workspace memory coverage");
  await page.goto("/");
  await page.evaluate(async () => window.matbotTransport.switchWorkspace("default"));
  await page.reload();

  await page.locator("#new-btn").click();
  await page.locator("#input").fill("Memorize this: Alpha workspace memory token.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Harness response");

  const secondWorkspace = await page.evaluate(async () => window.matbotTransport.createWorkspace("Memory Isolation"));
  await page.evaluate(async id => window.matbotTransport.switchWorkspace(id), secondWorkspace.id);
  await page.reload();
  const secondWorkspaceFacts = await page.evaluate(async () => window.matbotTransport.callTool("remembered_facts_action", {
    action: "query",
    query: {}
  }));
  expect(secondWorkspaceFacts.items).toEqual([]);

  await page.locator("#new-btn").click();
  await page.locator("#input").fill("Memorize this: Beta workspace memory token.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Harness response");

  await page.evaluate(async () => window.matbotTransport.switchWorkspace("default"));
  await page.reload();
  const defaultFacts = await page.evaluate(async () => window.matbotTransport.callTool("remembered_facts_action", {
    action: "query",
    query: {}
  }));
  expect(defaultFacts.items.map(item => item.fact)).toContain("Alpha workspace memory token.");
  expect(defaultFacts.items.map(item => item.fact)).not.toContain("Beta workspace memory token.");
  await page.evaluate(async id => window.matbotTransport.deleteWorkspace(id), secondWorkspace.id);
});

test("MISSING-11 memory browser command follows Inner voice and opens the in-page browser", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop memory browser coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");

  await page.locator("#input").fill("Memorize this: The memory browser launcher token is Violet.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Harness response");

  await openSkills(page);
  const innerVoice = page.locator(".skill-entry", {
    has: page.locator(".skill-name-label", { hasText: "Inner voice" })
  });
  const memoryBrowser = page.locator("#memory-browser-btn");
  await expect(memoryBrowser).toBeVisible();
  await expect(memoryBrowser).toHaveText("Open memory browser");
  expect(await innerVoice.evaluate(el => el.nextElementSibling?.id)).toBe("memory-browser-btn");
  await page.mouse.move(800, 50);
  await page.waitForTimeout(200);

  const commandAppearance = locator => locator.evaluate(el => {
    const style = getComputedStyle(el);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      color: style.color,
      cursor: style.cursor,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      margin: style.margin,
      minHeight: style.minHeight,
      padding: style.padding
    };
  });
  expect(await commandAppearance(memoryBrowser)).toEqual(await commandAppearance(innerVoice));
  await innerVoice.hover();
  await page.waitForTimeout(200);
  const innerVoiceHoverAppearance = await commandAppearance(innerVoice);
  await memoryBrowser.hover();
  await page.waitForTimeout(200);
  expect(await commandAppearance(memoryBrowser)).toEqual(innerVoiceHoverAppearance);

  const popups = [];
  page.on("popup", popup => popups.push(popup));
  await memoryBrowser.click();
  await expect(page.locator("#memory-browser-overlay")).toHaveClass(/open/);
  await expect(page.locator("#memory-browser-title")).toHaveText("Memories");

  await page.locator("#memory-browser-search").fill("Violet");
  await page.locator("#memory-browser-search").press("Enter");
  await expect(page.locator("#memory-browser-list")).toContainText("memory browser launcher token is Violet");
  await page.waitForTimeout(100);
  expect(popups).toHaveLength(0);
  await expect(page.locator("#memory-browser-status")).toHaveText("");
});

test("MISSING-11 standalone memory browser loads, creates, edits, filters, and deletes through its own base URL", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop standalone memory browser coverage");
  await page.goto("http://127.0.0.1:19788/");
  await expect(page.locator("#count-label")).toContainText("0");
  await expect(page.locator("#search-input")).toHaveAttribute("placeholder", "Search remembered facts");
  await page.locator("#new-fact").fill("Standalone browser verification marker");
  await page.locator("#add-memory-btn").click();
  await expect(page.locator("#memory-list")).toContainText("Standalone browser verification marker");
  await page.locator("#state-filter").selectOption("unprocessed");
  await expect(page.locator("#memory-list")).toContainText("Standalone browser verification marker");
  const memoryButton = page.locator("#memory-list button").first();
  const selectedId = await memoryButton.getAttribute("data-id");
  const selectedResponse = page.waitForResponse(response => response.url().endsWith(`/api/memories/${encodeURIComponent(selectedId)}`) && response.request().method() === "GET");
  await memoryButton.click();
  await selectedResponse;
  await expect(page.locator("#fact-input")).toHaveValue("Standalone browser verification marker");
  await page.locator("#fact-input").fill("Standalone browser verification marker revised");
  await page.locator("#save-btn").click();
  await expect(page.locator("#status")).toHaveText("Saved.");
  await expect(page.locator("#memory-list")).toContainText("revised");
  const id = await page.locator("#memory-title").textContent();
  const version = await page.locator("#version").inputValue();
  await page.locator("#fact-input").fill("Standalone browser local stale edit");
  await page.evaluate(async ({ id, version }) => {
    await fetch(`/api/memories/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected: version, fact: "Standalone browser server edit" }),
    });
  }, { id, version });
  await page.locator("#save-btn").click();
  await expect(page.locator("#status")).toContainText("Version conflict");
  await expect(page.locator("#fact-input")).toHaveValue("Standalone browser server edit");
  await page.locator("#fact-input").fill("Standalone browser conflict resolved");
  await page.locator("#save-btn").click();
  await expect(page.locator("#status")).toHaveText("Saved.");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#delete-btn").click();
  await expect(page.locator("#memory-list")).not.toContainText("Standalone browser conflict resolved");
});

test("in-page memory browser can create, edit, search, and delete memories", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop memory browser CRUD coverage");
  await page.goto("/");

  await openSkills(page);
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
  await expect(page.locator("#memory-browser-overlay")).not.toHaveClass(/open/);

  await expect(page.locator("#memory-browser-btn")).toBeVisible();
  await page.locator("#memory-browser-btn").click();
  await expect(page.locator("#memory-browser-overlay")).toHaveClass(/open/);
  await expect(page.locator("#memory-browser-state")).toHaveText("processed");

  await page.locator("#memory-browser-search").fill("Copper, revised");
  await page.locator("#memory-browser-search").press("Enter");
  await expect(page.locator("#memory-browser-list")).toContainText("Copper, revised");
  await page.locator("#memory-browser-filter").selectOption("processed");
  await expect(page.locator("#memory-browser-list")).toContainText("Copper, revised");

  page.once("dialog", dialog => dialog.accept());
  await page.locator("#memory-browser-delete").click();
  await expect(page.locator("#memory-browser-panel-status")).toContainText("Deleted");
  await expect(page.locator("#memory-browser-list")).not.toContainText("Copper, revised");
  await page.locator("#memory-browser-close").click();
  await expect(page.locator("#memory-browser-overlay")).not.toHaveClass(/open/);
});

test("direct cognition tool calls can receive session and provider context", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop direct cognition tool coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");

  await page.locator("#input").fill("The direct recall token is Helix.");
  await page.keyboard.press("Enter");
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
  await page.keyboard.press("Enter");
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
  await page.keyboard.press("Enter");

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
  await page.keyboard.press("Enter");

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
  await page.keyboard.press("Enter");

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
  await expect(page.locator("#attachment-tray")).toBeHidden();

  const reservedName = "report #1?final%.txt";
  await page.setInputFiles("#upload-input", {
    name: reservedName,
    mimeType: "text/plain",
    buffer: Buffer.from("reserved filename opened", "utf8")
  });
  const reserved = page.locator(`.file-item[data-path="${reservedName}"]`);
  await expect(reserved).toBeVisible();
  const [opened] = await Promise.all([
    page.waitForEvent("popup"),
    reserved.click()
  ]);
  await expect(opened.locator("body")).toHaveText("reserved filename opened");
  await opened.close();
  await reserved.hover();
  await reserved.locator(".file-action-btn").click();
  await expect(reserved).toHaveCount(0);
  await expect(page.locator("#attachment-tray")).toBeHidden();
});

test("MISSING-05 plugin discovery returns stable compatible entries before runtime activation", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop plugin discovery coverage");
  await page.goto("/");
  const discovered = await page.evaluate(() => window.matbotTransport.callTool("plugin", { action: "discover_local" }));
  const background = discovered.find(entry => entry.specifier === "./packages/plugins/background");
  expect(background).toBeTruthy();
  expect(background.configuredVia).toBeUndefined();
  expect(Array.isArray(background.matbotRuntime)).toBeTruthy();
  expect(background.matbotRuntime).toContain("node");
  await openPlugins(page);
  await expect(page.locator(".plugin-entry-inactive", { hasText: "@matatbread/matbot-tool-background" })).toBeVisible();
});

test("attaches an uploaded workspace file to a message and prefers it over a matching RAG host path", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop files coverage");
  await page.goto("/");

  await page.setInputFiles("#upload-input", {
    name: "README.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Attached README\n\nSummarize this workspace copy.", "utf8")
  });

  const fileRow = page.locator('.file-item[data-path="README.md"]');
  const attachmentChip = page.locator('#attachment-tray [data-attachment-path="README.md"]');
  await expect(fileRow).toBeVisible();
  await expect(attachmentChip).toBeVisible();

  await attachmentChip.locator(".attachment-chip-remove").click();
  await expect(page.locator("#attachment-tray")).toBeHidden();
  await fileRow.hover();
  await fileRow.locator(".file-attach-btn").click();
  await expect(attachmentChip).toBeVisible();

  await page.locator("#input").fill("Read README.md and summarize its contents");
  await page.keyboard.press("Enter");

  await expect(page.locator("#attachment-tray")).toBeHidden();
  await expect(page.locator('.message.user .message-attachment[data-attachment-path="README.md"]').last()).toBeVisible();
  await expect(page.locator("#messages .marker-block").last()).toContainText("C:/RAG-test/README.md");
  const modelToolHeaders = page.locator("#messages .message.assistant:not(.marker-block) .tool-header");
  await expect(modelToolHeaders.last()).toContainText("workspace_action");
  await expect(modelToolHeaders).not.toContainText("file_broker_action");
  await expect(page.locator(".message.assistant:not(.marker-block)").last()).toContainText(
    "Read attached workspace file README.md with workspace_action"
  );
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

test("skill deletion supports cancellation and confirmation", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop skill deletion coverage");
  await page.goto("/");
  await page.evaluate(async () => window.matbotTransport.callTool("skill_action", {
    action: "save",
    name: "Disposable Playwright Skill",
    content: "# Disposable"
  }));
  await openSkills(page);

  const skill = page.locator(".skill-entry", { hasText: "Disposable Playwright Skill" });
  await expect(skill).toBeVisible();
  await skill.hover();
  page.once("dialog", dialog => dialog.dismiss());
  await skill.getByTitle("Delete skill").click();
  await expect(skill).toBeVisible();

  page.once("dialog", dialog => dialog.accept());
  await skill.getByTitle("Delete skill").click();
  await expect(skill).toHaveCount(0);
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
  await page.keyboard.press("Enter");

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

test("mobile layout can navigate and operate architecture panels", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile architecture coverage");
  await page.goto("/");
  await page.locator("#burger").click();
  await openArchitecturePanel(page, "sources");

  await expect(page.locator("#architecture-screen")).toBeVisible();
  await expect(page.locator("body")).not.toHaveClass(/sidebar-open/);
  await expect(page.locator("#architecture-source-list")).toContainText("architecture.md");

  await page.getByRole("tab", { name: "SQL Preview" }).click();
  await page.locator("#architecture-sql-plan-btn").click();
  await expect(page.locator("#architecture-sql-preview")).toContainText("SELECT");
  await expect(page.locator("#architecture-sql-approve-btn")).toBeEnabled();
});

test("mobile layout exposes workflow operations summary and run ledger", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile workflow operations coverage");
  await page.goto("/");
  const runId = await page.evaluate(async () => {
    const compiled = await window.matbotTransport.callTool("workflow_action", {
      action: "compile", workspaceId: "default", name: "Mobile Workflow", publish: true, dryRun: false
    });
    const run = await window.matbotTransport.callTool("workflow_action", {
      action: "dry_run", workspaceId: "default", workflowId: compiled.published.definition.id, inputs: { device: "mobile" }
    });
    return run.id;
  });

  await page.locator("#burger").click();
  await openArchitecturePanel(page, "workflows");
  await expect(page.locator("#architecture-title")).toHaveText("Workflow Operations Center");
  await expect(page.locator("#workflow-ops-workflow-count")).toHaveText("1");
  await expect(page.locator("#workflow-ops-run-count")).toHaveText("1");
  await page.locator('.workflow-ops-tab[data-workflow-ops-view="runs"]').click();
  await page.locator(`#workflow-ops-run-list .architecture-item[data-run-id="${runId}"]`).click();
  await expect(page.locator("#workflow-ops-run-detail")).toContainText('"device": "mobile"');
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("Run Ledger");
});

test("mobile layout contains narrow-phone content and provides usable primary controls", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile-only responsive coverage");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");

  const primaryControlSizes = await page.locator("#main").evaluate(main => {
    const size = selector => {
      const rect = main.querySelector(selector).getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    return {
      burger: size("#burger"),
      send: size("#send-btn")
    };
  });
  expect(primaryControlSizes.burger.width).toBeGreaterThanOrEqual(40);
  expect(primaryControlSizes.burger.height).toBeGreaterThanOrEqual(40);
  expect(primaryControlSizes.send.width).toBeGreaterThanOrEqual(36);
  expect(primaryControlSizes.send.height).toBeGreaterThanOrEqual(36);

  await page.locator("#burger").click();
  await openArchitecturePanel(page, "sources");
  await expect(page.locator("#architecture-source-list .architecture-badge.bad")).toHaveText("unhealthy");
  const architectureLayout = await page.locator("#architecture-screen").evaluate(screen => {
    const badge = screen.querySelector("#architecture-source-list .architecture-badge.bad");
    return {
      clientWidth: screen.clientWidth,
      scrollWidth: screen.scrollWidth,
      badgeWhiteSpace: badge ? getComputedStyle(badge).whiteSpace : null
    };
  });
  expect(architectureLayout.scrollWidth).toBeLessThanOrEqual(architectureLayout.clientWidth + 1);
  expect(architectureLayout.badgeWhiteSpace).toBe("normal");
});

test("mobile landscape keeps both memory browser panes usable", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile-only responsive coverage");
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto("/");
  await page.locator("#burger").click();
  await openSkills(page);
  await page.locator("#memory-browser-btn").click();

  const layout = await page.locator("#memory-browser").evaluate(panel => {
    const list = panel.querySelector("#memory-browser-list-pane").getBoundingClientRect();
    const detail = panel.querySelector("#memory-browser-detail-pane").getBoundingClientRect();
    return {
      sideBySide: Math.abs(list.top - detail.top) <= 1 && list.right <= detail.left + 1,
      detailHeight: detail.height,
      clientHeight: panel.clientHeight,
      scrollHeight: panel.scrollHeight
    };
  });
  expect(layout.sideBySide).toBeTruthy();
  expect(layout.detailHeight).toBeGreaterThan(180);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight + 1);
});

test("E2E-001 workspace switch locks mutations and a failed switch restores the active workspace", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workspace-switch failure coverage");
  await page.goto("/");
  await page.evaluate(async () => window.matbotTransport.createWorkspace("Switch Target"));
  await page.reload();
  await page.locator("#workspace-toggle-btn").click();

  let releaseSwitch;
  const switchReached = new Promise(resolve => { releaseSwitch = resolve; });
  await page.route("**/workspaces/workspace-1/switch", async route => {
    await switchReached;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporary switch failure" })
    });
  });

  await page.locator('.workspace-option[data-workspace-id="workspace-1"]').click();
  await expect(page.locator("#workspace-status")).toContainText("Switching");
  await expect(page.locator("#input")).toBeDisabled();
  await expect(page.locator("#send-btn")).toBeDisabled();
  await expect(page.locator("#new-btn")).toBeDisabled();
  await expect(page.locator("#upload-input")).toBeDisabled();
  await expect(page.locator("#workspace-toggle-btn")).toBeDisabled();

  releaseSwitch();
  await expect(page.locator("#workspace-status")).toContainText("temporary switch failure");
  await expect(page.locator("#input")).toBeEnabled();
  await expect(page.locator("#send-btn")).toBeEnabled();
  await expect(page.locator("#new-btn")).toBeEnabled();
  await expect(page.locator("#workspace-toggle-btn")).toContainText("Default");
});

test("E2E-002 sessions, files, skills, plugins, and memories remain isolated between workspaces", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workspace isolation matrix");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await page.locator("#input").fill("Memorize this: Workspace A secret token.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Harness response");
  await page.evaluate(async () => {
    await window.matbotTransport.callTool("workspace_action", { action: "write", path: "shared-name.txt", content: "workspace A" });
    await window.matbotTransport.callTool("skill_action", { action: "save", name: "Workspace Probe", content: "# Workspace A" });
    await window.matbotTransport.callTool("plugin", { action: "add", specifier: "./packages/plugins/background" });
    await window.matbotTransport.callTool("workspace_rag", {
      action: "configure",
      contextId: "default",
      contextName: "Workspace A Knowledge",
      paths: ["C:\\Knowledge\\A"]
    });
  });
  const workspaceAConversation = await page.locator(".session-item.active").getAttribute("data-sid");

  const workspaceB = await page.evaluate(async () => window.matbotTransport.createWorkspace("Isolation B"));
  await page.evaluate(async id => window.matbotTransport.switchWorkspace(id), workspaceB.id);
  await page.reload();

  const isolated = await page.evaluate(async () => {
    const [sessions, files, skills, plugins, memories, rag] = await Promise.all([
      window.matbotTransport.callTool("session_action", { action: "list" }),
      window.matbotTransport.callTool("workspace_action", { action: "list" }),
      window.matbotTransport.callTool("skill_action", { action: "list" }),
      window.matbotTransport.callTool("plugin", { action: "list" }),
      window.matbotTransport.callTool("remembered_facts_action", { action: "query", query: {} }),
      window.matbotTransport.callTool("workspace_rag", { action: "get_config" })
    ]);
    return { sessions, files, skills, plugins, memories, rag };
  });
  expect(isolated.sessions.some(session => session.id === workspaceAConversation)).toBe(false);
  expect(isolated.files.some(file => file.path === "shared-name.txt")).toBe(false);
  expect(isolated.skills.skills.some(skill => skill.name === "Workspace Probe")).toBe(false);
  expect(isolated.plugins.loaded.some(plugin => plugin.name.includes("background"))).toBe(false);
  expect(isolated.memories.items).toEqual([]);
  expect(isolated.rag.contexts.flatMap(context => context.paths)).not.toContain("C:\\Knowledge\\A");

  await page.evaluate(async () => {
    await window.matbotTransport.callTool("workspace_action", { action: "write", path: "shared-name.txt", content: "workspace B" });
    await window.matbotTransport.callTool("skill_action", { action: "save", name: "Workspace Probe", content: "# Workspace B" });
    await window.matbotTransport.callTool("remembered_facts_action", {
      action: "set",
      data: { fact: "Workspace B secret token.", sessionId: "manual", messageId: "manual", createdAt: new Date().toISOString() }
    });
    await window.matbotTransport.callTool("workspace_rag", {
      action: "configure",
      contextId: "default",
      contextName: "Workspace B Knowledge",
      paths: ["C:\\Knowledge\\B"]
    });
  });

  await page.evaluate(async () => window.matbotTransport.switchWorkspace("default"));
  await page.reload();
  const restored = await page.evaluate(async () => {
    const [file, skill, memories, rag] = await Promise.all([
      window.matbotTransport.callTool("workspace_action", { action: "read", path: "shared-name.txt" }),
      window.matbotTransport.callTool("skill_action", { action: "load", name: "Workspace Probe" }),
      window.matbotTransport.callTool("remembered_facts_action", { action: "query", query: {} }),
      window.matbotTransport.callTool("workspace_rag", { action: "get_config" })
    ]);
    return { file, skill, memories, rag };
  });
  expect(restored.file).toBe("workspace A");
  expect(restored.skill.content).toBe("# Workspace A");
  expect(restored.memories.items.map(item => item.fact)).toContain("Workspace A secret token.");
  expect(restored.memories.items.map(item => item.fact)).not.toContain("Workspace B secret token.");
  expect(restored.rag.contexts.flatMap(context => context.paths)).toContain("C:\\Knowledge\\A");
  expect(restored.rag.contexts.flatMap(context => context.paths)).not.toContain("C:\\Knowledge\\B");
});

test("E2E-003 stopping a slow turn ignores completion and allows a clean next turn", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop abort integrity coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await page.locator("#input").fill("slow response with late output");
  await page.keyboard.press("Enter");
  await expect(page.locator("#send-btn")).toHaveClass(/stop-mode/);
  await expect(page.locator(".message.assistant")).toContainText("Starting slow response");

  await page.locator("#input").fill("queued turn that must be dropped");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.user", { hasText: "queued turn that must be dropped" })).toBeVisible();
  await page.locator("#send-btn").click();
  await expect(page.locator("#send-btn")).not.toHaveClass(/stop-mode/);
  await expect(page.locator(".message.user", { hasText: "queued turn that must be dropped" })).toHaveCount(0);
  const stoppedText = await page.locator(".message.assistant").last().textContent();
  await page.waitForTimeout(250);
  await expect(page.locator(".message.assistant").last()).toHaveText(stoppedText);

  await page.locator("#input").fill("clean turn after abort");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Harness response to: clean turn after abort");
  await expect(page.locator(".message.assistant").last()).not.toContainText("slow response");
  const sid = await page.locator(".session-item.active").getAttribute("data-sid");
  const stored = await page.evaluate(async sessionId => window.matbotTransport.callTool("session_action", {
    action: "get",
    sessionId
  }), sid);
  expect(stored.messages.some(message => message.content?.[0]?.text === "queued turn that must be dropped")).toBe(false);
});

test("E2E-004 editing governed SQL inputs invalidates approval and rapid execute is idempotent", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop governed SQL integrity coverage");
  let executeRequests = 0;
  await page.route("**/tools/structured_data_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "execute_query") {
      executeRequests += 1;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await route.fallback();
  });
  await page.goto("/");
  await openArchitecturePanel(page, "sql");
  await page.locator("#architecture-sql-plan-btn").click();
  await expect(page.locator("#architecture-sql-approve-btn")).toBeEnabled();
  await page.locator("#architecture-sql-approve-btn").click();
  await expect(page.locator("#architecture-sql-execute-btn")).toBeEnabled();

  await page.locator("#architecture-sql-filter-value").fill("refined");
  await expect(page.locator("#architecture-sql-status")).toContainText("Plan and approve again");
  await expect(page.locator("#architecture-sql-execute-btn")).toBeDisabled();
  await expect(page.locator("#architecture-sql-preview")).toHaveText("");

  await page.locator("#architecture-sql-plan-btn").click();
  await page.locator("#architecture-sql-approve-btn").click();
  await expect(page.locator("#architecture-sql-execute-btn")).toBeEnabled();
  await page.locator("#architecture-sql-execute-btn").evaluate(button => {
    button.click();
    button.click();
  });
  await expect(page.locator("#architecture-sql-results")).toContainText("total_revenue");
  expect(executeRequests).toBe(1);
});

test("E2E-006 workspace RAG save failure preserves edits and ignores stale workspace status", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workspace RAG failure coverage");
  let failConfigure = true;
  await page.route("**/tools/workspace_rag", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "configure" && failConfigure) {
      failConfigure = false;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Path must be absolute and accessible" })
      });
      return;
    }
    if (input.action === "status" && !failConfigure) {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, workspaceId: "different-workspace", percent: 3, message: "stale workspace status" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await page.locator("#workspace-config-btn").click();
  await page.locator("#workspace-rag-paths").fill("relative\\docs");
  await page.locator("#workspace-rag-save-btn").click();
  await expect(page.locator("#workspace-rag-status")).toContainText("Path must be absolute");
  await expect(page.locator("#workspace-rag-paths")).toHaveValue("relative\\docs");
  await expect(page.locator("#workspace-rag-save-btn")).toBeEnabled();

  await page.locator("#workspace-rag-paths").fill("C:\\Knowledge");
  await page.locator("#workspace-rag-save-btn").click();
  await expect(page.locator("#workspace-rag-save-btn")).toBeDisabled();
  await expect(page.locator("#workspace-rag-status")).not.toContainText("stale workspace status");
});

test("E2E-007 failed plugin activation is atomic and core plugins have no remove control", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop plugin mutation safety coverage");
  let failSubmit = true;
  await page.route("**/sessions/*/submit", async route => {
    const input = route.request().postDataJSON();
    if (failSubmit && String(input.content).includes("packages/plugins/background")) {
      failSubmit = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary plugin mutation failure" })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openPlugins(page);
  const coreWorkspace = page.locator("details.plugin-entry", { hasText: "@matatbread/matbot-tool-workspace" });
  await expect(coreWorkspace.getByTitle("Remove plugin")).toHaveCount(0);

  const background = page.locator(".plugin-entry-inactive", { hasText: "@matatbread/matbot-tool-background" });
  await background.hover();
  await background.getByTitle("Add plugin").click();
  await expect(page.locator(".msg-error").last()).toContainText("temporary plugin mutation failure");
  await expect(background).toBeVisible();

  await background.hover();
  await background.getByTitle("Add plugin").click();
  await expect(page.locator("details.plugin-entry", { hasText: "@matatbread/matbot-tool-background" })).toBeVisible();
});

test("E2E-009 workspace create and rename failures do not create phantom state", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workspace validation coverage");
  await page.route("**/workspaces", async route => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Workspace name already exists" })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await page.locator("#workspace-toggle-btn").click();
  page.once("dialog", dialog => dialog.accept("Default"));
  await page.locator("#workspace-new-btn").click();
  await expect(page.locator("#workspace-status")).toContainText("Workspace name already exists");
  await expect(page.locator("#workspace-list .workspace-row")).toHaveCount(1);

  await page.route("**/workspaces/default/rename", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "rename unavailable" })
  }));
  page.once("dialog", dialog => dialog.accept("Renamed Phantom"));
  await page.locator("#workspace-rename-btn").click();
  await expect(page.locator("#workspace-status")).toContainText("rename unavailable");
  await expect(page.locator("#workspace-toggle-btn")).toContainText("Default");
});

test("E2E-010 file batch upload keeps successful files and reports individual failure", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop file batch failure coverage");
  await page.route("**/tools/workspace_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "write" && input.path === "rejected.txt") {
      await route.fulfill({
        status: 413,
        contentType: "application/json",
        body: JSON.stringify({ error: "file exceeds configured limit" })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  page.once("dialog", dialog => dialog.accept());
  await page.setInputFiles("#upload-input", [
    { name: "accepted.txt", mimeType: "text/plain", buffer: Buffer.from("accepted") },
    { name: "rejected.txt", mimeType: "text/plain", buffer: Buffer.from("rejected") }
  ]);
  await expect(page.locator('[data-path="accepted.txt"]')).toBeVisible();
  await expect(page.locator('[data-path="rejected.txt"]')).toHaveCount(0);
  await expect(page.locator('[data-attachment-path="accepted.txt"]')).toBeVisible();
  await expect(page.locator('[data-attachment-path="rejected.txt"]')).toHaveCount(0);
});

test("E2E-011 memory browser surfaces version conflicts and permits a clean retry", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop memory optimistic concurrency coverage");
  await page.goto("/");
  const created = await page.evaluate(async () => window.matbotTransport.callTool("remembered_facts_action", {
    action: "set",
    data: { fact: "Original concurrent fact.", sessionId: "manual", messageId: "manual", createdAt: new Date().toISOString() }
  }));
  await openSkills(page);
  await page.locator("#memory-browser-btn").click();
  await page.locator("#memory-browser-list .memory-browser-item", { hasText: "Original concurrent fact" }).click();

  await page.evaluate(async id => window.matbotTransport.callTool("remembered_facts_action", {
    action: "set",
    id,
    data: { fact: "Server concurrent fact.", sessionId: "manual", messageId: "manual", createdAt: new Date().toISOString() }
  }), created.id);
  await page.locator("#memory-browser-fact-input").fill("Local stale edit.");
  await page.locator("#memory-browser-save").click();
  await expect(page.locator("#memory-browser-panel-status")).toContainText("Version conflict");
  await expect(page.locator("#memory-browser-fact-input")).toHaveValue("Server concurrent fact.");
  await expect(page.locator("#memory-browser-overlay")).toHaveClass(/open/);

  await page.locator("#memory-browser-fact-input").fill("Resolved concurrent fact.");
  await page.locator("#memory-browser-save").click();
  await expect(page.locator("#memory-browser-overlay")).not.toHaveClass(/open/);
  const saved = await page.evaluate(async id => window.matbotTransport.callTool("remembered_facts_action", { action: "get", id }), created.id);
  expect(saved.fact).toBe("Resolved concurrent fact.");
});

test("E2E-012 skill editor degrades safely when the Markdown editor is offline", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop offline skill editor coverage");
  await page.route("https://**/*", route => route.abort());
  await page.goto("/");
  await openSkills(page);
  await page.locator(".skill-entry", { hasText: "Panel Etiquette" }).click();
  await expect(page.locator("#skill-editor-error")).toContainText("Markdown editor unavailable offline");
  await expect(page.locator("#skill-editor-save")).toBeDisabled();
  await page.getByRole("button", { name: "Metadata" }).click();
  await expect(page.locator("#skill-metadata")).toContainText("expert_panel");
  await page.getByRole("button", { name: "Triggers" }).click();
  await expect(page.locator(".trigger-row")).toHaveCount(1);
});

test("E2E-013 expert panel blocks an empty explicit selection without a request", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop expert validation coverage");
  let panelRequests = 0;
  page.on("request", request => {
    if (/\/sessions\/[^/]+\/expert-panel$/.test(new URL(request.url()).pathname)) panelRequests += 1;
  });
  await page.goto("/");
  await openExperts(page);
  await page.locator("#expert-enabled").check();
  await page.locator("#expert-all").uncheck();
  for (const choice of await page.locator(".expert-choice").all()) await choice.uncheck();
  await page.locator("#input").fill("Should not run without experts");
  await page.locator("#send-btn").click();
  await expect(page.locator("#expert-status")).toContainText("Select at least one expert");
  expect(panelRequests).toBe(0);
  await expect(page.locator("#input")).toHaveValue("Should not run without experts");
});

test("E2E-014 source refresh failure keeps usable source data visible", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop source partial-failure coverage");
  await page.goto("/");
  await openArchitecturePanel(page, "sources");
  await expect(page.locator("#architecture-source-list")).toContainText("architecture.md");
  let failList = true;
  await page.route("**/tools/source_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "list" && failList) {
      failList = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "source registry temporarily unavailable" })
      });
      return;
    }
    await route.fallback();
  });
  await page.locator("#architecture-source-refresh").click();
  await expect(page.locator("#architecture-source-status")).toContainText("source registry temporarily unavailable");
  await expect(page.locator("#architecture-source-list")).toContainText("architecture.md");
  await page.locator("#architecture-source-refresh").click();
  await expect(page.locator("#architecture-source-status")).not.toContainText("temporarily unavailable");
});

test("E2E-017 failed regression suite is visibly release-blocking", async ({ page, isMobile }) => {
  await page.route("**/tools/evaluation_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "run_suite") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          run: {
            id: "eval-run:failed",
            suiteId: input.suiteId,
            candidate: "edge-case",
            status: "completed",
            passed: false,
            score: 0.4,
            passRate: 0.5,
            caseCount: 2
          }
        })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  if (isMobile) await page.locator("#burger").click();
  await openArchitecturePanel(page, "evaluation");
  await page.locator('#evaluation-suite-list .architecture-item[data-suite-id="suite:playwright-governed"]').click();
  await page.locator("#evaluation-suite-detail").getByRole("button", { name: "Run regression suite" }).click();
  await expect(page.locator("#architecture-evaluation-status")).toContainText("Evaluation failed");
  await expect(page.locator("#architecture-evaluation-status")).toHaveClass(/error/);
});

test("E2E-018 context graph handles empty results and retries a transient retrieval failure", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop graph empty/error coverage");
  let attempt = 0;
  await page.route("**/tools/context_graph_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action !== "retrieve") return route.fallback();
    attempt += 1;
    if (attempt === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "graph retrieval unavailable" })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entities: [], relationships: [], facts: [], warnings: [] })
    });
  });
  await page.goto("/");
  await openArchitecturePanel(page, "graph");
  await page.locator("#architecture-graph-search").fill("missing entity");
  await page.locator("#architecture-graph-retrieve").click();
  await expect(page.locator("#architecture-graph-status")).toContainText("graph retrieval unavailable");
  await expect(page.locator("#architecture-graph-retrieve")).toBeEnabled();
  await page.locator("#architecture-graph-retrieve").click();
  await expect(page.locator("#architecture-graph-status")).toContainText("Retrieved 0 fact(s)");
  await expect(page.locator("#architecture-graph-list")).not.toContainText("missing entity");
});

test("E2E-019 review validation and creation failure preserve the form for retry", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop durable-review validation coverage");
  await page.goto("/");
  await openArchitecturePanel(page, "reviews");
  await page.locator("#architecture-review-question").fill("");
  await page.locator("#architecture-review-create-btn").click();
  await expect(page.locator("#architecture-review-status")).toContainText("Question is required");

  let failReview = true;
  await page.route("**/tools/expert_panel", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "review" && failReview) {
      failReview = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "review service unavailable" })
      });
      return;
    }
    await route.fallback();
  });
  await page.locator("#architecture-review-question").fill("Preserve this review question");
  await page.locator("#architecture-review-create-btn").click();
  await expect(page.locator("#architecture-review-status")).toContainText("review service unavailable");
  await expect(page.locator("#architecture-review-question")).toHaveValue("Preserve this review question");
  await page.locator("#architecture-review-create-btn").click();
  await expect(page.locator("#architecture-review-status")).toContainText("Review created");
});

test("E2E-021 missing sessions plugin shows the persistence warning", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop missing-session-plugin coverage");
  await page.route("**/tools/session_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "list") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Tool session_action not found" })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await expect(page.locator("#sessions-banner")).toBeVisible();
  await expect(page.locator("#sessions-banner")).toContainText("conversations won't be saved after reload");
});

test("E2E-022 font controls clamp at documented UI bounds and architecture tabs wrap by keyboard", async ({ page, isMobile }) => {
  await page.goto("/");
  if (isMobile) await page.locator("#burger").click();
  for (let index = 0; index < 30; index += 1) await page.locator("#fs-down").click();
  await expect.poll(() => page.locator("body").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(10);
  for (let index = 0; index < 30; index += 1) await page.locator("#fs-up").click();
  await expect.poll(() => page.locator("body").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(22);
  await page.reload();
  await expect.poll(() => page.locator("body").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(22);

  if (await page.locator("#burger").isVisible()) await page.locator("#burger").click();
  await openArchitecturePanel(page, "sources");
  const sourcesTab = page.getByRole("tab", { name: "Sources" });
  await sourcesTab.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Reviews" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Reviews" }).press("ArrowRight");
  await expect(sourcesTab).toHaveAttribute("aria-selected", "true");
});

test("T2-E2E-002 routes normal turns through providers scoped to the active workspace", async ({ page, request, isMobile }) => {
  test.skip(isMobile, "desktop provider/workspace contract");
  await page.goto("/");
  const workspaceB = await page.evaluate(async () => window.matbotTransport.createWorkspace("Provider B"));
  await request.post("/__test/workspaces/default/providers", { data: { providers: ["openai", "Local-A"] } });
  await request.post(`/__test/workspaces/${workspaceB.id}/providers`, { data: { providers: ["Local-B"] } });
  await page.reload();

  await expect(page.locator("#provider-select option")).toHaveCount(2);
  await page.locator("#provider-select").selectOption("Local-A");
  await page.locator("#new-btn").click();
  await page.locator("#input").fill("provider route A");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("provider route A");
  await expect(page.locator("#send-btn")).not.toHaveClass(/stop-mode/);
  const storedA = await page.evaluate(async () => {
    const listed = await window.matbotTransport.callTool("session_action", { action: "list" });
    const records = await Promise.all(listed.map(session => window.matbotTransport.callTool(
      "session_action", { action: "get", sessionId: session.id }
    )));
    return records.find(record => record.messages.some(message => message.content?.[0]?.text?.includes("provider route A")));
  });
  expect(storedA.messages.filter(message => message.role === "assistant").at(-1).providerName).toBe("Local-A");

  await page.evaluate(async id => window.matbotTransport.switchWorkspace(id), workspaceB.id);
  await page.reload();
  await expect(page.locator("#provider-select")).toHaveValue("Local-B");
  await expect(page.locator("#provider-select option")).toHaveCount(1);
  await expect(page.locator("#provider-select option")).not.toContainText("Local-A");
  await page.locator("#new-btn").click();
  await page.locator("#input").fill("provider route B");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("provider route B");
  await expect(page.locator("#send-btn")).not.toHaveClass(/stop-mode/);
  const storedB = await page.evaluate(async () => {
    const listed = await window.matbotTransport.callTool("session_action", { action: "list" });
    const records = await Promise.all(listed.map(session => window.matbotTransport.callTool(
      "session_action", { action: "get", sessionId: session.id }
    )));
    return records.find(record => record.messages.some(message => message.content?.[0]?.text?.includes("provider route B")));
  });
  expect(storedB.messages.filter(message => message.role === "assistant").at(-1).providerName).toBe("Local-B");

  await page.evaluate(async () => window.matbotTransport.switchWorkspace("default"));
  await page.reload();
  await expect(page.locator("#provider-select")).toHaveValue("Local-A");
});

test("T2-E2E-003 ignores outgoing workspace events after a successful switch", async ({ page, request, isMobile }) => {
  test.skip(isMobile, "desktop successful workspace handoff");
  await page.goto("/");
  await page.locator("#new-btn").click();
  const outgoingSession = await page.locator(".session-item.active").getAttribute("data-sid");
  const target = await page.evaluate(async () => window.matbotTransport.createWorkspace("Clean Target"));
  await page.reload();
  await page.locator("#workspace-toggle-btn").click();

  await Promise.all([
    page.waitForEvent("load"),
    page.locator(`.workspace-option[data-workspace-id="${target.id}"]`).click()
  ]);
  await expect(page.locator("#workspace-toggle-btn")).toContainText("Clean Target");

  await request.post(`/__test/sessions/${outgoingSession}/event`, {
    data: {
      event: "text-delta",
      data: { type: "text-delta", delta: "OUTGOING-LATE-CANARY", traceId: "late-a" }
    }
  });
  await page.waitForTimeout(100);
  await expect(page.locator("#messages")).not.toContainText("OUTGOING-LATE-CANARY");
  await expect(page.locator(`.session-item[data-sid="${outgoingSession}"]`)).toHaveCount(0);

  await page.locator("#new-btn").click();
  await page.locator("#input").fill("clean target turn");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("clean target turn");
  await expect(page.locator("#messages")).not.toContainText("OUTGOING-LATE-CANARY");
});

test("T2-E2E-004 deletes every disposable resource for only the named workspace", async ({ page, request, isMobile }) => {
  test.skip(isMobile, "desktop destructive workspace cleanup");
  await page.goto("/");
  await page.evaluate(async () => {
    await window.matbotTransport.callTool("workspace_action", {
      action: "write", path: "same.txt", content: "workspace A survives"
    });
  });
  const workspaceB = await page.evaluate(async () => window.matbotTransport.createWorkspace("Delete Me Exactly"));
  await page.evaluate(async id => window.matbotTransport.switchWorkspace(id), workspaceB.id);
  await page.reload();
  await request.post(`/__test/workspaces/${workspaceB.id}/providers`, { data: { providers: ["Disposable-B"] } });
  await page.evaluate(async () => {
    await window.matbotTransport.callTool("workspace_action", {
      action: "write", path: "same.txt", content: "workspace B deleted"
    });
    await window.matbotTransport.callTool("skill_action", {
      action: "save", name: "Disposable Skill", content: "# Delete me"
    });
    await window.matbotTransport.callTool("remembered_facts_action", {
      action: "set",
      data: { fact: "Disposable memory", sessionId: "manual", messageId: "manual", createdAt: new Date().toISOString() }
    });
    await window.matbotTransport.callTool("workspace_rag", {
      action: "configure", contextId: "default", contextName: "Disposable RAG", paths: ["C:\\Disposable\\B"]
    });
    await window.matbotTransport.callTool("plugin", {
      action: "add", specifier: "./packages/plugins/background"
    });
  });
  await page.locator("#new-btn").click();

  await page.evaluate(async () => window.matbotTransport.switchWorkspace("default"));
  await page.reload();
  await page.locator("#workspace-toggle-btn").click();
  const row = page.locator(`.workspace-row[data-workspace-id="${workspaceB.id}"]`);
  await row.locator(".workspace-delete-btn").click();
  await expect(page.locator("#workspace-delete-message")).toContainText('Delete "Delete Me Exactly"');
  await page.locator("#workspace-delete-confirm").click();
  await expect(row).toHaveCount(0);

  const deletedState = await (await request.get(`/__test/workspaces/${workspaceB.id}/state`)).json();
  expect(deletedState).toEqual({
    exists: false,
    sessions: 0,
    files: 0,
    skills: 0,
    memories: 0,
    hasRagState: false,
    hasPluginState: false,
    hasProviderState: false
  });
  const survivingFile = await page.evaluate(async () => window.matbotTransport.callTool(
    "workspace_action", { action: "read", path: "same.txt" }
  ));
  expect(survivingFile).toBe("workspace A survives");
  await expect(page.locator('.workspace-row[data-workspace-id="default"] .workspace-delete-btn')).toHaveCount(0);
});

test("T2-E2E-005 renders workspace and session names as inert text", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop untrusted display-data contract");
  await page.addInitScript(() => { window.__cortexXssCanary = 0; });
  await page.goto("/");
  const payload = '<img src=x onerror="window.__cortexXssCanary=1"> bidirectional-safe';
  await page.evaluate(async value => {
    await window.matbotTransport.createWorkspace(value);
    await window.matbotTransport.callTool("session_action", {
      action: "rename", sessionId: "s0", title: value
    });
  }, payload);
  await page.reload();
  await page.locator("#workspace-toggle-btn").click();
  await expect(page.locator(".workspace-option-name", { hasText: payload })).toBeVisible();
  await expect(page.locator(".session-label").first()).toContainText("<img src=x");
  expect(await page.evaluate(() => window.__cortexXssCanary)).toBe(0);
  await expect(page.locator(".workspace-option-name img, .session-label img")).toHaveCount(0);
});

test("T2-E2E-007 restores an unaccepted prompt and retries it exactly once", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop normal-turn recovery");
  let submissions = 0;
  await page.route("**/sessions/*/submit", async route => {
    submissions += 1;
    if (submissions === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "provider temporarily unavailable" })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await page.locator("#new-btn").click();
  await page.locator("#input").fill("exactly once recovery prompt");
  await page.keyboard.press("Enter");
  await expect(page.locator(".msg-error").last()).toContainText("provider temporarily unavailable");
  await expect(page.locator("#input")).toHaveValue("exactly once recovery prompt");

  const sid = await page.locator(".session-item.active").getAttribute("data-sid");
  let stored = await page.evaluate(async id => window.matbotTransport.callTool(
    "session_action", { action: "get", sessionId: id }
  ), sid);
  expect(stored.messages).toHaveLength(0);

  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("exactly once recovery prompt");
  stored = await page.evaluate(async id => window.matbotTransport.callTool(
    "session_action", { action: "get", sessionId: id }
  ), sid);
  expect(stored.messages.filter(message => message.role === "user")).toHaveLength(1);
  expect(submissions).toBe(2);
});

test("T2-E2E-008 keeps a file row and recovers when deletion fails", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop file deletion recovery");
  let failDelete = true;
  await page.route("**/tools/workspace_action", async route => {
    const input = route.request().postDataJSON();
    if (failDelete && input.action === "delete" && input.path === "retain-on-failure.txt") {
      failDelete = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "file delete temporarily unavailable" })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await page.setInputFiles("#upload-input", {
    name: "retain-on-failure.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retain me", "utf8")
  });
  const row = page.locator('.file-item[data-path="retain-on-failure.txt"]');
  const deleteFailure = new Promise(resolve => page.once("dialog", async dialog => {
    resolve(dialog.message());
    await dialog.dismiss();
  }));
  await row.hover();
  await row.locator(".file-action-btn").click();
  expect(await deleteFailure).toContain("file delete temporarily unavailable");
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator(".file-action-btn").click();
  await expect(row).toHaveCount(0);
});

test("T2-E2E-010 round-trips and clears memory administrative fields", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop memory administrative fields");
  await page.goto("/");
  await openSkills(page);
  await page.locator("#memory-browser-btn").click();
  await page.locator("#memory-browser-new-fact").fill("Administrative memory field probe.");
  await page.locator("#memory-browser-add").click();
  await page.locator("#memory-browser-dream-skill").fill("Operations");
  await page.locator("#memory-browser-ignore-until").fill("2030-01-02T03:04:05.000Z");
  await page.locator("#memory-browser-save").click();
  await page.locator("#memory-browser-btn").click();
  await expect(page.locator("#memory-browser-dream-skill")).toHaveValue("Operations");
  await expect(page.locator("#memory-browser-ignore-until")).toHaveValue("2030-01-02T03:04:05.000Z");
  await page.locator("#memory-browser-dream-skill").fill("");
  await page.locator("#memory-browser-ignore-until").fill("");
  await page.locator("#memory-browser-save").click();
  await page.locator("#memory-browser-btn").click();
  await expect(page.locator("#memory-browser-dream-skill")).toHaveValue("");
  await expect(page.locator("#memory-browser-ignore-until")).toHaveValue("");
});

test("T2-E2E-011 preserves skill content when save fails and retries once", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop skill save recovery");
  await page.addInitScript(() => {
    window.TinyMDE = {
      Editor: class {
        constructor({ textarea }) { this.textarea = textarea; }
        setContent(value) { this.textarea.value = value; }
        getContent() { return this.textarea.value; }
      },
      CommandBar: class {}
    };
  });
  let saves = 0;
  await page.route("**/tools/skill_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "save") {
      saves += 1;
      if (saves === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "skill store temporarily unavailable" })
        });
        return;
      }
    }
    await route.fallback();
  });
  await page.goto("/");
  await openSkills(page);
  await page.locator(".skill-entry", { hasText: "Panel Etiquette" }).click();
  await page.locator("#skill-editor-text").evaluate((element, value) => {
    element.value = value;
  }, "# Unsaved probe\nKeep this exact content.");
  await page.locator("#skill-editor-save").click();
  await expect(page.locator("#skill-editor-overlay")).toHaveClass(/open/);
  await expect(page.locator("#skill-editor-error")).toContainText("skill store temporarily unavailable");
  await expect(page.locator("#skill-editor-text")).toHaveValue("# Unsaved probe\nKeep this exact content.");
  await page.locator("#skill-editor-save").click();
  await expect(page.locator("#skill-editor-overlay")).not.toHaveClass(/open/);
  expect(saves).toBe(2);
});

test("T2-E2E-012 retains successful expert evidence when one expert times out", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop partial expert failure");
  await page.goto("/");
  await page.locator("#expert-toggle-btn").click();
  await page.locator("#expert-enabled").check();
  await page.locator("#expert-mode").selectOption("parallel");
  await page.locator("#expert-synthesize").check();
  await page.locator("#expert-toggle-btn").click();
  await page.locator("#input").fill("partial expert failure");
  await page.keyboard.press("Enter");
  const answer = page.locator(".message.assistant").last();
  await expect(answer).toContainText("Design Expert answer");
  await expect(answer).toContainText("Finance Expert");
  await expect(answer).toContainText("Simulated finance expert timeout");
  await expect(answer).toContainText("excluded Finance Expert");
});

test("T2-E2E-013 keeps denied-source canaries out of graph retrieval", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop denied-source browser contract");
  const deniedCanary = "DENIED-SOURCE-CANARY-741";
  await page.route("**/tools/context_graph_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "retrieve") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entities: [{
            id: "allowed-entity", canonicalName: "Allowed entity", type: "document",
            aliases: [], identifiers: {}, sensitivity: "internal"
          }],
          facts: [],
          warnings: ["One denied source was excluded."]
        })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openArchitecturePanel(page, "graph");
  await page.locator("#architecture-graph-search").fill(`allowed, ${deniedCanary}`);
  await page.locator("#architecture-graph-form").evaluate(form => form.requestSubmit());
  await expect(page.locator("#architecture-graph-status")).toContainText("Retrieved 0 fact");
  await expect(page.locator("#architecture-screen")).not.toContainText(deniedCanary);
  await expect(page.locator("#architecture-graph-list")).toContainText("allowed-entity");
});

test("T2-E2E-014 ignores an older SQL plan that completes after a newer plan", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop SQL planning race");
  let releaseOld;
  const oldReleased = new Promise(resolve => { releaseOld = resolve; });
  let oldStarted;
  const oldSeen = new Promise(resolve => { oldStarted = resolve; });
  await page.route("**/tools/structured_data_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "plan_query" && input.plan?.metricName === "revenue") {
      oldStarted();
      await oldReleased;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openArchitecturePanel(page, "sql");
  await page.locator("#architecture-sql-metric").fill("revenue");
  await page.locator("#architecture-sql-form").evaluate(form => form.requestSubmit());
  await oldSeen;
  await page.locator("#architecture-sql-metric").fill("orders");
  await page.locator("#architecture-sql-form").evaluate(form => form.requestSubmit());
  await expect(page.locator("#architecture-sql-preview")).toContainText("count(");
  const currentPreview = await page.locator("#architecture-sql-preview").textContent();
  releaseOld();
  await page.waitForTimeout(100);
  await expect(page.locator("#architecture-sql-preview")).toHaveText(currentPreview);
});

test("T2-E2E-015 presents a failed post-approval workflow action as failed", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop failed workflow execution evidence");
  await page.goto("/");
  const seeded = await page.evaluate(async () => window.matbotTransport.callTool("workflow_action", {
    action: "compile", workspaceId: "default", name: "Failed External Action", publish: true, dryRun: true
  }));
  const runId = seeded.dryRun?.id ?? seeded.compilation?.dryRunId;
  await page.route("**/tools/workflow_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "inspect_run" && input.runId === runId) {
      const response = await route.fetch();
      const body = await response.json();
      body.run.status = "failed";
      body.run.completionState = "failed";
      body.run.executedActions = [{
        id: "failed-action", toolName: "file_broker_action", status: "failed",
        error: "simulated external write failure"
      }];
      body.events.push({ id: "failed-event", eventType: "tool_execution_failed", sequence: 999 });
      await route.fulfill({ response, json: body });
      return;
    }
    await route.fallback();
  });
  await openArchitecturePanel(page, "workflows");
  await page.getByRole("tab", { name: "Run Ledger" }).click();
  await page.locator(`#workflow-ops-run-list .architecture-item[data-run-id="${runId}"]`).click();
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("failed");
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("simulated external write failure");
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("tool_execution_failed");
});

test("T2-E2E-016 renders finite honest ROI for zero cost and negative benefit", async ({ page, isMobile }) => {
  await page.route("**/tools/evaluation_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "roi") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          verifiedOutcomes: 1,
          timeSavedHours: 0,
          operatingCostUsd: 0,
          fixedCostUsd: 0,
          totalBenefitUsd: 0,
          netBenefitUsd: -25,
          roi: null,
          paybackOutcomes: null,
          byWorkflow: []
        })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  if (isMobile) await page.locator("#burger").click();
  await openArchitecturePanel(page, "evaluation");
  await expect(page.locator("#evaluation-net-benefit")).toContainText("-$25");
  await expect(page.locator("#evaluation-roi-detail")).toContainText("Awaiting cost baseline");
  await expect(page.locator("#architecture-screen")).not.toContainText(/NaN|Infinity/);
});

test("T2-E2E-017 normalizes graph terms and ignores an overlapping stale retrieval", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop graph overlap race");
  const requests = [];
  let releaseOld;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  await page.route("**/tools/context_graph_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action !== "retrieve") return route.fallback();
    requests.push(input);
    if (input.terms.includes("old")) await oldGate;
    const term = input.terms.includes("old") ? "Old result" : "Newest result";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entities: [{
          id: term.toLowerCase().replace(" ", "-"), canonicalName: term, type: "document",
          aliases: [], identifiers: {}, sensitivity: "internal"
        }],
        facts: []
      })
    });
  });
  await page.goto("/");
  await openArchitecturePanel(page, "graph");
  await page.locator("#architecture-graph-search").fill("old, old");
  await page.locator("#architecture-graph-form").evaluate(form => form.requestSubmit());
  await expect.poll(() => requests.length).toBe(1);
  await page.locator("#architecture-graph-retrieve").evaluate(button => { button.disabled = false; });
  await page.locator("#architecture-graph-search").fill(" newest , newest ");
  await page.locator("#architecture-graph-form").evaluate(form => form.requestSubmit());
  await expect(page.locator("#architecture-graph-list")).toContainText("newest-result");
  releaseOld();
  await page.waitForTimeout(100);
  await expect(page.locator("#architecture-graph-list")).toContainText("newest-result");
  await expect(page.locator("#architecture-graph-list")).not.toContainText("old-result");
  expect(requests[1].terms).toEqual(["newest"]);
});

test("T2-E2E-018 keeps durable reviews isolated across workspaces", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop review workspace isolation");
  await page.goto("/");
  await page.evaluate(async () => window.matbotTransport.callTool("expert_panel", {
    action: "review",
    workspaceId: "default",
    question: "Workspace A review canary",
    targetType: "decision",
    targetId: "shared-target",
    experts: ["design"]
  }));
  const workspaceB = await page.evaluate(async () => window.matbotTransport.createWorkspace("Review B"));
  await page.evaluate(async id => window.matbotTransport.switchWorkspace(id), workspaceB.id);
  await page.reload();
  await openArchitecturePanel(page, "reviews");
  await expect(page.locator("#architecture-review-list")).not.toContainText("Workspace A review canary");
  await page.evaluate(async id => window.matbotTransport.callTool("expert_panel", {
    action: "review",
    workspaceId: id,
    question: "Workspace B review canary",
    targetType: "decision",
    targetId: "shared-target",
    experts: ["design"]
  }), workspaceB.id);
  await page.locator("#architecture-review-refresh").click();
  await expect(page.locator("#architecture-review-list")).toContainText("Workspace B review canary");
  await expect(page.locator("#architecture-review-list")).not.toContainText("Workspace A review canary");
});

test("T2-E2E-019 rolls back failed optional-plugin removal and retries once", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop plugin removal rollback");
  await page.goto("/");
  await page.evaluate(async () => window.matbotTransport.callTool("plugin", {
    action: "add", specifier: "./packages/plugins/background"
  }));
  await page.reload();
  let removals = 0;
  await page.route("**/sessions/*/submit", async route => {
    const input = route.request().postDataJSON();
    if (String(input.content).startsWith("Remove the plugin")) {
      removals += 1;
      if (removals === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "plugin removal temporarily unavailable" })
        });
        return;
      }
    }
    await route.fallback();
  });
  await openPlugins(page);
  const active = page.locator("details.plugin-entry", { hasText: "@matatbread/matbot-tool-background" });
  await active.hover();
  await active.getByTitle("Remove plugin").click();
  await expect(page.locator(".msg-error").last()).toContainText("plugin removal temporarily unavailable");
  await expect(active).toBeVisible();
  await active.hover();
  await active.getByTitle("Remove plugin").click();
  await expect(active).toHaveCount(0);
  expect(removals).toBe(2);
});

test("T2-E2E-021 restores focus when a destructive dialog is cancelled by keyboard", async ({ page }) => {
  await page.goto("/");
  const disposable = await page.evaluate(async () => window.matbotTransport.createWorkspace("Keyboard Delete"));
  await page.reload();
  if (await page.locator("#burger").isVisible()) await page.locator("#burger").click();
  await page.locator("#workspace-toggle-btn").click();
  const trigger = page.locator(`.workspace-row[data-workspace-id="${disposable.id}"] .workspace-delete-btn`);
  await trigger.focus();
  await trigger.press("Enter");
  await expect(page.locator("#workspace-delete-confirm")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#workspace-delete-dialog")).not.toHaveClass(/open/);
  await expect(trigger).toBeFocused();
});

test("T2-E2E-022 reports a cross-tab memory edit conflict without overwriting", async ({ page, context, isMobile }) => {
  test.skip(isMobile, "desktop multi-tab memory concurrency");
  await page.goto("/");
  const created = await page.evaluate(async () => window.matbotTransport.callTool("remembered_facts_action", {
    action: "set",
    data: { fact: "Cross-tab original", sessionId: "manual", messageId: "manual", createdAt: new Date().toISOString() }
  }));
  const second = await context.newPage();
  await second.goto("/");
  for (const current of [page, second]) {
    await openSkills(current);
    await current.locator("#memory-browser-btn").click();
    await current.locator(".memory-browser-item", { hasText: "Cross-tab original" }).click();
  }
  await page.locator("#memory-browser-fact-input").fill("Cross-tab first writer");
  await page.locator("#memory-browser-save").click();
  await second.locator("#memory-browser-fact-input").fill("Cross-tab stale writer");
  await second.locator("#memory-browser-save").click();
  await expect(second.locator("#memory-browser-panel-status")).toContainText("Version conflict");
  const stored = await page.evaluate(async id => window.matbotTransport.callTool(
    "remembered_facts_action", { action: "get", id }
  ), created.id);
  expect(stored.fact).toBe("Cross-tab first writer");
  await second.close();
});

test("T2-E2E-023 explains a missing provider and retains the prompt", async ({ page, request, isMobile }) => {
  test.skip(isMobile, "desktop provider troubleshooting");
  await request.post("/__test/workspaces/default/providers", { data: { providers: [] } });
  await page.goto("/");
  await expect(page.locator("#provider-select option")).toHaveCount(0);
  await page.locator("#input").fill("retain this prompt while provider is missing");
  await page.keyboard.press("Enter");
  await expect(page.locator(".msg-error").last()).toContainText("no model provider is available in the active workspace");
  await expect(page.locator("#input")).toHaveValue("retain this prompt while provider is missing");
});

test("T3-E2E-001 sanitizes hostile Markdown, URLs, file names, and graph labels", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop cross-surface sanitization matrix");
  await page.addInitScript(() => { window.__cortexXssCanary = 0; });
  const canaryRequests = [];
  page.on("request", request => {
    if (request.url().includes("canary.invalid")) canaryRequests.push(request.url());
  });
  const hostileHtml = '<img src="//canary.invalid/tracker.png" onerror="window.__cortexXssCanary++">';
  const payload = [
    hostileHtml,
    "[unsafe](JaVaScRiPt:window.__cortexXssCanary++)",
    "[protocol-relative](//canary.invalid/navigation)",
    "[safe](https://example.test/safe)"
  ].join("");
  await page.route("**/tools/context_graph_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "retrieve") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entities: [{
            id: "hostile-entity",
            canonicalName: hostileHtml,
            type: "document",
            aliases: [hostileHtml],
            identifiers: {},
            sensitivity: "internal"
          }],
          facts: []
        })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await page.setInputFiles("#upload-input", {
    name: '<img onerror="window.__cortexXssCanary++">.md',
    mimeType: "text/markdown",
    buffer: Buffer.from(payload)
  });
  await expect(page.locator('.file-item[data-path*="img onerror"] .file-name')).toContainText("<img onerror");
  await page.locator("#new-btn").click();
  await page.locator("#input").fill(payload);
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("unsafe");
  const answer = page.locator(".message.assistant").last();
  await expect(answer.getByRole("link", { name: "unsafe" })).toHaveCount(0);
  await expect(answer.getByText("unsafe", { exact: true })).toBeVisible();
  await expect(answer.getByRole("link", { name: "protocol-relative" })).toHaveCount(0);
  await expect(answer.getByText("protocol-relative", { exact: true })).toBeVisible();
  await expect(answer.getByRole("link", { name: "safe" })).toHaveAttribute("href", "https://example.test/safe");
  await expect(answer.getByRole("link", { name: "safe" })).toHaveAttribute("target", "_blank");
  await expect(answer.getByRole("link", { name: "safe" })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(answer.locator("img, [onerror]")).toHaveCount(0);

  await openArchitecturePanel(page, "graph");
  await page.locator("#architecture-graph-search").fill("hostile");
  await page.locator("#architecture-graph-form").evaluate(form => form.requestSubmit());
  await expect(page.locator("#architecture-graph-list")).toContainText("<img src=");
  await expect(page.locator("#architecture-graph-list img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__cortexXssCanary)).toBe(0);
  expect(canaryRequests).toEqual([]);
});

test("T3-E2E-002 fences a delayed file response to its initiating workspace", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workspace generation fencing");
  let releaseOld;
  let signalOld;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  const oldSeen = new Promise(resolve => { signalOld = resolve; });
  let holdNextList = false;
  await page.route("**/tools/workspace_action", async route => {
    const input = route.request().postDataJSON();
    if (holdNextList && input.action === "list") {
      holdNextList = false;
      signalOld();
      await oldGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ path: "OUTGOING-FILE-CANARY.txt", size: 10 }])
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  const target = await page.evaluate(async () => window.matbotTransport.createWorkspace("Generation B"));
  await page.evaluate(async id => window.matbotTransport.switchWorkspace(id), target.id);
  await page.evaluate(async () => {
    await window.matbotTransport.callTool("workspace_action", {
      action: "write", path: "workspace-b.txt", content: "B"
    });
    await window.matbotTransport.switchWorkspace("default");
    await loadWorkspaces();
  });
  holdNextList = true;
  await page.evaluate(() => { void loadFiles(); });
  await oldSeen;
  await page.evaluate(async id => {
    await window.matbotTransport.switchWorkspace(id);
    await loadWorkspaces();
    await loadFiles();
  }, target.id);
  await expect(page.locator(".file-item")).toContainText("workspace-b.txt");
  releaseOld();
  await page.waitForTimeout(100);
  await expect(page.locator("#file-list")).not.toContainText("OUTGOING-FILE-CANARY");
  await expect(page.locator(".file-item")).toContainText("workspace-b.txt");
});

test("T3-E2E-006 excludes one denied-source canary from evidence product surfaces", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop denied evidence propagation");
  const denied = "DENIED-EVIDENCE-CANARY-9831";
  await page.route("**/tools/context_graph_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "retrieve") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entities: [{
            id: "allowed-only",
            canonicalName: "Allowed evidence",
            type: "document",
            aliases: [],
            identifiers: {},
            sensitivity: "internal"
          }],
          facts: [],
          warnings: ["Denied evidence was excluded."]
        })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openArchitecturePanel(page, "sources");
  await expect(page.locator("#architecture-screen")).not.toContainText(denied);
  await openArchitecturePanel(page, "graph");
  await page.locator("#architecture-graph-search").fill(denied);
  await page.locator("#architecture-graph-form").evaluate(form => form.requestSubmit());
  await expect(page.locator("#architecture-graph-list")).toContainText("allowed-only");
  await openArchitecturePanel(page, "evaluation");
  await expect(page.locator("#architecture-screen")).not.toContainText(denied);
  await openArchitecturePanel(page, "reviews");
  await expect(page.locator("#architecture-screen")).not.toContainText(denied);
  await openArchitecturePanel(page, "workflows");
  await expect(page.locator("#architecture-screen")).not.toContainText(denied);
});

test("T3-E2E-008 preserves a valid provider through discovery failure and falls back deterministically", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop provider discovery recovery");
  await page.goto("/");
  await page.locator("#provider-select").selectOption("openai");
  let failDiscovery = true;
  await page.route("**/tools/provider", async route => {
    if (failDiscovery) {
      failDiscovery = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "provider discovery temporarily unavailable" })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ providers: [{ name: "Recovered-Provider" }] })
    });
  });
  expect(await page.evaluate(() => refreshProviderSelect())).toBe(false);
  await expect(page.locator("#provider-select")).toHaveValue("openai");
  await expect(page.locator("#provider-select")).toHaveAttribute("title", /Provider list unavailable/i);
  expect(await page.evaluate(() => refreshProviderSelect())).toBe(true);
  await expect(page.locator("#provider-select")).toHaveValue("Recovered-Provider");
  await expect(page.locator("#provider-select option")).toHaveCount(1);
});

test("T3-E2E-009 reconciles one accepted turn after reload loses its stream", async ({ page, request, isMobile }) => {
  test.skip(isMobile, "desktop accepted-turn reconciliation");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await page.locator("#input").fill("slow accepted reload recovery");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Starting slow response");
  const sid = await page.locator(".session-item.active").getAttribute("data-sid");
  await page.reload();
  await expect(page.locator("#send-btn")).toHaveClass(/stop-mode/);
  const completed = await request.post(`/__test/sessions/${encodeURIComponent(sid)}/complete`, {
    data: { text: "Recovered terminal response after stream loss." }
  });
  expect(completed.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator(".message.assistant").last()).toContainText("Recovered terminal response after stream loss");
  await expect(page.locator("#send-btn")).not.toHaveClass(/stop-mode/);
  const stored = await page.evaluate(async id => window.matbotTransport.callTool(
    "session_action", { action: "get", sessionId: id }
  ), sid);
  expect(stored.messages.filter(message => message.role === "user")).toHaveLength(1);
  expect(stored.messages.filter(message => message.role === "assistant")).toHaveLength(1);
});

test("T3-E2E-010 handles empty and binary files, explicit collision choice, and failed-send attachment retention", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop file boundary and attachment recovery");
  await page.goto("/");
  await page.setInputFiles("#upload-input", [
    { name: "empty.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(0) },
    { name: "binary.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 1, 2]) },
    { name: "collision.txt", mimeType: "text/plain", buffer: Buffer.from("original") }
  ]);
  await expect(page.locator('.file-item[data-path="empty.bin"]')).toContainText("0 B");
  await expect(page.locator('.file-item[data-path="binary.bin"]')).toContainText("4 B");
  const collisionDialog = new Promise(resolve => page.once("dialog", async dialog => {
    resolve(dialog.message());
    await dialog.dismiss();
  }));
  await page.setInputFiles("#upload-input", {
    name: "collision.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("replacement")
  });
  expect(await collisionDialog).toContain('Replace existing workspace file "collision.txt"');
  const collisionValue = await page.evaluate(async () => window.matbotTransport.callTool(
    "workspace_action", { action: "read", path: "collision.txt" }
  ));
  expect(collisionValue).toBe("original");
  const binaryValue = await page.evaluate(async () => window.matbotTransport.callTool(
    "workspace_action", { action: "read", path: "binary.bin", encoding: "base64" }
  ));
  expect(binaryValue).toBe(Buffer.from([0, 255, 1, 2]).toString("base64"));

  await expect(page.locator('.file-item[data-path="binary.bin"] .file-attach-btn')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.attachment-chip[data-attachment-path="binary.bin"]')).toBeVisible();
  let failed = false;
  await page.route("**/sessions/*/submit", async route => {
    if (!failed) {
      failed = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "submission unavailable" })
      });
      return;
    }
    await route.fallback();
  });
  await page.locator("#input").fill("read binary attachment");
  await page.keyboard.press("Enter");
  await expect(page.locator('.attachment-chip[data-attachment-path="binary.bin"]')).toBeVisible();
  await expect(page.locator("#input")).toHaveValue("read binary attachment");
});

test("T3-E2E-012 paginates memories and recovers a stale delete without losing selection", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop memory pagination and delete CAS");
  await page.goto("/");
  await page.evaluate(async () => {
    for (let index = 0; index < 55; index += 1) {
      await window.matbotTransport.callTool("remembered_facts_action", {
        action: "set",
        data: {
          fact: `Paged memory ${String(index).padStart(2, "0")}`,
          sessionId: "manual",
          messageId: "manual",
          createdAt: new Date(Date.now() + index).toISOString()
        }
      });
    }
  });
  await openSkills(page);
  await page.locator("#memory-browser-btn").click();
  await expect(page.locator("#memory-browser-count")).toContainText("50 of 55");
  await page.locator("#memory-browser-load-more").click();
  await expect(page.locator("#memory-browser-count")).toContainText("55 of 55");
  await expect(page.locator(".memory-browser-item")).toHaveCount(55);

  let staleDelete = true;
  await page.route("**/tools/remembered_facts_action", async route => {
    const input = route.request().postDataJSON();
    if (staleDelete && input.action === "delete") {
      staleDelete = false;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, deleted: false })
      });
      return;
    }
    await route.fallback();
  });
  const selectedFact = await page.locator("#memory-browser-fact-input").inputValue();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#memory-browser-delete").click();
  await expect(page.locator("#memory-browser-panel-status")).toContainText("Delete did not apply");
  await expect(page.locator("#memory-browser-fact-input")).toHaveValue(selectedFact);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#memory-browser-delete").click();
  await expect(page.locator(".memory-browser-item")).toHaveCount(54);
});

test("T3-E2E-013 requires an explicit decision before discarding unsaved skill content", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop unsaved skill decision");
  await page.addInitScript(() => {
    window.TinyMDE = {
      Editor: class {
        constructor({ textarea }) { this.textarea = textarea; }
        setContent(value) { this.textarea.value = value; }
        getContent() { return this.textarea.value; }
      },
      CommandBar: class {}
    };
  });
  await page.goto("/");
  await openSkills(page);
  await page.locator(".skill-entry", { hasText: "Panel Etiquette" }).click();
  await expect(page.locator("#skill-editor-overlay")).toHaveClass(/open/);
  await page.evaluate(() => skillEditor.setContent("# Unsaved content\nDo not lose this."));
  const keepOpen = new Promise(resolve => page.once("dialog", async dialog => {
    resolve(dialog.message());
    await dialog.dismiss();
  }));
  await page.locator("#skill-editor-cancel").click();
  expect(await keepOpen).toContain("Discard unsaved skill changes");
  await expect(page.locator("#skill-editor-overlay")).toHaveClass(/open/);
  await expect(page.locator("#skill-editor-text")).toHaveValue("# Unsaved content\nDo not lose this.");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#skill-editor-cancel").click();
  await expect(page.locator("#skill-editor-overlay")).not.toHaveClass(/open/);
});

test("T3-E2E-014 retains independent expert evidence when synthesis alone fails", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop synthesis-only failure");
  await page.goto("/");
  await page.locator("#expert-toggle-btn").click();
  await page.locator("#expert-enabled").check();
  await page.locator("#expert-synthesize").check();
  await page.locator("#expert-toggle-btn").click();
  await page.locator("#input").fill("synthesis only failure");
  await page.keyboard.press("Enter");
  const answer = page.locator(".message.assistant").last();
  await expect(answer).toContainText("Design Expert answer");
  await expect(answer).toContainText("Finance Expert answer");
  await expect(answer).toContainText("Engineering Expert answer");
  await expect(answer).toContainText("Synthesis unavailable");
  await expect(answer).toContainText("independent expert evidence remains available");
});

test("T3-E2E-016 keeps workflow modes and immutable versions distinct through multi-gate decisions", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow version and multi-gate matrix");
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const v1 = await window.matbotTransport.callTool("workflow_action", {
      action: "compile",
      workspaceId: "default",
      name: "Versioned Governed Flow",
      purpose: "Version one",
      riskLevel: "high",
      allowedTool: "file_broker_action",
      publish: true
    });
    const v2 = await window.matbotTransport.callTool("workflow_action", {
      action: "compile",
      workspaceId: "default",
      name: "Versioned Governed Flow",
      purpose: "Version two",
      riskLevel: "high",
      allowedTool: "file_broker_action",
      publish: true
    });
    const dry = await window.matbotTransport.callTool("workflow_action", {
      action: "start",
      workspaceId: "default",
      workflowId: v1.published.definition.id,
      workflowVersion: v1.published.definition.version,
      mode: "dry_run"
    });
    const shadow = await window.matbotTransport.callTool("workflow_action", {
      action: "start",
      workspaceId: "default",
      workflowId: v2.published.definition.id,
      workflowVersion: v2.published.definition.version,
      mode: "shadow"
    });
    const gated = await window.matbotTransport.callTool("workflow_action", {
      action: "start",
      workspaceId: "default",
      workflowId: v2.published.definition.id,
      workflowVersion: v2.published.definition.version,
      mode: "approval_gated"
    });
    const first = await window.matbotTransport.callTool("workflow_action", {
      action: "approve", runId: gated.id, approvalId: "approval:action"
    });
    const second = await window.matbotTransport.callTool("workflow_action", {
      action: "reject", runId: gated.id, approvalId: "approval:expert-review"
    });
    return { v1, v2, dry, shadow, gated, first, second };
  });
  expect(result.v1.published.definition.version).not.toBe(result.v2.published.definition.version);
  expect(result.dry.mode).toBe("dry_run");
  expect(result.dry.executedActions).toEqual([]);
  expect(result.shadow.mode).toBe("shadow");
  expect(result.shadow.executedActions).toEqual([]);
  expect(result.first.run.status).toBe("waiting_for_approval");
  expect(result.second.run.status).toBe("failed");

  await openArchitecturePanel(page, "workflows");
  await page.getByRole("tab", { name: "Run Ledger" }).click();
  await page.locator(`#workflow-ops-run-list .architecture-item[data-run-id="${result.gated.id}"]`).click();
  await expect(page.locator("#workflow-ops-run-detail")).toContainText(result.v2.published.definition.version);
  await expect(page.locator("#workflow-ops-run-detail")).toContainText("failed");
});

test("T3-E2E-017 reports replay reconstruction failure without executing writes", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop replay failure");
  let replayCalls = 0;
  await page.route("**/tools/evaluation_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "replay") {
      replayCalls += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Replay unavailable: stored span graph is incomplete; no writes executed." })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openArchitecturePanel(page, "evaluation");
  await page.getByRole("button", { name: "Replay trace safely" }).click();
  await expect(page.locator("#architecture-evaluation-status")).toContainText("stored span graph is incomplete");
  await expect(page.locator("#architecture-evaluation-status")).toContainText("no writes executed");
  expect(replayCalls).toBe(1);
});

test("T3-E2E-018 enforces graph source constraints and drops malformed relationships", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop graph validation matrix");
  let retrieveInput;
  await page.route("**/tools/context_graph_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "retrieve") {
      retrieveInput = input;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entities: [
            { id: "entity-a", canonicalName: "Entity A", type: "service", aliases: [], identifiers: {} },
            { id: "entity-b", canonicalName: "Entity B", type: "service", aliases: [], identifiers: {} }
          ],
          facts: [
            {
              subject: { id: "entity-a", canonicalName: "Entity A" },
              object: { id: "entity-b", canonicalName: "Entity B" },
              relationship: {
                subjectEntityId: "entity-a",
                objectEntityId: "entity-b",
                predicate: "depends_on",
                confidence: 0.8
              },
              sourceId: "source:allowed",
              sourceVersionId: "v1"
            },
            {
              subject: { id: "entity-a", canonicalName: "Entity A" },
              object: { id: "entity-a", canonicalName: "Entity A" },
              relationship: {
                subjectEntityId: "entity-a",
                objectEntityId: "entity-a",
                predicate: "INVALID_SELF_EDGE",
                confidence: 5
              },
              sourceId: "source:allowed",
              sourceVersionId: "v1"
            }
          ]
        })
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openArchitecturePanel(page, "graph");
  await page.locator("#architecture-graph-search").fill("  Żółć , żółć  ");
  await page.locator("#architecture-graph-source").fill("source:allowed");
  await page.locator("#architecture-graph-form").evaluate(form => form.requestSubmit());
  await expect(page.locator("#architecture-graph-detail")).toContainText("depends_on");
  await expect(page.locator("#architecture-graph-detail")).not.toContainText("INVALID_SELF_EDGE");
  expect(retrieveInput.sourceIds).toEqual(["source:allowed"]);
  expect(retrieveInput.terms).toEqual(["Żółć", "żółć"]);
});

test("T3-E2E-019 validates review targets and deduplicates expert IDs before creation", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop review target validation");
  let reviewInput;
  await page.route("**/tools/expert_panel", async route => {
    const input = route.request().postDataJSON();
    if (input.action === "review") reviewInput = input;
    await route.fallback();
  });
  await page.goto("/");
  await openArchitecturePanel(page, "reviews");
  await page.locator("#architecture-review-target-id").fill("");
  await page.locator("#architecture-review-form").evaluate(form => form.requestSubmit());
  await expect(page.locator("#architecture-review-status")).toContainText("Target ID is required");
  expect(reviewInput).toBeUndefined();

  await page.locator("#architecture-review-target-id").fill("workflow:compiled-followup");
  await page.locator("#architecture-review-workflow-id").fill("workflow:compiled-followup");
  await page.locator("#architecture-review-experts").fill("finance, finance, engineering");
  await page.locator("#architecture-review-form").evaluate(form => form.requestSubmit());
  await expect(page.locator("#architecture-review-status")).toContainText("Review created");
  expect(reviewInput.experts).toEqual(["finance", "engineering"]);
});

test("T3-E2E-020 persists optional plugin configuration across frontend reloads", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop plugin persistence");
  await page.goto("/");
  await page.evaluate(async () => window.matbotTransport.callTool("plugin", {
    action: "add", specifier: "./packages/plugins/background"
  }));
  await page.reload();
  await openPlugins(page);
  await expect(page.locator("details.plugin-entry", { hasText: "@matatbread/matbot-tool-background" })).toBeVisible();
  await page.evaluate(async () => window.matbotTransport.callTool("plugin", {
    action: "remove", specifier: "./packages/plugins/background"
  }));
  await page.reload();
  await openPlugins(page);
  await expect(page.locator("details.plugin-entry", { hasText: "@matatbread/matbot-tool-background" })).toHaveCount(0);
  await expect(page.locator(".plugin-entry-inactive", { hasText: "@matatbread/matbot-tool-background" })).toBeVisible();
});

test("T3-E2E-022 traps focus and announces status for destructive workspace decisions", async ({ page, isMobile }) => {
  await page.goto("/");
  const disposable = await page.evaluate(async () => window.matbotTransport.createWorkspace("Accessible Delete"));
  await page.reload();
  if (isMobile) await page.locator("#burger").click();
  await page.locator("#workspace-toggle-btn").click();
  const trigger = page.locator(`.workspace-row[data-workspace-id="${disposable.id}"] .workspace-delete-btn`);
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.locator("#workspace-delete-dialog");
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("#workspace-delete-confirm")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#workspace-delete-cancel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#workspace-delete-confirm")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#workspace-delete-cancel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.locator("#workspace-status")).toHaveAttribute("role", "status");
  await expect(page.locator("#workspace-status")).toHaveAttribute("aria-live", "polite");
});

test("T3-E2E-023 distinguishes provider discovery, missing plugin, and RAG diagnostics without destructive advice", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop troubleshooting matrix");
  await page.route("**/tools/provider", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "provider discovery transport unavailable" })
  }));
  await page.route("**/tools/workspace_action", route => route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "workspace tool not found (404)" })
  }));
  await page.route("**/tools/workspace_rag", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "workspace RAG service unavailable" })
  }));
  await page.goto("/");
  await expect(page.locator("#provider-select option")).toHaveText("Provider list unavailable — retry after restart");
  await expect(page.locator("#provider-select")).toHaveAttribute("title", /active workspace provider configuration/i);
  await expect(page.locator("#file-list")).toContainText("Workspace plugin not loaded");
  await expect(page.locator("#file-list")).toContainText("Enable workspace");
  await page.locator("#workspace-config-btn").click();
  await expect(page.locator("#workspace-rag-status")).toContainText("workspace_rag plugin unavailable");
  await expect(page.locator("body")).not.toContainText("down -v");
  await expect(page.locator("body")).not.toContainText("delete Docker");
});
