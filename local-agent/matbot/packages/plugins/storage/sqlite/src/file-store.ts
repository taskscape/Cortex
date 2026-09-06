import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { FileStore, FileHandle, FileMetaData, FileEvent, FileFilter, MimeType } from '@matatbread/matbot-plugin-api';

const file_table_name = 'file_meta';

// Puts buffer whole files in memory before insert; the cap bounds a hostile or
// oversized stream before it can OOM the process. Checked per chunk so the
// failure happens as soon as the limit is crossed.
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;

/**
 * A {@link FileStore} persisting file metadata and blobs in the shared SQLite
 * database (`file_meta` table). Blobs are stored whole and streamed lazily;
 * watchers are notified of every write in-process.
 */
export class SQLiteFileStore implements FileStore {
  private readonly db:      DatabaseSync;
  private readonly maxBytes: number;
  private readonly watchers = new Set<(event: FileEvent) => void>();

  /**
   * Creates the metadata table and indexes if absent.
   * @param db - Shared SQLite database connection.
   * @param opts - Optional settings; `maxBytes` caps the buffered size of a single put (default 256 MiB).
   * @throws Propagates SQLite errors from creating the table or indexes.
   */
  constructor(db: DatabaseSync, opts?: { maxBytes?: number }) {
    this.db       = db;
    this.maxBytes = opts?.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
    db.exec(`CREATE TABLE IF NOT EXISTS ${file_table_name} (
      id          TEXT    PRIMARY KEY NOT NULL,
      name        TEXT    NOT NULL,
      mime_type   TEXT    NOT NULL,
      size        INTEGER NOT NULL,
      created_at  TEXT    NOT NULL,
      namespace   TEXT,
      session_id  TEXT,
      message_id  TEXT,
      allowed     INTEGER,
      data        BLOB    NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${file_table_name}_name      ON ${file_table_name} (name)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${file_table_name}_namespace ON ${file_table_name} (namespace)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${file_table_name}_session   ON ${file_table_name} (session_id)`);
    // Add `allowed`/`version` to tables created before these columns existed; ignore the error if already present.
    try { db.exec(`ALTER TABLE ${file_table_name} ADD COLUMN allowed INTEGER`); } catch { /* column exists */ }
    try { db.exec(`ALTER TABLE ${file_table_name} ADD COLUMN version TEXT`);   } catch { /* column exists */ }
  }

