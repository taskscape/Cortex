import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

await import("../../local-agent/matbot/apps/cli/register.js");

const { WorkspaceRagV2Manager } = await import(
  "../../local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts"
);
const { MemoryRagV2Repository } = await import(
  "../../local-agent/matbot/packages/plugins/workspace-rag/src/v2/memory-repository.ts"
);

const RETRIEVAL_VARIANTS = [
  "flat_dense_baseline",
  "lexical_only",
  "dense_only",
  "hybrid_rrf",
  "hybrid_translated",
  "hybrid_reranked",
  "hierarchical",
  "hierarchical_lazy",
];

const TEST_ENV = {
  CORTEX_RAG_V2_EAGER_MAX_BYTES: "1500",
  CORTEX_RAG_V2_ASYNC_MAX_BYTES: "9000",
  CORTEX_RAG_V2_EAGER_PASSAGE_VECTOR_CAP: "3",
  CORTEX_RAG_V2_PARSER_MEMORY_BYTES: "512",
  CORTEX_RAG_V2_TARGET_PASSAGE_TOKENS: "48",
  CORTEX_RAG_V2_HARD_MAX_PASSAGE_TOKENS: "72",
  CORTEX_RAG_V2_LINE_INDEX_STRIDE: "4",
};

function vector(text, dimensions = 64) {
  const result = new Array(dimensions).fill(0);
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const digest = createHash("sha256").update(token).digest();
    result[digest.readUInt16BE(0) % dimensions] += 1;
  }
  const norm = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0)) || 1;
  return result.map(value => value / norm);
}

function testEmbedder({ signature = "playwright-e5-v1", delayMs = 0 } = {}) {
  return {
    info: {
      backend: "playwright-deterministic",
      model: "playwright-multilingual-e5",
      dimensions: 64,
      signature,
      maxTokens: 512,
    },
    async embed(texts, _purpose, signal) {
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
      }
      return texts.map(value => vector(value));
    },
  };
}

function generatedSections(prefix, count, wordsPerSection, markerAt = -1) {
  return Array.from({ length: count }, (_, index) => {
    const marker = index === markerAt
      ? ` The immutable retrieval marker is ${prefix}-91745.`
      : "";
    const body = Array.from(
      { length: wordsPerSection },
      (__, word) => `${prefix.toLocaleLowerCase()}-${index}-${word}`,
    ).join(" ");
    return `## ${prefix} section ${index}\n\n${body}.${marker}`;
  }).join("\n\n");
}

