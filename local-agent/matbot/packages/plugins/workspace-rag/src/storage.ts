import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_FILE = 'index.json';
const SQLITE_FILE = 'index.sqlite';
const DEFAULT_QDRANT_URL = 'http://localhost:6333';
const QDRANT_UPSERT_BATCH_SIZE = 512;
const QDRANT_SEARCH_LIMIT = 200;

export type RagStorageKind = 'json' | 'qdrant-sqlite';
export type VectorizerBackend = 'hash-cpu' | 'cuda-http';

export interface VectorizerMetadata {
  backend: VectorizerBackend;
  model: string;
  dimensions: number;
}

export interface WorkspaceRefLike {
  id: string;
  name: string;
  configPath: string;
  configDir: string;
  active: boolean;
}

export interface RagContextLike {
  id: string;
  name: string;
  paths: string[];
}

export interface VectorChunk {
  id: string;
  text: string;
  vector: number[];
}

export interface IndexedDocument {
  id: string;
  contextId?: string;
  path: string;
  hash: string;
  vectorizer?: VectorizerMetadata;
  updatedAt: string;
  chunks: VectorChunk[];
}

export interface VectorDbFile {
  version: 1;
  documents: IndexedDocument[];
}

export interface StoredDocumentInfo {
  id: string;
  contextId?: string;
  path: string;
  hash: string;
  vectorizer?: VectorizerMetadata;
  updatedAt: string;
  sourceType: 'file' | 'knowledge';
}

export interface SearchHit {
  workspaceId: string;
  contextName: string;
  path: string;
  chunkId: string;
  score: number;
  text: string;
}

export interface RagStorageSummary {
  documents: number;
  chunks: number;
  textChars: number;
  vectorValues: number;
}

export interface RagStorageStatus {
  storageBackend: RagStorageKind;
  storageMessage: string;
  qdrantUrl?: string;
  qdrantCollection?: string;
  sqlitePath?: string;
  legacyJsonPath?: string;
}

export interface RagStorage {
  readonly kind: RagStorageKind;
  describe(workspace?: WorkspaceRefLike): RagStorageStatus;
  listDocumentInfo(workspace: WorkspaceRefLike): Promise<StoredDocumentInfo[]>;
  upsertDocuments(workspace: WorkspaceRefLike, documents: IndexedDocument[]): Promise<void>;
  deleteStaleFiles(
    workspace: WorkspaceRefLike,
    configuredContextIds: ReadonlySet<string>,
    seenContextPathKeys: ReadonlySet<string>,
  ): Promise<void>;
  flush(workspace: WorkspaceRefLike): Promise<void>;
  summary(workspace: WorkspaceRefLike): Promise<RagStorageSummary>;
  search(
    workspace: WorkspaceRefLike,
    activeContext: RagContextLike,
    vectorizer: VectorizerMetadata,
    queryVector: readonly number[],
    limit: number,
    signal: AbortSignal,
  ): Promise<SearchHit[]>;
  close?(): Promise<void>;
}

export function vectorizerIdentity(info: VectorizerMetadata): string {
  return `${info.backend}:${info.model}:${info.dimensions}`;
}

export function documentMatchesVectorizer(doc: { vectorizer?: VectorizerMetadata }, info: VectorizerMetadata): boolean {
  const current = doc.vectorizer ?? {
    backend: 'hash-cpu' as const,
    model: 'token-hash-v1',
    dimensions: 384,
  };
  return vectorizerIdentity(current) === vectorizerIdentity(info);
}

