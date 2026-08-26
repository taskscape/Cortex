import type { SortSpec } from '@matatbread/matbot-core';
import { getField, pathSegments } from './access.js';

// Compares two resolved field values. Missing (undefined/null) sorts last. Same-type pairs
// compare within type — numbers numerically, booleans numerically (false < true), strings
// by codepoint order — mirroring the strict filter semantics in compile.ts where ordering
// only exists within a type. Cross-type pairs still need a deterministic total order for
// sorting, so they fall back to string codepoint order of the String() forms.
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  const am = a === undefined || a === null;
  const bm = b === undefined || b === null;
  if (am || bm) return am ? (bm ? 0 : 1) : -1;
  if (typeof a === 'number'   && typeof b === 'number')   return a - b;
  if (typeof a === 'boolean'  && typeof b === 'boolean')  return Number(a) - Number(b);
  if (typeof a === 'string'   && typeof b === 'string')   return a < b ? -1 : a > b ? 1 : 0;
  const as = String(a), bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

// Sorts by the requested specs, then appends `id` as a final tiebreaker so the order is always
// total — without which an opaque cursor over the result could not point at a stable boundary.
/**
 * Sort documents by the requested specs (missing values last; numbers and booleans compare
 * numerically — false < true —, strings by codepoint order, cross-type pairs by their string
 * form), appending `id` as a final tiebreaker so the ordering is total and cursor-stable.
 *
 * @param docs - Documents to sort (the input array is not mutated).
 * @param sort - Sort specs in application order, or `undefined` for id-only ordering.
 * @returns A new sorted array.
 */
export function applySort<T extends { id: string }>(docs: T[], sort: SortSpec[] | undefined): T[] {
  const compiled = [...(sort ?? []), { field: 'id', dir: 'asc' as const }]
    .map(s => ({ seg: pathSegments(s.field), sign: s.dir === 'desc' ? -1 : 1 }));

  return [...docs].sort((a, b) => {
    for (const { seg, sign } of compiled) {
      const c = compareValues(getField(a, seg), getField(b, seg));
      if (c !== 0) return c * sign;
    }
    return 0;
  });
}