async function createGeneratedCorpus(root) {
  const docs = path.join(root, "generated-documents");
  await mkdir(path.join(docs, "archive"), { recursive: true });
  await mkdir(path.join(docs, "current"), { recursive: true });
  await mkdir(path.join(docs, "signed"), { recursive: true });

  const files = {
    "signed/contract-pl.md": [
      "---",
      "document_type: contract",
      "jurisdiction: PL",
      "publication_date: 2025-01-01",
      "valid_from: 2025-02-01",
      "valid_to: 2028-12-31",
      "parties: [Alfa Sp. z o.o., Beta S.A.]",
      "---",
      "# Umowa ramowa PL-2025-104",
      "",
      "## Artykuł 12. Wypowiedzenie",
      "",
      "### Clause 12.4",
      "",
      "Wykonawca może wypowiedzieć umowę z zachowaniem trzydziestodniowego okresu wypowiedzenia.",
      "Kod dowodowy: TERM-1204.",
      "",
      "## Artykuł 18. Odpowiedzialność",
      "",
      "Odpowiedzialność dostawcy jest ograniczona do opłat zapłaconych w ostatnich dwunastu miesiącach.",
    ].join("\n"),
    "current/policy-eu.md": [
      "---",
      "document_type: policy",
      "jurisdiction: EU",
      "publication_date: 2026-04-01",
      "valid_from: 2026-04-15",
      "---",
      "# Current delivery policy",
      "",
      "## Delivery window",
      "",
      "Priority shipments must arrive within forty-eight hours. Reference POLICY-4800.",
    ].join("\n"),
    "archive/policy-eu-2023.md": [
      "---",
      "document_type: policy",
      "jurisdiction: EU",
      "publication_date: 2023-01-01",
      "valid_from: 2023-01-01",
      "valid_to: 2024-12-31",
      "---",
      "# Historical delivery policy",
      "",
      "## Delivery window",
      "",
      "Priority shipments were allowed ninety-six hours. Reference POLICY-9600.",
    ].join("\n"),
    "structured-annex.md": [
      "---",
      "document_type: annex",
      "jurisdiction: EU",
      "---",
      "# Annex A — Service levels",
      "",
      "> These thresholds form part of the operative agreement.",
      "",
      "## Regional thresholds",
      "",
      "| Region | Severity | Restoration target |",
      "| --- | --- | --- |",
      "| Warsaw | Critical | 2 hours |",
      "| Berlin | High | 8 hours |",
      "| Paris | Medium | 24 hours |",
      "",
      "## Validation example",
      "",
      "```yaml",
      "service_level:",
      "  reference: ANNEX-7712",
      "  region: Warsaw",
      "  target_hours: 2",
      "```",
      "",
      "- Escalate after the first missed target.",
      "- Preserve the incident identifier in every follow-up.",
    ].join("\n"),
    "books/operations-2023.md": [
      "---",
      "document_type: book_chapter",
      "book_id: operations-handbook",
      "book_title: Operations Handbook",
      "publication_date: 2023-01-01",
      "---",
      "# Operations Handbook — 2023 edition",
      "",
      "## Retry policy",
      "",
      "The older RETRY-441 rule waits sixty seconds before another attempt.",
    ].join("\n"),
    "books/operations-2024.md": [
      "---",
      "document_type: book_chapter",
      "book_id: operations-handbook",
      "book_title: Operations Handbook",
      "publication_date: 2024-01-01",
      "---",
      "# Operations Handbook — 2024 edition",
      "",
      "## Retry policy",
      "",
      "Alice replied that the current RETRY-441 rule waits thirty seconds after renewing the upstream lease.",
    ].join("\n"),
    "duplicate-a.md": [
      "# Operational duplicate",
      "",
      "## Recovery",
      "",
      "The recovery verification phrase is DUPLICATE-CEDAR-55110.",
    ].join("\n"),
    "duplicate-b.md": [
      "# Operational duplicate",
      "",
      "## Recovery",
      "",
      "The recovery verification phrase is DUPLICATE-CEDAR-55110.",
    ].join("\n"),
    "medium-handbook.md": [
      "# Medium generated handbook",
      "",
      generatedSections("MEDIUM", 16, 28, 7),
    ].join("\n"),
    "exceptional-cold.md": [
      "# Exceptional generated source",
      "",
      "This document intentionally crosses the Playwright cold-file threshold.",
      "",
      generatedSections("COLD", 36, 42, 29),
    ].join("\n"),
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(docs, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return { docs, files };
}

async function ingest(manager, workspace, context) {
  await manager.initialize();
  const job = manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);
  return job;
}

async function waitFor(check, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the generated-corpus condition.");
}

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function diagnosticPage() {
  return `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>Hybrid Retrieval Playwright Diagnostics</title>
  <body>
    <h1>Hybrid Retrieval Playwright Diagnostics</h1>
    <p id="state">ready</p>
    <pre id="result" aria-live="polite"></pre>
    <script>
      window.runHybridCheck = async (route, body = {}) => {
        document.querySelector("#state").textContent = "running";
        const response = await fetch(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        const result = { ok: response.ok, status: response.status, data };
        document.querySelector("#result").textContent = JSON.stringify(result);
        document.querySelector("#state").textContent = response.ok ? "complete" : "error";
        return result;
      };
    </script>
  </body>
</html>`;
}

test.describe("Workspace RAG V2 generated-corpus acceptance", () => {
  test.describe.configure({ mode: "serial" });

  let mobileProject = false;
  let root;
  let origin;
  let server;
  let manager;
  let repository;
  let workspace;
  let context;
  let ingestionJob;
  let initialValidation;
  let savedEnvironment;

  test.beforeAll(async ({ isMobile }) => {
    mobileProject = Boolean(isMobile);
    if (mobileProject) return;

    savedEnvironment = Object.fromEntries(
      Object.keys(TEST_ENV).map(name => [name, process.env[name]]),
    );
    Object.assign(process.env, TEST_ENV);

    root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-playwright-"));
    const { docs } = await createGeneratedCorpus(root);
    workspace = { id: "playwright-workspace", name: "Playwright", configDir: root };
    context = { id: "generated-corpus", name: "Generated corpus", paths: [docs] };
    repository = new MemoryRagV2Repository();
    manager = new WorkspaceRagV2Manager(repository, testEmbedder(), undefined, {
      summarizerSignature: "playwright-summary-v1",
      async rewriteQuery({ latestQuestion }) {
        if (/older edition/iu.test(latestQuestion)) {
          return "Compare the RETRY-441 rule in the 2023 and 2024 editions of the Operations Handbook";
        }
        return latestQuestion;
      },
      async summarize(input) {
        return `Semantic ${input.level} routing summary for ${input.title}: ${input.text}`;
      },
    });
    ingestionJob = await ingest(manager, workspace, context);
    await manager.waitForSummaries();
    initialValidation = await repository.validateGeneration(
      workspace.id,
      context.id,
      ingestionJob.generationId,
    );

    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(diagnosticPage());
        return;
      }
      if (request.method !== "POST") {
        json(response, 404, { error: "Not found" });
        return;
      }
      try {
        const body = await readBody(request);
        if (url.pathname === "/api/status") {
          json(response, 200, {
            status: await manager.status("primary", workspace, context),
            validation: await repository.validateGeneration(
              workspace.id,
              context.id,
              ingestionJob.generationId,
            ),
            initialValidation,
          });
          return;
        }
        if (url.pathname === "/api/search") {
          json(response, 200, await manager.search(
            workspace,
            context,
            body.query,
            body.options ?? {},
          ));
          return;
        }
        if (url.pathname === "/api/fetch-range") {
          json(response, 200, await manager.fetchSourceRange(
            workspace,
            context,
            body.documentVersionId,
            body.startByte,
            body.endByte,
          ));
          return;
        }
        if (url.pathname === "/api/fetch-lines") {
          json(response, 200, await manager.fetchLines(
            workspace,
            context,
            body.documentVersionId,
            body.startLine,
            body.endLine,
          ));
          return;
        }
        if (url.pathname === "/api/grep") {
          json(response, 200, await manager.grepDocuments(
            workspace,
            context,
            body.documentVersionIds,
            body.pattern,
            body.limit,
          ));
          return;
        }
        if (url.pathname === "/api/evaluate") {
          json(response, 200, await manager.evaluate(
            workspace,
            context,
            body.cases,
            body.k,
            body.variant,
          ));
          return;
        }
        if (url.pathname === "/api/evict") {
          json(response, 200, await manager.evictColdPassageEmbeddings(
            workspace,
            context,
            body.limit,
          ));
          return;
        }
        if (url.pathname === "/api/census") {
          json(response, 200, await manager.census(context.paths));
          return;
        }
        if (url.pathname === "/api/scenario/cancellation") {
          json(response, 200, await cancellationScenario(root));
          return;
        }
        if (url.pathname === "/api/scenario/signature") {
          json(response, 200, await signatureScenario(root));
          return;
        }
        if (url.pathname === "/api/scenario/degradation") {
          json(response, 200, await degradationScenario(root));
          return;
        }
        if (url.pathname === "/api/scenario/isolation") {
          let error;
          try {
            await manager.search(
              { ...workspace, id: "another-workspace" },
              context,
              "TERM-1204",
            );
          } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
          }
          json(response, 200, { error });
          return;
        }
        json(response, 404, { error: "Unknown diagnostic route" });
      } catch (error) {
        json(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    origin = `http://127.0.0.1:${address.port}`;
  });

  test.afterAll(async () => {
    if (mobileProject) return;
    await manager?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (root) await rm(root, { recursive: true, force: true });
    for (const [name, value] of Object.entries(savedEnvironment ?? {})) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function run(page, route, body = {}) {
    await page.goto(origin);
    const pending = page.evaluate(
      ({ route: target, body: payload }) => window.runHybridCheck(target, payload),
      { route, body },
    );
    await expect(page.locator("#state")).toHaveText(/complete|error/);
    return pending;
  }

  test("publishes complete lexical coverage and a bounded hierarchical index", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const result = await run(page, "/api/status");

    expect(result.ok).toBe(true);
    expect(result.data.status.activeGenerationId).toBe(ingestionJob.generationId);
    expect(["active_hybrid_partial", "active_hybrid_complete"]).toContain(
      result.data.status.activeState,
    );
    expect(result.data.status.embeddingSignature).toBe("playwright-e5-v1");
    expect(result.data.status.job.processedFiles).toBe(10);
    expect(result.data.status.summaries.enabled).toBe(true);
    expect(result.data.status.summaries.completed).toBeGreaterThan(0);
    expect(result.data.initialValidation.documents).toBe(10);
    expect(result.data.initialValidation.sections).toBeGreaterThan(40);
    expect(result.data.initialValidation.passages).toBeGreaterThan(
      result.data.initialValidation.sections,
    );
    expect(result.data.initialValidation.lexicalReady).toBe(
      result.data.initialValidation.passages,
    );
    expect(result.data.initialValidation.passageEmbeddings).toBeGreaterThan(0);
    expect(result.data.initialValidation.passageEmbeddings).toBeLessThan(
      result.data.initialValidation.passages,
    );
  });

  test("streams a varied corpus and reports structures, duplicates, tiers, and forecasts", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const result = await run(page, "/api/census");

    expect(result.ok).toBe(true);
    expect(result.data.complete).toBe(true);
    expect(result.data.files).toBe(10);
    expect(result.data.structures.headings).toBeGreaterThan(40);
    expect(result.data.structures.tables).toBeGreaterThan(0);
    expect(result.data.exactDuplicateRate).toBeGreaterThan(0);
    expect(result.data.percentiles.p50).toBeGreaterThan(0);
    expect(result.data.largest[0].bytes).toBeGreaterThan(9_000);
    expect(result.data.projected.lexicalBytes).toBeGreaterThan(0);
    expect(result.data.projected.vectorBytes).toBeGreaterThan(0);
    expect(result.data.partitionPlan.backend).toBe("postgres-pgvector");
  });

  test("routes document to section to passage and fuses exact, lexical, and dense lanes", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const result = await run(page, "/api/search", {
      query: "What does Clause 12.4 say about TERM-1204?",
      options: { limit: 5 },
    });

    expect(result.ok).toBe(true);
    expect(result.data.plan.intent).toBe("exact_reference");
    expect(result.data.plan.exactReferences).toContain("Clause 12.4");
    expect(result.data.diagnostics.routedDocumentIds.length).toBeGreaterThan(0);
    expect(result.data.diagnostics.routedSectionIds.length).toBeGreaterThan(0);
    expect(result.data.diagnostics.candidateCounts.routedInput).toBeGreaterThan(0);
    expect(result.data.diagnostics.candidateCounts.passageFused).toBeGreaterThan(0);
    expect(result.data.evidence[0].text).toContain("TERM-1204");
    expect(result.data.evidence[0].retrievalReasons.join(" ")).toMatch(
      /RRF contribution|exact_reference/,
    );
  });

  test("rewrites a conversational comparison, expands its book collection, and performs a follow-up pass", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const result = await run(page, "/api/search", {
      query: "Does the older edition say the same thing?",
      options: {
        limit: 5,
        conversation: [
          { role: "user", text: "What does the 2024 Operations Handbook say about RETRY-441?" },
          { role: "assistant", text: "Alice says it waits thirty seconds after renewing the lease." },
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.data.plan.originalQuery).toBe("Does the older edition say the same thing?");
    expect(result.data.plan.rewriteMethod).toBe("model");
    expect(result.data.plan.standaloneQuery).toContain("2023 and 2024 editions");
    expect(result.data.plan.intent).toBe("comparison");
    expect(result.data.plan.iterativeQueries.length).toBeGreaterThan(0);
    expect(result.data.answerability.iterations).toBe(2);
    expect(result.data.answerability.abstained).toBe(false);
    expect(new Set(result.data.evidence.map(item => item.documentId)).size).toBeGreaterThanOrEqual(2);
    expect(result.data.diagnostics.routedCollectionIds).toHaveLength(1);
    expect(result.data.evidence.every(item => !item.retrievalReasons.join(" ").match(/summary/iu))).toBe(true);
  });

  test("returns an explicit insufficient-evidence result instead of unrelated dense evidence", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const result = await run(page, "/api/search", {
      query: "What does ZXQ-NOT-PRESENT-991 require?",
      options: { limit: 5 },
    });

    expect(result.ok).toBe(true);
    expect(result.data.answerability.firstPass.status).toBe("insufficient");
    expect(result.data.answerability.status).toBe("insufficient");
    expect(result.data.answerability.abstained).toBe(true);
    expect(result.data.evidence).toEqual([]);
  });

  test("returns immutable byte and line citations that reproduce the evidence", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const search = await run(page, "/api/search", {
      query: "ANNEX-7712 Warsaw restoration target",
      options: { limit: 4 },
    });
    const evidence = search.data.evidence.find(item => item.text.includes("ANNEX-7712"));
    expect(evidence).toBeTruthy();

    const range = await run(page, "/api/fetch-range", {
      documentVersionId: evidence.documentVersionId,
      startByte: evidence.byteRange.from,
      endByte: evidence.byteRange.to,
    });
    const lines = await run(page, "/api/fetch-lines", {
      documentVersionId: evidence.documentVersionId,
      startLine: evidence.lineRange.from,
      endLine: evidence.lineRange.to,
    });

    expect(range.data.text).toBe(evidence.text);
    expect(range.data.contentSha256).toBe(evidence.contentSha256);
    expect(lines.data.text).toContain("ANNEX-7712");
    expect(lines.data.text).toContain("target_hours: 2");
    expect(evidence.headingPath).toEqual(
      expect.arrayContaining(["Annex A — Service levels", "Validation example"]),
    );
  });

  test("preserves multilingual source evidence while applying controlled translation", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const result = await run(page, "/api/search", {
      query: "termination liability",
      options: {
        jurisdictions: ["PL"],
        documentTypes: ["contract"],
        answerLanguage: "en",
        limit: 5,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.data.plan.lexicalVariants.some(
      value => value.reason.includes("controlled legal terminology expansion"),
    )).toBe(true);
    expect(result.data.evidence.length).toBeGreaterThan(0);
    expect(result.data.evidence.every(item => item.jurisdiction === "PL")).toBe(true);
    expect(result.data.evidence.some(item => /wypowied|odpowiedzialność/iu.test(item.text))).toBe(true);
    expect(result.data.evidence.every(item => !item.text.includes("notice of termination"))).toBe(true);
  });

  test("enforces document, jurisdiction, and effective-date filters", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const historical = await run(page, "/api/search", {
      query: "delivery policy hours",
      options: {
        documentTypes: ["policy"],
        jurisdictions: ["EU"],
        asOfDate: "2024-06-01",
        limit: 5,
      },
    });
    const current = await run(page, "/api/search", {
      query: "delivery policy hours",
      options: {
        documentTypes: ["policy"],
        jurisdictions: ["EU"],
        asOfDate: "2026-06-01",
        limit: 5,
      },
    });

    expect(historical.data.evidence.length).toBeGreaterThan(0);
    expect(historical.data.evidence.every(item => item.sourceUri.includes("policy-eu-2023.md"))).toBe(true);
    expect(historical.data.evidence.some(item => item.text.includes("ninety-six"))).toBe(true);
    expect(current.data.evidence.length).toBeGreaterThan(0);
    expect(current.data.evidence.every(item => item.sourceUri.includes("policy-eu.md"))).toBe(true);
    expect(current.data.evidence.some(item => item.text.includes("forty-eight"))).toBe(true);
  });

  test("keeps cold content lexically searchable and lazily promotes only selected passages", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const before = (await run(page, "/api/status")).data.validation;
    const result = await run(page, "/api/search", {
      query: "What is COLD-91745?",
      options: { limit: 3, variant: "hierarchical_lazy" },
    });
    expect(result.data.evidence.some(item => item.text.includes("COLD-91745"))).toBe(true);

    const after = await waitFor(async () => {
      const value = (await run(page, "/api/status")).data.validation;
      return value.passageEmbeddings > before.passageEmbeddings ? value : undefined;
    });
    expect(after.lexicalReady).toBe(after.passages);
    expect(after.passageEmbeddings).toBeGreaterThan(before.passageEmbeddings);
    expect(after.passageEmbeddings).toBeLessThan(after.passages);
  });

  test("bounds regular-expression search and rejects unsafe expressions", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const search = await run(page, "/api/search", {
      query: "TERM-1204",
      options: { limit: 2 },
    });
    const documentVersionId = search.data.evidence[0].documentVersionId;
    const grep = await run(page, "/api/grep", {
      documentVersionIds: [documentVersionId],
      pattern: "wypowiedzieć.{0,120}trzydziestodniowego",
      limit: 10,
    });
    const unsafe = await run(page, "/api/grep", {
      documentVersionIds: [documentVersionId],
      pattern: "(a+)+",
      limit: 10,
    });

    expect(grep.ok).toBe(true);
    expect(grep.data.matches.length).toBeGreaterThan(0);
    expect(grep.data.matches[0].byteRange.to).toBeGreaterThan(
      grep.data.matches[0].byteRange.from,
    );
    expect(unsafe.ok).toBe(false);
    expect(unsafe.data.error).toMatch(/prohibited/i);
  });

  test("persists comparable metrics for every retrieval ablation", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const known = await run(page, "/api/search", {
      query: "POLICY-4800",
      options: { limit: 3 },
    });
    const passageId = known.data.evidence.find(
      item => item.text.includes("POLICY-4800"),
    ).passageId;

    for (const variant of RETRIEVAL_VARIANTS) {
      const result = await run(page, "/api/evaluate", {
        cases: [{
          id: `policy-${variant}`,
          category: "exact",
          query: "POLICY-4800 priority shipments",
          judgments: [{ passageId, relevance: 3 }],
        }],
        k: 5,
        variant,
      });
      expect(result.ok, variant).toBe(true);
      expect(result.data.metrics.cases, variant).toBe(1);
      expect(result.data.metrics.citationCorrectness, variant).toBeGreaterThanOrEqual(0);
      expect(result.data.metrics.evidenceFaithfulness, variant).toBeGreaterThanOrEqual(0);
    }
    expect(repository.evaluationRuns).toHaveLength(RETRIEVAL_VARIANTS.length);
    expect(repository.evaluationRuns.map(run => run.configuration.variant)).toEqual(
      RETRIEVAL_VARIANTS,
    );
  });

  test("diversifies duplicate evidence and preserves lexical retrieval after vector eviction", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const duplicates = await run(page, "/api/search", {
      query: "DUPLICATE-CEDAR-55110 recovery",
      options: { limit: 8 },
    });
    const duplicateEvidence = duplicates.data.evidence.filter(
      item => item.text.includes("DUPLICATE-CEDAR-55110"),
    );
    expect(duplicateEvidence.length).toBeLessThanOrEqual(2);
    expect(new Set(duplicateEvidence.map(item => item.passageId)).size).toBe(
      duplicateEvidence.length,
    );

    const before = (await run(page, "/api/status")).data.validation;
    const eviction = await run(page, "/api/evict", { limit: 2 });
    const after = (await run(page, "/api/status")).data.validation;
    const lexical = await run(page, "/api/search", {
      query: "DUPLICATE-CEDAR-55110",
      options: { limit: 3, variant: "lexical_only" },
    });
    expect(eviction.data.evicted).toBeGreaterThan(0);
    expect(after.lexicalReady).toBe(before.lexicalReady);
    expect(after.passageEmbeddings).toBe(before.passageEmbeddings - eviction.data.evicted);
    expect(lexical.data.evidence.some(item => item.text.includes("DUPLICATE-CEDAR-55110"))).toBe(true);
  });

  test("cancellation cannot replace an active immutable publication", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const result = await run(page, "/api/scenario/cancellation");

    expect(result.ok).toBe(true);
    expect(result.data.cancelledState).toBe("cancelled");
    expect(result.data.cancelledGeneration).not.toBe(result.data.activeGeneration);
    expect(result.data.activeGeneration).toBe(result.data.baselineGeneration);
  });

  test("publishes signature-isolated generations side by side", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const result = await run(page, "/api/scenario/signature");

    expect(result.ok).toBe(true);
    expect(result.data.firstGeneration).not.toBe(result.data.secondGeneration);
    expect(result.data.firstSignature).toBe("playwright-signature-v1");
    expect(result.data.activeSignature).toBe("playwright-signature-v2");
    expect(result.data.secondEmbeddedTexts).toBeGreaterThan(0);
    expect(result.data.validation.passageEmbeddings).toBe(
      result.data.validation.passages,
    );
  });

  test("degrades safely when reranking is unavailable and isolates workspaces", async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), "Backend-heavy generated-corpus acceptance runs once in desktop Chromium.");
    const degraded = await run(page, "/api/scenario/degradation");
    const isolated = await run(page, "/api/scenario/isolation");

    expect(degraded.ok).toBe(true);
    expect(degraded.data.evidenceCount).toBeGreaterThan(0);
    expect(degraded.data.degraded.join(" ")).toMatch(/reranker unavailable/i);
    expect(degraded.data.evidenceText).toContain("DEGRADED-88220");
    expect(isolated.data.error).toMatch(/no active publication/i);
  });
});

