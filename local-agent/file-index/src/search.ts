import type { IndexedChunk } from "./store.js";

export interface SearchResult {
  path: string;
  relativePath?: string;
  score: number;
  snippet: string;
  metadata: {
    extension: string;
    modifiedTime: string;
    chunkIndex: number;
    size: number;
  };
}

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

function insertByDescendingScore(results: SearchResult[], result: SearchResult): void {
  let index = results.length;
  while (index > 0 && results[index - 1]!.score < result.score) index--;
  results.splice(index, 0, result);
}

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
    relativePath: chunk.relativePath,
    score,
    snippet: makeSnippet(chunk.content, terms),
    metadata: {
      extension: chunk.extension,
      modifiedTime: chunk.modifiedTime,
      chunkIndex: chunk.chunkIndex,
      size: chunk.size
    }
  };
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.:\\-]+/i)
    .map(term => term.trim())
    .filter(Boolean);
}

function makeSnippet(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const firstMatch = terms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatch - 120);
  const end = Math.min(content.length, firstMatch + 280);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}
