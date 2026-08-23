import { createHash, randomUUID } from 'node:crypto';
import { detectPassageLanguage } from './language.js';
import { RagV2ColbertAdapter } from './late-interaction.js';
import { RagV2ObjectStore } from './object-store.js';
import type { RagV2Repository, RagV2RetrievalRunRecord, RagV2SearchScope } from './repository.js';
import {
  decomposeRagV2Query,
  rewriteRagV2ConversationQuery,
  type RagV2SemanticServices,
} from './semantic.js';
import type {
  RagV2ConversationTurn,
  RagV2Embedder,
  RagV2Evidence,
  RagV2PassageRecord,
  RagV2QueryRewrite,
  RagV2RankedHit,
  RagV2RetrievalPlan,
  RagV2RetrievalVariant,
  RagV2SearchResult,
} from './types.js';

/**
 * Caller-supplied options controlling one retrieval search.
 */
export interface RetrievalOptions {
  principalId?: string;
  groupIds?: string[];
  limit?: number;
  answerLanguage?: string;
  documentTypes?: string[];
  jurisdictions?: string[];
  asOfDate?: string;
  variant?: RagV2RetrievalVariant;
  conversation?: RagV2ConversationTurn[];
  rewriteProvider?: string;
  iterative?: boolean;
}

interface RerankResponse {
  model?: string;
  scores: number[];
}

interface RetrievalDependencies {
  repository: RagV2Repository;
  objectStore: RagV2ObjectStore;
  embedder: RagV2Embedder;
  rerankerUrl?: string;
  rrfK?: number;
  rrfWeights?: Record<string, number>;
  colbertUrl?: string;
  semanticServices?: RagV2SemanticServices;
  onLazySection?: (
    workspaceId: string,
    contextId: string,
    generationId: string,
    sectionId: string,
    passageId?: string,
    signal?: AbortSignal,
  ) => void;
}

const EXACT_REFERENCE_PATTERNS = [
  /\b(?:article|art\.?|section|sec\.?|clause|annex|appendix|§|artykuł|rozdział)\s*[\w.-]+(?:\([\w.-]+\))*/giu,
  /\b[A-Z]{2,8}[-/]\d{2,}(?:[-/]\d+)*\b/gu,
  /\b(?:NIP|VAT|KRS|REGON)\s*[:#]?\s*[A-Z0-9-]{6,}\b/giu,
  /\b\d{4}-\d{2}-\d{2}\b/gu,
  /\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/giu,
  /\b(?:PLN|EUR|USD|GBP|CHF)\s*\d[\d .,]*(?:[.,]\d{2})?\b/giu,
  /\b\d[\d .,]*(?:[.,]\d{2})?\s*(?:PLN|EUR|USD|GBP|CHF|zł|€|\$|£)\b/giu,
  /(?:[A-Za-z]:\\|\/)[^\s"'<>|]{3,}/gu,
];

const ENTITY_PATTERN = /\b(?:[\p{Lu}][\p{L}\p{M}'’-]+)(?:\s+[\p{Lu}][\p{L}\p{M}'’-]+){1,4}\b/gu;
const QUOTED_PATTERN = /["“”„](.{2,160}?)["“”]/gu;

const CONTROLLED_LEGAL_EXPANSIONS: Record<string, Record<string, string[]>> = {
  termination: {
    pl: ['wypowiedzenie', 'rozwiązanie umowy'],
    de: ['kündigung', 'vertragsbeendigung'],
  },
  wypowiedzenie: {
    en: ['termination', 'notice of termination'],
    de: ['kündigung'],
  },
  payment: {
    pl: ['płatność', 'zapłata'],
    de: ['zahlung'],
  },
  płatność: {
    en: ['payment'],
    de: ['zahlung'],
  },
  liability: {
    pl: ['odpowiedzialność'],
    de: ['haftung'],
  },
  odpowiedzialność: {
    en: ['liability'],
    de: ['haftung'],
  },
};

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function elapsed(startedAt: number): number {
  return Date.now() - startedAt;
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map(value => value.trim()).filter(Boolean))];
}

function identifyLane(hits: readonly RagV2RankedHit[], retriever: string): RagV2RankedHit[] {
  return hits.map((hit, index) => ({
    ...hit,
    retriever,
    retrieverRank: index + 1,
    retrievalReasons: [...hit.retrievalReasons, `${retriever} rank ${index + 1}`],
  }));
}

function inferIntent(query: string, exactReferences: readonly string[]): RagV2RetrievalPlan['intent'] {
  if (/\b(?:as of|on \d{4}-\d{2}-\d{2}|na dzień|według stanu na|zum stand)\b/iu.test(query)) return 'as_of';
  if (/\b(?:compare|difference|versus|vs\.?|porównaj|różnic|vergleich)\b/iu.test(query)) return 'comparison';
  if (/\b(?:diagnose|diagnosis|debug|root cause|why (?:does|did|is|was)|fail(?:s|ed|ure)?|error|exception|retry|workaround|napraw|błąd|awari|fehler|ursache)\b/iu.test(query)) return 'diagnostic';
  if (exactReferences.length > 0 || /["“”„].+["“”]/u.test(query)) return 'exact_reference';
  if (/\b(?:summarize|overview|across|all documents|podsumuj|przegląd|wszystkich dokument)\b/iu.test(query)) {
    return 'broad_synthesis';
  }
  return 'fact_lookup';
}

