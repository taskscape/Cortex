import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { evaluateRagV2Results } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/evaluation.ts"
);

function evidence(passageId, overrides = {}) {
  return {
    passageId,
    documentVersionId: "version-1",
    startByte: 10,
    endByte: 20,
    startLine: 2,
    endLine: 3,
    contentSha256: "a".repeat(64),
    ...overrides,
  };
}

test("workspace RAG V2 evaluation calculates graded retrieval, citation, and ACL metrics", () => {
  const metrics = evaluateRagV2Results([
    {
      testCase: {
        id: "exact-1",
        category: "exact",
        query: "exact clause",
        judgments: [
          { passageId: "p1", relevance: 3 },
          { passageId: "p2", relevance: 1 },
        ],
      },
      evidence: [evidence("p1"), evidence("noise"), evidence("p2")],
    },
    {
      testCase: {
        id: "acl-1",
        category: "authorization",
        query: "private clause",
        judgments: [{ passageId: "allowed", relevance: 2 }],
        forbiddenPassageIds: ["forbidden"],
      },
      evidence: [evidence("allowed")],
    },
    {
      testCase: {
        id: "none-1",
        category: "not_present",
        query: "absent",
        judgments: [],
      },
      evidence: [],
    },
  ], 3);

  assert.equal(metrics.cases, 3);
  assert.equal(metrics.authorizationLeakageRate, 0);
  assert.equal(metrics.citationCorrectness, 1);
  assert.ok(metrics.evidenceFaithfulness > 0.8);
  assert.equal(metrics.byCategory.not_present.recallAtK, 1);
  assert.ok(metrics.ndcgAtK > 0.8);
  assert.ok(metrics.meanReciprocalRank > 0.9);
});

test("workspace RAG V2 evaluation detects invalid citations and forbidden evidence", () => {
  const metrics = evaluateRagV2Results([{
    testCase: {
      id: "leak",
      category: "authorization",
      query: "secret",
      judgments: [{ passageId: "allowed", relevance: 2 }],
      forbiddenPassageIds: ["forbidden"],
    },
    evidence: [
      evidence("forbidden", { endByte: 5, contentSha256: "bad" }),
      evidence("allowed"),
    ],
  }], 2);
  assert.equal(metrics.authorizationLeakageRate, 1);
  assert.equal(metrics.citationCorrectness, 0.5);
  assert.equal(metrics.evidenceFaithfulness, 0.5);
});
