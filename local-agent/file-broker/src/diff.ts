/**
 * Produces a simplified unified diff of two text versions of one file. Lines
 * are compared positionally rather than by an LCS, so edits shift the whole
 * tail into +/- pairs.
 *
 * @param filePath - Path shown in the diff headers.
 * @param before - Previous content.
 * @param after - New content.
 * @returns A unified-diff-style text joined with newlines.
 */
export function createUnifiedDiff(filePath: string, before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];
  const max = Math.max(beforeLines.length, afterLines.length);

  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];

    if (left === right) {
      lines.push(` ${left ?? ""}`);
      continue;
    }

    if (left !== undefined) {
      lines.push(`-${left}`);
    }

    if (right !== undefined) {
      lines.push(`+${right}`);
    }
  }

  return lines.join("\n");
}
