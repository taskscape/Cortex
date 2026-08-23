import fs from "node:fs/promises";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".config",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

/**
 * Tests whether a file's extension is one of the indexable text types.
 *
 * @param filePath - Path whose extension is checked.
 * @returns True if the extension is in the supported text set.
 */
export function isIndexableTextFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Reads up to `maxBytes` of a file from the start and decodes it as UTF-8.
 *
 * @param filePath - The file to read.
 * @param maxBytes - Maximum number of bytes to read.
 * @returns The decoded text (possibly truncated at a multi-byte boundary).
 * @throws Any filesystem error from opening or reading the file.
 */
export async function extractText(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Splits text into fixed-size chunks of `chunkSize` characters; an empty input
 * yields a single empty chunk so every file has at least one chunk.
 *
 * @param content - Text to split.
 * @param chunkSize - Characters per chunk (default 2000).
 * @returns The ordered chunks covering the whole content.
 */
export function chunkText(content: string, chunkSize = 2000): string[] {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    chunks.push(content.slice(cursor, cursor + chunkSize));
    cursor += chunkSize;
  }

  return chunks.length === 0 ? [""] : chunks;
}
