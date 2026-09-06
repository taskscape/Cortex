import { createHash, randomUUID } from 'node:crypto';
import { PLUGIN_API_VERSION, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type {
  MatbotMachine,
  MatbotPluginSpec,
  Principal,
  Store,
  StoreQuery,
  Tool,
  ToolContext,
  ToolEvent,
  ToolCallContext,
  ToolResultContext,
} from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    readonly ConnectorRegistry?: ConnectorRegistry;
  }
}

/** Wire protocol a connector speaks. */
export type ConnectorProtocol = 'native' | 'mcp' | 'postgres' | 'http';
/** Access level a connector, binding, or action requires or grants. */
export type ConnectorCapability = 'read' | 'write' | 'admin';
/** Data-sensitivity classification applied to connector tool bindings. */
export type ConnectorSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
/** How a connector instance authenticates to its backing system. */
export type ConnectorAuthMode = 'none' | 'api_key' | 'oauth_user' | 'oauth_service' | 'windows';
/** Liveness classification of a connector instance. */
export type ConnectorHealthState = 'unknown' | 'healthy' | 'degraded' | 'down';
/** Outcome recorded for an audited connector tool call. */
export type ConnectorAuditStatus = 'allowed' | 'denied' | 'error';

/** Catalogued connector type: what protocol it speaks and what it can do. */
export interface ConnectorDefinition {
  id: string;
  version: string;
  type: string;
  displayName: string;
  protocol: ConnectorProtocol;
  sourceTypes: string[];
  capabilities: ConnectorCapability[];
  createdAt: string;
  updatedAt: string;
  description?: string;
}

/** Partial definition accepted by `upsertDefinition`; omitted fields keep existing values. */
export type ConnectorDefinitionInput = {
  id?: string;
  type: string;
  displayName: string;
  protocol: ConnectorProtocol;
  sourceTypes?: string[];
  capabilities?: ConnectorCapability[];
  description?: string;
};

/** A configured, workspace-scoped deployment of a connector definition. */
export interface ConnectorInstance {
  id: string;
  version: string;
  definitionId: string;
  type: string;
  workspaceId: string;
  displayName: string;
  ownerPrincipalId: string;
  authMode: ConnectorAuthMode;
  scopes: string[];
  readEnabled: boolean;
  writeEnabled: boolean;
  healthState: ConnectorHealthState;
  createdAt: string;
  updatedAt: string;
  credentialRef?: string;
  syncCadence?: string;
  lastSyncAt?: string;
  nextSyncAt?: string;
}

/** Partial instance accepted by `upsertInstance`; omitted fields keep existing values. */
export type ConnectorInstanceInput = {
  id?: string;
  definitionId: string;
  type: string;
  workspaceId: string;
  displayName: string;
  ownerPrincipalId?: string;
  authMode?: ConnectorAuthMode;
  credentialRef?: string;
  scopes?: string[];
  readEnabled?: boolean;
  writeEnabled?: boolean;
  healthState?: ConnectorHealthState;
  syncCadence?: string;
  lastSyncAt?: string;
  nextSyncAt?: string;
};

/** Authorization grant letting a principal use specific tools of one connector instance,
 *  subject to scopes, tool allow/deny lists, sensitive-field redaction, approval rules, and expiry. */
export interface ConnectorGrant {
  id: string;
  version: string;
  connectorInstanceId: string;
  principalId: string;
  scopes: string[];
  allowedTools: string[];
  deniedTools: string[];
  sensitiveFields: string[];
  approvalRules: string[];
  createdAt: string;
  updatedAt: string;
  effectiveUserId?: string;
  expiresAt?: string;
}

/** Partial grant accepted by `upsertGrant`; omitted fields keep existing values. */
export type ConnectorGrantInput = {
  id?: string;
  connectorInstanceId: string;
  principalId: string;
  effectiveUserId?: string;
  scopes?: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  sensitiveFields?: string[];
  approvalRules?: string[];
  expiresAt?: string;
};

/** Maps a connector capability onto a registered tool name/prefix, with policy metadata used for enforcement and audit. */
export interface ConnectorToolBinding {
  id: string;
  version: string;
  connectorInstanceId: string;
  capability: ConnectorCapability;
  sourceTypes: string[];
  sensitivity: ConnectorSensitivity;
  createdAt: string;
  updatedAt: string;
  toolName?: string;
  toolNamePrefix?: string;
  requiredScopes?: string[];
  inputActionField?: string;
  actionCapabilities?: Record<string, ConnectorCapability>;
  approvalPolicyId?: string;
  sensitiveFields?: string[];
  description?: string;
}

/** Partial binding accepted by `upsertToolBinding`; omitted fields keep existing values. */
export type ConnectorToolBindingInput = {
  id?: string;
  connectorInstanceId: string;
  capability: ConnectorCapability;
  sourceTypes?: string[];
  sensitivity?: ConnectorSensitivity;
  toolName?: string;
  toolNamePrefix?: string;
  requiredScopes?: string[];
  inputActionField?: string;
  actionCapabilities?: Record<string, ConnectorCapability>;
  approvalPolicyId?: string;
  sensitiveFields?: string[];
  description?: string;
};

/** Persisted incremental-sync position for one connector instance (per cursor kind/partition). */
export interface ConnectorSyncCursor {
  id: string;
  version: string;
  connectorInstanceId: string;
  cursorKind: string;
  cursor: string;
  updatedAt: string;
  partitionKey?: string;
}

/** Fields accepted by `upsertSyncCursor`. */
export type ConnectorSyncCursorInput = {
  id?: string;
  connectorInstanceId: string;
  cursorKind: string;
  cursor: string;
  partitionKey?: string;
};

