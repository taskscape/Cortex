export type RagV2Mode = 'off' | 'primary';
export type RagV2Level = 'collection' | 'document' | 'section' | 'passage';
export type RagV2EmbeddingPurpose = 'query' | 'document';
export type RagV2RetrievalVariant =
  | 'flat_dense_baseline'
  | 'lexical_only'
  | 'dense_only'
  | 'hybrid_rrf'
  | 'hybrid_translated'
  | 'hybrid_reranked'
  | 'hierarchical'
  | 'hierarchical_lazy';
export type RagV2PublicationState =
  | 'staging'
  | 'active_lexical'
  | 'active_hybrid_partial'
  | 'active_hybrid_complete'
  | 'retired'
  | 'quarantined';
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
export type RagV2EmbeddingState = 'not_planned' | 'queued' | 'ready' | 'failed' | 'evicted';
export type RagV2LexicalState = 'pending' | 'ready' | 'failed';

export interface RagV2WorkspaceRef {
  id: string;
  name: string;
  configDir: string;
}

export interface RagV2ContextRef {
  id: string;
  name: string;
  paths: string[];
}

export interface RagV2VectorizerInfo {
  backend: string;
  model: string;
  dimensions: number;
  signature: string;
  maxTokens?: number;
}

export interface RagV2Embedder {
  readonly info: RagV2VectorizerInfo;
  embed(
    texts: readonly string[],
    purpose: RagV2EmbeddingPurpose,
    signal?: AbortSignal,
  ): Promise<number[][]>;
}

export interface RagV2HeadingRef {
  level: number;
  text: string;
  line: number;
  byte: number;
}

export interface RagV2LanguageResult {
  primary: string | 'und';
  confidence: number;
  distribution: Record<string, number>;
  mixed: boolean;
  script: string;
}

export interface RagV2SourceObject {
  contentSha256: string;
  objectPath: string;
  lineIndexPath: string;
  byteLength: number;
}

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

export interface RagV2ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface RagV2QueryRewrite {
  latestQuestion: string;
  standaloneQuery: string;
  method: 'identity' | 'deterministic' | 'model';
  conversationTurnsUsed: number;
  contextHash?: string;
}

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

export interface RagV2ParsedDocument {
  title: string;
  lineCount: number;
  tableOfContents: RagV2HeadingRef[];
  routingSummary: string;
  languageDistribution: Record<string, number>;
  sections: RagV2SectionRecord[];
  passages: RagV2PassageRecord[];
}

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
}

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
  /** Configured source roots skipped because they are not currently indexable. */
  skippedPaths?: string[];
  trigger: 'startup' | 'watch' | 'interval' | 'configuration' | 'manual' | 'retry';
  currentPath?: string;
  checkpoint?: string;
  message?: string;
  cancelRequested: boolean;
  pauseRequested: boolean;
}

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

export interface RagV2Status {
  mode: RagV2Mode;
  available: boolean;
  backend: 'postgres-pgvector' | 'memory' | 'unavailable';
  activeGenerationId?: string;
  activeState?: RagV2PublicationState;
  embeddingSignature?: string;
  job?: RagV2Job;
  lastSuccessfulReconcileAt?: string;
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
