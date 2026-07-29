import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import type { Pool as PgPool, PoolClient, PoolConfig } from 'pg';

const DATA_FILE = 'index.json';
const DEFAULT_POSTGRES_HOST = 'localhost';
const DEFAULT_POSTGRES_PORT = 5432;
const DEFAULT_POSTGRES_DB = 'mem0';
const DEFAULT_POSTGRES_USER = 'mem0';
const DEFAULT_POSTGRES_SCHEMA = 'workspace_rag';
const POSTGRES_UPSERT_BATCH_SIZE = 1024;
const POSTGRES_CHUNK_INSERT_BATCH_SIZE = 128;
const POSTGRES_SEARCH_LIMIT = 200;

export type RagStorageKind = 'json' | 'postgres-pgvector';
export type VectorizerBackend = 'hash-cpu' | 'cuda-http';

export interface VectorizerMetadata {
  backend: VectorizerBackend;
  model: string;
  dimensions: number;
  signature?: string;
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
  fileSize?: number;
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
  fileSize?: number;
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
  postgresHost?: string;
  postgresPort?: number;
  postgresDatabase?: string;
  postgresSchema?: string;
  postgresTables?: string[];
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
  return `${info.backend}:${info.model}:${info.dimensions}:${effectiveVectorizerSignature(info)}`;
}

export function documentMatchesVectorizer(doc: { vectorizer?: VectorizerMetadata }, info: VectorizerMetadata): boolean {
  const current = doc.vectorizer ?? {
    backend: 'hash-cpu' as const,
    model: 'token-hash-v1',
    dimensions: 384,
  };
  return vectorizerIdentity(current) === vectorizerIdentity(info);
}

