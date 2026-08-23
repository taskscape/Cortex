import type { Filter, SortSpec } from '@matatbread/matbot-core';
import { StoreQueryError } from '@matatbread/matbot-core';

// Everything needed to reproduce the next page deterministically: the query, its sort, the page
// size, and the position. The cursor is opaque and self-contained — a caller pages by sending only
// a previous result's cursor back. The in-memory reference backend carries the literal query and an
// offset; a pushdown backend would carry its own keyset under the same opaque contract.
/**
 * The decoded contents of a pagination cursor — everything needed to reproduce the next page
 * deterministically. Opaque to callers; a pushdown backend would carry its own keyset under the
 * same contract.
 */
export interface PageState {
  /** Filter carried from the originating query. */
  where?:  Filter;
  /** Sort carried from the originating query. */
  sort?:   SortSpec[];
  /** Page size carried from the originating query. */
  limit?:  number;
  /** Position of the next page within the sorted result set. */
  offset:  number;
}

/**
 * Encode a page state as an opaque cursor string.
 *
 * @param state - The page state to encode.
 * @returns The JSON-encoded opaque cursor.
 */
export function encodeCursor(state: PageState): string {
  return JSON.stringify(state);
}

/**
 * Decode an opaque cursor produced by {@link encodeCursor}.
 *
 * @param cursor - A cursor from a previous result, passed back verbatim.
 * @returns The decoded page state.
 * @throws {StoreQueryError} With code `MALFORMED` when the cursor is unreadable.
 */
export function decodeCursor(cursor: string): PageState {
  let parsed: unknown;
  try { parsed = JSON.parse(cursor); } catch { parsed = undefined; }
  const offset = (parsed as { offset?: unknown } | undefined)?.offset;
  if (parsed === null || typeof parsed !== 'object' || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)
    throw new StoreQueryError('unreadable cursor — pass back a cursor from a previous result verbatim', '/cursor', 'MALFORMED');
  return parsed as PageState;
}
