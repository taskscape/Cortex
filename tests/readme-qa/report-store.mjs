// Where the README Q&A run collects its scored answers.
//
// Playwright restarts the worker process after a failed test, so an in-memory
// array would lose every result recorded before the first wrong answer. Each
// scored answer is therefore appended to a JSONL file as soon as it is known,
// and the report is assembled from that file in global teardown.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const reportDir = resolve(repoRoot, "test-results/readme-qa");
export const answersPath = resolve(reportDir, "answers.jsonl");

export function resetAnswers() {
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(answersPath, "", "utf8");
}

export function recordAnswer(result) {
  mkdirSync(reportDir, { recursive: true });
  appendFileSync(answersPath, `${JSON.stringify(result)}\n`, "utf8");
}

// Later lines win, so a rerun of the same question (`--repeat-each`, a manual
// retry) reports its final outcome rather than the first one.
export function readAnswers() {
  let raw;
  try {
    raw = readFileSync(answersPath, "utf8");
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const result = JSON.parse(line);
    byId.set(result.id, result);
  }
  return [...byId.values()];
}
