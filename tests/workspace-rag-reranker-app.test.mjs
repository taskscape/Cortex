import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

function findPython() {
  for (const command of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const args = command === "py" ? ["-3", "--version"] : ["--version"];
    if (spawnSync(command, args, { stdio: "ignore" }).status === 0) {
      return { command, prefix: command === "py" ? ["-3"] : [] };
    }
  }
  return undefined;
}

const python = findPython();

test("reranker service enforces bounds, reuses one model, and degrades GPU OOM", {
  skip: python === undefined,
}, async () => {
  const { stdout, stderr } = await execFileAsync(python.command, [
    ...python.prefix,
    "tests/workspace-rag-reranker-app-runtime.py",
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.match(stdout + stderr, /reranker app mock integration passes/);
});

test("reranker Compose service is optional and shares the persistent model cache", async () => {
  const compose = await readFile(
    path.join(process.cwd(), "local-agent", "docker", "mem0", "docker-compose.yml"),
    "utf8",
  );
  assert.match(compose, /workspace-rag-reranker:[\s\S]*?profiles:\s*\["reranker"\]/);
  assert.match(compose, /workspace-rag-reranker:[\s\S]*?workspace-rag-models:\/models/);
  assert.match(compose, /RERANKER_MAX_TEXTS/);
  assert.doesNotMatch(compose, /matbot\/workspace-rag-reranker:latest/);
  assert.match(compose, /RERANKER_MODEL_REVISION:[^\n]*[a-f0-9]{40}/);
  assert.match(compose, /RERANKER_CODE_REVISION:[^\n]*[a-f0-9]{40}/);
  assert.match(compose, /pgvector\/pgvector:0\.8\.3-pg16@sha256:[a-f0-9]{64}/);
});
