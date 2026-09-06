import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileEvent, FileFilter, FileHandle, FileMetaData, FileStore, MimeType } from '@matatbread/matbot-core';

/**
 * Semantic metadata and the committed immutable payload version.
 *
 * Serialized as the `<id>.meta.json` manifest next to the payload. Optional
 * fields double as layout discriminators: `dataFile` marks an explicit
 * immutable blob, `id` marks the legacy anonymous layout, and their absence
 * means a legacy named entry whose payload path mirrors the id.
 */
interface FileMeta {
  mimeType:   MimeType;
  sessionId?: string;
  messageId?: string;
  namespace?: string;
  allowed?:   boolean;
  // New entries reference an immutable blob; older anonymous entries use .data.
  // Absent on legacy named entries, where the payload path mirrors the id.
  dataFile?:  string;
  // Present only in legacy entries written before the named-file refactor.
  // Used to detect the legacy layout: data was at id + '.data'.
  id?:        string;
  version?:   string;
  createdAt?: string;
}

const VERSION_DIR = '.cortex-versions';
const VERSION_GRACE_MS = 24 * 60 * 60 * 1_000;
const mutationLocks = new Map<string, Promise<void>>();

/**
 * Resolves the on-disk payload path for an entry across all supported layouts:
 * an explicit immutable blob (`dataFile`), a legacy anonymous `id + '.data'`
 * payload, or a legacy named entry whose payload path mirrors the id.
 *
 * @param dir Root directory of the store.
 * @param id Logical file id.
 * @param meta Parsed manifest for the entry.
 * @returns The joined payload path; existence is not checked.
 */
function resolveDataPath(dir: string, id: string, meta: FileMeta): string {
  if (meta.dataFile !== undefined) return path.join(dir, meta.dataFile); // explicit payload
  if (meta.id       !== undefined) return path.join(dir, id + '.data'); // legacy anonymous
  return path.join(dir, id);                                             // legacy named
}

/**
 * Builds the metadata manifest path for an entry.
 *
 * @param dir Root directory of the store.
 * @param id Logical file id.
 * @returns The `<id>.meta.json` manifest path.
 */
function metaFilePath(dir: string, id: string): string {
  return path.join(dir, `${id}.meta.json`);
}

/**
 * Builds a {@link FileHandle} for an entry from its parsed manifest, statting
 * both the payload and the manifest. Version and creation time fall back to
 * filesystem metadata for legacy entries; optional annotations are copied only
 * when present.
 *
 * @param id Logical file id, also used as the handle's `name`.
 * @param meta Parsed manifest for the entry.
 * @param dir Root directory of the store.
 * @returns A handle exposing the entry's metadata plus a `stream` reader over its payload.
 * @throws Error - If the payload or the manifest cannot be stat'ed (e.g. the payload was deleted).
 */
async function makeHandle(id: string, meta: FileMeta, dir: string): Promise<FileHandle> {
  const dp = resolveDataPath(dir, id, meta);
  const mp = metaFilePath(dir, id);
  const [ds, ms] = await Promise.all([stat(dp), stat(mp)]);
  const born = ms.birthtimeMs > 0 ? ms.birthtimeMs : ms.ctimeMs;
  const fileMetaData: FileMetaData = {
    id,
    name:      id,
    version:   meta.version ?? ds.mtimeMs.toString(),
    size:      ds.size,
    createdAt: meta.createdAt ?? new Date(born).toISOString(),
    mimeType:  meta.mimeType,
    ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
    ...(meta.messageId !== undefined ? { messageId: meta.messageId } : {}),
    ...(meta.namespace !== undefined ? { namespace: meta.namespace } : {}),
    ...(meta.allowed   !== undefined ? { allowed:   meta.allowed   } : {}),
  };
  return {
    ...fileMetaData,
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array> {
      return nodeStreamToAsyncIterable(dp, signal);
    },
  };
}

/**
 * Adapts a Node file read stream into an async byte-chunk iterable.
 *
 * @param filePath File to stream.
 * @param signal Optional abort signal; aborting destroys the underlying stream.
 * @returns An async iterable of `Uint8Array` chunks in file order.
 * @throws Error - Propagates stream failures, including a missing or unreadable file surfacing on first iteration.
 */
