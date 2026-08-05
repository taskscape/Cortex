import { expect, test } from "@playwright/test";

const uncaughtPageErrors = new WeakMap();

test.beforeEach(async ({ page, request }) => {
  const reset = await request.post("/__test/reset-memory");
  expect(reset.ok(), "test harness reset").toBeTruthy();
  const errors = [];
  uncaughtPageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(uncaughtPageErrors.get(page) ?? [], "uncaught browser errors").toEqual([]);
});

async function openArchitecturePanel(page, view) {
  const sidebarIsOpen = await page.locator("body").evaluate(body => body.classList.contains("sidebar-open"));
  if (!sidebarIsOpen && await page.locator("#burger").isVisible()) await page.locator("#burger").click();
  const section = page.locator('[data-section="architecture"]');
  if ((await section.getAttribute("class"))?.includes("collapsed")) {
    await section.locator(".sidebar-heading").click();
  }
  await page.locator(`.architecture-nav-btn[data-architecture-view="${view}"]`).click();
}

async function seedWorkflowRuns(page, name) {
  return page.evaluate(async workflowName => {
    const compiled = await window.matbotTransport.callTool("workflow_action", {
      action: "compile",
      workspaceId: "default",
      name: workflowName,
      purpose: "Exercise the governed operations acceptance controls.",
      sourceIds: ["source:playwright-architecture-brief"],
      toolCalls: [{
        toolName: "file_broker_action",
        capability: "write",
        sourceIds: ["source:playwright-architecture-brief"],
        reason: "Fixture action requires an approval gate."
      }],
      riskLevel: "high",
      publish: true,
      dryRun: false
    });
    const workflowId = compiled.published.definition.id;
    const approvalRun = await window.matbotTransport.callTool("workflow_action", {
      action: "start",
      workspaceId: "default",
      workflowId,
      mode: "approval_gated",
      inputs: { invoiceId: "INV-42", amount: 1250 },
      evidenceSourceIds: ["source:playwright-architecture-brief"]
    });
    const shadowRuns = [];
    for (const invoiceId of ["INV-43", "INV-44", "INV-45"]) {
      shadowRuns.push(await window.matbotTransport.callTool("workflow_action", {
        action: "start",
        workspaceId: "default",
        workflowId,
        mode: "shadow",
        inputs: { invoiceId },
        evidenceSourceIds: ["source:playwright-architecture-brief"]
      }));
    }
    return { workflowId, approvalRunId: approvalRun.id, shadowRunIds: shadowRuns.map(run => run.id) };
  }, name);
}

test("AT-1/AT-2/AT-3 architecture tabs provide a visible roving keyboard focus and native activation", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop architecture accessibility coverage");
  await page.goto("/");
  await openArchitecturePanel(page, "sources");

  const tabOrder = ["Sources", "SQL Preview", "Workflows", "Evaluation & ROI", "Graph", "Reviews"];
  const sources = page.getByRole("tab", { name: "Sources" });
  await sources.focus();
  await expect(sources).toBeFocused();
  const focusIndicator = await sources.evaluate(element => {
    const style = getComputedStyle(element);
    return style.outlineStyle !== "none" || style.outlineWidth !== "0px" || style.boxShadow !== "none";
  });
  expect(focusIndicator, "browser focus indicator must remain visible on an architecture tab").toBeTruthy();

  for (let index = 0; index < tabOrder.length; index += 1) {
    const current = page.getByRole("tab", { name: tabOrder[index] });
    const nextName = tabOrder[(index + 1) % tabOrder.length];
    await expect(current).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: nextName })).toBeFocused();
    await expect(page.getByRole("tab", { name: nextName })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: nextName })).toBeVisible();
  }

  const graph = page.getByRole("tab", { name: "Graph" });
  await graph.focus();
  await page.keyboard.press("Enter");
  await expect(graph).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Graph" })).toBeVisible();

  const reviews = page.getByRole("tab", { name: "Reviews" });
  await reviews.focus();
  await page.keyboard.press("Space");
  await expect(reviews).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Reviews" })).toBeVisible();
});

