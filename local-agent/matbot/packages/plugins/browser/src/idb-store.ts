import type { CASResult, QueryResult, Store, StoreQuery } from '@matatbread/matbot-core';
import { executeQuery } from '@matatbread/matbot-storage-base';

/**
 * Promisify an IDBRequest.
 * @param req - Request whose success/error events drive the promise.
 * @returns Resolves with the request result on success.
 * @throws DOMException - Rejects with `req.error` when the request fails.
 */
function idbPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Open (creating on first use) an IndexedDB database holding a single object store.
 * @param dbName - Database name.
 * @param storeName - Object store created by the version-1 upgrade when the database is new.
 * @returns The open database connection.
 * @throws DOMException - Rejects with the open request's error (quota, permission, blocked
 *          upgrade).
 */
function openDB(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(storeName, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * `Store<T>` backed by IndexedDB.  Suitable for browser environments. Loads all documents and
 * delegates filtering/sorting/paging to the shared in-memory query engine.
 * @typeParam T - Stored record shape; must carry `id` (the IDB keyPath) and `version`.
 */
export class IDBStore<T extends { id: string; version: string }> implements Store<T> {
  private dbp: Promise<IDBDatabase>;

  private readonly storeName: string;
  /**
   * Starts opening the database; the connection promise is shared by all later operations, so
   * open failures surface on first use rather than here.
   * @param dbName - IndexedDB database name (`matbot-<namespace>` by convention).
   * @param storeName - Object store name, created on first open with `id` as keyPath.
   * @throws Never — connection failures reject the internal open promise and fail subsequent
   *          operations instead.
   */
  constructor(dbName: string, storeName: string) {
    this.storeName = storeName;
    this.dbp = openDB(dbName, storeName);
  }

  /**
   * Await the database connection and start a transaction on the object store.
   * @param mode - Transaction mode (`readonly` or `readwrite`).
   * @returns The object store bound to the new transaction.
   * @throws DOMException - If the open promise has rejected or the transaction cannot start.
   */
  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.dbp;
    return db.transaction(this.storeName, mode).objectStore(this.storeName);
  }

  /**
   * Fetches a document by id.
   * @param id Document identifier.
   * @returns The document, or `null` if not found.
   * @throws DOMException - On transaction or request failure.
   */
  async get(id: string): Promise<T | null> {
    const store = await this.tx('readonly');
    return (await idbPromise(store.get(id) as IDBRequest<T | undefined>)) ?? null;
  }

  /**
   * Unconditionally writes (inserts or overwrites) a document.
   * @param id Document identifier.
   * @param value Document to store.
   * @returns Resolves once the write commits.
   * @throws IndexedDB request errors propagate on transaction failure.
   */
  async set(id: string, value: T): Promise<void> {
    const store = await this.tx('readwrite');
    await idbPromise(store.put(value));
  }

  /**
   * Compare-and-swap: replaces the document only if its stored version matches `expected`.
   * @param id Document identifier.
   * @param expected Version the caller believes is current.
   * @param next New document to write on success.
   * @returns A result indicating success with the new doc, or failure with the current state.
   * @throws IndexedDB request errors propagate on transaction failure.
   */
  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    const db    = await this.dbp;
    const tx    = db.transaction(this.storeName, 'readwrite');
    const store = tx.objectStore(this.storeName);

    const current: T | undefined = await idbPromise(store.get(id) as IDBRequest<T | undefined>);

    if (current === undefined) {
      return { ok: false, current: null };
    }
    if (current.version !== expected) {
      return { ok: false, current };
    }

    await idbPromise(store.put(next));
    return { ok: true, doc: next };
  }

  /**
   * Deletes a document by id.
   * @param id Document identifier.
   * @param _expectedVersion Unused; deletion does not check the current version.
   * @returns `true` if a document existed and was deleted, `false` otherwise.
   * @throws DOMException - On transaction or request failure.
   */
  async delete(id: string, _expectedVersion?: string): Promise<boolean> {
    const store   = await this.tx('readwrite');
    const current = await idbPromise(store.get(id) as IDBRequest<T | undefined>);
    if (!current) return false;
    await idbPromise(store.delete(id));
    return true;
  }

  /**
   * Loads all documents and applies filtering/sorting/paging in memory.
   * @param q Query describing filters, sort, and paging.
   * @returns Matching documents plus total count.
   * @throws DOMException - On transaction or request failure.
   */
  async query(q: StoreQuery): Promise<QueryResult<T>> {
    const store = await this.tx('readonly');
    const all: T[] = await idbPromise(store.getAll() as IDBRequest<T[]>);
    return executeQuery(all, q);
  }
}
