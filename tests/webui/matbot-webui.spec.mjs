import { expect, test } from "@playwright/test";

async function openPlugins(page) {
  await page.locator('[data-section="plugins"] .sidebar-heading').click();
}

async function openSkills(page) {
  await page.locator('[data-section="skills"] .sidebar-heading').click();
}

test("loads the shell, providers, conversations, files, plugins, and skills", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/matbot/i);
  await expect(page.locator("h1")).toContainText("matbot");
  await expect(page.locator("#provider-select")).toContainText("openai");
  await expect(page.locator("#provider-select")).toContainText("panel-test");
  await expect(page.locator("#session-list")).toContainText(/Conversation/);
  await expect(page.locator("#file-list")).toContainText("brief.md");

  await openPlugins(page);
  await expect(page.locator("#plugin-list")).toContainText("@local-agent/expert-panel");
  await expect(page.locator("#plugin-list")).toContainText("expert_panel");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-storage-google-drive");
  await expect(page.locator(".plugin-incompatible")).toContainText("google-drive");

  await openSkills(page);
  await expect(page.locator("#skill-list")).toContainText("Panel Etiquette");
});

test("creates a conversation, sends a message, renders streaming output, tools, and usage", async ({ page }) => {
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
});

test("handles interactive prompt controls over the session event stream", async ({ page }) => {
  await page.goto("/");
  await page.locator("#new-btn").click();
  await page.locator("#input").fill("prompt me");
  await page.keyboard.press("Shift+Enter");

  await expect(page.locator(".prompt-block")).toContainText("Choose a test answer");
  await page.getByRole("button", { name: "Beta" }).click();
  await expect(page.locator(".message.assistant")).toContainText("Prompt answer received: Beta");
});

test("uploads and deletes workspace files through the files panel", async ({ page }) => {
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

test("opens skill editor, shows metadata and trigger controls, and saves", async ({ page }) => {
  await page.goto("/");
  await openSkills(page);
  await page.locator(".skill-entry", { hasText: "Panel Etiquette" }).click();

  await expect(page.locator("#skill-editor-overlay")).toHaveClass(/open/);
  await expect(page.locator("#skill-editor-title")).toHaveText("Panel Etiquette");

  await page.getByRole("button", { name: "Metadata" }).click();
  await expect(page.locator("#skill-metadata")).toContainText("How to run expert-panel conversations");
  await expect(page.locator("#skill-metadata")).toContainText("expert_panel");

  await page.getByRole("button", { name: "Triggers" }).click();
  await expect(page.locator("#skill-trigger-list")).toContainText("MATCH when the user asks");
  await page.locator("#skill-trigger-add").click();
  await page.locator(".trigger-row").last().locator(".trigger-text").fill("MATCH when this Playwright trigger is saved.");

  await page.locator("#skill-editor-save").click();
  await expect(page.locator("#skill-editor-overlay")).not.toHaveClass(/open/);
});

test("renames, hides, and marks sessions via sidebar controls", async ({ page }) => {
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

test("shows stop control while a turn is busy and aborts the running turn", async ({ page }) => {
  await page.goto("/");
  await page.locator("#new-btn").click();
  await page.locator("#input").fill("slow response please");
  await page.keyboard.press("Shift+Enter");

  await expect(page.locator("#stop-btn")).toHaveCSS("visibility", "visible");
  await page.locator("#stop-btn").click();
  await expect(page.locator("#stop-btn")).toHaveCSS("visibility", "hidden");
});

test("mobile layout exposes the sidebar through the burger button", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile-only behavior");

  await page.goto("/");
  await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
  await page.locator("#burger").click();
  await expect(page.locator("#sidebar")).toHaveClass(/open/);
  await expect(page.locator("#session-list")).toContainText(/Conversation/);
});
