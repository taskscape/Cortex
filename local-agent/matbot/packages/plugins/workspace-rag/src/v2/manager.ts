import {filesystemSource,normalizedPath,isWithinRoot,discoveryPriority,errorCode} from './source-filesystem.js';
import type {RagSourceAcquisition} from './source-filesystem.js';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { analyzeCensusFile, RagV2HyperLogLog } from './census.js';
import {
  ragV2ObjectRetentionFromEnv,
  ragV2AuditRetentionDaysFromEnv,
  ragV2CheckpointFilesFromEnv,
  ragV2ColbertUrlFromEnv,
  ragV2GcSettingsFromEnv,
  ragV2ObjectRootFromEnv,
  ragV2PolicyFromEnv,
  ragV2RerankerUrlFromEnv,
  ragV2RrfFromEnv,
  ragV2SummaryConcurrencyFromEnv,
  ragV2SummaryQueueLimitFromEnv,
  ragV2SummaryTimeoutMsFromEnv,
} from './config.js';
import {
  evaluateRagV2Results,
  type RagV2EvaluationCase,
  type RagV2EvaluationMetrics,
} from './evaluation.js';
import { RagV2ObjectStore } from './object-store.js';
import { parseMarkdownStream } from './parser.js';
import { RagV2RateLimiter } from './rate-limiter.js';
import { assertSafeRegex } from './regex-evaluator.js';
import type {
  RagV2DocumentFingerprint,
  RagV2EmbeddingRecord,
  RagV2GcResult,
  RagV2Repository,
} from './repository.js';
import { RagV2RetrievalEngine } from './retrieval.js';
import type { RagV2SemanticServices, RagV2SummaryInput } from './semantic.js';
import type {
  RagV2ConversationTurn,
  RagV2ContextRef,
  RagV2DocumentRecord,
  RagV2Embedder,
  RagV2Job,
  RagV2JobState,
  RagV2PassageRecord,
  RagV2RetrievalVariant,
  RagV2RoutingSummaryRecord,
  RagV2SearchResult,
  RagV2SectionRecord,
  RagV2Status,
  RagV2WorkspaceRef,
} from './types.js';

/**
 * A queued routing-summary unit of work: one embedding-grade summary for a
 * collection, document, section, or passage, deduplicated by source content
 * hash and summarizer signature before generation.
 */
interface SummaryTask extends RagV2SummaryInput {
  workspaceId: string;
  contextId: string;
  generationId: string;
  unitId: string;
  documentVersionId?: string;
  sourceContentSha256: string;
}

/**
 * Wraps an operation so the returned promise settles as soon as `signal`
 * aborts, rejecting with the signal's abort reason. The underlying operation
 * keeps running and its eventual settlement is ignored once aborted.
 *
 * @typeParam T - The operation's resolution value.
 * @param operation - Promise to gate on the signal.
 * @param signal - Abort signal; aborting before or during the operation rejects the wrapper.
 * @returns A promise resolving with the operation's value, rejecting with its error, or rejecting with the signal's abort reason when aborted.
 * @throws Error - The returned promise rejects with the signal's abort reason when it fires.
 */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(abortError(signal));
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Identifiers returned by a source bridge after registering one indexed
 * document with the external source registry. Either field may be omitted
 * when the registry declines to version the source.
 */
interface SourceRegistration {
  sourceId?: string;
  sourceVersionId?: string;
}

/**
 * Audit payload delivered to the manager's garbage-collection observer after
 * each orphan sweep and retired-generation cleanup for one context.
 */
export interface RagV2GcEvent {
  workspace: RagV2WorkspaceRef;
  context: RagV2ContextRef;
  result: RagV2GcResult;
  retiredGenerationsDeleted: number;
  completedAt: string;
  durationMs: number;
}

/**
 * Bridge the manager uses to register indexed documents with an external
 * source-registry-like service.
 */
export interface RagV2SourceBridge {
  /**
   * Registers one newly indexed document with the external source registry.
   * @param workspace - Owning workspace reference.
   * @param context - Owning context reference.
   * @param normalizedPath - Normalized path of the indexed file.
   * @param contentSha256 - Hex SHA-256 of the stored content.
   * @param modifiedAt - ISO-8601 modification timestamp of the source file.
   * @param summary - Generated routing summary for the document.
   * @returns Registration identifiers; either field may be undefined.
   */
  register(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    normalizedPath: string,
    contentSha256: string,
    modifiedAt: string,
    summary: string,
  ): Promise<SourceRegistration>;
  /**
   * Records that indexing one source failed.
   * @param workspace - Owning workspace reference.
   * @param context - Owning context reference.
   * @param normalizedPath - Normalized path of the file that failed to index.
   * @param error - The ingestion failure, serialized for the registry.
   */
  recordFailure(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    normalizedPath: string,
    error: unknown,
  ): Promise<void>;
  /**
   * Records that a previously indexed source disappeared from disk.
   * @param workspace - Owning workspace reference.
   * @param context - Owning context reference.
   * @param normalizedPaths - Normalized paths removed during reconciliation.
   */
  markRemoved(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    normalizedPaths: readonly string[],
  ): Promise<void>;
  /**
   * Optionally links the registered source into an external context graph.
   * @param workspace - Owning workspace reference.
   * @param context - Owning context reference.
   * @param normalizedPath - Normalized path of the indexed file.
   * @param registration - Registration returned by {@link RagV2SourceBridge.register}.
   * @param summary - Generated routing summary for the document.
   */
  enrichContextGraph?(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    normalizedPath: string,
    registration: SourceRegistration,
    summary: string,
  ): Promise<void>;
}

/**
 * Aggregate statistics from scanning a context's source roots before ingestion.
 */
export interface RagV2Census {
  files: number;
  totalBytes: number;
  largestBytes: number;
  sizeBuckets: Record<string, number>;
  largest: Array<{ path: string; bytes: number }>;
  complete: boolean;
  checkpoint?: string;
  resumedAfter?: string;
  percentiles: Record<string, number>;
  updateFrequency: Record<string, number>;
  structures: {
    headings: number;
    clauses: number;
    paragraphs: number;
    tables: number;
    estimatedPassages: number;
  };
  languages: Record<string, number>;
  mixedLanguageFiles: number;
  exactDuplicateRate: number;
  nearDuplicateRateEstimate: number;
  cardinalityErrorBound: number;
  sourceClasses: Record<string, number>;
  aclCardinality: { min: number; max: number; mean: number; histogram: Record<string, number> };
  projected: {
    lexicalBytes: number;
    immutableObjectBytes: number;
    documentVectors: number;
    sectionVectors: number;
    passageVectors: number;
    vectorBytes: number;
    hnswBytes: number;
  };
  recommendedTierThresholds: {
    eagerPassageMaxBytes: number;
    asyncPassageMaxBytes: number;
    eagerPassageVectorCap: number;
  };
  partitionPlan: {
    backend: 'postgres-pgvector';
    key: 'workspace_id/context_id/embedding_signature';
    vectorDimensions: number;
  };
  representativeSample: Array<{
    path: string;
    bytes: number;
    modifiedAt: string;
    language: string;
    contentSha256: string;
  }>;
}

/**
 * Options controlling census discovery depth and sampling.
 */
export interface RagV2CensusOptions {
  deep?: boolean;
  resumeAfter?: string;
}

/**
 * Bookkeeping for one in-flight ingestion: its live job record, abort
 * controller, and completion promise, keyed by workspace/context.
 */
interface ActiveRun {
  job: RagV2Job;
  controller: AbortController;
  promise: Promise<void>;
}

/** What requested an ingestion run; mirrors the trigger field of {@link RagV2Job}. */
type IngestionTrigger = RagV2Job['trigger'];





/**
 * Current wall-clock time as an ISO-8601 UTC timestamp.
 * @returns ISO-8601 string, e.g. `2026-09-06T12:00:00.000Z`.
 * @throws Never.
 */
function now(): string {
  return new Date().toISOString();
}





/** Files ingested concurrently when a bulk backlog is pending (adaptive mode). */
const BULK_FILE_CONCURRENCY = 3;
/** Adaptive mode tapers to sequential once this many files remain to process. */
const FILE_CONCURRENCY_TAIL_FILES = 4;





/**
 * Computes the lowercase hex SHA-256 digest of a string or buffer.
 * @param value - Content to hash.
 * @returns 64-character lowercase hex digest.
 * @throws Never.
 */
function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Deterministic input key for embedding reuse: hashes the level and the exact
 * embedding input text together so cached vectors never cross levels.
 * @param level - Record level (`document`, `section`, `passage`, or `collection`).
 * @param text - Exact text sent to the embedder.
 * @returns 64-character lowercase hex digest.
 * @throws Never.
 */
function embeddingInputSha256(level: string, text: string): string {
  return sha256(`${level}\0${text}`);
}

/**
 * Builds a deterministic, UUID-formatted identifier from a namespace and
 * value using SHA-256 bits laid out like a version-5 UUID; identical inputs
 * always yield the same id.
 * @param namespace - Scope separating identical values (e.g. `workspaceId:contextId`).
 * @param value - Stable value to identify, typically a normalized path or content hash.
 * @returns Deterministic UUID-formatted identifier.
 * @throws Never.
 */
