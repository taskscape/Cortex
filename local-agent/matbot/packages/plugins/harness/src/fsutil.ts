import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { HarnessError } from './paths.js';

export const IGNORED_DIRS = new Set(['.git', 'node_modules', '.data', '.plugins', '.svn', '.hg']);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip',
  '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.woff',
  '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.avi', '.mov', '.sqlite',
  '.db', '.wasm', '.class', '.jar', '.pyc', '.pdb', '.bin',
]);

/**
 * Extracts a file's extension, including the leading dot.
 *
 * @param filePath Path or file name.
 * @returns The lower-cased extension (e.g. `.ts`), or the empty string when there is no dot.
 */
export function extensionOf(filePath: string): string {
  const idx = filePath.lastIndexOf('.');
  return idx < 0 ? '' : filePath.slice(idx).toLowerCase();
}

/**
 * Heuristic binary sniff: known binary extension or >30% non-printable/null bytes.
 *
 * Only the first 8 KiB of `bytes` are sampled; NUL and control characters other
 * than tab, LF, and CR count as suspicious.
 *
 * @param filePath Path used for the extension check.
 * @param bytes File contents to sample; may be empty.
 * @returns True when the file looks binary.
 * @throws Never.
 */
export function isBinary(filePath: string, bytes: Uint8Array): boolean {
  if (BINARY_EXTENSIONS.has(extensionOf(filePath))) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const b of sample) {
    if (b === 0 || (b < 9) || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.3;
}

/**
 * Compile a glob pattern (`**`, `*`, `?`, `[a-z]`) to a RegExp over forward-slash paths.
 *
 * Backslashes are normalized to slashes first; a double-star followed by a
 * slash also matches zero segments; an
 * unterminated `[` is escaped literally; a leading `!` in a class becomes negation.
 * The result is anchored (`^...$`) and intended for full relative paths.
 *
 * @param pattern Glob pattern to compile.
 * @returns An anchored regular expression equivalent to the pattern.
 * @throws SyntaxError - If the compiled body is not a valid regular expression (e.g. a malformed character class).
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        i++;
        if (normalized[i + 1] === '/') i++;   // `**/` also matches zero segments
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '[') {
      const end = normalized.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; continue; }
      let body = normalized.slice(i + 1, end);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      re += `[${body}]`;
      i = end;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Options for {@link walkFiles}: extra directory pruning and a glob include filter.
 */
export interface WalkOptions {
  /** Extra directory names to prune. */
  ignoreDirs?: Iterable<string>;
  /** Glob include filter applied to file paths relative to `base`. */
  include?: RegExp;
}

/**
 * Collect files under `base` (relative paths), pruning ignored directories. Deterministic order.
 *
 * Directories named in {@link IGNORED_DIRS} plus `opts.ignoreDirs` are pruned; unreadable
 * directories are skipped silently. Entries are walked depth-first with locale-aware name
 * sorting, so the result order is stable. Paths are forward-slashed and relative to `base`.
 *
 * @param base Directory to scan recursively.
 * @param opts Extra ignored directory names and an optional include filter tested against each relative path.
 * @returns Matching relative file paths in deterministic depth-first order.
 * @throws Never - `readdir` failures are swallowed per directory.
 */
export async function walkFiles(base: string, opts: WalkOptions = {}): Promise<string[]> {
  const ignored = new Set(IGNORED_DIRS);
  for (const d of opts.ignoreDirs ?? []) ignored.add(d);
  const out: string[] = [];
  /**
   * Recursively collects readable directory entries into `out`, pruning ignored
   * directories and applying the include filter; unreadable directories end the branch.
   *
   * @param dir Absolute directory currently being visited.
   * @returns Nothing.
   */
  async function visit(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(base, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(full);
      } else if (entry.isFile()) {
        if (opts.include === undefined || opts.include.test(rel)) out.push(rel);
      }
    }
  }
  await visit(base);
  return out;
}

// ── Read-before-edit tracking (spec R12) ─────────────────────────────────────

/**
 * Freshness fingerprint of a file as of a tracked read: content hash plus mtime/size stamp.
 */
interface ReadRecord { hash: string; mtimeMs: number; size: number }

const readState = new Map<string, Map<string, ReadRecord>>();

/**
 * Test/multi-session hygiene: drop all tracked read state.
 *
 * Clears the per-session fingerprints recorded by {@link recordRead}; afterwards
 * every session must read a file again before editing it.
 *
 * @returns Nothing.
 * @throws Never.
 */
export function resetReadState(): void {
  readState.clear();
}

/**
 * Returns the read-state map for a session, creating it on first use.
 *
 * @param sessionId Session whose state to fetch.
 * @returns The session's mutable map of record keys to read records.
 */
function stateFor(sessionId: string): Map<string, ReadRecord> {
  let m = readState.get(sessionId);
  if (m === undefined) { m = new Map(); readState.set(sessionId, m); }
  return m;
}

/**
 * Normalizes an absolute path to the canonical record key.
 *
 * @param resolvedPath Absolute path of the tracked file.
 * @returns Forward-slashed, lower-cased path used as the map key.
 */
function recordKey(resolvedPath: string): string {
  return resolvedPath.split(sep).join('/').toLowerCase();
}

/**
 * Reads a file and computes its freshness fingerprint.
 *
 * @param resolvedPath Absolute path to read.
 * @returns The file's full bytes plus its SHA-256 hash, mtime, and size.
 * @throws Error - Propagates `readFile`/`stat` failures (e.g. the file does not exist).
 */
async function hashOf(resolvedPath: string): Promise<ReadRecord & { bytes: Buffer }> {
  const bytes = await readFile(resolvedPath);
  return {
    bytes,
    hash: createHash('sha256').update(bytes).digest('hex'),
    mtimeMs: (await stat(resolvedPath)).mtimeMs,
    size: bytes.length,
  };
}

/**
 * Record a successful read so later edits can verify freshness.
 *
 * Stores the file's hash/mtime/size fingerprint under the session; {@link requireFreshRead}
 * compares later disk state against it.
 *
 * @param sessionId Session performing the read.
 * @param resolvedPath Absolute path of the file that was read.
 * @returns Nothing.
 * @throws Error - If the file cannot be read or stat'ed.
 */
export async function recordRead(sessionId: string, resolvedPath: string): Promise<void> {
  const rec = await hashOf(resolvedPath);
  stateFor(sessionId).set(recordKey(resolvedPath), { hash: rec.hash, mtimeMs: rec.mtimeMs, size: rec.size });
}

/**
 * Enforce read-before-edit: the file must have been read this session and must not have changed
 * on disk since. Throws corrective HarnessErrors otherwise.
 *
 * The mtime/size check short-circuits; only a seemingly unchanged file is re-read and hashed.
 *
 * @param sessionId Session claiming the prior read.
 * @param resolvedPath Absolute path of the file about to be edited.
 * @returns The file's current contents.
 * @throws HarnessError - With code `invalid_input` when the file was never read this session, `not_found` when it no longer exists, or `conflict` when its mtime/size changed since the read.
 */
export async function requireFreshRead(sessionId: string, resolvedPath: string): Promise<Buffer> {
  const key = recordKey(resolvedPath);
  const known = stateFor(sessionId).get(key);
  if (known === undefined) {
    throw new HarnessError(
      `File "${resolvedPath}" has not been read in this session. Use the read tool first — edits are only allowed on content you have seen.`,
      'invalid_input',
    );
  }
  let currentStat: Stats;
  try { currentStat = await stat(resolvedPath); }
  catch {
    throw new HarnessError(`File "${resolvedPath}" no longer exists.`, 'not_found');
  }
  if (currentStat.mtimeMs !== known.mtimeMs || currentStat.size !== known.size) {
    throw new HarnessError(
      `File "${resolvedPath}" has been modified since it was last read. Read it again before editing.`,
      'conflict',
    );
  }
  const rec = await hashOf(resolvedPath);
  return rec.bytes;
}

// ── Diff rendering ───────────────────────────────────────────────────────────

/**
 * Result of {@link summarizeDiff}: change counts plus the rendered diff text.
 */
export interface DiffSummary { additions: number; deletions: number; diff: string }

/**
 * Line-based change summary: trims the common prefix/suffix, then renders the changed middle as
 * `-`/`+` lines with a little context. Deterministic and cheap; not a strict Myers diff.
 *
 * Up to three unchanged context lines are kept on each side of the changed region; a render
 * longer than `maxDiffChars` is hard-truncated with an ellipsis marker.
 *
 * @param oldText Previous file contents.
 * @param newText New file contents.
 * @param maxDiffChars Maximum rendered diff length in characters. Default 8000.
 * @returns Addition/deletion line counts plus the rendered diff string.
 * @throws Never.
 */
export function summarizeDiff(oldText: string, newText: string, maxDiffChars = 8000): DiffSummary {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length, endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld--; endNew--; }
  const removed = oldLines.slice(start, endOld);
  const added = newLines.slice(start, endNew);
  const contextBefore = oldLines.slice(Math.max(0, start - 3), start);
  const contextAfter = oldLines.slice(endOld, Math.min(oldLines.length, endOld + 3));
  const lines = [
    ...contextBefore.map(l => ` ${l}`),
    ...removed.map(l => `-${l}`),
    ...added.map(l => `+${l}`),
    ...contextAfter.map(l => ` ${l}`),
  ];
  let diff = lines.join('\n');
  if (diff.length > maxDiffChars) diff = `${diff.slice(0, maxDiffChars)}\n…[diff truncated]`;
  return { additions: added.length, deletions: removed.length, diff };
}
