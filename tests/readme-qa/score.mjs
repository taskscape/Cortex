// Deterministic 0/1 grading for the static README question set.
//
// The rubric lives entirely in `readme-questions.json`: every question carries
// `expect.required` (groups of alternatives, each group must match once) and an
// optional `expect.forbidden` list. Nothing here calls a model, so the same
// answer always produces the same score and a failure names the exact rule that
// was missed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const questionsPath = fileURLToPath(new URL("./readme-questions.json", import.meta.url));

// Answers arrive as rendered markdown. Backticks and emphasis markers would
// otherwise sit between a pattern and the identifier it looks for, so they are
// dropped before matching; whitespace is collapsed so multi-line answers and
// multi-line README quotes compare the same way.
export function normalizeText(value) {
  return String(value ?? "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function loadQuestionSet(path = questionsPath) {
  const set = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(set.questions) || set.questions.length === 0) {
    throw new Error(`Question set ${path} contains no questions.`);
  }
  return set;
}

export function loadQuestions(path = questionsPath) {
  return loadQuestionSet(path).questions;
}

function matchesAny(patterns, text) {
  return patterns.some(pattern => new RegExp(pattern, "i").test(text));
}

// Returns { id, score: 0 | 1, missing, violated, rationale } for one answer.
export function scoreAnswer(question, answer) {
  const text = normalizeText(answer);
  const required = question.expect?.required ?? [];
  const forbidden = question.expect?.forbidden ?? [];

  const missing = required.filter(group => !matchesAny(group, text));
  const violated = forbidden.filter(pattern => new RegExp(pattern, "i").test(text));
  const empty = text.length === 0;
  const score = !empty && missing.length === 0 && violated.length === 0 ? 1 : 0;

  const reasons = [];
  if (empty) reasons.push("answer was empty");
  if (missing.length > 0) reasons.push(`missing required: ${missing.map(group => group.join(" | ")).join("; ")}`);
  if (violated.length > 0) reasons.push(`contains forbidden: ${violated.join("; ")}`);

  return {
    id: question.id,
    section: question.section,
    question: question.question,
    score,
    missing,
    violated,
    rationale: reasons.length > 0 ? reasons.join(" / ") : "all required patterns matched",
    answer: text
  };
}

export function scoreAll(questions, answers) {
  return questions.map(question => scoreAnswer(question, answers[question.id]));
}

export function summarize(results) {
  const total = results.length;
  const passed = results.filter(result => result.score === 1).length;
  return {
    total,
    passed,
    failed: total - passed,
    accuracy: total === 0 ? 0 : Number((passed / total).toFixed(4))
  };
}

export function toMarkdownReport(results, meta = {}) {
  const summary = summarize(results);
  const lines = [
    "# README question set results",
    "",
    ...Object.entries(meta).map(([key, value]) => `- ${key}: ${value}`),
    `- score: ${summary.passed}/${summary.total} (${(summary.accuracy * 100).toFixed(1)}%)`,
    "",
    "| Score | Id | Question | Rationale |",
    "| --- | --- | --- | --- |",
    ...results.map(result => `| ${result.score} | ${result.id} | ${escapeCell(result.question)} | ${escapeCell(result.rationale)} |`),
    ""
  ];
  return lines.join("\n");
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
