import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Copies an existing file into `backupRoot` under a timestamped, UUID-suffixed
 * name derived from its path, so concurrent same-millisecond writes never
 * overwrite one another's snapshots.
 *
 * @param targetPath - The file to snapshot.
 * @param backupRoot - Directory under which the copy is stored.
 * @returns Absolute path of the backup copy, or undefined if the target does not exist.
 * @throws Any filesystem error from creating directories or copying the file.
 */
export async function createBackup(targetPath: string, backupRoot: string): Promise<string | undefined> {
  try {
    await fs.access(targetPath);
  } catch {
    return undefined;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = path.resolve(targetPath).replace(/[:\\\/]/g, "_");
  // Several approved writes can arrive in one millisecond. Keep every
  // pre-write snapshot attributable instead of allowing same-timestamp writes
  // to overwrite one another's backup.
  const backupPath = path.resolve(backupRoot, `${timestamp}_${randomUUID()}_${safeName}`);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(targetPath, backupPath);
  return backupPath;
}