function extractAsOfDate(query: string): string | undefined {
  return /\b(\d{4}-\d{2}-\d{2})\b/u.exec(query)?.[1];
}

function extractFilterValues(query: string, name: string): string[] {
  const expression = new RegExp(`\\b${name}\\s*:\\s*(?:["']([^"']+)["']|([\\p{L}\\p{N}_.-]+))`, 'giu');
  return unique([...query.matchAll(expression)].map(match => match[1] ?? match[2] ?? ''));
}

function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '');
}

/**
 * Builds the full {@link RagV2RetrievalPlan} for a question: rewrite,
 * language/intent detection, reference extraction, and query variants.
 * @param params - Question, conversation turns, corpus info, and options.
 * @returns The resolved plan.
 */
export function planRagV2Query(
  query: string,
  workspaceId: string,
  contextId: string,
  options: RetrievalOptions = {},
  rewrite: RagV2QueryRewrite = {
    latestQuestion: query,
    standaloneQuery: query,
    method: 'identity' as const,
    conversationTurnsUsed: 0,
  },
): RagV2RetrievalPlan {
  const language = detectPassageLanguage(query);
  const exactReferences = unique(EXACT_REFERENCE_PATTERNS.flatMap(pattern => [...query.matchAll(pattern)].map(match => match[0]!)));
  const quotedPhrases = unique([...query.matchAll(QUOTED_PATTERN)].map(match => match[1]!));
  const entities = unique([...query.matchAll(ENTITY_PATTERN)].map(match => match[0]!));
  const lexicalVariants: RagV2RetrievalPlan['lexicalVariants'] = [];
  const folded = stripDiacritics(query);
  if (folded !== query) lexicalVariants.push({ language: language.primary, query: folded, reason: 'diacritic-folded exact expansion' });
  const lower = query.toLocaleLowerCase();
  for (const [term, translations] of Object.entries(CONTROLLED_LEGAL_EXPANSIONS)) {
    if (!lower.includes(term)) continue;
    for (const [targetLanguage, values] of Object.entries(translations)) {
      lexicalVariants.push({
        language: targetLanguage,
        query: `${query} ${values.join(' ')}`,
        reason: `controlled legal terminology expansion for ${term}`,
      });
    }
  }
  const groupIds = options.groupIds ?? [];
  const explicitTypes = options.documentTypes ?? extractFilterValues(query, 'type');
  const explicitJurisdictions = options.jurisdictions ?? extractFilterValues(query, 'jurisdiction');
  const asOfDate = options.asOfDate ?? extractAsOfDate(query);
  return {
    originalQuery: rewrite.latestQuestion,
    latestQuestion: rewrite.latestQuestion,
    standaloneQuery: rewrite.standaloneQuery,
    rewriteMethod: rewrite.method,
    conversationTurnsUsed: rewrite.conversationTurnsUsed,
    ...(rewrite.contextHash ? { conversationContextHash: rewrite.contextHash } : {}),
    queryLanguage: language.primary,
    answerLanguage: options.answerLanguage ?? (language.primary === 'und' ? 'en' : language.primary),
    intent: inferIntent(query, exactReferences),
    exactReferences,
    quotedPhrases,
    entities,
    documentTypes: explicitTypes,
    jurisdictions: explicitJurisdictions,
    ...(asOfDate ? { asOfDate } : {}),
    corpusLanguages: unique([language.primary, ...lexicalVariants.map(value => value.language)]).filter(value => value !== 'und'),
    lexicalVariants,
    iterativeQueries: [],
    embeddingInstruction: 'Retrieve original evidence passages that answer the question.',
    authorization: {
      workspaceId,
      contextId,
      principalId: options.principalId ?? 'local-user',
      groupIds,
    },
  };
}

/**
 * Fuses per-retriever ranked lists into a single ranking via weighted RRF.
 * @param lists - Ranked hit lists keyed by retriever, with weights.
 * @param k - RRF smoothing constant.
 * @returns Hits sorted by fused score with fusion metadata attached.
 */
