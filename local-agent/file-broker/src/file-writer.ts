import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "@local-agent/http-utils";
import { isPathInside, realCanonicalPath, type WorkspaceConfig } from "@local-agent/paths";
import { createBackup } from "./backup.js";
import { createUnifiedDiff } from "./diff.js";
import { readHandleText } from "./file-reader.js";

/** Outcome of a successful write: the written path, optional backup, and diff. */
export interface WriteResult {
  /** Absolute path of the file that was written. */
  path: string;
  /** Path of the pre-write backup snapshot, absent when the file did not exist. */
  backupPath?: string;
  /** Unified diff of the file before versus after the write. */
  diff: string;
}

// A backup is meaningful only when its source is stable.  Serialise writes to
// one resolved path, while allowing unrelated files to proceed in parallel.
// Without this, a second request can copy a file while the first is replacing
// it (an intermittent Windows sharing violation) and return a 500 instead of
// a recoverable snapshot.
const writeTails = new Map<string, Promise<void>>();

/**
 * Writes UTF-8 text to a file, creating a backup of any existing content first
 * and returning a unified diff. Writes to the same resolved path are
 * serialised (per the per-path queue above) while unrelated paths proceed in
 * parallel.
 *
 * @param targetPath - File to write; parent directories are created as needed.
 * @param content - Full new text content for the file.
 * @param backupRoot - Directory under which the pre-write backup is stored.
 * @param workspaces - Optional workspace roots; when supplied, the target is
 * re-verified against them (H4 TOCTOU mitigation, see {@link openVerified}).
 * @returns The write result including backup path (when a prior file existed) and diff.
 * @throws Any filesystem error other than ENOENT when reading the previous content,
 * from creating the backup, or from writing the file.
 * @throws {@link HttpError} 403 when the verification rejects the target.
 */
export async function writeTextFile(targetPath: string, content: string, backupRoot: string, workspaces?: WorkspaceConfig): Promise<WriteResult> {
  const resolvedTarget = path.resolve(targetPath);
  const key = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  const previous = writeTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => turn);
  writeTails.set(key, tail);
  await previous;

  try {
    return await writeTextFileUnlocked(resolvedTarget, content, backupRoot, workspaces);
  } finally {
    release();
    if (writeTails.get(key) === tail) writeTails.delete(key);
  }
}

/**
 * Core write implementation invoked while holding the per-path write lock (see
 * {@link writeTextFile}). Reads the previous content (through a verified
 * handle when workspace roots are supplied), snapshots it via
 * {@link createBackup}, then writes atomically: content goes to a unique
 * temporary file in the target directory, is flushed to disk, and is renamed
 * over the target, so a crash can never leave truncated or partially written
 * content in place.
 *
 * @param targetPath - Resolved absolute path to write; parent directories are
 * created as needed.
 * @param content - Full new text content for the file.
 * @param backupRoot - Directory under which the pre-write backup is stored.
 * @param workspaces - Optional workspace roots; when supplied, the previous
 * content is read through {@link openVerified} (H4 TOCTOU mitigation).
 * @returns The write result including backup path (when a prior file existed)
 * and the unified diff of before versus after.
 * @throws Any filesystem error other than ENOENT when reading the previous
 * content, from creating the backup, or from writing/renaming the file; the
 * temporary file is removed on write failure.
 * @throws {@link HttpError} 403 when verification rejects the target.
 */
async function writeTextFileUnlocked(targetPath: string, content: string, backupRoot: string, workspaces?: WorkspaceConfig): Promise<WriteResult> {
  let before = "";
  try {
    if (workspaces === undefined) {
      before = await fs.readFile(targetPath, "utf8");
    } else {
      // H4: read the previous content through one verified handle so the
      // policy-approved real path cannot be swapped for a link in between.
      const handle = await openVerified(targetPath, workspaces);
      try {
        before = await readHandleText(handle);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const backupPath = await createBackup(targetPath, backupRoot);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  // Write to a unique temporary file in the same directory, flush it to disk,
  // then rename it over the target so a crash can never leave truncated or
  // partially written content in place (mirrors file-index saveStore).
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await fs.open(temporaryPath, "w");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    path: targetPath,
    ...(backupPath !== undefined ? { backupPath } : {}),
    diff: createUnifiedDiff(targetPath, before, content)
  };
}

/**
 * Opens an existing file for reading after re-verifying, as far as the platform
 * allows, that the file is the one the policy approved (H4 TOCTOU mitigation).
 *
 * Checks performed:
 * 1. `lstat` the final path component and reject symbolic links / junctions /
 *    reparse points before opening.
 * 2. Open the handle, then `fstat` through it and compare size+mtime against
 *    the pre-open lstat to detect a swap between check and open.
 * 3. Re-resolve the real canonical path and confirm it is still contained in
 *    one of the configured workspace roots.
 *
 * Residual race (documented honestly): Windows exposes no reliable O_NOFOLLOW
 * for fs.open, so an external process can still swap a path component between
 * steps or between this verification and subsequent I/O; these checks narrow
 * but cannot fully close that window. Writes additionally rely on temp+rename,
 * which replaces the final directory entry rather than following it, and the
 * temporary file was created fresh by us.
 *
 * @param targetPath - File to open; may not exist yet (callers treat ENOENT
 * as a create), in which case only the ancestor resolution applies.
 * @param workspaces - Workspace roots the resolved path must remain inside;
 * omit to skip containment re-verification.
 * @returns An open read handle for the verified file.
 * @throws {@link HttpError} with status 403 when a check fails.
 * @throws Any filesystem error other than ENOENT from lstat/open/stat.
 */
export async function openVerified(targetPath: string, workspaces?: WorkspaceConfig): Promise<fs.FileHandle> {
  const resolved = path.resolve(targetPath);
  let preStats: Stats | undefined;
  try {
    preStats = await fs.lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (preStats?.isSymbolicLink()) {
    // Node's lstat reports symlinks, junctions, and mount points alike.
    throw new HttpError(403, "Target is a symbolic link; refusing to follow it.");
  }

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(resolved, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && preStats !== undefined) {
      throw new HttpError(403, "Target was removed between verification and open.");
    }
    throw error;
  }

  try {
    if (preStats !== undefined) {
      const opened = await handle.stat();
      // Weak swap detection: Windows handles expose no stable inode id via
      // fstat here, so compare size/mtime between lstat and the opened fd.
      if (opened.size !== preStats.size || opened.mtimeMs !== preStats.mtimeMs) {
        throw new HttpError(403, "Target changed between verification and open.");
      }
    }
    if (workspaces !== undefined) {
      const realTarget = await realCanonicalPath(resolved);
      const inside = await rootsContain(realTarget, workspaces);
      if (!inside) {
        throw new HttpError(403, "Resolved path is outside configured workspace roots.");
      }
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Tests whether an already-resolved real path lies inside one of the
 * workspace's roots, canonicalising each root through the filesystem as well,
 * so a root registered via a link or short name still matches.
 *
 * @param realTarget - Real canonical path of the candidate file.
 * @param workspaces - Workspace roots to test against.
 * @returns True if the target equals or is beneath any root.
 * @throws Any filesystem error from resolving a root path other than ENOENT.
 */
async function rootsContain(realTarget: string, workspaces: WorkspaceConfig): Promise<boolean> {
  for (const root of workspaces.roots) {
    if (isPathInside(realTarget, await realCanonicalPath(root.path))) return true;
  }
  return false;
}