/** Recorded health-check result for a connector instance. */
export interface ConnectorHealthEvent {
  id: string;
  version: string;
  connectorInstanceId: string;
  state: ConnectorHealthState;
  checkedAt: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** Fields accepted by `recordHealth`. */
export type ConnectorHealthInput = {
  connectorInstanceId: string;
  state: ConnectorHealthState;
  checkedAt?: string;
  message?: string;
  details?: Record<string, unknown>;
};

/** Immutable audit record of one connector-backed tool call (allow/deny/error) with input/output hashes. */
export interface ConnectorAuditEvent {
  id: string;
  version: string;
  timestamp: string;
  connectorInstanceId: string;
  workspaceId: string;
  toolName: string;
  capability: ConnectorCapability;
  status: ConnectorAuditStatus;
  allowed: boolean;
  principalId: string;
  sourceIds: string[];
  toolCallId?: string;
  traceId?: string;
  workflowRunId?: string;
  providerName?: string;
  action?: string;
  inputHash?: string;
  resultHash?: string;
  durationMs?: number;
  sensitivity?: ConnectorSensitivity;
  approvalPolicyId?: string;
  message?: string;
  errorMessage?: string;
}

/** Fields accepted by `recordAudit`; missing fields are defaulted or omitted. */
export type ConnectorAuditInput = {
  connectorInstanceId: string;
  workspaceId: string;
  toolName: string;
  capability: ConnectorCapability;
  status: ConnectorAuditStatus;
  allowed: boolean;
  principalId: string;
  sourceIds?: string[];
  timestamp?: string;
  toolCallId?: string;
  traceId?: string;
  workflowRunId?: string;
  providerName?: string;
  action?: string;
  inputHash?: string;
  resultHash?: string;
  durationMs?: number;
  sensitivity?: ConnectorSensitivity;
  approvalPolicyId?: string;
  message?: string;
  errorMessage?: string;
};

/** Result of evaluating a tool call against connector bindings, instance state, and grants. */
export interface ConnectorPolicyDecision {
  bound: boolean;
  allowed: boolean;
  principalId: string;
  toolName: string;
  action?: string;
  capability?: ConnectorCapability;
  binding?: ConnectorToolBinding;
  connectorInstance?: ConnectorInstance;
  grant?: ConnectorGrant;
  reason?: string;
  requiredScopes?: string[];
  approvalPolicyId?: string;
}

/** Input to `evaluateToolCall`. */
export interface ConnectorPolicyInput {
  toolName: string;
  input: unknown;
  principal?: Principal;
}

/** Registry over connector definitions, instances, grants, bindings,
 *  sync cursors, health events, and audit events; plus the tool-call policy evaluator. */
export interface ConnectorRegistry {
  /** Deterministic store id for a definition of the given type.
   * @param type Connector type.
   * @returns Stable id derived from the type name. */
  stableConnectorDefinitionId(type: string): string;
  /** Deterministic store id for an instance.
   * @param workspaceId Owning workspace.
   * @param type Connector type.
   * @param displayName Instance display name.
   * @returns Hash-derived stable id. */
  stableConnectorInstanceId(workspaceId: string, type: string, displayName: string): string;
  /** Deterministic store id for a grant.
   * @param connectorInstanceId Target connector instance.
   * @param principalId Granted principal ('*' allowed).
   * @param effectiveUserId Optional on-behalf-of user.
   * @returns Hash-derived stable id. */
  stableConnectorGrantId(connectorInstanceId: string, principalId: string, effectiveUserId?: string): string;
  /** Deterministic store id for a tool binding.
   * @param input Binding identity fields.
   * @returns Hash-derived stable id. */
  stableConnectorToolBindingId(input: Pick<ConnectorToolBindingInput, 'connectorInstanceId' | 'toolName' | 'toolNamePrefix'>): string;
  /** Creates or updates a definition (id from the input or its stable-id derivation).
   * @param input Field values; omitted optional fields keep existing ones on update.
   * @returns The stored record. */
  upsertDefinition(input: ConnectorDefinitionInput): Promise<ConnectorDefinition>;
  /** Creates or updates a instance (id from the input or its stable-id derivation).
   * @param input Field values; omitted optional fields keep existing ones on update.
   * @returns The stored record. */
  upsertInstance(input: ConnectorInstanceInput): Promise<ConnectorInstance>;
  /** Creates or updates a grant (id from the input or its stable-id derivation).
   * @param input Field values; omitted optional fields keep existing ones on update.
   * @returns The stored record. */
  upsertGrant(input: ConnectorGrantInput): Promise<ConnectorGrant>;
  /** Creates or updates a tool binding (id from the input or its stable-id derivation).
   * @param input Field values; omitted optional fields keep existing ones on update.
   * @returns The stored record. */
  upsertToolBinding(input: ConnectorToolBindingInput): Promise<ConnectorToolBinding>;
  /** Creates or updates a sync cursor (id from the input or its stable-id derivation).
   * @param input Field values; omitted optional fields keep existing ones on update.
   * @returns The stored record. */
  upsertSyncCursor(input: ConnectorSyncCursorInput): Promise<ConnectorSyncCursor>;
  /** Fetches a ConnectorDefinition by id.
   * @param id Record id.
   * @returns The record, or `null` if absent. */
  getDefinition(id: string): Promise<ConnectorDefinition | null>;
  /** Fetches a ConnectorInstance by id.
   * @param id Record id.
   * @returns The record, or `null` if absent. */
  getInstance(id: string): Promise<ConnectorInstance | null>;
  /** Fetches a ConnectorGrant by id.
   * @param id Record id.
   * @returns The record, or `null` if absent. */
  getGrant(id: string): Promise<ConnectorGrant | null>;
  /** Fetches a ConnectorToolBinding by id.
   * @param id Record id.
   * @returns The record, or `null` if absent. */
  getToolBinding(id: string): Promise<ConnectorToolBinding | null>;
  /** Resolves the binding governing a tool call: exact toolName first, then the longest matching prefix.
   * @param toolName Registered tool name.
   * @returns The best-matching binding, or `null` when the tool is not connector-bound. */
  getBindingForTool(toolName: string): Promise<ConnectorToolBinding | null>;
  /** Queries stored definitions.
   * @param query Optional filter/sort/paging query; empty means all.
   * @returns Matching records. */
  queryDefinitions(query?: StoreQuery): Promise<ConnectorDefinition[]>;
  /** Queries stored instances.
   * @param query Optional filter/sort/paging query; empty means all.
   * @returns Matching records. */
  queryInstances(query?: StoreQuery): Promise<ConnectorInstance[]>;
  /** Queries stored grants.
   * @param query Optional filter/sort/paging query; empty means all.
   * @returns Matching records. */
  queryGrants(query?: StoreQuery): Promise<ConnectorGrant[]>;
  /** Queries stored tool bindings.
   * @param query Optional filter/sort/paging query; empty means all.
   * @returns Matching records. */
  queryToolBindings(query?: StoreQuery): Promise<ConnectorToolBinding[]>;
  /** Queries stored sync cursors.
   * @param query Optional filter/sort/paging query; empty means all.
   * @returns Matching records. */
  querySyncCursors(query?: StoreQuery): Promise<ConnectorSyncCursor[]>;
  /** Records a health event and updates the instance's current health state when it exists.
   * @param input Health observation.
   * @returns The persisted {@link ConnectorHealthEvent}. */
  recordHealth(input: ConnectorHealthInput): Promise<ConnectorHealthEvent>;
  /** Lists recorded health events.
   * @param connectorInstanceId Optional restriction to one instance.
   * @returns Matching events. */
  healthEvents(connectorInstanceId?: string): Promise<ConnectorHealthEvent[]>;
  /** Appends an immutable audit event for a connector tool call.
   * @param input Audit observation (source ids are de-duplicated).
   * @returns The persisted {@link ConnectorAuditEvent}. */
  recordAudit(input: ConnectorAuditInput): Promise<ConnectorAuditEvent>;
  /** Queries stored audit events.
   * @param query Optional filter/sort/paging query; empty means all.
   * @returns Matching records. */
  auditEvents(query?: StoreQuery): Promise<ConnectorAuditEvent[]>;
  /** Evaluates whether a tool call may proceed: resolves the binding, checks instance
   *  availability/read-write flags, then finds an unexpired grant matching the principal,
   *  required scopes, tool/action patterns, and approval rules.
   * @param input Tool name, raw call input, and optional explicit principal.
   * @returns The decision; unbound tools are allowed with `bound: false`. */
  evaluateToolCall(input: ConnectorPolicyInput): Promise<ConnectorPolicyDecision>;
}

const DEFINITION_STORE = 'connector_definitions';
const INSTANCE_STORE = 'connector_instances';
const GRANT_STORE = 'connector_grants';
const TOOL_BINDING_STORE = 'connector_tool_bindings';
const SYNC_CURSOR_STORE = 'connector_sync_cursors';
const HEALTH_STORE = 'connector_health';
const AUDIT_STORE = 'connector_audit_events';

const SYSTEM_PRINCIPAL: Principal = { id: 'system', type: 'system' };

/**
 * Current wall-clock time as an ISO-8601 UTC timestamp.
 *
 * @returns The timestamp, e.g. `2026-01-01T00:00:00.000Z`.
 * @throws Never.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Derives a deterministic, collision-resistant id from ordered identity parts.
 *
 * The parts are NUL-joined, SHA-256 hashed, and truncated to 32 hex characters, so equal
 * parts always yield the same id.
 *
 * @param prefix - Id namespace, used verbatim before the colon.
 * @param parts - Ordered identity parts; their order determines the id.
 * @returns `${prefix}:<32 hex chars>`.
 * @throws Never.
 */
function hashId(prefix: string, parts: readonly string[]): string {
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `${prefix}:${hash}`;
}

/**
 * SHA-256 hash of the canonical JSON encoding of a value, used for audit input/result hashes.
 *
 * @param value - JSON-safe value to hash (typically tool-call input or a redacted result).
 * @returns Full-length hex digest.
 * @throws TypeError - If `value` is not string-encodable JSON (e.g. top-level `undefined`).
 * @throws RangeError - If `value` contains a reference cycle (see {@link canonicalJson}).
 */
function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Serializes a value to JSON with object keys sorted recursively, so structurally equal
 * values always produce identical text regardless of key insertion order.
 *
 * @param value - JSON-safe value; `undefined` serializes to `undefined` (not a string).
 * @returns Canonical JSON text.
 * @throws RangeError - If `value` contains a reference cycle (there is no recursion guard).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * Trims, drops empties, and de-duplicates string values.
 *
 * @param values - Raw values; may contain duplicates and surrounding whitespace.
 * @returns Unique, trimmed, non-empty values in first-occurrence order.
 * @throws Never.
 */
function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

/**
 * Whether an expiry timestamp has passed.
 *
 * @param expiresAt - ISO timestamp; `undefined` means the grant never expires.
 * @param at - Reference time in epoch milliseconds; defaults to now.
 * @returns `true` when `expiresAt` parses to a finite time at or before `at`.
 * @throws Never.
 */
function isExpired(expiresAt: string | undefined, at = Date.now()): boolean {
  if (expiresAt === undefined) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= at;
}

/**
 * Reads a non-blank string action field from a tool-call input object.
 *
 * @param input - Raw tool-call input; non-object inputs yield `undefined`.
 * @param field - Field name to read; defaults to `'action'`.
 * @returns The action string, or `undefined` when the field is absent, blank, or not a string.
 * @throws Never.
 */
function actionFromInput(input: unknown, field = 'action'): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Extracts a workflow run id from tool-call input, from the top-level `workflowRunId`
 * field or, failing that, from `workflow.runId`.
 *
 * @param input - Raw tool-call input; non-object inputs yield `undefined`.
 * @returns The first non-blank run id found, or `undefined`.
 * @throws Never.
 */
function workflowRunIdFromInput(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record['workflowRunId'] === 'string' && record['workflowRunId'].trim() !== '') return record['workflowRunId'];
  const workflow = record['workflow'];
  if (workflow !== null && typeof workflow === 'object' && !Array.isArray(workflow)) {
    const runId = (workflow as Record<string, unknown>)['runId'];
    if (typeof runId === 'string' && runId.trim() !== '') return runId;
  }
  return undefined;
}

/**
 * Resolves the capability a call requires: the action's mapped capability when the input's
 * action field names an entry in the binding's `actionCapabilities`, otherwise the binding's
 * base capability.
 *
 * @param binding - Binding whose capability mapping applies.
 * @param input - Raw tool-call input, read at the binding's `inputActionField` (default `'action'`).
 * @returns The effective capability, plus the action name when one is present.
 * @throws Never.
 */
function resolveCapability(binding: ConnectorToolBinding, input: unknown): { capability: ConnectorCapability; action?: string } {
  const action = actionFromInput(input, binding.inputActionField ?? 'action');
  const mapped = action !== undefined ? binding.actionCapabilities?.[action] : undefined;
  return {
    capability: mapped ?? binding.capability,
    ...(action !== undefined ? { action } : {}),
  };
}

/**
 * Whether a grant's tool pattern covers a tool name and optional action.
 *
 * Pattern forms: `*` (everything), an exact tool name, `tool:action` (that action only),
 * or a trailing `*` as a prefix wildcard.
 *
 * @param pattern - Pattern from a grant's allowed/denied tool list.
 * @param toolName - Registered tool name.
 * @param action - Action within the tool, when known.
 * @returns `true` when the pattern covers the tool/action pair.
 * @throws Never.
 */
