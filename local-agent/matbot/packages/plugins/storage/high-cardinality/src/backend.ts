import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dirent } from 'node:fs';
import type { FileStore, StorageBackend, Store } from '@matatbread/matbot-plugin-api';
import { FilesystemFileStore } from '@matatbread/matbot-files-node';
import { FilesystemStore } from '@matatbread/matbot-storage-filesystem';
import { SQLiteStore } from '@matatbread/matbot-storage-sqlite';

const DATABASE_FILE = 'high-cardinality.db';
const MIGRATION_BATCH_SIZE = 512;
const PROJECTION_NAMESPACE = 'context_graph_projection_ops';
const PROJECTION_MIGRATION_VERSION = 'stable-target-v2';

/**
 * Namespaces backed by SQLite rather than the filesystem default.
 */
export const HIGH_CARDINALITY_NAMESPACES = new Set([
  'sources',
  'source_versions',
  'source_health_events',
  'source_access_events',
  'source_health_reports',
  'context_graph_entities',
  'context_graph_relationship_assertions',
  'context_graph_extraction_runs',
  'context_graph_projection_ops',
]);

/**
 * Minimal shape every persisted document must have; extra fields pass through
 * untouched.
 */
interface StoredDocument {
  id: string;
  version: string;
  [key: string]: unknown;
}

/**
 * Structural guard for values read from legacy JSON files.
 * @param value - Parsed JSON value.
 * @returns True when `value` is an object with string `id` and `version`.
 * @throws Never.
 */
function isStoredDocument(value: unknown): value is StoredDocument {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['version'] === 'string';
}

/**
 * Splits a read-only sequence into fixed-size batches.
 * @typeParam T - Element type.
 * @param values - Elements to batch, in order.
 * @param size - Batch size in elements (must be positive).
 * @returns The batches in order; the last may be short.
 * @throws Never.
 */
function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

/**
 * Derives a deterministic projection id from a projection-op document's
 * `workspaceId`, `operationType` and `parameters.id`, so re-running an
 * operation maps to the same id.
 * @param document - Candidate projection-op document.
 * @returns The stable id (`context-neo4j-projection:<32 hex chars>`), or
 *   undefined when the document lacks the required fields.
 * @throws Never.
 */
function stableProjectionId(document: StoredDocument): string | undefined {
  if (
    typeof document['workspaceId'] !== 'string'
    || typeof document['operationType'] !== 'string'
    || document['parameters'] === null
    || typeof document['parameters'] !== 'object'
    || typeof (document['parameters'] as Record<string, unknown>)['id'] !== 'string'
  ) return undefined;
  const targetId = (document['parameters'] as Record<string, unknown>)['id'] as string;
  const parts = [document['workspaceId'], document['operationType'], targetId];
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `context-neo4j-projection:${hash}`;
}

/**
 * A {@link StorageBackend} routing high-cardinality namespaces (see
 * {@link HIGH_CARDINALITY_NAMESPACES}) to tables in a shared WAL-mode SQLite
 * database under `<dotData>`, while every other namespace keeps the filesystem
 * JSON-store layout and files stay under `<dotData>/files`. On open it imports
 * each high-cardinality namespace's legacy per-id JSON files into SQLite, once.
 */
export class HighCardinalityStorageBackend implements StorageBackend {
  /** FileStore rooted at `<dotData>/files`. */
  readonly fileStore: FileStore;
  private readonly db: DatabaseSync;
  private readonly dotData: string;
  private readonly sqliteStores = new Map<string, SQLiteStore<StoredDocument>>();

  /**
   * Creates the backend over an already-opened database.
   * @param dotData - Root data directory.
   * @param db - SQLite connection shared by all high-cardinality stores.
   * @throws Never.
   */
  private constructor(dotData: string, db: DatabaseSync) {
    this.dotData = dotData;
    this.db = db;
    this.fileStore = new FilesystemFileStore(join(dotData, 'files'));
  }