test("SHP implemented source-health detail keeps unhealthy findings and events attached to the selected source", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop source-health rendering coverage");
  await page.goto("/");
  await openArchitecturePanel(page, "sources");

  await expect(page.locator('[data-health-count="healthy"] strong')).toHaveText("0");
  await expect(page.locator('[data-health-count="warnings"] strong')).toHaveText("2");
  await expect(page.locator('[data-health-count="critical"] strong')).toHaveText("0");
  const source = page.locator("#architecture-source-list .architecture-item", { hasText: "architecture.md" });
  await expect(source.locator(".architecture-badge.bad")).toHaveText("unhealthy");
  await expect(source).toHaveClass(/health-warning/);
  await expect(source.locator('.source-health-indicator[aria-label="warning source"]')).toBeVisible();
  await source.hover();
  await expect(source.getByRole("tooltip")).toContainText("stale");
  await expect(source.getByRole("tooltip")).toContainText("degraded");
  await source.click();

  const modal = page.locator("#architecture-source-health-modal");
  await expect(modal).toBeVisible();
  for (const value of ["Source ID", "source:playwright-architecture-brief", "Version ID", "source-version:playwright-architecture-brief-v1", "Connector health snapshot", "Warning count", "Critical count"]) {
    await expect(modal).toContainText(value);
  }
  await modal.getByRole("button", { name: "Close" }).click();
  await expect(modal).toBeHidden();

  const detail = page.locator("#architecture-source-detail");
  await expect(detail).toContainText("source:playwright-architecture-brief");
  await expect(detail).toContainText("Health");
  await expect(detail).toContainText("Freshness");
  await expect(detail).toContainText("Health Findings");
  await expect(detail).toContainText("architecture.md is stale.");
  await expect(detail).toContainText("architecture.md is degraded.");
  await expect(detail).toContainText("source-version:playwright-architecture-brief-v1");
  await expect(detail.locator(".architecture-card-grid").first().locator(".architecture-badge.warn")).toHaveCount(2);
  await expect(detail).toContainText("Events");
  await expect(detail).toContainText("retrieve");
  const accessEvent = detail.locator('.architecture-item[data-source-event-id="source-access:playwright"]');
  await accessEvent.click();
  const eventDetail = page.locator("#architecture-source-event-detail");
  await expect(eventDetail).toContainText("Event details");
  await expect(eventDetail).toContainText("access");
  await expect(eventDetail).toContainText("source-version:playwright-architecture-brief-v1");
  await expect(eventDetail).toContainText("principal:playwright");
  await expect(eventDetail).toContainText("tool-call:workspace-rag");
  await expect(detail.locator('.architecture-item[data-source-event-type="version"]')).toHaveCount(1);
});

test("SHP-3 critical source findings use the critical list and count treatment", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop source-health critical-state coverage");
  await page.goto("/");
  await page.route("**/tools/source_health_action", async route => {
    const response = await route.fetch();
    const report = await response.json();
    report.findings[0].severity = "critical";
    report.warningCount = 1;
    report.criticalCount = 1;
    await route.fulfill({ response, json: report });
  });
  await openArchitecturePanel(page, "sources");

  await expect(page.locator('[data-health-count="warnings"] strong')).toHaveText("1");
  await expect(page.locator('[data-health-count="critical"] strong')).toHaveText("1");
  const source = page.locator('#architecture-source-list .architecture-source-item[data-source-id="source:playwright-architecture-brief"]');
  await expect(source).toHaveClass(/health-critical/);
  await expect(source.locator('.source-health-indicator[aria-label="critical source"]')).toBeVisible();
});

test("GSP governed SQL keeps execution disabled until approval and renders the planned query record", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop governed SQL preview coverage");
  await page.goto("/");
  await openArchitecturePanel(page, "sql");

  await expect(page.locator("#architecture-sql-approve-btn")).toBeDisabled();
  await expect(page.locator("#architecture-sql-execute-btn")).toBeDisabled();
  await page.locator("#architecture-sql-plan-btn").click();

  await expect(page.locator("#architecture-sql-preview")).toContainText("SELECT");
  await expect(page.locator("#architecture-sql-preview")).toContainText("orders");
  await expect(page.locator("#architecture-sql-preview")).toHaveCSS("overflow-x", "auto");
  await expect(page.locator("#architecture-sql-preview")).toHaveCSS("white-space", "pre");
  const result = page.locator("#architecture-sql-results");
  await expect(result).toContainText("Query Run");
  await expect(result).toContainText("Metric");
  await expect(result).toContainText("Table");
  await expect(result).toContainText("Row limit");
  await expect(result).toContainText("SQL hash");
  await expect(result).toContainText("Sources");
  await expect(page.locator("#architecture-sql-execute-btn")).toBeDisabled();

  await page.locator("#architecture-sql-approve-btn").click();
  await expect(page.locator("#architecture-sql-status")).toContainText("Query approved");
  await expect(page.locator("#architecture-sql-execute-btn")).toBeEnabled();
  await page.locator("#architecture-sql-execute-btn").click();
  await expect(page.locator("#architecture-sql-status")).toContainText("Executed");
  await expect(result).toContainText("Rows");
  await expect(result).toContainText("Result Citation");
});

