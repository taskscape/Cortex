import type {} from '@matatbread/matbot-capabilities-types';
import {uiContribution} from './ui.js';
import {createSemanticServices} from './adapters/semantic.js';
import {HashCpuVectorizer,createLaunchVectorizer} from './adapters/embedding-node.js';
import type {TextVectorizer,Accelerator,VectorizerBackend,EmbeddingPurpose} from './adapters/embedding-node.js';
export {validateCudaEmbeddingHealth} from './adapters/embedding-node.js';
import {createRagRepository} from './adapters/repository-node.js';
import type {} from '@matatbread/matbot-capabilities-types';
import type { WorkspaceLifecycleParticipant, WorkspaceDeletionLease } from '@matatbread/matbot-workspace-manager-types';
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
/**
 * Shape of the workspace registry file (`cortex-workspaces.json`) read when
 * no `WorkspaceManager` service is mounted.
 */
interface WorkspaceRegistry {
  active: string;
  workspaces: Array<{ id: string; name: string; configPath: string }>;
}

/**
 * A single named RAG context: an id, a human-facing name, and the local roots
 * (folders or individual Markdown files) indexed for it.
 */
interface RagContextConfig {
  id: string;
  name: string;
  paths: string[];
}

/**
 * Persisted per-workspace RAG configuration (`cortex-rag.json`) listing all
 * contexts and which one is active. Invariants: at least one context exists
 * and `activeContextId` always refers to an entry of `contexts`.
 */
interface RagConfig {
  activeContextId: string;
  contexts: RagContextConfig[];
}

/**
 * {@link RagConfig} flattened with the active context's name and paths for
 * presentation and tool output.
 */
interface RagConfigView extends RagConfig {
  contextName: string;
  paths: string[];
}

/**
 * Partial update payload for a context edit. Omitted fields keep their
 * current values; `contextId` selects the context to edit and defaults to
 * the active one.
 */
interface RagConfigInput {
  contextId?: string;
  contextName?: string;
  paths?: string[];
}

/**
 * A workspace known to the plugin, either listed by the `WorkspaceManager`
 * service or synthesized from the active `matbot.yaml` path. `configDir` is
 * the directory containing `matbot.yaml` and therefore the workspace's
 * `cortex-rag.json` and ingestion log.
 */
interface WorkspaceRef {
  id: string;
  name: string;
  configPath: string;
  configDir: string;
  active: boolean;
}

/**
 * Deletion-readiness report for a workspace: `locked` is true while any of
 * its contexts has a reconciliation queued or running, with the blocking
 * job's state and message when available.
 */
interface WorkspaceRagLockStatus {
  locked: boolean;
  reason?: string;
  state?: RagV2Job['state'];
  message?: string;
}

/**
 * Coalescing state for one workspace/context reconciliation pipeline.
 * Triggers and changed paths accumulate until the running drain loop picks
 * them up; `promise` holds the active loop so concurrent requests await the
 * same run.
 */
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

/**
 * Extracts the Node.js filesystem error code (for example `ENOENT`) from an
 * unknown thrown value.
 *
 * @param error - Thrown value to inspect.
 * @returns The stringified `code` property, or undefined when the value is
 *   not an object carrying a code.
 * @throws Never.
 */
function filesystemErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Full status payload for the active context: the underlying `RagV2Status`
 * extended with context identity, watcher health, and embedding acceleration
 * details surfaced by the `workspace_rag` tool and the health probe.
 */
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

/**
 * Health of a registered source as tracked by the optional `SourceRegistry`
 * service: `degraded` after failed reads, `down` once the file disappears
 * from the active publication.
 */
type SourceHealthState = 'unknown' | 'healthy' | 'degraded' | 'down';
/**
 * Freshness classification for a registered source, attached to retrieved
 * evidence; `stale` and `expired` states are surfaced as retrieval warnings
 * by {@link sourceWarningsForHit}.
 */
type SourceStalenessState = 'unknown' | 'fresh' | 'stale' | 'expired';

/**
 * Minimal subset of a `SourceRegistry` source record consumed by this
 * plugin.
 */
interface SourceRegistrySourceLike {
  id: string;
  healthState: SourceHealthState;
  stalenessState: SourceStalenessState;
  title?: string;
  uri?: string;
}

/**
 * Minimal subset of a `SourceRegistry` immutable source version record.
 */
interface SourceRegistryVersionLike {
  id: string;
}

/**
 * Resolved citation for a source, as returned by the optional
 * `SourceRegistry` service and attached to search hits for presentation.
 */
interface SourceCitationLike {
  sourceId: string;
  text: string;
  policy: string;
  uri?: string;
  title?: string;
  versionId?: string;
  observedAt?: string;
}

/**
 * Structural subset of the optional `SourceRegistry` service used to track
 * workspace files as sources, record health and access audits, and resolve
 * citations. Resolved dynamically from the machine registry, so it may be
 * absent at runtime.
 */
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

/**
 * Structural subset of the optional `ContextGraph` service used to ingest
 * extracted source text as graph content.
 */
interface ContextGraphLike {
  ingestSource(input: {
    sourceId: string;
    sourceVersionId?: string;
    text?: string;
    extractionMethod?: 'deterministic' | 'connector_metadata' | 'model_extracted' | 'user_confirmed';
  }): Promise<unknown>;
}

/**
 * A single retrieved passage. V2 evidence fields (document/section ids, byte
 * and line ranges, retrieval reasons) are populated when the underlying V2
 * result carries them; the registry fields describe the source's health and
 * freshness after {@link WorkspaceRagManager.enrichSearchHits} enrichment.
 */
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

/**
 * Caveat attached to a hit whose source is degraded, down, stale, or
 * expired, rendered into retrieval context and markers.
 */
interface SourceWarning {
  path: string;
  severity: 'warning' | 'critical';
  issueType: 'stale' | 'expired' | 'degraded' | 'down';
  message: string;
  sourceId?: string;
}

/**
 * Observability correlation ids threaded into retrieval calls; every field
 * is individually optional and omitted from recorded spans when absent.
 */
interface RetrievalTraceContext {
  traceId?: string;
  rootTraceId?: string;
  sessionId?: string;
  parentSpanId?: string;
  toolCallId?: string;
}

/**
 * Conversation context used for query rewriting: the turns preceding the
 * latest user message plus the provider that should perform the rewrite.
 */
interface RetrievalConversationContext {
  turns: RagV2ConversationTurn[];
  provider?: string;
}

/**
 * Result of a detailed search: presentation-ready hits plus the raw V2
 * result (plan, answerability) when V2 produced one.
 */
interface WorkspaceSearchOutcome {
  hits: SearchHit[];
  v2Result?: RagV2SearchResult;
}

/**
 * Returns the current UTC time as an ISO-8601 timestamp.
 *
 * @returns ISO-8601 string for the current instant.
 * @throws Never.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Extracts a human-readable message from an unknown thrown value.
 *
 * @param error - Thrown value to describe.
 * @returns `error.message` for Error instances, otherwise `String(error)`.
 * @throws Never.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks whether a path is accessible to the current process.
 *
 * @param filePath - Path probed with `fs.access`.
 * @returns True when the path is accessible; false on any access error,
 *   including missing paths and permission failures.
 * @throws Never.
 */
