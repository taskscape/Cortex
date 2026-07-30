import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const documentPath = path.join(process.cwd(), "TEST-GAPS-AND-CRITERIA.md");

function idsIn(value) {
  return [...value.matchAll(/\b[A-Z]+-\d+\b/g)].map(match => match[0]);
}

test("every TEST-GAPS acceptance criterion has one implemented or commented disposition", async () => {
  const document = await readFile(documentPath, "utf8");
  const criteriaStart = document.indexOf("## 1. Architecture Tab Navigation");
  const dispositionStart = document.indexOf("### Criterion-Level Disposition");
  const dispositionEnd = document.indexOf("\n---", dispositionStart);

  assert.ok(criteriaStart > dispositionStart, "acceptance criteria must follow the disposition matrix");
  assert.ok(dispositionStart >= 0 && dispositionEnd > dispositionStart, "criterion disposition matrix must exist");

  const acceptanceRows = [...document.slice(criteriaStart).matchAll(/^\|\s*([A-Z]+-\d+)\s*\|/gm)];
  const acceptanceIds = acceptanceRows.map(match => match[1]);
  assert.ok(acceptanceIds.length > 0, "the document must contain acceptance criteria");
  assert.equal(
    new Set(acceptanceIds).size,
    acceptanceIds.length,
    "acceptance criterion IDs must be unique",
  );

  const implemented = new Set();
  const commented = new Set();
  const matrixRows = document
    .slice(dispositionStart, dispositionEnd)
    .split(/\r?\n/)
    .filter(line => /^\|[^-].*\|$/.test(line) && !line.startsWith("| Area |"));

  for (const row of matrixRows) {
    const columns = row.slice(1, -1).split("|").map(column => column.trim());
    assert.equal(columns.length, 3, `disposition row must have three columns: ${row}`);
    for (const id of idsIn(columns[1])) {
      assert.equal(implemented.has(id), false, `${id} is listed as implemented more than once`);
      implemented.add(id);
    }
    for (const id of idsIn(columns[2])) {
      assert.equal(commented.has(id), false, `${id} is listed as commented more than once`);
      commented.add(id);
    }
  }

  for (const id of implemented) {
    assert.equal(commented.has(id), false, `${id} cannot be both implemented and commented`);
  }

  const classified = new Set([...implemented, ...commented]);
  assert.deepEqual(
    [...classified].sort(),
    [...acceptanceIds].sort(),
    "every acceptance criterion must be classified exactly once",
  );
});

test("every test file referenced by TEST-GAPS exists", async () => {
  const document = await readFile(documentPath, "utf8");
  const references = [...new Set(
    [...document.matchAll(/`(tests\/[^`]+\.(?:mjs|ts))`/g)].map(match => match[1]),
  )];

  assert.ok(references.length > 0, "the implementation ledger must reference executable tests");
  for (const reference of references) {
    await assert.doesNotReject(
      access(path.resolve(process.cwd(), reference)),
      `referenced test does not exist: ${reference}`,
    );
  }
});
