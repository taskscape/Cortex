/** Whether RAG v2 is disabled or serves as the primary retrieval path. */
export type RagV2Mode = 'off' | 'primary';
/** Granularity level of an indexed unit. */
export type RagV2Level = 'collection' | 'document' | 'section' | 'passage';
/** Whether text is embedded as a query or as indexed document content (some models use asymmetric prefixes). */
export type RagV2EmbeddingPurpose = 'query' | 'document';
/** Retrieval strategy variants evaluated by the v2 engine. */
export type RagV2RetrievalVariant =
  | 'flat_dense_baseline'
  | 'lexical_only'
  | 'dense_only'
  | 'hybrid_rrf'
  | 'hybrid_translated'
  | 'hybrid_reranked'
  | 'hierarchical'
  | 'hierarchical_lazy';
/** Publication lifecycle state of a generation's records. */
export type RagV2PublicationState =
  | 'staging'
  | 'active_lexical'
  | 'active_hybrid_partial'
  | 'active_hybrid_complete'
  | 'retired'
  | 'quarantined';
/** Ingestion job lifecycle states. */
export type RagV2JobState =
  | 'discovered'
  | 'hashing'
  | 'parsing'
  | 'lexical_indexing'
  | 'section_embedding'
  | 'summarizing'
  | 'validating'
  | 'active_lexical'
  | 'active_hybrid_partial'
  | 'active_hybrid_complete'
  | 'paused'
  | 'cancelled'
  | 'retryable_failure'
  | 'permanent_failure'
  | 'quarantined';
/** Vector-index availability of a unit's embedding. */
export type RagV2EmbeddingState = 'not_planned' | 'queued' | 'ready' | 'failed' | 'evicted';
/**
 * Lexical-index availability of a unit.
 */
export type RagV2LexicalState = 'pending' | 'ready' | 'failed';

/** Identifies a workspace and its configuration directory. */
export interface RagV2WorkspaceRef {
  id: string;
  name: string;
  configDir: string;
}

/** Identifies an indexed context and the source paths it covers. */
export interface RagV2ContextRef {
  id: string;
  name: string;
  paths: string[];
}

/** Describes the active vectorizer; vectors are only mixable within one signature. */
export interface RagV2VectorizerInfo {
  backend: string;
  model: string;
  dimensions: number;
  signature: string;
  maxTokens?: number;
}

/** Embeds texts for query or document purposes. */
export interface RagV2Embedder {
  readonly info: RagV2VectorizerInfo;
  /**
   * Embeds a batch of texts for one purpose.
   * @param texts - Texts to embed.
   * @param purpose - Whether the texts are queries or indexed document content.
   * @param signal - Optional signal cancelling the embedding request.
   * @returns One vector per input text, in input order.
   */
  embed(
    texts: readonly string[],
    purpose: RagV2EmbeddingPurpose,
    signal?: AbortSignal,
  ): Promise<number[][]>;
}

/** A heading in a document's table of contents, addressed by line and byte offset. */
export interface RagV2HeadingRef {
  level: number;
  text: string;
  line: number;
  byte: number;
}

/** Detected language distribution over a span of text. */
export interface RagV2LanguageResult {
  primary: string | 'und';
  confidence: number;
  distribution: Record<string, number>;
  mixed: boolean;
  script: string;
}

/** A content-addressed object stored on disk plus its optional line index. */
export interface RagV2SourceObject {
  contentSha256: string;
  objectPath: string;
  lineIndexPath: string;
  byteLength: number;
}

/** Indexed document metadata with publication and embedding state. */
export interface RagV2DocumentRecord {
  documentId: string;
  documentVersionId: string;
  sourceId?: string;
  sourceVersionId?: string;
  workspaceId: string;
  contextId: string;
  aclTokens: string[];
  path: string;
  title: string;
  collectionId?: string;
  collectionTitle?: string;
  documentType: string;
  jurisdiction?: string;
  governingLaw?: string;
  parties: string[];
  publicationDate?: string;
  validFrom?: string;
  validTo?: string;
  languageDistribution: Record<string, number>;
  byteLength: number;
  lineCount: number;
  contentSha256: string;
  tableOfContents: RagV2HeadingRef[];
  routingSummary: string;
  publicationState: RagV2PublicationState;
  objectPath: string;
  lineIndexPath: string;
  modifiedAt: string;
  embeddingState: RagV2EmbeddingState;
}

/** An indexed collection grouping documents under a routing summary. */
export interface RagV2CollectionRecord {
  collectionId: string;
  collectionVersionId: string;
  generationId: string;
  workspaceId: string;
  contextId: string;
  title: string;
  documentCount: number;
  contentSha256: string;
  routingSummary: string;
  embeddingState: RagV2EmbeddingState;
  createdAt: string;
}

/**
 * Hierarchy level a routing summary was generated at.
 */
export type RagV2SummaryLevel = 'collection' | 'document' | 'section';

