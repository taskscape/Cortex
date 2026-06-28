import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolExecutor, ToolContext, ToolEvent, KnowledgeEntry, Store } from '@matatbread/matbot-plugin-api';

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

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
  'our', 'please', 'tell', 'that', 'the', 'their', 'this', 'to', 'what', 'when',
  'where', 'which', 'who', 'why', 'with', 'you', 'your',
]);

function normaliseText(text: string): string {
  return text.toLowerCase().replace(/\b(user|users|user's|my|mine|me)\b/g, ' user ');
}

function tokens(text: string): string[] {
  return [...new Set((normaliseText(text).match(/[a-z0-9]+/g) ?? [])
    .filter(t => t.length > 1 && !STOPWORDS.has(t)))];
}

function queryText(terms: readonly SearchTerm[]): string {
  return terms.map(item => item.context ? `${item.term} ${item.context}` : item.term).join(' ');
}

function scoreFact(fact: string, terms: readonly SearchTerm[]): number {
  const q = queryText(terms);
  const qTokens = tokens(q);
  if (qTokens.length === 0) return 0;

  const factText = normaliseText(fact);
  const factTokens = new Set(tokens(factText));
  let score = 0;
  for (const token of qTokens) {
    if (factTokens.has(token)) score += 1;
  }

  for (const term of terms) {
    const normalisedTerm = normaliseText(term.term).trim();
    if (normalisedTerm.length > 1 && factText.includes(normalisedTerm)) score += 2;
  }

  return score / qTokens.length;
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

async function searchRememberedFacts(
  services: MatbotMachine,
  terms: readonly SearchTerm[],
): Promise<RememberedFactMatch[]> {
  const store = services.createStore<RememberedFact>('remembered_facts');
  const facts = await fetchAllRememberedFacts(store);
  const seen = new Set<string>();
  return facts
    .map(fact => ({ fact, score: scoreFact(fact.fact, terms) }))
    .filter(match => match.score >= 0.5)
    .sort((a, b) => b.score - a.score || Date.parse(b.fact.createdAt) - Date.parse(a.fact.createdAt))
    .filter(match => {
      const key = factDedupeKey(match.fact.fact);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
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
    },
  };
}

export const plugin: MatbotPluginSpec = createRumsfeldPlugin();
