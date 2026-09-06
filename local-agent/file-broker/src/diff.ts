/** Maximum per-side line count for exact LCS matching before falling back. */
const MAX_LCS_LINES = 5000;

/** Context lines shown around each change in a hunk. */
const CONTEXT_LINES = 3;

type OpType = "same" | "delete" | "insert";

interface DiffOp {
  type: OpType;
  text: string;
}

/**
 * Produces a unified-style diff of two text versions of one file using an
 * LCS-based line comparison, so a single inserted line renders as one small
 * hunk instead of shifting the whole tail into +/- pairs. Hunks carry three
 * lines of context and are split when separated by more than six unchanged
 * lines. Inputs larger than {@link MAX_LCS_LINES} per side fall back to the
 * cheaper positional comparison (noted inline) to bound quadratic DP cost.
 *
 * Assumes inputs are UTF-8 text; lines are split on `\r?\n`.
 *
 * @param filePath - Path shown in the diff headers.
 * @param before - Previous content.
 * @param after - New content.
 * @returns A unified-diff-style text joined with newlines.
 * @throws Never; all failure modes degrade to the positional fallback.
 */
export function createUnifiedDiff(filePath: string, before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];

  if (beforeLines.length > MAX_LCS_LINES || afterLines.length > MAX_LCS_LINES) {
    // Positional fallback: edits shift the whole tail into +/- pairs here,
    // but bounding the quadratic LCS table matters more at this size.
    lines.push(`\\ Inputs exceed ${MAX_LCS_LINES} lines; positional fallback (diff may overstate changes).`);
    appendPositional(lines, beforeLines, afterLines);
    return lines.join("\n");
  }

  appendHunks(lines, lcsOps(beforeLines, afterLines));
  return lines.join("\n");
}

/**
 * Computes the line-level edit script via LCS dynamic programming. Common
 * prefixes/suffixes are trimmed first so mid-file edits run on small middles;
 * the DP table is allocated only over the trimmed range.
 *
 * @param before - Previous lines.
 * @param after - New lines.
 * @returns The ordered edit script (`same`/`delete`/`insert` ops) covering the
 * full transformation of `before` into `after`.
 */
function lcsOps(before: string[], after: string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB -= 1;
    endA -= 1;
  }

  for (let index = 0; index < start; index += 1) {
    ops.push({ type: "same", text: before[index]! });
  }

  const midB = before.slice(start, endB);
  const midA = after.slice(start, endA);
  if (midB.length === 0) {
    for (const text of midA) ops.push({ type: "insert", text });
  } else if (midA.length === 0) {
    for (const text of midB) ops.push({ type: "delete", text });
  } else {
    walkLcsTable(ops, midB, midA);
  }

  for (let index = endB; index < before.length; index += 1) {
    ops.push({ type: "same", text: before[index]! });
  }
  return ops;
}

/**
 * Fills `ops` with the minimal edit script between two non-empty middles.
 *
 * @param ops - Accumulator the ops are appended to.
 * @param midB - The non-empty trimmed "before" middle.
 * @param midA - The non-empty trimmed "after" middle.
 */
function walkLcsTable(ops: DiffOp[], midB: readonly string[], midA: readonly string[]): void {
  // LCS lengths never exceed MAX_LCS_LINES, so Uint16 cells are sufficient
  // and keep the worst-case table (~25M cells) bounded.
  const cols = midA.length + 1;
  const table = new Uint16Array((midB.length + 1) * cols);
  for (let i = midB.length - 1; i >= 0; i -= 1) {
    for (let j = midA.length - 1; j >= 0; j -= 1) {
      const diagonal = table[(i + 1) * cols + j + 1]!;
      const skipB = table[(i + 1) * cols + j]!;
      const skipA = table[i * cols + j + 1]!;
      table[i * cols + j] = midB[i] === midA[j] ? diagonal + 1 : Math.max(skipB, skipA);
    }
  }

  let i = 0;
  let j = 0;
  while (i < midB.length && j < midA.length) {
    if (midB[i] === midA[j]) {
      ops.push({ type: "same", text: midB[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      ops.push({ type: "delete", text: midB[i]! });
      i += 1;
    } else {
      ops.push({ type: "insert", text: midA[j]! });
      j += 1;
    }
  }
  while (i < midB.length) {
    ops.push({ type: "delete", text: midB[i]! });
    i += 1;
  }
  while (j < midA.length) {
    ops.push({ type: "insert", text: midA[j]! });
    j += 1;
  }
}

/**
 * Groups the edit script into hunks with {@link CONTEXT_LINES} context, merging
 * neighbouring changes separated by at most six unchanged lines.
 *
 * @param lines - Output accumulator; hunk headers and body lines are pushed
 * onto it in order.
 * @param ops - The complete ordered edit script from {@link lcsOps}.
 */
function appendHunks(lines: string[], ops: DiffOp[]): void {
  const changed = ops.map((op, index) => op.type === "same" ? -1 : index).filter(index => index >= 0);
  if (changed.length === 0) return;

  // Starting line numbers (1-based) of each op on both sides.
  let bLine = 1;
  let aLine = 1;
  const opStart = ops.map(op => {
    const position = { b: bLine, a: aLine };
    if (op.type !== "insert") bLine += 1;
    if (op.type !== "delete") aLine += 1;
    return position;
  });

  let hunkStart = 0;
  while (hunkStart < changed.length) {
    let hunkEnd = hunkStart;
    while (hunkEnd + 1 < changed.length &&
      changed[hunkEnd + 1]! - changed[hunkEnd]! <= CONTEXT_LINES * 2) {
      hunkEnd += 1;
    }
    const lo = Math.max(0, changed[hunkStart]! - CONTEXT_LINES);
    const hi = Math.min(ops.length - 1, changed[hunkEnd]! + CONTEXT_LINES);
    let bCount = 0;
    let aCount = 0;
    for (let index = lo; index <= hi; index += 1) {
      if (ops[index]!.type !== "insert") bCount += 1;
      if (ops[index]!.type !== "delete") aCount += 1;
    }
    lines.push(`@@ -${opStart[lo]!.b},${bCount} +${opStart[lo]!.a},${aCount} @@`);
    for (let index = lo; index <= hi; index += 1) {
      const op = ops[index]!;
      if (op.type === "same") lines.push(` ${op.text}`);
      else if (op.type === "delete") lines.push(`-${op.text}`);
      else lines.push(`+${op.text}`);
    }
    hunkStart = hunkEnd + 1;
  }
}

/**
 * Legacy positional rendering used only above the LCS size cap: compares lines
 * by index alone, so an insertion shifts the whole tail into +/- pairs.
 *
 * @param lines - Output accumulator; context and +/- lines are pushed onto it.
 * @param beforeLines - Previous lines.
 * @param afterLines - New lines.
 */
function appendPositional(lines: string[], beforeLines: string[], afterLines: string[]): void {
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
}
