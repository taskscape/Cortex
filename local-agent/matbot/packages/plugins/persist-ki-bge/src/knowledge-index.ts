import type { KnowledgeIndex, KnowledgeEntry, Store, Vault } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

/**
 * Rethrows helper: maps a rejected vault lookup to `undefined` when the
 * secret is simply absent, so a missing reranker credential degrades
 * gracefully instead of failing the search. Any other error propagates.
 * @param e - The rejection reason from a `vault.resolve` call.
 * @returns Always `undefined`; the function exists for its control flow.
 * @throws unknown - Re-throws `e` when it is not a {@link MissingSecretError}.
 */
const ifMissing = (e: unknown): undefined => {
  if (e instanceof MissingSecretError) return undefined;
  throw e;
};

// Selection threshold for weight-coverage results: return the top-scoring entries whose
// scores together cover this fraction of the total weight, surfacing clear winners without
// long-tail noise. Tune here to widen (higher) or narrow (lower) results.
const WEIGHT_COVERAGE_THRESHOLD = 0.5;

/**
 * Selects the top-scoring entries whose cumulative scores cover a fraction
 * ({@link WEIGHT_COVERAGE_THRESHOLD}) of the total weight, surfacing clear
 * winners without long-tail noise.
 *
 * @typeParam T - Entry type being ranked.
 * @param scored - Entries with scores, assumed already sorted best-first.
 * @returns The prefix of `scored` covering the weight threshold; all entries
 *   when the total score is zero or negative.
 * @throws Never.
 */
function topByWeightCoverage<T>(scored: Array<{ entry: T; score: number }>): T[] {
  const total = scored.reduce((sum, s) => sum + s.score, 0);
  if (total <= 0) return scored.map(s => s.entry);
  const target = total * WEIGHT_COVERAGE_THRESHOLD;
  let cumulative = 0;
  const top: T[] = [];
  for (const { entry, score } of scored) {
    top.push(entry);
    cumulative += score;
    if (cumulative >= target) break;
  }
  return top;
}

/**
 * Computes a 32-bit FNV-1a hash of a string, used as the content-change
 * fingerprint for indexed entries.
 * @param s - Text to hash.
 * @returns The hash as a lowercase hex string.
 * @throws Never.
 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Normalizes a term or entity for fuzzy matching: lowercased with all
 * non-alphanumeric characters stripped, so `"Ada Lovelace"` and
 * `"ada-lovelace"` compare equal.
 * @param s - Text to normalize.
 * @returns The normalized text (possibly empty).
 * @throws Never.
 */
function normalizeAlphanum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Heading weights (H1=20, H2=10, H3=5) are 5x the body-occurrence weight of 1, so a term
// in an H2 is worth ten plain body mentions. Step 2 sees full content (the reranker only
// gets the first 1500 chars), so it can afford to count every body hit.
/**
 * Weight of a markdown heading occurrence, by heading level (H1 heaviest).
 * @param level - Heading level (1–3; anything above 3 is treated as 3).
 * @returns 20 for H1, 10 for H2, 5 otherwise.
 * @throws Never.
 */
function headingWeight(level: number): number {
  if (level === 1) return 20;
  if (level === 2) return 10;
  return 5;
}

/**
 * Counts non-overlapping occurrences of a substring in a haystack.
 * @param haystack - Text to search within.
 * @param needle - Substring to count; empty needles are not supported and
 *   would loop, so callers must pass non-empty terms.
 * @returns The number of occurrences (0 when none).
 * @throws Never.
 */
function countOccurrences(haystack: string, needle: string): number {
  let idx   = 0;
  let count = 0;
  for (;;) {
    const next = haystack.indexOf(needle, idx);
    if (next === -1) return count;
    count++;
    idx = next + needle.length;
  }
}

/**
 * Scores content against search terms: heading lines (`#`–`###`) contribute
 * their heading weight per matching term (substring match), body lines
 * contribute 1 per literal occurrence. Case-insensitive throughout.
 *
 * @param content - Entry content, matched line by line.
 * @param terms - Terms to score; each contributes per occurrence.
 * @returns The total score (0 when nothing matches).
 * @throws Never.
 */
