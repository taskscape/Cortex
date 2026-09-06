import {currentPrincipal} from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-capabilities-types';
import type {} from '@matatbread/matbot-workspace-manager-types';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolExecutor, ToolContext, ToolEvent, KnowledgeEntry, Store, Hook, Message } from '@matatbread/matbot-plugin-api';

import {searchRememberedFacts,factDedupeKey} from '@matatbread/matbot-cognition/recall';
export {searchRememberedFacts} from '@matatbread/matbot-cognition/recall';
import type {RememberedFactMatch} from '@matatbread/matbot-cognition/recall';
/** One search request: the unknown term plus the sentence fragment it appeared in. */
interface SearchTerm{term:string;context?:string;}
/** One hit from the workspace RAG manager: source location, relevance score and text. */
interface WorkspaceRagHit{contextName:string;path:string;score:number;text:string;}
/** Structural subset of the optional WorkspaceRagManager service, resolved untyped via the registry. */
interface WorkspaceRagManagerLike{searchCurrent(query:string,limit:number,signal:AbortSignal):Promise<WorkspaceRagHit[]>;}
/**
 * Flattens search terms into a single query string, appending each term's context after the term.
 *
 * @param terms - Terms to flatten; `context` is optional per term.
 * @returns Space-joined query of `<term>[ <context>]` fragments.
 * @throws Never.
 */
const queryText=(terms:readonly SearchTerm[])=>terms.map(t=>t.context?t.term+' '+t.context:t.term).join(' ');
/**
 * Renders remembered-fact matches as a bulleted list under a "Remembered facts:" heading.
 *
 * @param matches - Matches to render, in list order.
 * @returns Newline-joined text block (just the heading when there are no matches).
 * @throws Never.
 */
function rememberedFactsContent(matches: readonly RememberedFactMatch[]): string {
  return ['Remembered facts:', ...matches.map(match => `- ${match.fact.fact}`)].join('\n');
}

/**
 * Renders workspace RAG hits as numbered, scored source blocks under a heading naming the first
 * hit's context (when known).
 *
 * @param hits - Hits to render; numbering follows this order.
 * @returns Blocks separated by blank lines (a bare heading when empty).
 * @throws Never.
 */
function workspaceRagContent(hits: readonly WorkspaceRagHit[]): string {
  return [
    `Workspace RAG results${hits[0]?.contextName ? ` (${hits[0].contextName})` : ''}:`,
    ...hits.map((hit, index) => [
      `- Source ${index + 1}: ${hit.path} (score ${hit.score.toFixed(3)})`,
      hit.text,
    ].join('\n')),
  ].join('\n\n');
}

/**
 * Composes the `contextual_search` result payload: a remembered-facts section, the best knowledge
 * entry, and workspace RAG hits — each section omitted when empty, joined by blank lines.
 *
 * @param remembered - Remembered-fact matches; omitted from the output when empty.
 * @param best - Top knowledge-index entry; omitted from the output when undefined.
 * @param workspaceRag - Workspace RAG hits; omitted from the output when empty. Defaults to `[]`.
 * @returns The joined content string (empty only when all inputs are empty).
 * @throws Never.
 */
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

/**
 * Display name for a knowledge entry: its first entity, falling back to the entry id when it has
 * no entities.
 *
 * @param entry - Entry to name.
 * @returns First entity, or the entry id.
 * @throws Never.
 */
function knowledgeName(entry: KnowledgeEntry): string {
  return entry.entities[0] ?? entry.id;
}


/**
 * Concatenates a message's text blocks with newlines.
 *
 * @param msg - Message to read; may be undefined (e.g. no user message yet).
 * @returns The joined text, or the empty string when `msg` is undefined or holds no text blocks.
 * @throws Never.
 */
function textOf(msg: Message | undefined): string {
  return msg?.content.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
}

/**
 * Marks the injected block as system-supplied, so the model doesn't read remembered facts as the user
 * having just said them. (Deliberately a local copy of the same framing `triggers` applies to its own
 * injections: same idea, no dependency between two plugins that don't otherwise know about each other.)
 *
 * @param body - Already-rendered content to wrap.
 * @returns The body enclosed in system-supplied framing markers.
 * @throws Never.
 */
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
 *
 * @param services - Runtime machine the fact search reads its store and settings through.
 * @returns A `screen` hook: the handler scores the turn's last genuine user message against the
 *   fact store and, on matches, returns `ephemeral` context plus a durable `memory-inject` marker.
 * @throws Never.
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

/**
 * Builds the default rumsfeld plugin: registers the `contextual_search` tool
 * (knowledge index + remembered facts + workspace RAG) and the memory
 * injection hook.
 *
 * @returns The plugin specification.
 * @throws Never.
 */
export function createRumsfeldPlugin(): MatbotPluginSpec {
  return {
    apiVersion: PLUGIN_API_VERSION,

    /**
     * Registers the `contextual_search` tool — served by the retrieval federation when present,
     * else by knowledge index + remembered facts + workspace RAG — and the memory-injection hook.
     *
     * @param services - Runtime machine providing the knowledge index, retrieval services, tools
     *   and hooks.
     * @returns A promise that resolves once the tool and hook are registered.
     * @throws Never.
     */
    async setup(services: MatbotMachine) {
      const executor: ToolExecutor = {
        async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
          const { terms } = input as { terms: SearchTerm[] };

          if (terms.length === 0) {
            yield { type: 'error', message: 'No search terms provided.' };
            return;
          }

          if(services.RetrievalFederation){
            const result=await services.RetrievalFederation.search({query:queryText(terms),limit:12,workspaceId:services.WorkspaceContext?.id??'default',principal:currentPrincipal(),signal:ctx.signal});
            if(!result.hits.length&&!result.partial){yield {type:'error',message:'There is no skill available for the requested operation.'};return;}
            const content=result.hits.map(hit=>hit.content).join('\n\n');
            const name=result.hits.some(h=>h.sourceId==='remembered_facts')?'remembered_facts':result.hits.some(h=>h.sourceId==='workspace_rag')?'workspace_rag':result.hits[0]?.knowledge?knowledgeName(result.hits[0].knowledge):'retrieval';
            yield {type:'result',value:{name,content,...(result.partial?{partial:true,sources:result.sources}:{}),citations:result.hits.map(hit=>({id:hit.id,sourceId:hit.sourceId,citation:hit.citation}))}};return;
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

/**
 * Default instance of the rumsfeld plugin.
 *
 * @returns The plugin specification.
 */
export const plugin: MatbotPluginSpec = createRumsfeldPlugin();
