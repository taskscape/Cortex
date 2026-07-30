import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { FileExpertKnowledge } = await import("../local-agent/matbot/plugins/expert-panel/src/file-knowledge.ts");

function expert(id, roots) {
  return {
    id,
    title: `${id} expert`,
    description: `${id} test expert`,
    roots,
    systemPrompt: "Use only the configured files.",
  };
}

test("expert knowledge loads every supported text format and ignores unsupported or oversized files", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-expert-knowledge-formats-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const supported = new Map([
    ["brief.md", "# Brief\nFORMAT_CANARY markdown"],
    ["component.mdx", "# Component\nFORMAT_CANARY mdx"],
    ["notes.txt", "FORMAT_CANARY text"],
    ["record.json", '{"topic":"FORMAT_CANARY json"}'],
    ["table.csv", "topic\nFORMAT_CANARY csv"],
    ["table.tsv", "topic\nFORMAT_CANARY tsv"],
    ["config.yaml", "topic: FORMAT_CANARY yaml"],
    ["config.yml", "topic: FORMAT_CANARY yml"],
  ]);
  for (const [name, content] of supported) await writeFile(path.join(root, name), content, "utf8");
  await writeFile(path.join(root, "unsupported.pdf"), "FORMAT_CANARY should not be loaded", "utf8");
  await writeFile(path.join(root, ".hidden.md"), "FORMAT_CANARY should stay hidden", "utf8");
  await writeFile(path.join(root, "too-large.md"), `FORMAT_CANARY${"x".repeat(1_000_001)}`, "utf8");

  const knowledge = new FileExpertKnowledge(expert("formats", [root]));
  const sources = await knowledge.search("FORMAT_CANARY", 20, new AbortController().signal);

  assert.deepEqual(
    sources.map(source => source.title).sort(),
    [...supported.keys()].sort(),
  );
  assert.ok(sources.every(source => source.path.startsWith(root)));
  assert.ok(sources.every(source => source.content.includes("FORMAT_CANARY")));
  assert.equal(sources.some(source => source.title === "unsupported.pdf"), false);
  assert.equal(sources.some(source => source.title === ".hidden.md"), false);
  assert.equal(sources.some(source => source.title === "too-large.md"), false);
  assert.equal(sources.find(source => source.title === "record.json")?.content, supported.get("record.json"));
  assert.equal(sources.find(source => source.title === "table.csv")?.content, supported.get("table.csv"));
});

test("expert knowledge keeps roots isolated and does not let a large matching file leak into results", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-expert-knowledge-isolation-"));
  const financeRoot = path.join(root, "finance");
  const securityRoot = path.join(root, "security");
  await Promise.all([mkdir(financeRoot), mkdir(securityRoot)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(financeRoot, "finance.md"), "FINANCE_ONLY_CANARY margin plan", "utf8");
  await writeFile(path.join(financeRoot, "finance-large.md"), `FINANCE_ONLY_CANARY${"x".repeat(1_000_001)}`, "utf8");
  await writeFile(path.join(securityRoot, "security.md"), "SECURITY_ONLY_CANARY access review", "utf8");

  const finance = new FileExpertKnowledge(expert("finance", [financeRoot]));
  const security = new FileExpertKnowledge(expert("security", [securityRoot]));
  const [financeSources, securitySources] = await Promise.all([
    finance.search("FINANCE_ONLY_CANARY", 10, new AbortController().signal),
    security.search("SECURITY_ONLY_CANARY", 10, new AbortController().signal),
  ]);

  assert.deepEqual(financeSources.map(source => source.title), ["finance.md"]);
  assert.ok(financeSources.every(source => source.path.startsWith(financeRoot)));
  assert.equal(financeSources.some(source => source.path.startsWith(securityRoot)), false);
  assert.deepEqual(securitySources.map(source => source.title), ["security.md"]);
  assert.ok(securitySources.every(source => source.path.startsWith(securityRoot)));
  assert.equal(securitySources.some(source => source.path.startsWith(financeRoot)), false);
});
