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
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createRagStorage,
  documentMatchesVectorizer,
  type RagStorage,
} from './storage.js';

const CONFIG_FILE = 'cortex-rag.json';
const REGISTRY_FILE = 'cortex-workspaces.json';
const LOG_FILE = 'ingestion.log';
const VECTOR_DIMS = 384;
const SCAN_INTERVAL_MS = 60_000;
const MAX_CHUNK_CHARS = 1800;
const MAX_CONTEXT_CHUNKS = 4;
const DEFAULT_CUDA_EMBEDDING_URL = 'http://localhost:8890';
const CUDA_EMBED_REQUEST_LIMIT = 256;
const CPU_VECTOR_BACKEND = 'hash-cpu';
const CPU_VECTOR_MODEL = 'token-hash-v1';
const STORED_VECTOR_DECIMAL_PLACES = 6;
const STORED_VECTOR_SCALE = 10 ** STORED_VECTOR_DECIMAL_PLACES;

type Accelerator = 'nvidia' | 'cpu';
type VectorizerBackend = 'hash-cpu' | 'cuda-http';

interface VectorizerMetadata {
  backend: VectorizerBackend;
  model: string;
  dimensions: number;
}

interface VectorizerRuntime extends VectorizerMetadata {
  accelerated: boolean;
  accelerator: Accelerator;
}

interface TextVectorizer {
  readonly info: VectorizerRuntime;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
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

interface VectorChunk {
  id: string;
  text: string;
  vector: number[];
}

interface IndexedDocument {
  id: string;
  contextId?: string;
  path: string;
  hash: string;
  vectorizer?: VectorizerMetadata;
  updatedAt: string;
  chunks: VectorChunk[];
}

interface IngestionStatus {
  workspaceId: string;
  contextName: string;
  paths: string[];
  state: 'pending' | 'idle' | 'indexing' | 'error';
  totalFiles: number;
  processedFiles: number;
  percent: number;
  currentFile?: string;
  lastIndexedAt?: string;
  message?: string;
  nvidiaAvailable: boolean;
  cudaAvailable: boolean;
  accelerated: boolean;
  accelerator: Accelerator;
  embeddingBackend: VectorizerBackend;
  embeddingModel: string;
  embeddingDimensions: number;
  cudaServiceUrl?: string;
  accelerationMessage?: string;
  storageBackend: 'json' | 'postgres-pgvector';
  storageMessage: string;
  postgresHost?: string;
  postgresPort?: number;
  postgresDatabase?: string;
  postgresSchema?: string;
  postgresTables?: string[];
  legacyJsonPath?: string;
}

interface WorkspaceRagLockStatus {
  locked: boolean;
  reason?: string;
  state?: IngestionStatus['state'];
  message?: string;
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
}

interface SourceWarning {
  path: string;
  severity: 'warning' | 'critical';
  issueType: 'stale' | 'expired' | 'degraded' | 'down';
  message: string;
  sourceId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error && typeof error.stack === 'string'
    ? error.stack.slice(0, 4000)
    : undefined;
}

function compactStoredVector(vector: readonly number[]): number[] {
  return vector.map(value => Number.isFinite(value)
    ? Math.round(value * STORED_VECTOR_SCALE) / STORED_VECTOR_SCALE
    : 0);
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function countNulChars(text: string): number {
  let count = 0;
  for (let index = text.indexOf('\0'); index !== -1; index = text.indexOf('\0', index + 1)) count++;
  return count;
}

function stripNulChars(text: string): string {
  return text.includes('\0') ? text.replace(/\0/g, '') : text;
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
  return [...new Set(paths.map(item => String(item).trim()).filter(Boolean))].map(item => path.resolve(item));
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
    accelerated: false,
    accelerator: 'cpu',
  };
}

function vectorizerMetadata(info: VectorizerRuntime): VectorizerMetadata {
  return {
    backend: info.backend,
    model: info.model,
    dimensions: info.dimensions,
  };
}

class HashCpuVectorizer implements TextVectorizer {
  readonly info = cpuVectorizerInfo();

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(text => vectorize(text));
  }
}

interface CudaHealthResponse {
  ok?: boolean;
  cudaAvailable?: boolean;
  device?: string;
  model?: string;
  dimensions?: number;
  message?: string;
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
    if (typeof body.message === 'string') result.message = body.message;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, cudaAvailable: false, message: `Embedding service unavailable: ${message}` };
  }
}

