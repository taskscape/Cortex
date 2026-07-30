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

interface StoredDocument {
  id: string;
  version: string;
  [key: string]: unknown;
}

function isStoredDocument(value: unknown): value is StoredDocument {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['version'] === 'string';
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

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

export class HighCardinalityStorageBackend implements StorageBackend {
  readonly fileStore: FileStore;
  private readonly db: DatabaseSync;
  private readonly dotData: string;
  private readonly sqliteStores = new Map<string, SQLiteStore<StoredDocument>>();

  private constructor(dotData: string, db: DatabaseSync) {
    this.dotData = dotData;
    this.db = db;
    this.fileStore = new FilesystemFileStore(join(dotData, 'files'));
  }

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

  async close(): Promise<void> {
    this.db.close();
  }

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