  /**
   * Stores a file (replacing any existing row with the same id) and emits a
   * change event to watchers.
   * @param name - File id; a UUID is minted when undefined.
   * @param mimeType - MIME type of the content.
   * @param data - Byte chunks making up the file.
   * @param opts - Optional namespace, session/message linkage and allowed flag.
   * @returns The handle for the stored file.
   * @throws When the stream exceeds the configured maximum size, or re-throws
   *         SQLite errors after rolling back the transaction.
   */
  async put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    opts?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean },
  ): Promise<FileHandle> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of data) {
      total += chunk.byteLength;
      if (total > this.maxBytes) {
        throw new Error(`File exceeds the store's maximum size of ${this.maxBytes} bytes (aborted after ${total} bytes).`);
      }
      chunks.push(chunk);
    }
    const blob = Buffer.concat(chunks);
    const size = blob.length;
    const id   = name ?? crypto.randomUUID();
    const now  = new Date().toISOString();

    let createdAt: string;
    let prevMeta:  MetaRow | undefined;
    const version = versionFor(blob, size);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      prevMeta  = this.db.prepare(META_SELECT + ` WHERE id = ?`).get(id) as unknown as MetaRow | undefined;
      createdAt = prevMeta?.created_at ?? now;
      this.db.prepare(`
        INSERT OR REPLACE INTO ${file_table_name} (id, name, mime_type, size, created_at, namespace, session_id, message_id, allowed, data, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, id, mimeType, size, createdAt,
             opts?.namespace ?? null, opts?.sessionId ?? null, opts?.messageId ?? null,
             opts?.allowed ? 1 : null, blob, version);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    const nextRow: MetaRow = {
      id, name: id, mime_type: mimeType, size, created_at: createdAt, version,
      namespace:  opts?.namespace  ?? null,
      session_id: opts?.sessionId  ?? null,
      message_id: opts?.messageId  ?? null,
      allowed:    opts?.allowed ? 1 : null,
    };
    const handle = this.buildHandle(nextRow);
    this.emit(buildFileEvent(nextRow, prevMeta !== undefined ? metaFromRow(prevMeta) : undefined));
    return handle;
  }

  /**
   * Resolves a file handle by id.
   * @param id - File identifier.
   * @returns The handle, or null when not found.
   * @throws Propagates SQLite errors from the metadata read.
   */
  async get(id: string): Promise<FileHandle | null> {
    const row = this.db.prepare(META_SELECT + ` WHERE id = ?`).get(id) as unknown as MetaRow | undefined;
    return row !== undefined ? this.buildHandle(row) : null;
  }

  /**
   * Resolves a file handle by name, optionally constrained to one namespace.
   * @param name - File name to match exactly.
   * @param namespace - Namespace constraint; undefined matches any namespace.
   * @returns The handle, or null when not found.
   * @throws Propagates SQLite errors from the metadata read.
   */
  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    const row = namespace !== undefined
      ? this.db.prepare(META_SELECT + ` WHERE name = ? AND namespace = ?`).get(name, namespace) as unknown as MetaRow | undefined
      : this.db.prepare(META_SELECT + ` WHERE name = ?`).get(name) as unknown as MetaRow | undefined;
    return row !== undefined ? this.buildHandle(row) : null;
  }

  /**
   * Deletes a file row.
   * @param id - File identifier.
   * @returns Resolves once the row is deleted (no-op when the id is absent).
   * @throws Propagates SQLite errors from the delete.
   */
  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${file_table_name} WHERE id = ?`).run(id);
  }

  /**
   * Streams handles for all files matching the filter.
   * @param filter - Optional criteria on namespace, session, MIME prefix or dates.
   * @returns Matching {@link FileHandle}s.
   * @throws Propagates SQLite errors from the metadata read.
   */
  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    const rows = this.db.prepare(META_SELECT).all() as unknown as MetaRow[];
    for (const row of rows) {
      const h = this.buildHandle(row);
      if (filter?.namespace     !== undefined && h.namespace  !== filter.namespace)       continue;
      if (filter?.sessionId     !== undefined && h.sessionId  !== filter.sessionId)       continue;
      if (filter?.mimeType      !== undefined && !h.mimeType.startsWith(filter.mimeType)) continue;
      if (filter?.createdAfter  !== undefined && h.createdAt  <  filter.createdAfter)     continue;
      if (filter?.createdBefore !== undefined && h.createdAt  >  filter.createdBefore)    continue;
      yield h;
    }
  }

  /**
   * Stores a temporary (root-namespaced) file: delegates to
   * {@link SQLiteFileStore.put} with no namespace/session linkage.
   * @param name - File id; a UUID is minted when undefined.
   * @param mimeType - MIME type of the content.
   * @param data - Byte chunks making up the file.
   * @returns The handle for the stored file.
   * @throws Under the same conditions as {@link SQLiteFileStore.put}.
   */
  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data);
  }

  /**
   * Yields every subsequent write event until the signal aborts.
   * @param signal - Optional abort signal ending the stream.
   * @returns Change events describing each write (fields changed vs. prior state).
   */
  async *watch(signal?: AbortSignal): AsyncIterable<FileEvent> {
    if (signal?.aborted) return;
    const queue: FileEvent[] = [];
    let notify: (() => void) | undefined;
    let done = false;

    /**
     * Releases a parked iterator, if one is waiting.
     * @returns Nothing.
     * @throws Never.
     */
    const wake     = (): void => { const fn = notify; notify = undefined; fn?.(); };
    /**
     * Enqueues an event and wakes the streaming iterator.
     * @param event - Change event emitted by a put.
     * @returns Nothing.
     * @throws Never.
     */
    const listener = (event: FileEvent): void => { queue.push(event); wake(); };
    /**
     * Ends the stream and deregisters the listener.
     * @returns Nothing.
     * @throws Never.
     */
    const onAbort  = (): void => { done = true; this.watchers.delete(listener); wake(); };

    this.watchers.add(listener);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      while (!done) {
        while (queue.length > 0) yield queue.shift()!;
        if (done) break;
        await new Promise<void>(r => { notify = r; });
      }
    } finally {
      this.watchers.delete(listener);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Notifies every registered watcher of a change event.
   * @param event - Event to deliver.
   * @returns Nothing.
   * @throws Propagates any error a watcher handler throws.
   */
  private emit(event: FileEvent): void {
    for (const fn of this.watchers) fn(event);
  }

  /**
   * Builds a {@link FileHandle} from a metadata row, spreading the metadata
   * plus a `stream` that fetches the blob lazily (yielding nothing when the
   * row is gone; the stream's SQLite errors surface to the stream consumer).
   * Rows written before the `version` column existed fall back to a
   * size-derived version.
   * @param row - Metadata row (without the blob).
   * @returns The handle.
   * @throws Never synchronously.
   */
  private buildHandle(row: MetaRow): FileHandle {
    const db = this.db;
    const meta: FileMetaData = {
      id:        row.id,
      version:   row.version ?? row.size.toString(),
      name:      row.name,
      mimeType:  row.mime_type,
      size:      row.size,
      createdAt: row.created_at,
      ...(row.namespace  !== null ? { namespace:  row.namespace  } : {}),
      ...(row.session_id !== null ? { sessionId:  row.session_id } : {}),
      ...(row.message_id !== null ? { messageId:  row.message_id } : {}),
      ...(row.allowed                 ? { allowed: true } : {}),
    };
    return {
      ...meta,
      /**
       * Fetches the blob on demand (a single query), streaming one chunk.
       * @yields The stored blob bytes, or nothing when the row is gone.
       * @throws Propagates SQLite errors from the blob read.
       */
      stream(_signal?: AbortSignal): AsyncIterable<Uint8Array> {
        const id = row.id;
        return (async function*() {
          const dataRow = db.prepare(`SELECT data FROM ${file_table_name} WHERE id = ?`).get(id) as unknown as { data: Buffer } | undefined;
          if (dataRow !== undefined) yield dataRow.data;
        })();
      },
    };
  }
}