test("WOC overview and run ledger expose summary metrics, typed inputs, evidence, events, and filters", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow operations coverage");
  await page.goto("/");
  const workflowName = "Ledger Acceptance Workflow";
  const seeded = await seedWorkflowRuns(page, workflowName);
  await page.route("**/tools/workflow_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action !== "inspect_run" || input.runId !== seeded.shadowRunIds[0]) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    body.run.executedActions = [{
      id: "action:playwright-executed-acceptance",
      toolName: "file_broker_action",
      capability: "write",
      status: "succeeded",
      requiresApproval: false,
      sourceIds: ["source:playwright-architecture-brief"],
      input: { path: "reports/acceptance.md" },
      output: { written: true, bytes: 128 },
      durationMs: 42,
    }];
    await route.fulfill({ response, json: body });
  });
  await openArchitecturePanel(page, "workflows");

  const summary = page.locator("#architecture-panel-workflows .workflow-ops-summary");
  await expect(summary.locator(".workflow-ops-metric")).toHaveCount(4);
  await expect(page.locator("#workflow-ops-workflow-count")).toHaveText("1");
  await expect(page.locator("#workflow-ops-run-count")).toHaveText("4");
  await expect(page.locator("#workflow-ops-pending-count")).toHaveText("2");
  await expect(page.locator("#workflow-ops-acceptance-rate")).toHaveText("0%");
  await expect(page.locator("#workflow-ops-acceptance-trend")).toHaveText("Trend: no labels");
  const recentRun = page.locator(`#workflow-ops-recent-runs .architecture-item[data-run-id="${seeded.approvalRunId}"]`);
  await expect(recentRun).toContainText(workflowName);
  await expect(recentRun).toContainText(seeded.approvalRunId);
  await expect(recentRun).toContainText("waiting_for_approval");
  await expect(recentRun).toContainText(/\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}/);

  for (const [label, panel] of [["Workflows", "library"], ["Runs", "runs"], ["Pending approvals", "approvals"], ["Shadow acceptance", "shadow"]]) {
    await summary.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await expect(page.locator(`[data-workflow-ops-panel="${panel}"]`)).toBeVisible();
  }

  await page.getByRole("tab", { name: "Run Ledger" }).click();
  await page.locator(`#workflow-ops-run-list .architecture-item[data-run-id="${seeded.approvalRunId}"]`).click();
  const detail = page.locator("#workflow-ops-run-detail");
  for (const label of ["Workflow", "Version", "Mode", "Status", "Principal", "Typed inputs", "Evidence", "Source IDs", "Source versions", "Proposed Actions", "Executed Actions", "Run Ledger"]) {
    await expect(detail).toContainText(label);
  }
  await expect(detail).toContainText("INV-42");
  await expect(detail).toContainText("source:playwright-architecture-brief");
  await expect(detail).toContainText("source-version:playwright-architecture-brief-v1");
  await expect(detail).toContainText("approval_requested");
  const typedInputs = detail.locator("details", { hasText: "Typed inputs" });
  await expect(typedInputs).not.toHaveAttribute("open", "");
  await typedInputs.locator("summary").click();
  await expect(typedInputs.locator("pre")).toContainText("INV-42");

  const sourceLink = detail.locator('.architecture-link-button[data-source-id="source:playwright-architecture-brief"]').first();
  await expect(sourceLink).toHaveText("source:playwright-architecture-brief");
  const proposedAction = detail.locator('.workflow-ops-action[data-action-id="action:playwright-write"]');
  await proposedAction.locator("summary").click();
  await expect(proposedAction).toContainText("file_broker_action");
  await expect(proposedAction).toContainText("Approval required");
  await expect(proposedAction).toContainText("Yes");
  await expect(proposedAction).toContainText("Inputs");

  await page.locator(`#workflow-ops-run-list .architecture-item[data-run-id="${seeded.shadowRunIds[0]}"]`).click();
  const executedAction = detail.locator(".workflow-ops-action", { hasText: "succeeded" }).last();
  await executedAction.locator("summary").click();
  await expect(executedAction).toContainText("Output");
  await expect(executedAction).toContainText('"written": true');
  await expect(executedAction).toContainText("42 ms");

  await page.getByRole("tab", { name: "Run Ledger" }).click();
  await page.locator(`#workflow-ops-run-list .architecture-item[data-run-id="${seeded.approvalRunId}"]`).click();
  await detail.locator('.architecture-link-button[data-source-id="source:playwright-architecture-brief"]').first().click();
  await expect(page.getByRole("tabpanel", { name: "Sources" })).toBeVisible();
  await expect(page.locator("#architecture-source-detail")).toContainText("source:playwright-architecture-brief");

  await page.getByRole("tab", { name: "Workflows" }).click();
  await page.getByRole("tab", { name: "Run Ledger" }).click();

  await page.locator("#workflow-ops-run-search").fill(seeded.approvalRunId);
  await expect(page.locator("#workflow-ops-run-list .architecture-item")).toHaveCount(1);
  await page.locator("#workflow-ops-run-status").selectOption("waiting_for_approval");
  await expect(page.locator("#workflow-ops-run-list .architecture-item")).toHaveCount(1);
  await page.locator("#workflow-ops-run-search").fill("");
  await page.locator("#workflow-ops-run-status").selectOption("succeeded");
  await expect(page.locator("#workflow-ops-run-list .architecture-item")).toHaveCount(3);
});