async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

/**
 * Validates newly supplied context paths. Editing a context tolerates a mix of
 * available and unavailable roots because ingestion skips unavailable roots
 * gracefully; creating a context stays strict so typos fail fast.
 *
 * @param paths - Absolute paths to probe; an empty list always passes.
 * @param mode - `all` rejects when any path is inaccessible; `any` rejects
 *   only when every path is inaccessible.
 * @returns Resolves once every path has been probed.
 * @throws Error - When the mode rejects and at least one path is
 *   inaccessible; the first inaccessible path names the error.
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

/**
 * Hashes text with SHA-256.
 *
 * @param text - UTF-8 text to hash.
 * @returns Lowercase hexadecimal digest.
 * @throws Never.
 */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Derives a stable identifier from arbitrary text.
 *
 * @param text - Text to hash.
 * @returns First 32 hexadecimal characters of the SHA-256 digest.
 * @throws Never.
 */
function stableId(text: string): string {
  return sha256(text).slice(0, 32);
}

/**
 * Canonicalizes a path for use as an identifier.
 *
 * @param filePath - Path resolved against the current working directory.
 * @returns Absolute path with forward slashes on every platform.
 * @throws Never.
 */
function normalizePathForId(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

/**
 * Normalizes arbitrary text into a context id slug.
 *
 * @param value - Raw id or name; null and undefined fall back to `fallback`.
 * @param fallback - Value used (after trimming and lowercasing) when `value`
 *   is null or undefined.
 * @returns Lowercase slug of at most 48 characters drawn from
 *   `[a-z0-9_-]`, or `'default'` when normalization empties the value.
 * @throws Never.
 */
function normalizeContextId(value: unknown, fallback: string): string {
  const raw = String(value ?? fallback).trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return normalized || 'default';
}

/**
 * Allocates a context id that does not collide with existing ones.
 *
 * @param base - Desired id or name, normalized via
 *   {@link normalizeContextId}.
 * @param existing - Ids already taken; mutated to include the returned id.
 * @returns The normalized id, suffixed `-2`, `-3`, ... on collisions.
 * @throws Never.
 */
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

/**
 * Coerces and deduplicates configured root paths.
 *
 * @param paths - Unknown value expected to be a string array; non-arrays
 *   yield an empty result and blank entries are dropped.
 * @returns Resolved absolute paths, deduplicated case-insensitively on
 *   Windows and case-sensitively elsewhere, in first-seen order.
 * @throws Never.
 */
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

/**
 * Parses unknown JSON into a valid {@link RagConfig}, tolerating missing or
 * malformed files. Guarantees at least one context (synthesizing a default
 * one from legacy top-level fields when necessary) and falls back to the
 * first context when `activeContextId` does not resolve.
 *
 * @param value - Parsed file contents; may be null or arbitrary.
 * @param workspace - Workspace used to name a synthesized default context.
 * @returns Normalized configuration whose `activeContextId` always refers
 *   to an entry of `contexts`.
 * @throws Never.
 */
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

/**
 * Resolves a configuration's active context.
 *
 * @param config - Configuration with at least one context.
 * @returns The context matching `activeContextId`, or the first context
 *   when the id does not resolve.
 * @throws Never.
 */
function activeContext(config: RagConfig): RagContextConfig {
  return config.contexts.find(context => context.id === config.activeContextId) ?? config.contexts[0]!;
}

/**
 * Flattens a configuration with its active context for presentation.
 *
 * @param config - Configuration to project.
 * @returns Copy of the configuration extended with `contextName` and
 *   `paths` taken from the active context.
 * @throws Never.
 */
function configView(config: RagConfig): RagConfigView {
  const active = activeContext(config);
  return {
    ...config,
    contextName: active.name,
    paths: active.paths,
  };
}

/**
 * Reads and parses a JSON file, falling back on any failure.
 *
 * @typeParam T - Expected parsed shape; the result is cast, not validated.
 * @param filePath - File read as UTF-8.
 * @param fallback - Returned when the file is missing, unreadable, or not
 *   valid JSON.
 * @returns The parsed value or the fallback.
 * @throws Never.
 */
async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Atomically writes a JSON document: creates the parent directory, stages a
 * uniquely named temporary file, then renames it into place.
 *
 * @param filePath - Destination file.
 * @param value - Value serialized with two-space indentation and a trailing
 *   newline.
 * @throws Error - Propagates filesystem failures from directory creation,
 *   writing, or the final rename.
 */
async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary=filePath+'.tmp-'+randomUUID();
  try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n','utf8');await rename(temporary,filePath);}finally{await rm(temporary,{force:true});}
}

/**
 * `KnowledgeIndex` decorator layering workspace RAG search on top of an
 * upstream index. Only `search` contributes workspace content: entries are
 * delegated verbatim to the upstream index, and upstream search failures are
 * logged and treated as empty results rather than failing the merged search.
 */
class WorkspaceRagKnowledgeIndex implements KnowledgeIndex {
  private readonly manager: WorkspaceRagManager;
  private readonly workspaceId: string;
  private readonly upstream: KnowledgeIndex | undefined;

  /**
   * Creates a decorator around an optional upstream index.
   *
   * @param manager - Manager supplying workspace-scoped V2 search.
   * @param workspaceId - Workspace whose contexts are searched.
   * @param upstream - Optional upstream index that continues to receive
   *   indexed entries and contribute merged search results.
   */
  constructor(
    manager: WorkspaceRagManager,
    workspaceId: string,
    upstream?: KnowledgeIndex,
  ) {
    this.manager = manager;
    this.workspaceId = workspaceId;
    this.upstream = upstream;
  }

  /**
   * Yields entries from the upstream index only; workspace RAG content is
   * served through {@link search} rather than enumerated here.
   *
   * @returns Iterable of upstream knowledge entries.
   * @throws Error - Propagates failures thrown by the upstream iterator.
   */
  *entries(): Iterable<KnowledgeEntry> {
    const upstreamEntries = this.upstream?.entries?.();
    if (upstreamEntries) yield* upstreamEntries;
  }

  /**
   * Delegates indexing to the upstream index; workspace RAG content is
   * ingested by its own V2 pipeline and stored nowhere here.
   *
   * @param entry - Knowledge entry forwarded upstream.
   * @throws Error - Propagates upstream indexing failures.
   */
  async index(entry: KnowledgeEntry): Promise<void> {
    await this.upstream?.index(entry);
  }

  /**
   * Searches the workspace RAG index and the upstream index in parallel and
   * merges the results. Upstream search failures are logged and contribute
   * no entries; duplicates are removed by `type:uuid:id` key, keeping the
   * first occurrence.
   *
   * @param terms - Terms to search; each `context` is appended after its
   *   `term` for the workspace query while the upstream index receives the
   *   terms unchanged.
   * @param signal - Cancellation signal; an already-aborted signal yields
   *   empty workspace hits.
   * @returns Merged entries with workspace results first, in stable order.
   * @throws Error - Propagates workspace search failures.
   */
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

