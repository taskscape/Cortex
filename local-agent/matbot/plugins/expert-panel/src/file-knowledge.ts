import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ExpertConfig, ExpertSource } from "./types.js";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml"
]);

const MAX_FILE_BYTES = 1_000_000;
const MANIFEST_TTL_MS = 5_000;
const FILE_READ_CONCURRENCY = 8;

/** Size/mtime fingerprint of one knowledge file, used to validate cache freshness. */
interface ExpertFileMetadata {
  path: string;
  size: number;
  mtimeMs: number;
}

/** A cached file's metadata plus its trimmed context text and lowercase scoring haystack. */
interface CachedExpertFile extends ExpertFileMetadata {
  contextContent: string;
  haystack: string;
}

/** Search outcome including non-fatal diagnostics for unreadable or skipped files. */
export interface ExpertKnowledgeSearchResult {
  sources: ExpertSource[];
  warnings: string[];
}

/**
 * Term-frequency knowledge search over an expert's configured file roots. Text files
 * (known extensions, ≤1 MB) are walked, cached by size/mtime with a short manifest TTL,
 * scored against tokenized queries, and returned as ranked `ExpertSource`s.
 */
export class FileExpertKnowledge {
  private readonly expert: ExpertConfig;
  private readonly cache = new Map<string, CachedExpertFile>();
  private manifest: ExpertFileMetadata[] = [];
  private manifestWarnings: string[] = [];
  private manifestExpiresAt = 0;

  /**
   * Creates a knowledge instance bound to one expert's configured roots.
   * @param expert The expert whose knowledge roots are searched.
   */
  constructor(expert: ExpertConfig) {
    this.expert = expert;
  }

  /**
   * Search the expert's knowledge files and return only the ranked sources.
   * @param query Free-text query to tokenize and score against file contents.
   * @param limit Maximum number of sources to return.
   * @param signal Cancellation signal; aborts throw through to the caller.
   * @returns Ranked matching sources, highest score first.
   * @throws When the signal is aborted.
   */
  async search(query: string, limit: number, signal: AbortSignal): Promise<ExpertSource[]> {
    return (await this.searchWithDiagnostics(query, limit, signal)).sources;
  }

