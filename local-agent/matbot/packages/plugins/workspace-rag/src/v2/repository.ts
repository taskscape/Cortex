import type {
  RagV2CollectionRecord,
  RagV2DocumentRecord,
  RagV2Evidence,
  RagV2Job,
  RagV2JobItem,
  RagV2Level,
  RagV2PassageRecord,
  RagV2PublicationState,
  RagV2RankedHit,
  RagV2RoutingSummaryRecord,
  RagV2SectionRecord,
  RagV2VectorizerInfo,
} from './types.js';

/**
 * Change-detection fingerprint for one indexed source path.
 */
export interface RagV2DocumentFingerprint {
  documentId: string;
  documentVersionId: string;
  path: string;
  byteLength: number;
  modifiedAt: string;
  contentSha256: string;
  embeddingSignature: string;
  summarySignature?: string;
}

/**
 * A published generation of a context's index, with its completeness state.
 */
export interface RagV2Publication {
  generationId: string;
  workspaceId: string;
  contextId: string;
  state: RagV2PublicationState;
  embeddingSignature: string;
  active: boolean;
  createdAt: string;
  publishedAt?: string;
}

/**
 * A stored embedding vector bound to a unit and vectorizer signature.
 */
export interface RagV2EmbeddingRecord {
  level: RagV2Level;
  unitId: string;
  documentVersionId: string;
  workspaceId: string;
  contextId: string;
  signature: string;
  inputSha256: string;
  vector: number[];
}

/**
 * Authorization scope bounding all searches (workspace/context/principal).
 */
export interface RagV2SearchScope {
  workspaceId: string;
  contextId: string;
  generationId: string;
  documentIds?: string[];
  collectionIds?: string[];
  sectionIds?: string[];
  authorizationTokens?: string[];
  documentTypes?: string[];
  jurisdictions?: string[];
  asOfDate?: string;
  lexicalLanguage?: string;
  limit: number;
}

/**
 * Persisted audit record of one retrieval run.
 */
export interface RagV2RetrievalRunRecord {
  id: string;
  workspaceId: string;
  contextId: string;
  generationId: string;
  questionHash: string;
  planJson: unknown;
  embeddingSignature: string;
  rerankerModel?: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'succeeded' | 'failed';
  timingsJson?: unknown;
}

/**
 * One hit persisted as part of a retrieval run.
 */
export interface RagV2StoredRetrievalHit {
  runId: string;
  hit: RagV2RankedHit;
  selectedForContext: boolean;
  exclusionReason?: string;
}

/**
 * Persisted audit record of one regex/grep retrieval run.
 */
export interface RagV2RegexRunRecord {
  id: string;
  workspaceId: string;
  contextId: string;
  generationId: string;
  patternHash: string;
  targetVersionCount: number;
  matchLimit: number;
  matchCount: number;
  resultBytes: number;
  durationMs: number;
  createdAt: string;
}

/**
 * Persistence contract shared by the memory and Postgres repositories:
 * generation lifecycle, job tracking, document/section/passage/embedding
 * writes, searches, and audit-run storage.
 */
export interface RagV2Repository {
  readonly backend: 'postgres-pgvector' | 'memory';
  initialize(vectorizer: RagV2VectorizerInfo): Promise<void>;
  close(): Promise<void>;

  /** Idempotent: adopting the generation an interrupted run left behind must not reset it. */
  beginGeneration(workspaceId: string, contextId: string, generationId: string): Promise<void>;
  activePublication(workspaceId: string, contextId: string): Promise<RagV2Publication | undefined>;
  generation(workspaceId: string, contextId: string, generationId: string): Promise<RagV2Publication | undefined>;
  /** Drops staging generations abandoned by earlier interrupted runs. Returns how many were removed. */
  pruneStagingGenerations(workspaceId: string, contextId: string, keepGenerationId: string): Promise<number>;
  publishGeneration(
    workspaceId: string,
    contextId: string,
    generationId: string,
    state: Extract<RagV2PublicationState, 'active_lexical' | 'active_hybrid_partial' | 'active_hybrid_complete'>,
  ): Promise<void>;
  validateGeneration(workspaceId: string, contextId: string, generationId: string): Promise<{
    valid: boolean;
    documents: number;
    sections: number;
    passages: number;
    lexicalReady: number;
    passageEmbeddings: number;
    errors: string[];
  }>;

