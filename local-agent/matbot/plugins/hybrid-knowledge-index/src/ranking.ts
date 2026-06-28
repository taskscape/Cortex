import type { KnowledgeEntry } from "./types.js";

export function mergeRankAndDeduplicate(entries: KnowledgeEntry[], limit = 12): KnowledgeEntry[] {
  const seen = new Set<string>();
  const ranked = entries
    .map(entry => ({ entry, score: score(entry) }))
    .sort((a, b) => b.score - a.score);

  const result: KnowledgeEntry[] = [];

  for (const item of ranked) {
    const key = `${item.entry.source ?? ""}:${item.entry.metadata?.path ?? ""}:${item.entry.content}`;

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
  const explicit = Number(entry.metadata?.score ?? 0);
  const sourceBoost = entry.source === "mem0" ? 2 : entry.source === "file-index" ? 1 : 0;
  return explicit + sourceBoost;
}
