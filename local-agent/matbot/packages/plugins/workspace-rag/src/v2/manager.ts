import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { analyzeCensusFile, RagV2HyperLogLog } from './census.js';
import {
  ragV2ObjectRetentionFromEnv,
  ragV2ColbertUrlFromEnv,
  ragV2PolicyFromEnv,
  ragV2RerankerUrlFromEnv,
  ragV2RrfFromEnv,
} from './config.js';
import {
  evaluateRagV2Results,
  type RagV2EvaluationCase,
  type RagV2EvaluationMetrics,
} from './evaluation.js';
import { RagV2ObjectStore } from './object-store.js';
import { parseMarkdownStream } from './parser.js';
import { RagV2RateLimiter } from './rate-limiter.js';
import type { RagV2EmbeddingRecord, RagV2Repository } from './repository.js';
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

interface SummaryTask extends RagV2SummaryInput {
  workspaceId: string;
  contextId: string;
  generationId: string;
  unitId: string;
  documentVersionId?: string;
  sourceContentSha256: string;
}

interface SourceRegistration {
  sourceId?: string;
  sourceVersionId?: string;
}

export interface RagV2SourceBridge {
  register(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    normalizedPath: string,
    contentSha256: string,
    modifiedAt: string,
    summary: string,
  ): Promise<SourceRegistration>;
  recordFailure(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    normalizedPath: string,
    error: unknown,
  ): Promise<void>;
  enrichContextGraph?(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    normalizedPath: string,
    registration: SourceRegistration,
    summary: string,
  ): Promise<void>;
}

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

export interface RagV2CensusOptions {
  deep?: boolean;
  resumeAfter?: string;
}