function toolMatchesPattern(pattern: string, toolName: string, action?: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  if (action !== undefined && pattern === `${toolName}:${action}`) return true;
  if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * Whether a grant applies to a principal. The wildcard principal `'*'` matches any principal.
 *
 * @param grant - Grant to test.
 * @param principal - Effective call principal.
 * @returns `true` when the grant's principal id equals the principal's id or is `'*'`.
 * @throws Never.
 */
function grantMatchesPrincipal(grant: ConnectorGrant, principal: Principal): boolean {
  return grant.principalId === principal.id || grant.principalId === '*';
}

/**
 * Whether the grant's `deniedTools` patterns cover the tool. Checked before allow lists,
 * so a denial wins over any matching allow pattern.
 *
 * @param grant - Grant to test.
 * @param toolName - Registered tool name.
 * @param action - Action within the tool, when known.
 * @returns `true` when any deny pattern matches.
 * @throws Never.
 */
function grantDeniesTool(grant: ConnectorGrant, toolName: string, action?: string): boolean {
  return grant.deniedTools.some(pattern => toolMatchesPattern(pattern, toolName, action));
}

/**
 * Whether the grant's `allowedTools` patterns cover the tool.
 *
 * @param grant - Grant to test.
 * @param toolName - Registered tool name.
 * @param action - Action within the tool, when known.
 * @returns `true` when any allow pattern matches.
 * @throws Never.
 */
function grantAllowsTool(grant: ConnectorGrant, toolName: string, action?: string): boolean {
  return grant.allowedTools.some(pattern => toolMatchesPattern(pattern, toolName, action));
}

/**
 * Whether the grant's scopes satisfy every required scope. The wildcard scope `'*'`
 * covers all scopes.
 *
 * @param grant - Grant to test.
 * @param requiredScopes - Scopes the call requires; every one must be held.
 * @returns `true` when the grant holds every required scope.
 * @throws Never.
 */
function grantAllowsScopes(grant: ConnectorGrant, requiredScopes: readonly string[]): boolean {
  if (grant.scopes.includes('*')) return true;
  return requiredScopes.every(scope => grant.scopes.includes(scope));
}

/**
 * Whether the grant permits a call gated behind an approval policy. Calls without a policy
 * are always permitted; the wildcard rule `'*'` covers every policy.
 *
 * @param grant - Grant to test.
 * @param approvalPolicyId - Policy gating the call, or `undefined` when ungated.
 * @returns `true` when the call may proceed.
 * @throws Never.
 */
function grantAllowsApproval(grant: ConnectorGrant, approvalPolicyId: string | undefined): boolean {
  if (approvalPolicyId === undefined) return true;
  return grant.approvalRules.includes('*') || grant.approvalRules.includes(approvalPolicyId);
}

/**
 * Scopes a call requires: the effective capability itself plus the binding's extra
 * `requiredScopes`, de-duplicated.
 *
 * @param binding - Binding governing the tool.
 * @param capability - Effective capability of the call.
 * @returns Required scope names.
 * @throws Never.
 */
function requiredScopesFor(binding: ConnectorToolBinding, capability: ConnectorCapability): string[] {
  return uniq([capability, ...(binding.requiredScopes ?? [])]);
}

/**
 * Resolves the principal a policy decision attributes a call to: the explicit principal
 * when given, otherwise the ambient principal if one is established, otherwise the
 * `'system'` principal. Unlike the ambient carrier's `currentPrincipal`, never throws
 * outside a principal scope.
 *
 * @param principal - Explicit principal carried by the call, if any.
 * @returns The effective principal; never `undefined`.
 * @throws Never.
 */
function effectivePrincipal(principal?: Principal): Principal {
  return principal ?? tryCurrentPrincipal() ?? SYSTEM_PRINCIPAL;
}

/**
 * Runs a store query and returns just the matching records.
 *
 * @typeParam T - Record type; must carry `id` and `version`.
 * @param store - Store to query.
 * @param query - Optional filter/sort/paging query; omitted means match all.
 * @returns Matching records in store order.
 * @throws Error - When the store query fails.
 */
async function queryAll<T extends { id: string; version: string }>(store: Store<T>, query?: StoreQuery): Promise<T[]> {
  const result = await store.query(query ?? {});
  return result.items;
}

/**
 * Queries a connector-scoped store, optionally restricted to one connector instance.
 *
 * @typeParam T - Record type; must carry `id`, `version`, and `connectorInstanceId`.
 * @param store - Store to query.
 * @param connectorInstanceId - Instance to filter on; `undefined` matches all instances.
 * @returns Matching records.
 * @throws Error - When the store query fails.
 */
async function queryByConnector<T extends { id: string; version: string; connectorInstanceId: string }>(
  store: Store<T>,
  connectorInstanceId?: string,
): Promise<T[]> {
  if (connectorInstanceId === undefined) return queryAll(store);
  return queryAll(store, { where: { op: 'eq', field: 'connectorInstanceId', value: connectorInstanceId } });
}

/**
 * Recursively collects `sourceId` / `sourceIds` values from a nested value, walking arrays
 * and object properties to a bounded depth with a bounded result size.
 *
 * @param value - Value to walk (typically a redacted tool result).
 * @param out - Set to accumulate into; a fresh set when omitted.
 * @param depth - Current recursion depth; callers normally omit it.
 * @returns The accumulated set of source ids.
 * @throws Never.
 */
function collectSourceIds(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || out.size >= 100) return out;
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectSourceIds(item, out, depth + 1);
    return out;
  }
  const record = value as Record<string, unknown>;
  const sourceId = record['sourceId'];
  if (typeof sourceId === 'string' && sourceId.trim() !== '') out.add(sourceId);
  const sourceIds = record['sourceIds'];
  if (Array.isArray(sourceIds)) {
    for (const item of sourceIds) {
      if (typeof item === 'string' && item.trim() !== '') out.add(item);
    }
  }
  for (const item of Object.values(record)) collectSourceIds(item, out, depth + 1);
  return out;
}

/**
 * Recursively replaces values of object fields whose names match one of the given field
 * names (case-insensitively) with `'[redacted]'`, to a bounded depth. Arrays are traversed;
 * non-object leaves pass through unchanged.
 *
 * @param value - Value to redact (typically a tool result).
 * @param fieldNames - Field names whose values must be redacted; empty means no redaction.
 * @param depth - Current recursion depth; callers normally omit it.
 * @returns A structurally copied value with matching fields redacted.
 * @throws Never.
 */
function redactDeep(value: unknown, fieldNames: readonly string[], depth = 0): unknown {
  if (depth > 8 || fieldNames.length === 0) return value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => redactDeep(item, fieldNames, depth + 1));
  const fields = new Set(fieldNames.map(field => field.toLowerCase()));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = fields.has(key.toLowerCase()) ? '[redacted]' : redactDeep(child, fieldNames, depth + 1);
  }
  return out;
}

/**
 * {@link ConnectorRegistry} implementation backed by seven dedicated stores, one per record
 * kind. Every upsert consults the existing record to preserve omitted fields and `createdAt`,
 * and mints a fresh random `version` on write; reads and queries delegate straight to the
 * stores.
 */
class StoreBackedConnectorRegistry implements ConnectorRegistry {
  private readonly definitions: Store<ConnectorDefinition>;
  private readonly instances: Store<ConnectorInstance>;
  private readonly grants: Store<ConnectorGrant>;
  private readonly bindings: Store<ConnectorToolBinding>;
  private readonly cursors: Store<ConnectorSyncCursor>;
  private readonly health: Store<ConnectorHealthEvent>;
  private readonly audit: Store<ConnectorAuditEvent>;

  /**
   * Captures the pre-created stores; no I/O occurs at construction.
   *
   * @param definitions - Store for {@link ConnectorDefinition} records.
   * @param instances - Store for {@link ConnectorInstance} records.
   * @param grants - Store for {@link ConnectorGrant} records.
   * @param bindings - Store for {@link ConnectorToolBinding} records.
   * @param cursors - Store for {@link ConnectorSyncCursor} records.
   * @param health - Store for {@link ConnectorHealthEvent} records.
   * @param audit - Store for {@link ConnectorAuditEvent} records.
   * @throws Never.
   */
  constructor(
    definitions: Store<ConnectorDefinition>,
    instances: Store<ConnectorInstance>,
    grants: Store<ConnectorGrant>,
    bindings: Store<ConnectorToolBinding>,
    cursors: Store<ConnectorSyncCursor>,
    health: Store<ConnectorHealthEvent>,
    audit: Store<ConnectorAuditEvent>,
  ) {
    this.definitions = definitions;
    this.instances = instances;
    this.grants = grants;
    this.bindings = bindings;
    this.cursors = cursors;
    this.health = health;
    this.audit = audit;
  }

  /**
   * Deterministic store id for a definition of the given type.
   *
   * @param type - Connector type.
   * @returns `connector-definition:<type>`.
   * @throws Never.
   */
  stableConnectorDefinitionId(type: string): string {
    return `connector-definition:${type}`;
  }

  /**
   * Hash-derived stable id for the instance identified by workspace, type, and display name.
   *
   * @param workspaceId - Owning workspace.
   * @param type - Connector type.
   * @param displayName - Instance display name.
   * @returns `connector-instance:<32 hex chars>`.
   * @throws Never.
   */
  stableConnectorInstanceId(workspaceId: string, type: string, displayName: string): string {
    return hashId('connector-instance', [workspaceId, type, displayName]);
  }

  /**
   * Hash-derived stable id for the grant of a principal on an instance. Wildcard and
   * effective-user variants derive distinct ids.
   *
   * @param connectorInstanceId - Target connector instance.
   * @param principalId - Granted principal, or `'*'` for all principals.
   * @param effectiveUserId - Optional on-behalf-of user; omitted means none.
   * @returns `connector-grant:<32 hex chars>`.
   * @throws Never.
   */
  stableConnectorGrantId(connectorInstanceId: string, principalId: string, effectiveUserId?: string): string {
    return hashId('connector-grant', [connectorInstanceId, principalId, effectiveUserId ?? '']);
  }

  /**
   * Hash-derived stable id for the binding identified by instance plus tool name/prefix.
   *
   * @param input - Binding identity fields; unset tool name/prefix hash as empty strings.
   * @returns `connector-tool-binding:<32 hex chars>`.
   * @throws Never.
   */
  stableConnectorToolBindingId(input: Pick<ConnectorToolBindingInput, 'connectorInstanceId' | 'toolName' | 'toolNamePrefix'>): string {
    return hashId('connector-tool-binding', [input.connectorInstanceId, input.toolName ?? '', input.toolNamePrefix ?? '']);
  }