function effectiveVectorizerSignature(info: VectorizerMetadata): string {
  return info.signature ?? 'legacy-v1';
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
      ...(doc.fileSize !== undefined ? { fileSize: doc.fileSize } : {}),
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

interface PostgresConfig {
  poolConfig: PoolConfig;
  host: string;
  port: number;
  database: string;
  schema: string;
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
  vectorizer_signature: string | null;
  updated_at: string;
  file_size: string | null;
  source_type: 'file' | 'knowledge';
}

interface ChunkRow {
  id: string;
  path: string;
  text: string;
  score: number;
}

class PostgresPgvectorRagStorage implements RagStorage {
  readonly kind = 'postgres-pgvector' as const;
  private readonly pool: PgPool;
  private readonly schemaName: string;
  private readonly schemaSql: string;
  private readonly documentsTableName: string;
  private readonly chunksTableName: string;
  private readonly documentsTableSql: string;
  private readonly chunksTableSql: string;
  private readonly vectorizer: VectorizerMetadata;
  private readonly config: PostgresConfig;

  private constructor(config: PostgresConfig, vectorizer: VectorizerMetadata) {
    this.config = config;
    this.vectorizer = vectorizer;
    this.pool = new Pool(config.poolConfig);
    this.schemaName = config.schema;
    this.schemaSql = quoteIdentifier(config.schema);
    this.documentsTableName = `documents_${vectorizer.dimensions}`;
    this.chunksTableName = `chunks_${vectorizer.dimensions}`;
    this.documentsTableSql = `${this.schemaSql}.${quoteIdentifier(this.documentsTableName)}`;
    this.chunksTableSql = `${this.schemaSql}.${quoteIdentifier(this.chunksTableName)}`;
  }

  static async open(vectorizer: VectorizerMetadata): Promise<PostgresPgvectorRagStorage> {
    const storage = new PostgresPgvectorRagStorage(postgresConfigFromEnv(), vectorizer);
    await storage.initialize();
    return storage;
  }

  describe(_workspace?: WorkspaceRefLike): RagStorageStatus {
    return {
      storageBackend: this.kind,
      storageMessage: 'Postgres pgvector storage active for workspace RAG metadata, chunks, and vectors.',
      postgresHost: this.config.host,
      postgresPort: this.config.port,
      postgresDatabase: this.config.database,
      postgresSchema: this.schemaName,
      postgresTables: [this.documentsTableName, this.chunksTableName],
    };
  }

  async listDocumentInfo(workspace: WorkspaceRefLike): Promise<StoredDocumentInfo[]> {
    const result = await this.pool.query<DocumentRow>(`
      SELECT id, context_id, path, hash, vectorizer_backend, vectorizer_model,
             vectorizer_dimensions, vectorizer_signature, updated_at, file_size, source_type
      FROM ${this.documentsTableSql}
      WHERE workspace_id = $1
    `, [postgresText(workspace.id)]);
    return result.rows.map(row => ({
      id: row.id,
      path: row.path,
      hash: row.hash,
      updatedAt: row.updated_at,
      ...(row.file_size !== null ? { fileSize: Number(row.file_size) } : {}),
      sourceType: row.source_type,
      ...(row.context_id !== null ? { contextId: row.context_id } : {}),
      vectorizer: {
        backend: row.vectorizer_backend,
        model: row.vectorizer_model,
        dimensions: row.vectorizer_dimensions,
        ...(row.vectorizer_signature !== null ? { signature: row.vectorizer_signature } : {}),
      },
    }));
  }

  async upsertDocuments(workspace: WorkspaceRefLike, documents: IndexedDocument[]): Promise<void> {
    if (documents.length === 0) return;
    for (let start = 0; start < documents.length; start += POSTGRES_UPSERT_BATCH_SIZE) {
      await this.upsertDocumentBatch(workspace, documents.slice(start, start + POSTGRES_UPSERT_BATCH_SIZE));
    }
  }

  async deleteStaleFiles(
    workspace: WorkspaceRefLike,
    configuredContextIds: ReadonlySet<string>,
    seenContextPathKeys: ReadonlySet<string>,
  ): Promise<void> {
    const result = await this.pool.query<Pick<DocumentRow, 'id' | 'context_id' | 'path'>>(`
      SELECT id, context_id, path
      FROM ${this.documentsTableSql}
      WHERE workspace_id = $1 AND source_type = 'file'
    `, [postgresText(workspace.id)]);
    const staleIds = result.rows
      .filter(row => {
        if (!path.isAbsolute(row.path)) return false;
        const contextId = row.context_id ?? 'default';
        if (!configuredContextIds.has(contextId)) return true;
        return !seenContextPathKeys.has(`${contextId}:${normalizePathForId(row.path)}`);
      })
      .map(row => row.id);
    if (staleIds.length === 0) return;
    await this.pool.query(`DELETE FROM ${this.documentsTableSql} WHERE workspace_id = $1 AND id = ANY($2::text[])`, [
      postgresText(workspace.id),
      staleIds.map(postgresText),
    ]);
  }

  async flush(_workspace: WorkspaceRefLike): Promise<void> {
    // Postgres commits each document batch transaction as ingestion proceeds.
  }

  async summary(workspace: WorkspaceRefLike): Promise<RagStorageSummary> {
    const documents = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.documentsTableSql} WHERE workspace_id = $1`,
      [postgresText(workspace.id)],
    );
    const chunks = await this.pool.query<{ chunks: string; textchars: string }>(`
      SELECT COUNT(*)::text AS chunks, COALESCE(SUM(LENGTH(text)), 0)::text AS textchars
      FROM ${this.chunksTableSql}
      WHERE workspace_id = $1
    `, [postgresText(workspace.id)]);
    const chunkCount = Number(chunks.rows[0]?.chunks ?? 0);
    return {
      documents: Number(documents.rows[0]?.count ?? 0),
      chunks: chunkCount,
      textChars: Number(chunks.rows[0]?.textchars ?? 0),
      vectorValues: chunkCount * this.vectorizer.dimensions,
    };
  }

  async search(
    workspace: WorkspaceRefLike,
    activeContext: RagContextLike,
    vectorizer: VectorizerMetadata,
    queryVector: readonly number[],
    limit: number,
    signal: AbortSignal,
  ): Promise<SearchHit[]> {
    if (signal.aborted || queryVector.length !== this.vectorizer.dimensions) return [];
    const wanted = clampLimit(limit);
    const searchLimit = Math.min(POSTGRES_SEARCH_LIMIT, Math.max(wanted * 25, 50));
    const result = await this.pool.query<ChunkRow>(`
      SELECT id, path, text, GREATEST(0, 1 - (embedding <=> $1::vector))::float8 AS score
      FROM ${this.chunksTableSql}
      WHERE workspace_id = $2
        AND vectorizer_backend = $3
        AND vectorizer_model = $4
        AND vectorizer_dimensions = $5
        AND vectorizer_signature = $6
        AND (
          (source_type = 'file' AND context_id = $7)
          OR source_type = 'knowledge'
        )
      ORDER BY embedding <=> $1::vector
      LIMIT $8
    `, [
      toPgVector(queryVector),
      postgresText(workspace.id),
      postgresText(vectorizer.backend),
      postgresText(vectorizer.model),
      vectorizer.dimensions,
      postgresText(effectiveVectorizerSignature(vectorizer)),
      postgresText(activeContext.id),
      searchLimit,
    ]);
    return result.rows
      .filter(row => row.score > 0)
      .slice(0, wanted)
      .map(row => ({
        workspaceId: workspace.id,
        contextName: activeContext.name,
        path: row.path,
        chunkId: row.id,
        score: row.score,
        text: row.text,
      }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async initialize(): Promise<void> {
    await this.pool.query('SELECT 1');
    await this.ensureVectorExtension();
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.documentsTableSql} (
        id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        context_id TEXT,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        vectorizer_backend TEXT NOT NULL,
        vectorizer_model TEXT NOT NULL,
        vectorizer_dimensions INTEGER NOT NULL,
        vectorizer_signature TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        file_size BIGINT,
        source_type TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      )
    `);
    await this.pool.query(`ALTER TABLE ${this.documentsTableSql} ADD COLUMN IF NOT EXISTS file_size BIGINT`);
    await this.pool.query(`ALTER TABLE ${this.documentsTableSql} ADD COLUMN IF NOT EXISTS vectorizer_signature TEXT`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.chunksTableSql} (
        id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        context_id TEXT,
        path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding vector(${this.vectorizer.dimensions}) NOT NULL,
        vectorizer_backend TEXT NOT NULL,
        vectorizer_model TEXT NOT NULL,
        vectorizer_dimensions INTEGER NOT NULL,
        vectorizer_signature TEXT NOT NULL,
        source_type TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id),
        FOREIGN KEY (workspace_id, document_id) REFERENCES ${this.documentsTableSql}(workspace_id, id) ON DELETE CASCADE
      )
    `);
    await this.pool.query(`ALTER TABLE ${this.chunksTableSql} ADD COLUMN IF NOT EXISTS vectorizer_signature TEXT`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_docs_${this.vectorizer.dimensions}_workspace_context_path`)} ON ${this.documentsTableSql} (workspace_id, context_id, path)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_docs_${this.vectorizer.dimensions}_source`)} ON ${this.documentsTableSql} (workspace_id, source_type)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_chunks_${this.vectorizer.dimensions}_document`)} ON ${this.chunksTableSql} (workspace_id, document_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_chunks_${this.vectorizer.dimensions}_filters`)} ON ${this.chunksTableSql} (workspace_id, context_id, source_type)`);
    await this.ensureVectorIndex();
  }

  private async ensureVectorExtension(): Promise<void> {
    const extension = await this.pool.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists");
    if (extension.rows[0]?.exists) return;
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  }

  private async ensureVectorIndex(): Promise<void> {
    try {
      await this.pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_chunks_${this.vectorizer.dimensions}_embedding_hnsw`)} ON ${this.chunksTableSql} USING hnsw (embedding vector_cosine_ops)`);
    } catch (error) {
      console.warn(`[workspace-rag] failed to create pgvector HNSW index; exact vector search remains available: ${errorMessage(error)}`);
    }
  }

  private async upsertDocumentBatch(workspace: WorkspaceRefLike, documents: IndexedDocument[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const documentIds = documents.map(doc => postgresText(doc.id));
      if (documentIds.length > 0) {
        await client.query(`DELETE FROM ${this.chunksTableSql} WHERE workspace_id = $1 AND document_id = ANY($2::text[])`, [
          postgresText(workspace.id),
          documentIds,
        ]);
      }
      await this.insertDocuments(client, workspace, documents);
      await this.insertChunks(client, workspace, documents);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertDocuments(client: PoolClient, workspace: WorkspaceRefLike, documents: IndexedDocument[]): Promise<void> {
    const values: unknown[] = [];
    const rows = documents.map(doc => {
      const offset = values.length;
      values.push(...documentValues(workspace, doc, this.vectorizer));
      return `(${Array.from({ length: 12 }, (_, index) => `$${offset + index + 1}`).join(', ')})`;
    });
    try {
      await client.query(`
        INSERT INTO ${this.documentsTableSql} (
          id, workspace_id, context_id, path, hash, vectorizer_backend, vectorizer_model,
          vectorizer_dimensions, vectorizer_signature, updated_at, file_size, source_type
        ) VALUES ${rows.join(', ')}
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          context_id = EXCLUDED.context_id,
          path = EXCLUDED.path,
          hash = EXCLUDED.hash,
          vectorizer_backend = EXCLUDED.vectorizer_backend,
          vectorizer_model = EXCLUDED.vectorizer_model,
          vectorizer_dimensions = EXCLUDED.vectorizer_dimensions,
          vectorizer_signature = EXCLUDED.vectorizer_signature,
          updated_at = EXCLUDED.updated_at,
          file_size = EXCLUDED.file_size,
          source_type = EXCLUDED.source_type
      `, values);
    } catch (error) {
      throw new Error(
        `Postgres pgvector document batch insert failed for workspace="${workspace.id}", documents=${documents.length}. ` +
        `Original error: ${errorMessage(error)}`,
      );
    }
  }

  private async insertChunks(client: PoolClient, workspace: WorkspaceRefLike, documents: IndexedDocument[]): Promise<void> {
    const chunks = documents.flatMap(doc => doc.chunks.map((chunk, index) => ({ doc, chunk, index })));
    for (let start = 0; start < chunks.length; start += POSTGRES_CHUNK_INSERT_BATCH_SIZE) {
      const batch = chunks.slice(start, start + POSTGRES_CHUNK_INSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const rows = batch.map(({ doc, chunk, index }) => {
        const metadata = doc.vectorizer ?? this.vectorizer;
        const offset = values.length;
        values.push(
          postgresText(chunk.id),
          postgresText(doc.id),
          postgresText(workspace.id),
          postgresNullableText(doc.contextId),
          postgresText(doc.path),
          index,
          postgresText(chunk.text),
          toPgVector(chunk.vector),
          postgresText(metadata.backend),
          postgresText(metadata.model),
          metadata.dimensions,
          postgresText(effectiveVectorizerSignature(metadata)),
          postgresText(sourceTypeForDocument(doc)),
        );
        return `(${Array.from({ length: 13 }, (_, parameter) => `$${offset + parameter + 1}`).join(', ')})`;
      });
      try {
        await client.query(`
          INSERT INTO ${this.chunksTableSql} (
            id, document_id, workspace_id, context_id, path, chunk_index, text, embedding,
            vectorizer_backend, vectorizer_model, vectorizer_dimensions, vectorizer_signature, source_type
          ) VALUES ${rows.map((row, rowIndex) => row.replace(`$${rowIndex * 13 + 8}`, `$${rowIndex * 13 + 8}::vector`)).join(', ')}
        `, values);
      } catch (error) {
        throw new Error(
          `Postgres pgvector chunk batch insert failed for workspace="${workspace.id}", ` +
          `chunks=${batch.length}, offset=${start}. Original error: ${errorMessage(error)}`,
        );
      }
    }
  }
}

export async function createRagStorage(vectorizer: VectorizerMetadata): Promise<RagStorage> {
  const mode = String(process.env['CORTEX_RAG_STORAGE'] ?? 'auto').trim().toLowerCase();
  if (mode === 'json' || mode === 'legacy-json') {
    return new JsonRagStorage('Legacy JSON workspace RAG storage forced by CORTEX_RAG_STORAGE.');
  }

  if (mode === 'qdrant' || mode === 'qdrant-sqlite') {
    console.warn('[workspace-rag] CORTEX_RAG_STORAGE=qdrant-sqlite is deprecated; using postgres-pgvector.');
  }

  try {
    return await PostgresPgvectorRagStorage.open(vectorizer);
  } catch (error) {
    if (mode === 'postgres' || mode === 'pgvector' || mode === 'postgres-pgvector') throw error;
    const message = `Postgres pgvector unavailable; using legacy JSON storage. ${errorMessage(error)}`;
    console.warn(`[workspace-rag] ${message}`);
    return new JsonRagStorage(message);
  }
}

function postgresConfigFromEnv(): PostgresConfig {
  const connectionString = process.env['CORTEX_RAG_POSTGRES_URL']?.trim();
  const host = process.env['CORTEX_RAG_POSTGRES_HOST']?.trim() || process.env['POSTGRES_HOST']?.trim() || DEFAULT_POSTGRES_HOST;
  const port = numberEnv(process.env['CORTEX_RAG_POSTGRES_PORT'] ?? process.env['POSTGRES_PORT'], DEFAULT_POSTGRES_PORT);
  const database = process.env['CORTEX_RAG_POSTGRES_DB']?.trim() || process.env['POSTGRES_DB']?.trim() || DEFAULT_POSTGRES_DB;
  const user = process.env['CORTEX_RAG_POSTGRES_USER']?.trim() || process.env['POSTGRES_USER']?.trim() || DEFAULT_POSTGRES_USER;
  const password = process.env['CORTEX_RAG_POSTGRES_PASSWORD'] ?? process.env['POSTGRES_PASSWORD'];
  const schema = sanitizeSqlIdentifier(process.env['CORTEX_RAG_POSTGRES_SCHEMA']?.trim() || DEFAULT_POSTGRES_SCHEMA);
  const poolConfig: PoolConfig = {
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
  };
  if (connectionString) {
    poolConfig.connectionString = connectionString;
    const parsed = parsePostgresUrl(connectionString);
    return {
      poolConfig,
      host: parsed.host || host,
      port: parsed.port || port,
      database: parsed.database || database,
      schema,
    };
  }
  poolConfig.host = host;
  poolConfig.port = port;
  poolConfig.database = database;
  poolConfig.user = user;
  if (password !== undefined && password !== '') poolConfig.password = password;
  return { poolConfig, host, port, database, schema };
}

function parsePostgresUrl(value: string): { host?: string; port?: number; database?: string } {
  try {
    const parsed = new URL(value);
    return {
      ...(parsed.hostname ? { host: parsed.hostname } : {}),
      ...(parsed.port ? { port: Number(parsed.port) } : {}),
      ...(parsed.pathname && parsed.pathname !== '/' ? { database: decodeURIComponent(parsed.pathname.slice(1)) } : {}),
    };
  } catch {
    return {};
  }
}

function documentValues(workspace: WorkspaceRefLike, doc: IndexedDocument, fallbackVectorizer: VectorizerMetadata): unknown[] {
  const metadata = doc.vectorizer ?? fallbackVectorizer;
  return [
    postgresText(doc.id),
    postgresText(workspace.id),
    postgresNullableText(doc.contextId),
    postgresText(doc.path),
    postgresText(doc.hash),
    postgresText(metadata.backend),
    postgresText(metadata.model),
    metadata.dimensions,
    postgresText(effectiveVectorizerSignature(metadata)),
    postgresText(doc.updatedAt),
    doc.fileSize ?? null,
    postgresText(sourceTypeForDocument(doc)),
  ];
}

function postgresText(value: string): string {
  return value.includes('\0') ? value.replace(/\0/g, '') : value;
}

function postgresNullableText(value: string | undefined | null): string | null {
  return value === undefined || value === null ? null : postgresText(value);
}

function toPgVector(vector: readonly number[]): string {
  return `[${vector.map(value => Number.isFinite(value) ? value : 0).join(',')}]`;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.floor(limit), 12));
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeSqlIdentifier(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  if (!sanitized) return DEFAULT_POSTGRES_SCHEMA;
  if (/^[0-9]/.test(sanitized)) return `_${sanitized}`;
  return sanitized;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}
