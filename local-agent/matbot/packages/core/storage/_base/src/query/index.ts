/**
 * Barrel of the query engine: field access, filter compilation, validation, sorting,
 * pagination, and reference execution.
 * @module
 */
export { getField, pathSegments } from './access.js';
export { compileFilter }           from './compile.js';
export { validateQuery }           from './validate.js';
export { applySort }               from './sort.js';
export { encodeCursor, decodeCursor, type PageState } from './paginate.js';
export { executeQuery }            from './execute.js';
