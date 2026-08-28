import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type {
  KnowledgeEntry,
  KnowledgeIndex,
  MatbotMachine,
  MatbotPluginSpec,
  MessageContent,
  Tool,
  ToolContext,
  ToolEvent,
} from '@matatbread/matbot-plugin-api';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { watch as watchFs, type FSWatcher } from 'node:fs';
import { access, appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ragV2GcSettingsFromEnv, ragV2ModeFromEnv } from './v2/config.js';
import type { RagV2EvaluationCase } from './v2/evaluation.js';
import { WorkspaceRagV2Manager, type RagV2SourceBridge } from './v2/manager.js';
import { MemoryRagV2Repository } from './v2/memory-repository.js';
import { PostgresRagV2Repository } from './v2/postgres-repository.js';
import type { RagV2SemanticServices } from './v2/semantic.js';
import {
  evaluateOpenSearchAdoption,
  type OpenSearchAdoptionGateInput,
} from './v2/search-backend.js';
import type {
  RagV2Mode,
  RagV2ConversationTurn,
  RagV2Job,
  RagV2RetrievalVariant,
  RagV2SearchResult,
  RagV2Status,
} from './v2/types.js';

const CONFIG_FILE = 'cortex-rag.json';
const REGISTRY_FILE = 'cortex-workspaces.json';
const LOG_FILE = 'ingestion.log';
const MAX_INGESTION_LOG_BYTES = 25 * 1024 * 1024;
const RAG_V2_EVALUATION_VARIANTS: readonly RagV2RetrievalVariant[] = [
  'flat_dense_baseline',
  'lexical_only',
  'dense_only',
  'hybrid_rrf',
  'hybrid_translated',
  'hybrid_reranked',
  'hierarchical',
  'hierarchical_lazy',
];
const VECTOR_DIMS = 384;
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const MIN_RECONCILE_INTERVAL_MS = 10_000;
const WATCH_DEBOUNCE_MS = 500;
const MAX_CONTEXT_CHUNKS = 4;
const DEFAULT_CUDA_EMBEDDING_URL = 'http://localhost:8890';
const CUDA_EMBED_REQUEST_LIMIT = 256;
const CUDA_EMBED_TIMEOUT_MS    = 120_000;
const CUDA_EMBED_MAX_ATTEMPTS  = 3;
const CPU_VECTOR_BACKEND = 'hash-cpu';
const CPU_VECTOR_MODEL = 'token-hash-v1';

type Accelerator = 'nvidia' | 'cpu';
type VectorizerBackend = 'hash-cpu' | 'cuda-http';
type EmbeddingPurpose = 'query' | 'document';

interface VectorizerMetadata {
  backend: VectorizerBackend;
  model: string;
  dimensions: number;
  signature: string;
}

interface VectorizerRuntime extends VectorizerMetadata {
  accelerated: boolean;
  accelerator: Accelerator;
  profile: string;
  maxTokens?: number;
  batchSize?: number;
}

