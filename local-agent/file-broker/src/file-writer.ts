import fs from "node:fs/promises";
import path from "node:path";
import { createBackup } from "./backup.js";
import { createUnifiedDiff } from "./diff.js";

export interface WriteResult {
  path: string;
  backupPath?: string;
  diff: string;
}

// A backup is meaningful only when its source is stable.  Serialise writes to
// one resolved path, while allowing unrelated files to proceed in parallel.
// Without this, a second request can copy a file while the first is replacing
// it (an intermittent Windows sharing violation) and return a 500 instead of
// a recoverable snapshot.
const writeTails = new Map<string, Promise<void>>();

export async function writeTextFile(targetPath: string, content: string, backupRoot: string): Promise<WriteResult> {
  const resolvedTarget = path.resolve(targetPath);
  const key = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  const previous = writeTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => turn);
  writeTails.set(key, tail);
  await previous;

  try {
    return await writeTextFileUnlocked(resolvedTarget, content, backupRoot);
  } finally {
    release();
    if (writeTails.get(key) === tail) writeTails.delete(key);
  }
}

async function writeTextFileUnlocked(targetPath: string, content: string, backupRoot: string): Promise<WriteResult> {
  let before = "";
  try {
    before = await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const backupPath = await createBackup(targetPath, backupRoot);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");

  return {
    path: targetPath,
    ...(backupPath !== undefined ? { backupPath } : {}),
    diff: createUnifiedDiff(targetPath, before, content)
  };
}