  /**
   * Search the expert's knowledge files, also reporting non-fatal warnings
   * (unreadable files, inaccessible roots, oversized skips).
   * @param query Free-text query to tokenize and score against file contents.
   * @param limit Maximum number of sources to return.
   * @param signal Cancellation signal; aborts throw through to the caller.
   * @returns Ranked sources plus collected warnings.
   * @throws When the signal is aborted.
   */
  async searchWithDiagnostics(query: string, limit: number, signal: AbortSignal): Promise<ExpertKnowledgeSearchResult> {
    const { files, warnings } = await this.listFiles(signal);
    const terms = tokenize(query);
    const sources = await mapWithConcurrency(files, FILE_READ_CONCURRENCY, async file => {
      signal.throwIfAborted();
      const cached = await this.readCached(file, signal).catch(error => {
        signal.throwIfAborted();
        warnings.push(`Expert "${this.expert.id}" could not read knowledge file: ${file.path}`);
        return undefined;
      });
      if (cached === undefined) return undefined;
      const score = scoreContent(cached.haystack, terms);
      if (score <= 0 && terms.length > 0) {
        return undefined;
      }

      return {
        id: stableId(`${this.expert.id}:${file.path}`),
        expertId: this.expert.id,
        path: file.path,
        title: path.basename(file.path),
        content: cached.contextContent,
        score
      } satisfies ExpertSource;
    });

    return {
      sources: sources
      .filter((source): source is ExpertSource => source !== undefined)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit),
      warnings: unique(warnings)
    };
  }

  /**
   * Return the current file manifest, honoring the short TTL cache. Within the TTL the
   * cached manifest is reused after re-verifying that all roots are still accessible;
   * if a root became inaccessible the cache is dropped and an empty manifest with the
   * root warnings is returned. Past the TTL the roots are re-walked and cache entries
   * for files that no longer exist are evicted.
   * @param signal Cancellation signal.
   * @returns Knowledge file candidates plus non-fatal warnings (inaccessible roots,
   *          oversized skips).
   * @throws When the signal is aborted.
   */
  private async listFiles(signal: AbortSignal): Promise<{ files: ExpertFileMetadata[]; warnings: string[] }> {
    if (Date.now() < this.manifestExpiresAt) {
      const rootWarnings = await inaccessibleRootWarnings(this.expert, signal);
      if (rootWarnings.length === 0) {
        return { files: this.manifest, warnings: this.manifestWarnings };
      }
      this.cache.clear();
      this.manifest = [];
      this.manifestWarnings = rootWarnings;
      this.manifestExpiresAt = 0;
      return { files: [], warnings: rootWarnings };
    }
    const { files, warnings } = await listTextFiles(this.expert, signal);
    const livePaths = new Set(files.map(file => file.path));
    for (const cachedPath of this.cache.keys()) {
      if (!livePaths.has(cachedPath)) this.cache.delete(cachedPath);
    }
    this.manifest = files;
    this.manifestWarnings = warnings;
    this.manifestExpiresAt = Date.now() + MANIFEST_TTL_MS;
    return { files, warnings };
  }

  /**
   * Read a file's text, serving from the in-memory cache while size and mtime are
   * unchanged. Fresh reads populate the cache with the trimmed context text and a
   * lowercase `path + content` haystack used for scoring.
   * @param file Manifest entry to read.
   * @param signal Cancellation signal propagated to the file read.
   * @returns The cached or freshly read file content.
   * @throws A file-system error when the file cannot be read, including abort errors.
   */
  private async readCached(file: ExpertFileMetadata, signal: AbortSignal): Promise<CachedExpertFile> {
    const cached = this.cache.get(file.path);
    if (cached?.size === file.size && cached.mtimeMs === file.mtimeMs) return cached;
    const content = await readFile(file.path, { encoding: "utf8", signal });
    const next: CachedExpertFile = {
      ...file,
      contextContent: trimForContext(content),
      haystack: `${file.path}\n${content}`.toLowerCase(),
    };
    this.cache.set(file.path, next);
    return next;
  }
}

/**
 * Walk every knowledge root of the expert and collect text-file candidates.
 * @param expert Expert whose roots are walked.
 * @param signal Cancellation signal checked between entries.
 * @returns Candidate files plus warnings for inaccessible roots and oversized files.
 * @throws A file-system error when a directory cannot be read; abort errors when the
 *         signal fires.
 */
async function listTextFiles(expert: ExpertConfig, signal: AbortSignal): Promise<{
  files: ExpertFileMetadata[];
  warnings: string[];
}> {
  const files: ExpertFileMetadata[] = [];
  const warnings: string[] = [];

  for (const root of expert.roots) {
    await walk(root, files, warnings, signal, expert.id, true);
  }

  return { files, warnings };
}

/**
 * Probe each knowledge root with `stat`, collecting a warning for every root that
 * cannot be accessed.
 * @param expert Expert whose roots are probed.
 * @param signal Cancellation signal.
 * @returns One warning per inaccessible root, in root order.
 * @throws When the signal is aborted.
 */
async function inaccessibleRootWarnings(expert: ExpertConfig, signal: AbortSignal): Promise<string[]> {
  const warnings: string[] = [];
  for (const root of expert.roots) {
    signal.throwIfAborted();
    await stat(root).catch(() => {
      warnings.push(`Expert "${expert.id}" knowledge root is inaccessible: ${root}`);
    });
  }
  return warnings;
}

