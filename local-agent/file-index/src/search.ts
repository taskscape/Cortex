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

  if (terms.length === 0) {
    return [];
  }

  return chunks
    .map(chunk => scoreChunk(chunk, terms))
    .filter((result): result is SearchResult => result !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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