function scoreContent(content: string, terms: Array<{ term: string }>): number {
  let score = 0;
  for (const line of content.split('\n')) {
    const m = /^(#{1,3})(?!#)\s+(.+)/.exec(line);
    if (m) {
      const level   = m[1]!.length;
      const heading = m[2]!.toLowerCase();
      for (const { term } of terms) {
        if (heading.includes(term.toLowerCase())) score += headingWeight(level);
      }
    } else {
      const lower = line.toLowerCase();
      for (const { term } of terms) {
        score += countOccurrences(lower, term.toLowerCase());
      }
    }
  }
  return score;
}

/**
 * A `Store<KnowledgeEntry>`-backed `KnowledgeIndex` with an optional Cloudflare BGE reranker.
 * Search proceeds in three steps: exact entity match, content-weighted scoring (headings weighted
 * above body), then BGE reranking when scores are close. Missing reranker credentials degrade
 * gracefully; HTTP/auth failures are warned about and also fall back to local scoring.
 */
export class PersistBGEKnowledgeIndex implements KnowledgeIndex {
  private readonly store: Store<KnowledgeEntry>;
  private readonly vault: Vault;

  /**
   * Creates the index over a persistent store with vault-provided reranker
   * credentials. Reads go through the store proxy, so it follows live
   * `KnowledgeIndex`-store swaps; nothing is cached at construction.
   *
   * @param store The `knowledge` store holding entries.
   * @param vault Vault for reranker credentials (`SKILL_RANK_API_KEY`,
   *   `CLOUDFLARE_ACCOUNT_ID`); missing secrets degrade to local scoring.
   */
  constructor(store: Store<KnowledgeEntry>, vault: Vault) {
    this.store = store;
    this.vault = vault;
  }

  /**
   * Add or update an entry in the index. Writes only when the content hash changed.
   * @param entry The entry to index (its `contentHash` is computed here).
   * @returns Nothing; the store is written only when the content actually changed.
   * @throws Error - If the store read or write fails.
   */
  async index(entry: KnowledgeEntry): Promise<void> {
    const hash     = fnv1a(entry.content);
    const existing = await this.store.get(entry.id);
    if (existing?.contentHash === hash) return;
    await this.store.set(entry.id, { ...entry, contentHash: hash });
  }

  /**
   * Search indexed entries. Step 1 returns an unambiguous alphanum-normalised entity match;
   * step 2 scores headings (H1=20/H2=10/H3=5) plus body occurrences; step 3 disambiguates via
   * the Cloudflare BGE reranker when scores are close, falling back to local ranking when
   * credentials are missing or the service fails.
   *
    * @param terms Search terms with optional context.
    * @param signal Abort signal forwarded to the reranker request.
    * @returns Matching entries, best first. Possible outcomes: a single
    *   unambiguous entity match; the top content score when it clearly wins;
    *   the BGE-reranked best entries; or the fallback winner when reranking
    *   is unavailable.
    * @throws Error - If the store query fails, the reranker HTTP request
    *   rejects (network failure), or the vault raises an error other than
    *   {@link MissingSecretError}. Reranker auth/quota failures do not throw —
    *   they warn and fall back to local ranking.
    * @throws DOMException - If `signal` aborts or the reranker's built-in 15s
    *   timeout fires.
    */
  async search(
    terms:  Array<{ term: string; context?: string }>,
    signal: AbortSignal,
  ): Promise<KnowledgeEntry[]> {
    const { items: all } = await this.store.query({});
    if (terms.length === 0 || all.length === 0) return [];

    // Step 1: alphanum-normalised entity match — single hit wins immediately
    const nameMatches = all.filter(entry =>
      terms.some(({ term }) => {
        const normTerm = normalizeAlphanum(term);
        return entry.entities.some(e => {
          const normEntity = normalizeAlphanum(e);
          return normEntity.includes(normTerm) || normTerm.includes(normEntity);
        });
      }),
    );

    if (nameMatches.length === 1) return nameMatches;

    // Step 2: content-weighted score — headings H1=20/H2=10/H3=5, plus 1 per body occurrence
    const candidatePool = nameMatches.length > 1 ? nameMatches : all;
    const scored = candidatePool
      .map(entry => ({ entry, score: scoreContent(entry.content, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    const [first, second] = scored;
    if (first !== undefined && (second === undefined || first.score >= second.score * 2)) {
      return [first.entry];
    }

    // Step 3: BGE reranker via Cloudflare Workers AI
    const apiKey    = await this.vault.resolve('${SKILL_RANK_API_KEY}').catch(ifMissing);
    const accountId = await this.vault.resolve('${CLOUDFLARE_ACCOUNT_ID}').catch(ifMissing);
    const rerankPool = scored.length > 0 ? scored.map(s => s.entry) : candidatePool;

    if (!apiKey || !accountId || rerankPool.length === 0) {
      return first ? [first.entry] : [];
    }

    const query    = terms.map(t => t.term).join(', ');
    const contexts = rerankPool.map(e => ({
      text: `${e.entities[0] ?? e.id}\n${e.content.slice(0, 1500)}`,
    }));

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-reranker-base`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body:   JSON.stringify({ query, contexts }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      },
    );

    // Surface auth/quota failures: the reranker otherwise degrades silently to heading
    // scoring, making a bad/expired token impossible to distinguish from "search got worse".
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.warn(
        `[persist-ki-bge] BGE reranker HTTP ${response.status}: ${detail.slice(0, 300)} — ` +
        `check SKILL_RANK_API_KEY / CLOUDFLARE_ACCOUNT_ID. Falling back to heading scoring.`,
      );
      return first ? [first.entry] : [];
    }

    type RerankResult = {
      success:  boolean;
      errors:   Array<unknown>;
      messages: Array<unknown>;
      result:   { response: Array<{ id: number; score: number }> };
    };
    let ranking: RerankResult | undefined;
    try {
      ranking = await response.json() as RerankResult;
    } catch { /* non-JSON body (e.g. an error page served with 200) */ }
    if (!ranking?.success) {
      console.warn(
        `[persist-ki-bge] BGE reranker returned ${ranking === undefined ? 'a non-JSON body' : 'success:false'}: ` +
        `${ranking === undefined ? '' : JSON.stringify(ranking.errors).slice(0, 300)}. Falling back to heading scoring.`,
      );
      return first ? [first.entry] : [];
    }
    const ranked = ranking.success
      ? ranking.result.response
          .slice()
          .sort((a, b) => b.score - a.score)
          .filter(r => r.id < rerankPool.length)
          .map(r => ({ entry: rerankPool[r.id]!, score: r.score }))
      : [];

    if (ranked.length === 0) {
      return first ? [first.entry] : [];
    }
    return topByWeightCoverage(ranked);
  }
}