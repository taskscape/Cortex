import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function dockerAvailable() {
  try { await execFileAsync("docker", ["compose", "version"], { timeout: 10_000 }); return true; }
  catch { return false; }
}

/** A Compose fixture may only clean up its own generated project. */
export async function createDockerComposeFixture(prefix = "cortex-test") {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const project = `${prefix}-${token}`.replace(/[^a-z0-9-]/gi, "").toLowerCase();
  if (!/^cortex-test-[a-z0-9-]+$/.test(project)) throw new Error("Refusing unsafe Docker Compose project name.");
  const root = await mkdtemp(path.join(tmpdir(), "cortex-docker-"));
  const run = async (args, options = {}) => execFileAsync("docker", ["compose", "-p", project, ...args], {
    timeout: options.timeout ?? 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return {
    root,
    project,
    write: (name, body) => writeFile(path.join(root, name), body, "utf8"),
    run,
    async cleanup(composeFiles = []) {
      try { await run([...composeFiles.flatMap(file => ["-f", file]), "down", "--volumes", "--remove-orphans"], { timeout: 120_000 }); }
      finally { await rm(root, { recursive: true, force: true }); }
    },
  };
}
