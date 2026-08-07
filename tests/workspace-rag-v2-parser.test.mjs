import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");

const { ragV2ModeFromEnv, ragV2PolicyFromEnv } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/config.ts"
);
const { RagV2ObjectStore } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/object-store.ts"
);
const { parseMarkdownStream } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/parser.ts"
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("workspace RAG V2 is the only index mode and defaults to primary", () => {
  const previous = process.env.CORTEX_RAG_V2_MODE;
  try {
    delete process.env.CORTEX_RAG_V2_MODE;
    assert.equal(ragV2ModeFromEnv(), "primary");
    process.env.CORTEX_RAG_V2_MODE = "unsupported-value";
    assert.equal(ragV2ModeFromEnv(), "primary", "unknown values cannot select an alternate index");
    process.env.CORTEX_RAG_V2_MODE = "off";
    assert.equal(ragV2ModeFromEnv(), "off");
  } finally {
    if (previous === undefined) delete process.env.CORTEX_RAG_V2_MODE;
    else process.env.CORTEX_RAG_V2_MODE = previous;
  }
});

test("workspace RAG V2 streams hierarchy with immutable byte and line citations", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-parser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "contract.md");
  const content = [
    "# Master Services Agreement",
    "",
    "This agreement is made by the customer and contractor.",
    "",
    "## 1. Termination",
    "",
    "Wykonawca może wypowiedzieć umowę zgodnie z artykułem 14.",
    "",
    "### 1.1 Termination for convenience",
    "",
    "The contractor shall provide thirty days notice 👉.",
    "",
    "| Party | Notice |",
    "| --- | --- |",
    "| Contractor | 30 days |",
    "",
  ].join("\r\n");
  await writeFile(source, content, "utf8");

  const objectStore = new RagV2ObjectStore(path.join(root, "objects"));
  const object = await objectStore.putFile(source);
  assert.equal(object.contentSha256, sha256(Buffer.from(content)));

  const sections = [];
  const passages = [];
  const lineWriter = await objectStore.createLineIndexWriter(object.contentSha256);
  const policy = {
    ...ragV2PolicyFromEnv(),
    parserMemoryBytes: 1024 * 1024,
    targetPassageTokens: 80,
    hardMaxPassageTokens: 120,
    lineIndexStride: 2,
  };
  const parsed = await parseMarkdownStream(
    object.objectPath,
    {
      workspaceId: "workspace-1",
      contextId: "context-1",
      documentId: "document-1",
      documentVersionId: object.contentSha256,
    },
    policy,
    {
      async onSection(section) { sections.push(section); },
      async onPassage(passage) { passages.push(passage); },
      ...(lineWriter ? { async onLineCheckpoint(line, byte) { await lineWriter.add(line, byte); } } : {}),
    },
  );
  await lineWriter?.close();

  assert.equal(parsed.title, "Master Services Agreement");
  assert.equal(parsed.sectionCount, 3);
  assert.equal(sections.length, 3);
  assert.ok(passages.length >= 3);
  assert.equal(parsed.passageCount, passages.length);
  assert.ok(parsed.languageDistribution.en > 0);
  assert.ok(parsed.languageDistribution.pl > 0);
  assert.deepEqual(sections[2].headingPath, [
    "Master Services Agreement",
    "1. Termination",
    "1.1 Termination for convenience",
  ]);

  for (let index = 0; index < passages.length; index++) {
    const passage = passages[index];
    const raw = await objectStore.fetchRange(
      object.contentSha256,
      passage.startByte,
      passage.endByte,
    );
    assert.equal(sha256(raw), passage.contentSha256);
    assert.equal(raw.toString("utf8"), passage.text);
    assert.equal(passage.previousPassageId, passages[index - 1]?.passageId);
    assert.equal(passage.nextPassageId, passages[index + 1]?.passageId);
  }

  const fetchedLines = await objectStore.fetchLines(object.contentSha256, 5, 7);
  assert.match(fetchedLines.text, /1\. Termination/);
  assert.match(fetchedLines.text, /Wykonawca/);

  const duplicate = await objectStore.putFile(source);
  assert.equal(duplicate.objectPath, object.objectPath, "content-addressed source objects are reused");
});

test("workspace RAG V2 splits a very long structural unit within the parser memory budget", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-bounded-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "large.md");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, `# Large\n\n${"zażółć👉".repeat(350_000)}\n`, "utf8");

  const objectStore = new RagV2ObjectStore(path.join(root, "objects"));
  const object = await objectStore.putFile(source);
  const passages = [];
  const parsed = await parseMarkdownStream(
    object.objectPath,
    {
      workspaceId: "workspace-1",
      contextId: "context-1",
      documentId: "document-large",
      documentVersionId: object.contentSha256,
    },
    {
      ...ragV2PolicyFromEnv(),
      parserMemoryBytes: 1024 * 1024,
      targetPassageTokens: 800,
      hardMaxPassageTokens: 1200,
    },
    {
      async onSection() {},
      async onPassage(passage) { passages.push(passage); },
    },
  );

  assert.ok(passages.length > 100);
  assert.ok(passages.every(passage => passage.tokenCount <= 1300));
  assert.ok(
    parsed.peakBufferedBytes <= 1024 * 1024,
    `peak parser buffer ${parsed.peakBufferedBytes} exceeded configured budget`,
  );
  for (const passage of passages) {
    assert.equal(passage.text.includes("\uFFFD"), false, "UTF-8 boundaries remain intact");
  }
});

