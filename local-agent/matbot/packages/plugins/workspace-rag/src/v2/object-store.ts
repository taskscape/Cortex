import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { RagV2SourceObject } from './types.js';

const DEFAULT_MAX_RANGE_BYTES = 8 * 1024 * 1024;

/**
 * Guards against path traversal outside the store root.
 * @param root - Root directory the candidate must stay within.
 * @param candidate - Path to check.
 * @returns Nothing.
 * @throws Error - When `candidate` lies outside `root` and is not the root itself.
 */
function assertInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    if (candidate !== root) throw new Error(`Workspace RAG V2 object path escapes its root: ${candidate}`);
  }
}

/**
 * Checks whether a path is accessible.
 * @param filePath - Path to test.
 * @returns True when `filePath` can be accessed; false on any access error.
 * @throws Never.
 */
async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Appends (line, byteOffset) entries to a content-addressed line index file.
 */
export class RagV2LineIndexWriter {
  private readonly stream: ReturnType<typeof createWriteStream>;
  private closed = false;
  private streamError: Error | undefined;

  /**
   * Opens a fresh index file for writing.
   *
   * The file is created exclusively (`wx`), so a pre-existing destination
   * fails asynchronously rather than here; underlying stream failures are
   * captured and surface from {@link RagV2LineIndexWriter.add} or
   * {@link RagV2LineIndexWriter.close}.
   * @param filePath - Destination path of the line-index file.
   * @throws Never.
   */
  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { flags: 'wx', encoding: 'utf8' });
    // A standing listener keeps a mid-stream failure from crashing the
    // process; the error is surfaced from add()/close() instead.
    this.stream.on('error', error => {
      this.streamError ??= error instanceof Error ? error : new Error(String(error));
    });
  }

  /**
   * Appends one line entry.
   * @param line - 1-based line number.
   * @param byteOffset - Byte offset of the line start in the source object.
   * @returns Resolves once the entry is accepted by the stream (awaiting drain under backpressure).
   * @throws Error - When the writer is already closed or the underlying stream has failed.
   */
  async add(line: number, byteOffset: number): Promise<void> {
    if (this.closed) throw new Error('Workspace RAG V2 line index is already closed.');
    if (this.streamError) throw this.streamError;
    if (!this.stream.write(`${line}\t${byteOffset}\n`)) {
      await new Promise<void>((resolve, reject) => {
        this.stream.once('drain', resolve);
        this.stream.once('error', reject);
      });
      if (this.streamError) throw this.streamError;
    }
  }

  /**
   * Ends the stream and waits for it to flush and finish; a second call
   * resolves immediately or rethrows the stored stream error.
   * @returns Resolves once the file is fully written.
   * @throws Error - When the stream failed at any point; the captured stream error is rethrown.
   */
  async close(): Promise<void> {
    if (this.closed) {
      if (this.streamError) throw this.streamError;
      return;
    }
    this.closed = true;
    this.stream.end();
    try {
      await finished(this.stream);
    } catch (error) {
      throw this.streamError ?? (error instanceof Error ? error : new Error(String(error)));
    }
    if (this.streamError) throw this.streamError;
  }
}

/**
 * Content-addressed on-disk store of source objects plus optional line
 * indexes, enabling byte-range reads without loading whole files.
 */
export class RagV2ObjectStore {
  readonly root: string;
  readonly retentionMode: 'managed' | 'external_immutable' | 'manifest_only';
  private readonly maxRangeBytes: number;
  private readonly externalRoot: string | undefined;

  /**
   * Resolves and records the store configuration without touching disk.
   * @param root - Managed store root; resolved to an absolute path.
   * @param maxRangeBytes - Default byte cap for single range or line reads; defaults to 8 MiB.
   * @param retentionMode - Whether bytes are managed here, external and immutable, or manifest-only; defaults to `managed`.
   * @param externalRoot - Root holding externally managed objects (read source for `external_immutable`); resolved to an absolute path.
   * @throws Never.
   */
  constructor(
    root: string,
    maxRangeBytes = DEFAULT_MAX_RANGE_BYTES,
    retentionMode: 'managed' | 'external_immutable' | 'manifest_only' = 'managed',
    externalRoot?: string,
  ) {
    this.root = path.resolve(root);
    this.maxRangeBytes = maxRangeBytes;
    this.retentionMode = retentionMode;
    this.externalRoot = externalRoot ? path.resolve(externalRoot) : undefined;
  }

