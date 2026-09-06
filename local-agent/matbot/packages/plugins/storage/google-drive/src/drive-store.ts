import type { CASResult, QueryResult, Store, StoreQuery } from '@matatbread/matbot-core';
import { executeQuery } from '@matatbread/matbot-storage-base';
import type { DriveClient } from './drive-client.js';

const JSON_MIME = 'application/json';
const SUFFIX    = '.json';

/**
 * Cache entry pairing a document with its Drive file id.
 * @typeParam T - Stored document shape.
 */
interface Entry<T> {
  doc:    T;
  fileId: string;
}

/**
 * `Store<T>` backed by a single Google Drive folder: one `<id>.json` file per document. Because each
 * Drive round-trip is slow, the whole namespace folder is read into memory once on first access and
 * thereafter served from there; every mutation writes through to Drive and updates the cache. A
 * per-store promise-chain mutex serialises the load and all mutations so concurrent writes can't
 * race the cache or create duplicate-named files (the single-realm analogue of the filesystem
 * store's per-key lock — cross-machine concurrency is out of scope, as it is for the filesystem
 * backend across processes). `cas` is accordingly an immediate read-modify-write against the cache:
 * safe within one browser, invisible across machines.
 */
export class DriveStore<T extends { id: string; version: string }> implements Store<T> {
  private readonly drive:    DriveClient;
  private readonly folderId: Promise<string>;
  private readonly cache = new Map<string, Entry<T>>();
  private loaded?: Promise<void>;
  private chain:   Promise<unknown> = Promise.resolve();

  /**
   * Creates the store; nothing touches Drive until the first operation loads
   * the folder.
   * @param drive - Drive client for all document traffic.
   * @param folderId - Promise of the namespace folder's id; resolved lazily
   *   and shared with the creator (typically the backend).
   * @throws Never.
   */
  constructor(drive: DriveClient, folderId: Promise<string>) {
    this.drive    = drive;
    this.folderId = folderId;
  }

  /**
   * Reads every `.json` file in the folder into the cache on first use,
   * skipping other file names. Memoised: a failure (listing, read, or JSON
   * parse) is re-raised by every later call rather than retried.
   * @returns The memoised load promise.
   * @throws Propagates {@link DriveClient} or parse errors from the initial
   *   load.
   */
  private ensureLoaded(): Promise<void> {
    if (this.loaded !== undefined) return this.loaded;
    this.loaded = (async () => {
      const folder = await this.folderId;
      const files  = await this.drive.list(folder);
      await Promise.all(files.map(async f => {
        if (!f.name.endsWith(SUFFIX)) return;
        const id   = f.name.slice(0, -SUFFIX.length);
        const text = await this.drive.readText(f.id);
        this.cache.set(id, { doc: JSON.parse(text) as T, fileId: f.id });
      }));
    })();
    return this.loaded;
  }

  /**
   * Serialises the load and all mutations through a single store-wide
   * promise-chain mutex, so concurrent writes cannot race the cache or create
   * duplicate-named files.
   * @typeParam R - Result type of the serialised operation.
   * @param fn - Operation to run once the lock is held.
   * @returns `fn`'s result.
   * @throws Propagates a rejection of `fn` to the caller; the chain is released
   *   either way.
   */
  private lock<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * Reads the document stored under `id`.
   * @param id - Record identifier.
   * @returns The parsed document, or null when absent.
   * @throws Propagates errors from the initial folder load.
   */
  async get(id: string): Promise<T | null> {
    await this.ensureLoaded();
    return this.cache.get(id)?.doc ?? null;
  }

  /**
   * Unconditionally writes a document: serialised through the store lock and
   * written through to Drive (in-place update, or creation when new), then
   * cached.
   * @param id - Record identifier.
   * @param value - Document to persist.
   * @returns Resolves once Drive and the cache are updated.
   * @throws Propagates errors from the initial load or the Drive write.
   */
  async set(id: string, value: T): Promise<void> {
    await this.ensureLoaded();
    await this.lock(async () => {
      await this.writeThrough(id, value);
    });
  }

  /**
   * Compare-and-swap write: replaces the document only if the cached version
   * equals `expected`. Checked under the store lock against the in-memory
   * cache, so it is safe within a single browser; cross-machine writes are out
   * of scope (see the class doc).
   * @param id - Record identifier.
   * @param expected - Version the caller believes is current.
   * @param next - Replacement document.
   * @returns `{ ok: true, doc: next }` on success, otherwise
   *   `{ ok: false, current }` with the cached document (null when absent).
   * @throws Propagates errors from the initial load or the Drive write.
   */
  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    await this.ensureLoaded();
    return this.lock(async () => {
      const entry = this.cache.get(id);
      if (entry === undefined)            return { ok: false, current: null };
      if (entry.doc.version !== expected) return { ok: false, current: entry.doc };
      await this.writeThrough(id, next);
      return { ok: true, doc: next };
    });
  }

  /**
   * Deletes the document's Drive file and drops it from the cache. The
   * expected-version parameter is accepted for the {@link Store} contract but
   * ignored — deletion is unconditional.
   * @param id - Record identifier.
   * @param _expectedVersion - Unused (contract conformance only).
   * @returns True when the document existed and was deleted, false when
   *   absent.
   * @throws Propagates errors from the initial load or the Drive delete (a 404
   *   is tolerated by {@link DriveClient.deleteFile}).
   */
  async delete(id: string, _expectedVersion?: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.lock(async () => {
      const entry = this.cache.get(id);
      if (entry === undefined) return false;
      await this.drive.deleteFile(entry.fileId);
      this.cache.delete(id);
      return true;
    });
  }

  /**
   * Loads all documents and applies the shared query engine.
   * @param q - The store query to execute.
   * @returns Matching items plus totals/cursor when applicable.
   * @throws Propagates errors from the initial folder load.
   */
  async query(q: StoreQuery): Promise<QueryResult<T>> {
    await this.ensureLoaded();
    return executeQuery([...this.cache.values()].map(e => e.doc), q);
  }

  /**
   * Creates or overwrites the Drive file for `id` and updates the cache. The
   * caller must already hold the store lock.
   * @param id - Record identifier (also the Drive file base name).
   * @param value - Document to persist.
   * @returns Resolves once Drive and the cache are updated.
   * @throws Propagates {@link DriveClient} errors from the update or create.
   */
  private async writeThrough(id: string, value: T): Promise<void> {
    const body  = JSON.stringify(value);
    const entry = this.cache.get(id);
    if (entry !== undefined) {
      await this.drive.updateFile(entry.fileId, body, JSON_MIME);
      this.cache.set(id, { doc: value, fileId: entry.fileId });
      return;
    }
    const folder = await this.folderId;
    const fileId = await this.drive.createFile(`${id}${SUFFIX}`, folder, body, JSON_MIME);
    this.cache.set(id, { doc: value, fileId });
  }
}