test("workspace RAG V2 promotes front matter, preserves fenced blocks, and repeats split table headers only for search", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-structure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "structured.md");
  const rows = Array.from({ length: 90 }, (_, index) => `| Party ${index} | ${index + 1} days |`);
  await writeFile(source, [
    "---",
    "document_type: contract",
    "jurisdiction: PL",
    "governing_law: Polish law",
    "parties: [Acme, Example Sp. z o.o.]",
    "publication_date: 2026-07-31",
    "valid_from: 2026-08-01",
    "book_id: commercial-contracts-handbook",
    "book_title: Commercial Contracts Handbook",
    "---",
    "# Structured agreement",
    "",
    "```markdown",
    "# This is code, not a heading",
    "",
    "and this blank line remains inside the code unit",
    "```",
    "",
    "| Party | Notice |",
    "| --- | --- |",
    ...rows,
    "",
  ].join("\n"), "utf8");

  const passages = [];
  const sections = [];
  const parsed = await parseMarkdownStream(
    source,
    {
      workspaceId: "workspace-structure",
      contextId: "context-structure",
      documentId: "document-structure",
      documentVersionId: "version-structure",
    },
    {
      ...ragV2PolicyFromEnv(),
      parserMemoryBytes: 64 * 1024,
      targetPassageTokens: 40,
      hardMaxPassageTokens: 48,
    },
    {
      async onSection(section) { sections.push(section); },
      async onPassage(passage) { passages.push(passage); },
    },
  );

  assert.deepEqual(parsed.metadata, {
    documentType: "contract",
    jurisdiction: "PL",
    governingLaw: "Polish law",
    parties: ["Acme", "Example Sp. z o.o."],
    publicationDate: "2026-07-31",
    validFrom: "2026-08-01",
    collectionId: "commercial-contracts-handbook",
    collectionTitle: "Commercial Contracts Handbook",
  });
  assert.ok(passages.every(passage => !/book_id:/u.test(passage.text)), "front matter is routing metadata, not citation evidence");
  assert.equal(
    parsed.tableOfContents.some(item => /This is code/.test(item.text)),
    false,
    "heading-like text inside a fence is not promoted into the hierarchy",
  );
  assert.ok(passages.some(passage =>
    passage.structuralType === "code" && /blank line remains inside/.test(passage.text)));
  const derivative = passages.find(passage =>
    passage.structuralType === "table"
    && passage.lexicalText?.startsWith("| Party | Notice |\n| --- | --- |\n")
    && !passage.text.startsWith("| Party | Notice |"));
  assert.ok(derivative, "later table chunks repeat headers in their search-only derivative");
  assert.equal(sha256(derivative.text), derivative.contentSha256);
  assert.ok(sections.length >= 1);
});

test("workspace RAG V2 object retention supports managed, external immutable, and explicit manifest-only modes", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.md");
  await writeFile(source, "# Retention\n\nimmutable evidence", "utf8");

  const externalRoot = path.join(root, "external");
  const externalManaged = new RagV2ObjectStore(externalRoot);
  const externalObject = await externalManaged.putFile(source);
  const externalReader = new RagV2ObjectStore(
    path.join(root, "external-manifests"),
    undefined,
    "external_immutable",
    externalRoot,
  );
  const externalReference = await externalReader.putFile(source);
  assert.equal(externalReference.objectPath, externalObject.objectPath);
  assert.match(
    (await externalReader.fetchRange(externalReference.contentSha256, 0, 11)).toString("utf8"),
    /Retention/,
  );

  const manifestOnly = new RagV2ObjectStore(
    path.join(root, "manifest"),
    undefined,
    "manifest_only",
  );
  const manifest = await manifestOnly.putFile(source);
  assert.match(
    (await manifestOnly.fetchRange(manifest.contentSha256, 0, 11)).toString("utf8"),
    /Retention/,
  );
  await writeFile(source, "# Changed\n\nmutable evidence", "utf8");
  await assert.rejects(
    manifestOnly.fetchRange(manifest.contentSha256, 0, 8),
    /historical citation is unavailable/i,
  );
});

const twoGiBTest = process.env.CORTEX_RAG_V2_2GB_INTEGRATION === "1" ? test : test.skip;

twoGiBTest("workspace RAG V2 parses a sparse 2 GiB source with bounded buffers", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-rag-v2-2gb-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "two-gib.md");
  const size = 2 * 1024 * 1024 * 1024;
  const handle = await open(source, "w");
  try {
    await handle.write(Buffer.from("# Two GiB\n\n"), 0, 11, 0);
    await handle.truncate(size);
    const tail = Buffer.from("\n\n## Tail\n\nEND-OF-TWO-GIB\n");
    await handle.write(tail, 0, tail.length, size - tail.length);
  } finally {
    await handle.close();
  }
  let passages = 0;
  const parsed = await parseMarkdownStream(
    source,
    {
      workspaceId: "workspace-2gb",
      contextId: "context-2gb",
      documentId: "document-2gb",
      documentVersionId: "version-2gb",
    },
    {
      ...ragV2PolicyFromEnv(),
      parserMemoryBytes: 16 * 1024 * 1024,
      targetPassageTokens: 800,
      hardMaxPassageTokens: 1200,
    },
    {
      async onSection() {},
      async onPassage() { passages++; },
    },
  );
  assert.ok(passages > 100_000);
  assert.ok(parsed.peakBufferedBytes <= 16 * 1024 * 1024);
  assert.equal(parsed.title, "Two GiB");
});