  /**
   * Creates or updates a definition, deriving its id from the input or the stable-id
   * derivation. Omitted optional fields keep the existing record's values (new-record
   * defaults: `capabilities` `['read']`, no description); `createdAt` is preserved on
   * update and a fresh random `version` is minted.
   *
   * @param input - Field values.
   * @returns The stored definition.
   * @throws Error - When the definition store read or write fails.
   */
  async upsertDefinition(input: ConnectorDefinitionInput): Promise<ConnectorDefinition> {
    const id = input.id ?? this.stableConnectorDefinitionId(input.type);
    const existing = await this.definitions.get(id);
    const timestamp = nowIso();
    const definition: ConnectorDefinition = {
      id,
      version: randomUUID(),
      type: input.type,
      displayName: input.displayName,
      protocol: input.protocol,
      sourceTypes: uniq(input.sourceTypes ?? existing?.sourceTypes ?? []),
      capabilities: uniq(input.capabilities ?? existing?.capabilities ?? ['read']) as ConnectorCapability[],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(input.description ?? existing?.description !== undefined ? { description: (input.description ?? existing?.description)! } : {}),
    };
    await this.definitions.set(id, definition);
    return definition;
  }

  /**
   * Creates or updates an instance, deriving its id from the input or the stable-id
   * derivation. Omitted optional fields keep the existing record's values (new-record
   * defaults: owner `'system'`, auth mode `'none'`, read enabled, write disabled, health
   * `'unknown'`); `createdAt` is preserved and a fresh random `version` is minted.
   *
   * @param input - Field values.
   * @returns The stored instance.
   * @throws Error - When the instance store read or write fails.
   */
  async upsertInstance(input: ConnectorInstanceInput): Promise<ConnectorInstance> {
    const id = input.id ?? this.stableConnectorInstanceId(input.workspaceId, input.type, input.displayName);
    const existing = await this.instances.get(id);
    const timestamp = nowIso();
    const instance: ConnectorInstance = {
      id,
      version: randomUUID(),
      definitionId: input.definitionId,
      type: input.type,
      workspaceId: input.workspaceId,
      displayName: input.displayName,
      ownerPrincipalId: input.ownerPrincipalId ?? existing?.ownerPrincipalId ?? 'system',
      authMode: input.authMode ?? existing?.authMode ?? 'none',
      scopes: uniq(input.scopes ?? existing?.scopes ?? []),
      readEnabled: input.readEnabled ?? existing?.readEnabled ?? true,
      writeEnabled: input.writeEnabled ?? existing?.writeEnabled ?? false,
      healthState: input.healthState ?? existing?.healthState ?? 'unknown',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(input.credentialRef ?? existing?.credentialRef !== undefined ? { credentialRef: (input.credentialRef ?? existing?.credentialRef)! } : {}),
      ...(input.syncCadence ?? existing?.syncCadence !== undefined ? { syncCadence: (input.syncCadence ?? existing?.syncCadence)! } : {}),
      ...(input.lastSyncAt ?? existing?.lastSyncAt !== undefined ? { lastSyncAt: (input.lastSyncAt ?? existing?.lastSyncAt)! } : {}),
      ...(input.nextSyncAt ?? existing?.nextSyncAt !== undefined ? { nextSyncAt: (input.nextSyncAt ?? existing?.nextSyncAt)! } : {}),
    };
    await this.instances.set(id, instance);
    return instance;
  }

  /**
   * Creates or updates a grant, deriving its id from the input or the stable-id derivation.
   * Omitted optional fields keep the existing record's values (empty lists for new grants);
   * `createdAt` is preserved and a fresh random `version` is minted.
   *
   * @param input - Field values.
   * @returns The stored grant.
   * @throws Error - When the grant store read or write fails.
   */
  async upsertGrant(input: ConnectorGrantInput): Promise<ConnectorGrant> {
    const id = input.id ?? this.stableConnectorGrantId(input.connectorInstanceId, input.principalId, input.effectiveUserId);
    const existing = await this.grants.get(id);
    const timestamp = nowIso();
    const grant: ConnectorGrant = {
      id,
      version: randomUUID(),
      connectorInstanceId: input.connectorInstanceId,
      principalId: input.principalId,
      scopes: uniq(input.scopes ?? existing?.scopes ?? []),
      allowedTools: uniq(input.allowedTools ?? existing?.allowedTools ?? []),
      deniedTools: uniq(input.deniedTools ?? existing?.deniedTools ?? []),
      sensitiveFields: uniq(input.sensitiveFields ?? existing?.sensitiveFields ?? []),
      approvalRules: uniq(input.approvalRules ?? existing?.approvalRules ?? []),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(input.effectiveUserId ?? existing?.effectiveUserId !== undefined ? { effectiveUserId: (input.effectiveUserId ?? existing?.effectiveUserId)! } : {}),
      ...(input.expiresAt ?? existing?.expiresAt !== undefined ? { expiresAt: (input.expiresAt ?? existing?.expiresAt)! } : {}),
    };
    await this.grants.set(id, grant);
    return grant;
  }

  /**
   * Creates or updates a tool binding, deriving its id from the input or the stable-id
   * derivation. Omitted optional fields keep the existing record's values (default
   * sensitivity `'internal'`); `createdAt` is preserved and a fresh random `version` is
   * minted.
   *
   * @param input - Field values; must yield `toolName` or `toolNamePrefix` after merging.
   * @returns The stored binding.
   * @throws Error - When neither `toolName` nor `toolNamePrefix` is set.
   * @throws Error - When the binding store read or write fails.
   */
  async upsertToolBinding(input: ConnectorToolBindingInput): Promise<ConnectorToolBinding> {
    const id = input.id ?? this.stableConnectorToolBindingId(input);
    const existing = await this.bindings.get(id);
    const timestamp = nowIso();
    const binding: ConnectorToolBinding = {
      id,
      version: randomUUID(),
      connectorInstanceId: input.connectorInstanceId,
      capability: input.capability,
      sourceTypes: uniq(input.sourceTypes ?? existing?.sourceTypes ?? []),
      sensitivity: input.sensitivity ?? existing?.sensitivity ?? 'internal',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(input.toolName ?? existing?.toolName !== undefined ? { toolName: (input.toolName ?? existing?.toolName)! } : {}),
      ...(input.toolNamePrefix ?? existing?.toolNamePrefix !== undefined ? { toolNamePrefix: (input.toolNamePrefix ?? existing?.toolNamePrefix)! } : {}),
      ...(input.requiredScopes ?? existing?.requiredScopes !== undefined ? { requiredScopes: uniq(input.requiredScopes ?? existing?.requiredScopes ?? []) } : {}),
      ...(input.inputActionField ?? existing?.inputActionField !== undefined ? { inputActionField: (input.inputActionField ?? existing?.inputActionField)! } : {}),
      ...(input.actionCapabilities ?? existing?.actionCapabilities !== undefined ? { actionCapabilities: input.actionCapabilities ?? existing?.actionCapabilities ?? {} } : {}),
      ...(input.approvalPolicyId ?? existing?.approvalPolicyId !== undefined ? { approvalPolicyId: (input.approvalPolicyId ?? existing?.approvalPolicyId)! } : {}),
      ...(input.sensitiveFields ?? existing?.sensitiveFields !== undefined ? { sensitiveFields: uniq(input.sensitiveFields ?? existing?.sensitiveFields ?? []) } : {}),
      ...(input.description ?? existing?.description !== undefined ? { description: (input.description ?? existing?.description)! } : {}),
    };
    if (binding.toolName === undefined && binding.toolNamePrefix === undefined) {
      throw new Error('Connector tool binding requires toolName or toolNamePrefix.');
    }
    await this.bindings.set(id, binding);
    return binding;
  }

  /**
   * Creates or updates a sync cursor, deriving its id from the instance, cursor kind, and
   * partition key. No existing record is consulted: the cursor value is replaced wholesale
   * and `updatedAt` is set to now.
   *
   * @param input - Cursor fields.
   * @returns The stored cursor.
   * @throws Error - When the cursor store write fails.
   */
  async upsertSyncCursor(input: ConnectorSyncCursorInput): Promise<ConnectorSyncCursor> {
    const id = input.id ?? hashId('connector-sync-cursor', [
      input.connectorInstanceId,
      input.cursorKind,
      input.partitionKey ?? '',
    ]);
    const cursor: ConnectorSyncCursor = {
      id,
      version: randomUUID(),
      connectorInstanceId: input.connectorInstanceId,
      cursorKind: input.cursorKind,
      cursor: input.cursor,
      updatedAt: nowIso(),
      ...(input.partitionKey !== undefined ? { partitionKey: input.partitionKey } : {}),
    };
    await this.cursors.set(id, cursor);
    return cursor;
  }

  /**
   * Fetches a definition by id.
   *
   * @param id - Record id.
   * @returns The definition, or `null` when absent.
   * @throws Error - When the store read fails.
   */
  getDefinition(id: string): Promise<ConnectorDefinition | null> {
    return this.definitions.get(id);
  }

  /**
   * Fetches an instance by id.
   *
   * @param id - Record id.
   * @returns The instance, or `null` when absent.
   * @throws Error - When the store read fails.
   */
  getInstance(id: string): Promise<ConnectorInstance | null> {
    return this.instances.get(id);
  }

  /**
   * Fetches a grant by id.
   *
   * @param id - Record id.
   * @returns The grant, or `null` when absent.
   * @throws Error - When the store read fails.
   */
  getGrant(id: string): Promise<ConnectorGrant | null> {
    return this.grants.get(id);
  }

  /**
   * Fetches a tool binding by id.
   *
   * @param id - Record id.
   * @returns The binding, or `null` when absent.
   * @throws Error - When the store read fails.
   */
  getToolBinding(id: string): Promise<ConnectorToolBinding | null> {
    return this.bindings.get(id);
  }

