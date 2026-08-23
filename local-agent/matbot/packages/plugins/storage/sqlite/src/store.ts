import { DatabaseSync } from 'node:sqlite';
import type { Store, StoreQuery, QueryResult, CASResult } from '@matatbread/matbot-plugin-api';
import { executeQuery } from '@matatbread/matbot-storage-base';

export class SQLiteStore<T extends { id: string; version: string }> implements Store<T> {
  private readonly db:    DatabaseSync;
  private readonly table: string;

  constructor(db: DatabaseSync, namespace: string) {
    this.db    = db;
    this.table = `${namespace.replace(/[^a-zA-Z0-9]/g, '_')}_store`;
    db.exec(`CREATE TABLE IF NOT EXISTS "${this.table}" (
      id      TEXT PRIMARY KEY NOT NULL,
      version TEXT NOT NULL,
      doc     TEXT NOT NULL
    )`);
  }

  /**
   * Reads the document stored under `id`.
   * @param id - Record identifier.
   * @returns The parsed document, or null when absent.
   */
  async get(id: string): Promise<T | null> {
    const row = this.db.prepare(`SELECT doc FROM "${this.table}" WHERE id = ?`).get(id) as unknown as { doc: string } | undefined;
    return row !== undefined ? JSON.parse(row.doc) as T : null;
  }

  async set(id: string, value: T): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO "${this.table}" (id, version, doc) VALUES (?, ?, ?)`)
      .run(id, value.version, JSON.stringify(value));
  }

  /**
   * Import legacy records without overwriting newer rows already present in SQLite.
   * The transaction turns a filesystem migration from one fsync per record into one
   * commit per chunk while remaining safely resumable after an interrupted startup.
   */
  /**
   * Inserts records only when their id is not already present.
   * @param values - Records to import.
   * @returns Number of records actually inserted.
   * @throws Re-throws SQLite errors after rolling back the transaction.
   */
  importMissing(values: readonly T[]): number {
    if (values.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO "${this.table}" (id, version, doc) VALUES (?, ?, ?)`,
    );
    let imported = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const value of values) {
        const result = insert.run(value.id, value.version, JSON.stringify(value));
        imported += Number(result.changes);
      }
      this.db.exec('COMMIT');
      return imported;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Inserts or updates records, keeping the existing row unless the incoming
   * record's `updatedAt` is greater than or equal to the stored one.
   * @param values - Records to import.
   * @returns Number of rows inserted or updated.
   * @throws Re-throws SQLite errors after rolling back the transaction.
   */
  importLatestByUpdatedAt(values: readonly T[]): number {
    if (values.length === 0) return 0;
    const insert = this.db.prepare(`
      INSERT INTO "${this.table}" (id, version, doc) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        doc = excluded.doc
      WHERE COALESCE(json_extract(excluded.doc, '$.updatedAt'), '') >=
            COALESCE(json_extract("${this.table}".doc, '$.updatedAt'), '')
    `);
    let imported = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const value of values) {
        const result = insert.run(value.id, value.version, JSON.stringify(value));
        imported += Number(result.changes);
      }
      this.db.exec('COMMIT');
      return imported;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Deletes all records with the given ids in one transaction.
   * @param ids - Record identifiers to delete.
   * @returns Number of rows deleted.
   * @throws Re-throws SQLite errors after rolling back the transaction.
   */
  deleteMany(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const remove = this.db.prepare(`DELETE FROM "${this.table}" WHERE id = ?`);
    let deleted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) deleted += Number(remove.run(id).changes);
      this.db.exec('COMMIT');
      return deleted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row     = this.db.prepare(`SELECT version, doc FROM "${this.table}" WHERE id = ?`).get(id) as unknown as { version: string; doc: string } | undefined;
      const current = row !== undefined ? JSON.parse(row.doc) as T : null;
      if (current === null || current.version !== expected) {
        this.db.exec('ROLLBACK');
        return { ok: false, current };
      }
      this.db.prepare(`UPDATE "${this.table}" SET version = ?, doc = ? WHERE id = ?`)
        .run(next.version, JSON.stringify(next), id);
      this.db.exec('COMMIT');
      return { ok: true, doc: next };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async delete(id: string, expectedVersion?: string): Promise<boolean> {
    if (expectedVersion !== undefined) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const row = this.db.prepare(`SELECT version FROM "${this.table}" WHERE id = ?`).get(id) as unknown as { version: string } | undefined;
        if (row === undefined || row.version !== expectedVersion) {
          this.db.exec('ROLLBACK');
          return false;
        }
        this.db.prepare(`DELETE FROM "${this.table}" WHERE id = ?`).run(id);
        this.db.exec('COMMIT');
        return true;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    const result = this.db.prepare(`DELETE FROM "${this.table}" WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /**
   * Loads all rows and filters, sorts and paginates them through the shared
   * query engine.
   * @param q - The store query to execute.
   * @returns Matching items plus the total count before pagination.
   */
  async query(q: StoreQuery): Promise<QueryResult<T>> {
    const rows = this.db.prepare(`SELECT doc FROM "${this.table}"`).all() as unknown as Array<{ doc: string }>;
    return executeQuery(rows.map(r => JSON.parse(r.doc) as T), q);
  }
}