export function reciprocalRankFusion(
  resultSets: readonly RagV2RankedHit[][],
  weights: Readonly<Record<string, number>> = {},
  k = 60,
): RagV2RankedHit[] {
  const fused = new Map<string, RagV2RankedHit>();
  for (const resultSet of resultSets) {
    for (let index = 0; index < resultSet.length; index++) {
      const hit = resultSet[index]!;
      const rank = hit.retrieverRank || index + 1;
      const weight = weights[hit.retriever] ?? 1;
      const contribution = weight / (k + rank);
      const current = fused.get(hit.id);
      if (!current) {
        fused.set(hit.id, {
          ...hit,
          fusionScore: contribution,
          retrievalReasons: [...hit.retrievalReasons],
        });
      } else {
        current.fusionScore = (current.fusionScore ?? 0) + contribution;
        current.retrievalReasons.push(...hit.retrievalReasons);
        if (hit.retrieverScore > current.retrieverScore) {
          current.retrieverScore = hit.retrieverScore;
        }
      }
      fused.get(hit.id)!.retrievalReasons.push(
        `${hit.retriever} RRF contribution ${contribution.toFixed(8)} (weight ${weight}, k ${k})`,
      );
    }
  }
  return [...fused.values()].sort((left, right) =>
    (right.fusionScore ?? 0) - (left.fusionScore ?? 0)
    || right.retrieverScore - left.retrieverScore);
}

async function rerank(
  url: string,
  query: string,
  hits: readonly RagV2RankedHit[],
  signal?: AbortSignal,
): Promise<RerankResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Workspace RAG V2 reranker timed out.')), 5_000);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(new URL('/rerank', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, texts: hits.map(hit => hit.text), truncate: true }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Workspace RAG V2 reranker returned HTTP ${response.status}.`);
    const body = await response.json() as unknown;
    if (Array.isArray(body)) {
      const scores = new Array<number>(hits.length).fill(0);
      for (const value of body) {
        if (!value || typeof value !== 'object') continue;
        const item = value as Record<string, unknown>;
        const index = Number(item['index']);
        const score = Number(item['score']);
        if (Number.isInteger(index) && index >= 0 && index < scores.length && Number.isFinite(score)) scores[index] = score;
      }
      return { scores };
    }
    if (body && typeof body === 'object') {
      const value = body as Record<string, unknown>;
      const scores = Array.isArray(value['scores']) ? value['scores'].map(Number) : [];
      if (scores.length === hits.length && scores.every(Number.isFinite)) {
        return {
          ...(typeof value['model'] === 'string' ? { model: value['model'] } : {}),
          scores,
        };
      }
    }
    throw new Error('Workspace RAG V2 reranker returned an unsupported response.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function needsNeighbour(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 180 || !/[.!?;:)\]]$/u.test(trimmed);
}

function nearDuplicate(left: string, right: string): boolean {
  const words = (value: string) => new Set(
    value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 1_000) ?? [],
  );
  const leftWords = words(left);
  const rightWords = words(right);
  if (leftWords.size < 8 || rightWords.size < 8) return false;
  let intersection = 0;
  for (const word of leftWords) if (rightWords.has(word)) intersection++;
  const union = leftWords.size + rightWords.size - intersection;
  return union > 0 && intersection / union >= 0.92;
}

function diversify(hits: readonly RagV2RankedHit[], limit: number): {
  selected: RagV2RankedHit[];
  exclusions: Map<string, string>;
} {
  const selected: RagV2RankedHit[] = [];
  const exclusions = new Map<string, string>();
  const documentCounts = new Map<string, number>();
  const sectionCounts = new Map<string, number>();
  const hashes = new Set<string>();
  const selectedTexts: string[] = [];
  for (const hit of hits) {
    if (selected.length >= limit) {
      exclusions.set(hit.id, 'evidence budget reached');
      continue;
    }
    if (hashes.has(hit.contentSha256)) {
      exclusions.set(hit.id, 'duplicate content hash');
      continue;
    }
    if (selectedTexts.some(text => nearDuplicate(text, hit.text))) {
      exclusions.set(hit.id, 'near-duplicate passage');
      continue;
    }
    const documentCount = documentCounts.get(hit.documentId) ?? 0;
    if (documentCount >= 8) {
      exclusions.set(hit.id, 'maximum passages per document');
      continue;
    }
    const sectionKey = hit.sectionId ?? hit.documentId;
    const sectionCount = sectionCounts.get(sectionKey) ?? 0;
    if (sectionCount >= 4) {
      exclusions.set(hit.id, 'maximum passages per section');
      continue;
    }
    selected.push(hit);
    hashes.add(hit.contentSha256);
    selectedTexts.push(hit.text);
    documentCounts.set(hit.documentId, documentCount + 1);
    sectionCounts.set(sectionKey, sectionCount + 1);
  }
  return { selected, exclusions };
}

function hitFromNeighbour(source: RagV2RankedHit, passage: RagV2PassageRecord): RagV2RankedHit {
  return {
    ...source,
    id: passage.passageId,
    passageId: passage.passageId,
    sectionId: passage.sectionId,
    headingPath: passage.headingPath,
    startByte: passage.startByte,
    endByte: passage.endByte,
    startLine: passage.startLine,
    endLine: passage.endLine,
    language: passage.language,
    text: passage.text,
    contentSha256: passage.contentSha256,
    embeddingState: passage.embeddingState,
    retriever: 'neighbour_expansion',
    retrieverRank: 1,
    retrieverScore: source.retrieverScore,
    fusionScore: (source.fusionScore ?? 0) * 0.95,
    retrievalReasons: [...source.retrievalReasons, `adjacent to ${source.passageId}`],
  };
}

