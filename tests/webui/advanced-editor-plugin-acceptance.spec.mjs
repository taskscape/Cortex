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

async function openSkills(page) {
  await ensureSidebarOpen(page);
  await page.locator('[data-section="skills"] .sidebar-heading').click();
}

async function openPlugins(page) {
  await ensureSidebarOpen(page);
  const section = page.locator('[data-section="plugins"]');
  if ((await section.getAttribute("class"))?.includes("collapsed")) {
    await section.locator(".sidebar-heading").click();
  }
}

async function ensureSidebarOpen(page) {
  const sidebarIsOpen = await page.locator("body").evaluate(body => body.classList.contains("sidebar-open"));
  if (!sidebarIsOpen && await page.locator("#burger").isVisible()) await page.locator("#burger").click();
}

function installTinyMdeStub(page) {
  return page.addInitScript(() => {
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
}

test("STE-1 through STE-8 skill trigger modal configures the shipped classifier behaviors and persists them", async ({ page }) => {
  await installTinyMdeStub(page);
  await page.goto("/");
  await openSkills(page);

  const skill = page.locator(".skill-entry", { hasText: "Panel Etiquette" });
  await skill.click();
  await expect(page.locator("#skill-editor-overlay")).toHaveClass(/open/);
  await page.getByRole("button", { name: "Triggers" }).click();

  const triggerRows = page.locator("#skill-trigger-list .trigger-row");
  await expect(triggerRows).toHaveCount(1);
  await expect(triggerRows.first().locator(".trigger-text")).toHaveValue(/expert panel etiquette/);
  await expect(triggerRows.first().locator(".trigger-action")).toHaveText("Action: skill_action use Panel Etiquette");

  await page.locator("#skill-trigger-add").click();
  const triggerDialog = page.getByRole("dialog", { name: "Add trigger" });
  await expect(triggerDialog).toBeVisible();
  const behavior = page.locator("#skill-trigger-dialog-kind");
  await expect(behavior.locator("option")).toHaveCount(4);
  await expect(page.locator("#skill-trigger-dialog-action")).toHaveValue("skill_action use Panel Etiquette");
  await page.locator("#skill-trigger-dialog-save").click();
  await expect(page.locator("#skill-trigger-dialog-error")).toContainText("Enter a classifier condition");
  await behavior.selectOption("contextual");
  await page.locator("#skill-trigger-dialog-rule").fill("MATCH when the acceptance canary asks for an editor trigger.");
  await page.locator("#skill-trigger-dialog-save").click();
  await expect(triggerDialog).not.toBeVisible();
  await expect(triggerRows).toHaveCount(2);
  const addedTrigger = triggerRows.last();
  await expect(addedTrigger.locator(".trigger-kind")).toHaveValue("contextual");
  await expect(addedTrigger.locator(".trigger-text")).toHaveValue("MATCH when the acceptance canary asks for an editor trigger.");
  await expect(addedTrigger.locator(".trigger-action")).toHaveText("Action: skill_action use Panel Etiquette");
  await page.locator("#skill-editor-save").click();
  await expect(page.locator("#skill-editor-overlay")).not.toHaveClass(/open/);

  await skill.click();
  await page.getByRole("button", { name: "Triggers" }).click();
  await expect(triggerRows).toHaveCount(2);
  await expect(addedTrigger.locator(".trigger-kind")).toHaveValue("contextual");
  await expect(addedTrigger.locator(".trigger-text")).toHaveValue("MATCH when the acceptance canary asks for an editor trigger.");

  await addedTrigger.locator(".trigger-edit").click();
  await addedTrigger.locator(".trigger-kind").selectOption("followup");
  await addedTrigger.locator(".trigger-text").fill("MATCH when the acceptance canary asks for an edited trigger.");
  await page.locator("#skill-editor-save").click();
  await expect(page.locator("#skill-editor-overlay")).not.toHaveClass(/open/);

  await skill.click();
  await page.getByRole("button", { name: "Triggers" }).click();
  await expect(triggerRows).toHaveCount(2);
  await expect(addedTrigger.locator(".trigger-kind")).toHaveValue("followup");
  await expect(addedTrigger.locator(".trigger-text")).toHaveValue("MATCH when the acceptance canary asks for an edited trigger.");

  await addedTrigger.locator(".trigger-del").click();
  await expect(triggerRows).toHaveCount(1);
  await page.locator("#skill-editor-save").click();
  await expect(page.locator("#skill-editor-overlay")).not.toHaveClass(/open/);

  await skill.click();
  await page.getByRole("button", { name: "Triggers" }).click();
  await expect(triggerRows).toHaveCount(1);
  await expect(triggerRows.first().locator(".trigger-text")).toHaveValue(/expert panel etiquette/);
});

test("plugin details show description, runtime types, tools, and incompatible runtime requirements", async ({ page }) => {
  await page.goto("/");
  await openPlugins(page);

  const sourceRegistry = page.locator("details.plugin-entry", {
    has: page.locator(".plugin-name-label", { hasText: "@matatbread/matbot-source-registry" })
  });
  const summary = sourceRegistry.locator("summary");
  await expect(summary).toHaveAttribute("title", "Source identity, freshness, health, citations, and provenance.");
  await expect(sourceRegistry.locator('.plugin-badge[data-type="tools"]')).toHaveText("tools");
  const sourceRegistryService = sourceRegistry.locator('.plugin-badge[data-type="service"]');
  await expect(sourceRegistryService).toHaveText("SourceRegistry");
  await expect(sourceRegistryService).toHaveAttribute("title", "service:SourceRegistry");

  await summary.click();
  await expect(sourceRegistry).toHaveAttribute("open", "");
  const sourceAction = sourceRegistry.locator(".plugin-tool-row", { hasText: "source_action" });
  await expect(sourceAction).toHaveText("source_action");
  await expect(sourceAction).toHaveAttribute("title", "Inspect source records, citations, and source events.");
  await expect(sourceRegistry.locator(".plugin-tool-row", { hasText: "source_health_action" })).toHaveText("source_health_action");

  const incompatible = page.locator(".plugin-entry-inactive.plugin-incompatible", {
    hasText: "@matatbread/matbot-storage-google-drive"
  });
  await expect(incompatible).toBeVisible();
  await expect(incompatible).toHaveAttribute("title", /Google Drive storage backend\. .*requires runtime: browser.*cannot run on this host/);
  await expect(incompatible.getByTitle("Add plugin")).toHaveCount(0);
});
