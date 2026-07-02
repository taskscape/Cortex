import { createHash, randomUUID } from 'node:crypto';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type {
  MatbotMachine,
  MatbotPluginSpec,
  Store,
  StoreQuery,
  Tool,
  ToolContext,
  ToolEvent,
} from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    readonly SourceRegistry?: SourceRegistry;
  }
}

export type SourceKind =
  | 'document'
  | 'table'
  | 'metric'
  | 'dashboard'
  | 'message'
  | 'ticket'
  | 'artifact'
  | 'query_result';

export type SourceSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type SourcePermissionState = 'unknown' | 'allowed' | 'denied' | 'partial';
export type SourceTrustLevel = 'unknown' | 'low' | 'medium' | 'high';
export type SourceStalenessState = 'unknown' | 'fresh' | 'stale' | 'expired';
export type SourceCitationPolicy = 'cite_path' | 'cite_link' | 'cite_query' | 'do_not_cite';
export type SourceHealthState = 'unknown' | 'healthy' | 'degraded' | 'down';
export type SourceAccessAction = 'read' | 'retrieve' | 'cite' | 'write' | 'delete' | 'health_check';

export interface SourceIdentityInput {
  workspaceId: string;
  connectorType: string;
  connectorInstanceId?: string;
  externalId: string;
}

export interface SourceRecord {
  id: string;
  version: string;
  workspaceId: string;
  connectorType: string;
  externalId: string;
  uri: string;
  title: string;
  sourceKind: SourceKind;
  sensitivity: SourceSensitivity;
  permissionState: SourcePermissionState;
  trustLevel: SourceTrustLevel;
  stalenessState: SourceStalenessState;
  citationPolicy: SourceCitationPolicy;
  healthState: SourceHealthState;
  knownLimitations: string[];
  createdAt: string;
  updatedAt: string;
  connectorInstanceId?: string;
  ownerPrincipalId?: string;
  businessDomain?: string;
  schemaOrDocumentType?: string;
  effectiveUserId?: string;
  freshnessSlaSeconds?: number;
  lastObservedAt?: string;
  lastSuccessfulReadAt?: string;
  staleAfter?: string;
  retentionPolicyId?: string;
}

export type SourceRecordInput = SourceIdentityInput & {
  id?: string;
  uri: string;
  title: string;
  sourceKind: SourceKind;
  sensitivity?: SourceSensitivity;
  permissionState?: SourcePermissionState;
  trustLevel?: SourceTrustLevel;
  citationPolicy?: SourceCitationPolicy;
  healthState?: SourceHealthState;
  stalenessState?: SourceStalenessState;
  knownLimitations?: string[];
  ownerPrincipalId?: string;
  businessDomain?: string;
  schemaOrDocumentType?: string;
  effectiveUserId?: string;
  freshnessSlaSeconds?: number;
  lastObservedAt?: string;
  lastSuccessfulReadAt?: string;
  staleAfter?: string;
  retentionPolicyId?: string;
};

export interface SourceVersion {
  id: string;
  version: string;
  sourceId: string;
  observedAt: string;
  provenance: {
    activityId: string;
    connectorAuditEventId?: string;
    ingestionRunId?: string;
    modelProvider?: string;
  };
  contentHash?: string;
  schemaHash?: string;
  validFrom?: string;
  validTo?: string;
}

export type SourceVersionInput = {
  id?: string;
  sourceId: string;
  observedAt?: string;
  provenance: SourceVersion['provenance'];
  contentHash?: string;
  schemaHash?: string;
  validFrom?: string;
  validTo?: string;
};

export interface SourceHealthEvent {
  id: string;
  version: string;
  sourceId: string;
  state: SourceHealthState;
  checkedAt: string;
  message?: string;
  details?: Record<string, unknown>;
}

export type SourceHealthInput = {
  sourceId: string;
  state: SourceHealthState;
  checkedAt?: string;
  message?: string;
  details?: Record<string, unknown>;
};

