import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");

const { WorkspaceRagV2Manager } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts"
);
const { MemoryRagV2Repository } = await import(
  "../local-agent/matbot/packages/plugins/workspace-rag/src/v2/memory-repository.ts"
);

function embedding(text, dimensions = 32) {
  const vector = new Array(dimensions).fill(0);
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    vector[token.length % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

/**
 * Tracks how many embedding calls are in flight. While `gateUntil` has not been
 * reached, calls park (bounded by `gateTimeoutMs`) so the scheduler gets a fair
 * chance to stack work; once reached, everything passes through unlocked.
 */
function trackedEmbedder(dimensions = 32, gateUntil = Infinity, gateTimeoutMs = 500) {
  let active = 0;
  let opened = false;
  const stats = { peak: 0 };
  const releases = new Set();
  const base = {
    info: { backend: "test", model: "test-multilingual", dimensions, signature: "test-v1", maxTokens: 512 },
    async embed(texts, _purpose, signal) {
      active++;
      stats.peak = Math.max(stats.peak, active);
      try {
        if (!opened && active < gateUntil) {
          await new Promise(resolve => {
            const timer = setTimeout(resolve, gateTimeoutMs);
            const release = () => { clearTimeout(timer); resolve(); };
            signal?.addEventListener("abort", release, { once: true });
            releases.add(release);
          });
        }
        if (active >= gateUntil && !opened) {
          opened = true;
          for (const release of [...releases]) release();
          releases.clear();
        }
        return texts.map(text => embedding(text));
      } finally {
        active--;
      }
    },
  };
  return { embedder: base, stats };
}

function refs(root, docs) {
  return {
    workspace: { id: "workspace-adaptive", name: "Adaptive", configDir: root },
    context: { id: "contracts", name: "Contracts", paths: [docs] },
  };
}

async function corpus(prefix, count) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  for (let index = 0; index < count; index++) {
    await writeFile(
      path.join(docs, `doc-${String(index).padStart(2, "0")}.md`),
      `# Doc ${index}\n\n## Body\n\nThe answer is ADAPTIVE-EVIDENCE-${index}.`,
      "utf8",
    );
  }
  return { root, docs };
}

test("MISSING-02 adaptive file concurrency runs bulk backlogs wide and incremental scans sequentially", async t => {
  const { root, docs } = await corpus("cortex-rag-adaptive-bulk-", 12);
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new MemoryRagV2Repository();
  const { embedder, stats } = trackedEmbedder(32, 3);
  const manager = new WorkspaceRagV2Manager(repository, embedder);
  t.after(() => manager.close());
  const { workspace, context } = refs(root, docs);
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);

  const status = await manager.status("primary", workspace, context);
  assert.equal(status.job.state, "active_hybrid_complete");
  assert.equal(status.job.processedFiles, 12);
  assert.ok(
    stats.peak >= 3,
    `a bulk backlog must ingest several files at once (peak concurrent embeddings: ${stats.peak})`,
  );
});

test("MISSING-02 adaptive file concurrency keeps small scans strictly sequential", async t => {
  process.env.CORTEX_RAG_V2_EMBED_PIPELINE_DEPTH = "1";
  t.after(() => { delete process.env.CORTEX_RAG_V2_EMBED_PIPELINE_DEPTH; });
  const { root, docs } = await corpus("cortex-rag-adaptive-small-", 2);
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new MemoryRagV2Repository();
  const { embedder, stats } = trackedEmbedder();
  const manager = new WorkspaceRagV2Manager(repository, embedder);
  t.after(() => manager.close());
  const { workspace, context } = refs(root, docs);
  manager.startIngestion(workspace, context);
  await manager.waitForIngestion(workspace.id, context.id);

  const status = await manager.status("primary", workspace, context);
  assert.equal(status.job.state, "active_hybrid_complete");
  assert.equal(
    stats.peak,
    1,
    `a scan with only a couple of pending files must stay sequential (peak: ${stats.peak})`,
  );
});