  /**
   * Creates the store's directory layout.
   *
   * Creates `objects/sha256` and `staging` beneath the root as needed; safe
   * to call repeatedly.
   * @returns Resolves once the directories exist.
   * @throws Error - When the directories cannot be created (fs errors propagate).
   */
  async initialize(): Promise<void> {
    await mkdir(path.join(this.root, 'objects', 'sha256'), { recursive: true });
    await mkdir(path.join(this.root, 'staging'), { recursive: true });
  }

  /**
   * Stores a file by content hash; identical content is deduplicated.
   *
   * Managed mode copies the source through a staging file and atomically
   * renames it into the hash-addressed layout, rejecting sources that change
   * (size or mtime) mid-copy. `external_immutable` mode verifies the object
   * already exists under the external root with the expected size.
   * `manifest_only` mode writes only a manifest recording the original path;
   * historical bytes are not guaranteed.
   * @param sourcePath - File to ingest; must exist and stay unchanged for the duration.
   * @param signal - Optional signal cancelling the copy or hash; the abort reason becomes the rejection.
   * @param onChunk - Optional async progress callback invoked per chunk with its byte length; the copy waits for each call.
   * @returns Content-addressed reference with hash, object path, line-index path, and byte length.
   * @throws Error - When the source is not a file, changes while being copied, or an external immutable object is missing or has the wrong size; fs and abort errors propagate.
   */
  async putFile(
    sourcePath: string,
    signal?: AbortSignal,
    onChunk?: (bytes: number) => Promise<void>,
  ): Promise<RagV2SourceObject> {
    await this.initialize();
    const before = await stat(sourcePath);
    if (!before.isFile()) throw new Error(`Workspace RAG V2 source is not a file: ${sourcePath}`);
    if (this.retentionMode !== 'managed') {
      const source = await this.hashStableSource(sourcePath, signal, onChunk);
      if (this.retentionMode === 'external_immutable') {
        const objectPath = this.contentPath(this.externalRoot!, source.contentSha256);
        const external = await stat(objectPath).catch(() => undefined);
        if (!external?.isFile() || external.size !== source.byteLength) {
          throw new Error(
            `External immutable source object is missing or has the wrong size: ${objectPath}`,
          );
        }
        return {
          ...source,
          objectPath,
          lineIndexPath: this.lineIndexPath(source.contentSha256),
        };
      }
      const manifestPath = this.manifestPath(source.contentSha256);
      await mkdir(path.dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, JSON.stringify({
        sourcePath: path.resolve(sourcePath),
        contentSha256: source.contentSha256,
        byteLength: source.byteLength,
        warning: 'Historical bytes are not guaranteed in manifest_only mode.',
      }), { encoding: 'utf8', flag: 'wx' }).catch(async error => {
        if (!await exists(manifestPath)) throw error;
      });
      return {
        ...source,
        objectPath: this.objectPath(source.contentSha256),
        lineIndexPath: this.lineIndexPath(source.contentSha256),
      };
    }
    const stagingPath = path.join(this.root, 'staging', `${randomUUID()}.source`);
    assertInsideRoot(this.root, stagingPath);
    const hash = createHash('sha256');
    let byteLength = 0;
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (signal?.aborted) {
          callback(signal.reason instanceof Error ? signal.reason : new Error('Workspace RAG V2 object copy cancelled.'));
          return;
        }
        void Promise.resolve(onChunk?.(chunk.length)).then(() => {
          hash.update(chunk);
          byteLength += chunk.length;
          callback(null, chunk);
        }, error => callback(error instanceof Error ? error : new Error(String(error))));
      },
    });
    try {
      await pipeline(
        createReadStream(sourcePath, { highWaterMark: 1024 * 1024 }),
        hasher,
        createWriteStream(stagingPath, { flags: 'wx' }),
        { signal },
      );
      const after = await stat(sourcePath);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`Workspace RAG V2 source changed while it was copied: ${sourcePath}`);
      }
      const contentSha256 = hash.digest('hex');
      const objectPath = this.objectPath(contentSha256);
      const lineIndexPath = this.lineIndexPath(contentSha256);
      await mkdir(path.dirname(objectPath), { recursive: true });
      if (await exists(objectPath)) {
        await rm(stagingPath, { force: true });
      } else {
        try {
          await rename(stagingPath, objectPath);
        } catch (error) {
          if (await exists(objectPath)) await rm(stagingPath, { force: true });
          else throw error;
        }
      }
      return { contentSha256, objectPath, lineIndexPath, byteLength };
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Opens a line-index writer for an existing object.
   * @param contentSha256 - Content hash of the object.
   * @returns A writer, or undefined when an index already exists.
   * @throws Error - When the line-index directory cannot be created.
   */
  async createLineIndexWriter(contentSha256: string): Promise<RagV2LineIndexWriter | undefined> {
    const finalPath = this.lineIndexPath(contentSha256);
    if (await exists(finalPath)) return undefined;
    await mkdir(path.dirname(finalPath), { recursive: true });
    const stagingPath = `${finalPath}.${randomUUID()}.tmp`;
    const writer = new RagV2LineIndexWriter(stagingPath);
    const originalClose = writer.close.bind(writer);
    writer.close = async () => {
      await originalClose();
      try {
        await rename(stagingPath, finalPath);
      } catch (error) {
        if (await exists(finalPath)) await rm(stagingPath, { force: true });
        else throw error;
      }
    };
    return writer;
  }

  /**
   * Reads a byte range out of a stored object.
   * @param contentSha256 - Hash of the stored object.
   * @param startByte - Inclusive 0-based start offset in bytes.
   * @param endByte - Exclusive end offset in bytes; must be greater than `startByte`.
   * @param maxBytes - Optional per-call cap in bytes; the effective cap is the smaller of this and the store maximum.
   * @returns A buffer of exactly `endByte - startByte` bytes.
   * @throws Error - When the offsets are not a valid increasing integer pair, the range exceeds the cap, or the file ends early; fs errors propagate.
   */
  async fetchRange(
    contentSha256: string,
    startByte: number,
    endByte: number,
    maxBytes = this.maxRangeBytes,
  ): Promise<Buffer> {
    if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte) || startByte < 0 || endByte <= startByte) {
      throw new Error('Workspace RAG V2 range must use non-negative, increasing integer byte offsets.');
    }
    const length = endByte - startByte;
    if (length > Math.min(maxBytes, this.maxRangeBytes)) {
      throw new Error(`Workspace RAG V2 range exceeds the ${Math.min(maxBytes, this.maxRangeBytes)} byte limit.`);
    }
    const objectPath = await this.sourcePath(contentSha256);
    const handle = await open(objectPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, startByte);
      if (bytesRead !== length) {
        throw new Error(`Workspace RAG V2 range ended early: expected ${length} bytes, read ${bytesRead}.`);
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads a 1-based inclusive line range via the line index.
   * @param contentSha256 - Hash of the stored object.
   * @param startLine - First line to return (1-based, inclusive).
   * @param endLine - Last line to return (inclusive, at least `startLine`).
   * @param maxBytes - Optional per-call cap in bytes; the effective cap is the smaller of this and the store maximum.
   * @returns The selected lines joined with their newlines plus the absolute covered byte range, falling back to the checkpoint offset when nothing matched.
   * @throws Error - When the line numbers are invalid or the result exceeds the byte cap; source-resolution and fs errors propagate.
   */
  async fetchLines(
    contentSha256: string,
    startLine: number,
    endLine: number,
    maxBytes = this.maxRangeBytes,
  ): Promise<{ text: string; startByte: number; endByte: number }> {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new Error('Workspace RAG V2 line range must use positive, increasing integer line numbers.');
    }
    const checkpoints = await this.readLineIndex(contentSha256);
    let checkpoint = { line: 1, byte: 0 };
    for (const candidate of checkpoints) {
      if (candidate.line > startLine) break;
      checkpoint = candidate;
    }
    const chunks: Buffer[] = [];
    let buffered = Buffer.alloc(0);
    let currentLine = checkpoint.line;
    let selectedStartByte: number | undefined;
    let selectedEndByte: number | undefined;
    let selectedBytes = 0;
    let absoluteByte = checkpoint.byte;
    const stream = createReadStream(await this.sourcePath(contentSha256), {
      start: checkpoint.byte,
      highWaterMark: 64 * 1024,
    });
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let data = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      let cursor = 0;
      while (cursor < data.length) {
        const newline = data.indexOf(0x0A, cursor);
        if (newline < 0) break;
        const raw = data.subarray(cursor, newline + 1);
        if (currentLine >= startLine && currentLine <= endLine) {
          if (selectedStartByte === undefined) selectedStartByte = absoluteByte;
          chunks.push(Buffer.from(raw));
          selectedBytes += raw.length;
          selectedEndByte = absoluteByte + raw.length;
          if (selectedBytes > Math.min(maxBytes, this.maxRangeBytes)) {
            throw new Error('Workspace RAG V2 line result exceeds its byte limit.');
          }
        }
        absoluteByte += raw.length;
        currentLine++;
        cursor = newline + 1;
        if (currentLine > endLine) {
          stream.destroy();
          break;
        }
      }
      buffered = Buffer.from(data.subarray(cursor));
      if (currentLine > endLine) break;
    }
    if (currentLine <= endLine && buffered.length > 0 && currentLine >= startLine) {
      if (selectedStartByte === undefined) selectedStartByte = absoluteByte;
      chunks.push(buffered);
      selectedEndByte = absoluteByte + buffered.length;
    }
    const result = Buffer.concat(chunks);
    return {
      text: result.toString('utf8'),
      startByte: selectedStartByte ?? checkpoint.byte,
      endByte: selectedEndByte ?? checkpoint.byte,
    };
  }

  /**
   * Resolves the on-disk path for a content hash.
   * @param contentSha256 - Content hash.
   * @returns Absolute object path.
   * @throws Error - When the hash is not a lowercase 64-hex SHA-256.
   */
  objectPath(contentSha256: string): string {
    this.assertHash(contentSha256);
    const result = this.contentPath(this.root, contentSha256);
    assertInsideRoot(this.root, result);
    return result;
  }

  /**
   * Resolves the on-disk path of a content hash's line index.
   * @param contentSha256 - Content hash.
   * @returns Absolute line-index path.
   * @throws Error - When the hash is not a lowercase 64-hex SHA-256.
   */
  lineIndexPath(contentSha256: string): string {
    return path.join(path.dirname(this.objectPath(contentSha256)), 'lines.tsv');
  }

  /**
   * Deletes old managed objects absent from the global repository reference
   * set. External and manifest-only stores are never owned by this collector.
   * @param referencedHashes - Content hashes still referenced by any repository.
   * @param olderThan - ISO-8601 cutoff; only blobs whose source file was modified strictly before it are eligible.
   * @param limit - Maximum number of blob directories to delete per call; defaults to 500.
   * @returns Number of blob directories deleted.
   * @throws Error - When the cutoff is not a valid timestamp or a blob directory cannot be removed; fs errors from deletion propagate.
   */
  async pruneUnreferenced(
    referencedHashes: ReadonlySet<string>,
    olderThan: string,
    limit = 500,
  ): Promise<number> {
    if (this.retentionMode !== 'managed' || limit <= 0) return 0;
    const cutoff = Date.parse(olderThan);
    if (!Number.isFinite(cutoff)) throw new Error(`Invalid Workspace RAG V2 blob GC cutoff: ${olderThan}`);
    const hashRoot = path.join(this.root, 'objects', 'sha256');
    const firstLevel = await readdir(hashRoot, { withFileTypes: true }).catch(() => []);
    let deleted = 0;
    for (const first of firstLevel) {
      if (deleted >= limit || !first.isDirectory() || !/^[a-f0-9]{2}$/u.test(first.name)) continue;
      const firstPath = path.join(hashRoot, first.name);
      const secondLevel = await readdir(firstPath, { withFileTypes: true }).catch(() => []);
      for (const second of secondLevel) {
        if (deleted >= limit || !second.isDirectory() || !/^[a-f0-9]{2}$/u.test(second.name)) continue;
        const secondPath = path.join(firstPath, second.name);
        const hashEntries = await readdir(secondPath, { withFileTypes: true }).catch(() => []);
        for (const entry of hashEntries) {
          if (deleted >= limit || !entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
          if (!entry.name.startsWith(`${first.name}${second.name}`) || referencedHashes.has(entry.name)) continue;
          const objectDirectory = path.join(secondPath, entry.name);
          assertInsideRoot(this.root, objectDirectory);
          const source = await stat(path.join(objectDirectory, 'source.md')).catch(() => undefined);
          if (!source?.isFile() || source.mtimeMs >= cutoff) continue;
          await rm(objectDirectory, { recursive: true, force: true });
          deleted++;
        }
      }
    }
    return deleted;
  }

  /**
   * Builds the hash-addressed path of an object's source file under a root.
   * @param root - Store root to place the object under.
   * @param contentSha256 - Lowercase 64-hex SHA-256 of the content.
   * @returns The absolute path under `root` at `objects/sha256`, sharded by the first four hash characters and ending in `source.md`.
   * @throws Error - When the hash is malformed.
   */
  private contentPath(root: string, contentSha256: string): string {
    this.assertHash(contentSha256);
    return path.join(
      root,
      'objects',
      'sha256',
      contentSha256.slice(0, 2),
      contentSha256.slice(2, 4),
      contentSha256,
      'source.md',
    );
  }

  /**
   * Resolves the manifest file path beside an object.
   * @param contentSha256 - Lowercase 64-hex SHA-256 of the content.
   * @returns The absolute `manifest.json` path in the object's directory.
   * @throws Error - When the hash is malformed (via the object path check).
   */
  private manifestPath(contentSha256: string): string {
    return path.join(path.dirname(this.objectPath(contentSha256)), 'manifest.json');
  }

  /**
   * Resolves the readable path of an object per the retention mode.
   *
   * Managed mode returns the managed path; `external_immutable` returns the
   * path under the external root; `manifest_only` reads the manifest and
   * re-hashes the recorded original file, requiring it to still match.
   * @param contentSha256 - Lowercase 64-hex SHA-256 of the content.
   * @returns The path the object's bytes can be read from.
   * @throws Error - When the hash is malformed, the manifest is missing fields or mismatched, or a manifest-only source changed on disk; fs errors propagate.
   */
  private async sourcePath(contentSha256: string): Promise<string> {
    if (this.retentionMode === 'managed') return this.objectPath(contentSha256);
    if (this.retentionMode === 'external_immutable') {
      return this.contentPath(this.externalRoot!, contentSha256);
    }
    const manifest = JSON.parse(await readFile(this.manifestPath(contentSha256), 'utf8')) as {
      sourcePath?: string;
      contentSha256?: string;
    };
    if (!manifest.sourcePath || manifest.contentSha256 !== contentSha256) {
      throw new Error('Workspace RAG V2 manifest-only source record is invalid.');
    }
    const current = await this.hashStableSource(manifest.sourcePath);
    if (current.contentSha256 !== contentSha256) {
      throw new Error(
        'Workspace RAG V2 manifest-only source changed; the historical citation is unavailable.',
      );
    }
    return manifest.sourcePath;
  }

  /**
   * Streams a file once to compute its hash and length.
   *
   * Size and mtime are taken before and after the stream; a mismatch rejects
   * the result as unreliable.
   * @param sourcePath - File to hash.
   * @param signal - Optional signal cancelling the stream; the abort reason is thrown.
   * @param onChunk - Optional async progress callback invoked per chunk with its byte length.
   * @returns The lowercase SHA-256 hex digest and the byte length.
   * @throws Error - When the source changes while being hashed or the signal aborts; fs errors propagate.
   */
  private async hashStableSource(
    sourcePath: string,
    signal?: AbortSignal,
    onChunk?: (bytes: number) => Promise<void>,
  ): Promise<{ contentSha256: string; byteLength: number }> {
    const before = await stat(sourcePath);
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const value of createReadStream(sourcePath, { highWaterMark: 1024 * 1024 })) {
      if (signal?.aborted) throw signal.reason ?? new Error('Workspace RAG V2 source hashing cancelled.');
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      await onChunk?.(chunk.length);
      hash.update(chunk);
      byteLength += chunk.length;
    }
    const after = await stat(sourcePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`Workspace RAG V2 source changed while it was hashed: ${sourcePath}`);
    }
    return { contentSha256: hash.digest('hex'), byteLength };
  }

  /**
   * Validates that a value is a lowercase SHA-256 hex digest.
   * @param contentSha256 - Value to check.
   * @returns Nothing.
   * @throws Error - When the value is not 64 lowercase hex characters.
   */
  private assertHash(contentSha256: string): void {
    if (!/^[a-f0-9]{64}$/u.test(contentSha256)) {
      throw new Error('Workspace RAG V2 content hash must be a lowercase SHA-256 value.');
    }
  }

  /**
   * Parses a line-index file into checkpoints.
   * @param contentSha256 - Hash whose line index should be read.
   * @returns The recorded checkpoints of 1-based line numbers and byte offsets; a single origin checkpoint when the index is absent or contains no valid entries.
   * @throws Error - When the index file exists but cannot be read; malformed entries are skipped.
   */
  private async readLineIndex(contentSha256: string): Promise<Array<{ line: number; byte: number }>> {
    const indexPath = this.lineIndexPath(contentSha256);
    if (!await exists(indexPath)) return [{ line: 1, byte: 0 }];
    const text = await readFile(indexPath, 'utf8');
    const values = text
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => {
        const [lineValue, byteValue] = line.split('\t');
        return { line: Number(lineValue), byte: Number(byteValue) };
      })
      .filter(value => Number.isSafeInteger(value.line) && value.line > 0 && Number.isSafeInteger(value.byte) && value.byte >= 0);
    return values.length > 0 ? values : [{ line: 1, byte: 0 }];
  }
}
