/**
 * Test audit contract validation ensures that the test scenario tracking documents
 * (`tests-to-implement.md`, `tests-to-implement2.md`, `tests-to-implement3.md`)
 * are properly synchronized with the actual executable tests.
 *
 * This test suite validates:
 * - Each audit document declares exactly the ordered scenario series 001-023
 * - Every declared scenario ID (E2E-XXX) has a corresponding executable test
 * - Every executable test with an E2E-XXX ID in its title is declared in an audit
 * - Scenario IDs follow the format T2-E2E-XXX or T3-E2E-XXX for tracking
 * - No scenario IDs are missing or duplicated in the audit documents
 *
 * Assumptions:
 * - The audit documents are in the project root with specific filenames
 * - Test files are in tests/ and follow the naming pattern *.test.mjs or *.test.ts
 * - Scenario IDs in test titles match the pattern E2E-XXX or T2-E2E-XXX/T3-E2E-XXX
 * - The audit documents use a structured format with #### E2E-XXX: headings
 * - Success is indicated by perfect 1:1 mapping between declared and implemented scenarios
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const audits = [
  { file: "tests-to-implement.md", prefix: "" },
  { file: "tests-to-implement2.md", prefix: "T2-" },
  { file: "tests-to-implement3.md", prefix: "T3-" }
];

async function executableTestFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await executableTestFiles(resolved));
    } else if (/\.(?:test|spec)\.(?:mjs|js|ts)$/.test(entry.name)) {
      files.push(resolved);
    }
  }
  return files;
}

function declaredScenarioIds(markdown) {
  return [...markdown.matchAll(/^#### ((?:T[23]-)?E2E-\d{3}):/gm)].map(match => match[1]);
}

function scenarioIdsInTestTitles(source) {
  const ids = [];
  for (const line of source.split(/\r?\n/)) {
    const title = /\b(?:test|it)(?:\.[a-z]+)?\(\s*( ["'`])([^"'`]+)\1/.exec(line)?.[2];
    if (!title) continue;
    ids.push(...title.matchAll(/\b(?:T[23]-)?E2E-\d{3}\b/g));
  }
  return ids.map(match => match[0]);
}

test("all three user-guide audits have one complete, executable scenario series", async () => {
  for (const audit of audits) {
    const markdown = await readFile(path.join(root, audit.file), "utf8");
    const ids = declaredScenarioIds(markdown);
    const expected = Array.from(
      { length: 23 },
      (_, index) => `${audit.prefix}E2E-${String(index + 1).padStart(3, "0")}`
    );
    assert.deepEqual(ids, expected, `${audit.file} must declare exactly the ordered 001-023 scenario series`);
  }
});

test("every recommended audit scenario ID appears in an executable test title", async () => {
  const declared = new Set();
  for (const audit of audits) {
    const markdown = await readFile(path.join(root, audit.file), "utf8");
    for (const id of declaredScenarioIds(markdown)) declared.add(id);
  }

  const implemented = new Map();
  for (const file of await executableTestFiles(path.join(root, "tests"))) {
    const source = await readFile(file, "utf8");
    for (const id of scenarioIdsInTestTitles(source)) {
      const locations = implemented.get(id) ?? [];
      locations.push(path.relative(root, file));
      implemented.set(id, locations);
    }
  }

  const missing = [...declared].filter(id => !implemented.has(id));
  assert.deepEqual(missing, [], `audit scenarios missing from executable test titles: ${missing.join(", ")}`);

  const undeclared = [...implemented].filter(([id]) => !declared.has(id));
  assert.deepEqual(
    undeclared,
    [],
    `executable scenario IDs missing from the audit documents: ${undeclared.map(([id]) => id).join(", ")}`
  );
});