test("WOC-8 workflow overview refreshes automatically every 30 seconds while visible", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow auto-refresh coverage");
  await page.goto("/");
  await seedWorkflowRuns(page, "Auto Refresh Acceptance Workflow");
  await page.clock.install();
  let listRunRequests = 0;
  page.on("request", request => {
    if (!request.url().includes("/tools/workflow_action")) return;
    if (request.postDataJSON()?.action === "list_runs") listRunRequests += 1;
  });

  await openArchitecturePanel(page, "workflows");
  await expect.poll(() => listRunRequests).toBe(1);
  await page.clock.runFor(30_000);
  await expect.poll(() => listRunRequests).toBeGreaterThanOrEqual(2);
});

test("WOC-5 failed recent runs use the critical visual treatment", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow failure-state coverage");
  await page.goto("/");
  const seeded = await seedWorkflowRuns(page, "Failed Run Visual Acceptance Workflow");
  await page.route("**/tools/workflow_action", async route => {
    const input = route.request().postDataJSON();
    if (input.action !== "list_runs") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    const run = body.runs.find(item => item.id === seeded.approvalRunId);
    run.status = "failed";
    run.updatedAt = "2026-07-30T09:15:00.000Z";
    await route.fulfill({ response, json: body });
  });

  await openArchitecturePanel(page, "workflows");

  const recent = page.locator(
    `#workflow-ops-recent-runs .architecture-item[data-run-id="${seeded.approvalRunId}"]`,
  );
  await expect(recent).toContainText(seeded.approvalRunId);
  const failedBadge = recent.locator(".architecture-badge.bad");
  await expect(failedBadge).toHaveText("failed");
  await expect(failedBadge).toHaveCSS("color", "rgb(153, 27, 27)");
  await expect(page.locator("#workflow-ops-attention")).toContainText("Failed runs");
  await expect(page.locator("#workflow-ops-attention")).toContainText("1");
});