  /**
   * Opens (creating if needed) the SQLite database under `<dotData>` and runs
   * legacy-JSON migration for every high-cardinality namespace.
   * @param dotData - Root data directory.
   * @returns The initialised backend.
   * @throws Propagates filesystem errors from creating the data directory and
   *   SQLite errors from opening the database or running migrations.
   */
  static async open(dotData: string): Promise<HighCardinalityStorageBackend> {
    await mkdir(dotData, { recursive: true });
    const db = new DatabaseSync(join(dotData, DATABASE_FILE));
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS "_high_cardinality_migrations" (
        namespace TEXT PRIMARY KEY NOT NULL,
        completed_at TEXT NOT NULL,
        imported_count INTEGER NOT NULL
      )
    `);
    const backend = new HighCardinalityStorageBackend(dotData, db);
    for (const namespace of HIGH_CARDINALITY_NAMESPACES) {
      await backend.migrateLegacyNamespace(namespace);
    }
    return backend;
  }

  /**
   * Returns the shared SQLite store for high-cardinality namespaces, or a
   * fresh FilesystemStore otherwise. SQLite stores are cached per namespace.
   * @param namespace - Store namespace.
   * @returns A store persisting documents of type `T`.
   * @template T - Stored document shape ({ id, version } at minimum).
   * @throws Propagates SQLite errors if table creation for a high-cardinality
   *   namespace fails.
   */
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    if (!HIGH_CARDINALITY_NAMESPACES.has(namespace)) {
      return new FilesystemStore<T>(join(this.dotData, namespace));
    }
    let store = this.sqliteStores.get(namespace);
    if (store === undefined) {
      store = new SQLiteStore<StoredDocument>(this.db, namespace);
      this.sqliteStores.set(namespace, store);
    }
    return store as SQLiteStore<T>;
  }

  /**
   * Closes the underlying SQLite database.
   * @returns Resolves once the database is closed.
   * @throws If SQLite reports an error while closing.
   */
  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * One-time import of a namespace's legacy per-id JSON files into SQLite,
   * guarded by a row in the `_high_cardinality_migrations` table. Readable
   * `{ id, version }` documents are imported idempotently (`importMissing`, or
   * stable-id normalisation plus cleanup of superseded ids for the projection
   * namespace); malformed files are skipped and legacy files are retained.
   * Progress and totals go to `console.warn`.
   * @param namespace - Namespace to migrate.
   * @returns Resolves once the migration marker row is written.
   * @throws Propagates non-ENOENT directory-read errors and SQLite errors from
   *   the import.
   */
  private async migrateLegacyNamespace(namespace: string): Promise<void> {
    const migrationKey = namespace === PROJECTION_NAMESPACE
      ? `${namespace}:${PROJECTION_MIGRATION_VERSION}`
      : namespace;
    const completed = this.db.prepare(
      'SELECT 1 FROM "_high_cardinality_migrations" WHERE namespace = ?',
    ).get(migrationKey);
    if (completed !== undefined) return;

    const legacyDir = join(this.dotData, namespace);
    let entries: Dirent[];
    try {
      entries = await readdir(legacyDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entries = [];
    }

    const files = entries
      .filter(entry => entry.isFile() && /^[\w%-]+\.json$/.test(entry.name))
      .map(entry => entry.name);
    const store = this.createStore<StoredDocument>(namespace) as SQLiteStore<StoredDocument>;
    let imported = 0;
    let examined = 0;
    if (files.length > 0) {
      console.warn(`[storage-high-cardinality] migrating ${files.length} legacy ${namespace} records to SQLite`);
    }
    for (const batch of chunks(files, MIGRATION_BATCH_SIZE)) {
      const documents = (await Promise.all(batch.map(async file => {
        try {
          const parsed = JSON.parse(await readFile(join(legacyDir, file), 'utf8')) as unknown;
          return isStoredDocument(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }))).filter((value): value is StoredDocument => value !== undefined);
      if (namespace === PROJECTION_NAMESPACE) {
        const normalized = documents.map(document => {
          const stableId = stableProjectionId(document);
          return stableId === undefined ? document : { ...document, id: stableId };
        });
        imported += store.importLatestByUpdatedAt(normalized);
        store.deleteMany(documents.flatMap((document, index) => (
          document.id !== normalized[index]!.id ? [document.id] : []
        )));
      } else {
        imported += store.importMissing(documents);
      }
      examined += batch.length;
      if (examined % (MIGRATION_BATCH_SIZE * 20) === 0) {
        console.warn(`[storage-high-cardinality] ${namespace}: examined ${examined}/${files.length}`);
      }
    }

    this.db.prepare(
      'INSERT INTO "_high_cardinality_migrations" (namespace, completed_at, imported_count) VALUES (?, ?, ?)',
    ).run(migrationKey, new Date().toISOString(), imported);
    if (files.length > 0) {
      console.warn(`[storage-high-cardinality] ${namespace}: imported ${imported} records; legacy files retained`);
    }
  }
}