export interface SourceAccessEvent {
  id: string;
  version: string;
  sourceId: string;
  action: SourceAccessAction;
  timestamp: string;
  allowed: boolean;
  principalId?: string;
  traceId?: string;
  toolCallId?: string;
  workflowRunId?: string;
  message?: string;
}

export type SourceAccessInput = {
  sourceId: string;
  action: SourceAccessAction;
  allowed: boolean;
  timestamp?: string;
  principalId?: string;
  traceId?: string;
  toolCallId?: string;
  workflowRunId?: string;
  message?: string;
};

export interface SourceCitation {
  sourceId: string;
  policy: SourceCitationPolicy;
  text: string;
  uri?: string;
  title?: string;
  versionId?: string;
  observedAt?: string;
}

export interface SourceRegistry {
  stableSourceId(input: SourceIdentityInput): string;
  stableSourceVersionId(input: Pick<SourceVersionInput, 'sourceId' | 'contentHash' | 'schemaHash'>): string;
  upsertSource(input: SourceRecordInput): Promise<SourceRecord>;
  upsertVersion(input: SourceVersionInput): Promise<SourceVersion>;
  getSource(id: string): Promise<SourceRecord | null>;
  getVersion(id: string): Promise<SourceVersion | null>;
  recordHealth(input: SourceHealthInput): Promise<SourceHealthEvent>;
  recordAccess(input: SourceAccessInput): Promise<SourceAccessEvent>;
  resolveCitation(sourceId: string, versionId?: string): Promise<SourceCitation>;
  querySources(query?: StoreQuery): Promise<SourceRecord[]>;
  staleSources(workspaceId?: string): Promise<SourceRecord[]>;
  healthEvents(sourceId?: string): Promise<SourceHealthEvent[]>;
  accessEvents(sourceId?: string): Promise<SourceAccessEvent[]>;
}

const SOURCE_STORE = 'sources';
const VERSION_STORE = 'source_versions';
const HEALTH_STORE = 'source_health_events';
const ACCESS_STORE = 'source_access_events';

function nowIso(): string {
  return new Date().toISOString();
}

