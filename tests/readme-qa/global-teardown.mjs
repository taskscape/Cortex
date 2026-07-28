import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadQuestionSet, summarize, toMarkdownReport } from "./score.mjs";
import { readAnswers, reportDir } from "./report-store.mjs";

// Assembles report.json and report.md from the answer log written during the
// run, in question order, and prints the 0/1 total.
export default function globalTeardown(config) {
  const results = readAnswers();
  if (results.length === 0) return;

  const order = new Map(loadQuestionSet().questions.map((question, index) => [question.id, index]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const summary = summarize(results);
  const meta = {
    source: loadQuestionSet().source,
    target: config.projects[0]?.use?.baseURL ?? "unknown",
    finishedAt: new Date().toISOString()
  };

  writeFileSync(resolve(reportDir, "report.json"), `${JSON.stringify({ ...meta, summary, results }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(reportDir, "report.md"), toMarkdownReport(results, meta), "utf8");
  console.log(`\nREADME Q&A: ${summary.passed}/${summary.total} correct (${(summary.accuracy * 100).toFixed(1)}%) — ${resolve(reportDir, "report.md")}`);
}
