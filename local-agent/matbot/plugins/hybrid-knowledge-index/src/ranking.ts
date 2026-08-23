import type { KnowledgeEntry } from "./types.js";

/**
 * Rank entries by confidence (plus a source-type boost for mem0/file-index) and
 * drop duplicates by source type + uuid + content hash.
 * @param entries Candidate entries from one or more backends.
 * @param limit Maximum number of entries to return; defaults to 12.
 * @returns Up to `limit` highest-scored, deduplicated entries, best first.
 */
export function mergeRankAndDeduplicate(entries: KnowledgeEntry[], limit = 12): KnowledgeEntry[] {
  const seen = new Set<string>();
  const ranked = entries
    .map(entry => ({ entry, score: score(entry) }))
    .sort((a, b) => b.score - a.score);

  const result: KnowledgeEntry[] = [];

  for (const item of ranked) {
    const key = `${item.entry.source.type}:${item.entry.source.uuid}:${item.entry.contentHash ?? item.entry.content}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item.entry);

    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function score(entry: KnowledgeEntry): number {
  const explicit = Number(entry.confidence ?? 0);
  const sourceBoost = entry.source.type === "mem0" ? 2 : entry.source.type === "file-index" ? 1 : 0;
  return explicit + sourceBoost;
}
