// README question set driven through the Cortex WebUI with Playwright.
//
// Unlike `tests/webui/matbot-webui.spec.mjs`, this suite points at a *running*
// Cortex instance (default `http://127.0.0.1:19778`) so a real provider answers
// the questions. Grading stays static: every answer is scored 0/1 by the
// regular expressions in `readme-questions.json` via `score.mjs`, and the run
// writes `test-results/readme-qa/report.json` plus `report.md`.
//
//   npm run test:readme-qa
//   $env:CORTEX_WEBUI_URL = "http://127.0.0.1:19778"; npm run test:readme-qa
//   npm run test:readme-qa -- --grep "workspace-rag"

import { expect, test } from "@playwright/test";

import { loadQuestionSet, scoreAnswer } from "./score.mjs";
import { recordAnswer } from "./report-store.mjs";

const answerTimeout = Number(process.env.CORTEX_QA_ANSWER_TIMEOUT_MS ?? 180_000);

const set = loadQuestionSet();
// The prompt prefix keeps the grader honest: it tells the assistant which
// document to answer from without leaking the expected wording. Override it to
// probe a different retrieval setup.
const promptPrefix = process.env.CORTEX_QA_PROMPT_PREFIX ?? set.promptPrefix ?? "";

async function startNewConversation(page) {
  await page.goto("/");
  await expect(page.locator("#input"), "Cortex WebUI did not load; start Cortex before running this suite").toBeVisible();
  await page.locator("#new-btn").click();
  await expect(page.locator(".empty-state")).toContainText("Start a conversation");
}

// Sends one prompt and returns the assistant text once the turn is finished.
// Plain Enter submits the composer (Shift+Enter only inserts a newline), and
// the send button switches to `stop-mode` for the duration of a turn, so its
// return to the normal state is the completion signal.
async function ask(page, prompt) {
  const answers = page.locator(".message.assistant:not(.marker-block)");
  const before = await answers.count();

  await page.locator("#input").fill(prompt);
  await page.keyboard.press("Enter");
  await expect(page.locator(".message.user").last(), "composer did not submit the question").toContainText(
    prompt.slice(0, 40),
    { timeout: 15_000 }
  );

  await expect(answers).toHaveCount(before + 1, { timeout: answerTimeout });
  await expect(page.locator("#send-btn")).not.toHaveClass(/stop-mode/, { timeout: answerTimeout });

  // `.msg-text` holds the rendered answer; reading the whole bubble would also
  // pull in the token/elapsed footer that the WebUI appends to a finished turn.
  const bubble = answers.last();
  const textParts = bubble.locator(".msg-text");
  const text = (await textParts.count()) > 0
    ? (await textParts.allInnerTexts()).join("\n\n")
    : await bubble.innerText();
  return text.trim();
}

// Deliberately not `mode: "serial"`: a wrong answer must not skip the remaining
// questions, or the report would stop at the first failure instead of scoring
// the whole set. `workers: 1` in the config still keeps the run sequential.
test.describe("README question set", () => {
  test.slow();

  for (const question of set.questions) {
    test(`[${question.id}] ${question.question}`, async ({ page }) => {
      await startNewConversation(page);
      const answer = await ask(page, `${promptPrefix}${question.question}`);
      const result = scoreAnswer(question, answer);
      recordAnswer(result);

      expect(result.score, `${result.rationale}\n\nanswer: ${result.answer}`).toBe(1);
    });
  }
});
