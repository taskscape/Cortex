import fs from "node:fs/promises";
import path from "node:path";

export async function readTextFile(filePath: string, maxBytes: number): Promise<{ content: string; truncated: boolean; size: number }> {
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    throw new Error("Path is not a file.");
  }

  const bytesToRead = Math.min(stats.size, maxBytes);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    return {
      content: buffer.subarray(0, result.bytesRead).toString("utf8"),
      truncated: stats.size > maxBytes,
      size: stats.size
    };
  } finally {
    await handle.close();
  }
}

export async function listDirectory(directoryPath: string): Promise<Array<{ name: string; path: string; type: string; size?: number }>> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const rows = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    const stats = await fs.stat(fullPath);
    rows.push({
      name: entry.name,
      path: fullPath,
      type: entry.isDirectory() ? "directory" : "file",
      size: entry.isFile() ? stats.size : undefined
    });
  }

  return rows;
}
