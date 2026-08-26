import type { KnowledgeIndex, KnowledgeEntry } from '@matatbread/matbot-plugin-api';

// In-memory KnowledgeIndex for development and environments without a BGE reranker.
// Entries are held in a Map keyed by id; search scores each doc by raw term-occurrence
// count, sorts descending, then returns the top docs whose cumulative score covers 50% of
// the total — surfacing clear winners quickly without drowning results in long-tail noise.
export class LookupKnowledgeIndex implements KnowledgeIndex {
  private readonly byId = new Map<string, KnowledgeEntry>();

  /** Snapshot of all indexed entries. Mutations only via `index` — no mutable bypass. */
  get docs(): readonly KnowledgeEntry[] {
    return [...this.byId.values()];
  }

  /**
   * Enumerate all indexed entries.
   *
   * @returns An iterable over every stored knowledge entry.
   */
  entries(): Iterable<KnowledgeEntry> {
    return this.byId.values();
  }

  /**
   * Index a knowledge entry, replacing any existing entry with the same `id`.
   *
   * @param entry - The entry to store.
   * @returns Resolves when the entry has been stored.
   */
  async index(entry: KnowledgeEntry): Promise<void> {
    this.byId.set(entry.id, entry);
  }

  /**
   * Search all entries by raw case-insensitive term-occurrence count. Results are sorted
   * descending and truncated once the cumulative score covers 50% of the total, surfacing
   * clear winners without drowning in long-tail noise.
   *
   * @param terms - Terms to look for; `context` is accepted but unused by this implementation.
   * @param _signal - Abort signal (unused — search is synchronous over an in-memory map).
   * @returns The top-scoring matching entries; empty when no entry contains any term.
   */
  async search(
    terms:  Array<{ term: string; context?: string }>,
    _signal: AbortSignal,
  ): Promise<KnowledgeEntry[]> {
    const results: Array<{ entry: KnowledgeEntry; score: number }> = [];

    for (const entry of this.byId.values()) {
      const text = entry.content.toLowerCase();
      let score = 0;
      for (const { term } of terms) {
        const t = term.toLowerCase();
        if (t.length === 0) continue;
        let pos = 0;
        while ((pos = text.indexOf(t, pos)) !== -1) {
          score++;
          pos += t.length;
        }
      }
      if (score > 0) results.push({ entry, score });
    }

    results.sort((a, b) => b.score - a.score);

    const total     = results.reduce((sum, r) => sum + r.score, 0);
    const threshold = total * 0.5;
    let   cumulative = 0;
    const top: KnowledgeEntry[] = [];
    for (const { entry, score } of results) {
      top.push(entry);
      cumulative += score;
      if (cumulative >= threshold) break;
    }
    return top;
  }
}
