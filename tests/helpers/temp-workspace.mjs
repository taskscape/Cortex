import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Create isolated paths for tests without ever reading a user's Cortex workspace. */
export async function createTempWorkspace(prefix = "cortex-test-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  const config = path.join(root, "config");
  const files = path.join(root, "files");
  const data = path.join(root, "data");
  await Promise.all([workspace, config, files, data].map(dir => mkdir(dir, { recursive: true })));
  return {
    root,
    workspace,
    config,
    files,
    data,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

export async function withTempWorkspace(t, prefix, run) {
  const fixture = await createTempWorkspace(prefix);
  t.after(() => fixture.cleanup());
  return run(fixture);
}