async function *nodeStreamToAsyncIterable(
  filePath: string,
  signal?:  AbortSignal,
): AsyncIterable<Uint8Array> {
  const rs = createReadStream(filePath);
  signal?.addEventListener('abort', () => rs.destroy(), { once: true });
  for await (const chunk of rs) {
    yield chunk as Uint8Array;
  }
}

/**
 * Node FileStore with immutable version blobs and an atomically replaced metadata
 * manifest as the commit point. Logical names/ids and legacy layouts remain readable.
 */
export class FilesystemFileStore implements FileStore {
  private readonly dir: string;
  private nextGcAt = 0;
  /**
   * Creates a store rooted at `dir`; no I/O happens until the first operation.
   *
   * @param dir Root directory for stored files (created lazily).
   */
  constructor(dir: string) { this.dir = dir; }

  /**
   * Creates the store root and the version-blob directory if missing, and
   * prunes unreferenced version blobs at most once per hour; pruning failures
   * are logged and retried on a later call.
   *
   * @returns Nothing.
   * @throws Error - If directory creation fails.
   */
  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(path.join(this.dir, VERSION_DIR), { recursive: true });
    if (Date.now() >= this.nextGcAt) {
      this.nextGcAt = Date.now() + 60 * 60 * 1_000;
      await this.pruneVersions().catch(error => console.warn(`[files] version cleanup deferred: ${String(error)}`));
    }
  }

  /**
   * Runs an operation serialized per entry, across every store instance in the
   * process. Locks are keyed by resolved store directory and lower-cased id and
   * chain onto a shared promise tail, which self-cleans when it is still the
   * chain's end.
   *
   * @typeParam T - Result type of the serialized operation.
   * @param id Logical file id to lock (case-insensitive).
   * @param operation Async work to run while holding the entry's lock.
   * @returns The result of `operation`.
   * @throws `Error` - Whatever `operation` throws, after the lock has been released.
   */
  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = `${path.resolve(this.dir).toLocaleLowerCase()}\0${id.toLocaleLowerCase()}`;
    const pending = (mutationLocks.get(key) ?? Promise.resolve()).then(operation);
    const tail = pending.then(() => {}, () => {});
    mutationLocks.set(key, tail);
    try { return await pending; }
    finally { if (mutationLocks.get(key) === tail) mutationLocks.delete(key); }
  }

  /**
   * Deletes unreferenced version blobs older than the 24-hour grace period,
   * at most 100 per run. A blob counts as referenced only if a scanned manifest
   * names it, so an incomplete metadata scan can never authorize deletion;
   * in-progress `.tmp` blobs become eligible once stale.
   *
   * @returns Nothing.
   * @throws SyntaxError - If a manifest contains invalid JSON.
   * @throws Error - If a manifest cannot be read, `stat` fails with anything other than ENOENT, or blob deletion fails.
   */
  private async pruneVersions(): Promise<void> {
    const referenced = new Set<string>();
    // An incomplete metadata scan must never become permission to delete blobs.
    for await (const file of this.findMetaFiles(this.dir)) {
      const meta = JSON.parse(await readFile(file, 'utf8')) as FileMeta;
      if (meta.dataFile) referenced.add(path.resolve(this.dir, meta.dataFile));
    }
    const versions = path.join(this.dir, VERSION_DIR);
    let removed = 0;
    for (const name of await readdir(versions)) {
      if (!/^[0-9a-f-]+\.blob(?:\.[0-9a-f-]+\.tmp)?$/i.test(name)) continue;
      const file = path.resolve(versions, name);
      if (referenced.has(file)) continue;
      const info = await stat(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (!info?.isFile() || info.mtimeMs >= Date.now() - VERSION_GRACE_MS) continue;
      await rm(file, { force: true });
      if (++removed >= 100) break;
    }
  }

  /**
   * Streams `data` into a temporary sibling file, fsyncs it, and atomically
   * renames it over `targetPath`. Each chunk is written in full via a
   * partial-write loop; a zero-byte write aborts as a stall. On failure the
   * temp file is closed and removed before the error is re-thrown.
   *
   * @param targetPath Final destination path of the payload.
   * @param data Chunked content to write, in order.
   * @returns Nothing.
   * @throws Error - If a write makes no progress or any filesystem step fails.
   */
  private async writeData(targetPath: string, data: AsyncIterable<Uint8Array>): Promise<void> {
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
    const fh = await open(tmpPath, 'w');
    try {
      for await (const chunk of data) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await fh.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) throw new Error('File write made no progress');
          offset += bytesWritten;
        }
      }
      await fh.sync();
      await fh.close();
      await rename(tmpPath, targetPath);
    } catch (err) {
      await fh.close().catch(() => {});
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Reads and parses an entry's metadata manifest without interpreting layouts.
   *
   * @param id Logical file id.
   * @returns The parsed {@link FileMeta}, or `null` when no manifest exists (ENOENT).
   * @throws Error - If the manifest cannot be read or parsed for any other reason, wrapping the underlying cause.
   */
  private async getRawMeta(id: string): Promise<FileMeta | null> {
    try {
      return JSON.parse(await readFile(metaFilePath(this.dir, id), 'utf8')) as FileMeta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Cannot read metadata for stored file ${id}: ${String(error)}`, { cause: error });
    }
  }

  /**
   * Writes a file, upserting by name when provided.
   *
   * The payload lands in a fresh immutable version blob and is committed by
   * atomically renaming a new manifest over the previous one; mutations for
   * the same id are serialized through the per-entry mutation lock. The
   * superseded blob is retained for existing readers until the grace-period prune.
   * @param name File name (used as the id); omit for an anonymous UUID entry.
   * @param mimeType MIME type stored alongside the file.
   * @param data Chunked content to stream to disk.
   * @param opts Optional session/message/namespace/allowed annotations.
   * @returns A handle for reading the file's metadata and content.
   * @throws Error - If `name` resolves into the reserved `.cortex-versions` directory,
   *   or if writing the payload or committing the manifest fails (partial artifacts
   *   are removed best-effort before re-throwing).
   */
  async put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    opts?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean },
  ): Promise<FileHandle> {
    const id = name ?? randomUUID();
    if (id.split(/[\\/]/)[0] === VERSION_DIR) throw new Error('Reserved file-store name');
    return this.withLock(id, async () => {
      await this.ensureDir();
      const previous = await this.get(id);
      const extras = {
        ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
        ...(opts?.namespace !== undefined ? { namespace: opts.namespace } : {}),
        ...(opts?.allowed   !== undefined ? { allowed:   opts.allowed   } : {}),
      };

      const version = randomUUID();
      const dataFile = path.join(VERSION_DIR, `${version}.blob`);
      const dp = path.join(this.dir, dataFile);
      const mp = metaFilePath(this.dir, id);
      const tmp = `${mp}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(mp), { recursive: true });
      const meta: FileMeta = { mimeType, dataFile, version, createdAt: previous?.createdAt ?? new Date().toISOString(), ...extras };
      try {
        await this.writeData(dp, data);
        await writeFile(tmp, JSON.stringify(meta));
        await rename(tmp, mp);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        await rm(dp, { force: true }).catch(() => {});
        throw error;
      }
      // Older version blobs are retained through a grace period for existing readers.
      return makeHandle(id, meta, this.dir);
    });
  }

  /**
   * Fetches a file handle by id.
   * @param id File identifier.
   * @returns The handle, or `null` if no metadata manifest exists.
   * @throws If committed metadata or payload data cannot be read.
   */
  async get(id: string): Promise<FileHandle | null> {
    const meta = await this.getRawMeta(id);
    if (!meta) return null;
    try {
      return await makeHandle(id, meta, this.dir);
    } catch (error) {
      throw new Error(`Cannot read data for stored file ${id}: ${String(error)}`, { cause: error });
    }
  }

  /**
   * Looks up the first file whose name matches, optionally within a namespace.
   *
   * Uses a direct O(1) lookup for named entries (id === name) and falls back to
   * a full filtered scan for legacy UUID-based entries.
   * @param name File name to find.
   * @param namespace Optional namespace restriction.
   * @returns The matching handle, or `null` when no entry matches.
   * @throws Error - If metadata for a scanned entry cannot be read (via {@link FilesystemFileStore.get}).
   */
  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    // Direct O(1) lookup for named files (id === name).
    const direct = await this.get(name);
    if (direct !== null && (namespace === undefined || direct.namespace === namespace)) return direct;
    // Fall back to full scan for legacy UUID-based entries.
    for await (const handle of this.list(namespace !== undefined ? { namespace } : {})) {
      if (handle.name === name) return handle;
    }
    return null;
  }

  /**
   * Removes a file's data and metadata files.
   * @param id File identifier.
   * @returns Nothing. The manifest is deleted first and legacy payloads only
   *   after that commit, so a failure cannot resurrect the entry; version blobs
   *   are left to the grace-period prune.
   * @throws Error - If removal fails for a reason other than a missing file, after the entry's lock is released.
   */
  async delete(id: string): Promise<void> {
    await this.withLock(id, async () => {
      const meta = await this.getRawMeta(id);
      await rm(metaFilePath(this.dir, id), { force: true });
      // Version blobs are reclaimed after grace; remove legacy payloads only after
      // the manifest deletion has committed. Failure cannot resurrect the entry.
      if (meta && !meta.version) await rm(resolveDataPath(this.dir, id, meta), { force: true });
    });
  }

  /**
   * Recursively lists stored files matching the filter.
   *
   * Walks `<id>.meta.json` manifests depth-first (skipping the version-blob
   * directory) and resolves each through {@link FilesystemFileStore.get}.
   * @param filter Optional namespace/session/MIME/date filters; every supplied field must match (exact `namespace`/`sessionId`, MIME-type prefix, inclusive ISO-date bounds).
   * @returns An async iterable of matching file handles in depth-first directory order.
   * @throws Error - If directory creation or metadata reading fails.
   */
  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    await this.ensureDir();
    for await (const mfp of this.findMetaFiles(this.dir)) {
      const rel = path.relative(this.dir, mfp);
      const id  = rel.slice(0, -'.meta.json'.length);
      const fh  = await this.get(id);
      if (!fh) continue;
      if (filter?.namespace     && fh.namespace  !== filter.namespace)                   continue;
      if (filter?.sessionId     && fh.sessionId  !== filter.sessionId)                   continue;
      if (filter?.mimeType      && !fh.mimeType.startsWith(filter.mimeType))             continue;
      if (filter?.createdAfter  && fh.createdAt  <  filter.createdAfter)                 continue;
      if (filter?.createdBefore && fh.createdAt  >  filter.createdBefore)                continue;
      yield fh;
    }
  }

  /**
   * Recursively yields `<id>.meta.json` manifest paths, depth-first, skipping
   * the version-blob directory. A missing directory ends the walk quietly.
   *
   * @param dir Directory to scan.
   * @returns An async iterable of manifest paths, parents before children.
   * @throws Error - Re-throws `readdir` failures other than ENOENT.
   */
  private async *findMetaFiles(dir: string): AsyncIterable<string> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === VERSION_DIR) continue;
        yield* this.findMetaFiles(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.meta.json')) {
        yield path.join(dir, entry.name);
      }
    }
  }

  /**
   * Writes a temporary file with no session/message/namespace annotations.
   * @param name File name.
   * @param mimeType MIME type of the file.
   * @param data Chunked content to store.
   * @returns A handle for the stored temp file.
   * @throws Error - Under the same conditions as {@link FilesystemFileStore.put}.
   */
  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data);
  }

  /**
   * Watches the store directory and yields debounced change events.
   * @param signal Abort signal that ends the watch.
   * @returns An async iterable of {@link FileEvent}s describing changed fields.
   * @throws Re-throws watcher or change-handler errors before terminating.
   */
  async *watch(signal?: AbortSignal): AsyncIterable<FileEvent> {
    // Storage backends construct their FileStore eagerly but create this directory lazily. The WebUI
    // starts watching during boot, before the first file write, so watch() must establish its own
    // prerequisite instead of crashing a fresh workspace with ENOENT.
    await this.ensureDir();

    const queue:     FileEvent[]                             = [];
    const prevMeta   = new Map<string, FileMetaData>();
    const debounces  = new Map<string, ReturnType<typeof setTimeout>>();
    let   notify:    (() => void) | undefined;
    let   done       = false;
    let   failure:   unknown;

    /**
     * Resolves the pending wait promise when the consumer is parked on it.
     */
    const wake = (): void => { const fn = notify; notify = undefined; fn?.(); };

    /**
     * Re-reads a changed file, queues a diff event against its previous snapshot,
     * and wakes the consumer; a vanished file instead drops its baseline without
     * queueing an event.
     *
     * @param id Logical file id reported as changed by the watcher.
     * @returns Nothing.
     * @throws Error - Rejects when the handle cannot be read; the caller records the rejection as the watch's terminal failure.
     */
    const handleChange = async (id: string): Promise<void> => {
      const handle = await this.get(id);
      if (!handle) { prevMeta.delete(id); return; }
      queue.push(buildFileEvent(handle, prevMeta.get(id)));
      prevMeta.set(id, metaFromHandle(handle));
      wake();
    };

    const watcher = watch(this.dir, { recursive: true }, (_, filename) => {
      if (typeof filename !== 'string') return;
      if (filename.split(/[\\/]/)[0] === VERSION_DIR || filename.endsWith('.tmp')) return;
      const id = filename.endsWith('.meta.json') ? filename.slice(0, -'.meta.json'.length)
        : filename.endsWith('.data') ? filename.slice(0, -'.data'.length) : filename;
      const t  = debounces.get(id);
      if (t !== undefined) clearTimeout(t);
      debounces.set(id, setTimeout(() => {
        debounces.delete(id);
        void handleChange(id).catch(error => { failure = error; done = true; wake(); });
      }, 50));
    });
    watcher.on('error', error => { failure = error; done = true; wake(); });

    /**
     * Ends the watch on abort: stops the watcher, closes the loop, and wakes the consumer.
     */
    const onAbort = (): void => { done = true; watcher.close(); wake(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      while (!done) {
        while (queue.length > 0) yield queue.shift()!;
        if (done) {
          if (failure !== undefined) throw failure;
          break;
        }
        await new Promise<void>(r => { notify = r; });
      }
    } finally {
      watcher.close();
      signal?.removeEventListener('abort', onAbort);
      for (const t of debounces.values()) clearTimeout(t);
    }
  }
}