// Selects all metadata columns except the blob — data is fetched lazily in stream().
const META_SELECT = `SELECT id, name, mime_type, size, created_at, namespace, session_id, message_id, allowed, version FROM ${file_table_name}`;

const META_KEYS: ReadonlyArray<keyof FileMetaData> = [
  'id', 'version', 'name', 'mimeType', 'size', 'createdAt',
  'sessionId', 'messageId', 'namespace', 'allowed',
];

/**
 * The `file_meta` row shape (snake_case, as SQLite returns it).
 */
interface MetaRow {
  id:         string;
  name:       string;
  mime_type:  string;
  size:       number;
  created_at: string;
  namespace:  string | null;
  session_id: string | null;
  message_id: string | null;
  allowed:    number | null;
  // Rows written before the column existed carry null; those fall back to the
  // legacy size-derived version until their next write.
  version:    string | null;
}

/**
 * Content-addressed revision: `"<sha256-of-blob>:<size>"`. Distinct content at
 * equal size yields distinct versions, so a stale handle's version never
 * matches a newer write.
 * @param blob - File bytes to hash.
 * @param size - Byte length of the blob (appended to the hash).
 * @returns The version string.
 * @throws Never.
 */
function versionFor(blob: Buffer, size: number): string {
  return `${createHash('sha256').update(blob).digest('hex')}:${size}`;
}

/**
 * Converts a snake_case metadata row into a {@link FileMetaData}, falling back
 * to a size-derived version when the row predates the `version` column.
 * @param row - Row to convert.
 * @returns The file metadata.
 * @throws Never.
 */
function metaFromRow(row: MetaRow): FileMetaData {
  return {
    id:        row.id,
    version:   row.version ?? row.size.toString(),
    name:      row.name,
    mimeType:  row.mime_type,
    size:      row.size,
    createdAt: row.created_at,
    ...(row.namespace  !== null ? { namespace:  row.namespace  } : {}),
    ...(row.session_id !== null ? { sessionId:  row.session_id } : {}),
    ...(row.message_id !== null ? { messageId:  row.message_id } : {}),
    ...(row.allowed                 ? { allowed: true } : {}),
  };
}

/**
 * Builds a change event for a written file, listing which metadata fields
 * differ from the previous state (all fields for a new file).
 * @param row - New row state.
 * @param prev - Previous metadata, or undefined for a new file.
 * @returns The event: full metadata plus the `changed` field names.
 * @throws Never.
 */
function buildFileEvent(row: MetaRow, prev: FileMetaData | undefined): FileEvent {
  const meta = metaFromRow(row);
  const a = meta as unknown as Record<string, unknown>;
  const b = prev as unknown as Record<string, unknown> | undefined;
  const changed = b === undefined
    ? [...META_KEYS]
    : META_KEYS.filter(k => a[k] !== b[k]);
  return { ...meta, changed };
}
