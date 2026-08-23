import type { StoreQuery, QueryResult } from '@matatbread/matbot-core';
import { validateQuery } from './validate.js';
import { compileFilter } from './compile.js';
import { applySort } from './sort.js';
import { encodeCursor, decodeCursor, type PageState } from './paginate.js';

function toQuery(p: PageState): StoreQuery {
  return {
    ...(p.where !== undefined ? { where: p.where } : {}),
    ...(p.sort  !== undefined ? { sort:  p.sort  } : {}),
    ...(p.limit !== undefined ? { limit: p.limit } : {}),
  };
}

// Reference in-memory execution: validate → filter → totally-order → paginate. Backends that load
// all documents into memory (filesystem, IndexedDB, sqlite-as-blob) delegate here; a pushdown
// backend would instead compile the same StoreQuery to its native query language.
//
// A cursor is self-contained: it carries the query, sort, page size, and position, so a caller can
// page by sending only the cursor back. When a cursor is present it fully determines the page —
// any where/sort/limit passed alongside it are ignored — which is what makes consecutive pages a
// disjoint cover (page N re-applies the same sort as page 1, so the total order never shifts). A
// cursor is untrusted input, so its decoded query is validated exactly like a fresh one.
/**
 * Reference in-memory query execution: validate → filter → totally-order → paginate. Backends
 * that load all documents into memory delegate here. A cursor fully determines the page (any
 * where/sort/limit alongside it are ignored) and is validated like fresh input.
 *
 * @param docs - All documents of the namespace to query.
 * @param q - The validated-shape query (filter, sort, limit, optional cursor).
 * @returns One page of results with a `total` count and a continuation cursor when more pages follow.
 * @throws {StoreQueryError} When the query or an opaque cursor fails validation.
 */
export function executeQuery<T extends { id: string; version: string }>(docs: T[], q: StoreQuery): QueryResult<T> {
  const page: PageState = q.cursor !== undefined
    ? decodeCursor(q.cursor)
    : {
        offset: 0,
        ...(q.where !== undefined ? { where: q.where } : {}),
        ...(q.sort  !== undefined ? { sort:  q.sort  } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      };

  validateQuery(toQuery(page));

  const predicate = page.where !== undefined ? compileFilter(page.where) : () => true;
  const ordered   = applySort(docs.filter(predicate), page.sort);

  const total = ordered.length;
  const end   = page.limit !== undefined ? page.offset + page.limit : ordered.length;
  const slice = ordered.slice(page.offset, end);
  const next  = page.offset + slice.length;

  return {
    items: slice,
    total,
    ...(next < total ? { cursor: encodeCursor({ ...page, offset: next }) } : {}),
  };
}
