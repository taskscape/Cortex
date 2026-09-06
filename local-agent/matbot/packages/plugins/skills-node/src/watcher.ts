import { watch, readdir, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { SkillManager } from '@matatbread/matbot-skills';

/**
 * Derives a skill name from a Markdown filename: strips the `.md` extension, turns `-`/`_` runs
 * into spaces, and title-cases each word.
 *
 * @param filename - File name to convert.
 * @returns Title-cased skill name.
 * @throws Never.
 */
function mdNameToSkillName(filename: string): string {
  return path.basename(filename, '.md')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Imports one `.md` file into the manager, unless a skill of the derived name already exists —
 * `.md` files are import-only and never clobber an existing skill (the file isn't even read).
 * Unreadable files are silently ignored.
 *
 * @param manager - Skill manager receiving the import.
 * @param dir - Directory holding the file.
 * @param filename - Name of the file to import.
 * @returns A promise that resolves when the import attempt is done (imported, skipped or ignored).
 * @throws Error - Propagates a rejected {@link SkillManager.importIfAbsent} store write.
 */
async function importFile(
  manager:  SkillManager,
  dir:      string,
  filename: string,
): Promise<void> {
  const name = mdNameToSkillName(filename);
  // .md files are import-only: once a skill exists, the store owns it (skip the read entirely).
  if (manager.get(name) !== undefined) return;

  const content = await readFile(path.join(dir, filename), 'utf8').catch(() => null);
  if (content === null) return;

  await manager.importIfAbsent(name, content);
}

/**
 * Resolves after `pollMs` or on abort — whichever comes first. The abort
 * listener is always removed so repeated polls cannot accumulate listeners.
 *
 * @param ms - Maximum time to wait, in milliseconds.
 * @param signal - Abort signal ending the wait early.
 * @returns A promise that resolves (never rejects) when the timer fires or the signal aborts.
 * @throws Never.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Injectable fs seams for tests; production callers use the real fs. */
export interface WatcherDeps {
  readdir?: typeof readdir;
  mkdir?:   typeof mkdir;
  watch?:   typeof watch;
}

/**
 * Watches a directory of Markdown files and imports each as a skill into the
 * given {@link SkillManager}. Falls back to polling if watch is unavailable;
 * directory read failures are transient — warned about and retried until the
 * signal aborts, never fatal. Node-only — this is the filesystem capability
 * the cross-runtime base plugin deliberately omits.
 * @param dir - Directory to import and watch.
 * @param manager - Skill manager receiving imported skills.
 * @param signal - Abort signal terminating the watcher.
 * @param pollMs - Poll interval used when fs.watch is unavailable. Default 5000 ms.
 * @param deps - Optional fs overrides (test seam).
 * @returns A promise that resolves when `signal` aborts.
 * @throws Error - If the initial directory creation or the initial import pass fails (e.g. the
 *   store rejects a write); after the watch starts, per-event import failures switch to the
 *   polling fallback instead of rejecting.
 */
export async function watchAndImportSkillDir(
  dir:     string,
  manager: SkillManager,
  signal:  AbortSignal,
  pollMs = 5_000,
  deps:   WatcherDeps = {},
): Promise<void> {
  const readdirFn = deps.readdir ?? readdir;
  const watchFn   = deps.watch   ?? watch;

  // A dir created after boot would otherwise never be picked up.
  await (deps.mkdir ?? mkdir)(dir, { recursive: true });

  const importAll = async (): Promise<void> => {
    let files: string[];
    try {
      files = await readdirFn(dir);
    } catch (e) {
      console.warn(`[skills-node] skill dir "${dir}" unreadable; retrying:`, e instanceof Error ? e.message : e);
      return;
    }
    for (const f of files) {
      if (f.endsWith('.md')) await importFile(manager, dir, f);
    }
  };

  await importAll();

  try {
    for await (const event of watchFn(dir, { signal })) {
      if (!event.filename?.endsWith('.md')) continue;
      await importFile(manager, dir, event.filename);
    }
  } catch {
    if (signal.aborted) return;
    while (!signal.aborted) {
      await sleep(pollMs, signal);
      await importAll();
    }
  }
}
