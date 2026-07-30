/**
 * Static validation of the README question set for the Playwright README QA test.
 *
 * This suite validates the question set in `tests/readme-qa/readme-questions.json`
 * that is used by the Playwright test `tests/readme-qa/readme-qa.spec.mjs` to ask
 * questions about the README and score answers against rubrics.
 *
 * This suite never talks to a model. It proves:
 * - Question IDs are unique, follow a valid format, and end with '?'
 * - Every question has a section field
 * - Expectations are well-formed: required patterns are grouped arrays of valid regexes
 * - Forbidden patterns are valid regexes
 * - Each question's sourceQuote (a passage from README.md) is still present
 * - Each sourceQuote scores 1 against its own question (answers match all required patterns)
 * - Non-answers (empty, vague, or non-answers) score 0 against all questions
 * - The summary function produces correct binary arithmetic
 *
 * Assumptions:
 * - The question set is in `tests/readme-qa/readme-questions.json`
 * - The scoreAnswer() function implements the 0/1 scoring logic based on required
 *   and forbidden patterns
 * - The normalizeText() function normalizes whitespace and backticks for comparison
 * - A README edit that invalidates a question will fail here first (fail-fast)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadQuestionSet, normalizeText, scoreAnswer, summarize } from "./readme-qa/score.mjs";

const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
const readme = normalizeText(readFileSync(readmePath, "utf8"));
const set = loadQuestionSet();

/**
 * Validates that all question IDs in the README QA question set are unique,
 * non-empty, follow a valid format (lowercase alphanumeric with hyphens),
 * and end with a question mark.
 *
 * This test ensures:
 * - Question IDs are unique (no duplicates)
 * - Question IDs are non-empty and follow the format [a-z0-9-]+
 * - Each question has a section field
 * - Each question ends with a question mark
 *
 * Assumptions:
 * - The question set is loaded from tests/readme-qa/readme-questions.json
 * - Success is indicated by all questions meeting the criteria
 */
test("question ids are unique and non-empty", () => {
  const ids = set.questions.map(question => question.id);
  assert.equal(ids.length, new Set(ids).size, "duplicate question ids");
  for (const question of set.questions) {
    assert.match(question.id, /^[a-z0-9-]+$/, `bad id: ${question.id}`);
    assert.ok(question.question.trim().endsWith("?"), `${question.id}: question must end with '?'`);
    assert.ok(question.section?.trim(), `${question.id}: missing section`);
  }
});

/**
 * Validates that every question's expectations are well-formed: required patterns
 * are grouped arrays of valid regexes, and forbidden patterns are valid regexes.
 *
 * This test ensures:
 * - Every question has at least one required pattern
 * - Required patterns are grouped as non-empty arrays of valid regexes
 * - Forbidden patterns are valid regexes
 *
 * Assumptions:
 * - The question set is loaded from tests/readme-qa/readme-questions.json
 * - Success is indicated by all expectations being well-formed
 */
test("every expectation is a group of alternatives with valid regular expressions", () => {
  for (const question of set.questions) {
    const required = question.expect?.required ?? [];
    assert.ok(required.length > 0, `${question.id}: no required patterns`);
    for (const group of required) {
      assert.ok(Array.isArray(group) && group.length > 0, `${question.id}: required entries must be non-empty arrays`);
      for (const pattern of group) assert.doesNotThrow(() => new RegExp(pattern, "i"), `${question.id}: bad pattern ${pattern}`);
    }
    for (const pattern of question.expect?.forbidden ?? []) {
      assert.doesNotThrow(() => new RegExp(pattern, "i"), `${question.id}: bad forbidden pattern ${pattern}`);
    }
  }
});

/**
 * Validates that each question's sourceQuote (a passage from README.md) is still
 * present in the README.md file, ensuring that questions remain valid even after
 * README edits.
 *
 * This test ensures:
 * - Each question's sourceQuote is still present in README.md
 * - README edits that invalidate a question will fail here first (fail-fast)
 *
 * Assumptions:
 * - The question set is loaded from tests/readme-qa/readme-questions.json
 * - README.md is loaded and normalized for comparison
 * - Success is indicated by all sourceQuotes being present
 */
test("each supporting quote is still present in README.md", () => {
  for (const question of set.questions) {
    assert.ok(
      readme.includes(normalizeText(question.sourceQuote)),
      `${question.id}: sourceQuote no longer appears in README.md: ${question.sourceQuote}`
    );
  }
});

/**
 * Validates that each question's sourceQuote (a passage from README.md) scores
 * 1 (perfect match) against its own question, ensuring that the question and
 * expected answer are correctly aligned.
 *
 * This test ensures:
 * - Each sourceQuote scores 1 (perfect match) against its own question
 * - The scoring logic correctly identifies matches
 *
 * Assumptions:
 * - The scoreAnswer() function implements the 0/1 scoring logic based on required
 *   and forbidden patterns
 * - Success is indicated by all sourceQuotes scoring 1
 */
test("each supporting quote scores 1 against its own question", () => {
  for (const question of set.questions) {
    const result = scoreAnswer(question, question.sourceQuote);
    assert.equal(result.score, 1, `${question.id}: quote scored 0 (${result.rationale})`);
  }
});

/**
 * Validates that non-answers (empty, vague, or non-answers) score 0 against all
 * questions, ensuring that the scoring logic correctly identifies inadequate answers.
 *
 * This test ensures:
 * - Empty answers score 0
 * - Vague answers score 0
 * - Non-answers score 0
 *
 * Assumptions:
 * - The scoreAnswer() function implements the 0/1 scoring logic based on required
 *   and forbidden patterns
 * - Success is indicated by all non-answers scoring 0
 */
test("non-answers score 0", () => {
  const nonAnswers = ["", "   ", "I do not know.", "The README does not say."];
  for (const question of set.questions) {
    for (const answer of nonAnswers) {
      const result = scoreAnswer(question, answer);
      assert.equal(result.score, 0, `${question.id}: scored 1 for non-answer ${JSON.stringify(answer)}`);
    }
  }
});

/**
 * Validates that the summary function produces correct binary arithmetic for
 * calculating accuracy from a list of scored items.
 *
 * This test ensures:
 * - The summary function correctly counts total, passed, and failed items
 * - The accuracy is calculated correctly (passed / total)
 *
 * Assumptions:
 * - The summarize() function takes an array of scored items and returns a summary
 * - Success is indicated by the summary matching the expected values
 */
test("summary arithmetic is binary and exact", () => {
  const summary = summarize([{ score: 1 }, { score: 0 }, { score: 1 }, { score: 0 }]);
  assert.deepEqual(summary, { total: 4, passed: 2, failed: 2, accuracy: 0.5 });
});
