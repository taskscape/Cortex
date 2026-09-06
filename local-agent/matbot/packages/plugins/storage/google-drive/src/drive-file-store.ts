import type { FileEvent, FileFilter, FileHandle, FileStore, MimeType } from '@matatbread/matbot-core';
import type { DriveClient } from './drive-client.js';

const DATA_SUFFIX = '.data';
const META_SUFFIX = '.meta.json';
const JSON_MIME   = 'application/json';

/**
 * Sidecar metadata persisted beside each blob as `<id>.meta.json` (same shape
 * as the OPFS browser store).
 */
interface DriveFileMeta {
  id:         string;
  version:    string;
  name:       string;
  mimeType:   MimeType;
  size:       number;
  createdAt:  string;
  sessionId?: string;
  messageId?: string;
  namespace?: string;
  allowed?:   boolean;
}

/**
 * In-memory pairing of a file's metadata with the Drive ids of its blob and
 * sidecar, cached after the initial folder load.
 */
interface Slot {
  meta:       DriveFileMeta;
  dataFileId: string;
  metaFileId: string;
}

/**
 * Buffers an async byte iterable into one contiguous array.
 * @param data - Byte chunks to concatenate, in stream order.
 * @returns All chunks joined in order.
 * @throws Propagates errors thrown by `data`.
 */
async function collect(data: AsyncIterable<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of data) { chunks.push(chunk); size += chunk.byteLength; }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/**
 * `FileStore` backed by a Google Drive folder: each blob is an `<id>.data` file paired with an
 * `<id>.meta.json` sidecar (the same shape as the OPFS browser store). Metadata is read into memory
 * once on first access so `list`/`get`/`getByName` don't re-walk Drive; blob bytes are fetched on
 * demand when a handle is streamed. Uploads buffer the full blob in memory before sending — adequate
 * for the chat-attachment sizes this serves, not for very large files. Watchers are not supported
 * (no push events in this backend).
 */
export class DriveFileStore implements FileStore {
  private readonly drive:    DriveClient;
  private readonly folderId: Promise<string>;
  private readonly slots = new Map<string, Slot>();
  private loaded?: Promise<void>;
  private chain:   Promise<unknown> = Promise.resolve();

  /**
   * Creates the store; nothing touches Drive until the first operation loads
   * the folder index.
   * @param drive - Drive client for all blob and sidecar traffic.
   * @param folderId - Promise of the store folder's id; resolved lazily and
   *   shared with the creator (typically the backend).
   * @throws Never.
   */
  constructor(drive: DriveClient, folderId: Promise<string>) {
    this.drive    = drive;
    this.folderId = folderId;
  }

  /**
   * Loads the folder's `.data`/`.meta.json` pairs into the slot cache on first
   * use, skipping orphaned sidecars. Memoised: a failure (listing, read, or
   * JSON parse) is re-raised by every later call rather than retried.
   * @returns The memoised load promise.
   * @throws Propagates {@link DriveClient} or parse errors from the initial
   *   load.
   */
  private ensureLoaded(): Promise<void> {
    if (this.loaded !== undefined) return this.loaded;
    this.loaded = (async () => {
      const folder = await this.folderId;
      const files  = await this.drive.list(folder);
      const data   = new Map<string, string>();   // id → dataFileId
      const metas  = new Map<string, string>();    // id → metaFileId
      for (const f of files) {
        if (f.name.endsWith(META_SUFFIX))      metas.set(f.name.slice(0, -META_SUFFIX.length), f.id);
        else if (f.name.endsWith(DATA_SUFFIX)) data.set(f.name.slice(0, -DATA_SUFFIX.length), f.id);
      }
      await Promise.all([...metas].map(async ([id, metaFileId]) => {
        const dataFileId = data.get(id);
        if (dataFileId === undefined) return;   // orphaned meta — skip
        const meta = JSON.parse(await this.drive.readText(metaFileId)) as DriveFileMeta;
        this.slots.set(id, { meta, dataFileId, metaFileId });
      }));
    })();
    return this.loaded;
  }

