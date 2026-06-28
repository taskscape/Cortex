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

test("loads the shell, providers, conversations, files, plugins, and skills", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop sidebar coverage");
  await page.goto("/");

  await expect(page).toHaveTitle(/Cortex/);
  await expect(page.locator("h1")).toContainText("Cortex");
  await expect(page.locator("#provider-select")).toContainText("openai");
  await expect(page.locator("#provider-select")).toContainText("Local");
  await expect(page.locator("#provider-select")).toContainText("panel-test");
  await expect(page.locator("#expert-toggle-btn")).toContainText("Experts");
  await expect(page.locator("#session-list")).toContainText(/Conversation/);
  await expect(page.locator("#file-list")).toContainText("brief.md");

  await openPlugins(page);
  await expect(page.locator("#plugin-list")).toContainText("@local-agent/expert-panel");
  await expect(page.locator("#plugin-list")).toContainText("expert_panel");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-workspace-rag");
  await expect(page.locator("#plugin-list")).toContainText("workspace_rag");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-storage-google-drive");
  await expect(page.locator(".plugin-incompatible")).toContainText("google-drive");
  await expect(page.locator("#workspace-toggle-btn")).toBeInViewport();

  await openSkills(page);
  await expect(page.locator("#skill-list")).toContainText("Panel Etiquette");
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

  await page.locator("#workspace-context-name").fill("Discarded Notes");
  await page.locator("#workspace-settings-cancel-btn").click();
  await expect(page.locator("#workspace-settings-screen")).not.toHaveClass(/open/);
  await expect(page.locator("#messages")).toBeVisible();

  await page.locator("#workspace-config-btn").click();
  await expect(page.locator("#workspace-settings-screen")).toHaveClass(/open/);
  await expect(page.locator("#workspace-context-name")).toHaveValue("Default");
  await page.locator("#workspace-context-name").fill("Engineering Notes");
  await page.locator("#workspace-rag-paths").fill("C:\\Projects\\Cortex\\docs\nD:\\Knowledge");
  await page.locator("#workspace-rag-save-btn").click();
  await expect(page.locator("#workspace-settings-screen")).not.toHaveClass(/open/);
  await expect(page.locator("#input-area")).toBeVisible();

  await page.locator("#workspace-config-btn").click();
  await expect(page.locator("#workspace-rag-status")).toContainText("indexing");
  await expect(page.locator("#workspace-rag-status")).toContainText("67%");
});

test("remembered facts persist across conversations and are used in later answers", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop memory coverage");
  await page.goto("/");
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");

  await page.locator("#input").fill("Memorize my name: Maciej Zagozda");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Harness response");

  const facts = await page.evaluate(async () => window.matbotTransport.callTool("remembered_facts_action", { action: "list" }));
  expect(facts.facts.some(fact => fact.fact.includes("Maciej Zagozda"))).toBeTruthy();

  await page.locator("#new-btn").click();
  await page.locator("#input").fill("What is my name?");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".message.assistant").last()).toContainText("Maciej Zagozda");
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
  await expect(page.locator("#expert-list")).toContainText("Design Expert");
  await expect(page.locator("#expert-list")).toContainText("Finance Expert");
  await expect(page.locator("#expert-list")).toContainText("Engineering Expert");
  await expect(page.locator("#expert-all")).toBeChecked();

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