// ── FileEvent helpers ─────────────────────────────────────────────────────────

const META_KEYS: ReadonlyArray<keyof FileMetaData> = [
  'id', 'version', 'name', 'mimeType', 'size', 'createdAt',
  'sessionId', 'messageId', 'namespace', 'allowed',
];

/**
 * Projects a {@link FileHandle} onto the plain {@link FileMetaData} snapshot used
 * as the change-detection baseline; absent optional annotations stay absent.
 *
 * @param h Handle to project.
 * @returns A metadata snapshot with all defined fields copied.
 */
function metaFromHandle(h: FileHandle): FileMetaData {
  return {
    id:        h.id,
    version:   h.version,
    name:      h.name,
    mimeType:  h.mimeType,
    size:      h.size,
    createdAt: h.createdAt,
    ...(h.sessionId !== undefined ? { sessionId: h.sessionId } : {}),
    ...(h.messageId !== undefined ? { messageId: h.messageId } : {}),
    ...(h.namespace !== undefined ? { namespace: h.namespace } : {}),
    ...(h.allowed   !== undefined ? { allowed:   h.allowed   } : {}),
  };
}

/**
 * Builds a change event by diffing the handle's current metadata against the
 * previous snapshot; the first sighting of an id reports every key in
 * {@link META_KEYS} as changed.
 *
 * @param handle Current handle for the changed file.
 * @param prev Previous metadata snapshot, or `undefined` when the file was first seen.
 * @returns A {@link FileEvent} carrying the current metadata plus the `changed` key list.
 */
function buildFileEvent(handle: FileHandle, prev: FileMetaData | undefined): FileEvent {
  const meta = metaFromHandle(handle);
  const a    = meta as unknown as Record<string, unknown>;
  const b    = prev as unknown as Record<string, unknown> | undefined;
  const changed = b === undefined
    ? [...META_KEYS]
    : META_KEYS.filter(k => a[k] !== b[k]);
  return { ...meta, changed };
}