  /**
   * Serialises mutations through a single store-wide promise-chain mutex, so
   * concurrent writes cannot interleave Drive updates or cache changes.
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
   * Builds a {@link FileHandle} spreading the metadata plus a `stream` that
   * fetches the blob bytes on demand. The stream yields nothing when the file
   * has been deleted or the signal is already aborted, re-checks the signal
   * after the fetch, and surfaces Drive read errors to the stream consumer.
   * @param meta - Metadata to expose on the handle.
   * @returns The handle.
   * @throws Never synchronously.
   */
  private makeHandle(meta: DriveFileMeta): FileHandle {
    const drive = this.drive;
    const slots = this.slots;
    return {
      ...meta,
      /**
       * Fetches the blob's bytes on demand (a single Drive read).
       * @param signal - Abort signal honoured before and after the fetch.
       * @yields The blob bytes, or nothing when the file is gone or the signal
       *   is already aborted.
       * @throws Propagates Drive read errors.
       */
      async *stream(signal?: AbortSignal): AsyncIterable<Uint8Array> {
        const slot = slots.get(meta.id);
        if (slot === undefined || signal?.aborted) return;
        const bytes = await drive.readBytes(slot.dataFileId);
        if (signal?.aborted) return;
        yield bytes;
      },
    };
  }

