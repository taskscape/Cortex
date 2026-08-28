import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { RagV2SourceObject } from './types.js';

const DEFAULT_MAX_RANGE_BYTES = 8 * 1024 * 1024;

function assertInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    if (candidate !== root) throw new Error(`Workspace RAG V2 object path escapes its root: ${candidate}`);
  }
}

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

  async initialize(): Promise<void> {
    await mkdir(path.join(this.root, 'objects', 'sha256'), { recursive: true });
    await mkdir(path.join(this.root, 'staging'), { recursive: true });
  }

  /**
   * Stores a file by content hash; identical content is deduplicated.
   * @param params - Source path, bytes and hashing inputs.
   * @returns The stored object reference.
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
   * @param params - Object hash plus byte range.
   * @returns The requested bytes decoded as UTF-8 text.
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
   * @param params - Object hash, line index path, and line range.
   * @returns The lines joined with newlines (empty when no index exists).
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
   */
  lineIndexPath(contentSha256: string): string {
    return path.join(path.dirname(this.objectPath(contentSha256)), 'lines.tsv');
  }

  /**
   * Deletes old managed objects absent from the global repository reference
   * set. External and manifest-only stores are never owned by this collector.
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

  private manifestPath(contentSha256: string): string {
    return path.join(path.dirname(this.objectPath(contentSha256)), 'manifest.json');
  }

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

  private assertHash(contentSha256: string): void {
    if (!/^[a-f0-9]{64}$/u.test(contentSha256)) {
      throw new Error('Workspace RAG V2 content hash must be a lowercase SHA-256 value.');
    }
  }

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
