import fs from "node:fs/promises";
import path from "node:path";
import { createBackup } from "./backup.js";
import { createUnifiedDiff } from "./diff.js";

/** Outcome of a successful write: the written path, optional backup, and diff. */
export interface WriteResult {
  /** Absolute path of the file that was written. */
  path: string;
  /** Path of the pre-write backup snapshot, absent when the file did not exist. */
  backupPath?: string;
  /** Unified diff of the file before versus after the write. */
  diff: string;
}

// A backup is meaningful only when its source is stable.  Serialise writes to
// one resolved path, while allowing unrelated files to proceed in parallel.
// Without this, a second request can copy a file while the first is replacing
// it (an intermittent Windows sharing violation) and return a 500 instead of
// a recoverable snapshot.
const writeTails = new Map<string, Promise<void>>();

/**
 * Writes UTF-8 text to a file, creating a backup of any existing content first
 * and returning a unified diff. Writes to the same resolved path are
 * serialised (per the per-path queue above) while unrelated paths proceed in
 * parallel.
 *
 * @param targetPath - File to write; parent directories are created as needed.
 * @param content - Full new text content for the file.
 * @param backupRoot - Directory under which the pre-write backup is stored.
 * @returns The write result including backup path (when a prior file existed) and diff.
 * @throws Any filesystem error other than ENOENT when reading the previous content,
 * from creating the backup, or from writing the file.
 */
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
