import type { FieldPath } from '@matatbread/matbot-core';

/**
 * Normalize a field reference to its path segments. A bare string is ONE key — never split on `.`.
 *
 * @param field - The field reference (bare key or nested segment array).
 * @returns The ordered path segments.
 */
export function pathSegments(field: FieldPath): string[] {
  return Array.isArray(field) ? field : [field];
}

/**
 * Null-safe traversal of a document by path segments (the grammar's implicit `?.`): any absent
 * or non-object segment short-circuits to `undefined` and never throws; a present `null` is
 * returned as-is.
 *
 * @param row - The document to read from.
 * @param segments - Ordered path segments to walk.
 * @returns The value at the path, `null` if stored, or `undefined` when missing.
 */
export function getField(row: unknown, segments: string[]): unknown {
  let cur: unknown = row;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
