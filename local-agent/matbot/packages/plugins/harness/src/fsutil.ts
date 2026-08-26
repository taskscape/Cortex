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

export function extensionOf(filePath: string): string {
  const idx = filePath.lastIndexOf('.');
  return idx < 0 ? '' : filePath.slice(idx).toLowerCase();
}

/** Heuristic binary sniff: known binary extension or >30% non-printable/null bytes. */
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

/** Compile a glob pattern (`**`, `*`, `?`, `[a-z]`) to a RegExp over forward-slash paths. */
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

export interface WalkOptions {
  /** Extra directory names to prune. */
  ignoreDirs?: Iterable<string>;
  /** Glob include filter applied to file paths relative to `base`. */
  include?: RegExp;
}

/** Collect files under `base` (relative paths), pruning ignored directories. Deterministic order. */
export async function walkFiles(base: string, opts: WalkOptions = {}): Promise<string[]> {
  const ignored = new Set(IGNORED_DIRS);
  for (const d of opts.ignoreDirs ?? []) ignored.add(d);
  const out: string[] = [];
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

interface ReadRecord { hash: string; mtimeMs: number; size: number }

const readState = new Map<string, Map<string, ReadRecord>>();

/** Test/multi-session hygiene: drop all tracked read state. */
export function resetReadState(): void {
  readState.clear();
}

function stateFor(sessionId: string): Map<string, ReadRecord> {
  let m = readState.get(sessionId);
  if (m === undefined) { m = new Map(); readState.set(sessionId, m); }
  return m;
}

function recordKey(resolvedPath: string): string {
  return resolvedPath.split(sep).join('/').toLowerCase();
}

async function hashOf(resolvedPath: string): Promise<ReadRecord & { bytes: Buffer }> {
  const bytes = await readFile(resolvedPath);
  return {
    bytes,
    hash: createHash('sha256').update(bytes).digest('hex'),
    mtimeMs: (await stat(resolvedPath)).mtimeMs,
    size: bytes.length,
  };
}

/** Record a successful read so later edits can verify freshness. */
export async function recordRead(sessionId: string, resolvedPath: string): Promise<void> {
  const rec = await hashOf(resolvedPath);
  stateFor(sessionId).set(recordKey(resolvedPath), { hash: rec.hash, mtimeMs: rec.mtimeMs, size: rec.size });
}

/**
 * Enforce read-before-edit: the file must have been read this session and must not have changed
 * on disk since. Throws corrective HarnessErrors otherwise.
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

export interface DiffSummary { additions: number; deletions: number; diff: string }

/**
 * Line-based change summary: trims the common prefix/suffix, then renders the changed middle as
 * `-`/`+` lines with a little context. Deterministic and cheap; not a strict Myers diff.
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
