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
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CONFIG_FILE = 'cortex-rag.json';
const REGISTRY_FILE = 'cortex-workspaces.json';
const DATA_FILE = 'index.json';
const VECTOR_DIMS = 384;
const SCAN_INTERVAL_MS = 60_000;
const MAX_CHUNK_CHARS = 1800;
const MAX_CONTEXT_CHUNKS = 4;
const DEFAULT_CUDA_EMBEDDING_URL = 'http://localhost:8890';
const CPU_VECTOR_BACKEND = 'hash-cpu';
const CPU_VECTOR_MODEL = 'token-hash-v1';

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

interface VectorDbFile {
  version: 1;
  documents: IndexedDocument[];
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
}

interface SearchHit {
  workspaceId: string;
  contextName: string;
  path: string;
  chunkId: string;
  score: number;
  text: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
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

function normalizeDocumentVectorizer(doc: IndexedDocument): VectorizerMetadata {
  return doc.vectorizer ?? {
    backend: CPU_VECTOR_BACKEND,
    model: CPU_VECTOR_MODEL,
    dimensions: VECTOR_DIMS,
  };
}

function vectorizerIdentity(info: VectorizerMetadata): string {
  return `${info.backend}:${info.model}:${info.dimensions}`;
}

function documentMatchesVectorizer(doc: IndexedDocument, info: VectorizerRuntime): boolean {
  return vectorizerIdentity(normalizeDocumentVectorizer(doc)) === vectorizerIdentity(info);
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
      if (!Array.isArray(embedding)) throw new Error(`CUDA embedding ${index} is not an array.`);
      const vector = embedding.map(value => Number(value));
      if (vector.length !== this.info.dimensions) {
        throw new Error(`CUDA embedding ${index} has ${vector.length} dimensions; expected ${this.info.dimensions}.`);
      }
      if (vector.some(value => !Number.isFinite(value))) {
        throw new Error(`CUDA embedding ${index} contains a non-finite value.`);
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

function cosine(a: readonly number[], b: readonly number[]): number {
  let score = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) score += (a[i] ?? 0) * (b[i] ?? 0);
  return score;
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
      source: { type: 'workspace-rag', uuid: hit.path },
      confidence: hit.score,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
  }
}

class WorkspaceRagManager {
  private readonly statuses = new Map<string, IngestionStatus>();
  private readonly dbCache = new Map<string, VectorDbFile>();
  private readonly scanInFlight = new Set<string>();
  private readonly scanQueued = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private vectorizer: TextVectorizer = new HashCpuVectorizer();
  private nvidiaAvailable = false;
  private cudaAvailable = false;
  private cudaServiceUrl: string | undefined;
  private accelerationMessage = 'Using CPU hash vectorizer.';
  private disposed = false;
  private readonly activeConfigPath: string;

  constructor(activeConfigPath: string) {
    this.activeConfigPath = activeConfigPath;
  }

  async start(): Promise<void> {
    const launch = await createLaunchVectorizer();
    this.vectorizer = launch.vectorizer;
    this.nvidiaAvailable = launch.nvidiaAvailable;
    this.cudaAvailable = launch.cudaAvailable;
    this.cudaServiceUrl = launch.cudaServiceUrl;
    this.accelerationMessage = launch.accelerationMessage;
    await this.scanAll();
    this.timer = setInterval(() => void this.scanAll(), SCAN_INTERVAL_MS);
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
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
    this.statuses.delete(workspace.id);
    await this.requestScanWorkspace(workspace);
    return configView(next);
  }

  async statusCurrent(): Promise<IngestionStatus> {
    const workspace = await this.currentWorkspace();
    await this.ensureStatus(workspace);
    return this.statuses.get(workspace.id)!;
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
    const db = await this.readDb(workspace);
    const queryVector = (await this.embedTexts([query], signal))[0] ?? [];
    const hits: SearchHit[] = [];
    for (const doc of db.documents) {
      if (!documentMatchesVectorizer(doc, this.vectorizer.info)) continue;
      const docContextId = doc.contextId ?? 'default';
      if (!doc.id.startsWith('knowledge:') && docContextId !== active.id) continue;
      for (const chunk of doc.chunks) {
        const score = cosine(queryVector, chunk.vector);
        if (score > 0) {
          hits.push({
            workspaceId: workspace.id,
            contextName: active.name,
            path: doc.path,
            chunkId: chunk.id,
            score,
            text: chunk.text,
          });
        }
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 12)));
  }

