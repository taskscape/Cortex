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

  const source = page.locator("#architecture-source-list .architecture-item", { hasText: "architecture.md" });
  await expect(source.locator(".architecture-badge.bad")).toHaveText("unhealthy");
  await source.click();

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
  const seeded = await seedWorkflowRuns(page, "Ledger Acceptance Workflow");
  await openArchitecturePanel(page, "workflows");

  await expect(page.locator("#architecture-panel-workflows .workflow-ops-summary .workflow-ops-metric")).toHaveCount(4);
  await expect(page.locator("#workflow-ops-workflow-count")).toHaveText("1");
  await expect(page.locator("#workflow-ops-run-count")).toHaveText("4");
  await expect(page.locator("#workflow-ops-pending-count")).toHaveText("2");
  await expect(page.locator("#workflow-ops-acceptance-rate")).toHaveText("0%");
  await expect(page.locator(`#workflow-ops-recent-runs .architecture-item[data-run-id="${seeded.approvalRunId}"]`)).toBeVisible();

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

  await page.locator("#workflow-ops-run-search").fill(seeded.approvalRunId);
  await expect(page.locator("#workflow-ops-run-list .architecture-item")).toHaveCount(1);
  await page.locator("#workflow-ops-run-status").selectOption("waiting_for_approval");
  await expect(page.locator("#workflow-ops-run-list .architecture-item")).toHaveCount(1);
  await page.locator("#workflow-ops-run-search").fill("");
  await page.locator("#workflow-ops-run-status").selectOption("succeeded");
  await expect(page.locator("#workflow-ops-run-list .architecture-item")).toHaveCount(3);
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
    await expect(detail).toContainText(outcome);
  }

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
