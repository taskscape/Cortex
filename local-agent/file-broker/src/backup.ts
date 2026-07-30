import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
