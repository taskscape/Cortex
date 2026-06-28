import path from "node:path";

export interface NormalizedPath {
  nativePath: string;
  canonicalPath: string;
  relativePath?: string;
  projectRoot?: string;
}

export function normalizeWindowsPath(inputPath: string, projectRoot?: string): NormalizedPath {
  const nativePath = path.resolve(inputPath);
  const canonicalPath = nativePath.toLowerCase().replace(/\//g, "\\");
  const normalizedRoot = projectRoot ? path.resolve(projectRoot) : undefined;
  const relativePath = normalizedRoot ? path.relative(normalizedRoot, nativePath) : undefined;

  return {
    nativePath,
    canonicalPath,
    relativePath,
    projectRoot: normalizedRoot
  };
}
