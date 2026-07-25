import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { evaluateAccess, normalizeWindowsPath, type SecurityPolicy, type WorkspaceConfig } from "@local-agent/paths";
import { chunkText, extractText, isIndexableTextFile } from "./extract.js";
import type { IndexedChunk, IndexStore } from "./store.js";

export interface IndexOptions {
  root: string;
  excludedPatterns: string[];
  maxFileBytes: number;
  // Indexing a file is a read, and it is served back through /search, so it clears the same bar as
  // GET /read on the broker: one deny policy, enforced in both services.
  workspaces: WorkspaceConfig;
  policy: SecurityPolicy;
  signal?: AbortSignal;
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
  const rootCanonical = normalizeWindowsPath(root).canonicalPath;
  const existingByPath = new Map<string, IndexedChunk[]>();
  for (const chunk of existing.chunks) {
    if (!isWithinRoot(chunk.canonicalPath, rootCanonical)) continue;
    const chunks = existingByPath.get(chunk.canonicalPath) ?? [];
    chunks.push(chunk);
    existingByPath.set(chunk.canonicalPath, chunks);
  }

  for await (const filePath of walk(root)) {
    options.signal?.throwIfAborted();
    const relative = path.relative(root, filePath);

    if (isExcluded(relative, options.excludedPatterns)) {
      skipped.push({ path: filePath, reason: "excluded-pattern" });
      continue;
    }

    const decision = evaluateAccess(filePath, "read", options.workspaces, options.policy);

    if (!decision.allowed) {
      skipped.push({ path: filePath, reason: decision.reason ?? "denied-by-security-policy" });
      continue;
    }

    // High-risk files (.env, .pem, .key, ...) are readable through the broker only behind an explicit
    // approval. Nothing approves an index run, and a chunk in the store is readable by anyone who can
    // reach /search — so they are never indexed. `looksLikeSecret` below is a content backstop for
    // ordinary files, not a substitute for this: it misses `TOKEN=...` shapes entirely.
    if (decision.highRisk) {
      skipped.push({ path: filePath, reason: "high-risk-file" });
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

    const normalized = normalizeWindowsPath(filePath, root);
    const previous = existingByPath.get(normalized.canonicalPath);
    if (
      previous !== undefined &&
      previous.length > 0 &&
      previous[0]!.size === stats.size &&
      previous[0]!.modifiedTime === stats.mtime.toISOString()
    ) {
      nextChunks.push(...previous);
      continue;
    }

    const content = await extractText(filePath, options.maxFileBytes);

    if (looksLikeSecret(content)) {
      skipped.push({ path: filePath, reason: "possible-secret" });
      continue;
    }

    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const chunks = chunkText(content);

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

  const outsideRoot = existing.chunks.filter(chunk => {
    return !isWithinRoot(chunk.canonicalPath, rootCanonical);
  });

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    chunks: [...outsideRoot, ...nextChunks],
    skipped
  };
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}\\`);
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

    // `isDirectory()` is false for a symlink or junction (readdir does not follow links), so a linked
    // directory falls through to `yield` and is then dropped by the `stats.isFile()` check in the
    // caller. That is load-bearing, not incidental: it keeps the walk inside the real subtree of the
    // root that resolveIndexRoot authorised. Do not "fix" it into following links.
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