  async indexKnowledgeEntry(workspaceId: string, entry: KnowledgeEntry): Promise<void> {
    const workspace = (await this.listWorkspaces()).find(item => item.id === workspaceId);
    if (!workspace) return;
    const config = await this.readConfig(workspace);
    const context = activeContext(config);
    const db = await this.readDb(workspace);
    const id = `knowledge:${context.id}:${entry.id}`;
    const existing = db.documents.findIndex(doc => doc.id === id);
    const chunks = chunkMarkdown(entry.content);
    const vectors = await this.embedTexts(
      chunks.map(text => `${entry.summary}\n${entry.entities.join(' ')}\n${text}`),
    );
    const document: IndexedDocument = {
      id,
      contextId: context.id,
      path: entry.source.uuid,
      hash: entry.contentHash ?? sha256(entry.content),
      vectorizer: vectorizerMetadata(this.vectorizer.info),
      updatedAt: nowIso(),
      chunks: chunks.map((text, index) => ({
        id: `${id}:${index}`,
        text,
        vector: vectors[index] ?? [],
      })),
    };
    if (existing >= 0) db.documents[existing] = document;
    else db.documents.push(document);
    await this.writeDb(workspace, db);
  }

  async scanAll(): Promise<void> {
    if (this.disposed) return;
    await Promise.all((await this.listWorkspaces()).map(workspace => this.requestScanWorkspace(workspace)));
  }

  private async requestScanWorkspace(workspace: WorkspaceRef): Promise<void> {
    if (this.scanInFlight.has(workspace.id)) {
      this.scanQueued.add(workspace.id);
      return;
    }
    do {
      this.scanQueued.delete(workspace.id);
      await this.scanWorkspace(workspace);
    } while (!this.disposed && this.scanQueued.has(workspace.id));
  }

  private async scanWorkspace(workspace: WorkspaceRef): Promise<void> {
    if (this.scanInFlight.has(workspace.id)) return;
    this.scanInFlight.add(workspace.id);
    try {
      const config = await this.readConfig(workspace);
      const active = activeContext(config);
      const status = await this.ensureStatus(workspace, config);
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
        });
        return;
      }

      const acceleration = this.accelerationStatusFields();
      const contextFiles = await Promise.all(config.contexts.map(async context => ({
        context,
        files: (await Promise.all(context.paths.map(collectMarkdownFiles))).flat(),
      })));
      const allFiles = contextFiles.flatMap(item => item.files.map(file => ({ context: item.context, file })));
      const db = await this.readDb(workspace);
      const byContextPath = new Map(db.documents.map(doc => [`${doc.contextId ?? 'default'}:${normalizePathForId(doc.path)}`, doc]));
      const seen = new Set<string>();
      let processed = 0;
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
      });

      for (const { context, file } of allFiles) {
        const normalized = normalizePathForId(file);
        const contextPathKey = `${context.id}:${normalized}`;
        seen.add(contextPathKey);
        processed++;
        this.updateProgress(workspace.id, processed, allFiles.length, file);
        let content: string;
        try { content = await readFile(file, 'utf8'); } catch { continue; }
        const hash = sha256(content);
        const existing = byContextPath.get(contextPathKey);
        if (existing?.hash === hash && documentMatchesVectorizer(existing, this.vectorizer.info)) continue;
        const fileStat = await stat(file).catch(() => null);
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
            vector: vectors[index] ?? [],
          })),
        };
        const index = db.documents.findIndex(item => item.id === doc.id);
        if (index >= 0) db.documents[index] = doc;
        else db.documents.push(doc);
      }

      const configuredContextIds = new Set(config.contexts.map(context => context.id));
      db.documents = db.documents.filter(doc => {
        if (doc.id.startsWith('knowledge:')) return true;
        if (!path.isAbsolute(doc.path)) return true;
        const docContextId = doc.contextId ?? 'default';
        if (!configuredContextIds.has(docContextId)) return false;
        return seen.has(`${docContextId}:${normalizePathForId(doc.path)}`);
      });
      await this.writeDb(workspace, db);
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
      });
    } catch (error) {
      const previous = this.statuses.get(workspace.id);
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
      });
    } finally {
      this.scanInFlight.delete(workspace.id);
    }
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

  private dbPath(workspace: WorkspaceRef): string {
    return path.join(workspace.configDir, '.data', 'workspace-rag', DATA_FILE);
  }

  private async readDb(workspace: WorkspaceRef): Promise<VectorDbFile> {
    const cached = this.dbCache.get(workspace.id);
    if (cached) return cached;
    const db = await readJson<VectorDbFile>(this.dbPath(workspace), { version: 1, documents: [] });
    this.dbCache.set(workspace.id, db);
    return db;
  }

  private async writeDb(workspace: WorkspaceRef, db: VectorDbFile): Promise<void> {
    this.dbCache.set(workspace.id, db);
    await writeJson(this.dbPath(workspace), db);
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
            await manager.scanAll();
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
      hit.text,
    ].join('\n')),
    '[End workspace RAG context.]',
  ].join('\n\n');
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

    const manager = new WorkspaceRagManager(services.configPath);
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
        return {
          ephemeral: [{ type: 'text', text }],
          markers: [{ type: 'marker', creator: 'workspace-rag', data: { hits: hits.map(hit => ({ path: hit.path, score: hit.score })) } }],
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