  /**
   * Runs a workspace RAG search and maps hits into knowledge entries with
   * stable ids, derived entities and tags, and the hit score as confidence.
   *
   * @param query - Query text assembled by {@link search}.
   * @param signal - Cancellation signal forwarded to the manager.
   * @returns One entry per hit, in hit-score order.
   * @throws Error - Propagates {@link WorkspaceRagManager.search} failures.
   */
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

/**
 * Orchestrates per-workspace RAG contexts for the V2-only pipeline. Owns the
 * persisted `cortex-rag.json` configuration, file watchers with debounced
 * reconciliation, the V2 manager lifecycle (ingestion, GC, census, search,
 * evaluation), the ingestion log, and deletion leases shared with the
 * `WorkspaceManager`. Optional peer services (`SourceRegistry`,
 * `ContextGraph`, `WorkspaceManager`) are resolved through the machine
 * registry and used opportunistically when present.
 */
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
  private readonly deletionReservations = new Set<string>();
  private releaseWorkspaceParticipant: (() => void) | undefined;
  private readonly workspaceMountAbort = new AbortController();
  private disposed = false;
  private readonly activeConfigPath: string;
  /**
   * Optional `SourceRegistry` service, resolved from the machine registry on
   * every access.
   *
   * @returns The registered service, or undefined when no plugin provides
   *   it.
   * @throws Never.
   */
  private get sourceRegistry(): SourceRegistryLike | undefined { return this.services.get('SourceRegistry' as never) as SourceRegistryLike | undefined; }
  /**
   * Optional `ContextGraph` service, resolved from the machine registry on
   * every access.
   *
   * @returns The registered service, or undefined when no plugin provides
   *   it.
   * @throws Never.
   */
  private get contextGraph(): ContextGraphLike | undefined { return this.services.get('ContextGraph' as never) as ContextGraphLike | undefined; }
  private readonly services: MatbotMachine;
  private readonly v2Mode: RagV2Mode = ragV2ModeFromEnv();
  private readonly gcSettings = ragV2GcSettingsFromEnv();
  private v2: WorkspaceRagV2Manager | undefined;
  private v2Message = 'Workspace RAG V2 is disabled.';

  /**
   * Creates an idle manager; call {@link start} before use.
   *
   * @param activeConfigPath - Absolute path to the workspace's
   *   `matbot.yaml`; used to derive the workspace id, config directory, and
   *   registry search root when no `WorkspaceManager` service is mounted.
   * @param services - Machine providing tools, hooks, contributions, and
   *   optional peer services.
   */
  constructor(
    activeConfigPath: string,
    services: MatbotMachine,
  ) {
    this.activeConfigPath = activeConfigPath;
    this.services = services;
  }

  /**
   * Reserves a workspace for deletion and returns a lease coordinating the
   * purge. The reservation rejects concurrent deletions and blocks new
   * reconciliations for the workspace until released.
   *
   * @param workspaceId - Workspace to reserve.
   * @returns Lease whose `commit` purges every context's V2 index, cancels
   *   pending reconciles, and closes the workspace's watchers, and whose
   *   `release` frees the reservation without deleting anything.
   * @throws Error - When the workspace is already reserved, its indexing is
   *   busy or queued, or the workspace is unknown; the reservation is
   *   released again before rethrowing.
   */
  async acquireWorkspaceDeletion(workspaceId: string): Promise<WorkspaceDeletionLease> {
    if (this.deletionReservations.has(workspaceId)) throw new Error('Workspace deletion already reserved');
    this.deletionReservations.add(workspaceId);
    try {
      const lock = this.workspaceLockStatus(workspaceId);
      if (lock.locked) throw new Error(lock.reason ?? 'Workspace indexing is busy');
      const workspace = (await this.listWorkspaces()).find(w => w.id === workspaceId);
      if (!workspace) throw new Error('Unknown workspace: ' + workspaceId);
      const config = await this.readConfig(workspace);
      return {
        commit: async () => {
          for (const context of config.contexts) {
            await this.v2?.purgeContext(this.v2Workspace(workspace), context);
            const key = this.reconcileKey(workspaceId, context.id);
            const timer = this.watchDebounce.get(key); if (timer) clearTimeout(timer);
            this.watchDebounce.delete(key); this.reconcileStates.delete(key);
          }
          for (let i = this.watchers.length - 1; i >= 0; i--) {
            if (this.watchers[i]!.workspaceId === workspaceId) { this.watchers[i]!.watcher.close(); this.watchers.splice(i, 1); }
          }
        },
        release: () => { this.deletionReservations.delete(workspaceId); },
      };
    } catch (error) { this.deletionReservations.delete(workspaceId); throw error; }
  }

  /**
   * Starts the manager: registers the workspace lifecycle participant
   * (rebinding on `WorkspaceManager` remounts), launches the embedding
   * vectorizer, initializes the V2 manager, refreshes watchers, schedules
   * the periodic reconcile interval (clamped to a 10 second minimum) and the
   * GC timer, and kicks off a startup reconciliation.
   *
   * @returns Resolves once startup scheduling is complete; failures of the
   *   background startup reconcile are recorded as watcher degradation
   *   instead of rejecting.
   * @throws Error - If the embedding vectorizer or the V2 repository backend
   *   cannot be created.
   */
  async start(): Promise<void> {
    const participant: WorkspaceLifecycleParticipant = {
      id: 'workspace-rag',
      readiness: id => { const lock = this.workspaceLockStatus(id); return { ...lock, canDelete: !lock.locked && !this.deletionReservations.has(id) }; },
      acquireDeletion: id => this.acquireWorkspaceDeletion(id),
    };
    const bind = () => { this.releaseWorkspaceParticipant?.(); this.releaseWorkspaceParticipant = this.services.WorkspaceManager?.registerParticipant?.(participant); };
    bind();
    this.services.mounted?.consume({ key: 'WorkspaceManager', signal: this.workspaceMountAbort.signal, onUnmount: () => { this.releaseWorkspaceParticipant?.(); this.releaseWorkspaceParticipant = undefined; } }, bind);
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

  /**
   * Stops the manager: releases the lifecycle participant, clears the
   * reconcile, GC, and debounce timers, closes all watchers, marks the
   * manager disposed, and closes the V2 manager (logging close failures).
   *
   * @returns Resolves when the V2 manager has been closed.
   * @throws Never.
   */
  async stop(): Promise<void> {
    this.workspaceMountAbort.abort();
    this.releaseWorkspaceParticipant?.();
    this.releaseWorkspaceParticipant = undefined;
    this.disposed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.gcTimer) clearTimeout(this.gcTimer);
    for (const timer of this.watchDebounce.values()) clearTimeout(timer);
    this.watchDebounce.clear();
    for (const { watcher } of this.watchers.splice(0)) watcher.close();
    this.watcherState = 'stopped';
    await this.v2?.close().catch(error => {
      console.warn(`[workspace-rag-v2] failed to close: ${errorMessage(error)}`);
    });
  }

  /**
   * Builds the map key identifying a workspace/context reconciliation state.
   *
   * @param workspaceId - Owning workspace id.
   * @param contextId - Context id within the workspace.
   * @returns Key joining both ids with a NUL separator.
   * @throws Never.
   */
  private reconcileKey(workspaceId: string, contextId: string): string {
    return `${workspaceId}\0${contextId}`;
  }