/**
 * Recursively collect candidate files under `target`, skipping dot-directories,
 * `node_modules`, and text files over {@link MAX_FILE_BYTES}. Non-root stat failures
 * are silently ignored; root failures add a warning.
 * @param target File or directory to walk.
 * @param files Accumulator receiving candidate file metadata.
 * @param warnings Accumulator receiving non-fatal diagnostics.
 * @param signal Cancellation signal.
 * @param expertId Expert id used in warning messages.
 * @param root True when `target` is a configured knowledge root (root stat failures
 *        are reported rather than ignored).
 * @throws A file-system error when a directory cannot be read; abort errors when the
 *         signal fires.
 */
async function walk(
  target: string,
  files: ExpertFileMetadata[],
  warnings: string[],
  signal: AbortSignal,
  expertId: string,
  root = false,
): Promise<void> {
  signal.throwIfAborted();

  let info;
  try {
    info = await stat(target);
  } catch {
    if (root) warnings.push(`Expert "${expertId}" knowledge root is inaccessible: ${target}`);
    return;
  }

  if (info.isFile()) {
    if (isTextFile(target) && info.size <= MAX_FILE_BYTES) {
      files.push({ path: target, size: info.size, mtimeMs: info.mtimeMs });
    } else if (isTextFile(target)) {
      warnings.push(`Expert "${expertId}" skipped oversized knowledge file (${info.size} bytes): ${target}`);
    }
    return;
  }

  if (!info.isDirectory()) {
    return;
  }

  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    await walk(path.join(target, entry.name), files, warnings, signal, expertId);
  }
}

/**
 * Check a file's extension against the known text-file set.
 * @param file File path to inspect.
 * @returns True when the extension is a recognized text extension (case-insensitive).
 * @throws Never.
 */
function isTextFile(file: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Extract unique lowercase search tokens of 3+ characters (letters, digits, underscore,
 * hyphen; includes Polish diacritics) from free text, in first-occurrence order.
 * @param text Free-text query to tokenize.
 * @returns Unique tokens.
 * @throws Never.
 */
function tokenize(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9_ąćęłńóśźż-]{3,}/gi) ?? []) {
    seen.add(raw);
  }
  return [...seen];
}

/**
 * Score a lowercase haystack against query terms by counting whole-word matches per
 * term. An empty term list scores 1 so files are still returned when the query has no
 * usable tokens.
 * @param haystack Lowercase `path + content` text to search.
 * @param terms Tokenized query terms (already lowercase).
 * @returns Total whole-word match count, or 1 for an empty term list.
 * @throws Never.
 */
function scoreContent(haystack: string, terms: string[]): number {
  if (terms.length === 0) {
    return 1;
  }

  let score = 0;

  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = haystack.match(new RegExp(`\\b${escaped}\\b`, "g"));
    score += matches?.length ?? 0;
  }

  return score;
}

/**
 * Map `worker` over `items` with at most `concurrency` in-flight promises, preserving
 * input order in the results. A worker rejection rejects the whole operation.
 * @typeParam T Input item type.
 * @typeParam R Worker result type.
 * @param items Items to process.
 * @param concurrency Maximum parallel workers (capped at `items.length`).
 * @param worker Async worker applied to each item.
 * @returns Results indexed like `items`.
 * @throws Whatever `worker` throws; the first rejection propagates.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
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

/**
 * Normalize line endings to `\n`, trim, and cap content at 6000 characters, appending
 * a `[truncated]` marker when cut.
 * @param content Raw file content.
 * @returns Context-safe text capped at 6000 characters plus a truncation marker when cut.
 * @throws Never.
 */
function trimForContext(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  return normalized.length <= 6_000 ? normalized : `${normalized.slice(0, 6_000)}\n\n[truncated]`;
}

/**
 * Derive a stable short identifier from arbitrary text.
 * @param input Text to hash.
 * @returns First 16 hex characters of the SHA-256 digest.
 * @throws Never.
 */
function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Deduplicate strings, preserving first-occurrence order.
 * @param values Values to deduplicate.
 * @returns Unique values in first-occurrence order.
 * @throws Never.
 */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}
