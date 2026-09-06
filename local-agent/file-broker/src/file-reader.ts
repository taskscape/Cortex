import fs from "node:fs/promises";
import path from "node:path";

/**
 * Reads up to `maxBytes` of a file as UTF-8 text, reporting whether the
 * content was truncated and the full file size.
 *
 * @param filePath - The file to read.
 * @param maxBytes - Maximum number of bytes to read.
 * @returns The decoded content, truncation flag, and total size in bytes.
 * @throws Any filesystem error from stat-ing or opening the file (e.g. ENOENT).
 * @throws Error if the path is not a regular file.
 */
export async function readTextFile(filePath: string, maxBytes: number): Promise<{ content: string; truncated: boolean; size: number }> {
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    throw new Error("Path is not a file.");
  }

  const handle = await fs.open(filePath, "r");
  try {
    return await readCappedText(handle, stats.size, maxBytes);
  } finally {
    await handle.close();
  }
}

/**
 * Reads up to `maxBytes` from an already-open handle as UTF-8 text, reporting
 * whether the content was truncated and the total file size.
 *
 * @param handle - Handle positioned at the start of the file.
 * @param size - Total file size in bytes (from the same handle).
 * @param maxBytes - Maximum number of bytes to read.
 * @returns The decoded content, truncation flag, and total size in bytes.
 */
export async function readCappedText(handle: fs.FileHandle, size: number, maxBytes: number): Promise<{ content: string; truncated: boolean; size: number }> {
  const bytesToRead = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const result = await handle.read(buffer, 0, bytesToRead, 0);
  return {
    content: buffer.subarray(0, result.bytesRead).toString("utf8"),
    truncated: size > maxBytes,
    size
  };
}

/**
 * Reads the entire remaining content of an already-open handle as UTF-8 text.
 *
 * @param handle - The handle to drain from its current position.
 * @returns The decoded full content.
 */
export async function readHandleText(handle: fs.FileHandle): Promise<string> {
  return (await handle.readFile()).toString("utf8");
}

/**
 * Lists a directory's immediate entries with type and (for files) size,
 * stat-ing entries with bounded concurrency.
 *
 * @param directoryPath - Directory to enumerate (non-recursive).
 * @returns Entries with name, absolute path, `directory`/`file` type, and file size when applicable.
 * @throws Any filesystem error from reading or stat-ing the directory contents.
 */
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

/**
 * Maps items to worker results with at most `concurrency` workers running at
 * once; workers pull the next index from a shared cursor, so results land in
 * input order regardless of completion order. Assumes `concurrency >= 1`.
 *
 * @param items - Items to process.
 * @param concurrency - Maximum simultaneously in-flight workers.
 * @param worker - Async function applied to each item.
 * @returns Results in the same order as `items`.
 * @throws The first worker rejection; already-started workers keep running.
 */
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
