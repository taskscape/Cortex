import { Worker } from 'node:worker_threads';

/** Hard wall-clock budget for one memory-lane regex evaluation. */
export const REGEX_EVALUATION_TIMEOUT_MS = 250;

const QUANTIFIER = /^[+*?]|\{\d+(?:,\d*)?\}/u;

/**
 * Detects a quantifier applied directly to a group that itself contains a
 * quantifier anywhere inside it — the shape that makes backtracking
 * exponential (for example ((a+)b)+c or (?:x+)*).
 */
function containsNestedQuantifierGroup(pattern: string): boolean {
  const quantified: boolean[] = [false];
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '[') {
      index++;
      while (index < pattern.length && pattern[index] !== ']') {
        if (pattern[index] === '\\') index++;
        index++;
      }
      index++;
      continue;
    }
    if (char === '(') {
      quantified.push(false);
      index++;
      if (pattern[index] === '?') {
        index++;
        const next = pattern[index];
        if (next === ':' || next === '=' || next === '!') index++;
        else if (next === '<') {
          index++;
          const modifier = pattern[index];
          if (modifier === '=' || modifier === '!') index++;
          else {
            while (index < pattern.length && pattern[index] !== '>') index++;
            index++;
          }
        }
      }
      continue;
    }
    if (char === ')') {
      const groupQuantified = quantified.pop() ?? false;
      if (groupQuantified && quantified.length > 0) {
        if (QUANTIFIER.test(pattern.slice(index + 1))) return true;
        // A group containing a quantifier makes every enclosing group
        // contain one too, even when this group is not itself quantified.
        quantified[quantified.length - 1] = true;
      }
      index++;
      continue;
    }
    if (QUANTIFIER.test(pattern.slice(index))) quantified[quantified.length - 1] = true;
    index++;
  }
  return false;
}

/**
 * Validates an LLM-supplied regex before any lane executes it.
 * @param pattern - Candidate pattern.
 */
export function assertSafeRegex(pattern: string): void {
  if (!pattern || pattern.length > 256) {
    throw new Error('Workspace RAG V2 regex must contain between 1 and 256 characters.');
  }
  if (/\\[1-9]|\(\?<([=!])|\(\?P</u.test(pattern)) {
    throw new Error('Workspace RAG V2 regex contains a prohibited backreference or lookbehind.');
  }
  if (containsNestedQuantifierGroup(pattern)) {
    throw new Error('Workspace RAG V2 regex contains a prohibited nested quantifier.');
  }
  try {
    new RegExp(pattern, 'u');
  } catch (error) {
    throw new Error(`Workspace RAG V2 regex is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const EVALUATOR_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const expression = new RegExp(workerData.pattern, "giu");
const matches = [];
for (let index = 0; index < workerData.texts.length; index++) {
  expression.lastIndex = 0;
  if (expression.test(workerData.texts[index])) matches.push(index);
}
parentPort.postMessage(matches);
`;

/**
 * Runs case-insensitive matching of `pattern` over `texts` inside a worker
 * thread with a hard timeout. A catastrophic pattern blocks only the worker,
 * which is terminated on breach; the caller receives a clear error instead of
 * a frozen event loop.
 * @param params - Validated pattern and candidate texts.
 * @param timeoutMs - Wall-clock budget for the whole evaluation.
 * @returns Indices of texts that match.
 */
export async function evaluateRegexMatchesBounded(
  pattern: string,
  texts: readonly string[],
  timeoutMs: number = REGEX_EVALUATION_TIMEOUT_MS,
): Promise<Set<number>> {
  if (texts.length === 0) return new Set();
  return await new Promise<Set<number>>((resolve, reject) => {
    const worker = new Worker(EVALUATOR_SOURCE, {
      eval: true,
      workerData: { pattern, texts: [...texts] },
    });
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(
        `Workspace RAG V2 regex evaluation exceeded its ${timeoutMs} ms time budget.`,
      )));
    }, timeoutMs);
    worker.once('message', value => {
      finish(() => resolve(new Set(
        Array.isArray(value) ? value.map(entry => Number(entry)).filter(Number.isSafeInteger) : [],
      )));
    });
    worker.once('error', error => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}