  /**
   * Returns the reconciliation state for a workspace/context pair, creating
   * and caching an empty one on first use.
   *
   * @param workspaceId - Owning workspace id.
   * @param contextId - Context id within the workspace.
   * @returns The shared mutable state for this pair.
   * @throws Never.
   */
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

  /**
   * Requests a V2 reconciliation for one context, coalescing concurrent
   * requests into a single drain loop. Recorded triggers are prioritized
   * manual > configuration > watch > retry > interval > startup, changed
   * paths accumulate across coalesced requests, and non-watch triggers
   * cancel a pending watch debounce. Loop failures are recorded on the
   * state's `lastError` rather than thrown; when the loop finishes with
   * pending work it re-requests itself as a `retry`.
   *
   * @param workspace - Workspace owning the context.
   * @param context - Context to reconcile; the latest seen wins when
   *   requests coalesce.
   * @param trigger - Reconciliation trigger to record.
   * @param wait - When true, awaits the coalesced run before returning.
   * @param changedPaths - Specific paths forced through re-ingestion,
   *   normalized before accumulation; defaults to none.
   * @param forceAll - When true, forces every discovered file through the
   *   pipeline regardless of change detection.
   * @returns The most recent V2 job for this pair, or undefined when the
   *   manager is disposed, V2 mode is off, the workspace is reserved for
   *   deletion, or nothing has run yet.
   * @throws Error - When the V2 manager is unavailable.
   */
  private async requestV2Reconcile(
    workspace: WorkspaceRef,
    context: RagContextConfig,
    trigger: RagV2Job['trigger'],
    wait: boolean,
    changedPaths: readonly string[] = [],
    forceAll = false,
  ): Promise<RagV2Job | undefined> {
    if (this.disposed || this.v2Mode === 'off' || this.deletionReservations.has(workspace.id)) return undefined;
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

  /**
   * Schedules a reconciliation for every context of every workspace, active
   * workspace first, skipping workspaces reserved for deletion or whose
   * config cannot be read. Per-context failures are recorded on the
   * corresponding reconcile state.
   *
   * @param trigger - `startup` or `interval` trigger recorded for each
   *   scheduled reconciliation.
   * @returns Resolves once every reconciliation has been requested.
   * @throws Never.
   */
  private async reconcileAll(trigger: Extract<RagV2Job['trigger'], 'startup' | 'interval'>): Promise<void> {
    if (this.disposed || this.v2Mode === 'off' || !this.v2) return;
    const scheduled: Array<Promise<unknown>> = [];
    for (const workspace of this.workspacesActiveFirst(await this.listWorkspaces())) {
      if(this.deletionReservations.has(workspace.id))continue;
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

  /**
   * Schedules the next periodic orphan-GC run with ±10% jitter on an unref'd
   * timer and reschedules itself after each run. No-op when the manager is
   * disposed, GC is disabled, or V2 is off or unavailable.
   *
   * @throws Never.
   */
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

  /**
   * Runs V2 orphan garbage collection for every context of every workspace,
   * active workspace first. Skips workspaces whose config cannot be read and
   * aborts the sweep for a workspace reserved for deletion.
   *
   * @throws Error - Propagates V2 garbage-collection failures for the
   *   current workspace.
   */
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
        if(this.deletionReservations.has(workspace.id))break;
        await this.v2.garbageCollect(this.v2Workspace(workspace), context);
      }
    }
  }