/**
 * A generated routing derivative. It is versioned by source content and model
 * signature, but can never be returned as answer evidence.
 */
export interface RagV2RoutingSummaryRecord {
  summaryId: string;
  workspaceId: string;
  contextId: string;
  generationId: string;
  level: RagV2SummaryLevel;
  unitId: string;
  documentVersionId?: string;
  sourceContentSha256: string;
  summarizerSignature: string;
  summary: string;
  createdAt: string;
}

/** One prior conversation turn used for query rewriting. */
export interface RagV2ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Result of rewriting the latest question into a standalone query. */
export interface RagV2QueryRewrite {
  latestQuestion: string;
  standaloneQuery: string;
  method: 'identity' | 'deterministic' | 'model';
  conversationTurnsUsed: number;
  contextHash?: string;
}

/** An indexed section: a heading-scoped byte range of a document version. */
export interface RagV2SectionRecord {
  sectionId: string;
  documentId: string;
  documentVersionId: string;
  workspaceId: string;
  contextId: string;
  ordinal: number;
  structuralType: string;
  headingPath: string[];
  headingText: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  language: string | 'und';
  languageConfidence: number;
  contentSha256: string;
  tokenCount: number;
  routingSummary: string;
  embeddingState: RagV2EmbeddingState;
}

/** An indexed passage: the atomic retrieval unit within a section. */
export interface RagV2PassageRecord {
  passageId: string;
  documentId: string;
  documentVersionId: string;
  sectionId: string;
  workspaceId: string;
  contextId: string;
  ordinal: number;
  headingPath: string[];
  structuralType: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  previousPassageId?: string;
  nextPassageId?: string;
  language: string | 'und';
  languageConfidence: number;
  languageDistribution: Record<string, number>;
  script: string;
  contentSha256: string;
  tokenCount: number;
  text: string;
  /**
   * Search-only derivative text. It may repeat structural context such as a
   * table header, while `text`, byte ranges, and hashes always describe the
   * immutable source bytes.
   */
  lexicalText?: string;
  lexicalState: RagV2LexicalState;
  embeddingState: RagV2EmbeddingState;
}

/** Parser output for one document before it is written to the repository. */
export interface RagV2ParsedDocument {
  title: string;
  lineCount: number;
  tableOfContents: RagV2HeadingRef[];
  routingSummary: string;
  languageDistribution: Record<string, number>;
  sections: RagV2SectionRecord[];
  passages: RagV2PassageRecord[];
}

/**
 * Tunable ingestion limits: passage sizing, parser memory, and rate caps.
 */
export interface RagV2IngestionPolicy {
  eagerPassageMaxBytes: number;
  asyncPassageMaxBytes: number;
  eagerPassageVectorCap: number;
  parserMemoryBytes: number;
  targetPassageTokens: number;
  hardMaxPassageTokens: number;
  lineIndexStride: number;
  storageBytesPerSecond: number;
  embeddingTextsPerSecond: number;
  sourceMetadataOpsPerSecond: number;
  contextGraphOpsPerSecond: number;
  /**
   * Files ingested concurrently within one context. Unset enables adaptive
   * concurrency: bulk backlogs run 3-wide and taper to sequential once only a
   * few files remain. An explicit value overrides (1 keeps strict order).
   */
  fileConcurrency?: number;
  /** Embedding batches kept in flight per file while Postgres writes drain. */
  embedPipelineDepth: number;
}

/** Progress record of an ingestion job over one context. */
export interface RagV2Job {
  id: string;
  workspaceId: string;
  contextId: string;
  generationId: string;
  state: RagV2JobState;
  createdAt: string;
  updatedAt: string;
  totalFiles: number;
  discoveredFiles: number;
  discoveredBytes: number;
  processedFiles: number;
  processedBytes: number;
  processedSections: number;
  processedPassages: number;
  lexicalReadyPassages: number;
  readyEmbeddings: number;
  queuedEmbeddings: number;
  throughputBytesPerSecond?: number;
  estimatedRemainingSeconds?: number;
  failedFiles: number;
  addedFiles: number;
  changedFiles: number;
  unchangedFiles: number;
  removedFiles: number;
  discoveryComplete: boolean;
  deletionsDeferred: boolean;
  /** Files this job inherited intact from the interrupted run whose generation it adopted. */
  resumedFiles: number;
  /** Checkpoint publications made while the scan was still running. */
  publishedCheckpoints: number;
  /** Configured source roots skipped because they are not currently indexable. */
  skippedPaths?: string[];
  trigger: 'startup' | 'watch' | 'interval' | 'configuration' | 'manual' | 'retry';
  currentPath?: string;
  checkpoint?: string;
  message?: string;
  cancelRequested: boolean;
  pauseRequested: boolean;
}

