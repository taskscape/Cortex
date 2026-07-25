import { realpath as realpathWithCallback } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// `fs/promises` exposes no `realpath.native`, and the native variant is the one that expands 8.3
// short names on Windows — so promisify the callback form rather than lose that.
const realpath = promisify(realpathWithCallback.native);

export interface NormalizedPath {
  nativePath: string;
  canonicalPath: string;
  relativePath?: string;
  projectRoot?: string;
}

export function canonicalPath(inputPath: string): string {
  return path.resolve(inputPath).toLowerCase().replace(/\//g, "\\");
}

export function isPathInside(childPath: string, parentPath: string): boolean {
  const child = canonicalPath(childPath);
  const parent = canonicalPath(parentPath);
  return child === parent || child.startsWith(parent.endsWith("\\") ? parent : `${parent}\\`);
}

export function normalizeWindowsPath(inputPath: string, projectRoot?: string): NormalizedPath {
  const nativePath = path.resolve(inputPath);
  const canonical = canonicalPath(nativePath);
  const normalizedRoot = projectRoot ? path.resolve(projectRoot) : undefined;
  const relativePath = normalizedRoot ? path.relative(normalizedRoot, nativePath) : undefined;

  return {
    nativePath,
    canonicalPath: canonical,
    relativePath,
    projectRoot: normalizedRoot
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

export async function isRealPathInside(childPath: string, parentPath: string): Promise<boolean> {
  return isPathInside(await realCanonicalPath(childPath), await realCanonicalPath(parentPath));
}
