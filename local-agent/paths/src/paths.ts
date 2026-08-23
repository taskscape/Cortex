import { realpath as realpathWithCallback } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// `fs/promises` exposes no `realpath.native`, and the native variant is the one that expands 8.3
// short names on Windows — so promisify the callback form rather than lose that.
const realpath = promisify(realpathWithCallback.native);

/** The different spellings of one path produced by {@link normalizeWindowsPath}. */
export interface NormalizedPath {
  /** Absolute path in native OS form (resolved, original casing). */
  nativePath: string;
  /** Lowercased, backslash-separated form used for comparisons. */
  canonicalPath: string;
  /** Path relative to `projectRoot`, present when a root was supplied. */
  relativePath?: string;
  /** The resolved project root, present when one was supplied. */
  projectRoot?: string;
}

/**
 * Canonicalises a path for comparison: resolves it to an absolute path,
 * lowercases it, and normalises forward slashes to backslashes.
 *
 * @param inputPath - The path to canonicalise (absolute or relative to cwd).
 * @returns The canonical form of the path.
 */
export function canonicalPath(inputPath: string): string {
  return path.resolve(inputPath).toLowerCase().replace(/\//g, "\\");
}

/**
 * Tests whether a child path is inside (or equal to) a parent path, using
 * case-insensitive canonical comparison.
 *
 * @param childPath - The candidate descendant path.
 * @param parentPath - The ancestor directory to test against.
 * @returns True if `childPath` equals or lies within `parentPath`.
 */
export function isPathInside(childPath: string, parentPath: string): boolean {
  const child = canonicalPath(childPath);
  const parent = canonicalPath(parentPath);
  return child === parent || child.startsWith(parent.endsWith("\\") ? parent : `${parent}\\`);
}

/**
 * Resolves a path and derives canonical/relative forms against an optional
 * project root.
 *
 * @param inputPath - The path to normalise (absolute or relative to cwd).
 * @param projectRoot - Optional root used to compute `relativePath`.
 * @returns A {@link NormalizedPath} with native, canonical, and (when a root is
 * given) relative/project-root fields populated.
 */
export function normalizeWindowsPath(inputPath: string, projectRoot?: string): NormalizedPath {
  const nativePath = path.resolve(inputPath);
  const canonical = canonicalPath(nativePath);
  const normalizedRoot = projectRoot ? path.resolve(projectRoot) : undefined;
  const relativePath = normalizedRoot ? path.relative(normalizedRoot, nativePath) : undefined;

  return {
    nativePath,
    canonicalPath: canonical,
    ...(relativePath !== undefined ? { relativePath } : {}),
    ...(normalizedRoot !== undefined ? { projectRoot: normalizedRoot } : {})
  };
}

// Resolves symlinks and junctions before canonicalising, so containment cannot be defeated by a link
// that points out of its parent. `realpath.native` also expands 8.3 short names (C:\PROGRA~1), which
// would otherwise canonicalise to a different string than their long form.
export async function realCanonicalPath(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  try {
    return canonicalPath(await realpath(resolved));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    // The target does not exist yet (a create). Resolve the nearest existing ancestor and re-append
    // the tail, so a path whose *parent* is a link is still resolved rather than trusted lexically.
    const parent = path.dirname(resolved);
    if (parent === resolved) {
      return canonicalPath(resolved);
    }

    return canonicalPath(path.join(await realCanonicalPath(parent), path.basename(resolved)));
  }
}

/**
 * Tests containment after resolving symlinks, junctions, and Windows 8.3 short
 * names on both paths, so links cannot defeat the check.
 *
 * @param childPath - The candidate descendant path (may not exist).
 * @param parentPath - The ancestor directory to test against.
 * @returns True if the real paths are in a containment relationship.
 * @throws Any filesystem error from `realpath.native` other than ENOENT
 * (e.g. EACCES while resolving an ancestor).
 */
export async function isRealPathInside(childPath: string, parentPath: string): Promise<boolean> {
  return isPathInside(await realCanonicalPath(childPath), await realCanonicalPath(parentPath));
}
