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

export type ConnectorProtocol = 'native' | 'mcp' | 'postgres' | 'http';
export type ConnectorCapability = 'read' | 'write' | 'admin';
export type ConnectorSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type ConnectorAuthMode = 'none' | 'api_key' | 'oauth_user' | 'oauth_service' | 'windows';
export type ConnectorHealthState = 'unknown' | 'healthy' | 'degraded' | 'down';
export type ConnectorAuditStatus = 'allowed' | 'denied' | 'error';

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

export type ConnectorDefinitionInput = {
  id?: string;
  type: string;
  displayName: string;
  protocol: ConnectorProtocol;
  sourceTypes?: string[];
  capabilities?: ConnectorCapability[];
  description?: string;
};

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

export interface ConnectorSyncCursor {
  id: string;
  version: string;
  connectorInstanceId: string;
  cursorKind: string;
  cursor: string;
  updatedAt: string;
  partitionKey?: string;
}

export type ConnectorSyncCursorInput = {
  id?: string;
  connectorInstanceId: string;
  cursorKind: string;
  cursor: string;
  partitionKey?: string;
};

export interface ConnectorHealthEvent {
  id: string;
  version: string;
  connectorInstanceId: string;
  state: ConnectorHealthState;
  checkedAt: string;
  message?: string;
  details?: Record<string, unknown>;
}

export type ConnectorHealthInput = {
  connectorInstanceId: string;
  state: ConnectorHealthState;
  checkedAt?: string;
  message?: string;
  details?: Record<string, unknown>;
};

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

export interface ConnectorPolicyInput {
  toolName: string;
  input: unknown;
  principal?: Principal;
}

export interface ConnectorRegistry {
  stableConnectorDefinitionId(type: string): string;
  stableConnectorInstanceId(workspaceId: string, type: string, displayName: string): string;
  stableConnectorGrantId(connectorInstanceId: string, principalId: string, effectiveUserId?: string): string;
  stableConnectorToolBindingId(input: Pick<ConnectorToolBindingInput, 'connectorInstanceId' | 'toolName' | 'toolNamePrefix'>): string;
  upsertDefinition(input: ConnectorDefinitionInput): Promise<ConnectorDefinition>;
  upsertInstance(input: ConnectorInstanceInput): Promise<ConnectorInstance>;
  upsertGrant(input: ConnectorGrantInput): Promise<ConnectorGrant>;
  upsertToolBinding(input: ConnectorToolBindingInput): Promise<ConnectorToolBinding>;
  upsertSyncCursor(input: ConnectorSyncCursorInput): Promise<ConnectorSyncCursor>;
  getDefinition(id: string): Promise<ConnectorDefinition | null>;
  getInstance(id: string): Promise<ConnectorInstance | null>;
  getGrant(id: string): Promise<ConnectorGrant | null>;
  getToolBinding(id: string): Promise<ConnectorToolBinding | null>;
  getBindingForTool(toolName: string): Promise<ConnectorToolBinding | null>;
  queryDefinitions(query?: StoreQuery): Promise<ConnectorDefinition[]>;
  queryInstances(query?: StoreQuery): Promise<ConnectorInstance[]>;
  queryGrants(query?: StoreQuery): Promise<ConnectorGrant[]>;
  queryToolBindings(query?: StoreQuery): Promise<ConnectorToolBinding[]>;
  querySyncCursors(query?: StoreQuery): Promise<ConnectorSyncCursor[]>;
  recordHealth(input: ConnectorHealthInput): Promise<ConnectorHealthEvent>;
  healthEvents(connectorInstanceId?: string): Promise<ConnectorHealthEvent[]>;
  recordAudit(input: ConnectorAuditInput): Promise<ConnectorAuditEvent>;
  auditEvents(query?: StoreQuery): Promise<ConnectorAuditEvent[]>;
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

function nowIso(): string {
  return new Date().toISOString();
}

function hashId(prefix: string, parts: readonly string[]): string {
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `${prefix}:${hash}`;
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function isExpired(expiresAt: string | undefined, at = Date.now()): boolean {
  if (expiresAt === undefined) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= at;
}

function actionFromInput(input: unknown, field = 'action'): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function resolveCapability(binding: ConnectorToolBinding, input: unknown): { capability: ConnectorCapability; action?: string } {
  const action = actionFromInput(input, binding.inputActionField ?? 'action');
  const mapped = action !== undefined ? binding.actionCapabilities?.[action] : undefined;
  return {
    capability: mapped ?? binding.capability,
    ...(action !== undefined ? { action } : {}),
  };
}

function toolMatchesPattern(pattern: string, toolName: string, action?: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  if (action !== undefined && pattern === `${toolName}:${action}`) return true;
  if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1));
  return false;
}

