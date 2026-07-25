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
  return mapWithConcurrency(entries, 16, async entry => {
    const fullPath = path.join(directoryPath, entry.name);
    const size = entry.isFile() ? (await fs.stat(fullPath)).size : undefined;
    return {
      name: entry.name,
      path: fullPath,
      type: entry.isDirectory() ? "directory" : "file",
      ...(size !== undefined ? { size } : {})
    };
  });
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}
