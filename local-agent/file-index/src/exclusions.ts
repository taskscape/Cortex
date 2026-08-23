import path from "node:path";
import { minimatch } from "minimatch";

// The configured patterns are Windows-style (`**\node_modules\**`). minimatch treats `\` as an ESCAPE
// character, not a separator, so those patterns silently matched nothing at all until this option was
// passed — node_modules, .git, dist and build were being indexed in full. `windowsPathsNoEscape` makes
// `\` a separator, which is what the config has always meant.
const MATCH_OPTIONS = { nocase: true, windowsPathsNoEscape: true } as const;

/**
 * Tests a relative path against the configured exclusion globs (case-insensitive,
 * Windows-style separators).
 *
 * @param relativePath - Path relative to the indexed root; `/` is normalised to `\`.
 * @param patterns - Exclusion glob patterns.
 * @returns True if any pattern matches the path.
 */
export function isExcluded(relativePath: string, patterns: readonly string[]): boolean {
  const normalized = relativePath.replace(/\//g, "\\");
  return patterns.some(pattern => minimatch(normalized, pattern, MATCH_OPTIONS));
}

/**
 * Whether a directory can be skipped without walking it. A pattern like `**\node_modules\**` does
 * not match the bare directory `node_modules`, so containment is probed with a synthetic direct
 * child: prune only when a plain child of any name would be excluded.
 *
 * Deliberately conservative: minimatch's `partial` option is not usable here — a leading `**` makes
 * it match every prefix, which would prune `src` and `source` too. Under-pruning only costs a walk
 * (the per-file check still excludes the contents); over-pruning would silently drop real files.
 *
 * @param relativePath - Directory path relative to the indexed root; `/` is normalised to `\`.
 * @param patterns - Exclusion glob patterns.
 * @returns True if the whole directory can be pruned from the walk without losing real files.
 */
export function isExcludedDirectory(relativePath: string, patterns: readonly string[]): boolean {
  const probe = path.join(relativePath.replace(/\//g, "\\"), "__probe__");
  return patterns.some(pattern => minimatch(probe, pattern, MATCH_OPTIONS));
}
