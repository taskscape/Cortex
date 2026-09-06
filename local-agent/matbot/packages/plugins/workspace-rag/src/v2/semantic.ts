import { createHash } from 'node:crypto';
import type {
  RagV2ConversationTurn,
  RagV2QueryRewrite,
  RagV2SummaryLevel,
} from './types.js';

/**
 * Inputs for one routing-summary generation: hierarchy level, display title,
 * heading breadcrumb, and the source text to summarize.
 */
export interface RagV2SummaryInput {
  level: RagV2SummaryLevel;
  title: string;
  breadcrumb: string[];
  text: string;
}

/**
 * Optional model-backed helpers for query rewriting and summarization; when a
 * helper is absent, callers fall back to deterministic behavior.
 */
export interface RagV2SemanticServices {
  readonly summarizerSignature?: string;
  rewriteQuery?(input: {
    latestQuestion: string;
    compactConversation: string;
    provider?: string;
    signal?: AbortSignal;
  }): Promise<string | undefined>;
  summarize?(input: RagV2SummaryInput, signal?: AbortSignal): Promise<string | undefined>;
}

const FOLLOW_UP_PATTERN = /\b(?:it|that|this|those|these|there|then|same|older|newer|previous|former|latter|she|he|they|them|her|his|their|again|also|what about|how about|and what|a co|co z|tam|wtedy|starsz|nowsz|poprzedn|ona|on|oni|sie|dasselbe|älter|neuer|vorher|sie|er)\b/iu;

/**
 * Collapses all whitespace runs to single spaces, trims, and hard-caps the
 * result at `limit` characters.
 * @param value - Text to normalize.
 * @param limit - Maximum output length in characters.
 * @returns The normalized text, at most `limit` characters.
 * @throws Never.
 */
function normalizeText(value: string, limit: number): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, limit);
}

/**
 * Computes the SHA-256 hex digest of a string.
 * @param value - Content to hash.
 * @returns Lowercase hex digest (64 characters).
 * @throws Never.
 */
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Compacts recent conversation turns into a bounded context string. Keeps
 * only recent human/model text and caps both per-turn and aggregate size;
 * retrieved robo context and tool results are deliberately not accepted here.
 * @param turns - Conversation turns in chronological order, newest last.
 * @param maxTurns - Maximum number of trailing turns to consider; defaults
 *   to 6.
 * @param maxCharacters - Character budget for the output; defaults to 3,000.
 *   Each turn is additionally capped at 800 characters.
 * @returns The selected turns (oldest first) and their `role: text`
 *   transcript joined by newlines.
 * @throws Never.
 */
export function compactRagV2Conversation(
  turns: readonly RagV2ConversationTurn[],
  maxTurns = 6,
  maxCharacters = 3_000,
): { turns: RagV2ConversationTurn[]; text: string } {
  const selected: RagV2ConversationTurn[] = [];
  let remaining = maxCharacters;
  for (const turn of turns.slice(-Math.max(1, maxTurns)).reverse()) {
    const text = normalizeText(turn.text, Math.min(800, remaining));
    if (!text) continue;
    selected.unshift({ role: turn.role, text });
    remaining -= text.length;
    if (remaining <= 0) break;
  }
  return {
    turns: selected,
    text: selected.map(turn => `${turn.role}: ${turn.text}`).join('\n'),
  };
}

/**
 * Builds a standalone query without a model by appending the compacted
 * conversation as explicit context for reference resolution.
 * @param latestQuestion - The current question text.
 * @param compactConversation - Bounded transcript produced by
 *   {@link compactRagV2Conversation}.
 * @returns The question unchanged when there is no context; otherwise the
 *   question plus a labelled context block, capped at 3,200 characters.
 * @throws Never.
 */
function deterministicRewrite(latestQuestion: string, compactConversation: string): string {
  const context = normalizeText(compactConversation, 2_400);
  if (!context) return latestQuestion;
  return normalizeText(
    `${latestQuestion}\nConversation context needed to resolve references:\n${context}`,
    3_200,
  );
}

/**
 * Rewrites the latest question into a standalone query. When the question
 * looks context-dependent (follow-up pronouns, very short questions, or
 * lowercase question-shaped text) and prior turns exist, a model-backed
 * rewrite is attempted first, falling back to a deterministic concatenation
 * on failure.
 * @param latestQuestion - The current question text; normalized to 1,200
 *   characters.
 * @param turns - Prior conversation turns, newest last; empty means no
 *   rewriting is needed.
 * @param services - Optional semantic services; without a `rewriteQuery`
 *   helper the deterministic rewrite is used.
 * @param provider - Optional provider name forwarded to the rewrite helper.
 * @param signal - Optional abort signal forwarded to the rewrite helper; a
 *   rewrite failure is swallowed unless this signal is aborted.
 * @returns The rewrite result; `method` reports which path produced
 *   `standaloneQuery`, and `contextHash` is set whenever conversation context
 *   was used.
 * @throws Error - rethrows the rewrite failure when `signal` is aborted
 *   during the rewrite call.
 */
