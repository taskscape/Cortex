import type { IndexedChunk } from "./store.js";

/** One search hit with score, snippet, and file metadata. */
export interface SearchResult {
  /** Native absolute path of the matching file. */
  path: string;
  /** Path relative to the indexed root, when known. */
  relativePath?: string;
  /** Term-match score; content matches weigh 2, path matches 3. */
  score: number;
  /** Whitespace-collapsed excerpt around the first match. */
  snippet: string;
  /** File-level metadata for display and filtering. */
  metadata: {
    /** Lowercased file extension (including dot). */
    extension: string;
    /** ISO mtime captured at index time. */
    modifiedTime: string;
    /** Zero-based chunk position within the file. */
    chunkIndex: number;
    /** File size in bytes at index time. */
    size: number;
    /** Present when values were withheld from this chunk, so a gap in the text is explainable. */
    redactions?: number;
  };
}

/**
 * Scores every chunk against the query terms (case-insensitive substring
 * matches in content and path) and returns the top results by descending
 * score.
 *
 * @param chunks - Chunks to search.
 * @param query - Free-text query tokenised on non-word characters.
 * @param limit - Maximum number of results to return.
 * @returns Up to `limit` results sorted by descending score; empty when the
 * query has no terms or `limit` is not positive.
 */
export function searchChunks(chunks: IndexedChunk[], query: string, limit: number): SearchResult[] {
  const terms = tokenize(query);
  const wanted = Math.max(0, Math.floor(limit));

  if (terms.length === 0 || wanted === 0) {
    return [];
  }

  const top: SearchResult[] = [];
  for (const chunk of chunks) {
    const result = scoreChunk(chunk, terms);
    if (result === undefined) continue;
    if (top.length === wanted && result.score <= top[top.length - 1]!.score) continue;
    insertByDescendingScore(top, result);
    if (top.length > wanted) top.pop();
  }
  return top;
}

/**
 * Inserts a result into a list kept sorted by descending score, shifting
 * lower-scored entries right. Assumes the list is already sorted.
 *
 * @param results - The sorted accumulator list, mutated in place.
 * @param result - The result to insert.
 */
function insertByDescendingScore(results: SearchResult[], result: SearchResult): void {
  let index = results.length;
  while (index > 0 && results[index - 1]!.score < result.score) index--;
  results.splice(index, 0, result);
}

/**
 * Scores one chunk against the query terms: +2 per term found (case-insensitive
 * substring) in the chunk content, +3 per term found in the native or relative
 * path, so filename matches outrank content matches.
 *
 * @param chunk - The chunk to score.
 * @param terms - Lowercased query terms from {@link tokenize}.
 * @returns The search result with score and snippet, or undefined when no term
 * matched anything (score 0).
 */
function scoreChunk(chunk: IndexedChunk, terms: string[]): SearchResult | undefined {
  const content = chunk.content.toLowerCase();
  const pathText = `${chunk.path} ${chunk.relativePath ?? ""}`.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (content.includes(term)) {
      score += 2;
    }

    if (pathText.includes(term)) {
      score += 3;
    }
  }

  if (score === 0) {
    return undefined;
  }

  return {
    path: chunk.path,
    ...(chunk.relativePath !== undefined ? { relativePath: chunk.relativePath } : {}),
    score,
    snippet: makeSnippet(chunk.content, terms),
    metadata: {
      extension: chunk.extension,
      modifiedTime: chunk.modifiedTime,
      chunkIndex: chunk.chunkIndex,
      size: chunk.size,
      ...(chunk.redactions !== undefined ? { redactions: chunk.redactions } : {})
    }
  };
}

/**
 * Splits a query into lowercased terms, keeping word characters plus `_`, `.`,
 * `:`, `\`, and `-` so paths and identifiers stay intact.
 *
 * @param query - Raw free-text query.
 * @returns Non-empty terms, lowercased; empty when the query has none.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.:\\-]+/i)
    .map(term => term.trim())
    .filter(Boolean);
}

/**
 * Builds a whitespace-collapsed excerpt around the earliest first occurrence
 * of any term, taking up to 120 characters of lead-in and up to 280 characters
 * total context.
 *
 * @param content - The chunk text the excerpt is drawn from.
 * @param terms - Lowercased query terms from {@link tokenize}.
 * @returns The trimmed, single-spaced excerpt; centred on the chunk start when
 * no term appears (index 0 fallback).
 */
function makeSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const firstMatch = terms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatch - 120);
  const end = Math.min(content.length, firstMatch + 280);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}