export function vectorDbSummary(db: VectorDbFile): RagStorageSummary {
  let chunks = 0;
  let textChars = 0;
  let vectorValues = 0;
  for (const doc of db.documents) {
    chunks += doc.chunks.length;
    for (const chunk of doc.chunks) {
      textChars += chunk.text.length;
      vectorValues += chunk.vector.length;
    }
  }
  return {
    documents: db.documents.length,
    chunks,
    textChars,
    vectorValues,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizePathForId(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

function stableUuid(text: string): string {
  const hex = sha256(text);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeCompactJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function dataDir(workspace: WorkspaceRefLike): string {
  return path.join(workspace.configDir, '.data', 'workspace-rag');
}

function legacyJsonPath(workspace: WorkspaceRefLike): string {
  return path.join(dataDir(workspace), DATA_FILE);
}

function sqlitePath(workspace: WorkspaceRefLike): string {
  return path.join(dataDir(workspace), SQLITE_FILE);
}

function sourceTypeForDocument(doc: Pick<IndexedDocument, 'id'>): 'file' | 'knowledge' {
  return doc.id.startsWith('knowledge:') ? 'knowledge' : 'file';
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let score = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) score += (a[i] ?? 0) * (b[i] ?? 0);
  return score;
}

class JsonRagStorage implements RagStorage {
  readonly kind = 'json' as const;
  private readonly cache = new Map<string, VectorDbFile>();
  private readonly dirty = new Set<string>();
  private readonly message: string;

  constructor(message = 'Legacy JSON workspace RAG storage active.') {
    this.message = message;
  }

  describe(workspace?: WorkspaceRefLike): RagStorageStatus {
    return {
      storageBackend: this.kind,
      storageMessage: this.message,
      ...(workspace ? { legacyJsonPath: legacyJsonPath(workspace) } : {}),
    };
  }

  async listDocumentInfo(workspace: WorkspaceRefLike): Promise<StoredDocumentInfo[]> {
    const db = await this.readDb(workspace);
    return db.documents.map(doc => ({
      id: doc.id,
      path: doc.path,
      hash: doc.hash,
      updatedAt: doc.updatedAt,
      sourceType: sourceTypeForDocument(doc),
      ...(doc.contextId ? { contextId: doc.contextId } : {}),
      ...(doc.vectorizer ? { vectorizer: doc.vectorizer } : {}),
    }));
  }

  async upsertDocuments(workspace: WorkspaceRefLike, documents: IndexedDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const db = await this.readDb(workspace);
    for (const doc of documents) {
      const index = db.documents.findIndex(item => item.id === doc.id);
      if (index >= 0) db.documents[index] = doc;
      else db.documents.push(doc);
    }
    this.dirty.add(workspace.id);
  }

  async deleteStaleFiles(
    workspace: WorkspaceRefLike,
    configuredContextIds: ReadonlySet<string>,
    seenContextPathKeys: ReadonlySet<string>,
  ): Promise<void> {
    const db = await this.readDb(workspace);
    const before = db.documents.length;
    db.documents = db.documents.filter(doc => {
      if (sourceTypeForDocument(doc) === 'knowledge') return true;
      if (!path.isAbsolute(doc.path)) return true;
      const docContextId = doc.contextId ?? 'default';
      if (!configuredContextIds.has(docContextId)) return false;
      return seenContextPathKeys.has(`${docContextId}:${normalizePathForId(doc.path)}`);
    });
    if (db.documents.length !== before) this.dirty.add(workspace.id);
  }

  async flush(workspace: WorkspaceRefLike): Promise<void> {
    if (!this.dirty.has(workspace.id)) return;
    const db = await this.readDb(workspace);
    await writeCompactJson(legacyJsonPath(workspace), db);
    this.dirty.delete(workspace.id);
  }

  async summary(workspace: WorkspaceRefLike): Promise<RagStorageSummary> {
    return vectorDbSummary(await this.readDb(workspace));
  }

  async search(
    workspace: WorkspaceRefLike,
    activeContext: RagContextLike,
    vectorizer: VectorizerMetadata,
    queryVector: readonly number[],
    limit: number,
    signal: AbortSignal,
  ): Promise<SearchHit[]> {
    if (signal.aborted) return [];
    const db = await this.readDb(workspace);
    const hits: SearchHit[] = [];
    for (const doc of db.documents) {
      if (!documentMatchesVectorizer(doc, vectorizer)) continue;
      const docContextId = doc.contextId ?? 'default';
      if (sourceTypeForDocument(doc) !== 'knowledge' && docContextId !== activeContext.id) continue;
      for (const chunk of doc.chunks) {
        const score = cosine(queryVector, chunk.vector);
        if (score > 0) {
          hits.push({
            workspaceId: workspace.id,
            contextName: activeContext.name,
            path: doc.path,
            chunkId: chunk.id,
            score,
            text: chunk.text,
          });
        }
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, clampLimit(limit));
  }

  private async readDb(workspace: WorkspaceRefLike): Promise<VectorDbFile> {
    const cached = this.cache.get(workspace.id);
    if (cached) return cached;
    const db = await readJson<VectorDbFile>(legacyJsonPath(workspace), { version: 1, documents: [] });
    this.cache.set(workspace.id, db);
    return db;
  }
}

interface DocumentRow {
  id: string;
  workspace_id: string;
  context_id: string | null;
  path: string;
  hash: string;
  vectorizer_backend: VectorizerBackend;
  vectorizer_model: string;
  vectorizer_dimensions: number;
  updated_at: string;
  source_type: 'file' | 'knowledge';
}

interface ChunkRow {
  id: string;
  point_id: string;
  document_id: string;
  workspace_id: string;
  context_id: string | null;
  path: string;
  chunk_index: number;
  text: string;
  source_type: 'file' | 'knowledge';
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, string | number>;
}

interface QdrantSearchResult {
  id: string | number;
  score?: number;
}

class QdrantSQLiteRagStorage implements RagStorage {
  readonly kind = 'qdrant-sqlite' as const;
  private readonly dbs = new Map<string, DatabaseSync>();
  private readonly baseUrl: string;
  private readonly collection: string;
  private readonly vectorizer: VectorizerMetadata;

  private constructor(baseUrl: string, collection: string, vectorizer: VectorizerMetadata) {
    this.baseUrl = baseUrl;
    this.collection = collection;
    this.vectorizer = vectorizer;
  }

  static async open(baseUrl: string, vectorizer: VectorizerMetadata, collection?: string): Promise<QdrantSQLiteRagStorage> {
    const storage = new QdrantSQLiteRagStorage(
      normalizeBaseUrl(baseUrl),
      sanitizeCollectionName(collection ?? defaultCollectionName(vectorizer)),
      vectorizer,
    );
    await storage.ensureCollection();
    return storage;
  }

  describe(workspace?: WorkspaceRefLike): RagStorageStatus {
    return {
      storageBackend: this.kind,
      storageMessage: 'Qdrant vectors with SQLite metadata/chunk storage active.',
      qdrantUrl: this.baseUrl,
      qdrantCollection: this.collection,
      ...(workspace ? { sqlitePath: sqlitePath(workspace) } : {}),
    };
  }

  async listDocumentInfo(workspace: WorkspaceRefLike): Promise<StoredDocumentInfo[]> {
    const db = this.db(workspace);
    const rows = db.prepare(`
      SELECT id, context_id, path, hash, vectorizer_backend, vectorizer_model,
             vectorizer_dimensions, updated_at, source_type
      FROM documents
    `).all() as unknown as DocumentRow[];
    return rows.map(row => ({
      id: row.id,
      path: row.path,
      hash: row.hash,
      updatedAt: row.updated_at,
      sourceType: row.source_type,
      ...(row.context_id !== null ? { contextId: row.context_id } : {}),
      vectorizer: {
        backend: row.vectorizer_backend,
        model: row.vectorizer_model,
        dimensions: row.vectorizer_dimensions,
      },
    }));
  }

  async upsertDocuments(workspace: WorkspaceRefLike, documents: IndexedDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const db = this.db(workspace);
    const records: Array<{ doc: IndexedDocument; pointIds: string[] }> = [];
    const points: QdrantPoint[] = [];
    for (const doc of documents) {
      const existingPointIds = this.pointIdsForDocument(db, doc.id);
      if (existingPointIds.length > 0) await this.deletePoints(existingPointIds);

      const docPoints = doc.chunks.map((chunk, index): QdrantPoint => {
        const sourceType = sourceTypeForDocument(doc);
        const pointId = stableUuid(`${workspace.id}:${chunk.id}`);
        return {
          id: pointId,
          vector: chunk.vector,
          payload: {
            workspace_id: workspace.id,
            context_id: doc.contextId ?? 'default',
            document_id: doc.id,
            chunk_id: chunk.id,
            path: doc.path,
            chunk_index: index,
            source_type: sourceType,
            vectorizer: vectorizerIdentity(doc.vectorizer ?? this.vectorizer),
          },
        };
      });
      points.push(...docPoints);
      records.push({ doc, pointIds: docPoints.map(point => point.id) });
    }

    await this.upsertPoints(points);
    for (const record of records) {
      this.replaceDocument(db, workspace, record.doc, record.pointIds);
    }
  }

  async deleteStaleFiles(
    workspace: WorkspaceRefLike,
    configuredContextIds: ReadonlySet<string>,
    seenContextPathKeys: ReadonlySet<string>,
  ): Promise<void> {
    const db = this.db(workspace);
    const rows = db.prepare(`
      SELECT id, context_id, path, source_type
      FROM documents
      WHERE workspace_id = ? AND source_type = 'file'
    `).all(workspace.id) as unknown as Array<Pick<DocumentRow, 'id' | 'context_id' | 'path' | 'source_type'>>;
    const staleIds = rows
      .filter(row => {
        if (!path.isAbsolute(row.path)) return false;
        const contextId = row.context_id ?? 'default';
        if (!configuredContextIds.has(contextId)) return true;
        return !seenContextPathKeys.has(`${contextId}:${normalizePathForId(row.path)}`);
      })
      .map(row => row.id);
    if (staleIds.length === 0) return;

    const pointIds = staleIds.flatMap(id => this.pointIdsForDocument(db, id));
    await this.deletePoints(pointIds);
    db.exec('BEGIN IMMEDIATE');
    try {
      const deleteChunks = db.prepare('DELETE FROM chunks WHERE document_id = ?');
      const deleteDoc = db.prepare('DELETE FROM documents WHERE id = ?');
      for (const id of staleIds) {
        deleteChunks.run(id);
        deleteDoc.run(id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async flush(_workspace: WorkspaceRefLike): Promise<void> {
    // Qdrant and SQLite are updated incrementally per document.
  }

  async summary(workspace: WorkspaceRefLike): Promise<RagStorageSummary> {
    const db = this.db(workspace);
    const documents = db.prepare('SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?')
      .get(workspace.id) as unknown as { count: number };
    const chunkSummary = db.prepare(`
      SELECT COUNT(*) AS chunks, COALESCE(SUM(LENGTH(text)), 0) AS textChars
      FROM chunks
      WHERE workspace_id = ?
    `).get(workspace.id) as unknown as { chunks: number; textChars: number };
    return {
      documents: documents.count,
      chunks: chunkSummary.chunks,
      textChars: chunkSummary.textChars,
      vectorValues: chunkSummary.chunks * this.vectorizer.dimensions,
    };
  }

  async search(
    workspace: WorkspaceRefLike,
    activeContext: RagContextLike,
    _vectorizer: VectorizerMetadata,
    queryVector: readonly number[],
    limit: number,
    signal: AbortSignal,
  ): Promise<SearchHit[]> {
    if (signal.aborted || queryVector.length !== this.vectorizer.dimensions) return [];
    const wanted = clampLimit(limit);
    const searchLimit = Math.min(QDRANT_SEARCH_LIMIT, Math.max(wanted * 25, 50));
    const [fileResults, knowledgeResults] = await Promise.all([
      this.searchPoints(queryVector, searchLimit, [
        matchCondition('workspace_id', workspace.id),
        matchCondition('context_id', activeContext.id),
        matchCondition('source_type', 'file'),
      ], signal),
      this.searchPoints(queryVector, searchLimit, [
        matchCondition('workspace_id', workspace.id),
        matchCondition('source_type', 'knowledge'),
      ], signal),
    ]);
    const scores = new Map<string, number>();
    for (const result of [...fileResults, ...knowledgeResults]) {
      const pointId = String(result.id);
      const score = typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : 0;
      if (score <= 0) continue;
      const existing = scores.get(pointId);
      if (existing === undefined || score > existing) scores.set(pointId, score);
    }
    const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const chunks = this.chunksByPointId(this.db(workspace), ordered.map(([pointId]) => pointId));
    const hits: SearchHit[] = [];
    for (const [pointId, score] of ordered) {
      const chunk = chunks.get(pointId);
      if (!chunk) continue;
      hits.push({
        workspaceId: workspace.id,
        contextName: activeContext.name,
        path: chunk.path,
        chunkId: chunk.id,
        score,
        text: chunk.text,
      });
      if (hits.length >= wanted) break;
    }
    return hits;
  }

  async close(): Promise<void> {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }

  private db(workspace: WorkspaceRefLike): DatabaseSync {
    const existing = this.dbs.get(workspace.id);
    if (existing) return existing;
    const filePath = sqlitePath(workspace);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        context_id TEXT,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        vectorizer_backend TEXT NOT NULL,
        vectorizer_model TEXT NOT NULL,
        vectorizer_dimensions INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        source_type TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY NOT NULL,
        point_id TEXT UNIQUE NOT NULL,
        document_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        context_id TEXT,
        path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        source_type TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_rag_documents_context_path
        ON documents (workspace_id, context_id, path);
      CREATE INDEX IF NOT EXISTS idx_workspace_rag_documents_source
        ON documents (workspace_id, source_type);
      CREATE INDEX IF NOT EXISTS idx_workspace_rag_chunks_document
        ON chunks (document_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_rag_chunks_point
        ON chunks (point_id);
    `);
    this.dbs.set(workspace.id, db);
    return db;
  }

  private pointIdsForDocument(db: DatabaseSync, documentId: string): string[] {
    const rows = db.prepare('SELECT point_id FROM chunks WHERE document_id = ?').all(documentId) as unknown as Array<{ point_id: string }>;
    return rows.map(row => row.point_id);
  }

  private replaceDocument(db: DatabaseSync, workspace: WorkspaceRefLike, doc: IndexedDocument, pointIds: string[]): void {
    const metadata = doc.vectorizer ?? this.vectorizer;
    const sourceType = sourceTypeForDocument(doc);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM chunks WHERE document_id = ?').run(doc.id);
      db.prepare(`
        INSERT OR REPLACE INTO documents (
          id, workspace_id, context_id, path, hash, vectorizer_backend, vectorizer_model,
          vectorizer_dimensions, updated_at, source_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        doc.id,
        workspace.id,
        doc.contextId ?? null,
        doc.path,
        doc.hash,
        metadata.backend,
        metadata.model,
        metadata.dimensions,
        doc.updatedAt,
        sourceType,
      );
      const insertChunk = db.prepare(`
        INSERT OR REPLACE INTO chunks (
          id, point_id, document_id, workspace_id, context_id, path, chunk_index, text, source_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      doc.chunks.forEach((chunk, index) => {
        insertChunk.run(
          chunk.id,
          pointIds[index] ?? stableUuid(`${workspace.id}:${chunk.id}`),
          doc.id,
          workspace.id,
          doc.contextId ?? null,
          doc.path,
          index,
          chunk.text,
          sourceType,
        );
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private chunksByPointId(db: DatabaseSync, pointIds: string[]): Map<string, ChunkRow> {
    if (pointIds.length === 0) return new Map();
    const placeholders = pointIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT id, point_id, document_id, workspace_id, context_id, path, chunk_index, text, source_type
      FROM chunks
      WHERE point_id IN (${placeholders})
    `).all(...pointIds) as unknown as ChunkRow[];
    return new Map(rows.map(row => [row.point_id, row]));
  }

  private async ensureCollection(): Promise<void> {
    const collectionPath = `/collections/${encodeURIComponent(this.collection)}`;
    try {
      const current = await this.request<{ result?: { config?: { params?: { vectors?: { size?: number } } } } }>('GET', collectionPath);
      const size = current.result?.config?.params?.vectors?.size;
      if (typeof size === 'number' && size !== this.vectorizer.dimensions) {
        throw new Error(
          `Qdrant collection ${this.collection} has vector size ${size}; expected ${this.vectorizer.dimensions}. ` +
          'Set CORTEX_RAG_QDRANT_COLLECTION to a different collection or recreate the existing one.',
        );
      }
      return;
    } catch (error) {
      if (!errorMessage(error).includes('HTTP 404')) throw error;
    }
    await this.request('PUT', collectionPath, {
      vectors: {
        size: this.vectorizer.dimensions,
        distance: 'Cosine',
      },
    });
  }

  private async upsertPoints(points: QdrantPoint[]): Promise<void> {
    for (let start = 0; start < points.length; start += QDRANT_UPSERT_BATCH_SIZE) {
      const batch = points.slice(start, start + QDRANT_UPSERT_BATCH_SIZE);
      await this.request('PUT', `/collections/${encodeURIComponent(this.collection)}/points?wait=true`, { points: batch });
    }
  }

  private async deletePoints(pointIds: string[]): Promise<void> {
    for (let start = 0; start < pointIds.length; start += QDRANT_UPSERT_BATCH_SIZE) {
      const batch = pointIds.slice(start, start + QDRANT_UPSERT_BATCH_SIZE);
      if (batch.length > 0) {
        await this.request('POST', `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`, { points: batch });
      }
    }
  }

  private async searchPoints(
    vector: readonly number[],
    limit: number,
    must: unknown[],
    signal: AbortSignal,
  ): Promise<QdrantSearchResult[]> {
    const response = await this.request<{ result?: QdrantSearchResult[] }>(
      'POST',
      `/collections/${encodeURIComponent(this.collection)}/points/search`,
      {
        vector,
        limit,
        filter: { must },
        with_payload: false,
        with_vector: false,
      },
      signal,
    );
    return Array.isArray(response.result) ? response.result : [];
  }

  private async request<T = unknown>(method: string, apiPath: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const request: RequestInit = { method };
    if (body !== undefined) {
      request.headers = { 'Content-Type': 'application/json' };
      request.body = JSON.stringify(body);
    }
    if (signal) request.signal = signal;
    const response = await fetch(`${this.baseUrl}${apiPath}`, request);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Qdrant ${method} ${apiPath} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export async function createRagStorage(vectorizer: VectorizerMetadata): Promise<RagStorage> {
  const mode = String(process.env['CORTEX_RAG_STORAGE'] ?? 'auto').trim().toLowerCase();
  if (mode === 'json' || mode === 'legacy-json') {
    return new JsonRagStorage('Legacy JSON workspace RAG storage forced by CORTEX_RAG_STORAGE.');
  }

  const qdrantUrl = normalizeBaseUrl(process.env['CORTEX_RAG_QDRANT_URL'] ?? DEFAULT_QDRANT_URL);
  const collection = process.env['CORTEX_RAG_QDRANT_COLLECTION'];
  try {
    return await QdrantSQLiteRagStorage.open(qdrantUrl, vectorizer, collection);
  } catch (error) {
    if (mode === 'qdrant' || mode === 'qdrant-sqlite') throw error;
    const message = `Qdrant unavailable at ${qdrantUrl}; using legacy JSON storage. ${errorMessage(error)}`;
    console.warn(`[workspace-rag] ${message}`);
    return new JsonRagStorage(message);
  }
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.floor(limit), 12));
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '') || DEFAULT_QDRANT_URL;
}

function sanitizeCollectionName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 255);
  return sanitized || 'cortex_workspace_rag';
}

function defaultCollectionName(vectorizer: VectorizerMetadata): string {
  const hash = sha256(vectorizerIdentity(vectorizer)).slice(0, 12);
  return `cortex_workspace_rag_${vectorizer.dimensions}_${hash}`;
}

function matchCondition(key: string, value: string): unknown {
  return { key, match: { value } };
}
