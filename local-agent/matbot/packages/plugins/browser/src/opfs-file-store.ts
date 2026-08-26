import type { FileEvent, FileFilter, FileHandle, FileStore, MimeType } from '@matatbread/matbot-core';

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

async function filesDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('matbot-files', { create: true });
}

function makeHandle(meta: OPFSMeta, dir: FileSystemDirectoryHandle): FileHandle {
  return {
    ...meta,
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

async function writeMeta(dir: FileSystemDirectoryHandle, meta: OPFSMeta): Promise<void> {
  const metaFh = await dir.getFileHandle(`${meta.id}.meta.json`, { create: true });
  const metaW  = await metaFh.createWritable();
  await metaW.write(JSON.stringify(meta));
  await metaW.close();
}

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
   * Writes a file to OPFS, creating a new entry or upserting by name.
   * @param name File name; when provided and an entry with the same name (+namespace) exists, its content is replaced in place.
   * @param mimeType MIME type of the file.
   * @param data Chunked file content to stream into storage.
   * @param meta Optional session/message/namespace/allowed annotations stored with the file.
   * @returns A handle for reading the stored file's metadata and content.
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
   */
  async *watch(signal?: AbortSignal): AsyncIterable<FileEvent> {
    if (signal === undefined || signal.aborted) return;
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); });
  }
}