  /**
   * Resolves the binding governing a tool: exact `toolName` matches win; otherwise the
   * longest `toolNamePrefix` that the tool name starts with.
   *
   * @param toolName - Registered tool name.
   * @returns The best-matching binding, or `null` when the tool is not connector-bound.
   * @throws Error - When the binding query fails.
   */
  async getBindingForTool(toolName: string): Promise<ConnectorToolBinding | null> {
    const bindings = await this.queryToolBindings();
    const exact = bindings.find(binding => binding.toolName === toolName);
    if (exact !== undefined) return exact;
    const prefixes = bindings
      .filter(binding => binding.toolNamePrefix !== undefined && toolName.startsWith(binding.toolNamePrefix))
      .sort((left, right) => (right.toolNamePrefix?.length ?? 0) - (left.toolNamePrefix?.length ?? 0));
    return prefixes[0] ?? null;
  }

  /**
   * Queries stored definitions.
   *
   * @param query - Optional filter/sort/paging query; omitted means all.
   * @returns Matching records.
   * @throws Error - When the store query fails.
   */
  queryDefinitions(query?: StoreQuery): Promise<ConnectorDefinition[]> {
    return queryAll(this.definitions, query);
  }

  /**
   * Queries stored instances.
   *
   * @param query - Optional filter/sort/paging query; omitted means all.
   * @returns Matching records.
   * @throws Error - When the store query fails.
   */
  queryInstances(query?: StoreQuery): Promise<ConnectorInstance[]> {
    return queryAll(this.instances, query);
  }

  /**
   * Queries stored grants.
   *
   * @param query - Optional filter/sort/paging query; omitted means all.
   * @returns Matching records.
   * @throws Error - When the store query fails.
   */
  queryGrants(query?: StoreQuery): Promise<ConnectorGrant[]> {
    return queryAll(this.grants, query);
  }

  /**
   * Queries stored tool bindings.
   *
   * @param query - Optional filter/sort/paging query; omitted means all.
   * @returns Matching records.
   * @throws Error - When the store query fails.
   */
  queryToolBindings(query?: StoreQuery): Promise<ConnectorToolBinding[]> {
    return queryAll(this.bindings, query);
  }

  /**
   * Queries stored sync cursors.
   *
   * @param query - Optional filter/sort/paging query; omitted means all.
   * @returns Matching records.
   * @throws Error - When the store query fails.
   */
  querySyncCursors(query?: StoreQuery): Promise<ConnectorSyncCursor[]> {
    return queryAll(this.cursors, query);
  }

  /**
   * Records a health event and, when the instance exists, updates its current health state
   * (plain overwrite: fresh `version`, `updatedAt` set to now). When the instance is absent
   * only the event is stored.
   *
   * @param input - Health observation; `checkedAt` defaults to now.
   * @returns The persisted event, with a fresh random id and version.
   * @throws Error - When the instance or health store write fails.
   */
  async recordHealth(input: ConnectorHealthInput): Promise<ConnectorHealthEvent> {
    const instance = await this.instances.get(input.connectorInstanceId);
    if (instance !== null) {
      await this.instances.set(instance.id, {
        ...instance,
        version: randomUUID(),
        healthState: input.state,
        updatedAt: nowIso(),
      });
    }
    const event: ConnectorHealthEvent = {
      id: randomUUID(),
      version: randomUUID(),
      connectorInstanceId: input.connectorInstanceId,
      state: input.state,
      checkedAt: input.checkedAt ?? nowIso(),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.details !== undefined ? { details: input.details } : {}),
    };
    await this.health.set(event.id, event);
    return event;
  }

  /**
   * Lists recorded health events, optionally restricted to one instance.
   *
   * @param connectorInstanceId - Instance to filter on; `undefined` matches all instances.
   * @returns Matching events.
   * @throws Error - When the store query fails.
   */
  healthEvents(connectorInstanceId?: string): Promise<ConnectorHealthEvent[]> {
    return queryByConnector(this.health, connectorInstanceId);
  }

  /**
   * Appends an immutable audit event for a connector tool call. Source ids are trimmed and
   * de-duplicated; unset optional fields are omitted from the record.
   *
   * @param input - Audit observation; `timestamp` defaults to now.
   * @returns The persisted event, with a fresh random id and version.
   * @throws Error - When the audit store write fails.
   */
  async recordAudit(input: ConnectorAuditInput): Promise<ConnectorAuditEvent> {
    const event: ConnectorAuditEvent = {
      id: randomUUID(),
      version: randomUUID(),
      timestamp: input.timestamp ?? nowIso(),
      connectorInstanceId: input.connectorInstanceId,
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      capability: input.capability,
      status: input.status,
      allowed: input.allowed,
      principalId: input.principalId,
      sourceIds: uniq(input.sourceIds ?? []),
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.workflowRunId !== undefined ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.providerName !== undefined ? { providerName: input.providerName } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.inputHash !== undefined ? { inputHash: input.inputHash } : {}),
      ...(input.resultHash !== undefined ? { resultHash: input.resultHash } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      ...(input.approvalPolicyId !== undefined ? { approvalPolicyId: input.approvalPolicyId } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    };
    await this.audit.set(event.id, event);
    return event;
  }

  /**
   * Queries stored audit events.
   *
   * @param query - Optional filter/sort/paging query; omitted means all.
   * @returns Matching events.
   * @throws Error - When the store query fails.
   */
  auditEvents(query?: StoreQuery): Promise<ConnectorAuditEvent[]> {
    return queryAll(this.audit, query);
  }

  /**
   * Evaluates whether a tool call may proceed. Unbound tools are allowed with `bound: false`.
   * For bound tools it checks, in order: the instance exists, the connector is not down, the
   * instance's read/write flags cover the effective capability, and an unexpired grant for
   * the principal exists that does not deny, and does allow, the tool/action with the
   * required scopes and approval policy. The principal falls back to the ambient principal,
   * then to `'system'`.
   *
   * @param input - Tool name, raw call input, and optional explicit principal.
   * @returns The decision; `binding`, `connectorInstance`, and `grant` are set when bound,
   *   and `reason` explains any denial.
   * @throws Error - When the binding, instance, or grant queries fail.
   */
  async evaluateToolCall(input: ConnectorPolicyInput): Promise<ConnectorPolicyDecision> {
    const principal = effectivePrincipal(input.principal);
    const binding = await this.getBindingForTool(input.toolName);
    if (binding === null) {
      return {
        bound: false,
        allowed: true,
        principalId: principal.id,
        toolName: input.toolName,
      };
    }

    const instance = await this.instances.get(binding.connectorInstanceId);
    const { capability, action } = resolveCapability(binding, input.input);
    const requiredScopes = requiredScopesFor(binding, capability);
    const approvalPolicyId = capability === 'read' ? undefined : binding.approvalPolicyId;
    const base: Omit<ConnectorPolicyDecision, 'allowed'> = {
      bound: true,
      principalId: principal.id,
      toolName: input.toolName,
      capability,
      binding,
      requiredScopes,
      ...(action !== undefined ? { action } : {}),
      ...(approvalPolicyId !== undefined ? { approvalPolicyId } : {}),
      ...(instance !== null ? { connectorInstance: instance } : {}),
    };

    if (instance === null) {
      return { ...base, allowed: false, reason: `No connector instance registered for tool "${input.toolName}".` };
    }
    if (instance.healthState === 'down') {
      return { ...base, allowed: false, connectorInstance: instance, reason: `Connector "${instance.displayName}" is down.` };
    }
    if (capability === 'read' && !instance.readEnabled) {
      return { ...base, allowed: false, connectorInstance: instance, reason: `Read access is disabled for connector "${instance.displayName}".` };
    }
    if ((capability === 'write' || capability === 'admin') && !instance.writeEnabled) {
      return { ...base, allowed: false, connectorInstance: instance, reason: `Write access is disabled for connector "${instance.displayName}".` };
    }

    const grants = (await this.queryGrants({
      where: { op: 'eq', field: 'connectorInstanceId', value: binding.connectorInstanceId },
    })).filter(grant => grantMatchesPrincipal(grant, principal) && !isExpired(grant.expiresAt));

    const denyingGrant = grants.find(grant => grantDeniesTool(grant, input.toolName, action));
    if (denyingGrant !== undefined) {
      return {
        ...base,
        allowed: false,
        connectorInstance: instance,
        grant: denyingGrant,
        reason: `Connector grant denies tool "${input.toolName}" for principal "${principal.id}".`,
      };
    }

    const allowingGrant = grants.find(grant =>
      grantAllowsTool(grant, input.toolName, action)
      && grantAllowsScopes(grant, requiredScopes)
      && grantAllowsApproval(grant, approvalPolicyId));
    if (allowingGrant === undefined) {
      return {
        ...base,
        allowed: false,
        connectorInstance: instance,
        reason: `No active connector grant allows ${capability} tool "${input.toolName}" for principal "${principal.id}".`,
      };
    }

    return {
      ...base,
      allowed: true,
      connectorInstance: instance,
      grant: allowingGrant,
    };
  }
}

/**
 * Parsed input shape accepted by the `connector_action` tool; fields beyond `action` are
 * consumed by the matching action (see {@link createConnectorActionTool}).
 */
interface ConnectorActionInput {
  action: string;
  id?: string;
  connectorInstanceId?: string;
  definitionId?: string;
  query?: StoreQuery;
  principalId?: string;
  grant?: ConnectorGrantInput;
  cursor?: ConnectorSyncCursorInput;
  state?: ConnectorHealthState;
  message?: string;
}

/**
 * Builds the `connector_action` admin tool over a registry: list/get of definitions,
 * instances, grants, and bindings, grant and sync-cursor writes, health listing and
 * synthetic health tests, and audit listing. Validation failures, unknown actions, and
 * registry errors are reported as `error` events rather than thrown.
 *
 * @param registry - Registry the tool operates on.
 * @param services - Machine used to resolve registered tools for the `test_health` action.
 * @returns The tool definition.
 * @throws Never.
 */
