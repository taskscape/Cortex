import fs from "node:fs/promises";
import path from "node:path";
import { createBackup } from "./backup.js";
import { createUnifiedDiff } from "./diff.js";

export interface WriteResult {
  path: string;
  backupPath?: string;
  diff: string;
}

export async function writeTextFile(targetPath: string, content: string, backupRoot: string): Promise<WriteResult> {
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
