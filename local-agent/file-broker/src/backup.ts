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
  const backupPath = path.resolve(backupRoot, `${timestamp}_${safeName}`);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(targetPath, backupPath);
  return backupPath;
}