  createJob(job: RagV2Job): Promise<void>;
  updateJob(job: RagV2Job): Promise<void>;
  currentJob(workspaceId: string, contextId: string): Promise<RagV2Job | undefined>;
  upsertJobItem(item: RagV2JobItem): Promise<void>;

  /** Documents held by `generationId`, or by the active publication when it is omitted. */
  listFingerprints(
    workspaceId: string,
    contextId: string,
    generationId?: string,
  ): Promise<RagV2DocumentFingerprint[]>;
  /** Documents held for `generationId`, or for the active publication when it is omitted. */
  countGenerationDocuments(workspaceId: string, contextId: string, generationId?: string): Promise<number>;
  beginDocument(generationId: string, document: RagV2DocumentRecord): Promise<void>;
  appendSections(sections: readonly RagV2SectionRecord[]): Promise<void>;
  appendPassages(passages: readonly RagV2PassageRecord[]): Promise<void>;
  putEmbeddings(records: readonly RagV2EmbeddingRecord[], vectorizer: RagV2VectorizerInfo): Promise<void>;
  reuseEmbeddings(
    records: readonly Omit<RagV2EmbeddingRecord, 'vector'>[],
    vectorizer: RagV2VectorizerInfo,
  ): Promise<Set<string>>;
  evictPassageEmbeddings(
    workspaceId: string,
    contextId: string,
    generationId: string,
    limit: number,
    vectorizer: RagV2VectorizerInfo,
  ): Promise<number>;
  finishDocument(generationId: string, document: RagV2DocumentRecord): Promise<void>;
  rebuildCollections(
    workspaceId: string,
    contextId: string,
    generationId: string,
  ): Promise<RagV2CollectionRecord[]>;
  findRoutingSummary(
    workspaceId: string,
    contextId: string,
    level: RagV2RoutingSummaryRecord['level'],
    sourceContentSha256: string,
    summarizerSignature: string,
  ): Promise<RagV2RoutingSummaryRecord | undefined>;
  putRoutingSummary(summary: RagV2RoutingSummaryRecord): Promise<void>;
  reconcileGeneration(
    jobId: string,
    workspaceId: string,
    contextId: string,
    generationId: string,
  ): Promise<number>;

  lexicalSearch(level: RagV2Level, query: string, scope: RagV2SearchScope): Promise<RagV2RankedHit[]>;
  exactSearch(references: readonly string[], scope: RagV2SearchScope): Promise<RagV2RankedHit[]>;
  denseSearch(
    level: RagV2Level,
    queryVector: readonly number[],
    vectorizer: RagV2VectorizerInfo,
    scope: RagV2SearchScope,
  ): Promise<RagV2RankedHit[]>;
  passagesForSection(
    workspaceId: string,
    contextId: string,
    generationId: string,
    sectionId: string,
    onlyMissingEmbeddings: boolean,
  ): Promise<RagV2PassageRecord[]>;
  documentVersion(
    workspaceId: string,
    contextId: string,
    documentVersionId: string,
    authorizationTokens: readonly string[],
  ): Promise<RagV2DocumentRecord | undefined>;
  grepDocuments(
    workspaceId: string,
    contextId: string,
    generationId: string,
    documentVersionIds: readonly string[],
    pattern: string,
    authorizationTokens: readonly string[],
    limit: number,
  ): Promise<RagV2RankedHit[]>;

  createRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void>;
  appendRetrievalHits(
    workspaceId: string,
    contextId: string,
    hits: readonly RagV2StoredRetrievalHit[],
  ): Promise<void>;
  appendRetrievalEvidence(
    workspaceId: string,
    contextId: string,
    runId: string,
    evidence: readonly RagV2Evidence[],
  ): Promise<void>;
  finishRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void>;
  saveEvaluationRun(input: {
    id: string;
    workspaceId: string;
    contextId: string;
    generationId: string;
    embeddingSignature: string;
    rerankerModel?: string;
    configuration: unknown;
    metrics: Record<string, unknown>;
    createdAt: string;
    completedAt: string;
  }): Promise<void>;
  saveRegexRun(run: RagV2RegexRunRecord): Promise<void>;
}