function createConnectorActionTool(registry: ConnectorRegistry, services: MatbotMachine): Tool {
  return {
    name: 'connector_action',
    description:
      'Inspect and administer Cortex connector records, grants, tool bindings, health, sync cursors, and audit events. ' +
      'Connector-backed tools are checked by connector grants before execution and audited after execution.\n\n' +
      'Actions:\n' +
      "  list        - { action: 'list', query?: StoreQuery }\n" +
      "  get         - { action: 'get', id: string }\n" +
      "  list_tools  - { action: 'list_tools', connectorInstanceId?: string }\n" +
      "  grants      - { action: 'grants', connectorInstanceId?: string, principalId?: string }\n" +
      "  set_grant   - { action: 'set_grant', grant: ConnectorGrantInput }\n" +
      "  set_sync    - { action: 'set_sync', cursor: ConnectorSyncCursorInput }\n" +
      "  health      - { action: 'health', connectorInstanceId?: string }\n" +
      "  test_health - { action: 'test_health', connectorInstanceId: string }\n" +
      "  list_audit  - { action: 'list_audit', query?: StoreQuery }",
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'list_tools', 'grants', 'set_grant', 'set_sync', 'health', 'test_health', 'list_audit'] },
        id: { type: 'string' },
        connectorInstanceId: { type: 'string' },
        definitionId: { type: 'string' },
        principalId: { type: 'string' },
        query: { type: 'object' },
        grant: { type: 'object' },
        cursor: { type: 'object' },
        state: { type: 'string', enum: ['unknown', 'healthy', 'degraded', 'down'] },
        message: { type: 'string' },
      },
    },
    executor: {
      async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
        const parsed = input && typeof input === 'object' ? input as ConnectorActionInput : { action: '' };
        try {
          switch (parsed.action) {
            case 'list':
              yield { type: 'result', value: {
                definitions: await registry.queryDefinitions(parsed.query),
                instances: await registry.queryInstances(parsed.query),
              } };
              return;
            case 'get': {
              if (!parsed.id) { yield { type: 'error', message: 'connector_action get requires "id".' }; return; }
              yield { type: 'result', value: {
                definition: await registry.getDefinition(parsed.id),
                instance: await registry.getInstance(parsed.id),
                grant: await registry.getGrant(parsed.id),
                toolBinding: await registry.getToolBinding(parsed.id),
              } };
              return;
            }
            case 'list_tools': {
              const query = parsed.connectorInstanceId === undefined
                ? parsed.query
                : { where: { op: 'eq' as const, field: 'connectorInstanceId', value: parsed.connectorInstanceId } };
              yield { type: 'result', value: { bindings: await registry.queryToolBindings(query) } };
              return;
            }
            case 'grants': {
              let grants = await registry.queryGrants(parsed.connectorInstanceId === undefined
                ? parsed.query
                : { where: { op: 'eq', field: 'connectorInstanceId', value: parsed.connectorInstanceId } });
              if (parsed.principalId !== undefined) grants = grants.filter(grant => grant.principalId === parsed.principalId);
              yield { type: 'result', value: { grants } };
              return;
            }
            case 'set_grant': {
              if (parsed.grant === undefined) { yield { type: 'error', message: 'connector_action set_grant requires "grant".' }; return; }
              yield { type: 'result', value: await registry.upsertGrant(parsed.grant) };
              return;
            }
            case 'set_sync': {
              if (parsed.cursor === undefined) { yield { type: 'error', message: 'connector_action set_sync requires "cursor".' }; return; }
              yield { type: 'result', value: await registry.upsertSyncCursor(parsed.cursor) };
              return;
            }
            case 'health':
              yield { type: 'result', value: { events: await registry.healthEvents(parsed.connectorInstanceId) } };
              return;
            case 'test_health': {
              if (!parsed.connectorInstanceId) { yield { type: 'error', message: 'connector_action test_health requires "connectorInstanceId".' }; return; }
              const bindings = await registry.queryToolBindings({
                where: { op: 'eq', field: 'connectorInstanceId', value: parsed.connectorInstanceId },
              });
              const missing = bindings
                .filter(binding => binding.toolName !== undefined)
                .filter(binding => services.tools.resolve(binding.toolName!) === null)
                .map(binding => binding.toolName!);
              const state = parsed.state ?? (missing.length === 0 ? 'healthy' : 'degraded');
              const message = parsed.message ?? (missing.length === 0
                ? 'All exact connector tool bindings are registered.'
                : `Missing connector tools: ${missing.join(', ')}`);
              yield { type: 'result', value: await registry.recordHealth({
                connectorInstanceId: parsed.connectorInstanceId,
                state,
                message,
                details: { missingTools: missing, checkedBy: 'connector_action' },
              }) };
              return;
            }
            case 'list_audit':
              yield { type: 'result', value: { events: await registry.auditEvents(parsed.query) } };
              return;
            default:
              yield { type: 'error', message: `Unknown connector_action "${String(parsed.action)}". Expected: list, get, list_tools, grants, set_grant, set_sync, health, test_health, list_audit.` };
          }
        } catch (error) {
          yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
        }
      },
    },
  };
}

/**
 * Writes a `denied` audit event for a connector-bound call rejected by policy. No-op when
 * the decision lacks a resolved instance, binding, or capability.
 *
 * @param registry - Registry the audit event is written to.
 * @param ctx - Tool-call hook context; supplies tool identity, input hash, trace id, and provider.
 * @param decision - Denying decision from {@link ConnectorRegistry.evaluateToolCall}.
 * @throws Error - When the audit write fails.
 */
async function auditDeniedToolCall(registry: ConnectorRegistry, ctx: ToolCallContext, decision: ConnectorPolicyDecision): Promise<void> {
  const instance = decision.connectorInstance;
  const binding = decision.binding;
  if (instance === undefined || binding === undefined || decision.capability === undefined) return;
  const workflowRunId = workflowRunIdFromInput(ctx.toolCall.input);
  await registry.recordAudit({
    connectorInstanceId: instance.id,
    workspaceId: instance.workspaceId,
    toolName: ctx.toolCall.name,
    capability: decision.capability,
    status: 'denied',
    allowed: false,
    principalId: decision.principalId,
    toolCallId: ctx.toolCall.id,
    ...(ctx.config.traceId !== undefined ? { traceId: ctx.config.traceId } : {}),
    ...(workflowRunId !== undefined ? { workflowRunId } : {}),
    providerName: ctx.config.provider,
    inputHash: hashPayload(ctx.toolCall.input),
    sourceIds: [],
    ...(decision.action !== undefined ? { action: decision.action } : {}),
    ...(binding.sensitivity !== undefined ? { sensitivity: binding.sensitivity } : {}),
    ...(decision.approvalPolicyId !== undefined ? { approvalPolicyId: decision.approvalPolicyId } : {}),
    ...(decision.reason !== undefined ? { message: decision.reason } : {}),
  });
}

/**
 * Audits an executed connector-bound tool call and returns the result to hand downstream.
 * Sensitive fields from the binding and the allowing grant are redacted before hashing and
 * before the result is returned; source ids are harvested from the redacted result. The
 * status is `error` for failed calls, `allowed` otherwise. No-op (the result is returned
 * unchanged) when the decision lacks a resolved instance, binding, or capability.
 *
 * @param registry - Registry the audit event is written to.
 * @param ctx - Tool-result hook context; supplies the result, duration, trace id, and provider.
 * @param decision - Allowing decision from {@link ConnectorRegistry.evaluateToolCall}.
 * @returns The redacted result, or the original result when the call is not audited.
 * @throws Error - When the audit write or payload hashing fails.
 */
async function auditToolResult(registry: ConnectorRegistry, ctx: ToolResultContext, decision: ConnectorPolicyDecision): Promise<unknown> {
  const instance = decision.connectorInstance;
  const binding = decision.binding;
  if (instance === undefined || binding === undefined || decision.capability === undefined) return ctx.result;
  const redactionFields = uniq([...(binding.sensitiveFields ?? []), ...(decision.grant?.sensitiveFields ?? [])]);
  const result = redactDeep(ctx.result, redactionFields);
  const sourceIds = [...collectSourceIds(result)];
  const workflowRunId = workflowRunIdFromInput(ctx.toolCall.input);
  await registry.recordAudit({
    connectorInstanceId: instance.id,
    workspaceId: instance.workspaceId,
    toolName: ctx.toolCall.name,
    capability: decision.capability,
    status: ctx.isError ? 'error' : 'allowed',
    allowed: true,
    principalId: decision.principalId,
    sourceIds,
    toolCallId: ctx.toolCall.id,
    ...(ctx.config.traceId !== undefined ? { traceId: ctx.config.traceId } : {}),
    ...(workflowRunId !== undefined ? { workflowRunId } : {}),
    providerName: ctx.config.provider,
    inputHash: hashPayload(ctx.toolCall.input),
    resultHash: hashPayload(result),
    durationMs: ctx.durationMs,
    sensitivity: binding.sensitivity,
    ...(decision.action !== undefined ? { action: decision.action } : {}),
    ...(decision.approvalPolicyId !== undefined ? { approvalPolicyId: decision.approvalPolicyId } : {}),
    ...(ctx.isError ? { errorMessage: canonicalJson(result).slice(0, 1000) } : {}),
  });
  return result;
}

/**
 * Installs `toolcall` and `toolresult` hooks (priority 20) that enforce connector grants
 * and write audit events for connector-bound tools. Denied calls are audited, reported to
 * the Observability service when a trace id is present, and rejected; allowed results are
 * redacted and audited. Observability failures are logged, never propagated; hook handlers
 * report rejections via their return value, not by throwing.
 *
 * @param registry - Registry used for policy evaluation and audit writes.
 * @param services - Machine providing hook registration and the optional Observability service.
 * @throws Never.
 */
