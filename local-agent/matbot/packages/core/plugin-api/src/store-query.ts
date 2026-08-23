// The matbot store query grammar: a minimal, closed filter AST designed to be translated to a
// real backend (SQL WHERE, Elasticsearch bool, Mongo find, IndexedDB cursor) — not interpreted by
// an embedded engine. The in-memory reference evaluator lives in @matatbread/matbot-storage-base.
//
// Design rules (see CLAUDE.md / the store-query design notes):
//   - LHS is always a field, RHS is always a constant. No field-vs-field, no computed values.
//   - Operators are a closed union discriminated by `op`, so every backend compiler is one total
//     `switch` the type checker can prove exhaustive.
//   - Comparisons are type-strict; null and absent are a single "missing" state (queried only via
//     `exists`). null is therefore barred from every comparison operand.

/** Any value storable in a document field, including `null`. */
export type Scalar     = string | number | boolean | null;
/** A comparison operand: {@link Scalar} minus `null` (query null presence via `exists` instead). */
export type Comparable = string | number | boolean;
/** An ordering operand for sort and range comparisons. */
export type Orderable  = string | number;

/**
 * A field reference in a filter or sort spec. A bare string is exactly ONE key (never split on
 * `.`); use an array of segments for a nested path — `"a.b"` is the key literally named `a.b`,
 * while `["a","b"]` is nested.
 */
export type FieldPath = string | string[];

/** The closed, backend-translatable filter AST. LHS is always a field; RHS is always a constant. */
export type Filter =
  | { op: 'eq' | 'neq';                field: FieldPath; value: Comparable }
  | { op: 'lt' | 'lte' | 'gt' | 'gte'; field: FieldPath; value: Orderable }
  | { op: 'in' | 'nin';                field: FieldPath; value: Comparable[] }
  | { op: 'exists';                    field: FieldPath; value: boolean }
  | { op: 'stringContains';            field: FieldPath; value: string }
  | { op: 'arrayContains';            field: FieldPath; value: Comparable }
  | { op: 'and' | 'or';                clauses: Filter[] }
  | { op: 'not';                       clause: Filter };

/** One sort term of a query. Backends append `id` as a final tiebreaker so ordering is total. */
export interface SortSpec {
  /** Field to order by. */
  field: FieldPath;
  /** Sort direction. */
  dir:   'asc' | 'desc';
}

/**
 * A store query: filter, ordered page fetch. `cursor` is opaque and backend-issued — pass a
 * previous result's cursor back to fetch the next page.
 */
export interface StoreQuery {
  /** Optional root filter clause; absent matches everything. */
  where?:  Filter;
  /** Optional ordering, applied in sequence. */
  sort?:   SortSpec[];
  /** Optional maximum number of items per page. */
  limit?:  number;
  /** Opaque continuation token from a previous {@link QueryResult}. */
  cursor?: string;
}

/** One page of query results. */
export interface QueryResult<T> {
  /** The documents in this page, in query order. */
  items:   T[];
  cursor?: string;   // present iff more pages may follow
  total?:  number;   // optional — omitted by backends that cannot count cheaply
}

/** Machine-readable reason a query was rejected at the validation boundary. */
export type StoreQueryErrorCode =
  | 'UNKNOWN_OP'      // an `op` outside the closed union
  | 'OPERAND_TYPE'    // operand is the wrong type for the op (e.g. boolean to `gt`)
  | 'NULL_OPERAND'    // null compared directly — use `exists` instead
  | 'EMPTY_FIELD'     // empty field path or empty path segment
  | 'EMPTY_CLAUSES'   // and/or with no clauses
  | 'MALFORMED';      // structurally invalid node (or unreadable cursor)

/**
 * Thrown at the query boundary (before any backend touches data) with a JSON `pointer` into the
 * offending node, so an LLM author can locate and fix the clause and retry. Lives in plugin-api
 * so cross-plugin `instanceof` works.
 */
export class StoreQueryError extends Error {
  /** JSON pointer to the offending query node. */
  readonly pointer: string;
  /** Machine-readable failure reason. */
  readonly code:    StoreQueryErrorCode;
  /**
   * @param message - Human-readable description of the defect.
   * @param pointer - JSON pointer into the offending query node.
   * @param code - Machine-readable failure reason.
   */
  constructor(message: string, pointer: string, code: StoreQueryErrorCode) {
    super(message);
    this.name    = 'StoreQueryError';
    this.pointer = pointer;
    this.code    = code;
  }
}