test("WCD-4 draft library displays compiler validation errors and warnings", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow draft validation coverage");
  await page.goto("/");
  const seeded = await page.evaluate(() => window.matbotTransport.callTool("workflow_action", {
    action: "compile",
    workspaceId: "default",
    name: "Draft Validation Acceptance",
    sourceIds: [],
    toolCalls: [],
    approvalGates: [{ id: "invalid-gate", type: "unsupported-gate" }],
    publish: false,
    dryRun: true,
  }));
  expect(seeded.compilation.validation.length).toBeGreaterThan(0);
  expect(seeded.compilation.warnings.length).toBeGreaterThan(0);

  await openArchitecturePanel(page, "workflows");
  await page.getByRole("tab", { name: "Library" }).click();
  await page.locator(`#workflow-ops-library-list .architecture-item[data-compilation-id="${seeded.compilation.id}"]`).click();
  const detail = page.locator("#workflow-ops-library-detail");
  await expect(detail).toContainText("Release checks");
  await expect(detail).toContainText("1 validation error(s)");
  await expect(detail).toContainText("$.approvalGates[0].type");
  await expect(detail).toContainText("Unsupported approval gate type");
  await expect(detail).toContainText("No tool calls were supplied");
  await expect(detail).toContainText("dryRun was requested without publish=true");
});

test("WSL shadow outcome controls record accept, reject, and mixed labels and recalculate readiness", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop workflow shadow coverage");
  await page.goto("/");
  const seeded = await seedWorkflowRuns(page, "Shadow Label Acceptance Workflow");
  await openArchitecturePanel(page, "workflows");
  await page.getByRole("tab", { name: "Shadow Lab" }).click();

  const labels = [
    [seeded.shadowRunIds[0], "Accept", "accepted"],
    [seeded.shadowRunIds[1], "Reject", "rejected"],
    [seeded.shadowRunIds[2], "Mark mixed", "mixed"]
  ];
  for (const [runId, buttonName, outcome] of labels) {
    await page.locator(`#workflow-ops-shadow-list .architecture-item[data-run-id="${runId}"]`).click();
    const detail = page.locator("#workflow-ops-shadow-detail");
    await expect(detail).toContainText("unlabeled");
    await expect(detail).toContainText(runId);
    await expect(detail).toContainText("Evidence");
    await expect(detail).toContainText("Proposed recommendation");
    await detail.getByRole("button", { name: buttonName }).click();
    await expect(page.locator(`#workflow-ops-shadow-list .architecture-item[data-run-id="${runId}"]`)).toHaveCount(0);
    await expect(page.locator("#architecture-workflow-status")).toContainText(`recorded as ${outcome}`);
  }

  await expect(page.locator("#workflow-ops-shadow-list .architecture-item")).toHaveCount(0);
  await expect(page.locator("#workflow-ops-shadow-list")).toContainText("No unlabeled shadow runs");
  await expect(page.locator("#workflow-ops-shadow-detail")).toContainText("Select a shadow run");

  const report = await page.evaluate(() => window.matbotTransport.callTool("workflow_action", { action: "shadow_report" }));
  expect(report.summary).toEqual(expect.objectContaining({ total: 3, accepted: 1, rejected: 1, mixed: 1 }));
  expect(report.comparisons.every(item => item.recommendationHash && item.sourceIds.includes("source:playwright-architecture-brief") && item.comparedAt)).toBe(true);

  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.locator("#workflow-ops-acceptance-rate")).toHaveText("33%");
  await expect(page.locator("#workflow-ops-shadow-readiness")).toContainText("Accepted");
  await expect(page.locator("#workflow-ops-shadow-readiness")).toContainText("Rejected");
  await expect(page.locator("#workflow-ops-shadow-readiness")).toContainText("Mixed");
});

test("ERO evaluation panel renders the waterfall contract and sponsor evidence aggregates", async ({ page }) => {
  await page.goto("/");
  await openArchitecturePanel(page, "evaluation");

  const traceDetail = page.locator("#evaluation-trace-detail");
  await expect(traceDetail).toContainText("Span waterfall");
  for (const kind of ["agent", "llm", "retriever", "guardrail", "tool"]) {
    await expect(traceDetail).toContainText(kind);
  }
  for (const column of ["Kind", "Operation", "Status", "Duration"]) {
    await expect(traceDetail).toContainText(column);
  }

  const sponsorEvidence = page.locator("#evaluation-roi-detail");
  for (const label of [
    "Verified outcomes", "Time saved", "Total benefit", "Operating cost", "Net benefit", "ROI",
    "Approval rate", "Escalation rate", "Action success", "Citation coverage", "Benefit by workflow"
  ]) {
    await expect(sponsorEvidence).toContainText(label);
  }
  await expect(sponsorEvidence).toContainText("workflow:invoice-review");
  await expect(sponsorEvidence).toContainText("666%");
});