function hashId(prefix: string, parts: readonly string[]): string {
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `${prefix}:${hash}`;
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function optional<T>(value: T | undefined): { include: false } | { include: true; value: T } {
  return value === undefined ? { include: false } : { include: true, value };
}

function computeStaleAfter(input: {
  lastSuccessfulReadAt?: string | undefined;
  freshnessSlaSeconds?: number | undefined;
  staleAfter?: string | undefined;
}): string | undefined {
  if (input.staleAfter !== undefined) return input.staleAfter;
  if (input.lastSuccessfulReadAt === undefined || input.freshnessSlaSeconds === undefined) return undefined;
  const readAt = Date.parse(input.lastSuccessfulReadAt);
  if (!Number.isFinite(readAt)) return undefined;
  return new Date(readAt + input.freshnessSlaSeconds * 1000).toISOString();
}

function effectiveStaleness(input: {
  stalenessState?: SourceStalenessState | undefined;
  staleAfter?: string | undefined;
  lastSuccessfulReadAt?: string | undefined;
  freshnessSlaSeconds?: number | undefined;
}, at = Date.now()): SourceStalenessState {
  if (input.stalenessState !== undefined && input.stalenessState !== 'unknown') return input.stalenessState;
  const staleAfter = computeStaleAfter(input);
  if (staleAfter === undefined) return input.lastSuccessfulReadAt !== undefined ? 'fresh' : 'unknown';
  const staleAt = Date.parse(staleAfter);
  if (!Number.isFinite(staleAt)) return 'unknown';
  return staleAt <= at ? 'stale' : 'fresh';
}

async function queryAll<T extends { id: string; version: string }>(store: Store<T>, query?: StoreQuery): Promise<T[]> {
  const result = await store.query(query ?? {});
  return result.items;
}

async function queryBySource<T extends { id: string; version: string; sourceId: string }>(
  store: Store<T>,
  sourceId?: string,
): Promise<T[]> {
  if (sourceId === undefined) return queryAll(store);
  return queryAll(store, { where: { op: 'eq', field: 'sourceId', value: sourceId } });
}

class StoreBackedSourceRegistry implements SourceRegistry {
  private readonly sources: Store<SourceRecord>;
  private readonly versions: Store<SourceVersion>;
  private readonly health: Store<SourceHealthEvent>;
  private readonly access: Store<SourceAccessEvent>;

  constructor(
    sources: Store<SourceRecord>,
    versions: Store<SourceVersion>,
    health: Store<SourceHealthEvent>,
    access: Store<SourceAccessEvent>,
  ) {
    this.sources = sources;
    this.versions = versions;
    this.health = health;
    this.access = access;
  }

  stableSourceId(input: SourceIdentityInput): string {
    return hashId('source', [
      input.workspaceId,
      input.connectorType,
      input.connectorInstanceId ?? '',
      input.externalId,
    ]);
  }

  stableSourceVersionId(input: Pick<SourceVersionInput, 'sourceId' | 'contentHash' | 'schemaHash'>): string {
    return hashId('source-version', [
      input.sourceId,
      input.contentHash ?? '',
      input.schemaHash ?? '',
    ]);
  }

  async upsertSource(input: SourceRecordInput): Promise<SourceRecord> {
    const id = input.id ?? this.stableSourceId(input);
    const existing = await this.sources.get(id);
    const timestamp = nowIso();
    const lastObservedAt = input.lastObservedAt ?? timestamp;
    const staleAfter = computeStaleAfter({
      lastSuccessfulReadAt: input.lastSuccessfulReadAt ?? existing?.lastSuccessfulReadAt,
      freshnessSlaSeconds: input.freshnessSlaSeconds ?? existing?.freshnessSlaSeconds,
      staleAfter: input.staleAfter,
    });
    const stalenessState = effectiveStaleness({
      stalenessState: input.stalenessState,
      staleAfter,
      lastSuccessfulReadAt: input.lastSuccessfulReadAt ?? existing?.lastSuccessfulReadAt,
      freshnessSlaSeconds: input.freshnessSlaSeconds ?? existing?.freshnessSlaSeconds,
    });
    const source: SourceRecord = {
      id,
      version: randomUUID(),
      workspaceId: input.workspaceId,
      connectorType: input.connectorType,
      externalId: input.externalId,
      uri: input.uri,
      title: input.title,
      sourceKind: input.sourceKind,
      sensitivity: input.sensitivity ?? existing?.sensitivity ?? 'internal',
      permissionState: input.permissionState ?? existing?.permissionState ?? 'unknown',
      trustLevel: input.trustLevel ?? existing?.trustLevel ?? 'unknown',
      stalenessState,
      citationPolicy: input.citationPolicy ?? existing?.citationPolicy ?? 'cite_path',
      healthState: input.healthState ?? existing?.healthState ?? 'unknown',
      knownLimitations: uniq(input.knownLimitations ?? existing?.knownLimitations ?? []),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastObservedAt,
      ...(optional(input.connectorInstanceId ?? existing?.connectorInstanceId).include ? { connectorInstanceId: (input.connectorInstanceId ?? existing?.connectorInstanceId)! } : {}),
      ...(optional(input.ownerPrincipalId ?? existing?.ownerPrincipalId).include ? { ownerPrincipalId: (input.ownerPrincipalId ?? existing?.ownerPrincipalId)! } : {}),
      ...(optional(input.businessDomain ?? existing?.businessDomain).include ? { businessDomain: (input.businessDomain ?? existing?.businessDomain)! } : {}),
      ...(optional(input.schemaOrDocumentType ?? existing?.schemaOrDocumentType).include ? { schemaOrDocumentType: (input.schemaOrDocumentType ?? existing?.schemaOrDocumentType)! } : {}),
      ...(optional(input.effectiveUserId ?? existing?.effectiveUserId).include ? { effectiveUserId: (input.effectiveUserId ?? existing?.effectiveUserId)! } : {}),
      ...(optional(input.freshnessSlaSeconds ?? existing?.freshnessSlaSeconds).include ? { freshnessSlaSeconds: (input.freshnessSlaSeconds ?? existing?.freshnessSlaSeconds)! } : {}),
      ...(optional(input.lastSuccessfulReadAt ?? existing?.lastSuccessfulReadAt).include ? { lastSuccessfulReadAt: (input.lastSuccessfulReadAt ?? existing?.lastSuccessfulReadAt)! } : {}),
      ...(optional(staleAfter).include ? { staleAfter: staleAfter! } : {}),
      ...(optional(input.retentionPolicyId ?? existing?.retentionPolicyId).include ? { retentionPolicyId: (input.retentionPolicyId ?? existing?.retentionPolicyId)! } : {}),
    };
    await this.sources.set(id, source);
    return source;
  }

  async upsertVersion(input: SourceVersionInput): Promise<SourceVersion> {
    const id = input.id ?? this.stableSourceVersionId(input);
    const existing = await this.versions.get(id);
    const version: SourceVersion = {
      id,
      version: randomUUID(),
      sourceId: input.sourceId,
      observedAt: input.observedAt ?? existing?.observedAt ?? nowIso(),
      provenance: input.provenance,
      ...(input.contentHash !== undefined ? { contentHash: input.contentHash } : {}),
      ...(input.schemaHash !== undefined ? { schemaHash: input.schemaHash } : {}),
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
    };
    await this.versions.set(id, version);
    return version;
  }

  getSource(id: string): Promise<SourceRecord | null> {
    return this.sources.get(id);
  }

  getVersion(id: string): Promise<SourceVersion | null> {
    return this.versions.get(id);
  }

  async recordHealth(input: SourceHealthInput): Promise<SourceHealthEvent> {
    const source = await this.sources.get(input.sourceId);
    if (source !== null) {
      await this.sources.set(source.id, {
        ...source,
        version: randomUUID(),
        healthState: input.state,
        updatedAt: nowIso(),
        stalenessState: effectiveStaleness(source),
      });
    }
    const event: SourceHealthEvent = {
      id: randomUUID(),
      version: randomUUID(),
      sourceId: input.sourceId,
      state: input.state,
      checkedAt: input.checkedAt ?? nowIso(),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.details !== undefined ? { details: input.details } : {}),
    };
    await this.health.set(event.id, event);
    return event;
  }

  async recordAccess(input: SourceAccessInput): Promise<SourceAccessEvent> {
    const event: SourceAccessEvent = {
      id: randomUUID(),
      version: randomUUID(),
      sourceId: input.sourceId,
      action: input.action,
      timestamp: input.timestamp ?? nowIso(),
      allowed: input.allowed,
      ...(input.principalId !== undefined ? { principalId: input.principalId } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.workflowRunId !== undefined ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
    };
    await this.access.set(event.id, event);
    return event;
  }

  async resolveCitation(sourceId: string, versionId?: string): Promise<SourceCitation> {
    const source = await this.sources.get(sourceId);
    if (source === null) {
      return {
        sourceId,
        policy: 'do_not_cite',
        text: `Unknown source ${sourceId}`,
      };
    }
    const version = versionId !== undefined ? await this.versions.get(versionId) : null;
    const base = {
      sourceId,
      policy: source.citationPolicy,
      title: source.title,
      ...(source.uri ? { uri: source.uri } : {}),
      ...(version?.id !== undefined ? { versionId: version.id } : {}),
      ...(version?.observedAt !== undefined ? { observedAt: version.observedAt } : {}),
    };
    switch (source.citationPolicy) {
      case 'cite_link':
      case 'cite_path':
        return { ...base, text: `${source.title}: ${source.uri}` };
      case 'cite_query':
        return { ...base, text: `${source.title} (${source.id})` };
      case 'do_not_cite':
        return { ...base, text: `Citation suppressed for ${source.title}` };
    }
  }

  async querySources(query?: StoreQuery): Promise<SourceRecord[]> {
    const sources = await queryAll(this.sources, query);
    return sources.map(source => ({
      ...source,
      stalenessState: effectiveStaleness(source),
    }));
  }

  async staleSources(workspaceId?: string): Promise<SourceRecord[]> {
    const sources = await this.querySources(workspaceId === undefined
      ? undefined
      : { where: { op: 'eq', field: 'workspaceId', value: workspaceId } });
    return sources.filter(source => source.stalenessState === 'stale' || source.stalenessState === 'expired');
  }

  healthEvents(sourceId?: string): Promise<SourceHealthEvent[]> {
    return queryBySource(this.health, sourceId);
  }

  accessEvents(sourceId?: string): Promise<SourceAccessEvent[]> {
    return queryBySource(this.access, sourceId);
  }
}

interface SourceActionInput {
  action: string;
  id?: string;
  sourceId?: string;
  versionId?: string;
  workspaceId?: string;
  query?: StoreQuery;
}

function createSourceActionTool(registry: SourceRegistry): Tool {
  return {
    name: 'source_action',
    description:
      'Inspect Cortex source registry records, freshness, health, citations, and source events. ' +
      'Sources are durable records for indexed documents, tables, metrics, dashboards, messages, tickets, artifacts, and query results. ' +
      'Use this tool when you need to verify source freshness, health, citation policy, or provenance before relying on evidence.\n\n' +
      'Actions:\n' +
      "  list     - { action: 'list', query?: StoreQuery }\n" +
      "  get      - { action: 'get', id: string }\n" +
      "  health   - { action: 'health', sourceId?: string }\n" +
      "  stale    - { action: 'stale', workspaceId?: string }\n" +
      "  citation - { action: 'citation', sourceId: string, versionId?: string }\n" +
      "  events   - { action: 'events', sourceId?: string }",
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'health', 'stale', 'citation', 'events'] },
        id: { type: 'string' },
        sourceId: { type: 'string' },
        versionId: { type: 'string' },
        workspaceId: { type: 'string' },
        query: { type: 'object' },
      },
    },
    executor: {
      async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
        const parsed = input && typeof input === 'object' ? input as SourceActionInput : { action: '' };
        try {
          switch (parsed.action) {
            case 'list':
              yield { type: 'result', value: { sources: await registry.querySources(parsed.query) } };
              return;
            case 'get': {
              if (!parsed.id) { yield { type: 'error', message: 'source_action get requires "id".' }; return; }
              yield { type: 'result', value: await registry.getSource(parsed.id) };
              return;
            }
            case 'health':
              yield { type: 'result', value: { events: await registry.healthEvents(parsed.sourceId) } };
              return;
            case 'stale':
              yield { type: 'result', value: { sources: await registry.staleSources(parsed.workspaceId) } };
              return;
            case 'citation': {
              if (!parsed.sourceId) { yield { type: 'error', message: 'source_action citation requires "sourceId".' }; return; }
              yield { type: 'result', value: await registry.resolveCitation(parsed.sourceId, parsed.versionId) };
              return;
            }
            case 'events':
              yield { type: 'result', value: { access: await registry.accessEvents(parsed.sourceId), health: await registry.healthEvents(parsed.sourceId) } };
              return;
            default:
              yield { type: 'error', message: `Unknown source_action "${String(parsed.action)}". Expected: list, get, health, stale, citation, events.` };
          }
        } catch (error) {
          yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
        }
      },
    },
  };
}

export function createSourceRegistry(services: MatbotMachine): SourceRegistry {
  return new StoreBackedSourceRegistry(
    services.createStore<SourceRecord>(SOURCE_STORE),
    services.createStore<SourceVersion>(VERSION_STORE),
    services.createStore<SourceHealthEvent>(HEALTH_STORE),
    services.createStore<SourceAccessEvent>(ACCESS_STORE),
  );
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Registers SourceRegistry and source_action for source provenance, freshness, health, and citations.',
  },
  async setup(services: MatbotMachine) {
    const registry = createSourceRegistry(services);
    await services.register('SourceRegistry', registry);
    services.tools.register(createSourceActionTool(registry));
  },
};

export default plugin;
