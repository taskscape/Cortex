import type { MatbotMachine, Store } from '@matatbread/matbot-plugin-api';
interface SearchTerm {
    term: string;
    context?: string;
}
interface RememberedFact {
    id: string;
    version: string;
    fact: string;
    sessionId: string;
    messageId: string;
    createdAt: string;
    dreamSkill?: string;
    ignoreUntil?: string;
}
export interface RememberedFactMatch {
    fact: RememberedFact;
    score: number;
}
interface WorkspaceRagHit {
    contextName: string;
    path: string;
    score: number;
    text: string;
}
interface WorkspaceRagManagerLike {
    searchCurrent(query: string, limit: number, signal: AbortSignal): Promise<WorkspaceRagHit[]>;
}
// Weighted share of a fact the query must account for before the fact is considered a match. Low
// enough that one rare token ("HELIOS-7") carries a fact on its own — so a fact stays reachable
// through a shared proper noun even when the question is asked in another language. General
// vocabulary does not survive that switch: matching here is lexical, and a Polish question about an
// English fact has nothing to match on. Semantic recall is the KnowledgeIndex's job, not this one's.
const FACT_MATCH_THRESHOLD = 0.35;
const MAX_FACT_MATCHES = 5;
const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does', 'for', 'from',
    'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
    'our', 'please', 'tell', 'that', 'the', 'their', 'this', 'to', 'what', 'when',
    'where', 'which', 'who', 'why', 'with', 'you', 'your',
]);
// Diacritics are folded before tokenising, because the token pattern below is ASCII: without this
// "są" tokenises to "s" and "wspólnotowym" splits into "wsp" + "lnotowym", so a Polish question can
// never match a Polish fact. Both the query and the stored fact go through here, so folding is
// symmetric. (ł has no canonical decomposition, hence the explicit pair.)
function foldDiacritics(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
}
function normaliseText(text: string): string {
    return foldDiacritics(text.toLowerCase()).replace(/\b(user|users|user's|my|mine|me)\b/g, ' user ');
}
// Tokens are truncated to a stem so an inflected form matches the form the fact was stored in —
// "serwerze"/"serwer"/"serwerowni" all collapse to "serwe". Heavily inflected languages (the user's
// Polish, here) are otherwise unmatchable by token equality, and a stemmer for every language the user
// might type in is not a thing this can carry. Five characters is the compromise: long enough that
// unrelated words rarely collide, short enough to absorb a case ending.
const STEM_LENGTH = 5;
function tokens(text: string): string[] {
    return [...new Set((normaliseText(text).match(/[a-z0-9]+/g) ?? [])
            .filter(t => t.length > 1 && !STOPWORDS.has(t))
            .map(t => t.slice(0, STEM_LENGTH)))];
}
function queryText(terms: readonly SearchTerm[]): string {
    return terms.map(item => item.context ? `${item.term} ${item.context}` : item.term).join(' ');
}
/** Token statistics over the whole fact store: how informative each token is, and which tokens are
 *  identifier-like — belonging to a single fact (a name, a server id) rather than being vocabulary. */
interface FactIndex {
    weight(token: string): number;
    isDistinctive(token: string): boolean;
    isKnown(token: string): boolean;
}
// Rare tokens ("helios", "zagozda") carry the identity of a fact; common ones ("user", "name") barely
// narrow anything. Smoothed so a single-fact store yields a uniform weight rather than a negative log.
//
// Note: query tokens that appear in NO fact are intentionally ignored later (see `queryWeightOf`) so
// recall does not depend on how much unrelated padding surrounds the token that matters.
function indexFacts(facts: readonly RememberedFact[]): FactIndex {
    const documentFrequency = new Map<string, number>();
    for (const fact of facts) {
        for (const token of tokens(fact.fact))
            documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    return {
        weight: token => Math.log((facts.length + 1) / (1 + (documentFrequency.get(token) ?? 0))) + 1,
        isKnown: token => documentFrequency.has(token),
        // Rarity alone is not identity. In a store of a few facts almost every token appears exactly
        // once, so a function word the stopword list doesn't cover — `się`, `jest`, anything outside
        // English — looks as unique as a server name, and a one-word coincidence with a long note scores
        // as a perfect match. Requiring the full stem length separates content from function words
        // without needing a stopword list per language: function words are short, identifiers are not.
        isDistinctive: token => (documentFrequency.get(token) ?? 0) <= 1 && token.length >= STEM_LENGTH,
    };
}
/**
 * Weighted overlap between a query and one fact, as the better of two views:
 *
 *  - how much of the FACT the query accounts for — the view that lets a whole user message be used as
 *    the query (the injection hook) without a long question diluting the score, since the denominator
 *    belongs to the fact;
 *  - how much of the QUERY the fact accounts for — the view that keeps a long pasted fact reachable,
 *    which fact-coverage alone cannot do (a 100-token note can never be "covered" by a six-word
 *    question).
 *
 * Both are weighted by discriminating power, so matching only shared vocabulary scores low while a
 * single rare token can carry a fact on its own. The guard rejects one-token coincidences unless that
 * token is unique to the fact.
 *
 * The query side counts only tokens some fact actually uses (see `queryWeightOf`): a fact is not
 * penalised for failing to explain words that NO fact explains. Without that, whether "HELIOS-7"
 * retrieves its fact would depend on how many ordinary words happened to surround it in the question.
 */
function scoreFact(fact: string, queryTokens: ReadonlySet<string>, queryWeight: number, index: FactIndex): number {
    if (queryTokens.size === 0)
        return 0;
    let factWeight = 0;
    let hitWeight = 0;
    let hits = 0;
    let distinctive = false;
    for (const token of tokens(fact)) {
        const weight = index.weight(token);
        factWeight += weight;
        if (!queryTokens.has(token))
            continue;
        hitWeight += weight;
        hits += 1;
        if (index.isDistinctive(token))
            distinctive = true;
    }
    if (factWeight === 0 || queryWeight === 0)
        return 0;
    if (hits < 2 && !distinctive)
        return 0;
    return Math.max(hitWeight / factWeight, hitWeight / queryWeight);
}
// Query tokens no fact uses are dropped rather than counted as unexplained: they carry no evidence
// either way, and letting them inflate the denominator makes recall depend on sentence padding. A
// query with nothing in common with the store weighs 0, which scores every fact 0.
function queryWeightOf(queryTokens: ReadonlySet<string>, index: FactIndex): number {
    let total = 0;
    for (const token of queryTokens)
        if (index.isKnown(token))
            total += index.weight(token);
    return total;
}
// Facts written through `remembered_facts_action` may carry no parseable timestamp; an unparseable one
// sorts oldest instead of poisoning the comparator with NaN.
function createdAtMs(fact: RememberedFact): number {
    const parsed = Date.parse(fact.createdAt ?? '');
    return Number.isNaN(parsed) ? 0 : parsed;
}
async function fetchAllRememberedFacts(store: Store<RememberedFact>): Promise<RememberedFact[]> {
    const out: RememberedFact[] = [];
    let cursor: string | undefined;
    do {
        const page = await store.query(cursor !== undefined ? { cursor } : {});
        out.push(...page.items);
        cursor = page.cursor;
    } while (cursor !== undefined);
    return out;
}
/**
 * Lexically scores every remembered fact against the search terms and returns
 * the top matches above the threshold, deduplicated and newest-first among ties.
 * @param services - Runtime machine (used to open the fact store).
 * @param terms - Search terms with optional context phrases.
 * @returns Matching facts with their scores (at most five).
 */
export async function searchRememberedFacts(services: MatbotMachine, terms: readonly SearchTerm[]): Promise<RememberedFactMatch[]> {
    const store = services.createStore<RememberedFact>('remembered_facts');
    const facts = await fetchAllRememberedFacts(store);
    const index = indexFacts(facts);
    const queryTokens = new Set(tokens(queryText(terms)));
    const queryWeight = queryWeightOf(queryTokens, index);
    const seen = new Set<string>();
    return facts
        .map(fact => ({ fact, score: scoreFact(fact.fact, queryTokens, queryWeight, index) }))
        .filter(match => match.score >= FACT_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score || createdAtMs(b.fact) - createdAtMs(a.fact))
        .filter(match => {
        const key = factDedupeKey(match.fact.fact);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    })
        .slice(0, MAX_FACT_MATCHES);
}
export function factDedupeKey(fact: string): string { return normaliseText(fact).replace(/[^a-z0-9]+/g, ' ').trim(); }