  /**
   * Debounces a watch-triggered reconciliation for a context, resetting the
   * 500 ms timer on every event. Changed Markdown paths are accumulated for
   * forced re-ingestion; other events only refresh the debounce. When the
   * timer fires, the workspace and context are re-resolved and the
   * reconciliation requested; failures are recorded on the reconcile state
   * and degrade the watcher.
   *
   * @param workspaceId - Workspace whose context changed.
   * @param contextId - Context whose roots changed.
   * @param changedPath - Normalized path of the changed file, when known.
   * @throws Never.
   */
  private scheduleWatchReconcile(workspaceId: string, contextId: string, changedPath?: string): void {
    if(this.disposed||this.deletionReservations.has(workspaceId))return;
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

  /**
   * Rebuilds all file watchers from current configurations, closing previous
   * watchers first. Single-file roots watch their parent directory and
   * filter events to the exact file; `change` events are ignored for
   * non-Markdown files while creations, deletions, and renames always
   * reconcile. Unavailable roots are skipped for well-known filesystem
   * error codes; other setup failures and runtime watcher errors degrade the
   * watcher state instead of throwing.
   *
   * @throws Error - Propagates workspace enumeration failures.
   */
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
          if (!rootStat||this.disposed||this.deletionReservations.has(workspace.id)) continue;
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

  /**
   * Resolves the ambient workspace id: the mounted `WorkspaceContext` id
   * when present, otherwise the `/workspaces/<id>/matbot.yaml` segment of
   * the active config path, otherwise `'default'`.
   *
   * @returns The current workspace id.
   * @throws Never.
   */
  currentWorkspaceId(): string {
    if(this.services.WorkspaceContext)return this.services.WorkspaceContext.id;
    const normalized = normalizePathForId(this.activeConfigPath);
    const match = /\/workspaces\/([^/]+)\/matbot\.ya?ml$/i.exec(normalized);
    return match?.[1] ?? 'default';
  }

  private configQueue:Promise<unknown>=Promise.resolve();
  /**
   * Serializes an async configuration mutation onto a per-manager queue so
   * read-modify-write cycles cannot interleave.
   *
   * @typeParam T - Operation result type.
   * @param operation - Mutation run once all prior operations settle.
   * @returns The operation's result; the queue itself never rejects.
   * @throws Error - Propagates the operation's own failure.
   */
  private async mutateConfig<T>(operation:()=>Promise<T>):Promise<T>{const next=this.configQueue.catch(()=>{}).then(operation);this.configQueue=next;return next;}
  /**
   * Builds an optimistic-concurrency snapshot of the current configuration:
   * a SHA-256 version token over the serialized view plus the editable
   * fields.
   *
   * @returns Object pairing a `version` hash with a `value` of context id,
   *   name, and paths.
   * @throws Error - Propagates configuration read failures.
   */
  async configurationSnapshot(){const value=await this.configCurrent();return {version:createHash('sha256').update(JSON.stringify(value)).digest('hex'),value:{contextId:value.activeContextId,contextName:value.contextName,paths:value.paths}};}
  /**
   * Applies a configuration update guarded by compare-and-swap on the
   * snapshot version.
   *
   * @param value - Raw configuration payload, validated and normalized by
   *   {@link configureOwned}.
   * @param expectedVersion - Version token from a previous
   *   {@link configurationSnapshot} call.
   * @returns Snapshot of the newly written configuration.
   * @throws Error - When `expectedVersion` no longer matches (reload before
   *   editing) or the update is rejected (blank or duplicate name,
   *   inaccessible paths).
   */
  async updateConfiguration(value:unknown,expectedVersion:string){return this.mutateConfig(async()=>{const current=await this.configurationSnapshot();if(current.version!==expectedVersion)throw new Error('Configuration conflict; reload before editing');await this.configureOwned(value as RagConfigInput);return this.configurationSnapshot();});}
  /**
   * Queues an edit of the active or targeted context.
   *
   * @param config - Context fields to change; omitted fields keep their
   *   current values.
   * @returns View of the updated configuration.
   * @throws Error - Propagates {@link configureOwned} failures.
   */
  async configureCurrent(config:RagConfigInput):Promise<RagConfigView>{return this.mutateConfig(()=>this.configureOwned(config));}
  /**
   * Edits a context without queueing: resolves the target context by
   * `contextId` (defaulting to the active one), validates the name (non-blank
   * and unique under accent-insensitive comparison), normalizes and
   * accessibility-checks replacement paths, writes the configuration, logs a
   * `configure` event, refreshes watchers, and schedules a
   * `configuration`-triggered reconcile when paths changed (not awaited).
   *
   * @param config - Context fields to change; `paths` undefined keeps the
   *   current paths while an explicit array replaces them.
   * @returns View of the updated configuration.
   * @throws Error - When the name is blank or already in use, a replacement
   *   path is inaccessible, or the configuration file cannot be written.
   */
  private async configureOwned(config: RagConfigInput): Promise<RagConfigView> {
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

  /**
   * Queues activation of a context by id.
   *
   * @param contextId - Context to make active.
   * @returns View of the updated configuration.
   * @throws Error - Propagates {@link selectContextOwned} failures.
   */
  async selectContextCurrent(contextId: string): Promise<RagConfigView>{return this.mutateConfig(()=>this.selectContextOwned(contextId));}
  /**
   * Activates a context without queueing and logs a `select_context` event.
   *
   * @param contextId - Context to make active.
   * @returns View of the updated configuration.
   * @throws Error - When the context id is unknown or the configuration
   *   file cannot be written.
   */
  private async selectContextOwned(contextId: string): Promise<RagConfigView> {
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

  /**
   * Queues creation of a new context, which becomes active immediately.
   *
   * @param contextName - Human-facing name; defaults to `Context <n>` when
   *   undefined.
   * @param paths - Initial roots; all must be accessible.
   * @returns View of the updated configuration with the new context active.
   * @throws Error - Propagates {@link createContextOwned} failures.
   */
  async createContextCurrent(contextName?: string, paths?: string[]): Promise<RagConfigView>{return this.mutateConfig(()=>this.createContextOwned(contextName,paths));}
  /**
   * Creates a context without queueing: validates the name (non-blank and
   * unique under accent-insensitive comparison), allocates a unique id,
   * requires every path to be accessible, persists the configuration, logs a
   * `create_context` event, refreshes watchers, and schedules a
   * `configuration`-triggered reconcile (not awaited).
   *
   * @param contextName - Human-facing name; defaults to `Context <n>` when
   *   undefined.
   * @param paths - Initial roots; all must be accessible, and an empty or
   *   undefined list is allowed.
   * @returns View of the updated configuration with the new context active.
   * @throws Error - When the name is blank or already in use, a path is
   *   inaccessible, or the configuration file cannot be written.
   */
  private async createContextOwned(contextName?: string, paths?: string[]): Promise<RagConfigView> {
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

  /**
   * Queues deletion of a context by id.
   *
   * @param contextId - Context to delete.
   * @returns View of the updated configuration.
   * @throws Error - Propagates {@link deleteContextOwned} failures.
   */
  async deleteContextCurrent(contextId: string): Promise<RagConfigView>{return this.mutateConfig(()=>this.deleteContextOwned(contextId));}
  /**
   * Deletes a context without queueing: refuses to remove the last remaining
   * context, reassigns the active context when needed, purges the context's
   * V2 index, awaits any in-flight reconciliation, logs `gc` and
   * `delete_context` events, and refreshes watchers.
   *
   * @param contextId - Context to delete.
   * @returns View of the updated configuration.
   * @throws Error - When the context id is unknown, it is the only context,
   *   the configuration cannot be written, or the V2 purge fails.
   */
  private async deleteContextOwned(contextId: string): Promise<RagConfigView> {
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

  /**
   * Builds the full status payload for the current workspace's active
   * context: V2 status extended with context identity, watcher state,
   * reconcile flags, and embedding acceleration details.
   *
   * @returns Aggregated status snapshot.
   * @throws Error - Propagates workspace enumeration or V2 status failures.
   */
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

  /**
   * Reports whether any context of a workspace has a reconciliation queued
   * or running; used for deletion readiness.
   *
   * @param workspaceId - Workspace to inspect.
   * @returns Lock report carrying the blocking job's state and message when
   *   locked, otherwise `{ locked: false }`.
   * @throws Never.
   */
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

  /**
   * Reads the current workspace's configuration.
   *
   * @returns View of the active context and all contexts.
   * @throws Error - Propagates workspace enumeration failures.
   */
  async configCurrent(): Promise<RagConfigView> {
    return configView(await this.readConfig(await this.currentWorkspace()));
  }

  /**
   * Searches the current workspace's active context and returns only the
   * hits.
   *
   * @param query - Query text; blank queries return no hits.
   * @param limit - Maximum hits to return.
   * @param signal - Cancellation signal.
   * @param trace - Optional observability correlation ids recorded with
   *   retrieval access.
   * @param conversation - Optional conversation turns used for query
   *   rewriting.
   * @returns Hits ordered by relevance; empty when aborted, V2 is
   *   unavailable, or the search fails.
   * @throws Error - Propagates workspace enumeration failures.
   */
  async searchCurrent(
    query: string,
    limit: number,
    signal: AbortSignal,
    trace?: RetrievalTraceContext,
    conversation?: RetrievalConversationContext,
  ): Promise<SearchHit[]> {
    return (await this.searchDetailed(this.currentWorkspaceId(), query, limit, signal, trace, conversation)).hits;
  }

  /**
   * Searches a specific workspace's active context and returns only the
   * hits.
   *
   * @param workspaceId - Workspace to search; unknown ids return no hits.
   * @param query - Query text; blank queries return no hits.
   * @param limit - Maximum hits to return.
   * @param signal - Cancellation signal.
   * @param trace - Optional observability correlation ids.
   * @returns Hits ordered by relevance; empty when aborted, V2 is
   *   unavailable, or the search fails.
   * @throws Error - Propagates workspace enumeration failures.
   */
  async search(workspaceId: string, query: string, limit: number, signal: AbortSignal, trace?: RetrievalTraceContext): Promise<SearchHit[]> {
    return (await this.searchDetailed(workspaceId, query, limit, signal, trace)).hits;
  }

  /**
   * Searches the current workspace, returning hits plus the raw V2 result
   * for answerability inspection.
   *
   * @param query - Query text; blank queries return no hits.
   * @param limit - Maximum hits to return.
   * @param signal - Cancellation signal.
   * @param trace - Optional observability correlation ids.
   * @param conversation - Optional conversation turns used for query
   *   rewriting.
   * @returns Hits plus the underlying V2 search result when one was
   *   produced.
   * @throws Error - Propagates workspace enumeration failures.
   */
  async searchCurrentDetailed(
    query: string,
    limit: number,
    signal: AbortSignal,
    trace?: RetrievalTraceContext,
    conversation?: RetrievalConversationContext,
  ): Promise<WorkspaceSearchOutcome> {
    return this.searchDetailed(this.currentWorkspaceId(), query, limit, signal, trace, conversation);
  }

  /**
   * Core V2-only search: resolves the workspace and its active context, runs
   * the V2 hybrid retrieval (with conversation-based query rewriting when
   * turns are supplied), maps evidence to hits, and enriches them with
   * source registry health and citations. Returns no hits when the signal is
   * already aborted, the workspace is unknown, the query is blank, or V2 is
   * disabled; search failures are logged and returned as no hits.
   *
   * @param workspaceId - Workspace to search.
   * @param query - Query text.
   * @param limit - Maximum hits to return.
   * @param signal - Cancellation signal forwarded to V2 retrieval.
   * @param trace - Optional observability correlation ids.
   * @param conversation - Optional conversation turns and rewrite provider.
   * @returns Hits ordered by relevance plus the raw V2 result.
   * @throws Error - Propagates workspace enumeration failures.
   */
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

  /**
   * Returns the V2 status for the current workspace's active context, or a
   * degraded placeholder payload when the V2 manager is unavailable.
   *
   * @returns V2 status object; shape varies with availability.
   * @throws Error - Propagates V2 status failures.
   */
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

  /**
   * Queues a manual or retry-triggered ingestion for the active context and
   * returns the resulting status without waiting for completion.
   *
   * @param trigger - `manual` (default) or `retry`.
   * @returns Current status snapshot.
   * @throws Error - When the V2 manager is unavailable.
   */
  async v2StartCurrent(trigger: Extract<RagV2Job['trigger'], 'manual' | 'retry'> = 'manual'): Promise<unknown> {
    const { workspace, context } = await this.v2Current();
    await this.requestV2Reconcile(workspace, context, trigger, false);
    return this.statusCurrent();
  }

  /**
   * Queues a manual reconciliation and waits for the coalesced run to finish
   * before returning status.
   *
   * @param forceAll - When true, re-ingests every discovered file
   *   (`reindex_now`); otherwise performs an incremental reconcile.
   * @returns Current status snapshot after reconciliation.
   * @throws Error - When the V2 manager is unavailable.
   */
  async v2ReconcileCurrent(forceAll = false): Promise<unknown> {
    const { workspace, context } = await this.v2Current();
    await this.requestV2Reconcile(workspace, context, 'manual', true, [], forceAll);
    return this.statusCurrent();
  }

  /**
   * Waits for the active context's pending reconciliation and ingestion to
   * finish.
   *
   * @returns Current status snapshot.
   * @throws Error - When the V2 manager is unavailable or ingestion
   *   monitoring fails.
   */
  async v2WaitCurrent(): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    await this.reconcileState(workspace.id, context.id).promise;
    await manager.waitForIngestion(workspace.id, context.id);
    return this.statusCurrent();
  }

  /**
   * Pauses the active context's ingestion.
   *
   * @returns Pause result as produced by the V2 manager.
   * @throws Error - When the V2 manager is unavailable or the pause fails.
   */
  async v2PauseCurrent(): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.pause(workspace.id, context.id);
  }

  /**
   * Resumes the active context's paused ingestion.
   *
   * @returns Resume result as produced by the V2 manager.
   * @throws Error - When the V2 manager is unavailable or the resume fails.
   */
  async v2ResumeCurrent(): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.resume(workspace.id, context.id);
  }

  /**
   * Cancels the active context's current or queued ingestion.
   *
   * @returns Cancellation result as produced by the V2 manager.
   * @throws Error - When the V2 manager is unavailable or cancellation
   *   fails.
   */
  async v2CancelCurrent(): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.cancel(workspace.id, context.id);
  }

  /**
   * Evicts the oldest cold passage-vector derivatives for the active
   * context.
   *
   * @param limit - Maximum derivatives to remove.
   * @returns Eviction result as produced by the V2 manager.
   * @throws Error - When the V2 manager is unavailable or eviction fails.
   */
  async v2EvictCurrent(limit: number): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.evictColdPassageEmbeddings(
      this.v2Workspace(workspace),
      context,
      limit,
    );
  }