function stableId(namespace: string, value: string): string {
  const hex = sha256(`${namespace}\0${value}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Builds the NUL-separated map key identifying a workspace/context pair in
 * the manager's in-memory bookkeeping maps.
 * @param workspaceId - Workspace id.
 * @param contextId - Context id.
 * @returns Composite map key.
 * @throws Never.
 */
function runKey(workspaceId: string, contextId: string): string {
  return `${workspaceId}\0${contextId}`;
}

/**
 * Extracts the cancellation error carried by an aborted signal, falling back
 * to a generic cancellation message when the abort reason is not an Error.
 * @param signal - Aborted (or aborting) signal whose reason is read.
 * @returns The signal's reason when it is an Error, otherwise a generic cancellation error.
 * @throws Never.
 */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Workspace RAG V2 ingestion cancelled.');
}

/**
 * Resolves after the given delay unless the signal aborts first, in which
 * case the timer is cleared and the returned promise rejects.
 * @param milliseconds - Delay before resolution.
 * @param signal - Abort signal; aborting cancels the timer and rejects.
 * @throws Error - The returned promise rejects with the signal's abort reason when it fires before the timer.
 */
async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}



/**
 * Mirrors `discoverMarkdown` traversal without stat-ing every file, so ingestion knows the
 * denominator before it starts. Unreadable directories are skipped: an approximate total is
 * better than failing the count, and discovery reports the real error moments later.
 */




/**
 * The v2 RAG subsystem orchestrator: owns ingestion jobs (discovery,
 * parsing, indexing, publication), status reporting, retrieval, evaluation,
 * census scans, and lifecycle (start/stop).
 */
export class WorkspaceRagV2Manager {
  private readonly repository: RagV2Repository;
  private readonly embedder: RagV2Embedder;
  private readonly sourceBridge: RagV2SourceBridge | undefined;
  private readonly semanticServices: RagV2SemanticServices | undefined;
  private readonly gcObserver: ((event: RagV2GcEvent) => void | Promise<void>) | undefined;
  private readonly objectStores = new Map<string, RagV2ObjectStore>();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly lastJobs = new Map<string, RagV2Job>();
  private readonly lazySections = new Map<string, {
    workspaceId: string;
    contextId: string;
    generationId: string;
    maxPassages: number;
    priorityPassageId?: string;
  }>();
  private lazyWorker: Promise<void> | undefined;
  private readonly lazyWorkerController = new AbortController();
  private readonly retrieval: Map<string, RagV2RetrievalEngine> = new Map();
  private readonly lastSuccessfulReconcile = new Map<string, string>();
  private readonly lastGc = new Map<string, NonNullable<RagV2Status['lastGc']>>();
  private readonly gcLocks = new Map<string, Promise<RagV2GcResult>>();
  private readonly gcAfterIngestion = new Map<string, { workspace: RagV2WorkspaceRef; context: RagV2ContextRef }>();
  private readonly gcQueue = new Map<string, {
    workspace: RagV2WorkspaceRef;
    context: RagV2ContextRef;
    attempt: number;
    dueAt: number;
  }>();
  private gcWorkerTimer: ReturnType<typeof setTimeout> | undefined;
  private gcWorker: Promise<void> | undefined;
  private readonly policy = ragV2PolicyFromEnv();
  private readonly rerankerUrl = ragV2RerankerUrlFromEnv();
  private readonly rrf = ragV2RrfFromEnv();
  private readonly objectRetention = ragV2ObjectRetentionFromEnv();
  private readonly checkpointFiles = ragV2CheckpointFilesFromEnv();
  private readonly colbertUrl = ragV2ColbertUrlFromEnv();
  private readonly gcSettings = ragV2GcSettingsFromEnv();
  private readonly storageLimiter = new RagV2RateLimiter(this.policy.storageBytesPerSecond);
  private readonly embeddingLimiter = new RagV2RateLimiter(this.policy.embeddingTextsPerSecond);
  private readonly sourceMetadataLimiter = new RagV2RateLimiter(this.policy.sourceMetadataOpsPerSecond);
  private readonly contextGraphLimiter = new RagV2RateLimiter(this.policy.contextGraphOpsPerSecond);
  private readonly summaryQueue: SummaryTask[] = [];
  private readonly summarySpaceWaiters: Array<() => void> = [];
  private readonly summaryIdleWaiters: Array<() => void> = [];
  private readonly summaryController = new AbortController();
  private readonly summaryConcurrency = ragV2SummaryConcurrencyFromEnv();
  private readonly summaryQueueLimit = ragV2SummaryQueueLimitFromEnv();
  private readonly summaryTimeoutMs = ragV2SummaryTimeoutMsFromEnv();
  private closing = false;
  private closePromise?: Promise<void>;
  private summaryActive = 0;
  private summaryCompleted = 0;
  private summaryFailed = 0;
  private initialized = false;
  private readonly sourceAcquisition:RagSourceAcquisition;

  /**
   * Creates the manager. Collaborators are captured as-is; policy, retention,
   * rate limiters, and background workers are initialized from the
   * environment, but no connections are opened until {@link initialize}.
   *
   * @param repository - Persistence backend for documents, jobs, and publications.
   * @param embedder - Embedding client used for document, section, passage, collection, and summary vectors.
   * @param sourceBridge - Optional bridge to an external source registry; ingestion degrades gracefully when absent.
   * @param semanticServices - Optional semantic summarizer for routing summaries; summarization is skipped when absent.
   * @param gcObserver - Optional observer invoked after each garbage-collection run; observer errors are logged, not fatal.
   * @param sourceAcquisition - Source discovery, counting, and root-selection strategy over configured Markdown paths; defaults to the filesystem implementation.
   */
  constructor(
    repository: RagV2Repository,
    embedder: RagV2Embedder,
    sourceBridge?: RagV2SourceBridge,
    semanticServices?: RagV2SemanticServices,
    gcObserver?: (event: RagV2GcEvent) => void | Promise<void>,
    sourceAcquisition:RagSourceAcquisition=filesystemSource,
  ) {
    this.sourceAcquisition=sourceAcquisition;
    this.repository = repository;
    this.embedder = embedder;
    this.sourceBridge = sourceBridge;
    this.semanticServices = semanticServices;
    this.gcObserver = gcObserver;
  }

  /**
   * Initialises repositories, vectorizers, and sidecar connections. Idempotent:
   * calls after a successful initialization return immediately.
   *
   * @throws Error - When the underlying repository initialization fails.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.repository.initialize(this.embedder.info);
    this.initialized = true;
  }

  /**
   * Stops background work and closes repository connections. Idempotent:
   * concurrent and repeated calls share one shutdown sequence, which aborts
   * ingestion, summary, lazy-embedding, and GC workers, then closes the
   * repository.
   *
   * @throws Error - When the repository fails to close.
   */
  async close(): Promise<void> {
    return this.closePromise ??= this.closeAll();
  }

  /**
   * Shutdown sequence behind {@link WorkspaceRagV2Manager.close}: sets the
   * closing flag, aborts all runs and background workers, drains their
   * promises, clears the GC queue, and closes the repository. Clearing the
   * summary queue wakes space waiters so pending enqueue calls reject.
   *
   * @throws Error - When the repository fails to close.
   */
  private async closeAll(): Promise<void> {
    this.closing = true;
    for (const run of this.runs.values()) run.controller.abort(new Error('Workspace RAG V2 manager is closing.'));
    this.summaryController.abort(new Error('Workspace RAG V2 manager is closing.'));
    this.summaryQueue.splice(0);
    for (const wake of this.summarySpaceWaiters.splice(0)) wake();
    this.lazyWorkerController.abort(new Error('Workspace RAG V2 manager is closing.'));
    await Promise.allSettled([...this.runs.values()].map(run => run.promise));
    await this.waitForSummaries();
    await this.lazyWorker?.catch(() => undefined);
    if (this.gcWorkerTimer) clearTimeout(this.gcWorkerTimer);
    this.gcQueue.clear();
    await this.gcWorker?.catch(() => undefined);
    await this.repository.close();
  }

  /**
   * Builds a status snapshot for one context: the active publication, the
   * live or last known job (the in-memory job wins when it is newer than or
   * identical to the stored one), the indexed document count, summary
   * pipeline counters, and a composed human-readable message. Repository
   * lookups run through `Promise.allSettled`, so storage failures degrade
   * `available` and feed the message instead of rejecting.
   *
   * @param mode - Operating mode echoed back in the status.
   * @param workspace - Workspace to report on.
   * @param context - Context to report on.
   * @returns Status snapshot; the included `job` is a deep clone.
   * @throws Never.
   */
  async status(
    mode: RagV2Status['mode'],
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
  ): Promise<RagV2Status> {
    const key = runKey(workspace.id, context.id);
    const run = this.runs.get(key);
    const results = await Promise.allSettled([
      this.repository.activePublication(workspace.id, context.id),
      this.repository.currentJob(workspace.id, context.id),
      this.repository.countGenerationDocuments(workspace.id, context.id, run?.job.generationId),
    ]);
    const publication = results[0].status === 'fulfilled' ? results[0].value : undefined;
    const storedJob = results[1].status === 'fulfilled' ? results[1].value : undefined;
    const remembered = this.lastJobs.get(key);
    const job = run?.job ?? (remembered && (!storedJob || remembered.id === storedJob.id
      || remembered.createdAt >= storedJob.createdAt) ? remembered : storedJob);
    const indexedDocuments = results[2].status === 'fulfilled' ? results[2].value : 0;
    const storageErrors = results.flatMap(result => result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    return {
      mode,
      available: this.initialized && storageErrors.length === 0,
      backend: this.repository.backend,
      indexedDocuments,
      ...(publication ? {
        activeGenerationId: publication.generationId,
        activeState: publication.state,
        embeddingSignature: publication.embeddingSignature,
      } : {}),
      ...(job ? { job: structuredClone(job) } : {}),
      ...(this.lastSuccessfulReconcile.get(runKey(workspace.id, context.id))
        ? { lastSuccessfulReconcileAt: this.lastSuccessfulReconcile.get(runKey(workspace.id, context.id))! }
        : {}),
      ...(this.lastGc.get(runKey(workspace.id, context.id))
        ? { lastGc: this.lastGc.get(runKey(workspace.id, context.id))! }
        : {}),
      summaries: {
        enabled: Boolean(this.semanticServices?.summarize && this.semanticServices.summarizerSignature),
        queued: this.summaryQueue.length,
        active: this.summaryActive,
        completed: this.summaryCompleted,
        failed: this.summaryFailed,
        ...(this.semanticServices?.summarizerSignature
          ? { signature: this.semanticServices.summarizerSignature }
          : {}),
      },
      message: [
        ...(storageErrors.length ? [`Workspace RAG storage is unavailable: ${[...new Set(storageErrors)].join('; ')}.`] : []),
        ...(job?.message ? [job.message] : []),
        publication
          ? `Workspace RAG V2 publication ${publication.generationId} is ${publication.state}.`
          : 'Workspace RAG V2 has no active publication.',
        ...(job?.skippedPaths?.length
          ? [`Skipped ${job.skippedPaths.length} unavailable configured path${job.skippedPaths.length === 1 ? '' : 's'}.`]
          : []),
      ].join(' '),
    };
  }

  /**
   * Starts an ingestion run for the context, or returns the active run's job
   * unchanged when one already exists (single-flight per context). The job
   * record is created synchronously and mutated in place as the background
   * run progresses; run failures are logged, never surfaced to the caller.
   *
   * @param workspace - Workspace to index.
   * @param context - Context whose configured paths are indexed.
   * @param trigger - What requested the run; defaults to `'manual'`.
   * @param forcePaths - Paths to re-ingest even when fingerprints match; normalized before use, defaults to none.
   * @param forceAll - Re-ingest every file regardless of fingerprint match; defaults to false.
   * @returns The new (or already active) job record.
   * @throws Error - When the manager is closing.
   */
  startIngestion(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    trigger: IngestionTrigger = 'manual',
    forcePaths: readonly string[] = [],
    forceAll = false,
  ): RagV2Job {
    if (this.closing) throw new Error('Workspace RAG V2 manager is closing.');
    const key = runKey(workspace.id, context.id);
    const existing = this.runs.get(key);
    if (existing) return existing.job;
    const controller = new AbortController();
    const createdAt = now();
    const job: RagV2Job = {
      id: randomUUID(),
      workspaceId: workspace.id,
      contextId: context.id,
      generationId: randomUUID(),
      state: 'discovered',
      createdAt,
      updatedAt: createdAt,
      totalFiles: 0,
      discoveredFiles: 0,
      discoveredBytes: 0,
      processedFiles: 0,
      processedBytes: 0,
      processedSections: 0,
      processedPassages: 0,
      lexicalReadyPassages: 0,
      readyEmbeddings: 0,
      queuedEmbeddings: 0,
      failedFiles: 0,
      addedFiles: 0,
      changedFiles: 0,
      unchangedFiles: 0,
      removedFiles: 0,
      discoveryComplete: false,
      deletionsDeferred: false,
      resumedFiles: 0,
      publishedCheckpoints: 0,
      trigger,
      cancelRequested: false,
      pauseRequested: false,
      message: 'Workspace RAG V2 discovery is starting.',
    };
    const promise = this.runIngestion(
      workspace,
      context,
      job,
      controller.signal,
      new Set(forcePaths.map(normalizedPath)),
      forceAll,
    )
      .catch(error => {
        console.warn(`[workspace-rag-v2] ingestion ${job.id} stopped: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.lastJobs.set(key, structuredClone(job));
        if (this.runs.get(key)?.job.id === job.id) this.runs.delete(key);
        const gc = this.gcAfterIngestion.get(key);
        if (gc) {
          this.gcAfterIngestion.delete(key);
          this.scheduleGarbageCollection(gc.workspace, gc.context);
        }
      });
    this.runs.set(key, { job, controller, promise });
    return job;
  }

  /**
   * Resolves when the context's current job reaches a terminal state.
   * @param workspaceId - Workspace id.
   * @param contextId - Context id.
   * @returns The terminal job, including failure details when ingestion failed.
   * @throws Error - When the stored job lookup fails.
   */
  async waitForIngestion(workspaceId: string, contextId: string): Promise<RagV2Job | undefined> {
    const key = runKey(workspaceId, contextId);
    const run = this.runs.get(key);
    await run?.promise;
    const job = run?.job ?? this.lastJobs.get(key) ?? await this.repository.currentJob(workspaceId, contextId);
    return job ? structuredClone(job) : undefined;
  }

  /**
   * Runs one orphan sweep and retired-generation cleanup for a context.
   * Concurrent calls for the same context share a single in-flight operation
   * instead of starting a second sweep; the repository is initialized first.
   *
   * @param workspace - Workspace to clean.
   * @param context - Context to clean.
   * @returns Deletion counts from the sweep; `deletionsSkipped` is set when ingestion is active.
   * @throws Error - When initialization or the sweep fails.
   */
  async garbageCollect(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
  ): Promise<RagV2GcResult> {
    await this.initialize();
    const key = runKey(workspace.id, context.id);
    const existing = this.gcLocks.get(key);
    if (existing) return existing;
    const operation = this.performGarbageCollection(workspace, context)
      .finally(() => this.gcLocks.delete(key));
    this.gcLocks.set(key, operation);
    return operation;
  }

  /**
   * Cancels local ingestion if needed, then idempotently purges non-audit
   * context state: queued and in-flight summaries, pending GC work, lazy
   * embedding scopes, repository records, and — in managed retention mode —
   * unreferenced content blobs older than the grace period. In-memory
   * bookkeeping for the context is cleared on success.
   *
   * @param workspace - Workspace owning the context.
   * @param context - Context to purge.
   * @throws Error - When cancellation, the purge, or blob pruning fails.
   */
  async purgeContext(workspace: RagV2WorkspaceRef, context: RagV2ContextRef): Promise<void> {
    const key = runKey(workspace.id, context.id);
    if (this.runs.has(key)) await this.cancel(workspace.id, context.id);
    await this.gcLocks.get(key)?.catch(() => undefined);
    this.gcQueue.delete(key);
    this.gcAfterIngestion.delete(key);
    await this.waitForSummaries();
    await this.waitForLazyWorker();
    await this.repository.purgeContext(workspace.id, context.id);
    if (this.gcSettings.blobGcEnabled && this.objectRetention.mode === 'managed') {
      await this.objectStore(workspace).pruneUnreferenced(
        await this.repository.listReferencedContentHashes(),
        new Date(Date.now() - this.gcSettings.graceMs).toISOString(),
      );
    }
    this.lastGc.delete(key);
    this.lastSuccessfulReconcile.delete(key);
    this.lastJobs.delete(key);
  }

  /**
   * Requests a pause of the context's running job at the next safe boundary.
   * With no active run, the stored job is returned unchanged.
   *
   * @param workspaceId - Workspace id.
   * @param contextId - Context id.
   * @returns The updated live job, or the stored job, or undefined when none is active.
   * @throws Error - When persisting the updated job fails.
   */
  async pause(workspaceId: string, contextId: string): Promise<RagV2Job | undefined> {
    const run = this.runs.get(runKey(workspaceId, contextId));
    if (!run) return this.repository.currentJob(workspaceId, contextId);
    run.job.pauseRequested = true;
    run.job.state = 'paused';
    run.job.updatedAt = now();
    run.job.message = 'Workspace RAG V2 ingestion is paused at the next safe boundary.';
    await this.repository.updateJob(run.job);
    return run.job;
  }

  /**
   * Resumes a paused job by clearing the pause request and returning the run
   * to its discovery state. With no active run, the stored job is returned
   * unchanged.
   *
   * @param workspaceId - Workspace id.
   * @param contextId - Context id.
   * @returns The updated live job, or the stored job, or undefined when there is nothing to resume.
   * @throws Error - When persisting the updated job fails.
   */
  async resume(workspaceId: string, contextId: string): Promise<RagV2Job | undefined> {
    const run = this.runs.get(runKey(workspaceId, contextId));
    if (!run) return this.repository.currentJob(workspaceId, contextId);
    run.job.pauseRequested = false;
    run.job.state = 'discovered';
    run.job.updatedAt = now();
    run.job.message = 'Workspace RAG V2 ingestion resumed.';
    await this.repository.updateJob(run.job);
    return run.job;
  }

  /**
   * Requests cancellation of the context's current job: flags the job, aborts
   * the run's controller, and waits for the run to settle before returning.
   * With no active run, the stored job is returned unchanged.
   *
   * @param workspaceId - Workspace id.
   * @param contextId - Context id.
   * @returns The updated live job, or the stored job, or undefined when none is active.
   * @throws Error - When persisting the updated job fails.
   */
  async cancel(workspaceId: string, contextId: string): Promise<RagV2Job | undefined> {
    const run = this.runs.get(runKey(workspaceId, contextId));
    if (!run) return this.repository.currentJob(workspaceId, contextId);
    run.job.cancelRequested = true;
    run.job.updatedAt = now();
    run.job.message = 'Workspace RAG V2 cancellation requested.';
    await this.repository.updateJob(run.job);
    run.controller.abort(new Error('Workspace RAG V2 ingestion cancelled by request.'));
    await run.promise.catch(() => undefined);
    return run.job;
  }

  /**
   * Runs a retrieval query against the context's active publication via the
   * per-workspace retrieval engine, which is created lazily on first use.
   *
   * @param workspace - Workspace to search.
   * @param context - Context to search.
   * @param query - Natural-language query text.
   * @param options - Optional authorization scopes, match limit, filters, retrieval variant, conversation context, and rewrite/iterative settings; defaults to all-empty.
   * @param signal - Optional abort signal forwarded to the retrieval engine.
   * @returns Search results with evidence passages, diagnostics, and answer material.
   * @throws Error - When the workspace id is invalid, there is no active publication, or the retrieval engine fails.
   */
  async search(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    query: string,
    options: {
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
    } = {},
    signal?: AbortSignal,
  ): Promise<RagV2SearchResult> {
    const engine = this.retrievalEngine(workspace);
    return engine.search(workspace.id, context.id, query, options, signal);
  }

  /**
   * Resolves when all queued routing-summary tasks have drained, returning
   * immediately when the pipeline is already idle. Used by shutdown, purge,
   * and garbage collection so summaries cannot recreate swept state.
   *
   * @throws Never.
   */
  async waitForSummaries(): Promise<void> {
    if (this.summaryQueue.length === 0 && this.summaryActive === 0) return;
    await new Promise<void>(resolve => this.summaryIdleWaiters.push(resolve));
  }

  /**
   * Queues one routing-summary task and starts the summary pump. No-op when
   * summarization is disabled (no semantic services or signature). While the
   * queue is at its limit, waits for space until either the caller's signal
   * or the manager's closing signal aborts.
   *
   * @param task - Summary unit of work with workspace/context/generation scope and source content hash.
   * @param signal - Caller's abort signal; combined with the manager's closing signal while waiting for space.
   * @throws Error - The returned promise rejects with the abort reason when the combined signal fires while waiting for queue space.
   */
  private async enqueueSummary(task: SummaryTask, signal: AbortSignal): Promise<void> {
    if (!this.semanticServices?.summarize || !this.semanticServices.summarizerSignature) return;
    const combined = AbortSignal.any([signal, this.summaryController.signal]);
    while (this.summaryQueue.length >= this.summaryQueueLimit && !this.summaryController.signal.aborted) {
      combined.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          combined.removeEventListener('abort', abort);
          const index = this.summarySpaceWaiters.indexOf(wake);
          if (index >= 0) this.summarySpaceWaiters.splice(index, 1);
        };
        const wake = (): void => { cleanup(); resolve(); };
        const abort = (): void => { cleanup(); reject(abortError(combined)); };
        this.summarySpaceWaiters.push(wake);
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) abort();
      });
    }
    combined.throwIfAborted();
    this.summaryQueue.push(task);
    this.pumpSummaryQueue();
  }

  /**
   * Drains the summary queue while concurrency slots are free and the
   * pipeline is not closed, running each task under a per-task timeout
   * signal. Tracks completion and failure counters, wakes idle waiters when
   * the pipeline empties, and releases both idle and space waiters once a
   * close has fully drained.
   *
   * @throws Never.
   */
  private pumpSummaryQueue(): void {
    while (
      this.summaryActive < this.summaryConcurrency
      && this.summaryQueue.length > 0
      && !this.summaryController.signal.aborted
    ) {
      const task = this.summaryQueue.shift()!;
      this.summarySpaceWaiters.shift()?.();
      this.summaryActive++;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error(`Semantic summary timed out after ${this.summaryTimeoutMs}ms.`)), this.summaryTimeoutMs);
      const signal = AbortSignal.any([this.summaryController.signal, deadline.signal]);
      void this.runSummaryTask(task, signal)
        .then(() => { this.summaryCompleted++; })
        .catch(error => {
          if (!this.summaryController.signal.aborted) {
            this.summaryFailed++;
            console.warn(`[workspace-rag-v2] ${task.level} summary failed for ${task.unitId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        })
        .finally(() => {
          clearTimeout(timer);
          this.summaryActive--;
          if (this.summaryQueue.length === 0 && this.summaryActive === 0) {
            for (const resolve of this.summaryIdleWaiters.splice(0)) resolve();
          } else {
            this.pumpSummaryQueue();
          }
        });
    }
    if (this.summaryController.signal.aborted && this.summaryActive === 0) {
      for (const resolve of this.summaryIdleWaiters.splice(0)) resolve();
      for (const resolve of this.summarySpaceWaiters.splice(0)) resolve();
    }
  }

  /**
   * Executes one summary task: reuses a stored summary for the same level,
   * content hash, and summarizer signature when available; otherwise calls
   * the semantic summarizer, collapses whitespace, truncates to 2000
   * characters, and persists the routing summary. Then embeds
   * `title + summary` and stores the vector when its dimensionality matches
   * the embedder; dimension mismatches are silently dropped.
   *
   * @param task - Summary unit of work.
   * @param signal - Abort signal checked between stages and applied to summarizer and embedding calls.
   * @throws Error - When the summarizer returns no usable text; also propagates abort reasons and repository failures.
   */
  private async runSummaryTask(task: SummaryTask, signal: AbortSignal): Promise<void> {
    const signature = this.semanticServices?.summarizerSignature;
    const summarize = this.semanticServices?.summarize;
    if (!signature || !summarize || signal.aborted) return;
    const reusable = await this.repository.findRoutingSummary(
      task.workspaceId,
      task.contextId,
      task.level,
      task.sourceContentSha256,
      signature,
    );
    signal.throwIfAborted();
    const generated = reusable?.summary ?? await abortable(summarize({
      level: task.level,
      title: task.title,
      breadcrumb: task.breadcrumb,
      text: task.text,
    }, signal), signal);
    signal.throwIfAborted();
    const summaryText = generated?.replace(/\s+/gu, ' ').trim().slice(0, 2_000);
    if (!summaryText) throw new Error('semantic summarizer returned no usable text');
    const record: RagV2RoutingSummaryRecord = {
      summaryId: sha256(`${task.level}\0${task.unitId}\0${task.sourceContentSha256}\0${signature}`),
      workspaceId: task.workspaceId,
      contextId: task.contextId,
      generationId: task.generationId,
      level: task.level,
      unitId: task.unitId,
      ...(task.documentVersionId ? { documentVersionId: task.documentVersionId } : {}),
      sourceContentSha256: task.sourceContentSha256,
      summarizerSignature: signature,
      summary: summaryText,
      createdAt: now(),
    };
    await this.repository.putRoutingSummary(record);
    const summaryEmbeddingText = `${task.title}\n${summaryText}`;
    signal.throwIfAborted();
    const vector = (await abortable(this.embedder.embed([summaryEmbeddingText], 'document', signal), signal))[0];
    signal.throwIfAborted();
    if (vector?.length !== this.embedder.info.dimensions) return;
    await this.repository.putEmbeddings([{
      level: task.level,
      unitId: task.unitId,
      documentVersionId: task.documentVersionId ?? task.unitId,
      workspaceId: task.workspaceId,
      contextId: task.contextId,
      signature: this.embedder.info.signature,
      inputSha256: embeddingInputSha256(task.level, summaryEmbeddingText),
      vector,
    }], this.embedder.info);
  }

  /**
   * Reads a byte range from an indexed document's stored object after
   * checking the caller's authorization tokens against the document.
   *
   * @param workspace - Workspace owning the document.
   * @param context - Context owning the document.
   * @param documentVersionId - Document version to read from.
   * @param startByte - Inclusive start offset in bytes.
   * @param endByte - End offset in bytes.
   * @param principalId - Caller identity for authorization; defaults to `'local-user'`.
   * @param groupIds - Caller group ids for authorization; defaults to none.
   * @returns Document metadata, the echoed byte range, the range's content SHA-256, and the decoded UTF-8 text.
   * @throws Error - When the workspace id is invalid, the document version is unavailable or unauthorized, or the byte range is invalid or too large.
   */
  async fetchSourceRange(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    documentVersionId: string,
    startByte: number,
    endByte: number,
    principalId = 'local-user',
    groupIds: readonly string[] = [],
  ): Promise<unknown> {
    const tokens = this.authorizationTokens(workspace.id, principalId, groupIds);
    const document = await this.repository.documentVersion(
      workspace.id, context.id, documentVersionId, tokens,
    );
    if (!document) throw new Error('Workspace RAG V2 document version is unavailable or unauthorized.');
    const raw = await this.objectStore(workspace).fetchRange(document.contentSha256, startByte, endByte);
    return {
      documentId: document.documentId,
      documentVersionId: document.documentVersionId,
      sourceId: document.sourceId,
      sourceVersionId: document.sourceVersionId,
      path: document.path,
      byteRange: { from: startByte, to: endByte },
      contentSha256: sha256(raw),
      text: raw.toString('utf8'),
    };
  }

  /**
   * Reads a line range from an indexed document via its line index after
   * checking the caller's authorization tokens against the document.
   *
   * @param workspace - Workspace owning the document.
   * @param context - Context owning the document.
   * @param documentVersionId - Document version to read from.
   * @param startLine - Inclusive 1-based start line.
   * @param endLine - Inclusive 1-based end line.
   * @param principalId - Caller identity for authorization; defaults to `'local-user'`.
   * @param groupIds - Caller group ids for authorization; defaults to none.
   * @returns Document metadata, the echoed line range, the covered byte range, and the requested lines joined with newlines.
   * @throws Error - When the workspace id is invalid, the document version is unavailable or unauthorized, or the line range is invalid.
   */
  async fetchLines(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    documentVersionId: string,
    startLine: number,
    endLine: number,
    principalId = 'local-user',
    groupIds: readonly string[] = [],
  ): Promise<unknown> {
    const tokens = this.authorizationTokens(workspace.id, principalId, groupIds);
    const document = await this.repository.documentVersion(
      workspace.id, context.id, documentVersionId, tokens,
    );
    if (!document) throw new Error('Workspace RAG V2 document version is unavailable or unauthorized.');
    const range = await this.objectStore(workspace).fetchLines(
      document.contentSha256, startLine, endLine,
    );
    return {
      documentId: document.documentId,
      documentVersionId: document.documentVersionId,
      sourceId: document.sourceId,
      sourceVersionId: document.sourceVersionId,
      path: document.path,
      lineRange: { from: startLine, to: endLine },
      byteRange: { from: range.startByte, to: range.endByte },
      text: range.text,
    };
  }

  /**
   * Regex/substring search over indexed documents with authorization scoping
   * and persisted audit runs. Requires an active publication; the match limit
   * is clamped to 1-100 and results are additionally capped at 2 MiB of text.
   * The pattern is validated for safety before execution, and an audit record
   * (pattern hash, counts, result bytes, duration) is always persisted.
   *
   * @param workspace - Workspace owning the documents.
   * @param context - Context whose active publication scopes the search.
   * @param documentVersionIds - Document versions to search; must contain 1-50 entries.
   * @param pattern - Regular expression evaluated by the repository.
   * @param limit - Requested match limit before clamping; defaults to 50.
   * @param principalId - Caller identity for authorization; defaults to `'local-user'`.
   * @param groupIds - Caller group ids for authorization; defaults to none.
   * @returns The publication generation id, the pattern, and matches with line/byte ranges and text.
   * @throws Error - When the version count is outside 1-50, the pattern fails safety validation or is invalid, or there is no active publication.
   */
  async grepDocuments(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    documentVersionIds: readonly string[],
    pattern: string,
    limit = 50,
    principalId = 'local-user',
    groupIds: readonly string[] = [],
  ): Promise<unknown> {
    if (documentVersionIds.length === 0 || documentVersionIds.length > 50) {
      throw new Error('Workspace RAG V2 regex requires between 1 and 50 authorized document versions.');
    }
    assertSafeRegex(pattern);
    const publication = await this.repository.activePublication(workspace.id, context.id);
    if (!publication) throw new Error('Workspace RAG V2 has no active publication for this context.');
    const startedAt = Date.now();
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const hits = await this.repository.grepDocuments(
      workspace.id,
      context.id,
      publication.generationId,
      documentVersionIds,
      pattern,
      this.authorizationTokens(workspace.id, principalId, groupIds),
      safeLimit,
    );
    const boundedHits: typeof hits = [];
    let resultBytes = 0;
    for (const hit of hits) {
      const bytes = Buffer.byteLength(hit.text);
      if (resultBytes + bytes > 2 * 1024 * 1024) break;
      boundedHits.push(hit);
      resultBytes += bytes;
    }
    await this.repository.saveRegexRun({
      id: randomUUID(),
      workspaceId: workspace.id,
      contextId: context.id,
      generationId: publication.generationId,
      patternHash: sha256(pattern),
      targetVersionCount: documentVersionIds.length,
      matchLimit: safeLimit,
      matchCount: boundedHits.length,
      resultBytes,
      durationMs: Date.now() - startedAt,
      createdAt: now(),
    });
    return {
      generationId: publication.generationId,
      pattern,
      matches: boundedHits.map(hit => ({
        documentId: hit.documentId,
        documentVersionId: hit.documentVersionId,
        passageId: hit.passageId,
        sectionId: hit.sectionId,
        path: hit.path,
        headingPath: hit.headingPath,
        lineRange: { from: hit.startLine, to: hit.endLine },
        byteRange: { from: hit.startByte, to: hit.endByte },
        text: hit.text,
      })),
    };
  }

  /**
   * Removes embeddings not touched within the retention window to reclaim
   * space. Requires an active publication; the batch limit is clamped to
   * 1-100000. After eviction the generation is revalidated and republished as
   * `active_lexical`, `active_hybrid_complete`, or `active_hybrid_partial` to
   * reflect the new embedding coverage.
   *
   * @param workspace - Workspace owning the publication.
   * @param context - Context owning the publication.
   * @param limit - Requested eviction batch size before clamping; defaults to 1000.
   * @returns The generation id, the number of embeddings evicted, and the republished state.
   * @throws Error - When there is no active publication or repository access fails.
   */
  async evictColdPassageEmbeddings(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    limit = 1_000,
  ): Promise<{ generationId: string; evicted: number; state: string }> {
    const publication = await this.repository.activePublication(workspace.id, context.id);
    if (!publication) throw new Error('Workspace RAG V2 has no active publication to evict.');
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100_000));
    const evicted = await this.repository.evictPassageEmbeddings(
      workspace.id,
      context.id,
      publication.generationId,
      safeLimit,
      this.embedder.info,
    );
    const validation = await this.repository.validateGeneration(
      workspace.id, context.id, publication.generationId,
    );
    const state = validation.passageEmbeddings === 0
      ? 'active_lexical'
      : validation.passageEmbeddings === validation.passages
        ? 'active_hybrid_complete'
        : 'active_hybrid_partial';
    await this.repository.publishGeneration(
      workspace.id,
      context.id,
      publication.generationId,
      state,
    );
    return { generationId: publication.generationId, evicted, state };
  }

  /**
   * Runs retrieval against evaluation cases and scores recall/precision.
   * Requires an active publication; cases must number 1-1000, and search
   * depth is capped at 25 with metrics reporting the searched k rather than a
   * requested k the corpus never produced. Cases run sequentially so aborts
   * are honored between searches; the run configuration and metrics are
   * persisted.
   *
   * @param workspace - Workspace to evaluate.
   * @param context - Context to evaluate.
   * @param cases - Evaluation cases with queries and expected evidence.
   * @param k - Requested search depth before the 25 cap; defaults to 10.
   * @param variant - Retrieval variant to evaluate; defaults to `'hierarchical_lazy'`.
   * @param signal - Optional abort signal checked between cases and forwarded to each search.
   * @returns The run id, the publication generation id, and aggregate plus per-case metrics.
   * @throws Error - When the case count is outside 1-1000, there is no active publication, or a search fails; also propagates the abort reason.
   */
  async evaluate(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    cases: readonly RagV2EvaluationCase[],
    k = 10,
    variant: RagV2RetrievalVariant = 'hierarchical_lazy',
    signal?: AbortSignal,
  ): Promise<{ runId: string; generationId: string; metrics: RagV2EvaluationMetrics }> {
    if (cases.length === 0 || cases.length > 1_000) {
      throw new Error('Workspace RAG V2 evaluation requires between 1 and 1,000 cases.');
    }
    const publication = await this.repository.activePublication(workspace.id, context.id);
    if (!publication) throw new Error('Workspace RAG V2 has no active publication for evaluation.');
    const runId = randomUUID();
    const createdAt = now();
    // Search depth is capped at 25; metrics must report the k actually
    // searched, not a requested k the corpus never produced.
    const searchedK = Math.max(1, Math.min(k, 25));
    const results: Array<{
      testCase: RagV2EvaluationCase;
      evidence: Array<{
        passageId: string;
        documentVersionId: string;
        startByte: number;
        endByte: number;
        startLine: number;
        endLine: number;
        contentSha256: string;
        sectionId: string;
      }>;
      routedSectionIds: string[];
    }> = [];
    for (const testCase of cases) {
      if (signal?.aborted) throw abortError(signal);
      const search = await this.search(
        workspace,
        context,
        testCase.query,
        { limit: searchedK, variant },
        signal,
      );
      results.push({
        testCase,
        evidence: search.evidence.map(value => ({
          passageId: value.passageId,
          documentVersionId: value.documentVersionId,
          startByte: value.byteRange.from,
          endByte: value.byteRange.to,
          startLine: value.lineRange.from,
          endLine: value.lineRange.to,
          contentSha256: value.contentSha256,
          sectionId: value.sectionId,
        })),
        routedSectionIds: search.diagnostics.routedSectionIds,
      });
    }
    const metrics = evaluateRagV2Results(results, searchedK);
    const completedAt = now();
    await this.repository.saveEvaluationRun({
      id: runId,
      workspaceId: workspace.id,
      contextId: context.id,
      generationId: publication.generationId,
      embeddingSignature: this.embedder.info.signature,
      ...(this.rerankerUrl ? { rerankerModel: this.rerankerUrl } : {}),
      configuration: {
        k: searchedK,
        variant,
        cases: cases.map(value => ({ id: value.id, category: value.category })),
      },
      metrics: metrics as unknown as Record<string, unknown>,
      createdAt,
      completedAt,
    });
    return { runId, generationId: publication.generationId, metrics };
  }

  /**
   * Scans a context's source roots without ingesting, producing file counts,
   * byte totals, size percentiles, language and structure statistics,
   * duplicate rate estimates (deep mode only), and storage/vector
   * projections. Aborts end the scan early with `complete: false` instead of
   * throwing; when `deep` is enabled each file is additionally analyzed for
   * structure and language.
   *
   * @param paths - Configured source paths to scan.
   * @param signal - Abort signal; defaults to a never-aborted signal.
   * @param options - `deep` (default true) enables per-file analysis; `resumeAfter` is a normalized checkpoint path — files at or before it lexicographically are skipped.
   * @returns The census report, carrying a `checkpoint` path for resumable scans.
   * @throws Error - When discovery or per-file analysis fails for a non-abort reason.
   */
  async census(
    paths: readonly string[],
    signal = new AbortController().signal,
    options: RagV2CensusOptions = {},
  ): Promise<RagV2Census> {
    const deep = options.deep ?? true;
    const exactCardinality = new RagV2HyperLogLog();
    const similarityCardinality = new RagV2HyperLogLog();
    const sizeHistogram = new Uint32Array(1024);
    const languageWeights: Record<string, number> = {};
    const updateFrequency: Record<string, number> = {
      '<=7d': 0, '8-30d': 0, '31-90d': 0, '91-365d': 0, '>365d': 0,
    };
    const sourceClasses: Record<string, number> = { current: 0, archive: 0, authority: 0 };
    const structures = { headings: 0, clauses: 0, paragraphs: 0, tables: 0, estimatedPassages: 0 };
    let mixedLanguageFiles = 0;
    let sectionVectors = 0;
    let passageVectors = 0;
    const representative: Array<RagV2Census['representativeSample'][number] & { priority: string }> = [];
    const result: RagV2Census = {
      files: 0,
      totalBytes: 0,
      largestBytes: 0,
      sizeBuckets: {
        '0-1MiB': 0,
        '1-20MiB': 0,
        '20-250MiB': 0,
        '250MiB-2GiB': 0,
        '>2GiB': 0,
      },
      largest: [],
      complete: true,
      ...(options.resumeAfter ? { resumedAfter: normalizedPath(options.resumeAfter) } : {}),
      percentiles: {},
      updateFrequency,
      structures,
      languages: languageWeights,
      mixedLanguageFiles: 0,
      exactDuplicateRate: 0,
      nearDuplicateRateEstimate: 0,
      cardinalityErrorBound: exactCardinality.relativeError(),
      sourceClasses,
      aclCardinality: { min: 1, max: 1, mean: 1, histogram: { '1': 0 } },
      projected: {
        lexicalBytes: 0,
        immutableObjectBytes: 0,
        documentVectors: 0,
        sectionVectors: 0,
        passageVectors: 0,
        vectorBytes: 0,
        hnswBytes: 0,
      },
      recommendedTierThresholds: {
        eagerPassageMaxBytes: this.policy.eagerPassageMaxBytes,
        asyncPassageMaxBytes: this.policy.asyncPassageMaxBytes,
        eagerPassageVectorCap: this.policy.eagerPassageVectorCap,
      },
      partitionPlan: {
        backend: 'postgres-pgvector',
        key: 'workspace_id/context_id/embedding_signature',
        vectorDimensions: this.embedder.info.dimensions,
      },
      representativeSample: [],
    };
    const resumedAfter = options.resumeAfter ? normalizedPath(options.resumeAfter) : undefined;
    for await (const file of this.sourceAcquisition.discoverMarkdown(paths, signal)) {
      if (resumedAfter && file.path.localeCompare(resumedAfter) <= 0) continue;
      if (signal.aborted) {
        result.complete = false;
        break;
      }
      result.files++;
      result.totalBytes += file.size;
      result.checkpoint = file.path;
      result.largestBytes = Math.max(result.largestBytes, file.size);
      const sizeBin = Math.min(sizeHistogram.length - 1, Math.floor(Math.log2(file.size + 1) * 32));
      sizeHistogram[sizeBin] = sizeHistogram[sizeBin]! + 1;
      const mib = file.size / (1024 * 1024);
      const bucket = mib < 1 ? '0-1MiB' : mib < 20 ? '1-20MiB' : mib < 250 ? '20-250MiB' : mib <= 2048 ? '250MiB-2GiB' : '>2GiB';
      result.sizeBuckets[bucket] = (result.sizeBuckets[bucket] ?? 0) + 1;
      result.largest.push({ path: file.path, bytes: file.size });
      result.largest.sort((left, right) => right.bytes - left.bytes);
      if (result.largest.length > 100) result.largest.length = 100;
      const ageDays = Math.max(0, (Date.now() - Date.parse(file.modifiedAt)) / 86_400_000);
      const ageBucket = ageDays <= 7 ? '<=7d' : ageDays <= 30 ? '8-30d' : ageDays <= 90 ? '31-90d' : ageDays <= 365 ? '91-365d' : '>365d';
      updateFrequency[ageBucket] = (updateFrequency[ageBucket] ?? 0) + 1;
      const lowerPath = file.path.toLocaleLowerCase();
      const sourceClass = /(?:^|\/)(?:archive|archived|history|old)(?:\/|$)/u.test(lowerPath)
        ? 'archive'
        : /(?:^|\/)(?:authority|official|signed|approved)(?:\/|$)/u.test(lowerPath)
          ? 'authority'
          : 'current';
      sourceClasses[sourceClass] = (sourceClasses[sourceClass] ?? 0) + 1;
      if (!deep) continue;
      try {
        const analysis = await analyzeCensusFile(file.path, file.size, signal);
        exactCardinality.add(analysis.contentSha256);
        // A banded SimHash key intentionally trades precision for a stable,
        // fixed-memory near-duplicate forecast.
        similarityCardinality.add(`${analysis.similarityFingerprint.slice(0, 12)}0000`);
        structures.headings += analysis.headings;
        structures.clauses += analysis.clauses;
        structures.paragraphs += analysis.paragraphs;
        structures.tables += analysis.tables;
        structures.estimatedPassages += analysis.estimatedPassages;
        sectionVectors += Math.max(1, analysis.headings + analysis.tables);
        if (file.size <= this.policy.eagerPassageMaxBytes) {
          passageVectors += Math.min(analysis.estimatedPassages, this.policy.eagerPassageVectorCap);
        } else if (file.size <= this.policy.asyncPassageMaxBytes) {
          passageVectors += Math.min(analysis.estimatedPassages, this.policy.eagerPassageVectorCap);
        }
        for (const [language, weight] of Object.entries(analysis.language.distribution)) {
          languageWeights[language] = (languageWeights[language] ?? 0) + weight;
        }
        if (analysis.language.mixed) mixedLanguageFiles++;
        const priority = sha256(file.path);
        representative.push({
          path: file.path,
          bytes: file.size,
          modifiedAt: file.modifiedAt,
          language: analysis.language.primary,
          contentSha256: analysis.contentSha256,
          priority,
        });
        representative.sort((left, right) => left.priority.localeCompare(right.priority));
        if (representative.length > 200) representative.length = 200;
      } catch (error) {
        if (signal.aborted) {
          result.complete = false;
          break;
        }
        throw error;
      }
    }
    /**
     * Estimates a file-size percentile from the log2-banded histogram,
     * falling back to the largest observed file when the histogram is
     * exhausted. Returns 0 when no files were seen.
     */
    const percentile = (fraction: number): number => {
      if (result.files === 0) return 0;
      const target = Math.max(1, Math.ceil(result.files * fraction));
      let seen = 0;
      for (let index = 0; index < sizeHistogram.length; index++) {
        seen += sizeHistogram[index]!;
        if (seen >= target) return Math.round(2 ** ((index + 0.5) / 32) - 1);
      }
      return result.largestBytes;
    };
    result.percentiles = {
      p50: percentile(0.5),
      p90: percentile(0.9),
      p95: percentile(0.95),
      p99: percentile(0.99),
      p999: percentile(0.999),
    };
    result.mixedLanguageFiles = mixedLanguageFiles;
    const exactUnique = Math.min(result.files, exactCardinality.estimate());
    const similarityUnique = Math.min(result.files, similarityCardinality.estimate());
    result.exactDuplicateRate = deep && result.files > 0 ? Math.max(0, 1 - exactUnique / result.files) : 0;
    result.nearDuplicateRateEstimate = deep && result.files > 0
      ? Math.max(result.exactDuplicateRate, 1 - similarityUnique / result.files)
      : 0;
    result.aclCardinality.histogram['1'] = result.files;
    const vectorCount = result.files + sectionVectors + passageVectors;
    const rawVectorBytes = vectorCount * this.embedder.info.dimensions * 4;
    result.projected = {
      lexicalBytes: Math.ceil(result.totalBytes * 0.65),
      immutableObjectBytes: result.totalBytes,
      documentVectors: result.files,
      sectionVectors,
      passageVectors,
      vectorBytes: rawVectorBytes,
      hnswBytes: Math.ceil(rawVectorBytes * 1.5),
    };
    result.representativeSample = representative.map(({ priority: _priority, ...entry }) => entry);
    return result;
  }

  /**
   * A run that dies mid-scan leaves its generation unpublished, so the next run would rediscover
   * the whole corpus as new. Adopt that generation instead: a document joins a generation only
   * once it is fully ingested, so everything the interrupted run left there is safe to inherit.
   * Adoption requires the previous job to have incomplete discovery, its generation to exist in
   * staging with the current embedding signature, and at least one indexed document.
   *
   * @param workspace - Workspace owning the generation.
   * @param context - Context owning the generation.
   * @param previous - Stored job from the interrupted run, when present.
   * @returns The resumable generation id, or undefined when the run cannot be resumed.
   * @throws Error - When repository access fails.
   */
  private async resumableGeneration(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    previous?: RagV2Job,
  ): Promise<{ generationId: string } | undefined> {
    if (!previous || previous.discoveryComplete) return undefined;
    const generation = await this.repository.generation(
      workspace.id, context.id, previous.generationId,
    );
    if (!generation || generation.state !== 'staging' || generation.embeddingSignature !== this.embedder.info.signature) return undefined;
    const documents = await this.repository.countGenerationDocuments(
      workspace.id, context.id, previous.generationId,
    );
    return documents > 0 ? { generationId: previous.generationId } : undefined;
  }

  /**
   * Publishes an independent membership snapshot. Writers continue using the job's staging
   * generation, so subsequent reconciliation cannot mutate a snapshot already used by search.
   * The snapshot is validated first and only published when valid and non-empty; any failure
   * is logged and skipped so checkpointing never fails ingestion.
   *
   * @param workspace - Workspace to publish the checkpoint for.
   * @param context - Context to publish the checkpoint for.
   * @param job - Active job whose `publishedCheckpoints` counter and timestamp are updated on success.
   * @throws Never.
   */
  private async publishCheckpoint(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    job: RagV2Job,
  ): Promise<void> {
    try {
      const checkpointId = randomUUID();
      await this.repository.beginGeneration(workspace.id, context.id, checkpointId, job.generationId);
      await this.repository.rebuildCollections(workspace.id, context.id, checkpointId);
      const validation = await this.repository.validateGeneration(
        workspace.id, context.id, checkpointId,
      );
      if (!validation.valid || validation.documents === 0) return;
      await this.repository.publishGeneration(
        workspace.id,
        context.id,
        checkpointId,
        validation.passageEmbeddings === 0
          ? 'active_lexical'
          : validation.passageEmbeddings === validation.passages
            ? 'active_hybrid_complete'
            : 'active_hybrid_partial',
      );
      job.publishedCheckpoints++;
      job.updatedAt = now();
      await this.repository.updateJob(job);
    } catch (error) {
      console.warn(`[workspace-rag-v2] checkpoint publication skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Executes a full ingestion run: marks any stale interrupted job as failed,
   * adopts a resumable staging generation when present, selects available
   * source roots (stopping early with a retryable failure when a skipped root
   * still backs indexed documents), then discovers and processes files tier
   * by tier (`authority` -> `current` -> `archive`) through a bounded worker
   * pool with periodic checkpoint publications. After discovery it reconciles
   * removals (deferring them when files failed), rebuilds and embeds
   * collections, validates the generation, and publishes it; failures mark
   * the job `retryable_failure` (or `cancelled` on abort) with a best-effort
   * terminal update before rethrowing.
   *
   * @param workspace - Workspace being indexed.
   * @param context - Context being indexed; its effective paths may be narrowed to available roots.
   * @param job - Pre-initialized job record, mutated in place throughout the run and persisted at each stage.
   * @param signal - Abort signal for the run, checked between stages and honored by discovery and embedding calls.
   * @param forcePaths - Normalized paths to re-ingest even when fingerprints match.
   * @param forceAll - Re-ingest every file regardless of fingerprint match.
   * @throws Error - When generation validation fails or a file task fails; abort reasons propagate after the job is marked cancelled.
   */
  private async runIngestion(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    job: RagV2Job,
    signal: AbortSignal,
    forcePaths: ReadonlySet<string>,
    forceAll: boolean,
  ): Promise<void> {
    let jobCreated = false;
    try {
      await this.initialize();
      await this.gcLocks.get(runKey(workspace.id, context.id));
      signal.throwIfAborted();
      const previousJob = await this.repository.currentJob(workspace.id, context.id);
      if (previousJob && !['active_lexical', 'active_hybrid_partial', 'active_hybrid_complete',
        'cancelled', 'retryable_failure', 'permanent_failure', 'quarantined'].includes(previousJob.state)) {
        previousJob.state = 'retryable_failure';
        previousJob.message = 'Previous ingestion was interrupted before reaching a terminal state.';
        previousJob.updatedAt = now();
        delete previousJob.currentPath;
        await this.repository.updateJob(previousJob);
      }
      const resumed = await this.resumableGeneration(workspace, context, previousJob);
      if (resumed) job.generationId = resumed.generationId;
      signal.throwIfAborted();
      // Treat an unacknowledged create as potentially committed, so its failure
      // also gets a best-effort terminal update.
      jobCreated = true;
      await this.repository.createJob(job);
      const fingerprints = new Map(
        (await this.repository.listFingerprints(workspace.id, context.id)).map(value => [normalizedPath(value.path), value]),
      );
      if (resumed) {
        const inherited = await this.repository.listFingerprints(
          workspace.id, context.id, resumed.generationId,
        );
        for (const value of inherited) fingerprints.set(normalizedPath(value.path), value);
        job.resumedFiles = inherited.length;
        job.message = `Resuming the generation left by an interrupted run with ${job.resumedFiles} file${job.resumedFiles === 1 ? '' : 's'} already indexed.`;
        job.updatedAt = now();
        await this.repository.updateJob(job);
      }
      const rootSelection = await this.sourceAcquisition.availableMarkdownRoots(context.paths);
      signal.throwIfAborted();
      if (rootSelection.skippedPaths.length > 0) {
        job.skippedPaths = rootSelection.skippedPaths;
        job.message = `Skipping ${rootSelection.skippedPaths.length} unavailable configured path${rootSelection.skippedPaths.length === 1 ? '' : 's'} while indexing the remaining paths.`;
        job.updatedAt = now();
        await this.repository.updateJob(job);
        const unavailableRootWithIndexedDocuments = rootSelection.skippedPaths.find(root =>
          [...fingerprints.keys()].some(filePath => isWithinRoot(filePath, root)),
        );
        if (unavailableRootWithIndexedDocuments) {
          job.state = 'retryable_failure';
          job.deletionsDeferred = true;
          job.message = (
            `Workspace RAG V2 could not completely discover ${unavailableRootWithIndexedDocuments}: `
            + 'the root has indexed documents, so its previous publication remains active.'
          );
          job.updatedAt = now();
          await this.repository.updateJob(job);
          return;
        }
      }
      const indexContext: RagV2ContextRef = { ...context, paths: rootSelection.paths };
      job.totalFiles = await this.sourceAcquisition.countMarkdown(indexContext.paths, signal);
      signal.throwIfAborted();
      job.message = `Discovering ${job.totalFiles} Markdown file${job.totalFiles === 1 ? '' : 's'}.`;
      job.updatedAt = now();
      await this.repository.updateJob(job);
      await this.repository.beginGeneration(workspace.id, context.id, job.generationId);
      signal.throwIfAborted();
      const pruned = await this.repository.pruneStagingGenerations(
        workspace.id, context.id, job.generationId,
      );
      if (pruned > 0) {
        console.warn(`[workspace-rag-v2] pruned ${pruned} abandoned staging generation${pruned === 1 ? '' : 's'}.`);
      }
      const seenPaths = new Set<string>();
      const checkpointState = { sinceFiles: 0, pending: Promise.resolve() };
      let removedPaths: string[] = [];
      for (const priority of ['authority', 'current', 'archive'] as const) {
        // Files within a tier run through a bounded worker pool so Postgres
        // writes, parsing, and GPU embedding overlap across files. Tiers stay
        // sequential to preserve the authority -> current -> archive order,
        // and discovery only advances when a worker slot is free so a
        // concurrency of 1 keeps the exact sequential scan semantics.
        const iterator = this.sourceAcquisition.discoverMarkdown(indexContext.paths, signal, priority);
        const inflight = new Set<Promise<void>>();
        const failures: unknown[] = [];
        try {
          while (true) {
            for (;;) {
              if (failures.length > 0) break;
              if (inflight.size < this.fileConcurrencyFor(job)) break;
              await Promise.race(inflight);
            }
            if (failures.length > 0) break;
            if (signal.aborted) throw abortError(signal);
            const next = await iterator.next();
            if (next.done) break;
            const file = next.value;
            await this.waitWhilePaused(job, signal);
            if (signal.aborted) throw abortError(signal);
            job.discoveredFiles++;
            job.discoveredBytes += file.size;
            if (job.discoveredFiles > job.totalFiles) job.totalFiles = job.discoveredFiles;
            job.currentPath = file.path;
            job.checkpoint = file.path;
            seenPaths.add(file.path);
            job.updatedAt = now();
            const elapsedSeconds = Math.max(0.001, (Date.now() - Date.parse(job.createdAt)) / 1_000);
            job.throughputBytesPerSecond = Math.round(job.processedBytes / elapsedSeconds);
            if (job.throughputBytesPerSecond > 0) {
              job.estimatedRemainingSeconds = Math.ceil(
                Math.max(0, job.discoveredBytes - job.processedBytes) / job.throughputBytesPerSecond,
              );
            } else {
              delete job.estimatedRemainingSeconds;
            }
            await this.repository.upsertJobItem({
              jobId: job.id,
              workspaceId: workspace.id,
              contextId: context.id,
              path: file.path,
              size: file.size,
              modifiedAt: file.modifiedAt,
              state: 'discovered',
            });
            const task = this.processDiscoveredFile(
              workspace, indexContext, job, file, fingerprints, forceAll, forcePaths, checkpointState, signal,
            ).catch(error => { failures.push(error); });
            inflight.add(task);
            void task.finally(() => inflight.delete(task));
          }
        } finally {
          // Drain before leaving the tier so no file writes race validation,
          // and so a throwing discovery pull still settles scheduled work.
          while (inflight.size > 0) {
            await Promise.race(inflight);
          }
        }
        if (signal.aborted) throw abortError(signal);
        if (failures.length > 0) throw failures[0];
      }
      if (signal.aborted) throw abortError(signal);
      job.discoveryComplete = true;
      job.totalFiles = job.discoveredFiles;
      job.state = 'validating';
      job.updatedAt = now();
      job.message = 'Validating the Workspace RAG V2 staging generation.';
      await this.repository.updateJob(job);
      removedPaths = [...fingerprints.keys()].filter(filePath => !seenPaths.has(filePath));
      if (job.failedFiles > 0) {
        job.deletionsDeferred = removedPaths.length > 0;
        removedPaths = [];
      } else {
        job.removedFiles = await this.repository.reconcileGeneration(
          job.id, workspace.id, context.id, job.generationId,
        );
      }
      const collections = await this.repository.rebuildCollections(
        workspace.id,
        context.id,
        job.generationId,
      );
      for (let start = 0; start < collections.length; start += 32) {
        const batch = collections.slice(start, start + 32);
        const inputs = batch.map(collection => `${collection.title}\n${collection.routingSummary}`);
        const vectors = await this.embedder.embed(
          inputs,
          'document',
          signal,
        );
        await this.repository.putEmbeddings(batch.map((collection, index) => ({
          level: 'collection' as const,
          unitId: collection.collectionVersionId,
          documentVersionId: collection.collectionVersionId,
          workspaceId: collection.workspaceId,
          contextId: collection.contextId,
          signature: this.embedder.info.signature,
          inputSha256: embeddingInputSha256('collection', inputs[index] ?? ''),
          vector: vectors[index] ?? [],
        })).filter(record => record.vector.length === this.embedder.info.dimensions), this.embedder.info);
        for (const collection of batch) {
          await this.enqueueSummary({
            level: 'collection',
            workspaceId: collection.workspaceId,
            contextId: collection.contextId,
            generationId: collection.generationId,
            unitId: collection.collectionVersionId,
            sourceContentSha256: collection.contentSha256,
            title: collection.title,
            breadcrumb: [collection.title],
            text: collection.routingSummary,
          }, signal);
        }
      }
      const validation = await this.repository.validateGeneration(workspace.id, context.id, job.generationId);
      if (!validation.valid) throw new Error(`Workspace RAG V2 generation is invalid: ${validation.errors.join(' ')}`);
      const publicationState = validation.passageEmbeddings === 0
        ? 'active_lexical'
        : validation.passageEmbeddings === validation.passages
          ? 'active_hybrid_complete'
          : 'active_hybrid_partial';
      await this.repository.publishGeneration(workspace.id, context.id, job.generationId, publicationState);
      if (removedPaths.length > 0) {
        await this.sourceBridge?.markRemoved(workspace, context, removedPaths).catch(error => {
          console.warn(`[workspace-rag-v2] failed to reconcile removed source state: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      job.state = publicationState;
      job.processedSections = validation.sections;
      job.processedPassages = validation.passages;
      job.lexicalReadyPassages = validation.lexicalReady;
      job.queuedEmbeddings = Math.max(0, validation.passages - validation.passageEmbeddings);
      job.estimatedRemainingSeconds = 0;
      job.updatedAt = now();
      job.message = [
        `Published ${validation.documents} documents, ${validation.sections} sections, and ${validation.passages} passages.`,
        `${job.addedFiles} added, ${job.changedFiles} changed, ${job.unchangedFiles} unchanged, ${job.removedFiles} removed.`,
        ...(job.skippedPaths?.length
          ? [`Skipped ${job.skippedPaths.length} unavailable configured path${job.skippedPaths.length === 1 ? '' : 's'}.`]
          : []),
        ...(job.deletionsDeferred ? ['Deletion reconciliation was deferred because one or more files failed.'] : []),
      ].join(' ');
      delete job.currentPath;
      await this.repository.updateJob(job);
      this.lastSuccessfulReconcile.set(runKey(workspace.id, context.id), job.updatedAt);
      if (this.gcSettings.enabled && (job.removedFiles > 0 || previousJob?.deletionsDeferred === true)) {
        this.gcAfterIngestion.set(runKey(workspace.id, context.id), { workspace, context });
      }
      this.startLazyWorker();
    } catch (error) {
      if (signal.aborted || job.cancelRequested) {
        job.state = 'cancelled';
        job.message = 'Workspace RAG V2 ingestion cancelled; the last successfully published snapshot remains active.';
      } else {
        job.state = 'retryable_failure';
        job.message = error instanceof Error ? error.message : String(error);
      }
      job.updatedAt = now();
      delete job.currentPath;
      if (jobCreated) {
        try {
          await this.repository.updateJob(job);
        } catch (persistenceError) {
          job.message += ` Terminal state could not be saved: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`;
        }
      }
      if (!signal.aborted) throw error;
    }
  }

  /**
   * Effective per-tier file concurrency. An explicit CORTEX_RAG_V2_FILE_CONCURRENCY
   * always wins; otherwise bulk backlogs run 3-wide and taper to sequential once
   * only a handful of files remain, so small incremental scans stay strictly
   * ordered and keep cross-file derivative reuse.
   *
   * @param job - Active job whose discovered/processed totals express the remaining backlog.
   * @returns Concurrency between 1 and 8.
   * @throws Never.
   */
  private fileConcurrencyFor(job: RagV2Job): number {
    const configured = this.policy.fileConcurrency;
    if (configured !== undefined) return Math.max(1, Math.min(8, configured));
    return job.totalFiles - job.processedFiles > FILE_CONCURRENCY_TAIL_FILES
      ? BULK_FILE_CONCURRENCY
      : 1;
  }

  /**
   * Runs one discovered file to completion inside the bounded per-tier pool.
   * Per-file ingestion failures are recorded against the job so the scan can
   * continue; every other rejection propagates to the pool feeder, which
   * fails the scan exactly as the sequential loop did. Checkpoint accounting
   * is shared for the whole run; the synchronous read-modify-write on the
   * single-threaded event loop keeps publications serial without locks.
   * Files whose fingerprint (size, modified time, embedding and summary
   * signatures) matches are counted unchanged unless forced; throughput and
   * ETA are recomputed after every file, and a checkpoint snapshot is
   * published every `checkpointFiles` processed files.
   *
   * @param workspace - Workspace being indexed.
   * @param context - Effective context whose narrowed paths are being indexed.
   * @param job - Active job record, mutated in place with state, counters, and progress.
   * @param file - Discovered file descriptor (normalized path, size in bytes, ISO modification time).
   * @param fingerprints - Shared known-path fingerprint map, read to skip unchanged files.
   * @param forceAll - Re-ingest regardless of fingerprint match.
   * @param forcePaths - Normalized paths to re-ingest regardless of fingerprint match.
   * @param checkpointState - Run-scoped checkpoint accumulator (`sinceFiles` counter and the serialized `pending` publication promise).
   * @param signal - Abort signal; aborts propagate instead of being recorded as file failures.
   * @throws Error - Propagates abort reasons and non-abort repository failures; per-file ingestion errors are recorded on the job instead.
   */
  private async processDiscoveredFile(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    job: RagV2Job,
    file: { path: string; size: number; modifiedAt: string },
    fingerprints: Map<string, RagV2DocumentFingerprint>,
    forceAll: boolean,
    forcePaths: ReadonlySet<string>,
    checkpointState: { sinceFiles: number; pending: Promise<void> },
    signal: AbortSignal,
  ): Promise<void> {
    const existing = fingerprints.get(file.path);
    const summarySignature = this.semanticServices?.summarizerSignature;
    if (
      existing
      && existing.byteLength === file.size
      && existing.modifiedAt === file.modifiedAt
      && existing.embeddingSignature === this.embedder.info.signature
      && (!summarySignature || existing.summarySignature === summarySignature)
      && !forceAll
      && !forcePaths.has(file.path)
    ) {
      job.unchangedFiles++;
      job.processedFiles++;
      job.processedBytes += file.size;
      await this.repository.upsertJobItem({
        jobId: job.id,
        workspaceId: workspace.id,
        contextId: context.id,
        path: file.path,
        size: file.size,
        modifiedAt: file.modifiedAt,
        state: 'active_hybrid_complete',
        documentId: existing.documentId,
        documentVersionId: existing.documentVersionId,
      });
      await this.repository.updateJob(job);
      return;
    }
    try {
      await this.ingestFile(workspace, context, job, file, signal);
      if (existing) job.changedFiles++;
      else job.addedFiles++;
      job.processedFiles++;
      job.processedBytes += file.size;
      checkpointState.sinceFiles++;
    } catch (error) {
      if (signal.aborted) throw error;
      job.failedFiles++;
      await this.repository.upsertJobItem({
        jobId: job.id,
        workspaceId: workspace.id,
        contextId: context.id,
        path: file.path,
        size: file.size,
        modifiedAt: file.modifiedAt,
        state: 'retryable_failure',
        error: error instanceof Error ? error.message : String(error),
      });
      await this.sourceBridge?.recordFailure(workspace, context, file.path, error);
    }
    job.updatedAt = now();
    const completedElapsedSeconds = Math.max(
      0.001,
      (Date.now() - Date.parse(job.createdAt)) / 1_000,
    );
    job.throughputBytesPerSecond = Math.round(job.processedBytes / completedElapsedSeconds);
    job.estimatedRemainingSeconds = job.throughputBytesPerSecond > 0
      ? Math.ceil(
        Math.max(0, job.discoveredBytes - job.processedBytes)
        / job.throughputBytesPerSecond,
      )
      : 0;
    job.message = `Processed ${job.processedFiles} of ${job.totalFiles} Markdown files.`;
    await this.repository.updateJob(job);
    if (this.checkpointFiles > 0 && checkpointState.sinceFiles >= this.checkpointFiles) {
      checkpointState.sinceFiles = 0;
      // Serialize snapshot promotion across concurrent file workers.
      checkpointState.pending = checkpointState.pending.then(() => this.publishCheckpoint(workspace, context, job));
      await checkpointState.pending;
    }
  }

  /**
   * Ingests one file end to end: hashes and stores the object under the
   * storage rate limiter, stages the document record, parses the markdown
   * stream into batched section and passage flushes that run through a
   * bounded embedding pipeline (with cross-generation embedding reuse),
   * builds the line index, registers the source with the bridge
   * (rate-limited) and optionally enriches the context graph, merges parsed
   * metadata, embeds the document-level summary, finishes the document,
   * queues its routing summary, and records the final job item state. Job
   * state transitions (`hashing` -> `parsing`) and embedding counters are
   * persisted as the work proceeds.
   *
   * @param workspace - Workspace being indexed.
   * @param context - Context being indexed.
   * @param job - Active job record, mutated in place with state and embedding counters.
   * @param file - Discovered file descriptor (normalized path, size in bytes, ISO modification time).
   * @param signal - Abort signal applied to hashing, parsing, embedding, and bridge calls.
   * @throws Error - Propagates abort reasons, parsing failures, and repository failures; per-part embedding failures are recorded on records instead of thrown.
   */
  private async ingestFile(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    job: RagV2Job,
    file: { path: string; size: number; modifiedAt: string },
    signal: AbortSignal,
  ): Promise<void> {
    job.state = 'hashing';
    job.updatedAt = now();
    await this.repository.updateJob(job);
    const objectStore = this.objectStore(workspace);
    const object = await objectStore.putFile(
      file.path,
      signal,
      bytes => this.storageLimiter.consume(bytes, signal),
    );
    const documentId = stableId(`${workspace.id}:${context.id}`, file.path);
    const documentVersionId = stableId(documentId, object.contentSha256);
    const initialDocument: RagV2DocumentRecord = {
      documentId,
      documentVersionId,
      workspaceId: workspace.id,
      contextId: context.id,
      aclTokens: [`workspace:${workspace.id}`],
      path: file.path,
      title: path.basename(file.path),
      documentType: 'markdown',
      parties: [],
      languageDistribution: {},
      byteLength: object.byteLength,
      lineCount: 0,
      contentSha256: object.contentSha256,
      tableOfContents: [],
      routingSummary: '',
      publicationState: 'staging',
      objectPath: object.objectPath,
      lineIndexPath: object.lineIndexPath,
      modifiedAt: file.modifiedAt,
      embeddingState: 'queued',
    };
    await this.repository.beginDocument(job.generationId, initialDocument);
    job.state = 'parsing';
    job.updatedAt = now();
    await this.repository.updateJob(job);

    const sectionBatch: RagV2SectionRecord[] = [];
    const passageBatch: RagV2PassageRecord[] = [];
    let eagerPassageVectors = 0;
    let asyncPassageVectorsPlanned = 0;
    const lineWriter = await objectStore.createLineIndexWriter(object.contentSha256);
    // Embedding batches drain through this bounded pipeline so the GPU keeps
    // working while Postgres writes and markdown parsing continue on the host.
    const pipeline: Array<Promise<void>> = [];
    /**
     * Schedules embedding work on a bounded pipeline: waits while
     * `embedPipelineDepth` tasks are in flight, then starts the task, which
     * removes itself from the pipeline when it settles.
     */
    const scheduleEmbeddingWork = async (task: () => Promise<void>): Promise<void> => {
      while (pipeline.length >= this.policy.embedPipelineDepth) {
        await Promise.race(pipeline);
      }
      const run = task().finally(() => {
        const index = pipeline.indexOf(run);
        if (index >= 0) pipeline.splice(index, 1);
      });
      void run.catch(() => undefined);
      pipeline.push(run);
    };
    /** Waits for every in-flight pipeline task to settle. */
    const drainPipeline = async (): Promise<void> => {
      const pending = pipeline.splice(0);
      await Promise.all(pending);
    };
    /**
     * Persists the accumulated section batch, then schedules embedding work
     * that reuses cached vectors where possible, embeds the remainder under
     * the embedding rate limiter, marks sections failed on non-abort errors,
     * and queues a routing summary per section.
     */
    const flushSections = async (): Promise<void> => {
      if (sectionBatch.length === 0) return;
      const batch = sectionBatch.splice(0);
      await scheduleEmbeddingWork(async () => {
        for (const section of batch) section.embeddingState = 'queued';
        await this.repository.appendSections(batch);
        try {
          /**
           * Builds the section embedding input: the heading path joined by
           * `>` over the routing summary.
           */
          const embeddingText = (section: RagV2SectionRecord) =>
            `${section.headingPath.join(' > ')}\n${section.routingSummary}`;
          const reusable = batch.map(section => ({
            level: 'section' as const,
            unitId: section.sectionId,
            documentVersionId: section.documentVersionId,
            workspaceId: section.workspaceId,
            contextId: section.contextId,
            signature: this.embedder.info.signature,
            inputSha256: embeddingInputSha256('section', embeddingText(section)),
          }));
          const reused = await this.repository.reuseEmbeddings(reusable, this.embedder.info);
          const pending = batch.filter(section => !reused.has(section.sectionId));
          job.readyEmbeddings += reused.size;
          if (pending.length > 0) {
            await this.embeddingLimiter.consume(pending.length, signal);
            const vectors = await this.embedder.embed(
              pending.map(embeddingText),
              'document',
              signal,
            );
            const records: RagV2EmbeddingRecord[] = pending.map((section, index) => ({
              level: 'section' as const,
              unitId: section.sectionId,
              documentVersionId: section.documentVersionId,
              workspaceId: section.workspaceId,
              contextId: section.contextId,
              signature: this.embedder.info.signature,
              inputSha256: embeddingInputSha256('section', embeddingText(section)),
              vector: vectors[index] ?? [],
            })).filter(record => record.vector.length === this.embedder.info.dimensions);
            await this.repository.putEmbeddings(records, this.embedder.info);
            job.readyEmbeddings += records.length;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          for (const section of batch) section.embeddingState = 'failed';
          await this.repository.appendSections(batch);
        }
        for (const section of batch) {
          await this.enqueueSummary({
            level: 'section',
            workspaceId: section.workspaceId,
            contextId: section.contextId,
            generationId: job.generationId,
            unitId: section.sectionId,
            documentVersionId: section.documentVersionId,
            sourceContentSha256: section.contentSha256,
            title: section.headingText,
            breadcrumb: section.headingPath,
            text: section.routingSummary,
          }, signal);
        }
      });
    };
    /**
     * Persists the accumulated passage batch and plans embeddings by file
     * size tier: eager passages (small files) are embedded immediately within
     * the per-file vector cap, async passages (medium files) are queued for
     * the lazy worker, and the rest are marked `not_planned`.
     */
    const flushPassages = async (): Promise<void> => {
      if (passageBatch.length === 0) return;
      const batch = passageBatch.splice(0);
      const eager = file.size <= this.policy.eagerPassageMaxBytes
        ? batch.slice(0, Math.max(0, this.policy.eagerPassageVectorCap - eagerPassageVectors))
        : [];
      const eagerIds = new Set(eager.map(passage => passage.passageId));
      const asyncSelected = file.size > this.policy.eagerPassageMaxBytes
        && file.size <= this.policy.asyncPassageMaxBytes
        ? batch.slice(0, Math.max(
          0,
          this.policy.eagerPassageVectorCap - asyncPassageVectorsPlanned,
        ))
        : [];
      const asyncIds = new Set(asyncSelected.map(passage => passage.passageId));
      for (const passage of batch) {
        if (eagerIds.has(passage.passageId) || asyncIds.has(passage.passageId)) {
          passage.embeddingState = 'queued';
        }
        else passage.embeddingState = 'not_planned';
      }
      await this.repository.appendPassages(batch);
      job.queuedEmbeddings += batch.filter(passage => passage.embeddingState === 'queued').length;
      if (eager.length > 0) {
        await scheduleEmbeddingWork(async () => {
          try {
            const reusable = eager.map(passage => ({
              level: 'passage' as const,
              unitId: passage.passageId,
              documentVersionId: passage.documentVersionId,
              workspaceId: passage.workspaceId,
              contextId: passage.contextId,
              signature: this.embedder.info.signature,
              inputSha256: embeddingInputSha256('passage', passage.text),
            }));
            const reused = await this.repository.reuseEmbeddings(reusable, this.embedder.info);
            const pending = eager.filter(passage => !reused.has(passage.passageId));
            job.readyEmbeddings += reused.size;
            await this.embeddingLimiter.consume(pending.length, signal);
            const vectors = pending.length > 0
              ? await this.embedder.embed(pending.map(passage => passage.text), 'document', signal)
              : [];
            const records: RagV2EmbeddingRecord[] = pending.map((passage, index) => ({
              level: 'passage' as const,
              unitId: passage.passageId,
              documentVersionId: passage.documentVersionId,
              workspaceId: passage.workspaceId,
              contextId: passage.contextId,
              signature: this.embedder.info.signature,
              inputSha256: embeddingInputSha256('passage', passage.text),
              vector: vectors[index] ?? [],
            })).filter(record => record.vector.length === this.embedder.info.dimensions);
            await this.repository.putEmbeddings(records, this.embedder.info);
            job.readyEmbeddings += records.length;
            eagerPassageVectors += records.length + reused.size;
          } catch (error) {
            if (signal.aborted) throw error;
            for (const passage of eager) passage.embeddingState = 'failed';
            await this.repository.appendPassages(eager);
          }
        });
      }
      if (asyncSelected.length > 0) {
        asyncPassageVectorsPlanned += asyncSelected.length;
        for (const sectionId of new Set(asyncSelected.map(passage => passage.sectionId))) {
          const key = `${workspace.id}\0${context.id}\0${sectionId}`;
          const selectedInSection = asyncSelected.filter(passage => passage.sectionId === sectionId);
          const existing = this.lazySections.get(key);
          this.lazySections.set(key, {
            workspaceId: workspace.id,
            contextId: context.id,
            generationId: job.generationId,
            maxPassages: (existing?.maxPassages ?? 0) + selectedInSection.length,
          });
        }
      }
    };
    try {
      const parsed = await parseMarkdownStream(
        object.objectPath,
        {
          workspaceId: workspace.id,
          contextId: context.id,
          documentId,
          documentVersionId,
          sourcePath: file.path,
        },
        this.policy,
        {
          async onSection(section) {
            sectionBatch.push(section);
            if (sectionBatch.length >= 64) await flushSections();
          },
          async onPassage(passage) {
            passageBatch.push(passage);
            if (passageBatch.length >= 128) await flushPassages();
          },
          ...(lineWriter ? {
            async onLineCheckpoint(line: number, byteOffset: number) {
              await lineWriter.add(line, byteOffset);
            },
          } : {}),
        },
        signal,
      );
      await flushPassages();
      await flushSections();
      await drainPipeline();
      await lineWriter?.close();
      job.processedSections += parsed.sectionCount;
      job.processedPassages += parsed.passageCount;
      job.lexicalReadyPassages += parsed.passageCount;
      await this.sourceMetadataLimiter.consume(1, signal);
      const source = await this.sourceBridge?.register(
        workspace, context, file.path, object.contentSha256, file.modifiedAt, parsed.routingSummary,
      );
      if (source && this.sourceBridge?.enrichContextGraph) {
        await this.contextGraphLimiter.consume(1, signal);
        await this.sourceBridge.enrichContextGraph(
          workspace, context, file.path, source, parsed.routingSummary,
        );
      }
      const document: RagV2DocumentRecord = {
        ...initialDocument,
        ...(source?.sourceId ? { sourceId: source.sourceId } : {}),
        ...(source?.sourceVersionId ? { sourceVersionId: source.sourceVersionId } : {}),
        title: parsed.title,
        ...(parsed.metadata.collectionId ? {
          collectionId: stableId(
            `${workspace.id}:${context.id}:collection`,
            parsed.metadata.collectionId.toLocaleLowerCase(),
          ),
          collectionTitle: parsed.metadata.collectionTitle ?? parsed.metadata.collectionId,
        } : {}),
        documentType: parsed.metadata.documentType ?? 'markdown',
        ...(parsed.metadata.jurisdiction ? { jurisdiction: parsed.metadata.jurisdiction } : {}),
        ...(parsed.metadata.governingLaw ? { governingLaw: parsed.metadata.governingLaw } : {}),
        parties: parsed.metadata.parties,
        ...(parsed.metadata.publicationDate ? { publicationDate: parsed.metadata.publicationDate } : {}),
        ...(parsed.metadata.validFrom ? { validFrom: parsed.metadata.validFrom } : {}),
        ...(parsed.metadata.validTo ? { validTo: parsed.metadata.validTo } : {}),
        languageDistribution: parsed.languageDistribution,
        lineCount: parsed.lineCount,
        tableOfContents: parsed.tableOfContents,
        routingSummary: parsed.routingSummary,
      };
      try {
        const documentEmbeddingText = `${document.title}\n${document.routingSummary}`;
        const reusable = [{
          level: 'document' as const,
          unitId: document.documentVersionId,
          documentVersionId: document.documentVersionId,
          workspaceId: document.workspaceId,
          contextId: document.contextId,
          signature: this.embedder.info.signature,
          inputSha256: embeddingInputSha256('document', documentEmbeddingText),
        }];
        const reused = await this.repository.reuseEmbeddings(reusable, this.embedder.info);
        job.readyEmbeddings += reused.size;
        await this.embeddingLimiter.consume(reused.size > 0 ? 0 : 1, signal);
        const vector = reused.size > 0 ? undefined : (await this.embedder.embed(
          [documentEmbeddingText],
          'document',
          signal,
        ))[0];
        if (reused.size > 0) {
          document.embeddingState = 'ready';
        } else if (vector?.length === this.embedder.info.dimensions) {
          await this.repository.putEmbeddings([{
            level: 'document',
            unitId: document.documentVersionId,
            documentVersionId: document.documentVersionId,
            workspaceId: document.workspaceId,
            contextId: document.contextId,
            signature: this.embedder.info.signature,
            inputSha256: embeddingInputSha256('document', documentEmbeddingText),
            vector,
          }], this.embedder.info);
          job.readyEmbeddings++;
          document.embeddingState = 'ready';
        } else {
          document.embeddingState = 'failed';
        }
      } catch (error) {
        if (signal.aborted) throw error;
        document.embeddingState = 'failed';
      }
      await this.repository.finishDocument(job.generationId, document);
      await this.enqueueSummary({
        level: 'document',
        workspaceId: document.workspaceId,
        contextId: document.contextId,
        generationId: job.generationId,
        unitId: document.documentVersionId,
        documentVersionId: document.documentVersionId,
        sourceContentSha256: document.contentSha256,
        title: document.title,
        breadcrumb: document.tableOfContents.slice(0, 100).map(item => item.text),
        text: `${document.routingSummary}\nTable of contents:\n${document.tableOfContents.slice(0, 100).map(item => item.text).join('\n')}`,
      }, signal);
      await this.repository.upsertJobItem({
        jobId: job.id,
        workspaceId: workspace.id,
        contextId: context.id,
        path: file.path,
        size: file.size,
        modifiedAt: file.modifiedAt,
        state: file.size <= this.policy.eagerPassageMaxBytes
          ? 'active_hybrid_complete'
          : 'active_hybrid_partial',
        documentId,
        documentVersionId,
      });
    } finally {
      if (pipeline.length > 0) await Promise.allSettled(pipeline.splice(0));
      await lineWriter?.close().catch(() => undefined);
    }
  }

  /**
   * Polls every 100 ms while the job's pause request is set, so aborts still
   * interrupt the wait promptly.
   *
   * @param job - Active job whose `pauseRequested` flag is observed.
   * @param signal - Abort signal that ends the wait with a rejection.
   * @throws Error - The returned promise rejects with the abort reason when the signal fires while paused.
   */
  private async waitWhilePaused(job: RagV2Job, signal: AbortSignal): Promise<void> {
    while (job.pauseRequested && !signal.aborted) await delay(100, signal);
  }

  /**
   * Returns the per-workspace object store, creating and caching it on first
   * use. The store root is the configured object root joined with the
   * workspace id, or `<workspace configDir>/.data/workspace-rag-v2` when
   * unconfigured; the retention mode comes from the environment.
   *
   * @param workspace - Workspace whose content objects are addressed.
   * @returns The workspace's cached object store.
   * @throws Error - When the workspace id contains characters outside `[A-Za-z0-9_-]`.
   */
  private objectStore(workspace: RagV2WorkspaceRef): RagV2ObjectStore {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(workspace.id)) {
      throw new Error(
        `Workspace RAG V2 workspace id must contain only [A-Za-z0-9_-] to root its object store safely: ${workspace.id}`,
      );
    }
    let store = this.objectStores.get(workspace.id);
    if (!store) {
      const configured = ragV2ObjectRootFromEnv();
      const root = configured
        ? path.join(path.resolve(configured), workspace.id)
        : path.join(workspace.configDir, '.data', 'workspace-rag-v2');
      store = new RagV2ObjectStore(
        root,
        undefined,
        this.objectRetention.mode,
        this.objectRetention.externalRoot,
      );
      this.objectStores.set(workspace.id, store);
    }
    return store;
  }

  /**
   * Builds the ACL token list scoping repository reads to a caller: the
   * workspace token, the user token, then one token per group.
   *
   * @param workspaceId - Workspace id.
   * @param principalId - Caller identity.
   * @param groupIds - Caller group ids.
   * @returns ACL tokens in `workspace:`, `user:`, then `group:` order.
   * @throws Never.
   */
  private authorizationTokens(
    workspaceId: string,
    principalId: string,
    groupIds: readonly string[],
  ): string[] {
    return [
      `workspace:${workspaceId}`,
      `user:${principalId}`,
      ...groupIds.map(value => `group:${value}`),
    ];
  }

  /**
   * Returns the per-workspace retrieval engine, creating and caching it on
   * first use with the shared repository, object store, embedder,
   * reranker/ColBERT endpoints, RRF settings, semantic services, and a
   * callback routing lazily selected sections into the lazy embedding worker.
   *
   * @param workspace - Workspace whose engine is addressed.
   * @returns The workspace's cached retrieval engine.
   * @throws Error - When the workspace id is invalid while creating the object store.
   */
  private retrievalEngine(workspace: RagV2WorkspaceRef): RagV2RetrievalEngine {
    let engine = this.retrieval.get(workspace.id);
    if (!engine) {
      engine = new RagV2RetrievalEngine({
        repository: this.repository,
        objectStore: this.objectStore(workspace),
        embedder: this.embedder,
        ...(this.rerankerUrl ? { rerankerUrl: this.rerankerUrl } : {}),
        rrfK: this.rrf.k,
        rrfWeights: this.rrf.weights,
        ...(this.colbertUrl ? { colbertUrl: this.colbertUrl } : {}),
        ...(this.semanticServices ? { semanticServices: this.semanticServices } : {}),
        onLazySection: (workspaceId, contextId, generationId, sectionId, passageId) => {
          this.enqueueSelectedLazySection(
            workspaceId, contextId, generationId, sectionId, passageId,
          );
        },
      });
      this.retrieval.set(workspace.id, engine);
    }
    return engine;
  }

  /**
   * Records a lazily selected section for background passage embedding,
   * capping the window at `min(512, eagerPassageVectorCap)` passages and
   * centering it on the priority passage when provided, then starts the lazy
   * worker. Replaces any pending scope for the same section.
   *
   * @param workspaceId - Workspace id.
   * @param contextId - Context id.
   * @param generationId - Generation whose passages are embedded.
   * @param sectionId - Section selected by retrieval.
   * @param priorityPassageId - Passage to center the embedding window on, when any.
   * @throws Never.
   */
  private enqueueSelectedLazySection(
    workspaceId: string,
    contextId: string,
    generationId: string,
    sectionId: string,
    priorityPassageId?: string,
  ): void {
    this.lazySections.set(`${workspaceId}\0${contextId}\0${sectionId}`, {
      workspaceId,
      contextId,
      generationId,
      maxPassages: Math.min(512, this.policy.eagerPassageVectorCap),
      ...(priorityPassageId ? { priorityPassageId } : {}),
    });
    this.startLazyWorker();
  }

  /**
   * Sweeps one context: skips deletions while an ingestion run is active,
   * otherwise drains the summary and lazy workers (re-checking for runs) and
   * prunes orphaned rows older than the grace period, retired generations
   * past their TTL, and — in managed retention mode — unreferenced blobs.
   * Records the outcome in `lastGc`, logs it, and notifies the observer
   * (observer failures are logged, not fatal).
   *
   * @param workspace - Workspace to sweep.
   * @param context - Context to sweep.
   * @returns Deletion counts, with `deletionsSkipped` set when a run prevented deletion.
   * @throws Error - When the repository sweep fails.
   */
  private async performGarbageCollection(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
  ): Promise<RagV2GcResult> {
    const key = runKey(workspace.id, context.id);
    const startedAt = Date.now();
    let retiredGenerationsDeleted = 0;
    let result: RagV2GcResult;
    if (this.runs.has(key)) {
      result = {
        documentsDeleted: 0,
        passagesDeleted: 0,
        sectionsDeleted: 0,
        embeddingsDeleted: 0,
        collectionsDeleted: 0,
        routingSummariesDeleted: 0,
        blobsDeleted: 0,
        deletionsSkipped: true,
      };
    } else {
      // Summary and lazy-vector workers can outlive publication. Let them drain
      // before deciding what is unreachable so they cannot recreate dangling
      // summaries or embeddings immediately after the sweep.
      await this.waitForSummaries();
      await this.waitForLazyWorker();
      if (this.runs.has(key)) {
        result = {
          documentsDeleted: 0,
          passagesDeleted: 0,
          sectionsDeleted: 0,
          embeddingsDeleted: 0,
          collectionsDeleted: 0,
          routingSummariesDeleted: 0,
          blobsDeleted: 0,
          deletionsSkipped: true,
        };
      } else {
        const olderThan = new Date(Date.now() - this.gcSettings.graceMs).toISOString();
        result = await this.repository.pruneOrphans(workspace.id, context.id, olderThan);
        if (!result.deletionsSkipped) {
          retiredGenerationsDeleted = await this.repository.pruneRetiredGenerations(
            workspace.id,
            context.id,
            new Date(Date.now() - this.gcSettings.retiredGenerationTtlMs).toISOString(),
          );
          if (this.gcSettings.blobGcEnabled && this.objectRetention.mode === 'managed') {
            result.blobsDeleted = await this.objectStore(workspace).pruneUnreferenced(
              await this.repository.listReferencedContentHashes(),
              olderThan,
            );
          }
        }
      }
    }
    const completedAt = now();
    const durationMs = Date.now() - startedAt;
    const status: NonNullable<RagV2Status['lastGc']> = {
      completedAt,
      durationMs,
      documentsDeleted: result.documentsDeleted,
      passagesDeleted: result.passagesDeleted,
      sectionsDeleted: result.sectionsDeleted,
      embeddingsDeleted: result.embeddingsDeleted,
      collectionsDeleted: result.collectionsDeleted,
      routingSummariesDeleted: result.routingSummariesDeleted,
      blobsDeleted: result.blobsDeleted,
      retiredGenerationsDeleted,
      deletionsSkipped: result.deletionsSkipped,
    };
    this.lastGc.set(key, status);
    const message = result.deletionsSkipped
      ? `[workspace-rag-v2] orphan GC skipped for ${workspace.id}/${context.id} because ingestion is active.`
      : `[workspace-rag-v2] orphan GC completed for ${workspace.id}/${context.id} in ${durationMs} ms: ${JSON.stringify(status)}`;
    console.info(message);
    await Promise.resolve(this.gcObserver?.({
      workspace,
      context,
      result,
      retiredGenerationsDeleted,
      completedAt,
      durationMs,
    })).catch(error => {
      console.warn(`[workspace-rag-v2] failed to record orphan GC audit event: ${error instanceof Error ? error.message : String(error)}`);
    });
    return result;
  }

  /**
   * Enqueues a garbage-collection task for the context, due `delayMs` from
   * now, keeping the earliest requested due time per context, and starts the
   * GC worker. No-op when GC is disabled or the manager is shutting down.
   *
   * @param workspace - Workspace to schedule GC for.
   * @param context - Context to schedule GC for.
   * @param attempt - Retry attempt number used for backoff when rescheduled; defaults to 0.
   * @param delayMs - Delay before the task is due, in milliseconds; defaults to 0.
   * @throws Never.
   */
  private scheduleGarbageCollection(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    attempt = 0,
    delayMs = 0,
  ): void {
    if (!this.gcSettings.enabled || this.lazyWorkerController.signal.aborted) return;
    const key = runKey(workspace.id, context.id);
    const dueAt = Date.now() + delayMs;
    const existing = this.gcQueue.get(key);
    if (!existing || dueAt < existing.dueAt) {
      this.gcQueue.set(key, { workspace, context, attempt, dueAt });
    }
    this.startGcWorker();
  }

  /**
   * Schedules a timer for the earliest queued GC task and runs the worker
   * when it fires, logging failures and rescheduling itself while the queue
   * is non-empty. No-op when a worker or timer already exists.
   *
   * @throws Never.
   */
  private startGcWorker(): void {
    if (this.gcWorker || this.gcWorkerTimer || this.gcQueue.size === 0) return;
    const next = [...this.gcQueue.values()].sort((left, right) => left.dueAt - right.dueAt)[0]!;
    this.gcWorkerTimer = setTimeout(() => {
      this.gcWorkerTimer = undefined;
      this.gcWorker = this.runGcWorker()
        .catch(error => {
          console.warn(`[workspace-rag-v2] orphan GC worker failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          this.gcWorker = undefined;
          this.startGcWorker();
        });
    }, Math.max(0, next.dueAt - Date.now()));
    this.gcWorkerTimer.unref?.();
  }

  /**
   * Takes the earliest due GC task off the queue and runs one garbage
   * collection for it. When deletions were skipped because ingestion was
   * active, the task is rescheduled with exponential backoff (1 s doubled per
   * attempt, capped at one hour). Errors propagate to the worker's caller.
   *
   * @throws Error - When {@link WorkspaceRagV2Manager.garbageCollect} fails.
   */
  private async runGcWorker(): Promise<void> {
    const entry = [...this.gcQueue.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
    if (!entry) return;
    const [key, task] = entry;
    this.gcQueue.delete(key);
    const result = await this.garbageCollect(task.workspace, task.context);
    if (result.deletionsSkipped && !this.lazyWorkerController.signal.aborted) {
      const attempt = task.attempt + 1;
      const delayMs = Math.min(3_600_000, 1_000 * (2 ** Math.min(attempt, 12)));
      this.scheduleGarbageCollection(task.workspace, task.context, attempt, delayMs);
    }
  }

  /**
   * Waits until the lazy embedding worker has fully drained, so garbage
   * collection cannot race vector writes.
   *
   * @throws Never.
   */
  private async waitForLazyWorker(): Promise<void> {
    while (this.lazyWorker) await this.lazyWorker.catch(() => undefined);
  }

  /**
   * Starts the lazy embedding worker when work is pending and none is
   * running; failures are logged (unless shutting down) and the worker
   * restarts itself while sections remain.
   *
   * @throws Never.
   */
  private startLazyWorker(): void {
    if (this.lazyWorker || this.lazySections.size === 0) return;
    this.lazyWorker = this.runLazyWorker()
      .catch(error => {
        if (!this.lazyWorkerController.signal.aborted) {
          console.warn(`[workspace-rag-v2] lazy embedding worker failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
      .finally(() => {
        this.lazyWorker = undefined;
        if (!this.lazyWorkerController.signal.aborted && this.lazySections.size > 0) this.startLazyWorker();
      });
  }

  /**
   * Processes queued lazy-section scopes in insertion order: fetches the
   * section's passages, centers a window of up to `maxPassages` around the
   * priority passage when present, and embeds them in batches of 256 with
   * cross-generation reuse under the embedding rate limiter. A non-abort
   * batch failure marks that batch failed and abandons the section; aborts
   * propagate. Once drained, revalidates every touched scope and republishes
   * its generation as hybrid-complete or hybrid-partial.
   *
   * @throws Error - Propagates the abort reason when shutting down, plus repository failures from passage, embedding, or validation calls.
   */
  private async runLazyWorker(): Promise<void> {
    const signal = this.lazyWorkerController.signal;
    const completedScopes = new Map<string, { workspaceId: string; contextId: string; generationId: string }>();
    while (this.lazySections.size > 0 && !signal.aborted) {
      const next = this.lazySections.entries().next().value as [
        string,
        {
          workspaceId: string;
          contextId: string;
          generationId: string;
          maxPassages: number;
          priorityPassageId?: string;
        },
      ] | undefined;
      if (!next) return;
      const [key, scope] = next;
      this.lazySections.delete(key);
      completedScopes.set(`${scope.workspaceId}\0${scope.contextId}\0${scope.generationId}`, scope);
      const sectionId = key.split('\0').at(-1)!;
      const sectionPassages = await this.repository.passagesForSection(
        scope.workspaceId, scope.contextId, scope.generationId, sectionId, true,
      );
      const priorityIndex = scope.priorityPassageId
        ? sectionPassages.findIndex(passage => passage.passageId === scope.priorityPassageId)
        : -1;
      const windowStart = priorityIndex >= 0
        ? Math.max(0, priorityIndex - Math.floor(scope.maxPassages / 2))
        : 0;
      const passages = sectionPassages.slice(windowStart, windowStart + scope.maxPassages);
      for (let start = 0; start < passages.length; start += 256) {
        const batch = passages.slice(start, start + 256);
        try {
          const reusable = batch.map(passage => ({
            level: 'passage' as const,
            unitId: passage.passageId,
            documentVersionId: passage.documentVersionId,
            workspaceId: passage.workspaceId,
            contextId: passage.contextId,
            signature: this.embedder.info.signature,
            inputSha256: embeddingInputSha256('passage', passage.text),
          }));
          const reused = await this.repository.reuseEmbeddings(reusable, this.embedder.info);
          const pending = batch.filter(passage => !reused.has(passage.passageId));
          await this.embeddingLimiter.consume(pending.length, signal);
          const vectors = pending.length > 0
            ? await this.embedder.embed(pending.map(passage => passage.text), 'document', signal)
            : [];
          const records: RagV2EmbeddingRecord[] = pending.map((passage, index) => ({
            level: 'passage' as const,
            unitId: passage.passageId,
            documentVersionId: passage.documentVersionId,
            workspaceId: passage.workspaceId,
            contextId: passage.contextId,
            signature: this.embedder.info.signature,
            inputSha256: embeddingInputSha256('passage', passage.text),
            vector: vectors[index] ?? [],
          })).filter(record => record.vector.length === this.embedder.info.dimensions);
          await this.repository.putEmbeddings(records, this.embedder.info);
        } catch (error) {
          if (signal.aborted) throw error;
          console.warn(`[workspace-rag-v2] lazy embedding batch failed for section ${sectionId}: ${error instanceof Error ? error.message : String(error)}`);
          for (const passage of batch) passage.embeddingState = 'failed';
          await this.repository.appendPassages(batch);
          break;
        }
      }
    }
    for (const scope of completedScopes.values()) {
      const validation = await this.repository.validateGeneration(
        scope.workspaceId, scope.contextId, scope.generationId,
      );
      if (validation.valid && validation.passageEmbeddings === validation.passages) {
        await this.repository.publishGeneration(
          scope.workspaceId, scope.contextId, scope.generationId, 'active_hybrid_complete',
        );
      } else if (validation.valid && validation.passageEmbeddings > 0) {
        await this.repository.publishGeneration(
          scope.workspaceId, scope.contextId, scope.generationId, 'active_hybrid_partial',
        );
      }
    }
  }
}