function registerPolicyHooks(registry: ConnectorRegistry, services: MatbotMachine): void {
  services.hooks.register({
    on: 'toolcall',
    priority: 20,
    async handler(ctx) {
      const decision = await registry.evaluateToolCall({
        toolName: ctx.toolCall.name,
        input: ctx.toolCall.input,
        principal: effectivePrincipal(),
      });
      if (!decision.bound || decision.allowed) return;
      await auditDeniedToolCall(registry, ctx, decision);
      const observability = services.get('Observability');
      if (observability !== undefined && ctx.config.traceId !== undefined) {
        const workflowRunId = workflowRunIdFromInput(ctx.toolCall.input);
        try {
          await observability.record({
            traceId: ctx.config.traceId,
            rootTraceId: ctx.config.rootTraceId ?? ctx.config.traceId,
            spanId: `connector-policy:${ctx.toolCall.id}`,
            sessionId: ctx.session.id,
            ...(workflowRunId !== undefined ? { workflowRunId } : {}),
            timestamp: new Date().toISOString(),
            phase: 'end', kind: 'guardrail', name: 'connector.policy', status: 'error',
            attributes: { policyOutcome: 'denied', toolName: ctx.toolCall.name, capability: decision.capability ?? null, connectorInstanceId: decision.connectorInstance?.id ?? null, approvalPolicyId: decision.approvalPolicyId ?? null, reason: decision.reason ?? null },
          });
        } catch (error) {
          console.warn(`[connector-fabric] observability sink failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { rejectTool: { message: decision.reason ?? `Connector policy denied tool "${ctx.toolCall.name}".` } };
    },
  });

  services.hooks.register({
    on: 'toolresult',
    priority: 20,
    async handler(ctx) {
      const decision = await registry.evaluateToolCall({
        toolName: ctx.toolCall.name,
        input: ctx.toolCall.input,
        principal: effectivePrincipal(),
      });
      if (!decision.bound || !decision.allowed) return;
      const result = await auditToolResult(registry, ctx, decision);
      const observability = services.get('Observability');
      if (observability !== undefined && ctx.config.traceId !== undefined) {
        const workflowRunId = workflowRunIdFromInput(ctx.toolCall.input);
        try {
          await observability.record({
            traceId: ctx.config.traceId,
            rootTraceId: ctx.config.rootTraceId ?? ctx.config.traceId,
            spanId: `connector-policy:${ctx.toolCall.id}`,
            sessionId: ctx.session.id,
            ...(workflowRunId !== undefined ? { workflowRunId } : {}),
            timestamp: new Date().toISOString(),
            phase: 'end', kind: 'guardrail', name: 'connector.policy', status: ctx.isError ? 'error' : 'ok', durationMs: ctx.durationMs,
            attributes: { policyOutcome: 'allowed', toolName: ctx.toolCall.name, capability: decision.capability ?? null, connectorInstanceId: decision.connectorInstance?.id ?? null, approvalPolicyId: decision.approvalPolicyId ?? null },
          });
        } catch (error) {
          console.warn(`[connector-fabric] observability sink failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (result !== ctx.result) return { result };
    },
  });
}

/**
 * Seeds the built-in connector fabric: eight definitions (source registry, workspace RAG,
 * file broker, MCP, read-only Postgres, workflow governance, context graph, evaluation and
 * observability), their `local`-workspace instances, ten tool bindings for the built-in
 * connector tools, and permissive wildcard grants. Idempotent: every record upserts by
 * stable id, so reseeding preserves `createdAt` and refreshes `updatedAt`.
 *
 * @param registry - Registry to seed.
 * @throws Error - When any seed record fails to persist.
 */
async function seedDefaultConnectors(registry: ConnectorRegistry): Promise<void> {
  const definitions = [
    {
      id: 'connector-definition:source-registry',
      type: 'source-registry',
      displayName: 'Source Registry',
      protocol: 'native' as const,
      sourceTypes: ['source_record', 'source_version', 'source_event'],
      capabilities: ['read' as const],
      description: 'Cortex source provenance, freshness, health, and citation records.',
    },
    {
      id: 'connector-definition:workspace-rag',
      type: 'workspace-rag',
      displayName: 'Workspace RAG',
      protocol: 'native' as const,
      sourceTypes: ['markdown_document', 'rag_chunk'],
      capabilities: ['read' as const, 'write' as const, 'admin' as const],
      description: 'Workspace-scoped markdown retrieval and indexing control.',
    },
    {
      id: 'connector-definition:file-broker',
      type: 'file-broker',
      displayName: 'Local File Broker',
      protocol: 'http' as const,
      sourceTypes: ['local_file', 'local_directory'],
      capabilities: ['read' as const, 'write' as const],
      description: 'Local file-broker HTTP service for policy-checked host filesystem access.',
    },
    {
      id: 'connector-definition:mcp',
      type: 'mcp',
      displayName: 'MCP Servers',
      protocol: 'mcp' as const,
      sourceTypes: ['mcp_tool', 'remote_resource'],
      capabilities: ['read' as const, 'write' as const, 'admin' as const],
      description: 'Model Context Protocol server manager and delegated MCP tool calls.',
    },
    {
      id: 'connector-definition:postgres-readonly',
      type: 'postgres-readonly',
      displayName: 'Postgres Read-Only',
      protocol: 'postgres' as const,
      sourceTypes: ['table', 'query_result', 'metric'],
      capabilities: ['read' as const],
      description: 'Read-only Postgres connector slot for structured data reasoning and pgvector-backed retrieval metadata.',
    },
    {
      id: 'connector-definition:workflow-governance',
      type: 'workflow-governance',
      displayName: 'Workflow Governance',
      protocol: 'native' as const,
      sourceTypes: ['workflow_definition', 'workflow_run', 'workflow_approval'],
      capabilities: ['read' as const, 'write' as const, 'admin' as const],
      description: 'Governed workflow definitions, run ledger, approval queue, and workflow policy checks.',
    },
    {
      id: 'connector-definition:context-graph',
      type: 'context-graph',
      displayName: 'Context Graph',
      protocol: 'native' as const,
      sourceTypes: ['context_entity', 'context_relationship', 'graph_projection'],
      capabilities: ['read' as const, 'write' as const, 'admin' as const],
      description: 'Source-backed business entity graph, relationship assertions, deterministic extraction, and Neo4j projection operations.',
    },
    {
      id: 'connector-definition:evaluation-observability',
      type: 'evaluation-observability',
      displayName: 'Evaluation, Observability, and ROI',
      protocol: 'native' as const,
      sourceTypes: ['trace', 'span', 'evaluation_suite', 'score', 'outcome', 'roi_report'],
      capabilities: ['read' as const, 'write' as const, 'admin' as const],
      description: 'End-to-end traces, safe replay, regression suites, governance metrics, and verified ROI evidence.',
    },
  ];

  for (const definition of definitions) await registry.upsertDefinition(definition);

  const instances = [
    { id: 'connector-instance:source-registry:local', definitionId: 'connector-definition:source-registry', type: 'source-registry', workspaceId: 'local', displayName: 'Local Source Registry', scopes: ['source-registry:read'], readEnabled: true, writeEnabled: false },
    { id: 'connector-instance:workspace-rag:local', definitionId: 'connector-definition:workspace-rag', type: 'workspace-rag', workspaceId: 'local', displayName: 'Local Workspace RAG', scopes: ['workspace-rag:read', 'workspace-rag:write', 'workspace-rag:admin'], readEnabled: true, writeEnabled: true },
    { id: 'connector-instance:file-broker:local', definitionId: 'connector-definition:file-broker', type: 'file-broker', workspaceId: 'local', displayName: 'Local File Broker', scopes: ['file-broker:read', 'file-broker:write'], readEnabled: true, writeEnabled: true },
    { id: 'connector-instance:mcp:local', definitionId: 'connector-definition:mcp', type: 'mcp', workspaceId: 'local', displayName: 'Local MCP Fabric', scopes: ['mcp:read', 'mcp:admin'], readEnabled: true, writeEnabled: true },
    { id: 'connector-instance:postgres-readonly:local', definitionId: 'connector-definition:postgres-readonly', type: 'postgres-readonly', workspaceId: 'local', displayName: 'Local Postgres Read-Only', scopes: ['postgres:read'], readEnabled: true, writeEnabled: true },
    { id: 'connector-instance:workflow-governance:local', definitionId: 'connector-definition:workflow-governance', type: 'workflow-governance', workspaceId: 'local', displayName: 'Local Workflow Governance', scopes: ['workflow:read', 'workflow:write', 'workflow:admin'], readEnabled: true, writeEnabled: true },
    { id: 'connector-instance:context-graph:local', definitionId: 'connector-definition:context-graph', type: 'context-graph', workspaceId: 'local', displayName: 'Local Context Graph', scopes: ['context-graph:read', 'context-graph:write', 'context-graph:admin'], readEnabled: true, writeEnabled: true },
    { id: 'connector-instance:evaluation-observability:local', definitionId: 'connector-definition:evaluation-observability', type: 'evaluation-observability', workspaceId: 'local', displayName: 'Local Evaluation and Observability', scopes: ['evaluation:read', 'evaluation:write', 'evaluation:admin'], readEnabled: true, writeEnabled: true },
  ];

  for (const instance of instances) {
    await registry.upsertInstance({
      ...instance,
      ownerPrincipalId: 'system',
      authMode: instance.type === 'file-broker' ? 'windows' : 'none',
      healthState: 'unknown',
    });
  }

  const bindings: ConnectorToolBindingInput[] = [
    {
      connectorInstanceId: 'connector-instance:source-registry:local',
      toolName: 'source_action',
      capability: 'read',
      sourceTypes: ['source_record', 'source_event'],
      sensitivity: 'internal',
      requiredScopes: ['source-registry:read'],
      inputActionField: 'action',
      description: 'Inspect source registry provenance and freshness metadata.',
    },
    {
      connectorInstanceId: 'connector-instance:source-registry:local',
      toolName: 'source_health_action',
      capability: 'read',
      sourceTypes: ['source_record', 'source_health_report'],
      sensitivity: 'internal',
      requiredScopes: ['source-registry:read'],
      inputActionField: 'action',
      description: 'Generate source health reports and stale-source warnings.',
    },
    {
      connectorInstanceId: 'connector-instance:workspace-rag:local',
      toolName: 'workspace_rag',
      capability: 'read',
      sourceTypes: ['markdown_document', 'rag_chunk'],
      sensitivity: 'internal',
      requiredScopes: ['workspace-rag:read'],
      inputActionField: 'action',
      actionCapabilities: {
        status: 'read',
        get_config: 'read',
        search: 'read',
        configure: 'write',
        select_context: 'write',
        create_context: 'write',
        reindex_now: 'admin',
      },
      approvalPolicyId: 'workspace-rag-write',
      description: 'Search and configure workspace-scoped markdown retrieval.',
    },
    {
      connectorInstanceId: 'connector-instance:file-broker:local',
      toolName: 'file_broker_action',
      capability: 'read',
      sourceTypes: ['local_file', 'local_directory'],
      sensitivity: 'confidential',
      requiredScopes: ['file-broker:read'],
      inputActionField: 'action',
      actionCapabilities: {
        health: 'read',
        list: 'read',
        read: 'read',
        write: 'write',
      },
      approvalPolicyId: 'file-broker-write',
      sensitiveFields: ['content'],
      description: 'List, read, and write configured local host filesystem roots through file-broker.',
    },
    {
      connectorInstanceId: 'connector-instance:mcp:local',
      toolName: 'mcp_action',
      capability: 'read',
      sourceTypes: ['mcp_tool'],
      sensitivity: 'confidential',
      requiredScopes: ['mcp:read'],
      inputActionField: 'action',
      actionCapabilities: {
        list: 'read',
        add: 'admin',
        remove: 'admin',
      },
      approvalPolicyId: 'mcp-admin',
      sensitiveFields: ['headers', 'env'],
      description: 'Manage local and remote MCP server connections.',
    },
    {
      connectorInstanceId: 'connector-instance:mcp:local',
      toolNamePrefix: 'mcp__',
      capability: 'admin',
      sourceTypes: ['mcp_tool', 'remote_resource'],
      sensitivity: 'confidential',
      requiredScopes: ['mcp:admin'],
      approvalPolicyId: 'mcp-admin',
      sensitiveFields: ['apiKey', 'accessToken', 'authorization'],
      description: 'Delegated MCP server tools registered as mcp__<server>__<tool>.',
    },
    {
      connectorInstanceId: 'connector-instance:postgres-readonly:local',
      toolName: 'structured_data_action',
      capability: 'read',
      sourceTypes: ['table', 'metric', 'query_result'],
      sensitivity: 'confidential',
      requiredScopes: ['postgres:read'],
      inputActionField: 'action',
      actionCapabilities: {
        catalog: 'read',
        validate_sql: 'read',
        plan_query: 'read',
        runs: 'read',
        execute_query: 'read',
        register_connection: 'admin',
        upsert_table: 'admin',
        upsert_column: 'admin',
        upsert_metric: 'admin',
        approve_query: 'admin',
      },
      approvalPolicyId: 'structured-data-admin',
      sensitiveFields: ['rows', 'parameters', 'credentialRef', 'approvalToken'],
      description: 'Governed structured data catalog, semantic SQL planning, and approved read-only query execution.',
    },
    {
      connectorInstanceId: 'connector-instance:workflow-governance:local',
      toolName: 'workflow_action',
      capability: 'read',
      sourceTypes: ['workflow_definition', 'workflow_run', 'workflow_approval'],
      sensitivity: 'confidential',
      requiredScopes: ['workflow:read'],
      inputActionField: 'action',
      actionCapabilities: {
        validate: 'read',
        shadow_report: 'read',
        inspect_run: 'read',
        list_runs: 'read',
        list_approvals: 'read',
        get_compilation: 'read',
        compilations: 'read',
        compile: 'write',
        draft: 'write',
        dry_run: 'write',
        start: 'write',
        label_shadow_result: 'write',
        compare_shadow_result: 'write',
        approve: 'admin',
        reject: 'admin',
        escalate: 'admin',
      },
      approvalPolicyId: 'workflow-governance-admin',
      sensitiveFields: ['inputs', 'proposedActions', 'approvalToken', 'transcript', 'messages', 'toolCalls', 'inputHints', 'sampleInputs'],
      description: 'Governed workflow compilation, definitions, run ledger, dry-run, shadow labeling/comparison, and approvals.',
    },
    {
      connectorInstanceId: 'connector-instance:context-graph:local',
      toolName: 'context_graph_action',
      capability: 'read',
      sourceTypes: ['context_entity', 'context_relationship', 'graph_projection'],
      sensitivity: 'confidential',
      requiredScopes: ['context-graph:read'],
      inputActionField: 'action',
      actionCapabilities: {
        list: 'read',
        search_entities: 'read',
        neighbors: 'read',
        path_search: 'read',
        retrieve: 'read',
        projection_log: 'read',
        upsert_entity: 'write',
        assert_relationship: 'write',
        extract_source: 'write',
      },
      approvalPolicyId: 'context-graph-write',
      sensitiveFields: ['identifiers', 'evidenceSpan', 'parameters', 'text'],
      description: 'Search, retrieve, extract, and maintain source-backed context graph assertions.',
    },
    {
      connectorInstanceId: 'connector-instance:evaluation-observability:local',
      toolName: 'evaluation_action',
      capability: 'read',
      sourceTypes: ['trace', 'span', 'evaluation_suite', 'score', 'outcome', 'roi_report'],
      sensitivity: 'confidential',
      requiredScopes: ['evaluation:read'],
      inputActionField: 'action',
      actionCapabilities: {
        traces: 'read',
        inspect_trace: 'read',
        replay: 'read',
        suites: 'read',
        evaluation_runs: 'read',
        metrics: 'read',
        roi: 'read',
        upsert_suite: 'write',
        run_suite: 'write',
        upsert_baseline: 'admin',
        record_outcome: 'admin',
      },
      approvalPolicyId: 'evaluation-observability-admin',
      sensitiveFields: ['suite', 'baseline', 'outcome'],
      description: 'Inspect traces, replay safely, execute evaluation suites, and manage verified ROI evidence.',
    },
  ];

  for (const binding of bindings) await registry.upsertToolBinding(binding);

  const grants: ConnectorGrantInput[] = [
    {
      connectorInstanceId: 'connector-instance:source-registry:local',
      principalId: '*',
      scopes: ['*'],
      allowedTools: ['source_action', 'source_health_action'],
    },
    {
      connectorInstanceId: 'connector-instance:workspace-rag:local',
      principalId: '*',
      scopes: ['*'],
      allowedTools: ['workspace_rag'],
      approvalRules: ['workspace-rag-write'],
    },
    {
      connectorInstanceId: 'connector-instance:file-broker:local',
      principalId: '*',
      scopes: ['*'],
      allowedTools: ['file_broker_action'],
      approvalRules: ['file-broker-write'],
      sensitiveFields: ['content'],
    },
    {
      connectorInstanceId: 'connector-instance:mcp:local',
      principalId: '*',
      scopes: ['*'],
      allowedTools: ['mcp_action', 'mcp__*'],
      approvalRules: ['mcp-admin'],
      sensitiveFields: ['headers', 'env', 'apiKey', 'accessToken', 'authorization'],
    },
    {
      connectorInstanceId: 'connector-instance:postgres-readonly:local',
      principalId: '*',
      scopes: ['*'],
      allowedTools: ['structured_data_action'],
      approvalRules: ['structured-data-admin'],
      sensitiveFields: ['rows', 'parameters', 'credentialRef', 'approvalToken'],
    },
    {
      connectorInstanceId: 'connector-instance:workflow-governance:local',
      principalId: '*',
      scopes: ['*'],
      allowedTools: ['workflow_action'],
      approvalRules: ['workflow-governance-admin'],
      sensitiveFields: ['inputs', 'proposedActions', 'approvalToken', 'transcript', 'messages', 'toolCalls', 'inputHints', 'sampleInputs'],
    },
    {
      connectorInstanceId: 'connector-instance:context-graph:local',
      principalId: '*',
      scopes: ['*'],
      allowedTools: ['context_graph_action'],
      approvalRules: ['context-graph-write'],
      sensitiveFields: ['identifiers', 'evidenceSpan', 'parameters', 'text'],
    },
    {
      connectorInstanceId: 'connector-instance:evaluation-observability:local',
      principalId: '*',
      scopes: ['*'],
      allowedTools: ['evaluation_action'],
      approvalRules: ['evaluation-observability-admin'],
      sensitiveFields: ['suite', 'baseline', 'outcome'],
    },
  ];

  for (const grant of grants) await registry.upsertGrant(grant);
}

/**
 * Builds a store-backed {@link ConnectorRegistry} using seven dedicated stores
 * created through the machine's store factory.
 * @param services The matbot machine providing `createStore`.
 * @returns The registry instance.
 */
export function createConnectorRegistry(services: MatbotMachine): ConnectorRegistry {
  return new StoreBackedConnectorRegistry(
    services.createStore<ConnectorDefinition>(DEFINITION_STORE),
    services.createStore<ConnectorInstance>(INSTANCE_STORE),
    services.createStore<ConnectorGrant>(GRANT_STORE),
    services.createStore<ConnectorToolBinding>(TOOL_BINDING_STORE),
    services.createStore<ConnectorSyncCursor>(SYNC_CURSOR_STORE),
    services.createStore<ConnectorHealthEvent>(HEALTH_STORE),
    services.createStore<ConnectorAuditEvent>(AUDIT_STORE),
  );
}

/**
 * Connector-fabric plugin: registers the ConnectorRegistry service, seeds the
 * default connector definitions/instances/bindings/grants, exposes the
 * `connector_action` admin tool, and installs toolcall/toolresult hooks that
 * enforce grants and write audit events for connector-bound tools.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Registers ConnectorRegistry, connector_action, connector grant enforcement, and connector audit hooks.',
  },
  /**
   * Plugin entry point: creates and seeds the registry, then registers the
   * `ConnectorRegistry` service, the `connector_action` tool, and the policy hooks.
   *
   * @param services - Machine to register into.
   * @throws Error - When seeding or registration fails.
   */
  async setup(services: MatbotMachine) {
    const registry = createConnectorRegistry(services);
    await seedDefaultConnectors(registry);
    await services.register('ConnectorRegistry', registry);
    services.tools.register(createConnectorActionTool(registry, services));
    registerPolicyHooks(registry, services);
  },
};

export default plugin;
