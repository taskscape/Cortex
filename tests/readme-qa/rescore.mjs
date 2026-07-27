// Re-applies the current rubric to the answers of the last run, without asking a model again.
//
// Tuning a regular expression is a loop: widen an alternative, see whether the stored answer now
// scores 1, and check nothing else flipped. Re-running the Playwright suite for that costs a full
// set of provider turns; this reads `test-results/readme-qa/answers.jsonl` instead.
//
//   node tests/readme-qa/rescore.mjs            # score table plus what changed since the run
//   node tests/readme-qa/rescore.mjs --verbose  # include the stored answer for every miss
//   node tests/readme-qa/rescore.mjs --write    # also rewrite report.json / report.md
//
// A run whose answers all say "the README does not cover this" is a retrieval failure, not a rubric
// failure — no pattern can fix that, and loosening one to make it pass only hides it.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadQuestionSet, scoreAnswer, summarize, toMarkdownReport } from "./score.mjs";
import { readAnswers, reportDir } from "./report-store.mjs";

const verbose = process.argv.includes("--verbose");
const write = process.argv.includes("--write");

const stored = readAnswers();
if (stored.length === 0) {
  console.error(`No answers in ${resolve(reportDir, "answers.jsonl")}. Run: npm run test:readme-qa`);
  process.exit(2);
}

const questions = new Map(loadQuestionSet().questions.map(question => [question.id, question]));
const results = [];
const flipped = [];

for (const previous of stored) {
  const question = questions.get(previous.id);
  if (question === undefined) {
    console.warn(`skipping ${previous.id}: no longer in the question set`);
    continue;
  }
  const result = scoreAnswer(question, previous.answer);
  results.push(result);
  if (result.score !== previous.score) flipped.push({ id: result.id, from: previous.score, to: result.score });
}

const summary = summarize(results);
for (const result of results) {
  const mark = result.score === 1 ? "1" : "0";
  console.log(`${mark}  ${result.id.padEnd(34)} ${result.score === 1 ? "" : result.rationale}`);
  if (verbose && result.score === 0) console.log(`     answer: ${result.answer}`);
}

console.log(`\n${summary.passed}/${summary.total} correct (${(summary.accuracy * 100).toFixed(1)}%)`);
for (const change of flipped) console.log(`changed since the run: ${change.id} ${change.from} -> ${change.to}`);

if (write) {
  const meta = { source: loadQuestionSet().source, rescoredAt: new Date().toISOString() };
  writeFileSync(resolve(reportDir, "report.json"), `${JSON.stringify({ ...meta, summary, results }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(reportDir, "report.md"), toMarkdownReport(results, meta), "utf8");
  console.log(`wrote ${resolve(reportDir, "report.md")}`);
}
