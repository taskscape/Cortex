import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Default number of backups retained per target file (L13). */
const DEFAULT_MAX_BACKUPS = 20;

/**
 * Maximum backups kept per target file, overridable via
 * `CORTEX_FILE_BROKER_MAX_BACKUPS` (values below 1 fall back to the default).
 *
 * @returns The retention limit; at least 1.
 */
function maxBackupsPerFile(): number {
  const raw = Number(process.env.CORTEX_FILE_BROKER_MAX_BACKUPS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_BACKUPS;
  return Math.floor(raw);
}

/**
 * Copies an existing file into `backupRoot` under a timestamped, UUID-suffixed
 * name derived from its path, so concurrent same-millisecond writes never
 * overwrite one another's snapshots. After each successful copy, only the most
 * recent {@link maxBackupsPerFile} backups of the same target are kept; older
 * ones are pruned (oldest first) so snapshots cannot accumulate forever.
 *
 * @param targetPath - The file to snapshot.
 * @param backupRoot - Directory under which the copy is stored.
 * @returns Absolute path of the backup copy, or undefined if the target does not exist.
 * @throws Any filesystem error from creating directories or copying the file.
 */
export async function createBackup(targetPath: string, backupRoot: string): Promise<string | undefined> {
  try {
    await fs.access(targetPath);
  } catch {
    return undefined;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = safeBackupName(targetPath);
  // Several approved writes can arrive in one millisecond. Keep every
  // pre-write snapshot attributable instead of allowing same-timestamp writes
  // to overwrite one another's backup.
  const backupPath = path.resolve(backupRoot, `${timestamp}_${randomUUID()}_${safeName}`);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(targetPath, backupPath);
  await pruneOldBackups(backupRoot, safeName);
  return backupPath;
}

/**
 * Flattens a target path into its backup filename suffix.
 *
 * @param targetPath - The backed-up file's path.
 * @returns The resolved path with `:`, `\`, and `/` replaced by `_`, so every
 * backup of one target shares a stable, filesystem-safe name fragment.
 */
function safeBackupName(targetPath: string): string {
  return path.resolve(targetPath).replace(/[:\\\/]/g, "_");
}

/**
 * Deletes the oldest backups of one target beyond the retention limit. Backup
 * names begin with an ISO-8601 timestamp, so lexicographic order is
 * chronological order.
 *
 * @param backupRoot - Directory holding the timestamped backup files.
 * @param safeName - Filename suffix identifying the target's backups (see
 * {@link safeBackupName}).
 * @returns A promise resolving once pruning completes; individual deletion
 * failures are swallowed (best-effort retention).
 */
async function pruneOldBackups(backupRoot: string, safeName: string): Promise<void> {
  const max = maxBackupsPerFile();
  const entries = await fs.readdir(backupRoot);
  const matching = entries.filter(name => name.endsWith(`_${safeName}`)).sort();
  const excess = matching.slice(0, Math.max(0, matching.length - max));
  await Promise.all(excess.map(name =>
    fs.rm(path.join(backupRoot, name), { force: true }).catch(() => undefined)));
}
