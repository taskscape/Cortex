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

export function isIndexableTextFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

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

export function chunkText(content: string, chunkSize = 2000): string[] {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    chunks.push(content.slice(cursor, cursor + chunkSize));
    cursor += chunkSize;
  }

  return chunks.length === 0 ? [""] : chunks;
}
