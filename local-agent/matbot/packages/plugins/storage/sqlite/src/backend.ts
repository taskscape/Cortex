import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, FileStore } from '@matatbread/matbot-plugin-api';
import type { StorageBackend } from '@matatbread/matbot-plugin-api';
import { SQLiteStore } from './store.js';
import { SQLiteFileStore } from './file-store.js';

/**
 * A {@link StorageBackend} persisting every namespace as a table in a single
 * WAL-mode SQLite database (`<dotData>/matbot.db`), including binary files.
 */
export class SQLiteStorageBackend implements StorageBackend {
  private readonly db: DatabaseSync;
  /** FileStore backed by the same database. */
  readonly fileStore:  FileStore;

  private constructor(db: DatabaseSync) {
    this.db        = db;
    this.fileStore = new SQLiteFileStore(db);
  }

  /**
   * Opens (creating if needed) the database under `<dotData>` with WAL mode
   * and NORMAL synchronous pragmas.
   * @param dotData - Root data directory.
   * @returns The initialised backend.
   */
  static open(dotData: string): Promise<SQLiteStorageBackend> {
    mkdirSync(dotData, { recursive: true });
    const db = new DatabaseSync(join(dotData, 'matbot.db'));
    // WAL mode: readers don't block writers and vice versa.
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    return Promise.resolve(new SQLiteStorageBackend(db));
  }

  /**
   * Creates (or reuses, per call) a store for the given namespace.
   * @param namespace - Store namespace mapped to its own table.
   * @returns A store persisting documents of type `T`.
   * @template T - Stored document shape ({ id, version } at minimum).
   */
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    return new SQLiteStore<T>(this.db, namespace);
  }

  /**
   * Closes the underlying SQLite database.
   */
  async close(): Promise<void> {
    this.db.close();
  }
}