interface TextVectorizer {
  readonly info: VectorizerRuntime;
  embed(texts: readonly string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<number[][]>;
}

interface WorkspaceRegistry {
  active: string;
  workspaces: Array<{ id: string; name: string; configPath: string }>;
}

interface RagContextConfig {
  id: string;
  name: string;
  paths: string[];
}

interface RagConfig {
  activeContextId: string;
  contexts: RagContextConfig[];
}

interface RagConfigView extends RagConfig {
  contextName: string;
  paths: string[];
}

interface RagConfigInput {
  contextId?: string;
  contextName?: string;
  paths?: string[];
}

interface WorkspaceRef {
  id: string;
  name: string;
  configPath: string;
  configDir: string;
  active: boolean;
}

interface WorkspaceRagLockStatus {
  locked: boolean;
  reason?: string;
  state?: RagV2Job['state'];
  message?: string;
}

interface V2ReconcileState {
  pending: boolean;
  triggers: Set<RagV2Job['trigger']>;
  changedPaths: Set<string>;
  forceAll: boolean;
  latestContext?: RagContextConfig;
  promise?: Promise<void>;
  currentJob?: RagV2Job;
  lastEventAt?: string;
  lastError?: string;
}

const SKIPPABLE_WATCH_ROOT_ERROR_CODES = new Set([
  'EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOTDIR', 'EPERM',
]);

function filesystemErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

interface WorkspaceRagStatus extends RagV2Status {
  contextName: string;
  paths: string[];
  watcher: {
    state: 'active' | 'degraded' | 'stopped';
    watchedRoots: number;
    pendingChanges: boolean;
    reconcileQueued: boolean;
    lastEventAt?: string;
    lastError?: string;
  };
  accelerator: Accelerator;
  accelerated: boolean;
  nvidiaAvailable: boolean;
  cudaAvailable: boolean;
  embeddingBackend: VectorizerBackend;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingProfile: string;
  embeddingSignature: string;
  embeddingMaxTokens?: number;
  embeddingBatchSize?: number;
  cudaServiceUrl?: string;
  accelerationMessage: string;
}

type SourceHealthState = 'unknown' | 'healthy' | 'degraded' | 'down';
type SourceStalenessState = 'unknown' | 'fresh' | 'stale' | 'expired';

interface SourceRegistrySourceLike {
  id: string;
  healthState: SourceHealthState;
  stalenessState: SourceStalenessState;
  title?: string;
  uri?: string;
}

interface SourceRegistryVersionLike {
  id: string;
}

interface SourceCitationLike {
  sourceId: string;
  text: string;
  policy: string;
  uri?: string;
  title?: string;
  versionId?: string;
  observedAt?: string;
}

interface SourceRegistryLike {
  stableSourceId(input: {
    workspaceId: string;
    connectorType: string;
    connectorInstanceId?: string;
    externalId: string;
  }): string;
  upsertSource(input: Record<string, unknown>): Promise<SourceRegistrySourceLike>;
  upsertVersion(input: Record<string, unknown>): Promise<SourceRegistryVersionLike>;
  getSource(id: string): Promise<SourceRegistrySourceLike | null>;
  recordHealth(input: {
    sourceId: string;
    state: SourceHealthState;
    checkedAt?: string;
    message?: string;
    details?: Record<string, unknown>;
  }): Promise<unknown>;
  recordAccess(input: {
    sourceId: string;
    action: 'read' | 'retrieve' | 'cite' | 'write' | 'delete' | 'health_check';
    allowed: boolean;
    timestamp?: string;
    message?: string;
    traceId?: string;
    toolCallId?: string;
  }): Promise<unknown>;
  resolveCitation(sourceId: string, versionId?: string): Promise<SourceCitationLike>;
}

interface ContextGraphLike {
  ingestSource(input: {
    sourceId: string;
    sourceVersionId?: string;
    text?: string;
    extractionMethod?: 'deterministic' | 'connector_metadata' | 'model_extracted' | 'user_confirmed';
  }): Promise<unknown>;
}

interface SearchHit {
  workspaceId: string;
  contextName: string;
  path: string;
  chunkId: string;
  score: number;
  text: string;
  sourceId?: string;
  sourceVersionId?: string;
  sourceHealthState?: SourceHealthState;
  sourceStalenessState?: SourceStalenessState;
  citation?: SourceCitationLike;
  documentId?: string;
  documentVersionId?: string;
  sectionId?: string;
  startByte?: number;
  endByte?: number;
  startLine?: number;
  endLine?: number;
  language?: string;
  retrievalReasons?: string[];
  retrievalRunId?: string;
}

interface SourceWarning {
  path: string;
  severity: 'warning' | 'critical';
  issueType: 'stale' | 'expired' | 'degraded' | 'down';
  message: string;
  sourceId?: string;
}

interface RetrievalTraceContext {
  traceId?: string;
  rootTraceId?: string;
  sessionId?: string;
  parentSpanId?: string;
  toolCallId?: string;
}

interface RetrievalConversationContext {
  turns: RagV2ConversationTurn[];
  provider?: string;
}

interface WorkspaceSearchOutcome {
  hits: SearchHit[];
  v2Result?: RagV2SearchResult;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

/**
 * Validates newly supplied context paths. Editing a context tolerates a mix of
 * available and unavailable roots because ingestion skips unavailable roots
 * gracefully; creating a context stays strict so typos fail fast.
 */
async function assertAccessibleContextPaths(paths: readonly string[], mode: 'all' | 'any'): Promise<void> {
  const inaccessible: string[] = [];
  for (const item of paths) {
    if (!(await exists(item))) inaccessible.push(item);
  }
  const rejected = mode === 'all' ? inaccessible.length > 0 : paths.length > 0 && inaccessible.length === paths.length;
  if (rejected) {
    throw new Error(`Workspace RAG context path is inaccessible: ${inaccessible[0]}`);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stableId(text: string): string {
  return sha256(text).slice(0, 32);
}

function normalizePathForId(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

function normalizeContextId(value: unknown, fallback: string): string {
  const raw = String(value ?? fallback).trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return normalized || 'default';
}

function uniqueContextId(base: string, existing: Set<string>): string {
  const normalized = normalizeContextId(base, 'context');
  let candidate = normalized;
  let index = 2;
  while (existing.has(candidate)) {
    candidate = `${normalized}-${index++}`;
  }
  existing.add(candidate);
  return candidate;
}

function normalizeFolderPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const normalized = new Map<string, string>();
  for (const item of paths) {
    const raw = String(item).trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    const key = process.platform === 'win32' ? normalizePathForId(resolved).toLowerCase() : normalizePathForId(resolved);
    if (!normalized.has(key)) normalized.set(key, resolved);
  }
  return [...normalized.values()];
}

function normalizeConfig(value: unknown, workspace: WorkspaceRef): RagConfig {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const contexts: RagContextConfig[] = [];
  const seen = new Set<string>();

  if (Array.isArray(record.contexts)) {
    for (const item of record.contexts) {
      if (!item || typeof item !== 'object') continue;
      const context = item as Record<string, unknown>;
      const name = typeof context.name === 'string' && context.name.trim()
        ? context.name.trim()
        : String(context.id ?? `Context ${contexts.length + 1}`);
      contexts.push({
        id: uniqueContextId(String(context.id ?? name), seen),
        name,
        paths: normalizeFolderPaths(context.paths),
      });
    }
  }

  if (contexts.length === 0) {
    contexts.push({
      id: 'default',
      name: typeof record.contextName === 'string' && record.contextName.trim()
        ? record.contextName.trim()
        : workspace.name || workspace.id,
      paths: normalizeFolderPaths(record.paths),
    });
  }

  const requestedActive = typeof record.activeContextId === 'string' ? record.activeContextId : contexts[0]!.id;
  const activeContextId = contexts.some(context => context.id === requestedActive) ? requestedActive : contexts[0]!.id;
  return { activeContextId, contexts };
}

function activeContext(config: RagConfig): RagContextConfig {
  return config.contexts.find(context => context.id === config.activeContextId) ?? config.contexts[0]!;
}

function configView(config: RagConfig): RagConfigView {
  const active = activeContext(config);
  return {
    ...config,
    contextName: active.name,
    paths: active.paths,
  };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9\u00c0-\u024f]{2,}/g) ?? [];
}

function vectorize(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIMS).fill(0);
  for (const token of tokenize(text)) {
    const hash = createHash('sha1').update(token).digest();
    const idx = hash.readUInt32BE(0) % VECTOR_DIMS;
    vector[idx] = (vector[idx] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map(value => value / norm) : vector;
}

function cpuVectorizerInfo(): VectorizerRuntime {
  return {
    backend: CPU_VECTOR_BACKEND,
    model: CPU_VECTOR_MODEL,
    dimensions: VECTOR_DIMS,
    signature: 'hash-cpu-token-hash-v1',
    accelerated: false,
    accelerator: 'cpu',
    profile: 'token-hash-v1',
  };
}

class HashCpuVectorizer implements TextVectorizer {
  readonly info = cpuVectorizerInfo();

  async embed(texts: readonly string[], _purpose: EmbeddingPurpose): Promise<number[][]> {
    return texts.map(text => vectorize(text));
  }
}

/**
 * Health payload reported by the CUDA embedding sidecar.
 */
export interface CudaHealthResponse {
  ok?: boolean;
  cudaAvailable?: boolean;
  device?: string;
  model?: string;
  dimensions?: number;
  profile?: string;
  signature?: string;
  maxTokens?: number;
  batchSize?: number;
  normalized?: boolean;
  queryPrefix?: string;
  documentPrefix?: string;
  message?: string;
  dtype?: string;
}

/**
 * Keep the CUDA sidecar contract in one testable place.  A status code alone is
 * not enough: vectors from a changed model or preprocessing profile cannot be
 * mixed safely with an existing Workspace RAG index.
 */
export function validateCudaEmbeddingHealth(health: CudaHealthResponse): string | undefined {
  if (health.ok !== true) return 'Embedding service did not report ok=true.';
  if (typeof health.model !== 'string' || !health.model.trim()) return 'Embedding service did not report a model.';
  if (!Number.isInteger(health.dimensions) || health.dimensions! <= 0) return 'Embedding service reported invalid dimensions.';
  if (typeof health.profile !== 'string' || !health.profile.trim()) return 'Embedding service did not report a profile.';
  if (typeof health.signature !== 'string' || !health.signature.trim()) return 'Embedding service did not report a preprocessing signature.';
  if (health.normalized !== true) return 'Embedding service must report normalized output.';
  if (!Number.isInteger(health.batchSize) || health.batchSize! <= 0 || health.batchSize! > CUDA_EMBED_REQUEST_LIMIT) {
    return `Embedding service reported invalid batch size (expected 1-${CUDA_EMBED_REQUEST_LIMIT}).`;
  }
  if (health.profile === 'e5-asymmetric-v1') {
    if (health.queryPrefix !== 'query: ' || health.documentPrefix !== 'passage: ') {
      return 'E5 embedding service must report query: and passage: preprocessing prefixes.';
    }
    if (health.model === 'intfloat/multilingual-e5-base' && health.dimensions !== 768) {
      return 'intfloat/multilingual-e5-base must report 768 dimensions.';
    }
  }
  if (health.profile === 'plain-v1') {
    if (health.queryPrefix !== '' || health.documentPrefix !== '') {
      return 'plain-v1 embedding service must not report asymmetric preprocessing prefixes.';
    }
    if (health.model === 'sentence-transformers/all-MiniLM-L6-v2' && health.dimensions !== 384) {
      return 'sentence-transformers/all-MiniLM-L6-v2 must report 384 dimensions.';
    }
  }
  return undefined;
}

interface VectorizerLaunchState {
  vectorizer: TextVectorizer;
  nvidiaAvailable: boolean;
  cudaAvailable: boolean;
  cudaServiceUrl?: string;
  accelerationMessage: string;
}

function isTruthyEnv(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_CUDA_EMBEDDING_URL).replace(/\/+$/, '');
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeCudaEmbeddingService(baseUrl: string): Promise<CudaHealthResponse> {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/health`, 1500);
    if (!response.ok) {
      return { ok: false, cudaAvailable: false, message: `Embedding service returned HTTP ${response.status}.` };
    }
    const body = await response.json() as CudaHealthResponse;
    const result: CudaHealthResponse = {
      ok: body.ok === true,
      cudaAvailable: body.cudaAvailable === true,
    };
    if (typeof body.device === 'string') result.device = body.device;
    if (typeof body.model === 'string') result.model = body.model;
    if (typeof body.dimensions === 'number' && Number.isFinite(body.dimensions)) result.dimensions = body.dimensions;
    if (typeof body.profile === 'string') result.profile = body.profile;
    if (typeof body.signature === 'string') result.signature = body.signature;
    if (typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens)) result.maxTokens = body.maxTokens;
    if (typeof body.batchSize === 'number' && Number.isFinite(body.batchSize)) result.batchSize = body.batchSize;
    if (typeof body.normalized === 'boolean') result.normalized = body.normalized;
    if (typeof body.queryPrefix === 'string') result.queryPrefix = body.queryPrefix;
    if (typeof body.documentPrefix === 'string') result.documentPrefix = body.documentPrefix;
    if (typeof body.message === 'string') result.message = body.message;
    if (typeof body.dtype === 'string') result.dtype = body.dtype;
    const validationError = validateCudaEmbeddingHealth(result);
    if (validationError !== undefined) return { ...result, ok: false, message: validationError };
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, cudaAvailable: false, message: `Embedding service unavailable: ${message}` };
  }
}

class CudaHttpVectorizer implements TextVectorizer {
  readonly info: VectorizerRuntime;
  private readonly baseUrl: string;

  constructor(baseUrl: string, health: Required<Pick<CudaHealthResponse, 'model' | 'dimensions' | 'profile' | 'signature' | 'batchSize'>> & Pick<CudaHealthResponse, 'maxTokens'>) {
    this.baseUrl = baseUrl;
    this.info = {
      backend: 'cuda-http',
      model: health.model,
      dimensions: health.dimensions,
      signature: health.signature,
      accelerated: true,
      accelerator: 'nvidia',
      profile: health.profile,
      batchSize: health.batchSize,
      ...(health.maxTokens !== undefined ? { maxTokens: health.maxTokens } : {}),
    };
  }

  async embed(texts: readonly string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const embeddings: number[][] = [];
    for (let start = 0; start < texts.length; start += CUDA_EMBED_REQUEST_LIMIT) {
      const batch = texts.slice(start, start + CUDA_EMBED_REQUEST_LIMIT);
      embeddings.push(...await this.embedBatch(batch, purpose, start, signal));
    }
    return embeddings;
  }

  private async embedBatch(texts: readonly string[], purpose: EmbeddingPurpose, offset: number, signal?: AbortSignal): Promise<number[][]> {
    const body = JSON.stringify({ texts, inputType: purpose });
    let response: Response | undefined;
    for (let attempt = 1;; attempt++) {
      const timeout = AbortSignal.timeout(CUDA_EMBED_TIMEOUT_MS);
      try {
        response = await fetch(`${this.baseUrl}/embed`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) {
        if (attempt >= CUDA_EMBED_MAX_ATTEMPTS || signal?.aborted) throw e;
      }
      if (response !== undefined
        && response.status !== 429 && response.status < 500) break;
      // Transient sidecar failure (429/5xx/network): back off and retry the batch.
      if (signal?.aborted || attempt >= CUDA_EMBED_MAX_ATTEMPTS) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(1_000 * 2 ** (attempt - 1), 10_000)));
    }
    if (response === undefined) throw new Error('CUDA embedding service request failed.');
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`CUDA embedding service HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const parsed = await response.json() as {
      embeddings?: unknown;
      dimensions?: unknown;
      model?: unknown;
      signature?: unknown;
      inputType?: unknown;
    };
    if (parsed.model !== this.info.model) {
      throw new Error(`CUDA embedding service model changed from "${this.info.model}" to "${String(parsed.model)}". Restart Matbot after the sidecar is stable.`);
    }
    if (parsed.signature !== this.info.signature) {
      throw new Error('CUDA embedding service preprocessing signature changed. Restart Matbot and reindex before searching.');
    }
    if (parsed.dimensions !== this.info.dimensions) {
      throw new Error(`CUDA embedding service dimensions changed from ${this.info.dimensions} to ${String(parsed.dimensions)}.`);
    }
    if (parsed.inputType !== purpose) {
      throw new Error(`CUDA embedding service returned inputType="${String(parsed.inputType)}"; expected "${purpose}".`);
    }
    if (!Array.isArray(parsed.embeddings)) throw new Error('CUDA embedding service returned no embeddings array.');
    if (parsed.embeddings.length !== texts.length) {
      throw new Error(`CUDA embedding service returned ${parsed.embeddings.length} embeddings for ${texts.length} text(s).`);
    }
    return parsed.embeddings.map((embedding, index) => {
      const embeddingIndex = offset + index;
      if (!Array.isArray(embedding)) throw new Error(`CUDA embedding ${embeddingIndex} is not an array.`);
      const vector = embedding.map(value => Number(value));
      if (vector.length !== this.info.dimensions) {
        throw new Error(`CUDA embedding ${embeddingIndex} has ${vector.length} dimensions; expected ${this.info.dimensions}.`);
      }
      if (vector.some(value => !Number.isFinite(value))) {
        throw new Error(`CUDA embedding ${embeddingIndex} contains a non-finite value.`);
      }
      return vector;
    });
  }
}

async function createLaunchVectorizer(): Promise<VectorizerLaunchState> {
  const nvidiaAvailable = await detectNvidia();
  if (isTruthyEnv(process.env['CORTEX_RAG_DISABLE_CUDA'])) {
    return {
      vectorizer: new HashCpuVectorizer(),
      nvidiaAvailable,
      cudaAvailable: false,
      accelerationMessage: 'CUDA ingestion disabled by CORTEX_RAG_DISABLE_CUDA.',
    };
  }

  const cudaServiceUrl = normalizeBaseUrl(
    process.env['CORTEX_RAG_CUDA_EMBEDDING_URL'] ?? process.env['CORTEX_RAG_EMBEDDING_URL'],
  );
  const probe = await probeCudaEmbeddingService(cudaServiceUrl);
  if (
    probe.ok
    && probe.cudaAvailable
    && probe.model
    && probe.dimensions
    && probe.dimensions > 0
    && probe.profile
    && probe.signature
    && probe.batchSize
  ) {
    const device = probe.device ? ` on ${probe.device}` : '';
    return {
      vectorizer: new CudaHttpVectorizer(cudaServiceUrl, {
        model: probe.model,
        dimensions: probe.dimensions,
        profile: probe.profile,
        signature: probe.signature,
        batchSize: probe.batchSize,
        ...(probe.maxTokens !== undefined ? { maxTokens: probe.maxTokens } : {}),
      }),
      nvidiaAvailable,
      cudaAvailable: true,
      cudaServiceUrl,
      accelerationMessage: `CUDA embedding backend active${device}.`,
    };
  }

  const reason = probe.message ?? (nvidiaAvailable
    ? 'CUDA embedding service is not ready.'
    : 'NVIDIA GPU was not detected by nvidia-smi.');
  return {
    vectorizer: new HashCpuVectorizer(),
    nvidiaAvailable,
    cudaAvailable: false,
    cudaServiceUrl,
    accelerationMessage: `Using CPU hash vectorizer. ${reason}`,
  };
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function detectNvidia(): Promise<boolean> {
  return new Promise(resolve => {
    const child = execFile('nvidia-smi', ['-L'], { timeout: 2000 }, error => resolve(!error));
    child.on('error', () => resolve(false));
  });
}

class WorkspaceRagKnowledgeIndex implements KnowledgeIndex {
  private readonly manager: WorkspaceRagManager;
  private readonly workspaceId: string;
  private readonly upstream: KnowledgeIndex | undefined;

  constructor(
    manager: WorkspaceRagManager,
    workspaceId: string,
    upstream?: KnowledgeIndex,
  ) {
    this.manager = manager;
    this.workspaceId = workspaceId;
    this.upstream = upstream;
  }

  *entries(): Iterable<KnowledgeEntry> {
    const upstreamEntries = this.upstream?.entries?.();
    if (upstreamEntries) yield* upstreamEntries;
  }

  async index(entry: KnowledgeEntry): Promise<void> {
    await this.upstream?.index(entry);
  }

  async search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]> {
    const query = terms.map(term => term.context ? `${term.term} ${term.context}` : term.term).join('\n');
    const [workspaceEntries, upstreamEntries] = await Promise.all([
      this.searchWorkspace(query, signal),
      this.upstream?.search(terms, signal).catch(error => {
        console.warn(`[workspace-rag] upstream KnowledgeIndex search failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }) ?? Promise.resolve([]),
    ]);
    const seen = new Set<string>();
    const merged: KnowledgeEntry[] = [];
    for (const entry of [...workspaceEntries, ...upstreamEntries]) {
      const key = `${entry.source.type}:${entry.source.uuid}:${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    return merged;
  }

  private async searchWorkspace(query: string, signal: AbortSignal): Promise<KnowledgeEntry[]> {
    const hits = await this.manager.search(this.workspaceId, query, MAX_CONTEXT_CHUNKS, signal);
    const timestamp = nowIso();
    return hits.map(hit => ({
      id: `workspace-rag:${hit.workspaceId}:${hit.chunkId}`,
      version: stableId(`${hit.chunkId}:${hit.score}`),
      entities: [hit.contextName, path.basename(hit.path)],
      tags: ['workspace-rag', hit.workspaceId],
      summary: `${hit.contextName}: ${path.basename(hit.path)}`,
      content: hit.text,
      contentHash: sha256(hit.text),
      source: { type: 'workspace-rag', uuid: hit.sourceId ?? hit.path },
      confidence: hit.score,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }
}

class WorkspaceRagManager {
  private readonly logRotationChecked = new Set<string>();
  private readonly reconcileStates = new Map<string, V2ReconcileState>();
  private readonly watchers: Array<{ watcher: FSWatcher; workspaceId: string; contextId: string; root: string }> = [];
  private readonly watchDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private gcTimer: ReturnType<typeof setTimeout> | undefined;
  private watcherState: 'active' | 'degraded' | 'stopped' = 'stopped';
  private watcherError: string | undefined;
  private vectorizer: TextVectorizer = new HashCpuVectorizer();
  private nvidiaAvailable = false;
  private cudaAvailable = false;
  private cudaServiceUrl: string | undefined;
  private accelerationMessage = 'Using CPU hash vectorizer.';
  private disposed = false;
  private readonly activeConfigPath: string;
  private readonly sourceRegistry: SourceRegistryLike | undefined;
  private readonly contextGraph: ContextGraphLike | undefined;
  private readonly services: MatbotMachine;
  private readonly v2Mode: RagV2Mode = ragV2ModeFromEnv();
  private readonly gcSettings = ragV2GcSettingsFromEnv();
  private v2: WorkspaceRagV2Manager | undefined;
  private v2Message = 'Workspace RAG V2 is disabled.';

  constructor(
    activeConfigPath: string,
    sourceRegistry: SourceRegistryLike | undefined,
    contextGraph: ContextGraphLike | undefined,
    services: MatbotMachine,
  ) {
    this.activeConfigPath = activeConfigPath;
    this.sourceRegistry = sourceRegistry;
    this.contextGraph = contextGraph;
    this.services = services;
  }

  async start(): Promise<void> {
    const launch = await createLaunchVectorizer();
    this.vectorizer = launch.vectorizer;
    this.nvidiaAvailable = launch.nvidiaAvailable;
    this.cudaAvailable = launch.cudaAvailable;
    this.cudaServiceUrl = launch.cudaServiceUrl;
    this.accelerationMessage = launch.accelerationMessage;
    await this.startV2();
    await this.refreshWatchers();
    const configuredInterval = Number(process.env['CORTEX_RAG_RECONCILE_INTERVAL_MS'] ?? DEFAULT_RECONCILE_INTERVAL_MS);
    const interval = Math.max(
      MIN_RECONCILE_INTERVAL_MS,
      Number.isFinite(configuredInterval) ? configuredInterval : DEFAULT_RECONCILE_INTERVAL_MS,
    );
    this.reconcileTimer = setInterval(() => {
      void this.reconcileAll('interval').catch(error => {
        this.watcherState = 'degraded';
        this.watcherError = errorMessage(error);
      });
    }, interval);
    this.scheduleGcTimer();
    void this.reconcileAll('startup').catch(error => {
      this.watcherState = 'degraded';
      this.watcherError = errorMessage(error);
    });
  }

  stop(): void {
    this.disposed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.gcTimer) clearTimeout(this.gcTimer);
    for (const timer of this.watchDebounce.values()) clearTimeout(timer);
    this.watchDebounce.clear();
    for (const { watcher } of this.watchers.splice(0)) watcher.close();
    this.watcherState = 'stopped';
    void this.v2?.close().catch(error => {
      console.warn(`[workspace-rag-v2] failed to close: ${errorMessage(error)}`);
    });
  }

  private reconcileKey(workspaceId: string, contextId: string): string {
    return `${workspaceId}\0${contextId}`;
  }

  private reconcileState(workspaceId: string, contextId: string): V2ReconcileState {
    const key = this.reconcileKey(workspaceId, contextId);
    const existing = this.reconcileStates.get(key);
    if (existing) return existing;
    const created: V2ReconcileState = {
      pending: false,
      triggers: new Set(),
      changedPaths: new Set(),
      forceAll: false,
    };
    this.reconcileStates.set(key, created);
    return created;
  }

  private async requestV2Reconcile(
    workspace: WorkspaceRef,
    context: RagContextConfig,
    trigger: RagV2Job['trigger'],
    wait: boolean,
    changedPaths: readonly string[] = [],
    forceAll = false,
  ): Promise<RagV2Job | undefined> {
    if (this.disposed || this.v2Mode === 'off') return undefined;
    if (!this.v2) throw new Error(this.v2Message);
    const key = this.reconcileKey(workspace.id, context.id);
    if (trigger !== 'watch') {
      const debounce = this.watchDebounce.get(key);
      if (debounce) clearTimeout(debounce);
      this.watchDebounce.delete(key);
    }
    const state = this.reconcileState(workspace.id, context.id);
    state.pending = true;
    state.triggers.add(trigger);
    state.latestContext = context;
    for (const changedPath of changedPaths) state.changedPaths.add(normalizePathForId(changedPath));
    state.forceAll ||= forceAll;
    if (trigger === 'watch') state.lastEventAt = nowIso();
    if (!state.promise) {
      state.promise = (async () => {
        while (!this.disposed && state.pending) {
          state.pending = false;
          const triggers = [...state.triggers];
          const forcedPaths = [...state.changedPaths];
          const forceEveryFile = state.forceAll;
          state.triggers.clear();
          state.changedPaths.clear();
          state.forceAll = false;
          const selected = triggers.includes('manual') ? 'manual'
            : triggers.includes('configuration') ? 'configuration'
              : triggers.includes('watch') ? 'watch'
                : triggers.includes('retry') ? 'retry'
                  : triggers.includes('interval') ? 'interval'
                    : 'startup';
          const latestContext = state.latestContext ?? context;
          const job = this.v2!.startIngestion(
            this.v2Workspace(workspace), latestContext, selected, forcedPaths, forceEveryFile,
          );
          state.currentJob = job;
          await this.v2!.waitForIngestion(workspace.id, context.id);
          let status: RagV2Status;
          try {
            status = await this.v2!.status(this.v2Mode, this.v2Workspace(workspace), latestContext);
          } catch (error) {
            state.lastError = errorMessage(error);
            console.warn(`[workspace-rag-v2] status check failed for ${workspace.id}/${context.id}: ${errorMessage(error)}`);
            continue;
          }
          const terminal = status.job;
          if (terminal?.state === 'retryable_failure' || terminal?.state === 'permanent_failure') {
            state.lastError = terminal.message ?? `Workspace RAG V2 reconciliation ended in ${terminal.state}.`;
          } else {
            delete state.lastError;
          }
        }
      })().catch(error => {
        state.lastError = errorMessage(error);
        console.warn(`[workspace-rag-v2] reconciliation loop failed for ${workspace.id}/${context.id}: ${errorMessage(error)}`);
      }).finally(() => {
        delete state.promise;
        if (state.pending && !this.disposed) {
          void this.requestV2Reconcile(workspace, context, 'retry', false).catch(error => {
            state.lastError = errorMessage(error);
          });
        }
      });
    }
    await Promise.resolve();
    if (wait) await state.promise;
    return state.currentJob;
  }

  private async reconcileAll(trigger: Extract<RagV2Job['trigger'], 'startup' | 'interval'>): Promise<void> {
    if (this.disposed || this.v2Mode === 'off' || !this.v2) return;
    const scheduled: Array<Promise<unknown>> = [];
    for (const workspace of this.workspacesActiveFirst(await this.listWorkspaces())) {
      let config: RagConfig;
      try {
        config = await this.readConfig(workspace);
      } catch (error) {
        console.warn(`[workspace-rag-v2] skipped workspace ${workspace.id}: ${errorMessage(error)}`);
        continue;
      }
      for (const context of config.contexts) {
        if (this.disposed) return;
        scheduled.push(this.requestV2Reconcile(workspace, context, trigger, false).catch(error => {
          this.reconcileState(workspace.id, context.id).lastError = errorMessage(error);
        }));
      }
    }
    await Promise.all(scheduled);
  }

  private scheduleGcTimer(): void {
    if (this.disposed || !this.gcSettings.enabled || this.v2Mode === 'off' || !this.v2) return;
    const jitter = 0.9 + Math.random() * 0.2;
    this.gcTimer = setTimeout(() => {
      this.gcTimer = undefined;
      void this.garbageCollectAll().catch(error => {
        console.warn(`[workspace-rag-v2] periodic orphan GC failed: ${errorMessage(error)}`);
      }).finally(() => this.scheduleGcTimer());
    }, Math.max(1, Math.round(this.gcSettings.intervalMs * jitter)));
    this.gcTimer.unref?.();
  }

  private async garbageCollectAll(): Promise<void> {
    if (this.disposed || !this.gcSettings.enabled || !this.v2) return;
    for (const workspace of this.workspacesActiveFirst(await this.listWorkspaces())) {
      let config: RagConfig;
      try {
        config = await this.readConfig(workspace);
      } catch (error) {
        console.warn(`[workspace-rag-v2] skipped orphan GC for workspace ${workspace.id}: ${errorMessage(error)}`);
        continue;
      }
      for (const context of config.contexts) {
        if (this.disposed) return;
        await this.v2.garbageCollect(this.v2Workspace(workspace), context);
      }
    }
  }

  private scheduleWatchReconcile(workspaceId: string, contextId: string, changedPath?: string): void {
    const key = this.reconcileKey(workspaceId, contextId);
    const state = this.reconcileState(workspaceId, contextId);
    if (changedPath?.toLocaleLowerCase().endsWith('.md')) {
      state.changedPaths.add(normalizePathForId(changedPath));
    }
    const existing = this.watchDebounce.get(key);
    if (existing) clearTimeout(existing);
    this.watchDebounce.set(key, setTimeout(() => {
      this.watchDebounce.delete(key);
      void (async () => {
        const workspace = (await this.listWorkspaces()).find(item => item.id === workspaceId);
        if (!workspace) return;
        const context = (await this.readConfig(workspace)).contexts.find(item => item.id === contextId);
        if (!context) return;
        await this.requestV2Reconcile(workspace, context, 'watch', false);
      })().catch(error => {
        const state = this.reconcileState(workspaceId, contextId);
        state.lastError = errorMessage(error);
        this.watcherState = 'degraded';
        this.watcherError = state.lastError;
      });
    }, WATCH_DEBOUNCE_MS));
  }

  private async refreshWatchers(): Promise<void> {
    for (const { watcher } of this.watchers.splice(0)) watcher.close();
    this.watcherState = this.v2Mode === 'off' || !this.v2 ? 'stopped' : 'active';
    this.watcherError = undefined;
    if (this.watcherState === 'stopped') return;
    for (const workspace of await this.listWorkspaces()) {
      const config = await this.readConfig(workspace);
      for (const context of config.contexts) {
        for (const root of context.paths) {
          const rootStat = await stat(root).catch(error => {
            if (SKIPPABLE_WATCH_ROOT_ERROR_CODES.has(filesystemErrorCode(error) ?? '')) {
              console.warn(`[workspace-rag-v2] skipped watcher for unavailable root ${root}: ${errorMessage(error)}`);
              return undefined;
            }
            this.watcherState = 'degraded';
            this.watcherError = `Cannot watch ${root}: ${errorMessage(error)}`;
            return undefined;
          });
          if (!rootStat) continue;
          const watchRoot = rootStat.isFile() ? path.dirname(root) : root;
          const expectedFile = rootStat.isFile() ? normalizePathForId(root) : undefined;
          let watcher: FSWatcher;
          try {
            watcher = watchFs(watchRoot, { recursive: rootStat.isDirectory() }, (eventType, filename) => {
              const changed = filename ? normalizePathForId(path.join(watchRoot, String(filename))) : undefined;
              if (expectedFile && changed && changed !== expectedFile) return;
              if (eventType === 'change' && changed && !changed.toLocaleLowerCase().endsWith('.md')) return;
              this.scheduleWatchReconcile(workspace.id, context.id, changed);
            });
          } catch (error) {
            this.watcherState = 'degraded';
            this.watcherError = `Cannot watch ${root}: ${errorMessage(error)}`;
            continue;
          }
          watcher.on('error', error => {
            this.watcherState = 'degraded';
            this.watcherError = `Watcher failed for ${root}: ${errorMessage(error)}`;
          });
          this.watchers.push({ watcher, workspaceId: workspace.id, contextId: context.id, root });
        }
      }
    }
  }

  currentWorkspaceId(): string {
    const normalized = normalizePathForId(this.activeConfigPath);
    const match = /\/workspaces\/([^/]+)\/matbot\.ya?ml$/i.exec(normalized);
    return match?.[1] ?? 'default';
  }

  async configureCurrent(config: RagConfigInput): Promise<RagConfigView> {
    const workspace = await this.currentWorkspace();
    const current = await this.readConfig(workspace);
    const targetId = typeof config.contextId === 'string' && config.contextId.trim()
      ? config.contextId.trim()
      : current.activeContextId;
    const context = current.contexts.find(item => item.id === targetId) ?? activeContext(current);
    if (typeof config.contextName === 'string' && !config.contextName.trim()) {
      throw new Error('Workspace RAG context name must not be blank.');
    }
    const nextName = typeof config.contextName === 'string' ? config.contextName.trim() : context.name;
    if (current.contexts.some(item => item.id !== context.id && item.name.localeCompare(nextName, undefined, { sensitivity: 'accent' }) === 0)) {
      throw new Error(`Workspace RAG context name "${nextName}" is already in use.`);
    }
    const previousPaths = context.paths;
    const nextPaths = Array.isArray(config.paths) ? normalizeFolderPaths(config.paths) : context.paths;
    if (Array.isArray(config.paths)) await assertAccessibleContextPaths(nextPaths, 'any');
    const pathsChanged = JSON.stringify(previousPaths) !== JSON.stringify(nextPaths);
    const next: RagConfig = {
      activeContextId: context.id,
      contexts: current.contexts.map(item => item.id === context.id ? {
        ...item,
        name: nextName,
        paths: nextPaths,
      } : item),
    };
    await writeJson(this.configPath(workspace), next);
    await this.log(workspace, 'configure', {
      contextId: context.id,
      contextName: activeContext(next).name,
      paths: activeContext(next).paths,
      pathsChanged,
    });
    await this.refreshWatchers();
    if (pathsChanged) void this.requestV2Reconcile(workspace, activeContext(next), 'configuration', false);
    return configView(next);
  }

  async selectContextCurrent(contextId: string): Promise<RagConfigView> {
    const workspace = await this.currentWorkspace();
    const current = await this.readConfig(workspace);
    const context = current.contexts.find(item => item.id === contextId);
    if (!context) throw new Error(`Unknown workspace RAG context "${contextId}".`);
    const next: RagConfig = { ...current, activeContextId: context.id };
    await writeJson(this.configPath(workspace), next);
    await this.log(workspace, 'select_context', {
      contextId: context.id,
      contextName: context.name,
      paths: context.paths,
    });
    return configView(next);
  }

  async createContextCurrent(contextName?: string, paths?: string[]): Promise<RagConfigView> {
    const workspace = await this.currentWorkspace();
    const current = await this.readConfig(workspace);
    if (contextName !== undefined && !contextName.trim()) throw new Error('Workspace RAG context name must not be blank.');
    const name = contextName?.trim() || `Context ${current.contexts.length + 1}`;
    if (current.contexts.some(context => context.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
      throw new Error(`Workspace RAG context name "${name}" is already in use.`);
    }
    const seen = new Set(current.contexts.map(context => context.id));
    const id = uniqueContextId(name, seen);
    const nextPaths = normalizeFolderPaths(paths);
    await assertAccessibleContextPaths(nextPaths, 'all');
    const nextContext: RagContextConfig = {
      id,
      name,
      paths: nextPaths,
    };
    const next: RagConfig = {
      activeContextId: id,
      contexts: [...current.contexts, nextContext],
    };
    await writeJson(this.configPath(workspace), next);
    await this.log(workspace, 'create_context', {
      contextId: id,
      contextName: name,
      paths: nextContext.paths,
    });
    await this.refreshWatchers();
    void this.requestV2Reconcile(workspace, nextContext, 'configuration', false);
    return configView(next);
  }

  async deleteContextCurrent(contextId: string): Promise<RagConfigView> {
    const workspace = await this.currentWorkspace();
    const current = await this.readConfig(workspace);
    const context = current.contexts.find(item => item.id === contextId);
    if (!context) throw new Error(`Unknown workspace RAG context "${contextId}".`);
    if (current.contexts.length === 1) throw new Error('Workspace RAG must retain one context. Configure its paths instead of deleting it.');
    const contexts = current.contexts.filter(item => item.id !== context.id);
    const next: RagConfig = {
      activeContextId: current.activeContextId === context.id ? contexts[0]!.id : current.activeContextId,
      contexts,
    };
    await writeJson(this.configPath(workspace), next);
    const reconcile = this.reconcileState(workspace.id, context.id);
    reconcile.pending = false;
    reconcile.triggers.clear();
    reconcile.changedPaths.clear();
    if (this.v2) {
      await this.v2.purgeContext(this.v2Workspace(workspace), context);
      await reconcile.promise;
      this.reconcileStates.delete(this.reconcileKey(workspace.id, context.id));
      await this.log(workspace, 'gc', {
        contextId: context.id,
        contextName: context.name,
        action: 'purge_context',
      });
    }
    await this.log(workspace, 'delete_context', { contextId: context.id, contextName: context.name });
    await this.refreshWatchers();
    return configView(next);
  }

  async statusCurrent(): Promise<WorkspaceRagStatus> {
    const workspace = await this.currentWorkspace();
    const context = activeContext(await this.readConfig(workspace));
    const v2 = await this.v2StatusCurrent() as RagV2Status;
    const state = this.reconcileState(workspace.id, context.id);
    const key = this.reconcileKey(workspace.id, context.id);
    const statusError = state.lastError ?? this.watcherError;
    return {
      ...v2,
      contextName: context.name,
      paths: context.paths,
      watcher: {
        state: this.watcherState,
        watchedRoots: this.watchers.filter(item => item.workspaceId === workspace.id && item.contextId === context.id).length,
        pendingChanges: state.pending || this.watchDebounce.has(key),
        reconcileQueued: state.pending,
        ...(state.lastEventAt ? { lastEventAt: state.lastEventAt } : {}),
        ...(statusError ? { lastError: statusError } : {}),
      },
      ...this.accelerationStatusFields(),
    };
  }

  workspaceLockStatus(workspaceId: string): WorkspaceRagLockStatus {
    const states = [...this.reconcileStates.entries()]
      .filter(([key]) => key.startsWith(`${workspaceId}\0`))
      .map(([, state]) => state);
    const active = states.find(state => state.promise || state.pending);
    if (!active) return { locked: false };
    return {
      locked: true,
      reason: active.pending ? 'Workspace indexing is queued.' : 'Workspace indexing is currently running.',
      ...(active.currentJob?.state ? { state: active.currentJob.state } : {}),
      ...(active.currentJob?.message ? { message: active.currentJob.message } : {}),
    };
  }

  async configCurrent(): Promise<RagConfigView> {
    return configView(await this.readConfig(await this.currentWorkspace()));
  }

  async searchCurrent(
    query: string,
    limit: number,
    signal: AbortSignal,
    trace?: RetrievalTraceContext,
    conversation?: RetrievalConversationContext,
  ): Promise<SearchHit[]> {
    return (await this.searchDetailed(this.currentWorkspaceId(), query, limit, signal, trace, conversation)).hits;
  }

  async search(workspaceId: string, query: string, limit: number, signal: AbortSignal, trace?: RetrievalTraceContext): Promise<SearchHit[]> {
    return (await this.searchDetailed(workspaceId, query, limit, signal, trace)).hits;
  }

  async searchCurrentDetailed(
    query: string,
    limit: number,
    signal: AbortSignal,
    trace?: RetrievalTraceContext,
    conversation?: RetrievalConversationContext,
  ): Promise<WorkspaceSearchOutcome> {
    return this.searchDetailed(this.currentWorkspaceId(), query, limit, signal, trace, conversation);
  }

  private async searchDetailed(
    workspaceId: string,
    query: string,
    limit: number,
    signal: AbortSignal,
    trace?: RetrievalTraceContext,
    conversation?: RetrievalConversationContext,
  ): Promise<WorkspaceSearchOutcome> {
    if (signal.aborted) return { hits: [] };
    const workspace = (await this.listWorkspaces()).find(item => item.id === workspaceId);
    if (!workspace || !query.trim()) return { hits: [] };
    const config = await this.readConfig(workspace);
    const active = activeContext(config);
    if (this.v2Mode === 'off' || !this.v2) return { hits: [] };
    try {
      const result = await this.v2.search(this.v2Workspace(workspace), active, query, {
        limit,
        ...(conversation?.turns.length ? { conversation: conversation.turns } : {}),
        ...(conversation?.provider ? { rewriteProvider: conversation.provider } : {}),
      }, signal);
      return {
        hits: result.evidence.length > 0
          ? await this.enrichSearchHits(workspace, active, this.v2SearchHits(workspace, active, result), trace)
          : [],
        v2Result: result,
      };
    } catch (error) {
      console.warn(`[workspace-rag-v2] V2-only search failed: ${errorMessage(error)}`);
      return { hits: [] };
    }
  }

  async v2StatusCurrent(): Promise<unknown> {
    const workspace = await this.currentWorkspace();
    const context = activeContext(await this.readConfig(workspace));
    if (!this.v2) {
      return {
        mode: this.v2Mode,
        available: false,
        backend: 'unavailable',
        indexedDocuments: 0,
        summaries: { enabled: false, queued: 0, active: 0, completed: 0, failed: 0 },
        message: this.v2Message,
      };
    }
    return this.v2.status(this.v2Mode, this.v2Workspace(workspace), context);
  }

  async v2StartCurrent(trigger: Extract<RagV2Job['trigger'], 'manual' | 'retry'> = 'manual'): Promise<unknown> {
    const { workspace, context } = await this.v2Current();
    await this.requestV2Reconcile(workspace, context, trigger, false);
    return this.statusCurrent();
  }

  async v2ReconcileCurrent(forceAll = false): Promise<unknown> {
    const { workspace, context } = await this.v2Current();
    await this.requestV2Reconcile(workspace, context, 'manual', true, [], forceAll);
    return this.statusCurrent();
  }

  async v2WaitCurrent(): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    await this.reconcileState(workspace.id, context.id).promise;
    await manager.waitForIngestion(workspace.id, context.id);
    return this.statusCurrent();
  }

  async v2PauseCurrent(): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.pause(workspace.id, context.id);
  }

  async v2ResumeCurrent(): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.resume(workspace.id, context.id);
  }

  async v2CancelCurrent(): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.cancel(workspace.id, context.id);
  }

  async v2EvictCurrent(limit: number): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.evictColdPassageEmbeddings(
      this.v2Workspace(workspace),
      context,
      limit,
    );
  }

  async v2GcCurrent(contextId?: string): Promise<unknown> {
    if (!this.v2) throw new Error(this.v2Message);
    const workspace = await this.currentWorkspace();
    const config = await this.readConfig(workspace);
    const context = contextId
      ? config.contexts.find(item => item.id === contextId)
      : activeContext(config);
    if (!context) throw new Error(`Unknown workspace RAG context "${contextId}".`);
    return this.v2.garbageCollect(this.v2Workspace(workspace), context);
  }

  async v2CensusCurrent(
    signal?: AbortSignal,
    options: { deep?: boolean; resumeAfter?: string } = {},
  ): Promise<unknown> {
    const { context, manager } = await this.v2Current();
    return manager.census(context.paths, signal, options);
  }

  async v2SearchCurrent(
    query: string,
    limit: number,
    signal: AbortSignal,
    filters: {
      documentTypes?: string[];
      jurisdictions?: string[];
      asOfDate?: string;
      conversation?: RagV2ConversationTurn[];
      rewriteProvider?: string;
      iterative?: boolean;
    } = {},
  ): Promise<RagV2SearchResult> {
    const { workspace, context, manager } = await this.v2Current();
    const result = await manager.search(
      this.v2Workspace(workspace), context, query, { limit, ...filters }, signal,
    );
    if (!this.sourceRegistry) return result;
    return {
      ...result,
      evidence: await Promise.all(result.evidence.map(async evidence => {
        if (!evidence.sourceId) return evidence;
        const source = await this.sourceRegistry!.getSource(evidence.sourceId).catch(() => null);
        return source ? {
          ...evidence,
          sourceHealth: source.healthState,
          sourceStaleness: source.stalenessState,
        } : evidence;
      })),
    };
  }

  async v2FetchRangeCurrent(documentVersionId: string, startByte: number, endByte: number): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.fetchSourceRange(
      this.v2Workspace(workspace), context, documentVersionId, startByte, endByte,
    );
  }

  async v2FetchLinesCurrent(documentVersionId: string, startLine: number, endLine: number): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.fetchLines(
      this.v2Workspace(workspace), context, documentVersionId, startLine, endLine,
    );
  }

  async v2GrepCurrent(documentVersionIds: string[], pattern: string, limit: number): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.grepDocuments(
      this.v2Workspace(workspace), context, documentVersionIds, pattern, limit,
    );
  }

  async v2EvaluateCurrent(
    cases: RagV2EvaluationCase[],
    k: number,
    variant: RagV2RetrievalVariant,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.evaluate(this.v2Workspace(workspace), context, cases, k, variant, signal);
  }

  private workspacesActiveFirst(workspaces: WorkspaceRef[]): WorkspaceRef[] {
    const current = this.currentWorkspaceId();
    return workspaces
      .map((workspace, index) => ({ workspace, index }))
      .sort((left, right) => {
        const leftPriority = left.workspace.active || left.workspace.id === current ? 0 : 1;
        const rightPriority = right.workspace.active || right.workspace.id === current ? 0 : 1;
        return leftPriority - rightPriority || left.index - right.index;
      })
      .map(item => item.workspace);
  }

  private fileSourceExternalId(contextId: string, normalizedPath: string): string {
    return `${contextId}:${normalizedPath}`;
  }

  private sourceId(workspace: WorkspaceRef, externalId: string): string | undefined {
    return this.sourceRegistry?.stableSourceId({
      workspaceId: workspace.id,
      connectorType: 'workspace-rag',
      externalId,
    });
  }

  private async extractContextGraphSource(
    workspace: WorkspaceRef,
    sourceId: string,
    sourceVersionId: string,
    text: string,
    extractionMethod: 'deterministic' | 'connector_metadata' | 'model_extracted' | 'user_confirmed',
  ): Promise<void> {
    if (this.contextGraph === undefined) return;
    try {
      await this.contextGraph.ingestSource({ sourceId, sourceVersionId, text, extractionMethod });
    } catch (error) {
      await this.log(workspace, 'context_graph_extract_error', {
        sourceId,
        sourceVersionId,
        error: errorMessage(error),
      });
    }
  }

  private async registerFileReadFailure(
    workspace: WorkspaceRef,
    context: RagContextConfig,
    normalizedPath: string,
    error: unknown,
  ): Promise<void> {
    if (this.sourceRegistry === undefined) return;
    const externalId = this.fileSourceExternalId(context.id, normalizedPath);
    const source = await this.sourceRegistry.upsertSource({
      workspaceId: workspace.id,
      connectorType: 'workspace-rag',
      externalId,
      uri: normalizedPath,
      title: path.basename(normalizedPath),
      sourceKind: 'document',
      schemaOrDocumentType: 'markdown',
      sensitivity: 'internal',
      permissionState: 'partial',
      trustLevel: 'medium',
      citationPolicy: 'cite_path',
      healthState: 'degraded',
      stalenessState: 'stale',
      lastObservedAt: nowIso(),
      knownLimitations: ['Workspace RAG could not read this configured source during the last scan.'],
    });
    await this.sourceRegistry.recordHealth({
      sourceId: source.id,
      state: 'degraded',
      checkedAt: nowIso(),
      message: `Workspace RAG failed to read markdown source: ${errorMessage(error)}`,
      details: { path: normalizedPath },
    });
  }

  private async enrichSearchHits(
    workspace: WorkspaceRef,
    context: RagContextConfig,
    hits: SearchHit[],
    trace?: RetrievalTraceContext,
  ): Promise<SearchHit[]> {
    const sourceRegistry = this.sourceRegistry;
    if (sourceRegistry === undefined) return hits;
    return Promise.all(hits.map(async hit => {
      const externalId = this.fileSourceExternalId(context.id, normalizePathForId(hit.path));
      const sourceId = this.sourceId(workspace, externalId);
      if (sourceId === undefined) return hit;
      const source = await sourceRegistry.getSource(sourceId);
      if (source === null) return hit;
      await sourceRegistry.recordAccess({
        sourceId,
        action: 'retrieve',
        allowed: true,
        timestamp: nowIso(),
        message: 'Workspace RAG returned this source as retrieval context.',
        ...(trace?.traceId !== undefined ? { traceId: trace.traceId } : {}),
        ...(trace?.toolCallId !== undefined ? { toolCallId: trace.toolCallId } : {}),
      });
      const citation = await sourceRegistry.resolveCitation(sourceId).catch(() => undefined);
      return {
        ...hit,
        sourceId,
        sourceHealthState: source.healthState,
        sourceStalenessState: source.stalenessState,
        ...(citation !== undefined ? { citation } : {}),
      };
    }));
  }

  private accelerationStatusFields(): Pick<
    WorkspaceRagStatus,
    | 'nvidiaAvailable'
    | 'cudaAvailable'
    | 'accelerated'
    | 'accelerator'
    | 'embeddingBackend'
    | 'embeddingModel'
    | 'embeddingDimensions'
    | 'embeddingProfile'
    | 'embeddingSignature'
    | 'embeddingMaxTokens'
    | 'embeddingBatchSize'
    | 'cudaServiceUrl'
    | 'accelerationMessage'
  > {
    return {
      nvidiaAvailable: this.nvidiaAvailable,
      cudaAvailable: this.cudaAvailable,
      accelerated: this.vectorizer.info.accelerated,
      accelerator: this.vectorizer.info.accelerator,
      embeddingBackend: this.vectorizer.info.backend,
      embeddingModel: this.vectorizer.info.model,
      embeddingDimensions: this.vectorizer.info.dimensions,
      embeddingProfile: this.vectorizer.info.profile,
      embeddingSignature: this.vectorizer.info.signature,
      ...(this.vectorizer.info.maxTokens !== undefined ? { embeddingMaxTokens: this.vectorizer.info.maxTokens } : {}),
      ...(this.vectorizer.info.batchSize !== undefined ? { embeddingBatchSize: this.vectorizer.info.batchSize } : {}),
      ...(this.cudaServiceUrl ? { cudaServiceUrl: this.cudaServiceUrl } : {}),
      accelerationMessage: this.accelerationMessage,
    };
  }

  private async startV2(): Promise<void> {
    if (this.v2Mode === 'off') return;
    const storageMode = String(process.env['CORTEX_RAG_V2_STORAGE'] ?? 'postgres').trim().toLowerCase();
    const repository = storageMode === 'memory'
      ? new MemoryRagV2Repository()
      : new PostgresRagV2Repository();
    const embedder = {
      info: {
        backend: this.vectorizer.info.backend,
        model: this.vectorizer.info.model,
        dimensions: this.vectorizer.info.dimensions,
        signature: this.vectorizer.info.signature,
        ...(this.vectorizer.info.maxTokens !== undefined ? { maxTokens: this.vectorizer.info.maxTokens } : {}),
      },
      embed: (
        texts: readonly string[],
        purpose: EmbeddingPurpose,
        signal?: AbortSignal,
      ) => this.vectorizer.embed(texts, purpose, signal),
    };
    const manager = new WorkspaceRagV2Manager(
      repository,
      embedder,
      this.v2SourceBridge(),
      this.v2SemanticServices(),
      async event => {
        const workspace: WorkspaceRef = {
          id: event.workspace.id,
          name: event.workspace.name,
          configDir: event.workspace.configDir,
          configPath: path.join(event.workspace.configDir, 'matbot.yaml'),
          active: event.workspace.id === this.currentWorkspaceId(),
        };
        await this.log(workspace, 'gc', {
          contextId: event.context.id,
          contextName: event.context.name,
          result: event.result,
          retiredGenerationsDeleted: event.retiredGenerationsDeleted,
          completedAt: event.completedAt,
          durationMs: event.durationMs,
        });
      },
    );
    try {
      await manager.initialize();
      this.v2 = manager;
      this.v2Message = `Workspace RAG V2 ${this.v2Mode} mode is ready with ${repository.backend}.`;
    } catch (error) {
      await manager.close().catch(() => undefined);
      this.v2Message = `Workspace RAG V2 initialization failed; workspace RAG is unavailable. ${errorMessage(error)}`;
      console.warn(`[workspace-rag-v2] ${this.v2Message}`);
    }
  }

  private v2SourceBridge(): RagV2SourceBridge | undefined {
    if (!this.sourceRegistry) return undefined;
    return {
      register: async (workspace, context, normalizedPath, contentSha256, modifiedAt, summary) => {
        const externalId = this.fileSourceExternalId(context.id, normalizedPath);
        const workspaceRef: WorkspaceRef = {
          id: workspace.id,
          name: workspace.name,
          configPath: path.join(workspace.configDir, 'matbot.yaml'),
          configDir: workspace.configDir,
          active: workspace.id === this.currentWorkspaceId(),
        };
        const stableSourceId = this.sourceId(workspaceRef, externalId);
        const previous = stableSourceId ? await this.sourceRegistry!.getSource(stableSourceId) : null;
        const source = await this.sourceRegistry!.upsertSource({
          workspaceId: workspace.id,
          connectorType: 'workspace-rag',
          externalId,
          uri: normalizedPath,
          title: path.basename(normalizedPath),
          sourceKind: 'document',
          schemaOrDocumentType: 'markdown',
          sensitivity: 'internal',
          permissionState: 'allowed',
          trustLevel: 'medium',
          citationPolicy: 'cite_path',
          healthState: 'healthy',
          lastObservedAt: nowIso(),
          lastSuccessfulReadAt: nowIso(),
          knownLimitations: [
            'Workspace RAG V2 indexes immutable document, section, and passage evidence.',
            'Generated summaries route retrieval but are not final answer evidence.',
          ],
        });
        if (previous && previous.healthState !== 'healthy') {
          await this.sourceRegistry!.recordHealth({
            sourceId: source.id,
            state: 'healthy',
            checkedAt: nowIso(),
            message: 'Workspace RAG source is present in the active V2 publication.',
            details: { path: normalizedPath, contextId: context.id, lifecycle: 'restored' },
          });
        }
        const version = await this.sourceRegistry!.upsertVersion({
          sourceId: source.id,
          contentHash: contentSha256,
          observedAt: modifiedAt,
          provenance: { activityId: `workspace-rag-v2:${workspace.id}:${context.id}:ingest` },
        });
        return { sourceId: source.id, sourceVersionId: version.id };
      },
      enrichContextGraph: async (workspace, context, normalizedPath, registration, summary) => {
        if (!registration.sourceId || !registration.sourceVersionId) return;
        await this.extractContextGraphSource(
          {
            id: workspace.id,
            name: workspace.name,
            configPath: path.join(workspace.configDir, 'matbot.yaml'),
            configDir: workspace.configDir,
            active: workspace.id === this.currentWorkspaceId(),
          },
          registration.sourceId,
          registration.sourceVersionId,
          `${path.basename(normalizedPath)}\n${summary}`,
          'deterministic',
        );
      },
      recordFailure: async (workspace, context, normalizedPath, error) => {
        await this.registerFileReadFailure(
          {
            id: workspace.id,
            name: workspace.name,
            configPath: path.join(workspace.configDir, 'matbot.yaml'),
            configDir: workspace.configDir,
            active: workspace.id === this.currentWorkspaceId(),
          },
          context,
          normalizedPath,
          error,
        );
      },
      markRemoved: async (workspace, context, normalizedPaths) => {
        for (const normalizedPath of normalizedPaths) {
          const workspaceRef: WorkspaceRef = {
            id: workspace.id,
            name: workspace.name,
            configPath: path.join(workspace.configDir, 'matbot.yaml'),
            configDir: workspace.configDir,
            active: workspace.id === this.currentWorkspaceId(),
          };
          const sourceId = this.sourceId(
            workspaceRef,
            this.fileSourceExternalId(context.id, normalizedPath),
          );
          if (!sourceId || await this.sourceRegistry!.getSource(sourceId) === null) continue;
          await this.sourceRegistry!.recordHealth({
            sourceId,
            state: 'down',
            checkedAt: nowIso(),
            message: 'Workspace RAG source is no longer present in the active V2 publication.',
            details: { path: normalizedPath, contextId: context.id, lifecycle: 'removed' },
          });
        }
      },
    };
  }

  private v2SemanticServices(): RagV2SemanticServices {
    const services = this.services;
    const summaryProvider = process.env['CORTEX_RAG_V2_SUMMARY_PROVIDER']?.trim();
    const summaryModel = summaryProvider ? services.providers.get(summaryProvider)?.model : undefined;
    const parseJsonString = (text: string, key: string): string | undefined => {
      const match = /\{[\s\S]*\}/u.exec(text);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]) as Record<string, unknown>;
          if (typeof parsed[key] === 'string' && parsed[key].trim()) return parsed[key].trim();
        } catch {
          // Fall through to a bounded plain-text response.
        }
      }
      const value = text.replace(/^```(?:json)?|```$/gimu, '').trim();
      return value || undefined;
    };
    return {
      rewriteQuery: async input => {
        if (!input.provider || !services.providers.has(input.provider)) return undefined;
        const result = await services.singleTurn({
          provider: input.provider,
          system: [
            'Rewrite a conversational follow-up as one standalone knowledge-retrieval query.',
            'Resolve pronouns, ellipsis, relative versions, people, and dates only from the supplied conversation.',
            'Preserve exact identifiers and quoted strings. Do not answer the question.',
            'Return JSON only: {"standaloneQuery":"..."}.',
          ].join(' '),
          prompt: `Conversation:\n${input.compactConversation}\n\nLatest question:\n${input.latestQuestion}`,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return parseJsonString(result.text, 'standaloneQuery');
      },
      ...(summaryProvider && services.providers.has(summaryProvider) ? {
        summarizerSignature: `${summaryProvider}:${summaryModel ?? 'unknown'}:rag-routing-summary-v1`,
        summarize: async (input, signal) => {
          const result = await services.singleTurn({
            provider: summaryProvider,
            system: [
              'Create a concise semantic routing summary for retrieval.',
              'Include distinctive topics, entities, terminology, version cues, and relationships.',
              'Do not invent facts. The output is a routing derivative and will never be cited as evidence.',
              'Use at most 180 words. Return JSON only: {"summary":"..."}.',
            ].join(' '),
            prompt: [
              `Level: ${input.level}`,
              `Title: ${input.title}`,
              `Breadcrumb: ${input.breadcrumb.join(' > ')}`,
              `Source material:\n${input.text.slice(0, 12_000)}`,
            ].join('\n\n'),
            ...(signal ? { signal } : {}),
          });
          return parseJsonString(result.text, 'summary');
        },
      } : {}),
    };
  }

  private async v2Current(): Promise<{
    workspace: WorkspaceRef;
    context: RagContextConfig;
    manager: WorkspaceRagV2Manager;
  }> {
    if (!this.v2) throw new Error(this.v2Message);
    const workspace = await this.currentWorkspace();
    const context = activeContext(await this.readConfig(workspace));
    return { workspace, context, manager: this.v2 };
  }

  private v2Workspace(workspace: WorkspaceRef): { id: string; name: string; configDir: string } {
    return { id: workspace.id, name: workspace.name, configDir: workspace.configDir };
  }

  private v2SearchHits(
    workspace: WorkspaceRef,
    context: RagContextConfig,
    result: RagV2SearchResult,
  ): SearchHit[] {
    return result.evidence.map(evidence => ({
      workspaceId: workspace.id,
      contextName: context.name,
      path: evidence.sourceUri,
      chunkId: evidence.passageId,
      score: evidence.score,
      text: evidence.text,
      ...(evidence.sourceId ? { sourceId: evidence.sourceId } : {}),
      ...(evidence.sourceVersionId ? { sourceVersionId: evidence.sourceVersionId } : {}),
      documentId: evidence.documentId,
      documentVersionId: evidence.documentVersionId,
      sectionId: evidence.sectionId,
      startByte: evidence.byteRange.from,
      endByte: evidence.byteRange.to,
      startLine: evidence.lineRange.from,
      endLine: evidence.lineRange.to,
      language: evidence.language,
      retrievalReasons: evidence.retrievalReasons,
      retrievalRunId: result.runId,
      citation: {
        sourceId: evidence.sourceId ?? evidence.documentId,
        policy: 'cite_path',
        text: `${evidence.sourceUri}:${evidence.lineRange.from}-${evidence.lineRange.to}`,
        uri: evidence.sourceUri,
        title: evidence.title,
        ...(evidence.sourceVersionId ? { versionId: evidence.sourceVersionId } : {}),
      },
    }));
  }

  private async currentWorkspace(): Promise<WorkspaceRef> {
    const current = this.currentWorkspaceId();
    return (await this.listWorkspaces()).find(item => item.id === current) ?? {
      id: current,
      name: current === 'default' ? 'Default' : current,
      configPath: this.activeConfigPath,
      configDir: path.dirname(this.activeConfigPath),
      active: true,
    };
  }

  private async listWorkspaces(): Promise<WorkspaceRef[]> {
    const registryPath = await this.registryPath();
    if (!registryPath) {
      const workspace = await this.currentWorkspaceFallback();
      return [workspace];
    }
    const registry = await readJson<WorkspaceRegistry>(registryPath, { active: 'default', workspaces: [] });
    if (registry.workspaces.length === 0) return [await this.currentWorkspaceFallback()];
    return registry.workspaces.map(record => {
      const configPath = path.resolve(path.dirname(registryPath), record.configPath);
      return {
        id: record.id,
        name: record.name,
        configPath,
        configDir: path.dirname(configPath),
        active: record.id === registry.active,
      };
    });
  }

  private async currentWorkspaceFallback(): Promise<WorkspaceRef> {
    const id = this.currentWorkspaceId();
    return {
      id,
      name: id === 'default' ? 'Default' : id,
      configPath: this.activeConfigPath,
      configDir: path.dirname(this.activeConfigPath),
      active: true,
    };
  }

  private async registryPath(): Promise<string | null> {
    const env = process.env['CORTEX_WORKSPACES_FILE'];
    if (env && await exists(env)) return path.resolve(env);
    let dir = path.dirname(this.activeConfigPath);
    while (true) {
      const candidate = path.join(dir, REGISTRY_FILE);
      if (await exists(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private configPath(workspace: WorkspaceRef): string {
    return path.join(workspace.configDir, CONFIG_FILE);
  }

  private async readConfig(workspace: WorkspaceRef): Promise<RagConfig> {
    return normalizeConfig(await readJson<unknown>(this.configPath(workspace), null), workspace);
  }

  private logPath(workspace: WorkspaceRef): string {
    return path.join(workspace.configDir, '.data', 'workspace-rag', LOG_FILE);
  }

  private async log(workspace: WorkspaceRef, event: string, fields: Record<string, unknown> = {}): Promise<void> {
    const logPath = this.logPath(workspace);
    const entry = {
      timestamp: nowIso(),
      event,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      configPath: workspace.configPath,
      ...fields,
    };
    const line = `${JSON.stringify(entry)}\n`;
    try {
      await mkdir(path.dirname(logPath), { recursive: true });
      if (!this.logRotationChecked.has(workspace.id)) {
        this.logRotationChecked.add(workspace.id);
        const logStat = await stat(logPath).catch(() => null);
        if (logStat !== null && logStat.size > MAX_INGESTION_LOG_BYTES) {
          const archivePath = `${logPath}.1`;
          await rm(archivePath, { force: true });
          await rename(logPath, archivePath);
        }
      }
      await appendFile(logPath, line, 'utf8');
    } catch (error) {
      console.warn(`[workspace-rag] failed to write ingestion log for ${workspace.id}: ${errorMessage(error)}`);
    }
  }

}

async function observeRetrieval(
  services: MatbotMachine,
  trace: RetrievalTraceContext,
  query: string,
  hits: SearchHit[],
  startedAt: number,
  spanId: string,
): Promise<void> {
  const observability = services.get('Observability');
  if (observability === undefined || trace.traceId === undefined) return;
  try {
    await observability.record({
      traceId: trace.traceId,
      rootTraceId: trace.rootTraceId ?? trace.traceId,
      spanId,
      ...(trace.parentSpanId !== undefined ? { parentSpanId: trace.parentSpanId } : {}),
      ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
      timestamp: nowIso(),
      phase: 'end', kind: 'retriever', name: 'workspace_rag.search', status: 'ok',
      durationMs: Date.now() - startedAt,
      attributes: {
        queryHash: sha256(query),
        returnedCount: hits.length,
        retrievedSourceIds: hits.map(hit => hit.sourceId).filter((value): value is string => value !== undefined),
        hits: hits.map((hit, rank) => ({ rank: rank + 1, sourceId: hit.sourceId ?? null, sourceVersionId: hit.sourceVersionId ?? null, score: hit.score, path: hit.path, citation: hit.citation ?? null, health: hit.sourceHealthState ?? null, freshness: hit.sourceStalenessState ?? null })),
      },
    });
  } catch (error) {
    console.warn(`[workspace-rag] observability sink failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createWorkspaceRagTool(manager: WorkspaceRagManager, services: MatbotMachine): Tool {
  return {
    name: 'workspace_rag',
    description:
      'Configure and inspect the V2-only workspace-scoped Markdown hybrid index. The tool watches configured local roots, ' +
      'publishes atomic reconciled generations, reports ingestion and watcher state, and searches verified V2 evidence.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          description: 'reconcile_now is incremental; reindex_now forces every discovered file through the V2 pipeline; gc reclaims orphaned V2 persistence.',
          enum: [
            'status', 'get_config', 'configure', 'select_context', 'create_context', 'delete_context',
            'search', 'reindex_now',
            'ingestion_start', 'ingestion_pause', 'ingestion_resume', 'ingestion_cancel',
            'ingestion_retry', 'ingestion_status', 'ingestion_wait', 'reconcile_now',
            'corpus_census', 'v2_search', 'grep_documents', 'fetch_source_range', 'fetch_lines',
            'evaluation_run', 'backend_gate_evaluate',
            'embedding_evict', 'gc',
          ],
        },
        contextId: { type: 'string', description: 'Workspace RAG context id for select_context, delete_context, configure, or gc (defaults to active).' },
        contextName: { type: 'string', description: 'Human-facing name for this workspace RAG context.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute local folder paths or individual Markdown files.' },
        query: { type: 'string', description: 'Search query for action=search.' },
        limit: { type: 'number', default: 5 },
        documentVersionId: { type: 'string', description: 'Immutable V2 document version id for range retrieval.' },
        documentVersionIds: { type: 'array', items: { type: 'string' }, description: 'Authorized immutable V2 document versions for narrowed regex.' },
        pattern: { type: 'string', description: 'Bounded regular expression for action=grep_documents.' },
        startByte: { type: 'number', description: 'Inclusive source byte offset.' },
        endByte: { type: 'number', description: 'Exclusive source byte offset.' },
        startLine: { type: 'number', description: 'Inclusive one-based source line.' },
        endLine: { type: 'number', description: 'Inclusive one-based source line.' },
        evaluationCases: {
          type: 'array',
          items: { type: 'object' },
          description: 'V2 evaluation cases with id, category, query, judgments, and optional forbiddenPassageIds.',
        },
        k: { type: 'number', default: 10, description: 'Evaluation cutoff for Recall, Precision, nDCG, and MRR.' },
        evaluationVariant: {
          type: 'string',
          enum: [...RAG_V2_EVALUATION_VARIANTS],
          default: 'hierarchical_lazy',
          description: 'Retriever ablation persisted with evaluation metrics for flat dense, lexical, dense, RRF, translation, reranking, hierarchy, and lazy-promotion comparisons.',
        },
        deep: {
          type: 'boolean',
          default: true,
          description: 'For corpus_census, stream every file to measure structure, language, and duplicate forecasts.',
        },
        resumeAfter: {
          type: 'string',
          description: 'For corpus_census, resume after the normalized checkpoint path returned by an interrupted run.',
        },
        documentTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional V2 document-type filters, for example contract or policy.',
        },
        jurisdictions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional V2 jurisdiction filters, for example PL or EU.',
        },
        asOfDate: {
          type: 'string',
          description: 'Optional ISO date used to filter publication and validity ranges.',
        },
        iterative: {
          type: 'boolean',
          default: true,
          description: 'Enable the bounded follow-up retrieval pass. The final evidence-sufficiency gate and explicit abstention always remain enabled.',
        },
        backendGate: {
          type: 'object',
          description: 'Measured PostgreSQL/OpenSearch metrics, targets, benefit, and operational approval.',
        },
        evictionLimit: {
          type: 'number',
          default: 1000,
          description: 'Maximum oldest passage-vector derivatives removed by embedding_evict.',
        },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        const action = typeof value.action === 'string' ? value.action : 'status';
        try {
          if (action === 'status') {
            yield { type: 'result', value: await manager.statusCurrent() };
            return;
          }
          if (action === 'get_config') {
            yield { type: 'result', value: await manager.configCurrent() };
            return;
          }
          if (action === 'configure') {
            const next = await manager.configureCurrent({
              ...(typeof value.contextId === 'string' ? { contextId: value.contextId } : {}),
              ...(typeof value.contextName === 'string' ? { contextName: value.contextName } : {}),
              ...(Array.isArray(value.paths) ? { paths: value.paths.map(item => String(item)) } : {}),
            });
            yield { type: 'result', value: { config: next, status: await manager.statusCurrent() } };
            return;
          }
          if (action === 'select_context') {
            const contextId = typeof value.contextId === 'string' ? value.contextId : '';
            if (!contextId.trim()) { yield { type: 'error', message: 'workspace_rag select_context requires "contextId".' }; return; }
            const next = await manager.selectContextCurrent(contextId.trim());
            yield { type: 'result', value: { config: next, status: await manager.statusCurrent() } };
            return;
          }
          if (action === 'create_context') {
            const next = await manager.createContextCurrent(
              typeof value.contextName === 'string' ? value.contextName : undefined,
              Array.isArray(value.paths) ? value.paths.map(item => String(item)) : undefined,
            );
            yield { type: 'result', value: { config: next, status: await manager.statusCurrent() } };
            return;
          }
          if (action === 'delete_context') {
            const contextId = typeof value.contextId === 'string' ? value.contextId : '';
            if (!contextId.trim()) { yield { type: 'error', message: 'workspace_rag delete_context requires "contextId".' }; return; }
            const next = await manager.deleteContextCurrent(contextId.trim());
            yield { type: 'result', value: { config: next, status: await manager.statusCurrent() } };
            return;
          }
          if (action === 'reindex_now') {
            yield { type: 'result', value: await manager.v2ReconcileCurrent(true) };
            return;
          }
          if (action === 'reconcile_now') {
            yield { type: 'result', value: await manager.v2ReconcileCurrent(false) };
            return;
          }
          if (action === 'ingestion_start') {
            yield { type: 'result', value: await manager.v2StartCurrent('manual') };
            return;
          }
          if (action === 'ingestion_retry') {
            yield { type: 'result', value: await manager.v2StartCurrent('retry') };
            return;
          }
          if (action === 'ingestion_pause') {
            yield { type: 'result', value: await manager.v2PauseCurrent() };
            return;
          }
          if (action === 'ingestion_resume') {
            yield { type: 'result', value: await manager.v2ResumeCurrent() };
            return;
          }
          if (action === 'ingestion_cancel') {
            yield { type: 'result', value: await manager.v2CancelCurrent() };
            return;
          }
          if (action === 'embedding_evict') {
            const evictionLimit = typeof value.evictionLimit === 'number'
              ? value.evictionLimit
              : 1_000;
            yield { type: 'result', value: await manager.v2EvictCurrent(evictionLimit) };
            return;
          }
          if (action === 'gc') {
            yield {
              type: 'result',
              value: await manager.v2GcCurrent(
                typeof value.contextId === 'string' && value.contextId.trim()
                  ? value.contextId.trim()
                  : undefined,
              ),
            };
            return;
          }
          if (action === 'ingestion_status') {
            yield { type: 'result', value: await manager.statusCurrent() };
            return;
          }
          if (action === 'ingestion_wait') {
            yield { type: 'result', value: await manager.v2WaitCurrent() };
            return;
          }
          if (action === 'corpus_census') {
            yield {
              type: 'result',
              value: await manager.v2CensusCurrent(ctx.signal, {
                ...(typeof value.deep === 'boolean' ? { deep: value.deep } : {}),
                ...(typeof value.resumeAfter === 'string' ? { resumeAfter: value.resumeAfter } : {}),
              }),
            };
            return;
          }
          if (action === 'v2_search') {
            const query = typeof value.query === 'string' ? value.query : '';
            if (!query.trim()) { yield { type: 'error', message: 'workspace_rag v2_search requires "query".' }; return; }
            const limit = typeof value.limit === 'number' ? value.limit : 5;
            yield {
              type: 'result',
              value: await manager.v2SearchCurrent(query, limit, ctx.signal, {
                ...(Array.isArray(value.documentTypes)
                  ? { documentTypes: value.documentTypes.map(item => String(item)).filter(Boolean) }
                  : {}),
                ...(Array.isArray(value.jurisdictions)
                  ? { jurisdictions: value.jurisdictions.map(item => String(item)).filter(Boolean) }
                  : {}),
                ...(typeof value.asOfDate === 'string' ? { asOfDate: value.asOfDate } : {}),
                conversation: conversationBeforeLatestUser(ctx.session),
                ...(ctx.provider ? { rewriteProvider: ctx.provider } : {}),
                ...(typeof value.iterative === 'boolean' ? { iterative: value.iterative } : {}),
              }),
            };
            return;
          }
          if (action === 'backend_gate_evaluate') {
            if (!value.backendGate || typeof value.backendGate !== 'object') {
              yield { type: 'error', message: 'workspace_rag backend_gate_evaluate requires "backendGate".' };
              return;
            }
            yield {
              type: 'result',
              value: evaluateOpenSearchAdoption(value.backendGate as OpenSearchAdoptionGateInput),
            };
            return;
          }
          if (action === 'grep_documents') {
            const documentVersionIds = Array.isArray(value.documentVersionIds)
              ? value.documentVersionIds.map(item => String(item)).filter(Boolean)
              : [];
            const pattern = typeof value.pattern === 'string' ? value.pattern : '';
            if (documentVersionIds.length === 0 || !pattern) {
              yield { type: 'error', message: 'workspace_rag grep_documents requires "documentVersionIds" and "pattern".' };
              return;
            }
            const limit = typeof value.limit === 'number' ? value.limit : 50;
            yield { type: 'result', value: await manager.v2GrepCurrent(documentVersionIds, pattern, limit) };
            return;
          }
          if (action === 'fetch_source_range') {
            const documentVersionId = typeof value.documentVersionId === 'string' ? value.documentVersionId : '';
            const startByte = typeof value.startByte === 'number' ? value.startByte : Number.NaN;
            const endByte = typeof value.endByte === 'number' ? value.endByte : Number.NaN;
            if (!documentVersionId || !Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte)) {
              yield { type: 'error', message: 'workspace_rag fetch_source_range requires "documentVersionId", "startByte", and "endByte".' };
              return;
            }
            yield { type: 'result', value: await manager.v2FetchRangeCurrent(documentVersionId, startByte, endByte) };
            return;
          }
          if (action === 'fetch_lines') {
            const documentVersionId = typeof value.documentVersionId === 'string' ? value.documentVersionId : '';
            const startLine = typeof value.startLine === 'number' ? value.startLine : Number.NaN;
            const endLine = typeof value.endLine === 'number' ? value.endLine : Number.NaN;
            if (!documentVersionId || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) {
              yield { type: 'error', message: 'workspace_rag fetch_lines requires "documentVersionId", "startLine", and "endLine".' };
              return;
            }
            yield { type: 'result', value: await manager.v2FetchLinesCurrent(documentVersionId, startLine, endLine) };
            return;
          }
          if (action === 'evaluation_run') {
            const cases = Array.isArray(value.evaluationCases)
              ? value.evaluationCases.filter(item => item && typeof item === 'object') as unknown as RagV2EvaluationCase[]
              : [];
            if (cases.length === 0) {
              yield { type: 'error', message: 'workspace_rag evaluation_run requires "evaluationCases".' };
              return;
            }
            const k = typeof value.k === 'number' ? value.k : 10;
            const evaluationVariant = typeof value.evaluationVariant === 'string'
              && RAG_V2_EVALUATION_VARIANTS.includes(value.evaluationVariant as RagV2RetrievalVariant)
              ? value.evaluationVariant as RagV2RetrievalVariant
              : 'hierarchical_lazy';
            yield {
              type: 'result',
              value: await manager.v2EvaluateCurrent(cases, k, evaluationVariant, ctx.signal),
            };
            return;
          }
          if (action === 'search') {
            const query = typeof value.query === 'string' ? value.query : '';
            if (!query.trim()) { yield { type: 'error', message: 'workspace_rag search requires "query".' }; return; }
            const limit = typeof value.limit === 'number' ? value.limit : 5;
            const trace = { ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}), ...(ctx.rootTraceId !== undefined ? { rootTraceId: ctx.rootTraceId } : {}), ...(ctx.parentSpanId !== undefined ? { parentSpanId: ctx.parentSpanId } : {}), ...(ctx.session?.id !== undefined ? { sessionId: ctx.session.id } : {}), ...(ctx.callId !== undefined ? { toolCallId: ctx.callId } : {}) };
            const startedAt = Date.now();
            const spanId = randomUUID();
            const hits = await manager.searchCurrent(query, limit, ctx.signal, trace, {
              turns: conversationBeforeLatestUser(ctx.session),
              ...(ctx.provider ? { provider: ctx.provider } : {}),
            });
            await observeRetrieval(services, trace, query, hits, startedAt, spanId);
            yield { type: 'result', value: { hits } };
            return;
          }
          yield { type: 'error', message: `Unknown workspace_rag action "${action}".` };
        } catch (error) {
          yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
        }
      },
    },
  };
}

function latestUserText(session: { messages: Array<{ role: string; content: MessageContent[] }> }): string {
  const last = session.messages.findLast(message => message.role === 'user');
  if (!last) return '';
  return last.content
    .filter((part): part is Extract<MessageContent, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

function conversationBeforeLatestUser(
  session: { messages: Array<{ role: string; content: MessageContent[] }> } | undefined,
): RagV2ConversationTurn[] {
  if (!session) return [];
  const latestUserIndex = session.messages.findLastIndex(message => message.role === 'user');
  if (latestUserIndex <= 0) return [];
  return session.messages.slice(0, latestUserIndex)
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => ({
      role: message.role as RagV2ConversationTurn['role'],
      text: message.content
        .filter((part): part is Extract<MessageContent, { type: 'text' }> =>
          part.type === 'text' && (!('origin' in part) || part.origin !== 'robo'))
        .map(part => part.text)
        .join('\n'),
    }))
    .filter(turn => turn.text.trim().length > 0)
    .slice(-8);
}

function renderAbstention(result: RagV2SearchResult): string {
  return [
    '[Workspace RAG retrieval result]',
    'The indexed corpus does not contain enough verified evidence to answer this request.',
    `Standalone retrieval query: ${result.plan.standaloneQuery}`,
    `Reason: ${result.answerability.reasons.join('; ')}`,
    'Do not imply that the corpus supports a factual answer. State the evidence limitation explicitly.',
    '[End workspace RAG retrieval result.]',
  ].join('\n');
}

function renderContext(hits: SearchHit[], answerability?: RagV2SearchResult['answerability']): string {
  if (hits.length === 0) return '';
  return [
    `[Workspace RAG context — ${hits[0]!.contextName}. Use this as grounded local context when relevant; cite file paths when relying on it.]`,
    ...(answerability?.status === 'conflicting'
      ? [`[Warning: retrieved sources conflict. Describe the disagreement and cite each side; do not silently choose one.]`]
      : []),
    ...hits.map((hit, index) => [
      `## Source ${index + 1}: ${hit.path}`,
      `Score: ${hit.score.toFixed(3)}`,
      ...(hit.sourceId !== undefined ? [`Source id: ${hit.sourceId}`] : []),
      ...(hit.sourceHealthState !== undefined ? [`Source health: ${hit.sourceHealthState}`] : []),
      ...(hit.sourceStalenessState !== undefined ? [`Source freshness: ${hit.sourceStalenessState}`] : []),
      ...(hit.documentVersionId !== undefined ? [`Document version: ${hit.documentVersionId}`] : []),
      ...(hit.sectionId !== undefined ? [`Section id: ${hit.sectionId}`] : []),
      ...(hit.startLine !== undefined && hit.endLine !== undefined ? [`Lines: ${hit.startLine}-${hit.endLine}`] : []),
      ...(hit.language !== undefined ? [`Language: ${hit.language}`] : []),
      ...(hit.retrievalReasons?.length ? [`Retrieved by: ${hit.retrievalReasons.join('; ')}`] : []),
      ...sourceWarningsForHit(hit).map(warning => `Warning: ${warning.message}`),
      ...(hit.citation !== undefined ? [`Citation: ${hit.citation.text}`] : []),
      hit.text,
    ].join('\n')),
    '[End workspace RAG context.]',
  ].join('\n\n');
}

function sourceWarningsForHit(hit: SearchHit): SourceWarning[] {
  const warnings: SourceWarning[] = [];
  if (hit.sourceHealthState === 'down') {
    warnings.push({
      path: hit.path,
      severity: 'critical',
      issueType: 'down',
      message: 'This source is marked down or unavailable; verify it before relying on it.',
      ...(hit.sourceId !== undefined ? { sourceId: hit.sourceId } : {}),
    });
  } else if (hit.sourceHealthState === 'degraded') {
    warnings.push({
      path: hit.path,
      severity: 'warning',
      issueType: 'degraded',
      message: 'This source is marked degraded; verify it before relying on it.',
      ...(hit.sourceId !== undefined ? { sourceId: hit.sourceId } : {}),
    });
  }
  if (hit.sourceStalenessState === 'expired') {
    warnings.push({
      path: hit.path,
      severity: 'critical',
      issueType: 'expired',
      message: 'This source has expired freshness; prefer newer evidence if available.',
      ...(hit.sourceId !== undefined ? { sourceId: hit.sourceId } : {}),
    });
  } else if (hit.sourceStalenessState === 'stale') {
    warnings.push({
      path: hit.path,
      severity: 'warning',
      issueType: 'stale',
      message: 'This source is stale; cite it with that limitation.',
      ...(hit.sourceId !== undefined ? { sourceId: hit.sourceId } : {}),
    });
  }
  return warnings;
}

let activeManager: WorkspaceRagManager | undefined;

/**
 * Default plugin specification: builds and starts the workspace RAG manager,
 * registers it as the `WorkspaceRagManager` service, installs the
 * `workspace_rag` tool, and adds a screen hook injecting per-turn context.
 *
 * @returns The plugin specification.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Workspace-scoped markdown RAG ingestion, vector search, and automatic per-turn context.',
  },
  async setup(services: MatbotMachine) {
    if (services.isSubAgent()) return;
    if (!services.configPath) throw new Error('workspace-rag requires services.configPath.');

    const sourceRegistry = services.get('SourceRegistry' as never) as SourceRegistryLike | undefined;
    const contextGraph = services.get('ContextGraph' as never) as ContextGraphLike | undefined;
    const manager = new WorkspaceRagManager(services.configPath, sourceRegistry, contextGraph, services);
    activeManager = manager;
    await manager.start();
    await services.register('WorkspaceRagManager' as never, manager as never);
    services.tools.register(createWorkspaceRagTool(manager, services));
    services.hooks.register({
      on: 'screen',
      priority: -10,
      async handler(ctx) {
        const query = latestUserText(ctx.session);
        if (!query.trim()) return;
        const status = await manager.statusCurrent();
        if (!status.activeGenerationId) return {
          markers: [{
            type: 'marker',
            creator: 'workspace-rag',
            data: { state: status.job?.state ?? 'pending', message: status.message },
          }],
        };
        const trace = { ...(ctx.config.traceId !== undefined ? { traceId: ctx.config.traceId } : {}), ...(ctx.config.rootTraceId !== undefined ? { rootTraceId: ctx.config.rootTraceId } : {}), sessionId: ctx.session.id };
        const startedAt = Date.now();
        const spanId = randomUUID();
        const outcome = await manager.searchCurrentDetailed(query, MAX_CONTEXT_CHUNKS, ctx.signal, trace, {
          turns: conversationBeforeLatestUser(ctx.session),
          provider: ctx.config.provider,
        });
        const hits = outcome.hits;
        await observeRetrieval(services, trace, query, hits, startedAt, spanId);
        if (outcome.v2Result?.answerability.abstained) {
          return {
            ephemeral: [{ type: 'text', text: renderAbstention(outcome.v2Result) }],
            markers: [{
              type: 'marker',
              creator: 'workspace-rag',
              data: {
                state: 'insufficient_evidence',
                standaloneQuery: outcome.v2Result.plan.standaloneQuery,
                reasons: outcome.v2Result.answerability.reasons,
              },
            }],
          };
        }
        const text = renderContext(hits, outcome.v2Result?.answerability);
        if (!text) return;
        const sourceWarnings = hits.flatMap(sourceWarningsForHit);
        return {
          ephemeral: [{ type: 'text', text }],
          markers: [{
            type: 'marker',
            creator: 'workspace-rag',
            data: {
              ...(sourceWarnings.length > 0 ? { sourceWarnings } : {}),
              hits: hits.map(hit => ({
                path: hit.path,
                score: hit.score,
                ...(hit.sourceId !== undefined ? { sourceId: hit.sourceId } : {}),
                ...(hit.sourceHealthState !== undefined ? { sourceHealthState: hit.sourceHealthState } : {}),
                ...(hit.sourceStalenessState !== undefined ? { sourceStalenessState: hit.sourceStalenessState } : {}),
              })),
            },
          }],
        };
      },
    });
  },
  async teardown() {
    activeManager?.stop();
    activeManager = undefined;
  },
};

export default plugin;
