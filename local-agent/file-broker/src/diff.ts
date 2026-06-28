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
