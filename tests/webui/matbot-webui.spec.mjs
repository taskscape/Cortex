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
  await page.locator('[data-section="plugins"] .sidebar-heading').click();
}

async function openSkills(page) {
  await page.locator('[data-section="skills"] .sidebar-heading').click();
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
  await page.locator(`#workflow-ops-shadow-list .architecture-item[data-run-id="${seeded.shadowRunId}"]`).click();
  await expect(page.locator("#workflow-ops-shadow-detail")).toContainText("accepted");
  await expect(page.locator("#workflow-ops-shadow-detail")).toContainText("shadow-recommendation-hash");
});

test("workflow compiler publishes a library entry and starts an approval-gated run", async ({ page, isMobile }) => {
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

test("workflow shadow lab records a human outcome and refreshes readiness metrics", async ({ page, isMobile }) => {
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
  await expect(page.locator("#workflow-ops-shadow-detail")).toContainText("accepted");
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

test("evaluation observability and ROI panel traces replay regressions and sponsor evidence", async ({ page, isMobile }) => {
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

test("memory browser command follows Inner voice and opens the in-page browser", async ({ page, isMobile }) => {
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
