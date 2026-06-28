import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { chunkText, extractText, isIndexableTextFile } from "./extract.js";
import { normalizeWindowsPath } from "./path-normalization.js";
import type { IndexedChunk, IndexStore } from "./store.js";

export interface IndexOptions {
  root: string;
  excludedPatterns: string[];
  maxFileBytes: number;
}

export interface IndexSummary {
  indexedFiles: number;
  chunks: number;
  skipped: number;
}

export async function indexRoot(options: IndexOptions, existing: IndexStore): Promise<IndexStore> {
  const root = path.resolve(options.root);
  const nextChunks: IndexedChunk[] = [];
  const skipped: IndexStore["skipped"] = [];
  let fileCount = 0;

  for await (const filePath of walk(root)) {
    const relative = path.relative(root, filePath);

    if (isExcluded(relative, options.excludedPatterns)) {
      skipped.push({ path: filePath, reason: "excluded-pattern" });
      continue;
    }

    const stats = await fs.stat(filePath);

    if (!stats.isFile()) {
      continue;
    }

    if (!isIndexableTextFile(filePath)) {
      skipped.push({ path: filePath, reason: "unsupported-extension" });
      continue;
    }

    if (stats.size > options.maxFileBytes) {
      skipped.push({ path: filePath, reason: "too-large" });
      continue;
    }

    const content = await extractText(filePath, options.maxFileBytes);

    if (looksLikeSecret(content)) {
      skipped.push({ path: filePath, reason: "possible-secret" });
      continue;
    }

    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const normalized = normalizeWindowsPath(filePath, root);
    const chunks = chunkText(content);
    fileCount += 1;

    nextChunks.push(
      ...chunks.map((chunk, chunkIndex) => ({
        id: `${normalized.canonicalPath}:${chunkIndex}`,
        path: normalized.nativePath,
        canonicalPath: normalized.canonicalPath,
        relativePath: normalized.relativePath,
        projectRoot: normalized.projectRoot,
        extension: path.extname(filePath).toLowerCase(),
        fileHash: hash,
        modifiedTime: stats.mtime.toISOString(),
        size: stats.size,
        chunkIndex,
        content: chunk
      }))
    );
  }

  const rootCanonical = normalizeWindowsPath(root).canonicalPath;
  const outsideRoot = existing.chunks.filter(chunk => {
    return !chunk.canonicalPath.startsWith(rootCanonical);
  });

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    chunks: [...outsideRoot, ...nextChunks],
    skipped
  };
}

export function summarize(store: IndexStore): IndexSummary {
  const files = new Set(store.chunks.map(chunk => chunk.canonicalPath));
  return {
    indexedFiles: files.size,
    chunks: store.chunks.length,
    skipped: store.skipped.length
  };
}

async function* walk(root: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      yield* walk(fullPath);
      continue;
    }

    yield fullPath;
  }
}

function isExcluded(relativePath: string, patterns: string[]): boolean {
  const normalized = relativePath.replace(/\//g, "\\");
  return patterns.some(pattern => minimatch(normalized, pattern, { nocase: true }));
}

function looksLikeSecret(content: string): boolean {
  const patterns = [
    /sk-[A-Za-z0-9_-]{20,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /password\s*[:=]\s*["']?[^"'\s]+/i,
    /api[_-]?key\s*[:=]\s*["']?[^"'\s]+/i
  ];

  return patterns.some(pattern => pattern.test(content));
}