function grantMatchesPrincipal(grant: ConnectorGrant, principal: Principal): boolean {
  return grant.principalId === principal.id || grant.principalId === '*';
}

function grantDeniesTool(grant: ConnectorGrant, toolName: string, action?: string): boolean {
  return grant.deniedTools.some(pattern => toolMatchesPattern(pattern, toolName, action));
}

function grantAllowsTool(grant: ConnectorGrant, toolName: string, action?: string): boolean {
  return grant.allowedTools.some(pattern => toolMatchesPattern(pattern, toolName, action));
}

function grantAllowsScopes(grant: ConnectorGrant, requiredScopes: readonly string[]): boolean {
  if (grant.scopes.includes('*')) return true;
  return requiredScopes.every(scope => grant.scopes.includes(scope));
}

function grantAllowsApproval(grant: ConnectorGrant, approvalPolicyId: string | undefined): boolean {
  if (approvalPolicyId === undefined) return true;
  return grant.approvalRules.includes('*') || grant.approvalRules.includes(approvalPolicyId);
}

function requiredScopesFor(binding: ConnectorToolBinding, capability: ConnectorCapability): string[] {
  return uniq([capability, ...(binding.requiredScopes ?? [])]);
}

function effectivePrincipal(principal?: Principal): Principal {
  return principal ?? tryCurrentPrincipal() ?? SYSTEM_PRINCIPAL;
}

async function queryAll<T extends { id: string; version: string }>(store: Store<T>, query?: StoreQuery): Promise<T[]> {
  const result = await store.query(query ?? {});
  return result.items;
}

async function queryByConnector<T extends { id: string; version: string; connectorInstanceId: string }>(
  store: Store<T>,
  connectorInstanceId?: string,
): Promise<T[]> {
  if (connectorInstanceId === undefined) return queryAll(store);
  return queryAll(store, { where: { op: 'eq', field: 'connectorInstanceId', value: connectorInstanceId } });
}

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

class StoreBackedConnectorRegistry implements ConnectorRegistry {
  private readonly definitions: Store<ConnectorDefinition>;
  private readonly instances: Store<ConnectorInstance>;
  private readonly grants: Store<ConnectorGrant>;
  private readonly bindings: Store<ConnectorToolBinding>;
  private readonly cursors: Store<ConnectorSyncCursor>;
  private readonly health: Store<ConnectorHealthEvent>;
  private readonly audit: Store<ConnectorAuditEvent>;

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

  stableConnectorDefinitionId(type: string): string {
    return `connector-definition:${type}`;
  }

  stableConnectorInstanceId(workspaceId: string, type: string, displayName: string): string {
    return hashId('connector-instance', [workspaceId, type, displayName]);
  }

  stableConnectorGrantId(connectorInstanceId: string, principalId: string, effectiveUserId?: string): string {
    return hashId('connector-grant', [connectorInstanceId, principalId, effectiveUserId ?? '']);
  }

  stableConnectorToolBindingId(input: Pick<ConnectorToolBindingInput, 'connectorInstanceId' | 'toolName' | 'toolNamePrefix'>): string {
    return hashId('connector-tool-binding', [input.connectorInstanceId, input.toolName ?? '', input.toolNamePrefix ?? '']);
  }

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

  getDefinition(id: string): Promise<ConnectorDefinition | null> {
    return this.definitions.get(id);
  }

  getInstance(id: string): Promise<ConnectorInstance | null> {
    return this.instances.get(id);
  }

  getGrant(id: string): Promise<ConnectorGrant | null> {
    return this.grants.get(id);
  }

  getToolBinding(id: string): Promise<ConnectorToolBinding | null> {
    return this.bindings.get(id);
  }

  async getBindingForTool(toolName: string): Promise<ConnectorToolBinding | null> {
    const bindings = await this.queryToolBindings();
    const exact = bindings.find(binding => binding.toolName === toolName);
    if (exact !== undefined) return exact;
    const prefixes = bindings
      .filter(binding => binding.toolNamePrefix !== undefined && toolName.startsWith(binding.toolNamePrefix))
      .sort((left, right) => (right.toolNamePrefix?.length ?? 0) - (left.toolNamePrefix?.length ?? 0));
    return prefixes[0] ?? null;
  }

  queryDefinitions(query?: StoreQuery): Promise<ConnectorDefinition[]> {
    return queryAll(this.definitions, query);
  }

  queryInstances(query?: StoreQuery): Promise<ConnectorInstance[]> {
    return queryAll(this.instances, query);
  }

