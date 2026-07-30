import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

function findPython() {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const command of candidates) {
    const args = command === "py" ? ["-3", "--version"] : ["--version"];
    const result = spawnSync(command, args, { stdio: "ignore" });
    if (result.status === 0) return { command, prefixArgs: command === "py" ? ["-3"] : [] };
  }
  return undefined;
}

const python = findPython();

test("CUDA sidecar handles CPU detection, model reuse, E5 preprocessing, and GPU OOM without a GPU", { skip: python === undefined }, async () => {
  const { stdout, stderr } = await execFileAsync(python.command, [
    ...python.prefixArgs,
    "tests/workspace-rag-cuda-app-runtime.py",
  ], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.match(stdout + stderr, /workspace-rag CUDA app mock integration passes/);
});

test("CUDA image preloads models and mounts a persistent Hugging Face cache", async () => {
  const root = process.cwd();
  const [dockerfile, compose] = await Promise.all([
    readFile(path.join(root, "local-agent", "docker", "mem0", "Dockerfile.workspace-rag-cuda"), "utf8"),
    readFile(path.join(root, "local-agent", "docker", "mem0", "docker-compose.yml"), "utf8"),
  ]);
  assert.match(dockerfile, /HF_HOME=\/models\/huggingface/);
  assert.match(dockerfile, /SENTENCE_TRANSFORMERS_HOME=\/models\/sentence-transformers/);
  assert.match(dockerfile, /SentenceTransformer\(model_name, device="cpu"\)/);
  assert.match(compose, /workspace-rag-cuda:[\s\S]*?volumes:\s*\r?\n\s*- workspace-rag-models:\/models/);
  assert.match(compose, /^  workspace-rag-models:\s*$/m);
});