  /**
   * Runs orphan garbage collection for the active or named context.
   *
   * @param contextId - Context to collect; defaults to the active context.
   * @returns Garbage-collection result as produced by the V2 manager.
   * @throws Error - When the V2 manager is unavailable or the context id is
   *   unknown.
   */
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

  /**
   * Censuses the active context's configured roots, measuring structure,
   * language, and duplicate forecasts; supports deep scans and resuming an
   * interrupted run.
   *
   * @param signal - Optional cancellation signal for the census stream.
   * @param options - `deep` streams every file rather than sampling;
   *   `resumeAfter` resumes after the normalized checkpoint path returned by
   *   an interrupted run.
   * @returns Census report as produced by the V2 manager.
   * @throws Error - When the V2 manager is unavailable or the census fails.
   */
  async v2CensusCurrent(
    signal?: AbortSignal,
    options: { deep?: boolean; resumeAfter?: string } = {},
  ): Promise<unknown> {
    const { context, manager } = await this.v2Current();
    return manager.census(context.paths, signal, options);
  }

  /**
   * Runs a full V2 hybrid search for the active context and, when a
   * `SourceRegistry` is mounted, annotates evidence with source health and
   * staleness (registry lookup failures leave evidence unchanged).
   *
   * @param query - Query text.
   * @param limit - Maximum evidence items to return.
   * @param signal - Cancellation signal.
   * @param filters - Optional document-type, jurisdiction, and as-of-date
   *   filters, conversation turns, rewrite provider, and iterative retrieval
   *   toggle.
   * @returns V2 search result including plan, answerability, and evidence.
   * @throws Error - Propagates V2 search failures.
   */
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

