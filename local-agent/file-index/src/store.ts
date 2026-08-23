import fs from "node:fs/promises";
import path from "node:path";

/** One indexed text fragment of a file, with metadata for search results. */
export interface IndexedChunk {
  /** Unique id: canonical path plus chunk index. */
  id: string;
  /** Native absolute path of the source file. */
  path: string;
  /** Lowercased canonical form of the path used for identity and change detection. */
  canonicalPath: string;
  /** Path relative to the indexed root, present when known. */
  relativePath?: string;
  /** The resolved indexed root, present when known. */
  projectRoot?: string;
  /** Lowercased file extension (including dot). */
  extension: string;
  /** SHA-256 of the original (pre-redaction) content; drives change detection. */
  fileHash: string;
  /** ISO timestamp of the file's mtime at index time. */
  modifiedTime: string;
  /** File size in bytes at index time. */
  size: number;
  /** Zero-based position of this chunk within the file. */
  chunkIndex: number;
  /** Chunk text after secret redaction was applied. */
  content: string;
  /** Number of credential-shaped values replaced with `[redacted]` in this chunk. Absent when none. */
  redactions?: number;
}

/**
 * The persisted index: chunk list plus a record of files skipped during the
 * last run and why.
 */
export interface IndexStore {
  /** Store schema version. */
  version: 1;
  /** ISO timestamp of the last successful save. */
  updatedAt: string;
  /** All indexed chunks across roots. */
  chunks: IndexedChunk[];
  /** Files/directories not indexed, each with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Creates an empty store with an epoch timestamp.
 *
 * @returns A fresh, empty {@link IndexStore}.
 */
export function emptyStore(): IndexStore {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    chunks: [],
    skipped: []
  };
}

/**
 * Loads the index store from disk, tolerating a missing file.
 *
 * @param storePath - Path of the persisted store JSON.
 * @returns The parsed store, or an empty store when the file does not exist.
 * @throws Any filesystem error other than ENOENT from reading the file.
 * @throws SyntaxError if the file is not valid JSON.
 */
export async function loadStore(storePath: string): Promise<IndexStore> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw) as IndexStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyStore();
    }

    throw error;
  }
}

/**
 * Atomically persists the store: writes to a unique temporary file in the same
 * directory, then renames it over the target, refreshing `updatedAt`. The
 * temporary file is removed if any step fails.
 *
 * @param storePath - Destination path for the store JSON.
 * @param store - The store to persist.
 * @throws Any filesystem error from creating directories or writing/renaming the file.
 */
export async function saveStore(storePath: string, store: IndexStore): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify({ ...store, updatedAt: new Date().toISOString() })}\n`,
      "utf8"
    );
    await fs.rename(temporaryPath, storePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
