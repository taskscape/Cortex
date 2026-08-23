import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { evaluateAccess, normalizeWindowsPath, type SecurityPolicy, type WorkspaceConfig } from "@local-agent/paths";
import { isExcluded, isExcludedDirectory } from "./exclusions.js";
import { chunkText, extractText, isIndexableTextFile } from "./extract.js";
import { fileLevelSecret, redactSecrets } from "./secrets.js";
import type { IndexedChunk, IndexStore } from "./store.js";

const RECOVERABLE_FILE_ERROR_CODES = new Set([
  "EACCES", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOENT", "EPERM",
]);

/** Inputs for an index run over one root directory. */
export interface IndexOptions {
  /** Root directory to walk (resolved internally). */
  root: string;
  /**
   * Indexing-only noise filters (build output, vendor trees). Not an access-control boundary —
   * the broker deliberately does not apply these; see evaluateAccess for what actually gates reads.
   */
  indexExcludedPatterns: string[];
  /** Maximum file size in bytes that will be read and indexed. */
  maxFileBytes: number;
  /**
   * Indexing a file is a read, and it is served back through /search, so it clears the same bar as
   * GET /read on the broker: one deny policy, enforced in both services.
   */
  workspaces: WorkspaceConfig;
  /** Security policy applied to every candidate file. */
  policy: SecurityPolicy;
  /** Optional signal; when aborted, indexing stops promptly. */
  signal?: AbortSignal;
}

/** High-level counts describing an index store after a run. */
export interface IndexSummary {
  /** Distinct files represented in the store. */
  indexedFiles: number;
  /** Total chunks in the store. */
  chunks: number;
  /** Files/directories skipped during indexing. */
  skipped: number;
}

/**
 * Walks `root`, extracts and redacts text from eligible files, and returns a
 * new store combining fresh chunks with unchanged chunks carried over (matched
 * by size/mtime) and all chunks for paths outside this root. Unreadable
 * directories/files are recorded as skipped instead of failing the run.
 *
 * @param options - Index run parameters including exclusions, limits, policy, and abort signal.
 * @param existing - Previous store whose chunks are reused or replaced.
 * @returns The updated store (not persisted; callers save it).
 * @throws Any non-recoverable filesystem error (codes outside EACCES/EBUSY/EIO/EMFILE/ENFILE/ENOENT/EPERM)
 * or an abort raised via `options.signal`.
 */
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

  for await (const filePath of walk(root, root, options.indexExcludedPatterns, skipped)) {
    try {
      options.signal?.throwIfAborted();
      const relative = path.relative(root, filePath);

      if (isExcluded(relative, options.indexExcludedPatterns)) {
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
      // reach /search — so they are never indexed. The redaction pass below is a content backstop for
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

      const secret = fileLevelSecret(content);
      if (secret !== undefined) {
        skipped.push({ path: filePath, reason: `possible-secret: ${secret}` });
        continue;
      }

      // Hash the original content: this drives change detection, so it must not shift when redaction
      // rules change.
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      const chunks = chunkText(content);

      nextChunks.push(
        ...chunks.map((chunk, chunkIndex) => {
          const { text, redactions } = redactSecrets(chunk);
          return {
            id: `${normalized.canonicalPath}:${chunkIndex}`,
            path: normalized.nativePath,
            canonicalPath: normalized.canonicalPath,
            ...(normalized.relativePath !== undefined ? { relativePath: normalized.relativePath } : {}),
            ...(normalized.projectRoot !== undefined ? { projectRoot: normalized.projectRoot } : {}),
            extension: path.extname(filePath).toLowerCase(),
            fileHash: hash,
            modifiedTime: stats.mtime.toISOString(),
            size: stats.size,
            chunkIndex,
            content: text,
            ...(redactions > 0 ? { redactions } : {})
          };
        })
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException)?.code;
      if (typeof code !== "string" || !RECOVERABLE_FILE_ERROR_CODES.has(code)) throw error;
      skipped.push({ path: filePath, reason: `unreadable-file: ${code}` });
    }
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

/**
 * Computes summary counts for a store.
 *
 * @param store - The store to summarise.
 * @returns Distinct indexed file count, total chunk count, and skipped count.
 */
export function summarize(store: IndexStore): IndexSummary {
  const files = new Set(store.chunks.map(chunk => chunk.canonicalPath));
  return {
    indexedFiles: files.size,
    chunks: store.chunks.length,
    skipped: store.skipped.length
  };
}

async function* walk(
  dir: string,
  base: string,
  excluded: string[],
  skipped: IndexStore["skipped"],
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // One unreadable directory (EPERM on a protected folder, EBUSY on a locked build output) used to
    // reject out of the generator and fail the whole run, persisting nothing. Record it and carry on:
    // a partial index that reports its gaps beats no index at all.
    skipped.push({ path: dir, reason: `unreadable-directory: ${(error as NodeJS.ErrnoException).code ?? String(error)}` });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // `isDirectory()` is false for a symlink or junction (readdir does not follow links), so a linked
    // directory falls through to `yield` and is then dropped by the `stats.isFile()` check in the
    // caller. That is load-bearing, not incidental: it keeps the walk inside the real subtree of the
    // root that resolveIndexRoot authorised. Do not "fix" it into following links.
    if (entry.isDirectory()) {
      // Prune before descending. Matching per file meant walking every node_modules tree in full to
      // discard it a file at a time — the dominant cost of a run over a broad root.
      if (isExcludedDirectory(path.relative(base, fullPath), excluded)) {
        skipped.push({ path: fullPath, reason: "excluded-pattern" });
        continue;
      }

      yield* walk(fullPath, base, excluded, skipped);
      continue;
    }

    yield fullPath;
  }
}