async function cancellationScenario(parentRoot) {
  const root = await mkdtemp(path.join(parentRoot, "cancel-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "baseline.md"), "# Baseline\n\nStable evidence BASELINE-44110.");
  const workspace = { id: "cancel-workspace", name: "Cancel", configDir: root };
  const context = { id: "cancel-context", name: "Cancel", paths: [docs] };
  const repository = new MemoryRagV2Repository();
  const baselineManager = new WorkspaceRagV2Manager(repository, testEmbedder());
  const baseline = await ingest(baselineManager, workspace, context);
  await baselineManager.close();

  for (let index = 0; index < 24; index++) {
    await writeFile(
      path.join(docs, `pending-${index}.md`),
      `# Pending ${index}\n\n${"cancellable generated evidence ".repeat(160)}`,
    );
  }
  const slowManager = new WorkspaceRagV2Manager(
    repository,
    testEmbedder({ delayMs: 80 }),
  );
  await slowManager.initialize();
  const pending = slowManager.startIngestion(workspace, context);
  await new Promise(resolve => setTimeout(resolve, 25));
  const cancelled = await slowManager.cancel(workspace.id, context.id);
  const active = await repository.activePublication(workspace.id, context.id);
  await slowManager.close();
  return {
    baselineGeneration: baseline.generationId,
    cancelledGeneration: pending.generationId,
    cancelledState: cancelled?.state,
    activeGeneration: active?.generationId,
  };
}

async function signatureScenario(parentRoot) {
  const root = await mkdtemp(path.join(parentRoot, "signature-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "stable.md"), "# Stable\n\nSignature evidence SIGNATURE-55220.");
  const workspace = { id: "signature-workspace", name: "Signature", configDir: root };
  const context = { id: "signature-context", name: "Signature", paths: [docs] };
  const repository = new MemoryRagV2Repository();

  const firstManager = new WorkspaceRagV2Manager(
    repository,
    testEmbedder({ signature: "playwright-signature-v1" }),
  );
  const first = await ingest(firstManager, workspace, context);
  const firstPublication = await repository.activePublication(workspace.id, context.id);
  await firstManager.close();

  let secondEmbeddedTexts = 0;
  const base = testEmbedder({ signature: "playwright-signature-v2" });
  const secondManager = new WorkspaceRagV2Manager(repository, {
    info: base.info,
    async embed(texts, purpose, signal) {
      secondEmbeddedTexts += texts.length;
      return base.embed(texts, purpose, signal);
    },
  });
  const second = await ingest(secondManager, workspace, context);
  const active = await repository.activePublication(workspace.id, context.id);
  const validation = await repository.validateGeneration(
    workspace.id,
    context.id,
    second.generationId,
  );
  await secondManager.close();
  return {
    firstGeneration: first.generationId,
    secondGeneration: second.generationId,
    firstSignature: firstPublication?.embeddingSignature,
    activeSignature: active?.embeddingSignature,
    secondEmbeddedTexts,
    validation,
  };
}

async function degradationScenario(parentRoot) {
  const root = await mkdtemp(path.join(parentRoot, "degraded-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(
    path.join(docs, "reranker.md"),
    "# Resilient retrieval\n\nEvidence survives reranker failure DEGRADED-88220.",
  );
  const workspace = { id: "degraded-workspace", name: "Degraded", configDir: root };
  const context = { id: "degraded-context", name: "Degraded", paths: [docs] };
  const previous = process.env.CORTEX_RAG_V2_RERANKER_URL;
  process.env.CORTEX_RAG_V2_RERANKER_URL = "http://127.0.0.1:1/rerank";
  const manager = new WorkspaceRagV2Manager(
    new MemoryRagV2Repository(),
    testEmbedder(),
  );
  if (previous === undefined) delete process.env.CORTEX_RAG_V2_RERANKER_URL;
  else process.env.CORTEX_RAG_V2_RERANKER_URL = previous;
  await ingest(manager, workspace, context);
  const result = await manager.search(
    workspace,
    context,
    "DEGRADED-88220",
    { limit: 3, variant: "hybrid_reranked" },
  );
  await manager.close();
  return {
    evidenceCount: result.evidence.length,
    evidenceText: result.evidence.map(value => value.text).join("\n"),
    degraded: result.degraded,
  };
}