function hasEvidenceConflict(values: readonly Pick<RagV2RankedHit, 'text' | 'documentId'>[]): boolean {
  if (new Set(values.map(value => value.documentId)).size < 2) return false;
  let positive = false;
  let negative = false;
  for (const value of values.slice(0, 30)) {
    const text = value.text.toLocaleLowerCase();
    positive ||= /\b(?:must|required|supported|enabled|allowed|applies|shall|yes|wymaga|dozwolon|obowiązuje|aktiviert|zulässig)\b/u.test(text);
    negative ||= /\b(?:must not|not required|unsupported|disabled|prohibited|does not apply|shall not|no|nie wolno|zabronion|nie obowiązuje|deaktiviert|unzulässig)\b/u.test(text);
  }
  return positive && negative;
}

function assessFirstPassCandidates(
  plan: RagV2RetrievalPlan,
  candidates: readonly RagV2RankedHit[],
): RagV2SearchResult['answerability']['firstPass'] {
  const reasons: string[] = [];
  const required = plan.intent === 'comparison' || plan.intent === 'diagnostic' ? 2 : 1;
  if (candidates.length < required) {
    reasons.push(`first pass produced ${candidates.length} passage candidate(s); ${required} required for ${plan.intent}`);
  }
  if (plan.intent === 'exact_reference' && candidates.length > 0
    && !candidates.some(value => value.retrievalReasons.some(reason => /exact_reference|exact-reference/iu.test(reason)))) {
    reasons.push('first pass did not recover the requested exact reference');
  }
  if (plan.intent === 'comparison' && new Set(candidates.map(value => value.documentId)).size < 2
    && new Set(candidates.map(value => value.sectionId).filter(Boolean)).size < 2) {
    reasons.push('first pass did not cover two comparison sources or sections');
  }
  const insufficient = reasons.length > 0;
  const conflicting = hasEvidenceConflict(candidates);
  if (conflicting) reasons.push('first-pass sources contain materially conflicting polarity');
  return {
    status: insufficient ? 'insufficient' : conflicting ? 'conflicting' : 'sufficient',
    candidateCount: candidates.length,
    reasons: reasons.length > 0 ? reasons : ['first-pass candidates satisfy the retrieval intent'],
  };
}

function assessAnswerability(
  plan: RagV2RetrievalPlan,
  evidence: readonly RagV2Evidence[],
  iterations: number,
  conflicting: boolean,
  firstPass: RagV2SearchResult['answerability']['firstPass'],
): RagV2SearchResult['answerability'] {
  const reasons: string[] = [];
  const required = plan.intent === 'comparison' || plan.intent === 'diagnostic' ? 2 : 1;
  if (evidence.length < required) reasons.push(`retrieval produced ${evidence.length} verified passage(s); ${required} required for ${plan.intent}`);
  if (plan.intent === 'exact_reference' && evidence.length > 0
    && !evidence.some(value => value.retrievalReasons.some(reason => /exact_reference|exact-reference/iu.test(reason)))) {
    reasons.push('the requested exact reference was not found in a verified evidence range');
  }
  if (plan.intent === 'comparison' && new Set(evidence.map(value => value.documentId)).size < 2
    && new Set(evidence.map(value => value.sectionId)).size < 2) {
    reasons.push('comparison evidence does not cover two distinct sources or sections');
  }
  const insufficient = reasons.length > 0;
  if (conflicting && !insufficient) reasons.push('independent retrieved sources contain materially conflicting polarity');
  const target = Math.max(1, required);
  return {
    status: insufficient ? 'insufficient' : conflicting ? 'conflicting' : 'sufficient',
    score: insufficient ? Math.min(0.49, evidence.length / target * 0.49) : conflicting ? 0.65 : Math.min(1, 0.75 + evidence.length * 0.05),
    abstained: insufficient,
    reasons: reasons.length > 0 ? reasons : ['verified evidence satisfies the retrieval intent'],
    iterations,
    firstPass,
  };
}

/**
 * Executes planned retrieval: runs lexical/dense/exact lanes, fuses and
 * diversifies results, optionally reranks, assesses answerability, and
 * records the audit run.
 */
export class RagV2RetrievalEngine {
  private readonly repository: RagV2Repository;
  private readonly objectStore: RagV2ObjectStore;
  private readonly embedder: RagV2Embedder;
  private readonly rerankerUrl: string | undefined;
  private readonly onLazySection: RetrievalDependencies['onLazySection'];
  private readonly rrfK: number;
  private readonly rrfWeights: Record<string, number>;
  private readonly colbert: RagV2ColbertAdapter | undefined;
  private readonly semanticServices: RagV2SemanticServices | undefined;

  constructor(dependencies: RetrievalDependencies) {
    this.repository = dependencies.repository;
    this.objectStore = dependencies.objectStore;
    this.embedder = dependencies.embedder;
    this.rerankerUrl = dependencies.rerankerUrl;
    this.onLazySection = dependencies.onLazySection;
    this.rrfK = dependencies.rrfK ?? 60;
    this.rrfWeights = dependencies.rrfWeights ?? {};
    this.colbert = dependencies.colbertUrl
      ? new RagV2ColbertAdapter(dependencies.colbertUrl)
      : undefined;
    this.semanticServices = dependencies.semanticServices;
  }

