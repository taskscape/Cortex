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
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-workspace-rag");
  await expect(page.locator("#plugin-list")).toContainText("workspace_rag");
  await expect(page.locator("#plugin-list")).toContainText("@matatbread/matbot-storage-google-drive");
  await expect(page.locator(".plugin-incompatible")).toContainText("google-drive");
  await expect(page.locator("#workspace-toggle-btn")).toBeInViewport();

  await openSkills(page);
  await expect(page.locator("#skill-list")).toContainText("Panel Etiquette");
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
  await expect(page.locator("#workspace-rag-save-btn")).toHaveCSS("background-color", "rgb(37, 99, 235)");
  await expect(page.locator("#workspace-rag-save-btn")).toHaveCSS("color", "rgb(255, 255, 255)");

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
  await expect(page.locator("#workspace-rag-current-file")).toContainText("retrieval-probe.md");
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

  const facts = await page.evaluate(async () => window.matbotTransport.callTool("remembered_facts_action", { action: "list" }));
  expect(facts.facts.some(fact => fact.fact.includes("Helix"))).toBeTruthy();

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