interface ActiveRun {
  job: RagV2Job;
  controller: AbortController;
  promise: Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function normalizedPath(value: string): string {
  return path.resolve(value).replace(/\\/gu, '/');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableId(namespace: string, value: string): string {
  const hex = sha256(`${namespace}\0${value}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function runKey(workspaceId: string, contextId: string): string {
  return `${workspaceId}\0${contextId}`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Workspace RAG V2 ingestion cancelled.');
}

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

async function* discoverMarkdown(
  paths: readonly string[],
  signal: AbortSignal,
  priority?: 'authority' | 'current' | 'archive',
): AsyncGenerator<{
  path: string;
  size: number;
  modifiedAt: string;
}> {
  const stack = [...paths].reverse().map(value => path.resolve(value));
  while (stack.length > 0) {
    if (signal.aborted) return;
    const current = stack.pop()!;
    const currentStat = await stat(current).catch(() => undefined);
    if (!currentStat) continue;
    if (currentStat.isFile()) {
      if (current.toLocaleLowerCase().endsWith('.md')) {
        const normalized = normalizedPath(current);
        if (!priority || discoveryPriority(normalized) === priority) {
          yield { path: normalized, size: currentStat.size, modifiedAt: currentStat.mtime.toISOString() };
        }
      }
      continue;
    }
    if (!currentStat.isDirectory()) continue;
    const entries = (await readdir(current, { withFileTypes: true }).catch(() => []))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (entry.isDirectory() && ['node_modules', '.git', '.data'].includes(entry.name)) continue;
      if (entry.isDirectory() || (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.md'))) {
        stack.push(path.join(current, entry.name));
      }
    }
  }
}

function discoveryPriority(filePath: string): 'authority' | 'current' | 'archive' {
  const lower = filePath.toLocaleLowerCase();
  if (/(?:^|\/)(?:authority|official|signed|approved|executed)(?:\/|$)/u.test(lower)) {
    return 'authority';
  }
  if (/(?:^|\/)(?:archive|archived|history|old|obsolete)(?:\/|$)/u.test(lower)) {
    return 'archive';
  }
  return 'current';
}

export class WorkspaceRagV2Manager {
  private readonly repository: RagV2Repository;
  private readonly embedder: RagV2Embedder;
  private readonly sourceBridge: RagV2SourceBridge | undefined;
  private readonly semanticServices: RagV2SemanticServices | undefined;
  private readonly objectStores = new Map<string, RagV2ObjectStore>();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly lazySections = new Map<string, {
    workspaceId: string;
    contextId: string;
    generationId: string;
    maxPassages: number;
    priorityPassageId?: string;
  }>();
  private lazyWorker: Promise<void> | undefined;
  private readonly retrieval: Map<string, RagV2RetrievalEngine> = new Map();
  private readonly policy = ragV2PolicyFromEnv();
  private readonly rerankerUrl = ragV2RerankerUrlFromEnv();
  private readonly rrf = ragV2RrfFromEnv();
  private readonly objectRetention = ragV2ObjectRetentionFromEnv();
  private readonly colbertUrl = ragV2ColbertUrlFromEnv();
  private readonly storageLimiter = new RagV2RateLimiter(this.policy.storageBytesPerSecond);
  private readonly embeddingLimiter = new RagV2RateLimiter(this.policy.embeddingTextsPerSecond);
  private readonly sourceMetadataLimiter = new RagV2RateLimiter(this.policy.sourceMetadataOpsPerSecond);
  private readonly contextGraphLimiter = new RagV2RateLimiter(this.policy.contextGraphOpsPerSecond);
  private readonly summaryQueue: SummaryTask[] = [];
  private readonly summarySpaceWaiters: Array<() => void> = [];
  private readonly summaryIdleWaiters: Array<() => void> = [];
  private readonly summaryController = new AbortController();
  private readonly summaryConcurrency = Math.max(1, Math.min(8, Number(process.env['CORTEX_RAG_V2_SUMMARY_CONCURRENCY'] ?? 2) || 2));
  private readonly summaryQueueLimit = Math.max(16, Math.min(4_096, Number(process.env['CORTEX_RAG_V2_SUMMARY_QUEUE_LIMIT'] ?? 256) || 256));
  private summaryActive = 0;
  private summaryCompleted = 0;
  private summaryFailed = 0;
  private initialized = false;

  constructor(
    repository: RagV2Repository,
    embedder: RagV2Embedder,
    sourceBridge?: RagV2SourceBridge,
    semanticServices?: RagV2SemanticServices,
  ) {
    this.repository = repository;
    this.embedder = embedder;
    this.sourceBridge = sourceBridge;
    this.semanticServices = semanticServices;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.repository.initialize(this.embedder.info);
    this.initialized = true;
  }

  async close(): Promise<void> {
    for (const run of this.runs.values()) run.controller.abort(new Error('Workspace RAG V2 manager is closing.'));
    await Promise.allSettled([...this.runs.values()].map(run => run.promise));
    this.summaryController.abort(new Error('Workspace RAG V2 manager is closing.'));
    this.summaryQueue.splice(0);
    await this.waitForSummaries();
    await this.repository.close();
  }

  async status(
    mode: RagV2Status['mode'],
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
  ): Promise<RagV2Status> {
    const publication = await this.repository.activePublication(workspace.id, context.id);
    const job = this.runs.get(runKey(workspace.id, context.id))?.job
      ?? await this.repository.currentJob(workspace.id, context.id);
    return {
      mode,
      available: this.initialized,
      backend: this.repository.backend,
      ...(publication ? {
        activeGenerationId: publication.generationId,
        activeState: publication.state,
        embeddingSignature: publication.embeddingSignature,
      } : {}),
      ...(job ? { job } : {}),
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
      message: publication
        ? `Workspace RAG V2 publication ${publication.generationId} is ${publication.state}.`
        : 'Workspace RAG V2 has no active publication; V1 remains the fallback.',
    };
  }

  startIngestion(workspace: RagV2WorkspaceRef, context: RagV2ContextRef): RagV2Job {
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
      cancelRequested: false,
      pauseRequested: false,
      message: 'Workspace RAG V2 discovery is starting.',
    };
    const promise = this.runIngestion(workspace, context, job, controller.signal)
      .catch(error => {
        console.warn(`[workspace-rag-v2] ingestion ${job.id} stopped: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.runs.get(key)?.job.id === job.id) this.runs.delete(key);
      });
    this.runs.set(key, { job, controller, promise });
    return job;
  }

  async waitForIngestion(workspaceId: string, contextId: string): Promise<void> {
    await this.runs.get(runKey(workspaceId, contextId))?.promise;
  }

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

  async waitForSummaries(): Promise<void> {
    if (this.summaryQueue.length === 0 && this.summaryActive === 0) return;
    await new Promise<void>(resolve => this.summaryIdleWaiters.push(resolve));
  }

  private async enqueueSummary(task: SummaryTask): Promise<void> {
    if (!this.semanticServices?.summarize || !this.semanticServices.summarizerSignature) return;
    while (this.summaryQueue.length >= this.summaryQueueLimit && !this.summaryController.signal.aborted) {
      await new Promise<void>(resolve => this.summarySpaceWaiters.push(resolve));
    }
    if (this.summaryController.signal.aborted) return;
    this.summaryQueue.push(task);
    this.pumpSummaryQueue();
  }

  private pumpSummaryQueue(): void {
    while (
      this.summaryActive < this.summaryConcurrency
      && this.summaryQueue.length > 0
      && !this.summaryController.signal.aborted
    ) {
      const task = this.summaryQueue.shift()!;
      this.summarySpaceWaiters.shift()?.();
      this.summaryActive++;
      void this.runSummaryTask(task, this.summaryController.signal)
        .then(() => { this.summaryCompleted++; })
        .catch(error => {
          if (!this.summaryController.signal.aborted) {
            this.summaryFailed++;
            console.warn(`[workspace-rag-v2] ${task.level} summary failed for ${task.unitId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        })
        .finally(() => {
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
    const generated = reusable?.summary ?? await summarize({
      level: task.level,
      title: task.title,
      breadcrumb: task.breadcrumb,
      text: task.text,
    }, signal);
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
    const vector = (await this.embedder.embed([`${task.title}\n${summaryText}`], 'document', signal))[0];
    if (vector?.length !== this.embedder.info.dimensions) return;
    await this.repository.putEmbeddings([{
      level: task.level,
      unitId: task.unitId,
      documentVersionId: task.documentVersionId ?? task.unitId,
      workspaceId: task.workspaceId,
      contextId: task.contextId,
      signature: this.embedder.info.signature,
      contentSha256: sha256(summaryText),
      vector,
    }], this.embedder.info);
  }

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
    this.assertSafeRegex(pattern);
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
        { limit: Math.max(1, Math.min(k, 25)), variant },
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
    const metrics = evaluateRagV2Results(results, k);
    const completedAt = now();
    await this.repository.saveEvaluationRun({
      id: runId,
      workspaceId: workspace.id,
      contextId: context.id,
      generationId: publication.generationId,
      embeddingSignature: this.embedder.info.signature,
      ...(this.rerankerUrl ? { rerankerModel: this.rerankerUrl } : {}),
      configuration: {
        k,
        variant,
        cases: cases.map(value => ({ id: value.id, category: value.category })),
      },
      metrics: metrics as unknown as Record<string, unknown>,
      createdAt,
      completedAt,
    });
    return { runId, generationId: publication.generationId, metrics };
  }

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
    for await (const file of discoverMarkdown(paths, signal)) {
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

  private async runIngestion(
    workspace: RagV2WorkspaceRef,
    context: RagV2ContextRef,
    job: RagV2Job,
    signal: AbortSignal,
  ): Promise<void> {
    await this.initialize();
    await this.repository.createJob(job);
    await this.repository.beginGeneration(workspace.id, context.id, job.generationId);
    const fingerprints = new Map(
      (await this.repository.listFingerprints(workspace.id, context.id)).map(value => [normalizedPath(value.path), value]),
    );
    try {
      for (const priority of ['authority', 'current', 'archive'] as const) {
        for await (const file of discoverMarkdown(context.paths, signal, priority)) {
        await this.waitWhilePaused(job, signal);
        if (signal.aborted) throw abortError(signal);
        job.discoveredFiles++;
        job.discoveredBytes += file.size;
        job.totalFiles = job.discoveredFiles;
        job.currentPath = file.path;
        job.checkpoint = file.path;
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
        const existing = fingerprints.get(file.path);
        const summarySignature = this.semanticServices?.summarizerSignature;
        if (
          existing
          && existing.byteLength === file.size
          && existing.modifiedAt === file.modifiedAt
          && existing.embeddingSignature === this.embedder.info.signature
          && (!summarySignature || existing.summarySignature === summarySignature)
        ) {
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
          continue;
        }
        try {
          await this.ingestFile(workspace, context, job, file, signal);
          job.processedFiles++;
          job.processedBytes += file.size;
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
        job.message = `Processed ${job.processedFiles} of ${job.discoveredFiles} discovered Markdown files.`;
        await this.repository.updateJob(job);
        }
      }
      if (signal.aborted) throw abortError(signal);
      job.state = 'validating';
      job.updatedAt = now();
      job.message = 'Validating the Workspace RAG V2 staging generation.';
      await this.repository.updateJob(job);
      await this.repository.reconcileGeneration(job.id, workspace.id, context.id, job.generationId);
      const collections = await this.repository.rebuildCollections(
        workspace.id,
        context.id,
        job.generationId,
      );
      for (let start = 0; start < collections.length; start += 32) {
        const batch = collections.slice(start, start + 32);
        const vectors = await this.embedder.embed(
          batch.map(collection => `${collection.title}\n${collection.routingSummary}`),
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
          contentSha256: collection.contentSha256,
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
          });
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
      job.state = publicationState;
      job.processedSections = validation.sections;
      job.processedPassages = validation.passages;
      job.lexicalReadyPassages = validation.lexicalReady;
      job.queuedEmbeddings = Math.max(0, validation.passages - validation.passageEmbeddings);
      job.estimatedRemainingSeconds = 0;
      job.updatedAt = now();
      job.message = `Published ${validation.documents} documents, ${validation.sections} sections, and ${validation.passages} passages.`;
      delete job.currentPath;
      await this.repository.updateJob(job);
      this.startLazyWorker();
    } catch (error) {
      if (signal.aborted || job.cancelRequested) {
        job.state = 'cancelled';
        job.message = 'Workspace RAG V2 ingestion cancelled; the previous publication remains active.';
      } else {
        job.state = 'retryable_failure';
        job.message = error instanceof Error ? error.message : String(error);
      }
      job.updatedAt = now();
      delete job.currentPath;
      await this.repository.updateJob(job);
      if (!signal.aborted) throw error;
    }
  }

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
    const flushSections = async (): Promise<void> => {
      if (sectionBatch.length === 0) return;
      const batch = sectionBatch.splice(0);
      for (const section of batch) section.embeddingState = 'queued';
      await this.repository.appendSections(batch);
      try {
        const reusable = batch.map(section => ({
          level: 'section' as const,
          unitId: section.sectionId,
          documentVersionId: section.documentVersionId,
          workspaceId: section.workspaceId,
          contextId: section.contextId,
          signature: this.embedder.info.signature,
          contentSha256: section.contentSha256,
        }));
        const reused = await this.repository.reuseEmbeddings(reusable, this.embedder.info);
        const pending = batch.filter(section => !reused.has(section.sectionId));
        job.readyEmbeddings += reused.size;
        if (pending.length > 0) {
          await this.embeddingLimiter.consume(pending.length, signal);
          const vectors = await this.embedder.embed(
            pending.map(section => `${section.headingPath.join(' > ')}\n${section.routingSummary}`),
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
            contentSha256: section.contentSha256,
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
        });
      }
    };
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
        try {
          const reusable = eager.map(passage => ({
            level: 'passage' as const,
            unitId: passage.passageId,
            documentVersionId: passage.documentVersionId,
            workspaceId: passage.workspaceId,
            contextId: passage.contextId,
            signature: this.embedder.info.signature,
            contentSha256: passage.contentSha256,
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
            contentSha256: passage.contentSha256,
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
        { workspaceId: workspace.id, contextId: context.id, documentId, documentVersionId },
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
        const reusable = [{
          level: 'document' as const,
          unitId: document.documentVersionId,
          documentVersionId: document.documentVersionId,
          workspaceId: document.workspaceId,
          contextId: document.contextId,
          signature: this.embedder.info.signature,
          contentSha256: document.contentSha256,
        }];
        const reused = await this.repository.reuseEmbeddings(reusable, this.embedder.info);
        job.readyEmbeddings += reused.size;
        await this.embeddingLimiter.consume(reused.size > 0 ? 0 : 1, signal);
        const vector = reused.size > 0 ? undefined : (await this.embedder.embed(
          [`${document.title}\n${document.routingSummary}`],
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
            contentSha256: document.contentSha256,
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
      });
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
      await lineWriter?.close().catch(() => undefined);
    }
  }

  private async waitWhilePaused(job: RagV2Job, signal: AbortSignal): Promise<void> {
    while (job.pauseRequested && !signal.aborted) await delay(100, signal);
  }

  private objectStore(workspace: RagV2WorkspaceRef): RagV2ObjectStore {
    let store = this.objectStores.get(workspace.id);
    if (!store) {
      const configured = process.env['CORTEX_RAG_V2_OBJECT_ROOT']?.trim();
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

  private assertSafeRegex(pattern: string): void {
    if (!pattern || pattern.length > 256) {
      throw new Error('Workspace RAG V2 regex must contain between 1 and 256 characters.');
    }
    if (/\\[1-9]|\(\?<([=!])|\(\?P<|\([^)]*[+*][^)]*\)\s*[+*{]/u.test(pattern)) {
      throw new Error('Workspace RAG V2 regex contains a prohibited backreference, lookbehind, or nested quantifier.');
    }
    try {
      new RegExp(pattern, 'u');
    } catch (error) {
      throw new Error(`Workspace RAG V2 regex is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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

  private startLazyWorker(): void {
    if (this.lazyWorker || this.lazySections.size === 0) return;
    this.lazyWorker = this.runLazyWorker()
      .catch(error => console.warn(`[workspace-rag-v2] lazy embedding worker failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.lazyWorker = undefined;
        if (this.lazySections.size > 0) this.startLazyWorker();
      });
  }

  private async runLazyWorker(): Promise<void> {
    const completedScopes = new Map<string, { workspaceId: string; contextId: string; generationId: string }>();
    while (this.lazySections.size > 0) {
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
      for (let start = 0; start < passages.length; start += 64) {
        const batch = passages.slice(start, start + 64);
        try {
          const reusable = batch.map(passage => ({
            level: 'passage' as const,
            unitId: passage.passageId,
            documentVersionId: passage.documentVersionId,
            workspaceId: passage.workspaceId,
            contextId: passage.contextId,
            signature: this.embedder.info.signature,
            contentSha256: passage.contentSha256,
          }));
          const reused = await this.repository.reuseEmbeddings(reusable, this.embedder.info);
          const pending = batch.filter(passage => !reused.has(passage.passageId));
          await this.embeddingLimiter.consume(pending.length);
          const vectors = pending.length > 0
            ? await this.embedder.embed(pending.map(passage => passage.text), 'document')
            : [];
          const records: RagV2EmbeddingRecord[] = pending.map((passage, index) => ({
            level: 'passage' as const,
            unitId: passage.passageId,
            documentVersionId: passage.documentVersionId,
            workspaceId: passage.workspaceId,
            contextId: passage.contextId,
            signature: this.embedder.info.signature,
            contentSha256: passage.contentSha256,
            vector: vectors[index] ?? [],
          })).filter(record => record.vector.length === this.embedder.info.dimensions);
          await this.repository.putEmbeddings(records, this.embedder.info);
        } catch {
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