  /**
   * Performs one end-to-end retrieval for a plan.
   * @param plan - The retrieval plan to execute.
   * @param options - Limits, variant selection, and reranker controls.
   * @returns The complete {@link RagV2SearchResult}.
   */
  async search(
    workspaceId: string,
    contextId: string,
    query: string,
    options: RetrievalOptions = {},
    signal?: AbortSignal,
  ): Promise<RagV2SearchResult> {
    const publication = await this.repository.activePublication(workspaceId, contextId);
    if (!publication) throw new Error('Workspace RAG V2 has no active publication for this context.');
    const rewrite = await rewriteRagV2ConversationQuery(
      query,
      options.conversation,
      this.semanticServices,
      options.rewriteProvider,
      signal,
    );
    const retrievalQuery = rewrite.standaloneQuery;
    const timings: Record<string, number> = {};
    const degraded: string[] = [];
    const variant = options.variant ?? 'hierarchical_lazy';
    const useHierarchy = variant === 'hierarchical' || variant === 'hierarchical_lazy';
    const useLexical = variant !== 'flat_dense_baseline' && variant !== 'dense_only';
    const useDense = variant !== 'lexical_only';
    const useTranslation = [
      'hybrid_translated',
      'hybrid_reranked',
      'hierarchical',
      'hierarchical_lazy',
    ].includes(variant);
    const useReranker = [
      'hybrid_reranked',
      'hierarchical',
      'hierarchical_lazy',
    ].includes(variant);
    const useLazyPromotion = variant === 'hierarchical_lazy';
    if (this.objectStore.retentionMode === 'manifest_only') {
      degraded.push(
        'manifest_only retention cannot guarantee historical availability; each citation fetch is rehashed.',
      );
    }
    const runId = randomUUID();
    const startedAtIso = new Date().toISOString();
    const plan = planRagV2Query(retrievalQuery, workspaceId, contextId, options, rewrite);
    const authorizationTokens = unique([
      `workspace:${workspaceId}`,
      `user:${plan.authorization.principalId}`,
      ...plan.authorization.groupIds.map(value => `group:${value}`),
    ]);
    const persistedPlan = {
      ...plan,
      retrievalVariant: variant,
      authorization: {
        workspaceId,
        contextId,
        principalHash: sha256(plan.authorization.principalId),
        groupSetHash: sha256([...plan.authorization.groupIds].sort().join('\0')),
      },
    };
    const run: RagV2RetrievalRunRecord = {
      id: runId,
      workspaceId,
      contextId,
      generationId: publication.generationId,
      questionHash: sha256(rewrite.latestQuestion),
      planJson: persistedPlan,
      embeddingSignature: this.embedder.info.signature,
      status: 'running',
      startedAt: startedAtIso,
    };
    await this.repository.createRetrievalRun(run);
    try {
      let queryVector: number[] = [];
      if (useDense) {
        const embeddingStarted = Date.now();
        queryVector = (await this.embedder.embed([retrievalQuery], 'query', signal))[0] ?? [];
        timings['query_embedding_ms'] = elapsed(embeddingStarted);
      }
      const routingScope: RagV2SearchScope = {
        workspaceId,
        contextId,
        generationId: publication.generationId,
        authorizationTokens,
        ...(plan.documentTypes.length > 0 ? { documentTypes: plan.documentTypes } : {}),
        ...(plan.jurisdictions.length > 0 ? { jurisdictions: plan.jurisdictions } : {}),
        ...(plan.asOfDate ? { asOfDate: plan.asOfDate } : {}),
        lexicalLanguage: plan.queryLanguage,
        limit: 100,
      };
      const routingStarted = Date.now();
      const routingPromises: Array<Promise<RagV2RankedHit[]>> = [];
      if (useHierarchy && useLexical) {
        routingPromises.push(
          this.repository.lexicalSearch('collection', retrievalQuery, { ...routingScope, limit: 20 }),
          this.repository.lexicalSearch('document', retrievalQuery, { ...routingScope, limit: 50 }),
          this.repository.lexicalSearch('section', retrievalQuery, routingScope),
          this.repository.exactSearch(
            [...plan.exactReferences, ...plan.quotedPhrases],
            { ...routingScope, limit: 50 },
          ),
        );
      }
      if (useHierarchy && useDense) {
        routingPromises.push(
          this.repository.denseSearch(
            'collection',
            queryVector,
            this.embedder.info,
            { ...routingScope, limit: 20 },
          ),
          this.repository.denseSearch(
            'document',
            queryVector,
            this.embedder.info,
            { ...routingScope, limit: 50 },
          ),
          this.repository.denseSearch('section', queryVector, this.embedder.info, routingScope),
        );
      }
      const routingSets = await Promise.all(routingPromises);
      let routed = reciprocalRankFusion(routingSets, this.rrfWeights, this.rrfK);
      const routedCollectionIds = unique(routed.filter(hit => hit.level === 'collection').slice(0, 10).map(hit => hit.documentId));
      if (useHierarchy && routedCollectionIds.length > 0) {
        const collectionScope = { ...routingScope, collectionIds: routedCollectionIds };
        const collectionExpansionPromises: Array<Promise<RagV2RankedHit[]>> = [];
        if (useLexical) {
          collectionExpansionPromises.push(
            this.repository.lexicalSearch('document', retrievalQuery, { ...collectionScope, limit: 50 }),
            this.repository.lexicalSearch('section', retrievalQuery, collectionScope),
          );
        }
        if (useDense) {
          collectionExpansionPromises.push(
            this.repository.denseSearch('document', queryVector, this.embedder.info, { ...collectionScope, limit: 50 }),
            this.repository.denseSearch('section', queryVector, this.embedder.info, collectionScope),
          );
        }
        const collectionExpansionSets = await Promise.all(collectionExpansionPromises);
        routingSets.push(...collectionExpansionSets.map(values => identifyLane(values, 'collection_member_route')));
        routed = reciprocalRankFusion(routingSets, this.rrfWeights, this.rrfK);
      }
      const routedDocumentIds = unique(routed.filter(hit => hit.level === 'document' || hit.level === 'section').slice(0, 30).map(hit => hit.documentId));
      const routedSectionIds = unique(routed.filter(hit => hit.sectionId).slice(0, 50).map(hit => hit.sectionId!));
      timings['routing_ms'] = elapsed(routingStarted);
      const candidateCounts: Record<string, number> = {
        routedInput: routingSets.reduce((sum, values) => sum + values.length, 0),
        routedFused: routed.length,
        routedCollections: routedCollectionIds.length,
        routedDocuments: routedDocumentIds.length,
        routedSections: routedSectionIds.length,
      };

      const candidateStarted = Date.now();
      const scoped: RagV2SearchScope = useHierarchy
        ? {
            ...routingScope,
            ...(routedDocumentIds.length > 0 ? { documentIds: routedDocumentIds } : {}),
            ...(routedSectionIds.length > 0 ? { sectionIds: routedSectionIds } : {}),
            limit: 150,
          }
        : { ...routingScope, limit: 150 };
      const collectionScoped: RagV2SearchScope | undefined = useHierarchy && routedCollectionIds.length > 0
        ? { ...routingScope, collectionIds: routedCollectionIds, limit: 150 }
        : undefined;
      const candidatePromises: Array<Promise<RagV2RankedHit[]>> = [];
      if (useLexical) {
        candidatePromises.push(
          this.repository.lexicalSearch('passage', retrievalQuery, scoped),
          this.repository.exactSearch(
            [...plan.exactReferences, ...plan.quotedPhrases],
            { ...routingScope, limit: 50 },
          ),
        );
        if (collectionScoped) {
          candidatePromises.push(
            this.repository.lexicalSearch('passage', retrievalQuery, collectionScoped)
              .then(hits => identifyLane(hits, 'passage_lexical_collection')),
          );
        }
      }
      if (useDense) {
        if (useHierarchy) {
          candidatePromises.push(
            this.repository.denseSearch(
              'passage',
              queryVector,
              this.embedder.info,
              { ...scoped, limit: 100 },
            ).then(hits => identifyLane(hits, 'passage_dense_scoped')),
          );
          if (collectionScoped) {
            candidatePromises.push(
              this.repository.denseSearch(
                'passage',
                queryVector,
                this.embedder.info,
                { ...collectionScoped, limit: 100 },
              ).then(hits => identifyLane(hits, 'passage_dense_collection')),
            );
          }
        }
        candidatePromises.push(
          this.repository.denseSearch(
            'passage',
            queryVector,
            this.embedder.info,
            { ...routingScope, limit: 100 },
          ).then(hits => identifyLane(hits, 'passage_dense_global')),
        );
      }
      if (useTranslation) {
        candidatePromises.push(...plan.lexicalVariants.slice(0, 3).map(lexicalVariant =>
          this.repository.lexicalSearch('passage', lexicalVariant.query, {
            ...scoped,
            lexicalLanguage: lexicalVariant.language,
            limit: 50,
          })
            .then(hits => identifyLane(hits, 'translated_lexical'))));
      }
      if (this.colbert && variant === 'hierarchical_lazy') {
        candidatePromises.push(
          this.colbert.search(retrievalQuery, scoped, signal)
            .then(result => result.hits)
            .catch(error => {
              degraded.push(
                `late-interaction unavailable: ${error instanceof Error ? error.message : String(error)}`,
              );
              return [];
            }),
        );
      }
      const candidateSets = await Promise.all(candidatePromises);
      candidateSets.forEach((values, index) => {
        candidateCounts[`passageLane${index + 1}`] = values.length;
      });
      let fused = reciprocalRankFusion(candidateSets, {
        ...this.rrfWeights,
        exact_reference: 2,
        passage_dense_global: 0.8,
      }, this.rrfK).slice(0, 100);
      let iterations = 1;
      const firstPass = assessFirstPassCandidates(plan, fused);
      const firstPassConflicting = firstPass.status === 'conflicting';
      if (options.iterative !== false && (
        plan.intent === 'comparison'
        || plan.intent === 'diagnostic'
        || firstPass.status !== 'sufficient'
        || firstPassConflicting
      )) {
        const iterativeStarted = Date.now();
        const iterativeQueries = decomposeRagV2Query(
          retrievalQuery,
          plan.intent,
          plan.exactReferences,
          plan.entities,
        );
        if (firstPassConflicting) {
          iterativeQueries.push({
            query: `${retrievalQuery} current authoritative version effective date`,
            reason: 'conflict resolution across current authoritative sources',
          });
        }
        if (iterativeQueries.length === 0 && fused.length < 3) {
          iterativeQueries.push({
            query: `${retrievalQuery} supporting evidence explanation`,
            reason: 'low-evidence recovery search',
          });
        }
        plan.iterativeQueries = iterativeQueries.slice(0, 4);
        const iterativeResults = await Promise.all(plan.iterativeQueries.map(async (item, index) => {
          const resultSets: RagV2RankedHit[][] = [];
          if (useLexical) {
            resultSets.push(identifyLane(
              await this.repository.lexicalSearch('passage', item.query, { ...routingScope, limit: 100 }),
              `iterative_lexical_${index + 1}`,
            ));
          }
          if (useDense) {
            const vector = (await this.embedder.embed([item.query], 'query', signal))[0] ?? [];
            resultSets.push(identifyLane(
              await this.repository.denseSearch('passage', vector, this.embedder.info, { ...routingScope, limit: 100 }),
              `iterative_dense_${index + 1}`,
            ));
          }
          return resultSets;
        }));
        const followUpSets = iterativeResults.flat();
        if (followUpSets.length > 0) {
          fused = reciprocalRankFusion([
            identifyLane(fused, 'first_pass_fused'),
            ...followUpSets,
          ], this.rrfWeights, this.rrfK).slice(0, 100);
          iterations++;
        }
        candidateCounts['iterativeQueries'] = plan.iterativeQueries.length;
        candidateCounts['iterativeCandidates'] = followUpSets.reduce((sum, values) => sum + values.length, 0);
        timings['iterative_retrieval_ms'] = elapsed(iterativeStarted);
      }
      candidateCounts['passageFused'] = fused.length;
      timings['candidate_retrieval_ms'] = elapsed(candidateStarted);

      let ranked = fused;
      if (useReranker && this.rerankerUrl && fused.length > 0) {
        const rerankStarted = Date.now();
        try {
          const result = await rerank(this.rerankerUrl, retrievalQuery, fused.slice(0, 100), signal);
          run.rerankerModel = result.model ?? this.rerankerUrl;
          ranked = fused
            .map((hit, index) => ({
              ...hit,
              rerankerScore: result.scores[index] ?? 0,
              rerankerInputHash: sha256(`${retrievalQuery}\0${hit.text}`),
            }))
            .sort((left, right) => (right.rerankerScore ?? 0) - (left.rerankerScore ?? 0))
            .map((hit, index) => ({
              ...hit,
              retrievalReasons: [...hit.retrievalReasons, `reranker rank ${index + 1}`],
            }));
        } catch (error) {
          degraded.push(`reranker unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
        timings['reranking_ms'] = elapsed(rerankStarted);
      }

      const requestedLimit = Math.max(1, Math.min(options.limit ?? 20, 25));
      const { selected, exclusions } = variant === 'flat_dense_baseline'
        ? { selected: ranked.slice(0, requestedLimit), exclusions: new Map<string, string>() }
        : diversify(ranked, requestedLimit);
      candidateCounts['selectedBeforeExpansion'] = selected.length;
      const expanded = variant === 'flat_dense_baseline'
        ? selected
        : await this.expandNeighbours(
            selected,
            workspaceId,
            contextId,
            publication.generationId,
            requestedLimit,
          );
      const evidenceStarted = Date.now();
      const evidence: RagV2Evidence[] = [];
      for (const hit of expanded) {
        if (!hit.passageId || !hit.sectionId || hit.startByte === undefined || hit.endByte === undefined
          || hit.startLine === undefined || hit.endLine === undefined) continue;
        try {
          const authorizedDocument = await this.repository.documentVersion(
            workspaceId,
            contextId,
            hit.documentVersionId,
            authorizationTokens,
          );
          if (!authorizedDocument) {
            degraded.push(`authorization or version recheck failed for passage ${hit.passageId}`);
            continue;
          }
          const raw = await this.objectStore.fetchRange(hit.documentVersionId.includes(':')
            ? hit.documentVersionId.split(':').at(-1)!
            : this.contentHashFromObjectPath(hit.objectPath) ?? hit.documentVersionId,
          hit.startByte, hit.endByte);
          const rangeHash = sha256(raw);
          if (rangeHash !== hit.contentSha256) {
            degraded.push(`range hash mismatch for passage ${hit.passageId}`);
            continue;
          }
          evidence.push({
            evidenceId: `D${evidence.length + 1}-P${hit.startLine}`,
            ...(hit.sourceId ? { sourceId: hit.sourceId } : {}),
            ...(hit.sourceVersionId ? { sourceVersionId: hit.sourceVersionId } : {}),
            documentId: hit.documentId,
            documentVersionId: hit.documentVersionId,
            passageId: hit.passageId,
            sectionId: hit.sectionId,
            title: hit.title,
            sourceUri: hit.path,
            documentType: authorizedDocument.documentType,
            ...(authorizedDocument.jurisdiction
              ? { jurisdiction: authorizedDocument.jurisdiction }
              : {}),
            ...(authorizedDocument.validFrom
              ? { effectiveDate: authorizedDocument.validFrom }
              : authorizedDocument.publicationDate
                ? { effectiveDate: authorizedDocument.publicationDate }
                : {}),
            headingPath: hit.headingPath,
            byteRange: { from: hit.startByte, to: hit.endByte },
            lineRange: { from: hit.startLine, to: hit.endLine },
            language: hit.language,
            text: raw.toString('utf8'),
            contentSha256: rangeHash,
            retrievalReasons: unique(hit.retrievalReasons),
            score: hit.rerankerScore ?? hit.fusionScore ?? hit.retrieverScore,
          });
          if (useLazyPromotion && hit.embeddingState !== 'ready' && hit.sectionId) {
            this.onLazySection?.(
              workspaceId,
              contextId,
              publication.generationId,
              hit.sectionId,
              hit.passageId,
              signal,
            );
          }
        } catch (error) {
          degraded.push(`evidence fetch failed for passage ${hit.passageId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      timings['evidence_assembly_ms'] = elapsed(evidenceStarted);
      const answerability = assessAnswerability(
        plan,
        evidence,
        iterations,
        hasEvidenceConflict(evidence),
        firstPass,
      );
      const deliveredEvidence = answerability.abstained ? [] : evidence;
      candidateCounts['evidenceConsidered'] = evidence.length;
      candidateCounts['evidenceDelivered'] = deliveredEvidence.length;
      timings['total_ms'] = new Date().getTime() - new Date(startedAtIso).getTime();

      const selectedIds = new Set(expanded.map(hit => hit.id));
      await this.repository.appendRetrievalHits(workspaceId, contextId, ranked.map(hit => ({
        runId,
        hit,
        selectedForContext: selectedIds.has(hit.id),
        ...(!selectedIds.has(hit.id) && exclusions.get(hit.id) ? { exclusionReason: exclusions.get(hit.id)! } : {}),
      })));
      await this.repository.appendRetrievalEvidence(workspaceId, contextId, runId, evidence);
      const completed: RagV2RetrievalRunRecord = {
        ...run,
        status: 'succeeded',
        completedAt: new Date().toISOString(),
        planJson: {
          ...plan,
          authorization: {
            workspaceId,
            contextId,
            principalId: sha256(plan.authorization.principalId),
            groupIds: [],
          },
        },
        timingsJson: { timings, candidateCounts, answerability },
      };
      await this.repository.finishRetrievalRun(completed);
      return {
        runId,
        plan,
        generationId: publication.generationId,
        evidence: deliveredEvidence,
        answerability,
        degraded,
        timings,
        diagnostics: { routedCollectionIds, routedDocumentIds, routedSectionIds, candidateCounts },
      };
    } catch (error) {
      await this.repository.finishRetrievalRun({
        ...run,
        status: 'failed',
        completedAt: new Date().toISOString(),
        timingsJson: timings,
      }).catch(() => undefined);
      throw error;
    }
  }

  private async expandNeighbours(
    selected: readonly RagV2RankedHit[],
    workspaceId: string,
    contextId: string,
    generationId: string,
    limit: number,
  ): Promise<RagV2RankedHit[]> {
    const result: RagV2RankedHit[] = [];
    const seen = new Set<string>();
    for (const hit of selected) {
      if (result.length >= limit) break;
      if (!seen.has(hit.id)) {
        seen.add(hit.id);
        result.push(hit);
      }
      if (!hit.sectionId || !hit.passageId || !needsNeighbour(hit.text) || result.length >= limit) continue;
      const passages = await this.repository.passagesForSection(
        workspaceId, contextId, generationId, hit.sectionId, false,
      );
      const index = passages.findIndex(passage => passage.passageId === hit.passageId);
      for (const neighbour of [passages[index - 1], passages[index + 1]]) {
        if (!neighbour || seen.has(neighbour.passageId) || result.length >= limit) continue;
        seen.add(neighbour.passageId);
        result.push(hitFromNeighbour(hit, neighbour));
      }
    }
    return result;
  }

  private contentHashFromObjectPath(objectPath: string | undefined): string | undefined {
    return objectPath?.match(/[\\/](?<hash>[a-f0-9]{64})[\\/]source\.md$/u)?.groups?.['hash'];
  }
}
