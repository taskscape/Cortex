import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolExecutor, ToolContext, ToolEvent, KnowledgeEntry, Store, Hook, Message } from '@matatbread/matbot-plugin-api';

interface SearchTerm {
  term: string;
  context?: string;
}

interface RememberedFact {
  id:           string;
  version:      string;
  fact:         string;
  sessionId:    string;
  messageId:    string;
  createdAt:    string;
  dreamSkill?:  string;
  ignoreUntil?: string;
}

interface RememberedFactMatch {
  fact:  RememberedFact;
  score: number;
}

interface WorkspaceRagHit {
  contextName: string;
  path:        string;
  score:       number;
  text:        string;
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
const MAX_FACT_MATCHES     = 5;

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
  weight(token: string):        number;
  isDistinctive(token: string): boolean;
  isKnown(token: string):       boolean;
}

// Rare tokens ("helios", "zagozda") carry the identity of a fact; common ones ("user", "name") barely
// narrow anything. Smoothed so a single-fact store yields a uniform weight rather than a negative log.
//
// Note: query tokens that appear in NO fact are intentionally ignored later (see `queryWeightOf`) so
// recall does not depend on how much unrelated padding surrounds the token that matters.
  const documentFrequency = new Map<string, number>();
  for (const fact of facts) {
    for (const token of tokens(fact.fact)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  return {
    weight:  token => Math.log((facts.length + 1) / (1 + (documentFrequency.get(token) ?? 0))) + 1,
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
  if (queryTokens.size === 0) return 0;
  let factWeight  = 0;
  let hitWeight   = 0;
  let hits        = 0;
  let distinctive = false;
  for (const token of tokens(fact)) {
    const weight = index.weight(token);
    factWeight += weight;
    if (!queryTokens.has(token)) continue;
    hitWeight += weight;
    hits      += 1;
    if (index.isDistinctive(token)) distinctive = true;
  }
  if (factWeight === 0 || queryWeight === 0) return 0;
  if (hits < 2 && !distinctive) return 0;
  return Math.max(hitWeight / factWeight, hitWeight / queryWeight);
}

// Query tokens no fact uses are dropped rather than counted as unexplained: they carry no evidence
// either way, and letting them inflate the denominator makes recall depend on sentence padding. A
// query with nothing in common with the store weighs 0, which scores every fact 0.
function queryWeightOf(queryTokens: ReadonlySet<string>, index: FactIndex): number {
  let total = 0;
  for (const token of queryTokens) if (index.isKnown(token)) total += index.weight(token);
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

export async function searchRememberedFacts(
  services: MatbotMachine,
  terms: readonly SearchTerm[],
): Promise<RememberedFactMatch[]> {
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
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_FACT_MATCHES);
}

function rememberedFactsContent(matches: readonly RememberedFactMatch[]): string {
  return ['Remembered facts:', ...matches.map(match => `- ${match.fact.fact}`)].join('\n');
}

function workspaceRagContent(hits: readonly WorkspaceRagHit[]): string {
  return [
    `Workspace RAG results${hits[0]?.contextName ? ` (${hits[0].contextName})` : ''}:`,
    ...hits.map((hit, index) => [
      `- Source ${index + 1}: ${hit.path} (score ${hit.score.toFixed(3)})`,
      hit.text,
    ].join('\n')),
  ].join('\n\n');
}

function combinedContent(
  remembered: readonly RememberedFactMatch[],
  best: KnowledgeEntry | undefined,
  workspaceRag: readonly WorkspaceRagHit[] = [],
): string {
  const parts = remembered.length > 0 ? [rememberedFactsContent(remembered)] : [];
  if (best !== undefined) {
    parts.push(`Knowledge index result (${knowledgeName(best)}):\n${best.content}`);
  }
  if (workspaceRag.length > 0) parts.push(workspaceRagContent(workspaceRag));
  return parts.join('\n\n');
}

function knowledgeName(entry: KnowledgeEntry): string {
  return entry.entities[0] ?? entry.id;
}

function factDedupeKey(fact: string): string {
  return normaliseText(fact).replace(/[^a-z0-9]+/g, ' ').trim();
}

function textOf(msg: Message | undefined): string {
  return msg?.content.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
}

// Marks the injected block as system-supplied, so the model doesn't read remembered facts as the user
// having just said them. (Deliberately a local copy of the same framing `triggers` applies to its own
// injections: same idea, no dependency between two plugins that don't otherwise know about each other.)
function fence(body: string): string {
  return '[Recalled from durable memory — supplied by the system, not part of the user\'s message. ' +
    `Use it if relevant; ignore it if not.]\n\n${body}\n\n[End of recalled memory.]`;
}

/**
 * The recall half of memory, as a resident hook rather than a tool the model must elect to call.
 *
 * `contextual_search` can only retrieve a fact once the model has already decided it is missing
 * context — which is precisely the judgement a model cannot make about a name or a server it has no
 * reason to suspect exists. So every turn's user message is scored against the fact store directly
 * (locally — no LLM call, no added latency) and matches ride in as `ephemeral` context. The tool stays
 * registered for deliberate mid-turn lookups; this is what makes a *new conversation* start knowing
 * what earlier ones established.
 */
export function createMemoryInjectionHook(services: MatbotMachine): Hook {
  return {
    on: 'screen',
    async handler(ctx) {
      const lastUser = ctx.session.messages.findLast(m =>
        m.role === 'user' && !m.content.every(c => c.origin === 'robo'));
      const text = textOf(lastUser);
      if (text.trim() === '') return;

      const matches = await searchRememberedFacts(services, [{ term: text }]);
      if (matches.length === 0) return;

      return {
        ephemeral: [{ type: 'text', text: fence(rememberedFactsContent(matches)) }],
        // The injected text is never otherwise persisted, so without this a post-mortem can't tell
        // whether the model answered from memory or in spite of it.
        markers: [{
          type:    'marker',
          creator: 'rumsfeld',
          data:    { event: 'memory-inject', facts: matches.map(m => ({ id: m.fact.id, score: Number(m.score.toFixed(3)) })) },
        }],
      };
    },
  };
}

export function createRumsfeldPlugin(): MatbotPluginSpec {
  return {
    apiVersion: PLUGIN_API_VERSION,

    async setup(services: MatbotMachine) {
      const executor: ToolExecutor = {
        async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
          const { terms } = input as { terms: SearchTerm[] };

          if (terms.length === 0) {
            yield { type: 'error', message: 'No search terms provided.' };
            return;
          }

          const [knowledgeResult, rememberedResult] = await Promise.allSettled([
            services.KnowledgeIndex.search(terms, ctx.signal),
            searchRememberedFacts(services, terms),
          ]);
          const results = knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : [];
          const remembered = rememberedResult.status === 'fulfilled' ? rememberedResult.value : [];
          const workspaceRagManager = services.get('WorkspaceRagManager' as never) as WorkspaceRagManagerLike | undefined;
          const workspaceRag = workspaceRagManager !== undefined
            ? await workspaceRagManager.searchCurrent(queryText(terms), 5, ctx.signal).catch(() => [])
            : [];

          if (remembered.length > 0) {
            yield { type: 'result', value: { name: 'remembered_facts', content: combinedContent(remembered, results[0], workspaceRag) } };
            return;
          }

          if (results.length === 0 && workspaceRag.length === 0) {
            yield { type: 'error', message: 'There is no skill available for the requested operation.' };
            return;
          }

          if (workspaceRag.length > 0) {
            yield { type: 'result', value: { name: 'workspace_rag', content: combinedContent([], results[0], workspaceRag) } };
            return;
          }

          const best = results[0]!;
          yield { type: 'result', value: { name: knowledgeName(best), content: best.content } };
        },
      };

      services.tools.register({
        name:        'contextual_search',
        description: `Load context for an unknown concept, system, term, or entity.

      Examples:
        - Is <unknown> currently working?
        - Tell me about <unknown>'s <unknown>.
        - Use your skill about <unknown>.
        - <unknown> said to <unknown> that <unknown> is broken.
        - The <unknown> is arriving for <unknown>'s birthday.

      Use when you encounter an "unknown" concept, system, term, entity, person or domain you lack specific context about — a named system you haven't
      been trained on, user-specific preferences, personal information, a specialised topic or other subject the user assumes you know about.

      Use this tool early and as a higher priority than external searches as it is more likely to yield domain specific results than a general search.
      Use this tool in preference to guessing, hallucinating, confabulating or making assumptions about what the unknown term might refer to.
      Only ask for more information about the unknown term if you have already tried to find context using the term as a search query, and that search did not return any relevant results.

      Markers of "unknown" terms are:
      - use of definite articles, demonstratives or possessives ("the", "my", "his", "that", "Fred's") even if the noun is common, for example "my Volvo" isn't a reference to Volvo's in general, it's about the user's specific car which they assume you have information about.
      - words that are clearly novel proper nouns or nouns used in a non-standard or domain-specific way, for example "the Xmit system" or "What does Xmit say?".
      - when the user directly uses the term 'skill' in their query, for example "Use your skill about <unknown> to do <unknown>".

      List one or more unknown terms you need more information about (without any qualifiers, demonstratives or possessives), together with the contextual phrase or sentence they were mentioned in.
      If the qualifiers are specific, for example "Fred's car", include "Fred" and "car" as separate terms.`,
        inputSchema: {
          type:     'object',
          required: ['terms'],
          properties: {
            terms: {
              type:  'array',
              items: {
                type:        'object',
                properties:  {
                  term:    { type: 'string' },
                  context: { type: 'string' },
                },
                description: 'A list of unknown concepts, systems, terms, entities or domains and their immediate context.',
              },
            },
          },
        },
        executor,
      });

      services.hooks.register(createMemoryInjectionHook(services));
    },
  };
}

export const plugin: MatbotPluginSpec = createRumsfeldPlugin();