  queryGrants(query?: StoreQuery): Promise<ConnectorGrant[]> {
    return queryAll(this.grants, query);
  }

  queryToolBindings(query?: StoreQuery): Promise<ConnectorToolBinding[]> {
    return queryAll(this.bindings, query);
  }

  querySyncCursors(query?: StoreQuery): Promise<ConnectorSyncCursor[]> {
    return queryAll(this.cursors, query);
  }

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

  healthEvents(connectorInstanceId?: string): Promise<ConnectorHealthEvent[]> {
    return queryByConnector(this.health, connectorInstanceId);
  }

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

  auditEvents(query?: StoreQuery): Promise<ConnectorAuditEvent[]> {
    return queryAll(this.audit, query);
  }

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

async function auditDeniedToolCall(registry: ConnectorRegistry, ctx: ToolCallContext, decision: ConnectorPolicyDecision): Promise<void> {
  const instance = decision.connectorInstance;
  const binding = decision.binding;
  if (instance === undefined || binding === undefined || decision.capability === undefined) return;
  await registry.recordAudit({
    connectorInstanceId: instance.id,
    workspaceId: instance.workspaceId,
    toolName: ctx.toolCall.name,
    capability: decision.capability,
    status: 'denied',
    allowed: false,
    principalId: decision.principalId,
    toolCallId: ctx.toolCall.id,
    providerName: ctx.config.provider,
    inputHash: hashPayload(ctx.toolCall.input),
    sourceIds: [],
    ...(decision.action !== undefined ? { action: decision.action } : {}),
    ...(binding.sensitivity !== undefined ? { sensitivity: binding.sensitivity } : {}),
    ...(decision.approvalPolicyId !== undefined ? { approvalPolicyId: decision.approvalPolicyId } : {}),
    ...(decision.reason !== undefined ? { message: decision.reason } : {}),
  });
}

async function auditToolResult(registry: ConnectorRegistry, ctx: ToolResultContext, decision: ConnectorPolicyDecision): Promise<unknown> {
  const instance = decision.connectorInstance;
  const binding = decision.binding;
  if (instance === undefined || binding === undefined || decision.capability === undefined) return ctx.result;
  const redactionFields = uniq([...(binding.sensitiveFields ?? []), ...(decision.grant?.sensitiveFields ?? [])]);
  const result = redactDeep(ctx.result, redactionFields);
  const sourceIds = [...collectSourceIds(result)];
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
      if (result !== ctx.result) return { result };
    },
  });
}

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
  ];

  for (const definition of definitions) await registry.upsertDefinition(definition);

  const instances = [
    { id: 'connector-instance:source-registry:local', definitionId: 'connector-definition:source-registry', type: 'source-registry', workspaceId: 'local', displayName: 'Local Source Registry', scopes: ['source-registry:read'], readEnabled: true, writeEnabled: false },
    { id: 'connector-instance:workspace-rag:local', definitionId: 'connector-definition:workspace-rag', type: 'workspace-rag', workspaceId: 'local', displayName: 'Local Workspace RAG', scopes: ['workspace-rag:read', 'workspace-rag:write', 'workspace-rag:admin'], readEnabled: true, writeEnabled: true },
    { id: 'connector-instance:file-broker:local', definitionId: 'connector-definition:file-broker', type: 'file-broker', workspaceId: 'local', displayName: 'Local File Broker', scopes: ['file-broker:read', 'file-broker:write'], readEnabled: true, writeEnabled: true },
    { id: 'connector-instance:mcp:local', definitionId: 'connector-definition:mcp', type: 'mcp', workspaceId: 'local', displayName: 'Local MCP Fabric', scopes: ['mcp:read', 'mcp:admin'], readEnabled: true, writeEnabled: true },
    { id: 'connector-instance:postgres-readonly:local', definitionId: 'connector-definition:postgres-readonly', type: 'postgres-readonly', workspaceId: 'local', displayName: 'Local Postgres Read-Only', scopes: ['postgres:read'], readEnabled: true, writeEnabled: false },
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
      scopes: ['postgres:read'],
      allowedTools: [],
    },
  ];

  for (const grant of grants) await registry.upsertGrant(grant);
}

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

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Registers ConnectorRegistry, connector_action, connector grant enforcement, and connector audit hooks.',
  },
  async setup(services: MatbotMachine) {
    const registry = createConnectorRegistry(services);
    await seedDefaultConnectors(registry);
    await services.register('ConnectorRegistry', registry);
    services.tools.register(createConnectorActionTool(registry, services));
    registerPolicyHooks(registry, services);
  },
};

export default plugin;