/** Per-file progress entry of an ingestion job. */
export interface RagV2JobItem {
  jobId: string;
  workspaceId: string;
  contextId: string;
  path: string;
  size: number;
  modifiedAt: string;
  state: RagV2JobState;
  documentId?: string;
  documentVersionId?: string;
  error?: string;
}

/** One weighted retriever/query pair produced by planning. */
export interface RagV2QueryVariant {
  retriever:
    | 'document_lexical'
    | 'document_dense'
    | 'section_lexical'
    | 'section_dense'
    | 'passage_lexical'
    | 'passage_dense_scoped'
    | 'passage_dense_global'
    | 'exact_reference'
    | 'translated_lexical';
  query: string;
  language: string;
  weight: number;
}

/** The fully resolved retrieval plan for one user question. */
export interface RagV2RetrievalPlan {
  originalQuery: string;
  latestQuestion: string;
  standaloneQuery: string;
  rewriteMethod: RagV2QueryRewrite['method'];
  conversationTurnsUsed: number;
  conversationContextHash?: string;
  queryLanguage: string | 'und';
  answerLanguage: string;
  intent: 'exact_reference' | 'fact_lookup' | 'comparison' | 'diagnostic' | 'as_of' | 'broad_synthesis';
  exactReferences: string[];
  quotedPhrases: string[];
  entities: string[];
  documentTypes: string[];
  jurisdictions: string[];
  asOfDate?: string;
  corpusLanguages: string[];
  lexicalVariants: Array<{ language: string; query: string; reason: string }>;
  iterativeQueries: Array<{ query: string; reason: string }>;
  embeddingInstruction: string;
  authorization: {
    workspaceId: string;
    contextId: string;
    principalId: string;
    groupIds: string[];
  };
}

/** A single ranked search hit at any level. */
export interface RagV2RankedHit {
  level: RagV2Level;
  id: string;
  documentId: string;
  documentVersionId: string;
  sectionId?: string;
  passageId?: string;
  path: string;
  title: string;
  headingPath: string[];
  startByte?: number;
  endByte?: number;
  startLine?: number;
  endLine?: number;
  language: string;
  text: string;
  contentSha256: string;
  retriever: string;
  retrieverRank: number;
  retrieverScore: number;
  fusionScore?: number;
  rerankerScore?: number;
  rerankerInputHash?: string;
  sourceId?: string;
  sourceVersionId?: string;
  objectPath?: string;
  lineIndexPath?: string;
  embeddingState?: RagV2EmbeddingState;
  retrievalReasons: string[];
}

/** Citation-ready evidence assembled from a hit. */
export interface RagV2Evidence {
  evidenceId: string;
  sourceId?: string;
  sourceVersionId?: string;
  documentId: string;
  documentVersionId: string;
  passageId: string;
  sectionId: string;
  title: string;
  sourceUri: string;
  documentType?: string;
  jurisdiction?: string;
  effectiveDate?: string;
  headingPath: string[];
  byteRange: { from: number; to: number };
  lineRange: { from: number; to: number };
  language: string;
  text: string;
  contentSha256: string;
  retrievalReasons: string[];
  sourceHealth?: string;
  sourceStaleness?: string;
  score: number;
}

/** Complete result of one v2 retrieval run, including answerability and diagnostics. */
export interface RagV2SearchResult {
  runId: string;
  plan: RagV2RetrievalPlan;
  generationId: string;
  evidence: RagV2Evidence[];
  answerability: {
    status: 'sufficient' | 'insufficient' | 'conflicting';
    score: number;
    abstained: boolean;
    reasons: string[];
    iterations: number;
    firstPass: {
      status: 'sufficient' | 'insufficient' | 'conflicting';
      candidateCount: number;
      reasons: string[];
    };
  };
  degraded: string[];
  timings: Record<string, number>;
  diagnostics: {
    routedCollectionIds: string[];
    routedDocumentIds: string[];
    routedSectionIds: string[];
    candidateCounts: Record<string, number>;
  };
}

/** Current status of the v2 subsystem for status reporting. */
export interface RagV2Status {
  mode: RagV2Mode;
  available: boolean;
  backend: 'postgres-pgvector' | 'memory' | 'unavailable';
  activeGenerationId?: string;
  activeState?: RagV2PublicationState;
  embeddingSignature?: string;
  job?: RagV2Job;
  /** Documents held in the database for the generation in flight, or the active publication when idle. */
  indexedDocuments: number;
  lastSuccessfulReconcileAt?: string;
  lastGc?: {
    completedAt: string;
    durationMs: number;
    documentsDeleted: number;
    passagesDeleted: number;
    sectionsDeleted: number;
    embeddingsDeleted: number;
    collectionsDeleted: number;
    routingSummariesDeleted: number;
    blobsDeleted: number;
    retiredGenerationsDeleted: number;
    deletionsSkipped: boolean;
  };
  summaries: {
    enabled: boolean;
    queued: number;
    active: number;
    completed: number;
    failed: number;
    signature?: string;
  };
  message: string;
}
