import type { FileEvent, FileFilter, FileHandle, FileStore, MimeType } from '@matatbread/matbot-core';

/**
 * Metadata sidecar persisted as `<id>.meta.json` beside each `<id>.data` blob in OPFS; its
 * fields are spread into the FileHandle returned to readers.
 */
interface OPFSMeta {
  id:          string;
  version:     string;
  name:        string;
  mimeType:    MimeType;
  size:        number;
  createdAt:   string;
  sessionId?:  string;
  messageId?:  string;
  namespace?:  string;
  allowed?:    boolean;
}

/**
 * Resolve (creating when absent) the `matbot-files` directory in the origin's OPFS root.
 * @returns A directory handle holding every file's data and metadata for this store.
 * @throws DOMException - OPFS access fails (no storage permission, quota errors).
 */
async function filesDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('matbot-files', { create: true });
}

/**
 * Build a FileHandle carrying the metadata plus a lazy content streamer.
 * @param meta - Metadata to spread onto the handle.
 * @param dir - OPFS directory holding the `<id>.data` blob.
 * @returns A handle whose `stream()` reads the stored blob chunk by chunk.
 * @throws Never — read failures surface from the returned stream during iteration.
 */
function makeHandle(meta: OPFSMeta, dir: FileSystemDirectoryHandle): FileHandle {
  return {
    ...meta,
    /**
     * Stream the file's bytes until the end or `signal` aborts.
     * @param signal - Optional abort signal; when aborted, iteration stops early.
     * @returns Yields successive chunks of the stored blob.
     * @throws DOMException - The blob cannot be opened or read.
     */
    async *stream(signal?: AbortSignal): AsyncIterable<Uint8Array> {
      const fh   = await dir.getFileHandle(`${meta.id}.data`);
      const file = await fh.getFile();
      const rs   = file.stream();
      const reader = rs.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || signal?.aborted) break;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

/**
 * Persist a metadata sidecar as `<id>.meta.json`, creating or overwriting it.
 * @param dir - OPFS directory to write into.
 * @param meta - Metadata serialized as JSON.
 * @returns Resolves once the metadata file is written and closed.
 * @throws DOMException - The write fails (quota, permission).
 */
async function writeMeta(dir: FileSystemDirectoryHandle, meta: OPFSMeta): Promise<void> {
  const metaFh = await dir.getFileHandle(`${meta.id}.meta.json`, { create: true });
  const metaW  = await metaFh.createWritable();
  await metaW.write(JSON.stringify(meta));
  await metaW.close();
}

/**
 * Stream chunks into the `<id>.data` file and report the byte size. Each chunk is copied into a
 * fresh ArrayBuffer-backed view because OPFS writables reject shared-buffer-backed views.
 * @param dir - OPFS directory to write into.
 * @param id - File id naming the data blob.
 * @param data - Chunked content to store.
 * @returns Total number of bytes written.
 * @throws Error - Any failure while consuming `data` or writing to OPFS; the writable is
 *          aborted first so it cannot leak or leave the OPFS swap-to-file pending forever.
 */
async function writeData(dir: FileSystemDirectoryHandle, id: string, data: AsyncIterable<Uint8Array>): Promise<number> {
  const dataFh   = await dir.getFileHandle(`${id}.data`, { create: true });
  const writable = await dataFh.createWritable();
  try {
    let size = 0;
    for await (const chunk of data) {
      // Copy into a fresh Uint8Array<ArrayBuffer> — OPFS writable requires ArrayBuffer-backed views
      const safe = new Uint8Array(chunk.byteLength);
      safe.set(chunk);
      await writable.write(safe);
      size += chunk.byteLength;
    }
    await writable.close();
    return size;
  } catch (e) {
    // Abandoning the writable without closing/aborting leaks it and can leave
    // the swap-to-file pending forever.
    await writable.abort().catch(() => undefined);
    throw e;
  }
}

/**
 * `FileStore` backed by the Origin Private File System (OPFS).
 * Requires a browser environment with `navigator.storage.getDirectory()`.
 */
export class OPFSFileStore implements FileStore {
  // Promise-chain mutex keyed by (name, namespace): the get→write→meta sequence
  // in a named put is not atomic, so concurrent puts of the same name would
  // otherwise race and mint duplicate entries.
  private inFlight = new Map<string, Promise<unknown>>();

  /**
   * Writes a file to OPFS, creating a new entry or upserting by name. Named writes are
   * serialized per (namespace, name) through an in-flight mutex so concurrent puts of the same
   * name cannot race into duplicate entries.
   * @param name File name; when provided and an entry with the same name (+namespace) exists, its content is replaced in place.
   * @param mimeType MIME type of the file.
   * @param data Chunked file content to stream into storage.
   * @param meta Optional session/message/namespace/allowed annotations stored with the file.
   * @returns A handle for reading the stored file's metadata and content.
   * @throws Error - OPFS read/write failures propagate.
   */
  async put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean },
  ): Promise<FileHandle> {
    if (name === undefined) return this.putNow(name, mimeType, data, meta);
    const key  = JSON.stringify([meta?.namespace ?? null, name]);
    const tail = (this.inFlight.get(key) ?? Promise.resolve())
      .then(() => this.putNow(name, mimeType, data, meta));
    this.inFlight.set(key, tail.then(() => undefined, () => undefined));
    return tail;
  }

  /**
   * Perform the get-or-upsert write without concurrency control (callers serialize named puts).
   * When `name` is provided and an entry with that name (+namespace) exists, its data blob is
   * replaced in place (same id, fresh version, preserved createdAt); otherwise a new id is
   * minted and named after the id when `name` is undefined.
   * @param name File name; undefined always creates a new entry.
   * @param mimeType MIME type of the file.
   * @param data Chunked content to stream into the data blob.
   * @param meta Optional session/message/namespace/allowed annotations stored with the file.
   * @returns A handle for the stored file.
   * @throws Error - Any failure while writing the data or metadata files.
   */
  private async putNow(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean },
  ): Promise<FileHandle> {
    const dir = await filesDir();

    // Upsert when name is provided: find existing entry with matching name (+ namespace).
    if (name !== undefined) {
      const existing = await this.getByName(name, meta?.namespace);
      if (existing !== null) {
        const size = await writeData(dir, existing.id, data);
        const fileMeta: OPFSMeta = {
          id:        existing.id,
          version:   crypto.randomUUID(),
          name,
          mimeType,
          size,
          createdAt: existing.createdAt,
          ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
          ...(meta?.messageId !== undefined ? { messageId: meta.messageId } : {}),
          ...(meta?.namespace !== undefined ? { namespace: meta.namespace } : {}),
          ...(meta?.allowed   !== undefined ? { allowed:   meta.allowed   } : {}),
        };
        await writeMeta(dir, fileMeta);
        return makeHandle(fileMeta, dir);
      }
    }

    const id   = crypto.randomUUID();
    const size = await writeData(dir, id, data);

    const fileMeta: OPFSMeta = {
      id,
      version:   crypto.randomUUID(),
      name:      name ?? id,
      mimeType,
      size,
      createdAt: new Date().toISOString(),
      ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
      ...(meta?.messageId !== undefined ? { messageId: meta.messageId } : {}),
      ...(meta?.namespace !== undefined ? { namespace: meta.namespace } : {}),
      ...(meta?.allowed   !== undefined ? { allowed:   meta.allowed   } : {}),
    };
    await writeMeta(dir, fileMeta);

    return makeHandle(fileMeta, dir);
  }

  /**
   * Fetches a file handle by id.
   * @param id File identifier.
   * @returns The file's handle, or `null` if no metadata exists for `id`.
   * @throws Never — all lookup/parse failures resolve to `null`.
   */
  async get(id: string): Promise<FileHandle | null> {
    try {
      const dir    = await filesDir();
      const metaFh = await dir.getFileHandle(`${id}.meta.json`);
      const file   = await metaFh.getFile();
      const meta   = JSON.parse(await file.text()) as OPFSMeta;
      return makeHandle(meta, dir);
    } catch {
      return null;
    }
  }

  /**
   * Fetches the first file whose name matches, optionally within a namespace.
   * @param name File name to look up.
   * @param namespace Optional namespace to restrict the search to.
   * @returns The matching handle, or `null` if none found.
   * @throws Error - Propagates failures from listing the store.
   */
  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    for await (const handle of this.list(namespace !== undefined ? { namespace } : {})) {
      if (handle.name === name) return handle;
    }
    return null;
  }

  /**
   * Removes a file's data and metadata entries.
   * @param id File identifier.
   * @returns Resolves once both removals have been attempted.
   * @throws Never — removal failures (absent entries, quota/permission errors) are logged via
   *          `console.warn`, not thrown.
   */
  async delete(id: string): Promise<void> {
    const dir = await filesDir();
    const results = await Promise.allSettled([
      dir.removeEntry(`${id}.data`),
      dir.removeEntry(`${id}.meta.json`),
    ]);
    // Removal failures (absent entries, quota/permission errors) must not vanish: log each one.
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        const file  = i === 0 ? `${id}.data` : `${id}.meta.json`;
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`[opfs-file-store] Failed to remove "${file}": ${error}`);
      }
    }
  }

  /**
   * Yields handles of stored files matching the given filter.
   * @param filter Optional namespace/session/MIME/date filters.
   * @returns An async iterable of matching file handles.
   * @throws Error - Propagates failures from reading the OPFS directory.
   */
  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    const dir = await filesDir();
    // TypeScript DOM lib doesn't expose the async iterator methods on
    // FileSystemDirectoryHandle yet; cast to use the runtime-available protocol.
    // The default async iterator is entries() — it yields [name, handle] tuples.
    type IterableDir = AsyncIterable<[string, FileSystemHandle]>;
    for await (const [name] of dir as unknown as IterableDir) {
      if (!name.endsWith('.meta.json')) continue;
      const id  = name.slice(0, -'.meta.json'.length);
      const fh  = await this.get(id);
      if (!fh) continue;
      if (filter?.namespace    && fh.namespace    !== filter.namespace)          continue;
      if (filter?.sessionId    && fh.sessionId    !== filter.sessionId)         continue;
      if (filter?.mimeType     && !fh.mimeType.startsWith(filter.mimeType))     continue;
      if (filter?.createdAfter  && fh.createdAt < filter.createdAfter)          continue;
      if (filter?.createdBefore && fh.createdAt > filter.createdBefore)         continue;
      yield fh;
    }
  }

  /**
   * Writes a temporary file (no session/message/namespace annotations).
   * @param name File name.
   * @param mimeType MIME type of the file.
   * @param data Chunked content to store.
   * @returns A handle for the stored temp file.
   * @throws Error - Same failures as put().
   */
  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data);
  }

  // OPFS has no native change notification; watch() is not implementable in the browser
  // without a SharedWorker or polling. Yield nothing and return when the signal fires.
  /**
   * No-op watcher: OPFS has no change notifications, so this yields nothing
   * and resolves when the signal aborts.
   * @param signal Abort signal that terminates the (empty) watch.
   * @returns An empty async iterable of file events.
   * @throws Never.
   */
  async *watch(signal?: AbortSignal): AsyncIterable<FileEvent> {
    if (signal === undefined || signal.aborted) return;
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); });
  }
}
