import path from "node:path";

export function canonicalPath(inputPath: string): string {
  return path.resolve(inputPath).toLowerCase().replace(/\//g, "\\");
}

export function isPathInside(childPath: string, parentPath: string): boolean {
  const child = canonicalPath(childPath);
  const parent = canonicalPath(parentPath);
  return child === parent || child.startsWith(parent.endsWith("\\") ? parent : `${parent}\\`);
}
