import type { JSONSchema } from './types.js';

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

type SchemaObject = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function resolveRef(schema: JSONSchema, ref: string): JSONSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = schema;
  for (const seg of ref.slice(2).split('/')) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as SchemaObject)[key];
  }
  return node as JSONSchema;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function validateAgainstSchema(
  value: unknown,
  schema: JSONSchema,
  issues: SchemaValidationIssue[] = [],
  path = '$',
  root: JSONSchema = schema,
): SchemaValidationIssue[] {
  if (issues.length >= 20) return issues;
  const s = schema as SchemaObject | boolean | null | undefined;
  if (s === true || s === undefined || s === null) return issues;
  if (s === false) { issues.push({ path, message: 'schema forbids any value here' }); return issues; }

  const ref = s['$ref'];
  if (typeof ref === 'string') {
    const target = resolveRef(root, ref);
    if (target !== undefined) validateAgainstSchema(value, target, issues, path, root);
    return issues;
  }

  const expectedTypes = Array.isArray(s['type']) ? s['type'] as string[] : (s['type'] !== undefined ? [s['type'] as string] : []);
  const anyOfSpecs = Array.isArray(s['anyOf']) ? s['anyOf'] as JSONSchema[] : undefined;
  const oneOfSpecs = Array.isArray(s['oneOf']) ? s['oneOf'] as JSONSchema[] : undefined;
  const matchesType = expectedTypes.length === 0
    ? true
    : expectedTypes.some(t => t === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : typeOf(value) === t);

  if (!matchesType && anyOfSpecs === undefined && oneOfSpecs === undefined) {
    issues.push({ path, message: `expected ${expectedTypes.join(' or ')}, got ${typeOf(value)}` });
    return issues;
  }
  if (!matchesType) return issues;

  const allOf = Array.isArray(s['allOf']) ? s['allOf'] as JSONSchema[] : undefined;
  for (const sub of allOf ?? []) validateAgainstSchema(value, sub, issues, path, root);

  if (anyOfSpecs !== undefined) {
    const pass = anyOfSpecs.some(sub => validateAgainstSchema(value, sub, [], path, root).length === 0);
    if (!pass) issues.push({ path, message: 'did not match any of the allowed shapes (anyOf)' });
  } else if (oneOfSpecs !== undefined) {
    const passing = oneOfSpecs.filter(sub => validateAgainstSchema(value, sub, [], path, root).length === 0).length;
    if (passing !== 1) issues.push({ path, message: `matched ${passing} oneOf branches; exactly one is required` });
  }

  if ('const' in s && !deepEqual(value, s['const'])) {
    issues.push({ path, message: `must be exactly ${JSON.stringify(s['const'])}` });
  }
  if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).some(v => deepEqual(value, v))) {
    issues.push({ path, message: `must be one of ${(s['enum'] as unknown[]).map(v => JSON.stringify(v)).join(', ')}` });
  }

  if (typeof value === 'number') {
    const min = s['minimum']; const max = s['maximum'];
    const exMin = s['exclusiveMinimum']; const exMax = s['exclusiveMaximum'];
    if (typeof min === 'number' && value < min) issues.push({ path, message: `must be >= ${min}` });
    if (typeof max === 'number' && value > max) issues.push({ path, message: `must be <= ${max}` });
    if (typeof exMin === 'number' && value <= exMin) issues.push({ path, message: `must be > ${exMin}` });
    if (typeof exMax === 'number' && value >= exMax) issues.push({ path, message: `must be < ${exMax}` });
  }
  if (typeof value === 'string') {
    const minLen = s['minLength']; const maxLen = s['maxLength'];
    if (typeof minLen === 'number' && value.length < minLen) issues.push({ path, message: `must be at least ${minLen} characters` });
    if (typeof maxLen === 'number' && value.length > maxLen) issues.push({ path, message: `must be at most ${maxLen} characters` });
    if (typeof s['pattern'] === 'string') {
      try {
        if (!new RegExp(s['pattern']).test(value)) issues.push({ path, message: `does not match pattern "${s['pattern']}"` });
      } catch { /* invalid regex in the schema itself — ignore */ }
    }
  }
  if (Array.isArray(value)) {
    const minItems = s['minItems']; const maxItems = s['maxItems'];
    if (typeof minItems === 'number' && value.length < minItems) issues.push({ path, message: `needs at least ${minItems} items` });
    if (typeof maxItems === 'number' && value.length > maxItems) issues.push({ path, message: `allows at most ${maxItems} items` });
    const items = s['items'];
    value.forEach((item, i) => { if (items !== undefined) validateAgainstSchema(item, items as JSONSchema, issues, `${path}[${i}]`, root); });
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const required = Array.isArray(s['required']) ? s['required'] as string[] : [];
    for (const key of required) {
      if (!(key in (value as SchemaObject))) issues.push({ path, message: `missing required property "${key}"` });
    }
    const props = (s['properties'] ?? {}) as Record<string, JSONSchema>;
    const obj = value as SchemaObject;
    for (const [key, v] of Object.entries(obj)) {
      if (props[key] !== undefined) {
        validateAgainstSchema(v, props[key], issues, `${path}.${key}`, root);
      } else if (s['additionalProperties'] === false) {
        issues.push({ path: `${path}.${key}`, message: 'unknown property (only declared properties are allowed)' });
      } else if (s['additionalProperties'] && typeof s['additionalProperties'] === 'object') {
        validateAgainstSchema(v, s['additionalProperties'] as JSONSchema, issues, `${path}.${key}`, root);
      }
    }
  }
  return issues;
}

export function formatValidationIssues(toolName: string, issues: SchemaValidationIssue[]): string {
  const listed = issues.slice(0, 5).map(i => `  - ${i.path}: ${i.message}`).join('\n');
  const more = issues.length > 5 ? `\n  …and ${issues.length - 5} more` : '';
  return `Invalid input for tool '${toolName}' — the call was not executed. Fix these and retry:\n${listed}${more}`;
}