  /**
   * Stores (or replaces) a file and its metadata sidecar in Drive. When `name`
   * is given the file is upserted by name (+ namespace), matching the OPFS
   * store's semantics — id and `createdAt` are preserved and a fresh `version`
   * is minted; otherwise a new UUID id is used. Buffers the whole blob in
   * memory first.
   * @param name - File name/id; `undefined` means anonymous (fresh UUID id).
   * @param mimeType - MIME type of the content.
   * @param data - Byte chunks making up the file.
   * @param opts - Optional namespace/session/message linkage.
   * @returns The handle for the stored file.
   * @throws When the Drive uploads fail, the folder cannot be resolved, or
   *   `data` throws while being buffered.
   */
  async put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean },
  ): Promise<FileHandle> {
    await this.ensureLoaded();
    const bytes = await collect(data);
    return this.lock(async () => {
      const folder = await this.folderId;

      // Upsert by name (+ namespace) when a name is given, matching the OPFS store's semantics.
      const existing = name !== undefined ? this.findByName(name, meta?.namespace) : undefined;

      const id        = existing?.meta.id ?? crypto.randomUUID();
      const createdAt = existing?.meta.createdAt ?? new Date().toISOString();
      const fileMeta: DriveFileMeta = {
        id,
        version:   crypto.randomUUID(),
        name:      name ?? id,
        mimeType,
        size:      bytes.byteLength,
        createdAt,
        ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
        ...(meta?.messageId !== undefined ? { messageId: meta.messageId } : {}),
        ...(meta?.namespace !== undefined ? { namespace: meta.namespace } : {}),
        ...(meta?.allowed   !== undefined ? { allowed:   meta.allowed   } : {}),
      };

      const dataBody = new Blob([bytes], { type: mimeType });
      const metaBody = JSON.stringify(fileMeta);

      let dataFileId: string;
      let metaFileId: string;
      if (existing !== undefined) {
        await this.drive.updateFile(existing.dataFileId, dataBody, mimeType);
        await this.drive.updateFile(existing.metaFileId, metaBody, JSON_MIME);
        dataFileId = existing.dataFileId;
        metaFileId = existing.metaFileId;
      } else {
        dataFileId = await this.drive.createFile(`${id}${DATA_SUFFIX}`, folder, dataBody, mimeType);
        metaFileId = await this.drive.createFile(`${id}${META_SUFFIX}`, folder, metaBody, JSON_MIME);
      }
      this.slots.set(id, { meta: fileMeta, dataFileId, metaFileId });
      return this.makeHandle(fileMeta);
    });
  }

  /**
   * Resolves a file handle by id from the cached index.
   * @param id - File identifier.
   * @returns The handle, or null when not found.
   * @throws Propagates index-load errors (see
   *   {@link DriveFileStore.ensureLoaded}).
   */
  async get(id: string): Promise<FileHandle | null> {
    await this.ensureLoaded();
    const slot = this.slots.get(id);
    return slot !== undefined ? this.makeHandle(slot.meta) : null;
  }

  /**
   * Resolves a file handle by name within an optional namespace.
   * @param name - File name.
   * @param namespace - Constrains the match when given; undefined matches any
   *   namespace.
   * @returns The handle, or null when not found.
   * @throws Propagates index-load errors.
   */
  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    await this.ensureLoaded();
    const slot = this.findByName(name, namespace);
    return slot !== undefined ? this.makeHandle(slot.meta) : null;
  }

  /**
   * Linear scan of the cached slots for an exact name (and namespace, when
   * given).
   * @param name - File name to match exactly.
   * @param namespace - Constrain the match when given; undefined matches any.
   * @returns The matching slot, or undefined.
   * @throws Never.
   */
  private findByName(name: string, namespace?: string): Slot | undefined {
    for (const slot of this.slots.values()) {
      if (slot.meta.name === name && (namespace === undefined || slot.meta.namespace === namespace)) return slot;
    }
    return undefined;
  }

  /**
   * Deletes a file's blob and sidecar from Drive and drops its slot. The two
   * deletions run via `Promise.allSettled`, so one failure does not block the
   * other and deletion failures are swallowed (the slot is removed
   * regardless); a 404 is already tolerated by
   * {@link DriveClient.deleteFile}.
   * @param id - File identifier.
   * @returns Resolves once both deletions have settled.
   * @throws Propagates index-load errors.
   */
  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    await this.lock(async () => {
      const slot = this.slots.get(id);
      if (slot === undefined) return;
      await Promise.allSettled([
        this.drive.deleteFile(slot.dataFileId),
        this.drive.deleteFile(slot.metaFileId),
      ]);
      this.slots.delete(id);
    });
  }

  /**
   * Streams handles for all cached files matching the filter, in slot
   * (insertion) order. Filter fields left undefined impose no constraint;
   * `mimeType` matches by prefix and the date bounds compare ISO strings.
   * @param filter - Optional criteria on namespace, session, MIME prefix or
   *   creation dates.
   * @yields Matching {@link FileHandle}s.
   * @throws Propagates index-load errors.
   */
  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    await this.ensureLoaded();
    for (const slot of this.slots.values()) {
      const m = slot.meta;
      if (filter?.namespace     && m.namespace !== filter.namespace)            continue;
      if (filter?.sessionId     && m.sessionId !== filter.sessionId)            continue;
      if (filter?.mimeType      && !m.mimeType.startsWith(filter.mimeType))     continue;
      if (filter?.createdAfter  && m.createdAt < filter.createdAfter)           continue;
      if (filter?.createdBefore && m.createdAt > filter.createdBefore)          continue;
      yield this.makeHandle(m);
    }
  }

  /**
   * Stores a temporary (root-namespaced) file: delegates to
   * {@link DriveFileStore.put} with no namespace/session linkage.
   * @param name - File name.
   * @param mimeType - MIME type of the content.
   * @param data - Byte chunks making up the file.
   * @returns The handle for the stored file.
   * @throws Under the same conditions as {@link DriveFileStore.put}.
   */
  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data);
  }

  /**
   * Drive has no cheap push change-feed, so this yields nothing and resolves
   * once the signal aborts (same as the OPFS store). Without a signal it
   * completes immediately.
   * @param signal - Abort signal ending the stream.
   * @yields Nothing.
   * @throws Never.
   */
  async *watch(signal?: AbortSignal): AsyncIterable<FileEvent> {
    if (signal === undefined || signal.aborted) return;
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); });
  }
}