class CudaHttpVectorizer implements TextVectorizer {
  readonly info: VectorizerRuntime;
  private readonly baseUrl: string;

  constructor(baseUrl: string, model: string, dimensions: number) {
    this.baseUrl = baseUrl;
    this.info = {
      backend: 'cuda-http',
      model,
      dimensions,
      accelerated: true,
      accelerator: 'nvidia',
    };
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const embeddings: number[][] = [];
    for (let start = 0; start < texts.length; start += CUDA_EMBED_REQUEST_LIMIT) {
      const batch = texts.slice(start, start + CUDA_EMBED_REQUEST_LIMIT);
      embeddings.push(...await this.embedBatch(batch, start, signal));
    }
    return embeddings;
  }

  private async embedBatch(texts: readonly string[], offset: number, signal?: AbortSignal): Promise<number[][]> {
    const request: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
    };
    if (signal) request.signal = signal;
    const response = await fetch(`${this.baseUrl}/embed`, request);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`CUDA embedding service HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const body = await response.json() as { embeddings?: unknown; dimensions?: unknown; model?: unknown };
    if (!Array.isArray(body.embeddings)) throw new Error('CUDA embedding service returned no embeddings array.');
    if (body.embeddings.length !== texts.length) {
      throw new Error(`CUDA embedding service returned ${body.embeddings.length} embeddings for ${texts.length} text(s).`);
    }
    return body.embeddings.map((embedding, index) => {
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
  if (probe.ok && probe.cudaAvailable && probe.model && probe.dimensions && probe.dimensions > 0) {
    const device = probe.device ? ` on ${probe.device}` : '';
    return {
      vectorizer: new CudaHttpVectorizer(cudaServiceUrl, probe.model, probe.dimensions),
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

function chunkMarkdown(content: string): string[] {
  const blocks = content.split(/\n(?=#{1,3}\s+)/g);
  const chunks: string[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.length <= MAX_CHUNK_CHARS) {
      chunks.push(trimmed);
      continue;
    }
    for (let i = 0; i < trimmed.length; i += MAX_CHUNK_CHARS) {
      chunks.push(trimmed.slice(i, i + MAX_CHUNK_CHARS).trim());
    }
  }
  return chunks;
}

function extractSummary(content: string): string {
  const heading = content.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading.slice(0, 180);
  return content.replace(/\s+/g, ' ').trim().slice(0, 180);
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

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.data') continue;
        await walk(next);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        results.push(next);
      }
    }
  }
  await walk(root);
  return results;
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
    await this.manager.indexKnowledgeEntry(this.workspaceId, entry);
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
  private readonly statuses = new Map<string, IngestionStatus>();
  private readonly scanInFlight = new Set<string>();
  private readonly scanQueued = new Set<string>();
  private readonly scanPromises = new Map<string, Promise<void>>();
  private backgroundScanPromise: Promise<void> | undefined;
  private backgroundScanQueued = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private vectorizer: TextVectorizer = new HashCpuVectorizer();
  private storage: RagStorage | undefined;
  private nvidiaAvailable = false;
  private cudaAvailable = false;
  private cudaServiceUrl: string | undefined;
  private accelerationMessage = 'Using CPU hash vectorizer.';
  private disposed = false;
  private readonly activeConfigPath: string;
  private readonly sourceRegistry: SourceRegistryLike | undefined;
  private readonly contextGraph: ContextGraphLike | undefined;

  constructor(activeConfigPath: string, sourceRegistry?: SourceRegistryLike, contextGraph?: ContextGraphLike) {
    this.activeConfigPath = activeConfigPath;
    this.sourceRegistry = sourceRegistry;
    this.contextGraph = contextGraph;
  }

  async start(): Promise<void> {
    const launch = await createLaunchVectorizer();
    this.vectorizer = launch.vectorizer;
    this.nvidiaAvailable = launch.nvidiaAvailable;
    this.cudaAvailable = launch.cudaAvailable;
    this.cudaServiceUrl = launch.cudaServiceUrl;
    this.accelerationMessage = launch.accelerationMessage;
    this.storage = await createRagStorage(this.vectorizer.info);
    this.timer = setInterval(() => this.startBackgroundScan('interval'), SCAN_INTERVAL_MS);
    this.startBackgroundScan('startup');
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    void this.storage?.close?.().catch(error => {
      console.warn(`[workspace-rag] failed to close storage backend: ${errorMessage(error)}`);
    });
  }

  private startBackgroundScan(reason: string): void {
    if (this.disposed) return;
    if (this.backgroundScanPromise) {
      this.backgroundScanQueued = true;
      return;
    }
    this.backgroundScanPromise = this.runBackgroundScans(reason)
      .finally(() => { this.backgroundScanPromise = undefined; });
  }

  private async runBackgroundScans(reason: string): Promise<void> {
    let scanReason = reason;
    do {
      this.backgroundScanQueued = false;
      try {
        await this.scanAll();
      } catch (error) {
        console.warn(`[workspace-rag] background scan failed (${scanReason}): ${errorMessage(error)}`);
      }
      scanReason = 'queued';
    } while (!this.disposed && this.backgroundScanQueued);
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
    const previousPaths = context.paths;
    const nextPaths = Array.isArray(config.paths) ? normalizeFolderPaths(config.paths) : context.paths;
    const pathsChanged = JSON.stringify(previousPaths) !== JSON.stringify(nextPaths);
    const next: RagConfig = {
      activeContextId: context.id,
      contexts: current.contexts.map(item => item.id === context.id ? {
        ...item,
        name: typeof config.contextName === 'string' && config.contextName.trim() ? config.contextName.trim() : item.name,
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
    this.statuses.delete(workspace.id);
    if (pathsChanged) await this.requestScanWorkspace(workspace);
    else await this.ensureStatus(workspace, next);
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
    this.statuses.delete(workspace.id);
    await this.requestScanWorkspace(workspace);
    return configView(next);
  }

  async createContextCurrent(contextName?: string, paths?: string[]): Promise<RagConfigView> {
    const workspace = await this.currentWorkspace();
    const current = await this.readConfig(workspace);
    const name = contextName?.trim() || `Context ${current.contexts.length + 1}`;
    const seen = new Set(current.contexts.map(context => context.id));
    const id = uniqueContextId(name, seen);
    const nextContext: RagContextConfig = {
      id,
      name,
      paths: normalizeFolderPaths(paths),
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
    this.statuses.delete(workspace.id);
    await this.requestScanWorkspace(workspace);
    return configView(next);
  }

  async statusCurrent(): Promise<IngestionStatus> {
    const workspace = await this.currentWorkspace();
    await this.ensureStatus(workspace);
    return this.statuses.get(workspace.id)!;
  }

  workspaceLockStatus(workspaceId: string): WorkspaceRagLockStatus {
    const status = this.statuses.get(workspaceId);
    if (this.scanPromises.has(workspaceId) || this.scanInFlight.has(workspaceId)) {
      return {
        locked: true,
        reason: 'Workspace indexing is currently running.',
        ...(status?.state !== undefined ? { state: status.state } : {}),
        ...(status?.message !== undefined ? { message: status.message } : {}),
      };
    }
    if (this.scanQueued.has(workspaceId)) {
      return {
        locked: true,
        reason: 'Workspace indexing is queued.',
        ...(status?.state !== undefined ? { state: status.state } : {}),
        ...(status?.message !== undefined ? { message: status.message } : {}),
      };
    }
    if (this.backgroundScanPromise) {
      return {
        locked: true,
        reason: 'Workspace indexing is pending in the background queue.',
        ...(status?.state !== undefined ? { state: status.state } : {}),
        ...(status?.message !== undefined ? { message: status.message } : {}),
      };
    }
    if (status?.state === 'indexing') {
      return {
        locked: true,
        reason: 'Workspace indexing is currently running.',
        state: status.state,
        ...(status.message !== undefined ? { message: status.message } : {}),
      };
    }
    return {
      locked: false,
      ...(status?.state !== undefined ? { state: status.state } : {}),
      ...(status?.message !== undefined ? { message: status.message } : {}),
    };
  }

  async configCurrent(): Promise<RagConfigView> {
    return configView(await this.readConfig(await this.currentWorkspace()));
  }

  async searchCurrent(query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]> {
    return this.search(this.currentWorkspaceId(), query, limit, signal);
  }

  async search(workspaceId: string, query: string, limit: number, signal: AbortSignal): Promise<SearchHit[]> {
    if (signal.aborted) return [];
    const workspace = (await this.listWorkspaces()).find(item => item.id === workspaceId);
    if (!workspace || !query.trim()) return [];
    const config = await this.readConfig(workspace);
    const active = activeContext(config);
    const queryVector = (await this.embedTexts([query], signal))[0] ?? [];
    const hits = await this.getStorage().search(workspace, active, this.vectorizer.info, queryVector, limit, signal);
    return this.enrichSearchHits(workspace, active, hits);
  }

  async indexKnowledgeEntry(workspaceId: string, entry: KnowledgeEntry): Promise<void> {
    const workspace = (await this.listWorkspaces()).find(item => item.id === workspaceId);
    if (!workspace) return;
    const config = await this.readConfig(workspace);
    const context = activeContext(config);
    const id = `knowledge:${context.id}:${entry.id}`;
    const content = stripNulChars(entry.content);
    const summary = stripNulChars(entry.summary);
    const entities = entry.entities.map(stripNulChars);
    const chunks = chunkMarkdown(content);
    const vectors = await this.embedTexts(
      chunks.map(text => `${summary}\n${entities.join(' ')}\n${text}`),
    );
    const document: IndexedDocument = {
      id,
      contextId: context.id,
      path: entry.source.uuid,
      hash: entry.contentHash ?? sha256(content),
      vectorizer: vectorizerMetadata(this.vectorizer.info),
      updatedAt: nowIso(),
      chunks: chunks.map((text, index) => ({
        id: `${id}:${index}`,
        text,
        vector: compactStoredVector(vectors[index] ?? []),
      })),
    };
    const storage = this.getStorage();
    await storage.upsertDocuments(workspace, [document]);
    await storage.flush(workspace);
    await this.registerKnowledgeSource(workspace, context, entry, document.hash);
    await this.log(workspace, 'knowledge_indexed', {
      entryId: entry.id,
      contextId: context.id,
      chunks: document.chunks.length,
      storage: storage.describe(workspace),
    });
  }

  async scanAll(): Promise<void> {
    if (this.disposed) return;
    for (const workspace of this.workspacesActiveFirst(await this.listWorkspaces())) {
      if (this.disposed) return;
      await this.requestScanWorkspace(workspace);
    }
  }

  async scanCurrent(): Promise<void> {
    if (this.disposed) return;
    await this.requestScanWorkspace(await this.currentWorkspace());
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

  private async requestScanWorkspace(workspace: WorkspaceRef): Promise<void> {
    const running = this.scanPromises.get(workspace.id);
    if (running) {
      this.scanQueued.add(workspace.id);
      await this.log(workspace, 'scan_queued', { reason: 'already_in_flight' });
      await running;
      return;
    }
    const promise = (async () => {
      do {
        this.scanQueued.delete(workspace.id);
        await this.scanWorkspace(workspace);
      } while (!this.disposed && this.scanQueued.has(workspace.id));
    })();
    this.scanPromises.set(workspace.id, promise);
    try {
      await promise;
    } finally {
      if (this.scanPromises.get(workspace.id) === promise) this.scanPromises.delete(workspace.id);
    }
  }

  private async scanWorkspace(workspace: WorkspaceRef): Promise<void> {
    if (this.scanInFlight.has(workspace.id)) return;
    this.scanInFlight.add(workspace.id);
    try {
      const config = await this.readConfig(workspace);
      const active = activeContext(config);
      const status = await this.ensureStatus(workspace, config);
      await this.log(workspace, 'scan_start', {
        activeContextId: active.id,
        contextName: active.name,
        paths: active.paths,
        vectorizer: this.vectorizer.info,
        storage: this.storageStatusFields(workspace),
      });
      if (active.paths.length === 0) {
        this.statuses.set(workspace.id, {
          ...status,
          contextName: active.name,
          paths: active.paths,
          state: 'pending',
          totalFiles: 0,
          processedFiles: 0,
          percent: 0,
          message: 'No markdown folders configured.',
          ...this.accelerationStatusFields(),
          ...this.storageStatusFields(workspace),
        });
        await this.log(workspace, 'scan_pending', {
          reason: 'no_markdown_folders_configured',
          contextName: active.name,
        });
        return;
      }

      const acceleration = this.accelerationStatusFields();
      const storageStatus = this.storageStatusFields(workspace);
      const contextFiles = await Promise.all(config.contexts.map(async context => ({
        context,
        files: (await Promise.all(context.paths.map(collectMarkdownFiles))).flat(),
      })));
      const allFiles = contextFiles.flatMap(item => item.files.map(file => ({ context: item.context, file })));
      await this.log(workspace, 'scan_files_collected', {
        totalFiles: allFiles.length,
        contexts: contextFiles.map(item => ({
          contextId: item.context.id,
          contextName: item.context.name,
          paths: item.context.paths,
          files: item.files.length,
        })),
      });
      const storage = this.getStorage();
      const byContextPath = new Map((await storage.listDocumentInfo(workspace)).map(doc => [`${doc.contextId ?? 'default'}:${normalizePathForId(doc.path)}`, doc]));
      const seen = new Set<string>();
      let processed = 0;
      let changedDocuments = 0;
      let changedChunks = 0;
      let pendingDocuments: IndexedDocument[] = [];
      let pendingChunks = 0;
      const flushPendingDocuments = async (reason: string, currentFile?: string): Promise<void> => {
        if (pendingDocuments.length === 0) return;
        const batchDocuments = pendingDocuments.length;
        const batchChunks = pendingChunks;
        await storage.upsertDocuments(workspace, pendingDocuments);
        pendingDocuments = [];
        pendingChunks = 0;
        await this.log(workspace, 'storage_upsert_progress', {
          reason,
          batchDocuments,
          batchChunks,
          changedDocuments,
          changedChunks,
          ...(currentFile ? { currentFile } : {}),
          storage: storage.describe(workspace),
        });
      };
      this.statuses.set(workspace.id, {
        ...status,
        contextName: active.name,
        paths: active.paths,
        state: 'indexing',
        totalFiles: allFiles.length,
        processedFiles: 0,
        percent: allFiles.length === 0 ? 100 : 0,
        message: allFiles.length === 0 ? 'No markdown files found.' : 'Indexing markdown files.',
        ...acceleration,
        ...storageStatus,
      });

      for (const { context, file } of allFiles) {
        const normalized = normalizePathForId(file);
        const contextPathKey = `${context.id}:${normalized}`;
        seen.add(contextPathKey);
        processed++;
        this.updateProgress(workspace.id, processed, allFiles.length, file);
        if (processed === 1 || processed === allFiles.length || processed % 100 === 0) {
          await this.log(workspace, 'scan_progress', {
            processedFiles: processed,
            totalFiles: allFiles.length,
            percent: allFiles.length === 0 ? 100 : Math.round((processed / allFiles.length) * 100),
            currentFile: file,
          });
        }
        let content: string;
        try { content = await readFile(file, 'utf8'); } catch (error) {
          await this.registerFileReadFailure(workspace, context, normalized, error);
          await this.log(workspace, 'file_read_error', {
            file,
            error: errorMessage(error),
          });
          continue;
        }
        const nulCharsRemoved = countNulChars(content);
        if (nulCharsRemoved > 0) {
          content = stripNulChars(content);
          await this.log(workspace, 'file_sanitized', {
            file,
            nulCharsRemoved,
            reason: 'postgres_text_columns_do_not_accept_nul',
          });
        }
        const hash = sha256(content);
        const fileStat = await stat(file).catch(() => null);
        await this.registerFileSource(workspace, context, normalized, fileStat?.mtime.toISOString() ?? nowIso(), hash, content);
        const existing = byContextPath.get(contextPathKey);
        if (existing?.hash === hash && documentMatchesVectorizer(existing, this.vectorizer.info)) continue;
        const chunks = chunkMarkdown(content);
        const vectors = await this.embedTexts(
          chunks.map(text => `${path.basename(file)}\n${extractSummary(content)}\n${text}`),
        );
        const docId = stableId(contextPathKey);
        const doc: IndexedDocument = {
          id: docId,
          contextId: context.id,
          path: normalized,
          hash,
          vectorizer: vectorizerMetadata(this.vectorizer.info),
          updatedAt: fileStat?.mtime.toISOString() ?? nowIso(),
          chunks: chunks.map((text, index) => ({
            id: `${docId}:${index}`,
            text,
            vector: compactStoredVector(vectors[index] ?? []),
          })),
        };
        pendingDocuments.push(doc);
        pendingChunks += doc.chunks.length;
        changedDocuments++;
        changedChunks += doc.chunks.length;
        if (pendingDocuments.length >= 32 || pendingChunks >= 1024) {
          await flushPendingDocuments('batch', file);
        }
      }
      await flushPendingDocuments('final');

      const configuredContextIds = new Set(config.contexts.map(context => context.id));
      await this.log(workspace, 'storage_finalize_start', {
        totalFiles: allFiles.length,
        changedDocuments,
        changedChunks,
        storage: storage.describe(workspace),
      });
      try {
        await this.recordMissingFileSources(workspace, config, byContextPath, seen);
        await storage.deleteStaleFiles(workspace, configuredContextIds, seen);
        await storage.flush(workspace);
      } catch (error) {
        throw new Error(
          'Failed to write workspace RAG index. ' +
          `storage=${storage.kind}, changedDocuments=${changedDocuments}, changedChunks=${changedChunks}. ` +
          `Original error: ${errorMessage(error)}`,
        );
      }
      const dbSummary = await storage.summary(workspace);
      const idleStatus = { ...this.statuses.get(workspace.id)! };
      delete idleStatus.currentFile;
      this.statuses.set(workspace.id, {
        ...idleStatus,
        state: 'idle',
        processedFiles: allFiles.length,
        percent: 100,
        lastIndexedAt: nowIso(),
        message: allFiles.length === 0 ? 'No markdown files found.' : `Indexed ${allFiles.length} markdown file(s).`,
        ...this.accelerationStatusFields(),
        ...this.storageStatusFields(workspace),
      });
      await this.log(workspace, 'scan_complete', {
        totalFiles: allFiles.length,
        changedDocuments,
        changedChunks,
        storage: storage.describe(workspace),
        ...dbSummary,
      });
    } catch (error) {
      const previous = this.statuses.get(workspace.id);
      await this.log(workspace, 'scan_error', {
        error: errorMessage(error),
        stack: errorStack(error),
        previousStatus: previous,
      });
      this.statuses.set(workspace.id, {
        workspaceId: workspace.id,
        contextName: previous?.contextName ?? workspace.name,
        paths: previous?.paths ?? [],
        state: 'error',
        totalFiles: previous?.totalFiles ?? 0,
        processedFiles: previous?.processedFiles ?? 0,
        percent: previous?.percent ?? 0,
        message: error instanceof Error ? error.message : String(error),
        ...this.accelerationStatusFields(),
        ...this.storageStatusFields(workspace),
      });
    } finally {
      this.scanInFlight.delete(workspace.id);
    }
  }

  private fileSourceExternalId(contextId: string, normalizedPath: string): string {
    return `${contextId}:${normalizedPath}`;
  }

  private knowledgeSourceExternalId(contextId: string, entry: KnowledgeEntry): string {
    return `${contextId}:knowledge:${entry.source.type}:${entry.source.uuid}:${entry.id}`;
  }

  private sourceId(workspace: WorkspaceRef, externalId: string): string | undefined {
    return this.sourceRegistry?.stableSourceId({
      workspaceId: workspace.id,
      connectorType: 'workspace-rag',
      externalId,
    });
  }

  private async registerFileSource(
    workspace: WorkspaceRef,
    context: RagContextConfig,
    normalizedPath: string,
    updatedAt: string,
    contentHash: string,
    content: string,
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
      permissionState: 'allowed',
      trustLevel: 'medium',
      citationPolicy: 'cite_path',
      healthState: 'healthy',
      lastObservedAt: nowIso(),
      lastSuccessfulReadAt: nowIso(),
      knownLimitations: [
        'Workspace RAG currently indexes Markdown text only.',
        'Search hits are chunk-level excerpts, not full document reads.',
      ],
    });
    const version = await this.sourceRegistry.upsertVersion({
      sourceId: source.id,
      contentHash,
      observedAt: updatedAt,
      provenance: {
        activityId: `workspace-rag:${workspace.id}:${context.id}:scan`,
      },
    });
    await this.sourceRegistry.recordHealth({
      sourceId: source.id,
      state: 'healthy',
      checkedAt: nowIso(),
      message: 'Workspace RAG read and indexed this markdown source.',
    });
    await this.extractContextGraphSource(workspace, source.id, version.id, content, 'deterministic');
  }

  private async registerKnowledgeSource(
    workspace: WorkspaceRef,
    context: RagContextConfig,
    entry: KnowledgeEntry,
    contentHash: string,
  ): Promise<void> {
    if (this.sourceRegistry === undefined) return;
    const externalId = this.knowledgeSourceExternalId(context.id, entry);
    const source = await this.sourceRegistry.upsertSource({
      workspaceId: workspace.id,
      connectorType: 'workspace-rag',
      externalId,
      uri: entry.source.uuid,
      title: entry.summary || entry.id,
      sourceKind: 'artifact',
      schemaOrDocumentType: entry.source.type,
      sensitivity: 'internal',
      permissionState: 'allowed',
      trustLevel: 'medium',
      citationPolicy: 'cite_path',
      healthState: 'healthy',
      lastObservedAt: nowIso(),
      lastSuccessfulReadAt: nowIso(),
      knownLimitations: ['Knowledge entries are indexed into workspace RAG as derived artifacts.'],
    });
    const version = await this.sourceRegistry.upsertVersion({
      sourceId: source.id,
      contentHash,
      observedAt: nowIso(),
      provenance: {
        activityId: `workspace-rag:${workspace.id}:${context.id}:knowledge-index`,
      },
    });
    await this.extractContextGraphSource(
      workspace,
      source.id,
      version.id,
      `${entry.summary}\n${entry.entities.join('\n')}\n${entry.content}`,
      'deterministic',
    );
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

  private async recordMissingFileSources(
    workspace: WorkspaceRef,
    config: RagConfig,
    byContextPath: Map<string, { contextId?: string; path: string; sourceType: 'file' | 'knowledge' }>,
    seen: Set<string>,
  ): Promise<void> {
    if (this.sourceRegistry === undefined) return;
    const configuredContextIds = new Set(config.contexts.map(context => context.id));
    for (const doc of byContextPath.values()) {
      if (doc.sourceType !== 'file') continue;
      if (!path.isAbsolute(doc.path)) continue;
      const contextId = doc.contextId ?? 'default';
      const key = `${contextId}:${normalizePathForId(doc.path)}`;
      if (configuredContextIds.has(contextId) && seen.has(key)) continue;
      const sourceId = this.sourceId(workspace, this.fileSourceExternalId(contextId, normalizePathForId(doc.path)));
      if (sourceId === undefined) continue;
      const source = await this.sourceRegistry.getSource(sourceId);
      if (source === null) continue;
      await this.sourceRegistry.recordHealth({
        sourceId,
        state: 'down',
        checkedAt: nowIso(),
        message: 'Workspace RAG source is no longer present in configured markdown paths.',
        details: { path: doc.path, contextId },
      });
    }
  }

  private async enrichSearchHits(
    workspace: WorkspaceRef,
    context: RagContextConfig,
    hits: SearchHit[],
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
    IngestionStatus,
    | 'nvidiaAvailable'
    | 'cudaAvailable'
    | 'accelerated'
    | 'accelerator'
    | 'embeddingBackend'
    | 'embeddingModel'
    | 'embeddingDimensions'
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
      ...(this.cudaServiceUrl ? { cudaServiceUrl: this.cudaServiceUrl } : {}),
      accelerationMessage: this.accelerationMessage,
    };
  }

  private storageStatusFields(workspace?: WorkspaceRef): Pick<
    IngestionStatus,
    | 'storageBackend'
    | 'storageMessage'
    | 'postgresHost'
    | 'postgresPort'
    | 'postgresDatabase'
    | 'postgresSchema'
    | 'postgresTables'
    | 'legacyJsonPath'
  > {
    return this.storage?.describe(workspace) ?? {
      storageBackend: 'json',
      storageMessage: 'Workspace RAG storage backend has not been initialized.',
    };
  }

  private getStorage(): RagStorage {
    if (!this.storage) throw new Error('Workspace RAG storage backend has not been initialized.');
    return this.storage;
  }

  private async embedTexts(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return this.vectorizer.embed(texts, signal);
  }

  private updateProgress(workspaceId: string, processed: number, total: number, currentFile: string): void {
    const previous = this.statuses.get(workspaceId);
    if (!previous) return;
    this.statuses.set(workspaceId, {
      ...previous,
      processedFiles: processed,
      totalFiles: total,
      percent: total === 0 ? 100 : Math.round((processed / total) * 100),
      currentFile,
    });
  }

  private async ensureStatus(workspace: WorkspaceRef, config?: RagConfig): Promise<IngestionStatus> {
    const cfg = config ?? await this.readConfig(workspace);
    const active = activeContext(cfg);
    const existing = this.statuses.get(workspace.id);
    if (
      existing &&
      existing.contextName === active.name &&
      JSON.stringify(existing.paths) === JSON.stringify(active.paths)
    ) return existing;
    const status: IngestionStatus = {
      workspaceId: workspace.id,
      contextName: active.name,
      paths: active.paths,
      state: active.paths.length > 0 ? 'idle' : 'pending',
      totalFiles: 0,
      processedFiles: 0,
      percent: active.paths.length > 0 ? 100 : 0,
      message: active.paths.length > 0 ? 'Waiting for next scan.' : 'No markdown folders configured.',
      ...this.accelerationStatusFields(),
      ...this.storageStatusFields(workspace),
    };
    this.statuses.set(workspace.id, status);
    return status;
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
      await mkdir(path.dirname(this.logPath(workspace)), { recursive: true });
      await appendFile(this.logPath(workspace), line, 'utf8');
    } catch (error) {
      console.warn(`[workspace-rag] failed to write ingestion log for ${workspace.id}: ${errorMessage(error)}`);
    }
  }

}

function createWorkspaceRagTool(manager: WorkspaceRagManager): Tool {
  return {
    name: 'workspace_rag',
    description:
      'Configure and inspect workspace-scoped markdown RAG. The tool indexes configured local folders ' +
      'for the current Cortex workspace, monitors markdown changes, reports ingestion progress, and can search indexed context.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'get_config', 'configure', 'select_context', 'create_context', 'search', 'reindex_now'] },
        contextId: { type: 'string', description: 'Workspace RAG context id for select_context or configure.' },
        contextName: { type: 'string', description: 'Human-facing name for this workspace RAG context.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute local folder paths containing markdown files.' },
        query: { type: 'string', description: 'Search query for action=search.' },
        limit: { type: 'number', default: 5 },
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
          if (action === 'reindex_now') {
            await manager.scanCurrent();
            yield { type: 'result', value: await manager.statusCurrent() };
            return;
          }
          if (action === 'search') {
            const query = typeof value.query === 'string' ? value.query : '';
            if (!query.trim()) { yield { type: 'error', message: 'workspace_rag search requires "query".' }; return; }
            const limit = typeof value.limit === 'number' ? value.limit : 5;
            yield { type: 'result', value: { hits: await manager.searchCurrent(query, limit, ctx.signal) } };
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

function renderContext(hits: SearchHit[]): string {
  if (hits.length === 0) return '';
  return [
    `[Workspace RAG context — ${hits[0]!.contextName}. Use this as grounded local context when relevant; cite file paths when relying on it.]`,
    ...hits.map((hit, index) => [
      `## Source ${index + 1}: ${hit.path}`,
      `Score: ${hit.score.toFixed(3)}`,
      ...(hit.sourceId !== undefined ? [`Source id: ${hit.sourceId}`] : []),
      ...(hit.sourceHealthState !== undefined ? [`Source health: ${hit.sourceHealthState}`] : []),
      ...(hit.sourceStalenessState !== undefined ? [`Source freshness: ${hit.sourceStalenessState}`] : []),
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
    const manager = new WorkspaceRagManager(services.configPath, sourceRegistry, contextGraph);
    activeManager = manager;
    await manager.start();
    await services.register('WorkspaceRagManager' as never, manager as never);
    services.tools.register(createWorkspaceRagTool(manager));
    services.hooks.register({
      on: 'screen',
      priority: -10,
      async handler(ctx) {
        const query = latestUserText(ctx.session);
        if (!query.trim()) return;
        const status = await manager.statusCurrent();
        if (status.state === 'pending') return {
          markers: [{ type: 'marker', creator: 'workspace-rag', data: { state: 'pending', message: status.message } }],
        };
        const hits = await manager.searchCurrent(query, MAX_CONTEXT_CHUNKS, ctx.signal);
        const text = renderContext(hits);
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
