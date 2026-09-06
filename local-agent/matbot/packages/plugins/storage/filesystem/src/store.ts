import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Store, StoreQuery, QueryResult, CASResult } from '@matatbread/matbot-plugin-api';
import { executeQuery } from '@matatbread/matbot-storage-base';

// A record id is an opaque string — plugins mint ids like `source:<hash>` — but a file name cannot
// hold every character: `:` is illegal on Windows, and `/` or `..` would escape the directory. Ids
// that are already file-safe keep their name, so existing files stay addressable; anything else is
// percent-encoded per UTF-8 byte. The encoding is reversible (`%` encodes to `%25`), so an encoded
// name can never collide with another id's name.
const FILE_SAFE_ID = /^[\w-]+$/;

// Leaves room under the common 255-byte file-name limit for the `.json`/`.json.tmp` suffixes.
const MAX_ENCODED_NAME = 200;

/**
 * Percent-encodes every UTF-8 byte of `id` that is not a filesystem-safe
 * character, leaving safe ASCII characters untouched. The encoding is
 * reversible, so an encoded name can never collide with another id's name.
 * @param id - Record identifier to map to a file-name fragment.
 * @returns The encoded name (each unsafe byte becomes `%XX`).
 * @throws Never.
 */
function encodeName(id: string): string {
  let encoded = '';
  for (const byte of new TextEncoder().encode(id)) {
    const char = String.fromCharCode(byte);
    encoded += byte < 0x80 && FILE_SAFE_ID.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/**
 * A {@link Store} implementation persisting each document as a pretty-printed
 * JSON file in a directory. Ids that are not filesystem-safe are percent-
 * encoded per UTF-8 byte; over-long names fall back to a `%h%<sha256>` digest.
 * Writes are atomic (tmp file + rename) and `set`/`cas`/`delete` serialise
 * per id with an in-process promise-chain mutex (single-process safety only).
 */
export class FilesystemStore<T extends { id: string; version: string }> implements Store<T> {
  private initPromise: Promise<void> | undefined;
  private locks = new Map<string, Promise<unknown>>();

  private readonly dir: string;
  /**
   * Creates a store rooted at `dir`. The directory is created lazily on first
   * write or query, not in the constructor.
   * @param dir - Directory holding one `<encoded-id>.json` file per document.
   * @throws Never.
   */
  constructor(dir: string) { this.dir = dir; }

  // ── Initialisation ───────────────────────────────────────────────────────────

  /**
   * Ensures the store directory exists, memoising the work so it runs at most
   * once per store instance.
   * @returns The memoised initialisation promise.
   * @throws Propagates `fs.mkdir` errors; because the promise is memoised, a
   *   failure is re-raised by every later call rather than retried.
   */
  private init(): Promise<void> {
    return (this.initPromise ??= fs.mkdir(this.dir, { recursive: true }).then(() => undefined));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Maps a record id to a filesystem-safe file base name. Already file-safe ids
   * keep their name (so existing files stay addressable); others are
   * percent-encoded per UTF-8 byte; over-long results fall back to `%h%` plus a
   * SHA-256 digest of the id (the digest form cannot shadow an encoded name).
   * @param id - Record identifier.
   * @returns The file base name, without extension.
   * @throws Error when `id` is the empty string.
   */
  private safeName(id: string): string {
    if (id.length === 0) throw new Error('Invalid store id: ""');
    if (FILE_SAFE_ID.test(id)) {
      return id.length <= MAX_ENCODED_NAME ? id : `%h%${createHash('sha256').update(id).digest('hex')}`;
    }
    const encoded = encodeName(id);
    // `%h%` is unreachable through encodeName — a `%` there is always followed by two hex digits —
    // so the digest form for over-long ids cannot shadow an encoded name.
    return encoded.length <= MAX_ENCODED_NAME ? encoded : `%h%${createHash('sha256').update(id).digest('hex')}`;
  }

  /**
   * Resolves a record id to its document's file path.
   * @param id - Record identifier.
   * @returns Path of the `<encoded-id>.json` file within the store directory.
   * @throws Error when `id` is empty (propagated from
   *   {@link FilesystemStore.safeName}).
   */
  private filePath(id: string): string {
    return join(this.dir, `${this.safeName(id)}.json`);
  }

  /**
   * Serialises concurrent operations on the same key through a promise-chain
   * mutex: each call queues behind the previous one for that key. Safe within a
   * single process only; cross-process safety requires a different backend.
   * @typeParam R - Result type of the serialised operation.
   * @param key - Lock key (the record id).
   * @param fn - Operation to run once the lock is held.
   * @returns `fn`'s result.
   * @throws Propagates a rejection of `fn` to the caller; the lock is released
   *   either way so the chain cannot wedge.
   */
  private withLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const tail = (this.locks.get(key) ?? Promise.resolve()).then(() => fn());
    this.locks.set(key, tail.then(() => undefined, () => undefined));
    return tail;
  }

  /**
   * Writes `content` to `filePath` atomically: the payload goes to a
   * `<filePath>.tmp` sibling first, then is renamed over the target.
   * @param filePath - Destination file path.
   * @param content - UTF-8 text to write.
   * @returns Resolves once the rename completes.
   * @throws Propagates write errors; on a failed rename the temp file is
   *   removed (best effort) and the rename error is re-thrown.
   */
  private async writeAtomic(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    try {
      await fs.rename(tmp, filePath);
    } catch (e) {
      await fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  // ── Store<T> implementation ───────────────────────────────────────────────────

  /**
   * Reads the document stored under `id`.
   * @param id - Record identifier.
   * @returns The parsed document, or null when absent.
   * @throws Propagates read or parse errors other than a missing file.
   */
  async get(id: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(id), 'utf8')) as T;
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * Unconditionally writes a document under `id`. Serialised per id with the
   * same promise-chain mutex as `cas`/`delete` so it cannot interleave with a
   * CAS window.
   * @param id - Record identifier.
   * @param value - Document to persist.
   * @returns Resolves once the file is written.
   * @throws Any error raised while writing or renaming the file.
   */
  async set(id: string, value: T): Promise<void> {
    return this.withLock(id, () => this.writeDoc(id, value));
  }

  /**
   * Unlocked write primitive: initialises the directory and writes the
   * document atomically as pretty-printed JSON. Callers that already hold the
   * id's lock (`cas`) must use this instead of {@link FilesystemStore.set}, or
   * they would queue behind themselves and deadlock.
   * @param id - Record identifier.
   * @param value - Document to persist.
   * @returns Resolves once the file is written.
   * @throws Propagates initialisation or write errors.
   */
  private async writeDoc(id: string, value: T): Promise<void> {
    await this.init();
    await this.writeAtomic(this.filePath(id), JSON.stringify(value, null, 2));
  }

  /**
   * Compare-and-swap write: replaces the document only if its current version
   * equals `expected`.
   * @param id - Record identifier.
   * @param expected - Version the caller believes is current.
   * @param next - Replacement document.
   * @returns `{ ok: true, doc: next }` on success, otherwise `{ ok: false, current }`.
   * @throws Propagates read errors from the version check and write errors from
   *   the replacement.
   */
  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    return this.withLock(id, async () => {
      const current = await this.get(id);
      if (current === null || current.version !== expected) {
        return { ok: false, current } satisfies CASResult<T>;
      }
      await this.writeDoc(id, next);
      return { ok: true, doc: next } satisfies CASResult<T>;
    });
  }

  /**
   * Deletes the document under `id`, optionally gated on a version check.
   * @param id - Record identifier.
   * @param expectedVersion - When given, delete only if the stored version matches.
   * @returns True if the file was deleted (or already gone), false on version mismatch.
   * @throws Propagates read errors from the version check; unlink errors are
   *   swallowed and reported as `false`.
   */
  async delete(id: string, expectedVersion?: string): Promise<boolean> {
    return this.withLock(id, async () => {
      if (expectedVersion !== undefined) {
        const current = await this.get(id);
        if (current === null || current.version !== expectedVersion) return false;
      }
      try {
        await fs.unlink(this.filePath(id));
        return true;
      } catch {
        return false;
      }
    });
  }

  /**
   * Loads every readable `.json` document in the directory and filters,
   * sorts and paginates it through the shared query engine. Corrupted files
   * are skipped silently.
   * @param q - The store query to execute.
   * @returns Matching items plus the total count before pagination.
   * @throws Propagates directory-creation errors from lazy initialisation;
   *   unreadable or corrupted files are skipped silently.
   */
  async query(q: StoreQuery): Promise<QueryResult<T>> {
    await this.init();

    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return { items: [], total: 0 };
    }

    // Collect into a mutable array to avoid Awaited<T> inference from Promise.all
    const pool: T[] = [];
    await Promise.all(
      entries
        .filter(e => /^[\w%-]+\.json$/.test(e))
        .map(async e => {
          try {
            pool.push(JSON.parse(await fs.readFile(join(this.dir, e), 'utf8')) as T);
          } catch { /* skip corrupted */ }
        }),
    );

    return executeQuery(pool, q);
  }
}
