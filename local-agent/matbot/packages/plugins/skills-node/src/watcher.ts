import { watch, readdir, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { SkillManager } from '@matatbread/matbot-skills';

function mdNameToSkillName(filename: string): string {
  return path.basename(filename, '.md')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

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

// Resolves after `pollMs` or on abort — whichever comes first. The abort
// listener is always removed so repeated polls cannot accumulate listeners.
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
 * @param pollMs - Poll interval used when fs.watch is unavailable.
 * @param deps - Optional fs overrides (test seam).
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