  /**
   * Fetches a byte range from an immutable document version.
   *
   * @param documentVersionId - V2 document version to read.
   * @param startByte - Inclusive byte offset into the source.
   * @param endByte - Exclusive byte offset into the source.
   * @returns Range payload as produced by the V2 manager.
   * @throws Error - When the V2 manager is unavailable or the range cannot
   *   be read.
   */
  async v2FetchRangeCurrent(documentVersionId: string, startByte: number, endByte: number): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.fetchSourceRange(
      this.v2Workspace(workspace), context, documentVersionId, startByte, endByte,
    );
  }

  /**
   * Fetches a line range from an immutable document version.
   *
   * @param documentVersionId - V2 document version to read.
   * @param startLine - Inclusive one-based line number.
   * @param endLine - Inclusive one-based line number.
   * @returns Lines payload as produced by the V2 manager.
   * @throws Error - When the V2 manager is unavailable or the lines cannot
   *   be read.
   */
  async v2FetchLinesCurrent(documentVersionId: string, startLine: number, endLine: number): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.fetchLines(
      this.v2Workspace(workspace), context, documentVersionId, startLine, endLine,
    );
  }

  /**
   * Runs a bounded regular-expression search across specific immutable
   * document versions.
   *
   * @param documentVersionIds - Authorized document versions to scan.
   * @param pattern - Regular expression to match.
   * @param limit - Maximum matches to return.
   * @returns Match list as produced by the V2 manager.
   * @throws Error - When the V2 manager is unavailable or the search fails.
   */
  async v2GrepCurrent(documentVersionIds: string[], pattern: string, limit: number): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.grepDocuments(
      this.v2Workspace(workspace), context, documentVersionIds, pattern, limit,
    );
  }

  /**
   * Runs a retrieval ablation evaluation for the active context using the
   * supplied cases and retrieval variant.
   *
   * @param cases - Evaluation cases with queries and relevance judgments.
   * @param k - Rank cutoff for Recall, Precision, nDCG, and MRR.
   * @param variant - Retrieval variant to measure.
   * @param signal - Cancellation signal.
   * @returns Evaluation metrics as produced by the V2 manager.
   * @throws Error - When the V2 manager is unavailable or the evaluation
   *   fails.
   */
  async v2EvaluateCurrent(
    cases: RagV2EvaluationCase[],
    k: number,
    variant: RagV2RetrievalVariant,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { workspace, context, manager } = await this.v2Current();
    return manager.evaluate(this.v2Workspace(workspace), context, cases, k, variant, signal);
  }

  /**
   * Orders workspaces so the active one (or the ambient current workspace)
   * comes first, preserving input order otherwise.
   *
   * @param workspaces - Workspaces to order; not mutated.
   * @returns New array with active and current workspaces first.
   * @throws Never.
   */
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

  /**
   * Builds the stable external id identifying a file within a context.
   *
   * @param contextId - Owning context id.
   * @param normalizedPath - Forward-slash normalized absolute path.
   * @returns External id of the form `<contextId>:<path>`.
   * @throws Never.
   */
  private fileSourceExternalId(contextId: string, normalizedPath: string): string {
    return `${contextId}:${normalizedPath}`;
  }

  /**
   * Resolves the registry's stable source id for a file-based external id.
   *
   * @param workspace - Workspace owning the file.
   * @param externalId - External id from {@link fileSourceExternalId}.
   * @returns Stable source id, or undefined when no `SourceRegistry` is
   *   mounted.
   * @throws Never.
   */
  private sourceId(workspace: WorkspaceRef, externalId: string): string | undefined {
    return this.sourceRegistry?.stableSourceId({
      workspaceId: workspace.id,
      connectorType: 'workspace-rag',
      externalId,
    });
  }

  /**
   * Feeds source text into the optional `ContextGraph` service. No-op when
   * the service is absent; ingestion failures are logged as
   * `context_graph_extract_error` events rather than thrown.
   *
   * @param workspace - Workspace owning the source.
   * @param sourceId - Registry source id.
   * @param sourceVersionId - Registry source version id.
   * @param text - Extracted text to ingest.
   * @param extractionMethod - Provenance of the extraction.
   * @throws Never.
   */
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

  /**
   * Records a failed read against the source registry: upserts the source as
   * degraded and stale with a partial permission state, then appends a
   * degraded health event. No-op when no `SourceRegistry` is mounted.
   *
   * @param workspace - Workspace owning the file.
   * @param context - Context under which the file is indexed.
   * @param normalizedPath - Forward-slash normalized absolute path.
   * @param error - Read failure recorded in the health message.
   * @throws Error - Propagates source-registry failures.
   */
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

  /**
   * Annotates search hits with source registry data: resolves each hit's
   * stable source, records a `retrieve` access audit event, and attaches
   * health, staleness, and citation details. Returns hits unchanged when no
   * registry is mounted or a source is unknown.
   *
   * @param workspace - Workspace the hits belong to.
   * @param context - Context the hits were retrieved from.
   * @param hits - Hits to enrich, in retrieval order.
   * @param trace - Optional correlation ids recorded with each access.
   * @returns New array of enriched hits in input order.
   * @throws Error - Propagates source-registry failures for source lookups
   *   and access recording; citation resolution failures are ignored.
   */
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

  /**
   * Projects the current vectorizer's embedding and acceleration details
   * into the status payload; optional fields are spread only when present.
   *
   * @returns Subset of {@link WorkspaceRagStatus} describing the active
   *   embedding backend.
   * @throws Never.
   */
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

  /**
   * Initializes the V2 manager: creates the storage-backed repository
   * (backend from `CORTEX_RAG_V2_STORAGE`, defaulting to `postgres`), an
   * embedder adapter over the launched vectorizer, the source registry
   * bridge, and semantic services, and wires a GC event logger into the
   * ingestion log. Initialization failures close the manager and degrade the
   * plugin to a descriptive unavailable message instead of throwing.
   *
   * @throws Error - If the requested repository backend name is unsupported.
   */
  private async startV2(): Promise<void> {
    if (this.v2Mode === 'off') return;
    const storageMode = String(process.env['CORTEX_RAG_V2_STORAGE'] ?? 'postgres').trim().toLowerCase();
    const repository = createRagRepository(storageMode);
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
      createSemanticServices(this.services),
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

  /**
   * Builds the bridge the V2 manager uses to mirror ingestion into the
   * source registry and context graph. Registration upserts source and
   * version records (restoring health for previously degraded sources),
   * removals record `down` health, and read failures record degraded
   * health.
   *
   * @returns Bridge callbacks, or undefined when no `SourceRegistry` is
   *   mounted.
   * @throws Never.
   */
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


  /**
   * Resolves the triple (workspace, active context, manager) required by the
   * `v2*` operations.
   *
   * @returns Current workspace, its active context, and the V2 manager.
   * @throws Error - When the V2 manager is unavailable or workspace
   *   enumeration fails.
   */
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

  /**
   * Projects a workspace reference onto the id, name, and config dir triple
   * the V2 manager expects.
   *
   * @param workspace - Workspace to project.
   * @returns Plain object with `id`, `name`, and `configDir`.
   * @throws Never.
   */
  private v2Workspace(workspace: WorkspaceRef): { id: string; name: string; configDir: string } {
    return { id: workspace.id, name: workspace.name, configDir: workspace.configDir };
  }

  /**
   * Maps V2 evidence items into presentation-ready search hits, including
   * positional ranges, retrieval reasons, and a path-based citation block.
   *
   * @param workspace - Workspace the evidence belongs to.
   * @param context - Context the evidence was retrieved from.
   * @param result - Raw V2 search result.
   * @returns One hit per evidence item, in evidence order.
   * @throws Never.
   */
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

  /**
   * Resolves the ambient workspace reference, synthesizing a placeholder
   * (marked active and anchored at the active config path) when the id is
   * not among the listed workspaces.
   *
   * @returns Current workspace reference.
   * @throws Error - Propagates workspace enumeration failures.
   */
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

  /**
   * Enumerates known workspaces. Prefers the mounted `WorkspaceManager`
   * service; otherwise reads the workspace registry file (resolved via
   * `CORTEX_WORKSPACES_FILE` or by walking up from the active config
   * directory), falling back to a single synthesized current workspace when
   * no registry exists or it lists nothing.
   *
   * @returns Workspace references with absolute config paths and active
   *   flags.
   * @throws Error - Propagates `WorkspaceManager` list failures.
   */
  private async listWorkspaces(): Promise<WorkspaceRef[]> {
    if (this.services.WorkspaceManager) {
      const list = await this.services.WorkspaceManager.list();
      const registryDir = path.dirname(this.services.WorkspaceContext?.registryPath ?? this.activeConfigPath);
      return list.workspaces.map(w => { const configPath = path.resolve(registryDir, w.configPath); return { id: w.id, name: w.name, configPath, configDir: path.dirname(configPath), active: w.id === this.services.WorkspaceContext?.id }; });
    }
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

  /**
   * Builds the single-workspace fallback reference anchored at the active
   * config path.
   *
   * @returns Workspace reference marked active and named after its id.
   * @throws Never.
   */
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

  /**
   * Locates the workspace registry file: honors `CORTEX_WORKSPACES_FILE`
   * when it points at an existing file, otherwise walks up from the active
   * config directory looking for `cortex-workspaces.json`.
   *
   * @returns Absolute registry path, or null when none can be found.
   * @throws Never.
   */
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

  /**
   * Resolves a workspace's RAG configuration file path.
   *
   * @param workspace - Workspace to resolve for.
   * @returns Path to `cortex-rag.json` inside the workspace config
   *   directory.
   * @throws Never.
   */
  private configPath(workspace: WorkspaceRef): string {
    return path.join(workspace.configDir, CONFIG_FILE);
  }

  /**
   * Reads and normalizes a workspace's RAG configuration; a missing or
   * malformed file yields a synthesized default configuration.
   *
   * @param workspace - Workspace to read for.
   * @returns Normalized configuration.
   * @throws Never.
   */
  private async readConfig(workspace: WorkspaceRef): Promise<RagConfig> {
    return normalizeConfig(await readJson<unknown>(this.configPath(workspace), null), workspace);
  }

  /**
   * Resolves a workspace's ingestion log path.
   *
   * @param workspace - Workspace to resolve for.
   * @returns Path to `ingestion.log` under the workspace's
   *   `.data/workspace-rag` directory.
   * @throws Never.
   */
  private logPath(workspace: WorkspaceRef): string {
    return path.join(workspace.configDir, '.data', 'workspace-rag', LOG_FILE);
  }

  /**
   * Appends a JSON line to the workspace's ingestion log, rotating the file
   * to `ingestion.log.1` once it exceeds 25 MiB (rotation is checked once
   * per workspace per process). Write failures are logged to the console
   * instead of thrown.
   *
   * @param workspace - Workspace the event belongs to.
   * @param event - Event name recorded in the entry's `event` field.
   * @param fields - Additional fields merged into the log entry.
   * @returns Resolves once the entry is appended or its failure logged.
   * @throws Never.
   */
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

/**
 * Records a completed retriever span with the `Observability` service when
 * mounted and a trace id is supplied. Sink failures are logged rather than
 * thrown.
 *
 * @param services - Machine providing the optional `Observability` service.
 * @param trace - Correlation ids for the span.
 * @param query - Query text; recorded only as a SHA-256 hash.
 * @param hits - Hits returned by retrieval, ranked as presented.
 * @param startedAt - `Date.now()` value captured before retrieval began, in
 *   milliseconds.
 * @param spanId - Fresh span id for the retriever span.
 * @returns Resolves once the span is recorded or its failure logged.
 * @throws Never.
 */
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

/**
 * Builds the `workspace_rag` tool exposing status, configuration editing,
 * context management, ingestion control, corpus census, V2 search and range
 * retrieval, grep, and evaluation actions. Executor failures are reported as
 * `error` tool events rather than thrown.
 *
 * @param manager - Manager backing every action.
 * @param services - Machine used for retrieval observability.
 * @returns The tool specification.
 * @throws Never.
 */
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

/**
 * Extracts the text of the latest user message in a session.
 *
 * @param session - Session whose messages are scanned.
 * @returns Concatenated text parts of the latest user message joined with
 *   newlines, or an empty string when there is none.
 * @throws Never.
 */
function latestUserText(session: { messages: Array<{ role: string; content: MessageContent[] }> }): string {
  const last = session.messages.findLast(message => message.role === 'user');
  if (!last) return '';
  return last.content
    .filter((part): part is Extract<MessageContent, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

/**
 * Builds the conversation history preceding the latest user message for
 * query rewriting: user and assistant turns only, robo-originated text parts
 * excluded, empty turns dropped, capped at the 8 most recent turns.
 *
 * @param session - Session to scan; undefined yields no turns.
 * @returns Up to 8 conversation turns in chronological order.
 * @throws Never.
 */
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

/**
 * Renders the ephemeral context injected when V2 retrieval abstains for lack
 * of verified evidence.
 *
 * @param result - V2 search result whose plan and answerability data are
 *   echoed into the text.
 * @returns Multi-line instruction block warning against over-claiming
 *   corpus support.
 * @throws Never.
 */
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

/**
 * Renders retrieved hits into the ephemeral per-turn context block: a header
 * with usage guidance, an optional conflicting-sources warning, one numbered
 * source section per hit (score, registry state, ranges, warnings,
 * citation, text), and a closing marker.
 *
 * @param hits - Hits to render, in retrieval order.
 * @param answerability - V2 answerability verdict; a `conflicting` status
 *   adds the conflict warning.
 * @returns Rendered context text, or an empty string when there are no
 *   hits.
 * @throws Never.
 */
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

/**
 * Derives user-facing warnings from a hit's source registry state.
 *
 * @param hit - Hit to inspect.
 * @returns Zero to two warnings: critical for `down` and `expired`
 *   sources, warning for `degraded` and `stale` ones.
 * @throws Never.
 */
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
    services.contributions?.register('webui','rag',uiContribution);
    if (services.isSubAgent()) return;
    if (!services.configPath) throw new Error('workspace-rag requires services.configPath.');

    const manager = new WorkspaceRagManager(services.configPath, services);
    activeManager = manager;
    await manager.start();
    await services.register('WorkspaceRagManager' as never, manager as never);
    services.tools.register(createWorkspaceRagTool(manager, services));
    services.contributions?.register('retrieval','workspace-rag',{title:'Workspace RAG passages',scope:'workspace',async search(query){if(query.workspaceId!==manager.currentWorkspaceId())throw new Error('RAG workspace mismatch');const hits=await manager.searchCurrent(query.query,query.limit,query.signal);return hits.map((hit,index)=>({id:hit.chunkId,sourceId:'workspace_rag',workspaceId:query.workspaceId,content:hit.text,citation:hit}));}});
    services.contributions?.register('configuration','workspace-rag',{title:'Workspace RAG context',scope:'workspace',schema:{type:'object',properties:{contextId:{type:'string'},contextName:{type:'string'},paths:{type:'array',items:{type:'string'}}}},secretPaths:[],apply:'immediate',read:()=>manager.configurationSnapshot(),async validate(value){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('RAG configuration must be an object');const row=value as Record<string,unknown>;if(Object.keys(row).some(key=>!['contextId','contextName','paths'].includes(key)))throw new Error('Unknown RAG configuration field');if(typeof row.contextId!=='string'||typeof row.contextName!=='string'||!row.contextName.trim()||!Array.isArray(row.paths)||!row.paths.every(p=>typeof p==='string'))throw new Error('Context id, name and paths are required');await assertAccessibleContextPaths(row.paths as string[],'any');},update:(value,expected)=>manager.updateConfiguration(value,expected)});
    services.contributions?.register('health','workspace-rag',{async probe(){const status=await manager.statusCurrent();return {state:status.activeGenerationId?'ready':'degraded',details:status};}});
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
    await activeManager?.stop();
    activeManager = undefined;
  },
};

export default plugin;