export async function rewriteRagV2ConversationQuery(
  latestQuestion: string,
  turns: readonly RagV2ConversationTurn[] = [],
  services?: RagV2SemanticServices,
  provider?: string,
  signal?: AbortSignal,
): Promise<RagV2QueryRewrite> {
  const question = normalizeText(latestQuestion, 1_200);
  const compact = compactRagV2Conversation(turns);
  const needsContext = compact.turns.length > 0 && (
    FOLLOW_UP_PATTERN.test(question)
    || question.split(/\s+/u).length <= 8
    || /^[?\p{L}\p{N}\s]+\?$/u.test(question) && !/[A-Z][\p{L}\p{M}]{2,}/u.test(question)
  );
  if (!needsContext) {
    return {
      latestQuestion: question,
      standaloneQuery: question,
      method: 'identity',
      conversationTurnsUsed: 0,
    };
  }

  const contextHash = hash(compact.text);
  if (services?.rewriteQuery) {
    try {
      const rewritten = normalizeText(await services.rewriteQuery({
        latestQuestion: question,
        compactConversation: compact.text,
        ...(provider ? { provider } : {}),
        ...(signal ? { signal } : {}),
      }) ?? '', 1_200);
      if (rewritten && rewritten !== question) {
        return {
          latestQuestion: question,
          standaloneQuery: rewritten,
          method: 'model',
          conversationTurnsUsed: compact.turns.length,
          contextHash,
        };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return {
    latestQuestion: question,
    standaloneQuery: deterministicRewrite(question, compact.text),
    method: 'deterministic',
    conversationTurnsUsed: compact.turns.length,
    contextHash,
  };
}

/**
 * Deterministically decomposes a user question into follow-up retriever
 * variants tailored to the intent: comparison subjects and entities,
 * diagnostic symptom/cause/remediation angles, entity drill-downs for broad
 * synthesis, or reference/entity recovery. Duplicates and the original query
 * are dropped, and at most four variants are returned.
 * @param query - The question text.
 * @param intent - The plan's detected retrieval intent.
 * @param exactReferences - Reference strings extracted from the query.
 * @param entities - Multi-word proper-noun phrases extracted from the query.
 * @returns At most four `{ query, reason }` variants feeding the plan's
 *   iterative queries.
 * @throws Never.
 */
export function decomposeRagV2Query(
  query: string,
  intent: 'exact_reference' | 'fact_lookup' | 'comparison' | 'diagnostic' | 'as_of' | 'broad_synthesis',
  exactReferences: readonly string[],
  entities: readonly string[],
): Array<{ query: string; reason: string }> {
  const values: Array<{ query: string; reason: string }> = [];
  /**
   * Normalizes a candidate query, then appends it with its reason unless it
   * is empty, equals the original question, or is already present.
   * @param value - Candidate variant text.
   * @param reason - Why the variant was generated.
   * @returns Nothing; appends to `values` in place.
   * @throws Never.
   */
  const add = (value: string, reason: string): void => {
    const normalized = normalizeText(value, 800);
    if (!normalized || normalized === query || values.some(item => item.query === normalized)) return;
    values.push({ query: normalized, reason });
  };
  if (intent === 'comparison') {
    const comparisonParts = query.split(/\b(?:versus|vs\.?|compared with|compared to|and|oraz|kontra|gegenüber|und)\b/iu)
      .map(value => value.replace(/\b(?:compare|difference|same|porównaj|różnic|vergleich)\b/giu, '').trim())
      .filter(value => value.split(/\s+/u).length >= 2)
      .slice(0, 3);
    for (const part of comparisonParts) add(part, 'comparison subject decomposition');
    for (const entity of entities.slice(0, 3)) add(`${entity} ${query}`, 'comparison entity coverage');
  } else if (intent === 'diagnostic') {
    for (const reference of exactReferences.slice(0, 3)) add(reference, 'diagnostic exact symptom');
    add(`${query} root cause`, 'diagnostic cause search');
    add(`${query} fix workaround resolution`, 'diagnostic remediation search');
  } else if (intent === 'broad_synthesis') {
    for (const entity of entities.slice(0, 3)) add(entity, 'broad synthesis entity drill-down');
  } else {
    for (const reference of exactReferences.slice(0, 3)) add(reference, 'exact-reference recovery');
    for (const entity of entities.slice(0, 2)) add(entity, 'entity recovery');
  }
  return values.slice(0, 4);
}

