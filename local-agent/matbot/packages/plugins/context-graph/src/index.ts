import { createHash, randomUUID } from 'node:crypto';
import { PLUGIN_API_VERSION, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
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
    readonly ContextGraph?: ContextGraph;
  }
}

export type ContextEntityType =
  | 'person'
  | 'team'
  | 'customer'
  | 'vendor'
  | 'system'
  | 'process'
  | 'metric'
  | 'ticket'
  | 'decision'
  | 'document'
  | 'contract'
  | 'task';

export type ContextSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type ExtractionMethod = 'deterministic' | 'connector_metadata' | 'model_extracted' | 'user_confirmed';
export type ProjectionStatus = 'queued' | 'applied' | 'failed';

export interface ContextEntity {
  id: string;
  version: string;
  workspaceId: string;
  type: ContextEntityType;
  canonicalName: string;
  aliases: string[];
  identifiers: Record<string, string>;
  sensitivity: ContextSensitivity;
  createdAt: string;
  updatedAt: string;
}

export type ContextEntityInput = {
  id?: string;
  workspaceId: string;
  type: ContextEntityType;
  canonicalName: string;
  aliases?: string[];
  identifiers?: Record<string, string>;
  sensitivity?: ContextSensitivity;
};

export interface EvidenceSpan {
  start?: number;
  end?: number;
  text?: string;
}

export interface ContextRelationshipAssertion {
  id: string;
  version: string;
  workspaceId: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  confidence: number;
  extractionMethod: ExtractionMethod;
  sourceId: string;
  createdAt: string;
  updatedAt: string;
  validFrom?: string;
  validTo?: string;
  sourceVersionId?: string;
  evidenceSpan?: EvidenceSpan;
}

export type ContextRelationshipAssertionInput = {
  id?: string;
  workspaceId: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  confidence?: number;
  extractionMethod?: ExtractionMethod;
  sourceId: string;
  validFrom?: string;
  validTo?: string;
  sourceVersionId?: string;
  evidenceSpan?: EvidenceSpan;
};

export interface ContextExtractionRun {
  id: string;
  version: string;
  workspaceId: string;
  sourceId: string;
  sourceVersionId?: string;
  extractionMethod: ExtractionMethod;
  status: 'succeeded' | 'failed';
  entityCount: number;
  relationshipCount: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export interface Neo4jProjectionOperation {
  id: string;
  version: string;
  workspaceId: string;
  operationHash: string;
  operationType: 'merge_entity' | 'merge_relationship';
  cypher: string;
  parameters: Record<string, unknown>;
  status: ProjectionStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface ContextGraphFact {
  relationship: ContextRelationshipAssertion;
  subject: ContextEntity;
  object: ContextEntity;
  sourceId: string;
  citationText?: string;
  sourceVersionId?: string;
  sourceTitle?: string;
  sourceUri?: string;
  sourceHealthState?: string;
  sourceStalenessState?: string;
  warning?: string;
}

export type ContextIngestSourceInput = {
  sourceId: string;
  sourceVersionId?: string;
  text?: string;
  extractionMethod?: ExtractionMethod;
};

export type GraphRetrievalInput = {
  workspaceId: string;
  terms?: string[];
  entityIds?: string[];
  sourceIds?: string[];
  maxDepth?: number;
  maxRelationships?: number;
};

export interface GraphRetrievalResult {
  seedEntities: ContextEntity[];
  facts: ContextGraphFact[];
  warnings: string[];
}

export interface ContextGraph {
  stableEntityId(workspaceId: string, type: ContextEntityType, canonicalName: string): string;
  stableRelationshipAssertionId(input: ContextRelationshipAssertionInput): string;
  upsertEntity(input: ContextEntityInput): Promise<ContextEntity>;
  assertRelationship(input: ContextRelationshipAssertionInput): Promise<ContextRelationshipAssertion>;
  ingestSource(input: ContextIngestSourceInput): Promise<ContextExtractionRun>;
  searchEntities(workspaceId: string, terms: string[], limit?: number): Promise<ContextEntity[]>;
  neighbors(entityId: string, options?: { depth?: number; maxRelationships?: number }): Promise<{ entities: ContextEntity[]; relationships: ContextRelationshipAssertion[]; facts: ContextGraphFact[] }>;
  pathSearch(startEntityId: string, targetEntityId: string, options?: { maxDepth?: number; maxPaths?: number }): Promise<Array<{ entities: ContextEntity[]; relationships: ContextRelationshipAssertion[]; facts: ContextGraphFact[] }>>;
  retrieveGraphContext(input: GraphRetrievalInput): Promise<GraphRetrievalResult>;
  queryEntities(query?: StoreQuery): Promise<ContextEntity[]>;
  queryRelationships(query?: StoreQuery): Promise<ContextRelationshipAssertion[]>;
  queryExtractionRuns(query?: StoreQuery): Promise<ContextExtractionRun[]>;
  projectionOperations(query?: StoreQuery): Promise<Neo4jProjectionOperation[]>;
}

interface SourceRecordLike {
  id: string;
  workspaceId: string;
  connectorType?: string;
  connectorInstanceId?: string;
  externalId?: string;
  uri?: string;
  title?: string;
  sourceKind?: string;
  sensitivity?: ContextSensitivity;
  permissionState?: 'unknown' | 'allowed' | 'denied' | 'partial';
  healthState?: string;
  stalenessState?: string;
  schemaOrDocumentType?: string;
  knownLimitations?: string[];
}

interface SourceVersionLike {
  id: string;
  sourceId: string;
  observedAt: string;
}

interface SourceCitationLike {
  sourceId: string;
  text: string;
  title?: string;
  uri?: string;
  versionId?: string;
  observedAt?: string;
}

interface SourceRegistryLike {
  getSource(id: string): Promise<SourceRecordLike | null>;
  getVersion(id: string): Promise<SourceVersionLike | null>;
  sourceVersions?(sourceId?: string): Promise<SourceVersionLike[]>;
  querySources?(query?: StoreQuery): Promise<SourceRecordLike[]>;
  resolveCitation(sourceId: string, versionId?: string): Promise<SourceCitationLike>;
  recordAccess(input: {
    sourceId: string;
    action: 'read' | 'retrieve' | 'cite' | 'write' | 'delete' | 'health_check';
    allowed: boolean;
    principalId?: string;
    message?: string;
  }): Promise<unknown>;
}

const ENTITY_STORE = 'context_graph_entities';
const RELATIONSHIP_STORE = 'context_graph_relationship_assertions';
const EXTRACTION_RUN_STORE = 'context_graph_extraction_runs';
const PROJECTION_STORE = 'context_graph_projection_ops';

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
  return JSON.stringify(sortForJson(value));
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortForJson(item)]));
  }
  return value;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_@./:#-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function displayName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.8;
  return Math.max(0, Math.min(1, value));
}

function principalId(): string {
  return tryCurrentPrincipal()?.id ?? 'system';
}

async function queryAll<T extends { id: string; version: string }>(store: Store<T>, query?: StoreQuery): Promise<T[]> {
  const result = await store.query(query ?? {});
  return result.items;
}

function sourceWarning(source: SourceRecordLike): string | undefined {
  if (source.permissionState === 'partial') return `Source "${source.title ?? source.id}" has partial permissions.`;
  if (source.healthState === 'degraded' || source.healthState === 'down') return `Source "${source.title ?? source.id}" health is ${source.healthState}.`;
  if (source.stalenessState === 'stale' || source.stalenessState === 'expired') return `Source "${source.title ?? source.id}" is ${source.stalenessState}.`;
  return undefined;
}

function relationshipType(predicate: string): string {
  const normalized = normalizeName(predicate).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return normalized === '' ? 'RELATED_TO' : normalized;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function regexMatches(regex: RegExp, text: string): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  for (const match of text.matchAll(regex)) {
    const value = match[0]?.trim();
    if (value !== undefined && value !== '') out.push({ text: value, index: match.index ?? 0 });
  }
  return out;
}

function deterministicCandidates(text: string): Array<{
  type: ContextEntityType;
  name: string;
  predicate: string;
  confidence: number;
  span?: EvidenceSpan;
  identifiers?: Record<string, string>;
}> {
  const candidates: Array<{
    type: ContextEntityType;
    name: string;
    predicate: string;
    confidence: number;
    span?: EvidenceSpan;
    identifiers?: Record<string, string>;
  }> = [];
  const add = (input: typeof candidates[number]): void => {
    const key = `${input.type}:${normalizeName(input.name)}:${input.predicate}`;
    if (candidates.some(candidate => `${candidate.type}:${normalizeName(candidate.name)}:${candidate.predicate}` === key)) return;
    candidates.push(input);
  };

  for (const match of regexMatches(/^#{1,6}\s+(.+)$/gm, text)) {
    const heading = match.text.replace(/^#{1,6}\s+/, '').trim();
    add({
      type: 'document',
      name: heading,
      predicate: 'has_heading',
      confidence: 0.9,
      span: { start: match.index, end: match.index + match.text.length, text: match.text },
    });
  }
  for (const match of regexMatches(/\b[A-Z][A-Z0-9]+-\d+\b/g, text)) {
    add({
      type: 'ticket',
      name: match.text,
      predicate: 'references_ticket',
      confidence: 0.95,
      span: { start: match.index, end: match.index + match.text.length, text: match.text },
      identifiers: { issueKey: match.text },
    });
  }
  for (const match of regexMatches(/\b#[1-9]\d{1,8}\b/g, text)) {
    add({
      type: 'ticket',
      name: match.text,
      predicate: 'references_ticket',
      confidence: 0.8,
      span: { start: match.index, end: match.index + match.text.length, text: match.text },
      identifiers: { issueNumber: match.text.slice(1) },
    });
  }
  for (const match of regexMatches(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, text)) {
    add({
      type: 'person',
      name: match.text.toLowerCase(),
      predicate: 'references_email',
      confidence: 0.95,
      span: { start: match.index, end: match.index + match.text.length, text: match.text },
      identifiers: { email: match.text.toLowerCase() },
    });
  }
  for (const match of regexMatches(/\bhttps?:\/\/[^\s)>\]]+/gi, text)) {
    add({
      type: 'document',
      name: match.text,
      predicate: 'links_to',
      confidence: 0.9,
      span: { start: match.index, end: match.index + match.text.length, text: match.text },
      identifiers: { url: match.text },
    });
  }
  for (const match of regexMatches(/\b(?:[A-Za-z]:\\|\.{1,2}\/|\/)[^\s:*?"<>|]+/g, text)) {
    add({
      type: 'document',
      name: match.text,
      predicate: 'references_file',
      confidence: 0.85,
      span: { start: match.index, end: match.index + match.text.length, text: match.text },
      identifiers: { path: match.text },
    });
  }
  for (const match of regexMatches(/\b\d{4}-\d{2}-\d{2}\b/g, text)) {
    add({
      type: 'decision',
      name: match.text,
      predicate: 'mentions_date',
      confidence: 0.75,
      span: { start: match.index, end: match.index + match.text.length, text: match.text },
      identifiers: { date: match.text },
    });
  }
  for (const match of regexMatches(/\b[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*\b/g, text)) {
    if (match.text.includes('@')) continue;
    add({
      type: 'system',
      name: match.text,
      predicate: 'references_table',
      confidence: 0.7,
      span: { start: match.index, end: match.index + match.text.length, text: match.text },
      identifiers: { table: match.text },
    });
  }
  return candidates;
}

class StoreBackedContextGraph implements ContextGraph {
  private readonly entities: Store<ContextEntity>;
  private readonly relationships: Store<ContextRelationshipAssertion>;
  private readonly extractionRuns: Store<ContextExtractionRun>;
  private readonly projectionOps: Store<Neo4jProjectionOperation>;
  private readonly sourceRegistry: SourceRegistryLike | undefined;

  constructor(
    entities: Store<ContextEntity>,
    relationships: Store<ContextRelationshipAssertion>,
    extractionRuns: Store<ContextExtractionRun>,
    projectionOps: Store<Neo4jProjectionOperation>,
    sourceRegistry: SourceRegistryLike | undefined,
  ) {
    this.entities = entities;
    this.relationships = relationships;
    this.extractionRuns = extractionRuns;
    this.projectionOps = projectionOps;
    this.sourceRegistry = sourceRegistry;
  }

  stableEntityId(workspaceId: string, type: ContextEntityType, canonicalName: string): string {
    return hashId('context-entity', [workspaceId, type, normalizeName(canonicalName)]);
  }

  stableRelationshipAssertionId(input: ContextRelationshipAssertionInput): string {
    return hashId('context-relationship', [
      input.workspaceId,
      input.subjectEntityId,
      normalizeName(input.predicate),
      input.objectEntityId,
      input.sourceId,
      input.sourceVersionId ?? '',
      input.validFrom ?? '',
      input.validTo ?? '',
    ]);
  }

  async upsertEntity(input: ContextEntityInput): Promise<ContextEntity> {
    const id = input.id ?? this.stableEntityId(input.workspaceId, input.type, input.canonicalName);
    const existing = await this.entities.get(id);
    const timestamp = nowIso();
    const entity: ContextEntity = {
      id,
      version: randomUUID(),
      workspaceId: input.workspaceId,
      type: input.type,
      canonicalName: displayName(input.canonicalName),
      aliases: uniq([...(existing?.aliases ?? []), ...(input.aliases ?? [])]),
      identifiers: { ...(existing?.identifiers ?? {}), ...(input.identifiers ?? {}) },
      sensitivity: input.sensitivity ?? existing?.sensitivity ?? 'internal',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.entities.set(id, entity);
    await this.enqueueEntityProjection(entity);
    return entity;
  }

  async assertRelationship(input: ContextRelationshipAssertionInput): Promise<ContextRelationshipAssertion> {
    const subject = await this.entities.get(input.subjectEntityId);
    if (subject === null) throw new Error(`Unknown subject entity "${input.subjectEntityId}".`);
    const object = await this.entities.get(input.objectEntityId);
    if (object === null) throw new Error(`Unknown object entity "${input.objectEntityId}".`);
    if (subject.workspaceId !== input.workspaceId || object.workspaceId !== input.workspaceId) {
      throw new Error('Relationship entities must belong to the assertion workspace.');
    }
    const id = input.id ?? this.stableRelationshipAssertionId(input);
    const existing = await this.relationships.get(id);
    const timestamp = nowIso();
    const relationship: ContextRelationshipAssertion = {
      id,
      version: randomUUID(),
      workspaceId: input.workspaceId,
      subjectEntityId: input.subjectEntityId,
      predicate: normalizeName(input.predicate),
      objectEntityId: input.objectEntityId,
      confidence: clampConfidence(input.confidence ?? existing?.confidence),
      extractionMethod: input.extractionMethod ?? existing?.extractionMethod ?? 'deterministic',
      sourceId: input.sourceId,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(input.validFrom ?? existing?.validFrom !== undefined ? { validFrom: (input.validFrom ?? existing?.validFrom)! } : {}),
      ...(input.validTo ?? existing?.validTo !== undefined ? { validTo: (input.validTo ?? existing?.validTo)! } : {}),
      ...(input.sourceVersionId ?? existing?.sourceVersionId !== undefined ? { sourceVersionId: (input.sourceVersionId ?? existing?.sourceVersionId)! } : {}),
      ...(input.evidenceSpan ?? existing?.evidenceSpan !== undefined ? { evidenceSpan: input.evidenceSpan ?? existing?.evidenceSpan! } : {}),
    };
    await this.relationships.set(id, relationship);
    await this.enqueueRelationshipProjection(relationship, subject, object);
    return relationship;
  }

  async ingestSource(input: ContextIngestSourceInput): Promise<ContextExtractionRun> {
    const startedAt = nowIso();
    const method = input.extractionMethod ?? 'deterministic';
    try {
      const source = await this.requireSource(input.sourceId);
      const sourceVersion = input.sourceVersionId ?? await this.latestSourceVersionId(input.sourceId);
      const sourceEntity = await this.upsertEntity({
        workspaceId: source.workspaceId,
        type: source.sourceKind === 'ticket' ? 'ticket' : source.sourceKind === 'metric' ? 'metric' : 'document',
        canonicalName: source.title ?? source.uri ?? source.id,
        aliases: uniq([source.uri ?? '', source.externalId ?? '']),
        identifiers: {
          sourceId: source.id,
          ...(source.uri !== undefined ? { uri: source.uri } : {}),
          ...(source.externalId !== undefined ? { externalId: source.externalId } : {}),
        },
        sensitivity: source.sensitivity ?? 'internal',
      });
      const text = [
        source.title ?? '',
        source.uri ?? '',
        source.schemaOrDocumentType ?? '',
        source.connectorType ?? '',
        ...(source.knownLimitations ?? []),
        input.text ?? '',
      ].filter(Boolean).join('\n');

      let entityCount = 1;
      let relationshipCount = 0;
      for (const candidate of deterministicCandidates(text)) {
        const entity = await this.upsertEntity({
          workspaceId: source.workspaceId,
          type: candidate.type,
          canonicalName: candidate.name,
          aliases: [],
          identifiers: candidate.identifiers ?? {},
          sensitivity: source.sensitivity ?? 'internal',
        });
        entityCount++;
        await this.assertRelationship({
          workspaceId: source.workspaceId,
          subjectEntityId: sourceEntity.id,
          predicate: candidate.predicate,
          objectEntityId: entity.id,
          confidence: candidate.confidence,
          extractionMethod: method,
          sourceId: source.id,
          ...(sourceVersion !== undefined ? { sourceVersionId: sourceVersion } : {}),
          ...(candidate.span !== undefined ? { evidenceSpan: candidate.span } : {}),
        });
        relationshipCount++;
      }
      const run: ContextExtractionRun = {
        id: hashId('context-extraction-run', [input.sourceId, sourceVersion ?? 'latest', method]),
        version: randomUUID(),
        workspaceId: source.workspaceId,
        sourceId: input.sourceId,
        ...(sourceVersion !== undefined ? { sourceVersionId: sourceVersion } : {}),
        extractionMethod: method,
        status: 'succeeded',
        entityCount,
        relationshipCount,
        startedAt,
        finishedAt: nowIso(),
      };
      await this.extractionRuns.set(run.id, run);
      return run;
    } catch (error) {
      const run: ContextExtractionRun = {
        id: hashId('context-extraction-run', [input.sourceId, input.sourceVersionId ?? 'latest', method]),
        version: randomUUID(),
        workspaceId: 'unknown',
        sourceId: input.sourceId,
        ...(input.sourceVersionId !== undefined ? { sourceVersionId: input.sourceVersionId } : {}),
        extractionMethod: method,
        status: 'failed',
        entityCount: 0,
        relationshipCount: 0,
        startedAt,
        finishedAt: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      };
      await this.extractionRuns.set(run.id, run);
      return run;
    }
  }

  async searchEntities(workspaceId: string, terms: string[], limit = 20): Promise<ContextEntity[]> {
    const normalized = terms.map(normalizeName).filter(Boolean);
    const entities = await this.queryEntities({ where: { op: 'eq', field: 'workspaceId', value: workspaceId } });
    if (normalized.length === 0) return entities.slice(0, limit);
    return entities
      .map(entity => ({ entity, score: this.entitySearchScore(entity, normalized) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.entity.canonicalName.localeCompare(right.entity.canonicalName))
      .slice(0, limit)
      .map(item => item.entity);
  }

  async neighbors(entityId: string, options: { depth?: number; maxRelationships?: number } = {}): Promise<{ entities: ContextEntity[]; relationships: ContextRelationshipAssertion[]; facts: ContextGraphFact[] }> {
    const start = await this.entities.get(entityId);
    if (start === null) throw new Error(`Unknown context entity "${entityId}".`);
    const maxDepth = Math.max(1, Math.min(4, Math.trunc(options.depth ?? 1)));
    const maxRelationships = Math.max(1, Math.min(100, Math.trunc(options.maxRelationships ?? 25)));
    const visited = new Set<string>([entityId]);
    const frontier: Array<{ entityId: string; depth: number }> = [{ entityId, depth: 0 }];
    const relationships: ContextRelationshipAssertion[] = [];
    const entities = new Map<string, ContextEntity>([[start.id, start]]);

    while (frontier.length > 0 && relationships.length < maxRelationships) {
      const current = frontier.shift()!;
      if (current.depth >= maxDepth) continue;
      const adjacent = (await this.relationshipsForEntity(current.entityId))
        .filter(relationship => relationship.workspaceId === start.workspaceId);
      for (const relationship of adjacent) {
        if (relationships.length >= maxRelationships) break;
        if (!await this.relationshipSourceAllowed(relationship)) continue;
        relationships.push(relationship);
        const nextId = relationship.subjectEntityId === current.entityId ? relationship.objectEntityId : relationship.subjectEntityId;
        const next = await this.entities.get(nextId);
        if (next !== null) entities.set(next.id, next);
        if (!visited.has(nextId)) {
          visited.add(nextId);
          frontier.push({ entityId: nextId, depth: current.depth + 1 });
        }
      }
    }
    const facts = await this.factsForRelationships(relationships);
    return { entities: [...entities.values()], relationships, facts };
  }

  async pathSearch(startEntityId: string, targetEntityId: string, options: { maxDepth?: number; maxPaths?: number } = {}): Promise<Array<{ entities: ContextEntity[]; relationships: ContextRelationshipAssertion[]; facts: ContextGraphFact[] }>> {
    const start = await this.entities.get(startEntityId);
    const target = await this.entities.get(targetEntityId);
    if (start === null) throw new Error(`Unknown start entity "${startEntityId}".`);
    if (target === null) throw new Error(`Unknown target entity "${targetEntityId}".`);
    if (start.workspaceId !== target.workspaceId) return [];
    const maxDepth = Math.max(1, Math.min(5, Math.trunc(options.maxDepth ?? 3)));
    const maxPaths = Math.max(1, Math.min(10, Math.trunc(options.maxPaths ?? 3)));
    const queue: Array<{ entityId: string; path: ContextRelationshipAssertion[]; visited: Set<string> }> = [
      { entityId: start.id, path: [], visited: new Set([start.id]) },
    ];
    const paths: ContextRelationshipAssertion[][] = [];
    while (queue.length > 0 && paths.length < maxPaths) {
      const current = queue.shift()!;
      if (current.path.length >= maxDepth) continue;
      for (const relationship of await this.relationshipsForEntity(current.entityId)) {
        if (!await this.relationshipSourceAllowed(relationship)) continue;
        const nextId = relationship.subjectEntityId === current.entityId ? relationship.objectEntityId : relationship.subjectEntityId;
        if (current.visited.has(nextId)) continue;
        const nextPath = [...current.path, relationship];
        if (nextId === target.id) {
          paths.push(nextPath);
          if (paths.length >= maxPaths) break;
        } else {
          queue.push({ entityId: nextId, path: nextPath, visited: new Set([...current.visited, nextId]) });
        }
      }
    }
    const out: Array<{ entities: ContextEntity[]; relationships: ContextRelationshipAssertion[]; facts: ContextGraphFact[] }> = [];
    for (const path of paths) {
      const entityIds = uniq([start.id, target.id, ...path.flatMap(relationship => [relationship.subjectEntityId, relationship.objectEntityId])]);
      const entities = (await Promise.all(entityIds.map(id => this.entities.get(id)))).filter((item): item is ContextEntity => item !== null);
      out.push({ entities, relationships: path, facts: await this.factsForRelationships(path) });
    }
    return out;
  }

  async retrieveGraphContext(input: GraphRetrievalInput): Promise<GraphRetrievalResult> {
    const maxRelationships = Math.max(1, Math.min(100, Math.trunc(input.maxRelationships ?? 20)));
    const seeds = new Map<string, ContextEntity>();
    for (const entityId of input.entityIds ?? []) {
      const entity = await this.entities.get(entityId);
      if (entity !== null && entity.workspaceId === input.workspaceId) seeds.set(entity.id, entity);
    }
    for (const entity of await this.searchEntities(input.workspaceId, input.terms ?? [], maxRelationships)) seeds.set(entity.id, entity);
    if ((input.sourceIds ?? []).length > 0) {
      const relationships = await this.queryRelationships({ where: { op: 'eq', field: 'workspaceId', value: input.workspaceId } });
      for (const relationship of relationships.filter(item => input.sourceIds!.includes(item.sourceId))) {
        const subject = await this.entities.get(relationship.subjectEntityId);
        const object = await this.entities.get(relationship.objectEntityId);
        if (subject !== null) seeds.set(subject.id, subject);
        if (object !== null) seeds.set(object.id, object);
      }
    }
    const seenRelationships = new Set<string>();
    const facts: ContextGraphFact[] = [];
    const warnings: string[] = [];
    for (const seed of seeds.values()) {
      if (facts.length >= maxRelationships) break;
      const expanded = await this.neighbors(seed.id, {
        depth: input.maxDepth ?? 1,
        maxRelationships: maxRelationships - facts.length,
      });
      for (const fact of expanded.facts) {
        if (seenRelationships.has(fact.relationship.id)) continue;
        seenRelationships.add(fact.relationship.id);
        facts.push(fact);
        if (fact.warning !== undefined) warnings.push(fact.warning);
        if (facts.length >= maxRelationships) break;
      }
    }
    return {
      seedEntities: [...seeds.values()],
      facts,
      warnings: uniq(warnings),
    };
  }

  queryEntities(query?: StoreQuery): Promise<ContextEntity[]> {
    return queryAll(this.entities, query);
  }

  queryRelationships(query?: StoreQuery): Promise<ContextRelationshipAssertion[]> {
    return queryAll(this.relationships, query);
  }

  queryExtractionRuns(query?: StoreQuery): Promise<ContextExtractionRun[]> {
    return queryAll(this.extractionRuns, query);
  }

  projectionOperations(query?: StoreQuery): Promise<Neo4jProjectionOperation[]> {
    return queryAll(this.projectionOps, query);
  }

  private entitySearchScore(entity: ContextEntity, terms: readonly string[]): number {
    const haystack = [
      normalizeName(entity.canonicalName),
      ...entity.aliases.map(normalizeName),
      ...Object.values(entity.identifiers).map(normalizeName),
      entity.type,
    ].join(' ');
    return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  }

  private async relationshipsForEntity(entityId: string): Promise<ContextRelationshipAssertion[]> {
    const relationships = await this.queryRelationships();
    return relationships.filter(relationship => relationship.subjectEntityId === entityId || relationship.objectEntityId === entityId);
  }

  private async relationshipSourceAllowed(relationship: ContextRelationshipAssertion): Promise<boolean> {
    if (this.sourceRegistry === undefined) return true;
    const source = await this.sourceRegistry.getSource(relationship.sourceId).catch(() => null);
    if (source === null) return false;
    return source.workspaceId === relationship.workspaceId && source.permissionState !== 'denied';
  }

  private async factsForRelationships(relationships: readonly ContextRelationshipAssertion[]): Promise<ContextGraphFact[]> {
    const facts: ContextGraphFact[] = [];
    const sourceAccess = new Set<string>();
    for (const relationship of relationships) {
      const subject = await this.entities.get(relationship.subjectEntityId);
      const object = await this.entities.get(relationship.objectEntityId);
      if (subject === null || object === null) continue;
      let source: SourceRecordLike | null = null;
      let citation: SourceCitationLike | undefined;
      if (this.sourceRegistry !== undefined) {
        source = await this.sourceRegistry.getSource(relationship.sourceId).catch(() => null);
        if (source === null || source.permissionState === 'denied') continue;
        citation = await this.sourceRegistry.resolveCitation(relationship.sourceId, relationship.sourceVersionId).catch(() => undefined);
        if (!sourceAccess.has(relationship.sourceId)) {
          sourceAccess.add(relationship.sourceId);
          await this.sourceRegistry.recordAccess({
            sourceId: relationship.sourceId,
            action: 'retrieve',
            allowed: true,
            principalId: principalId(),
            message: `Context graph retrieved relationship ${relationship.id}.`,
          }).catch(() => undefined);
        }
      }
      const warning = source !== null ? sourceWarning(source) : undefined;
      facts.push({
        relationship,
        subject,
        object,
        sourceId: relationship.sourceId,
        ...(citation?.text !== undefined ? { citationText: citation.text } : {}),
        ...(relationship.sourceVersionId !== undefined ? { sourceVersionId: relationship.sourceVersionId } : {}),
        ...(source?.title !== undefined ? { sourceTitle: source.title } : {}),
        ...(source?.uri !== undefined ? { sourceUri: source.uri } : {}),
        ...(source?.healthState !== undefined ? { sourceHealthState: source.healthState } : {}),
        ...(source?.stalenessState !== undefined ? { sourceStalenessState: source.stalenessState } : {}),
        ...(warning !== undefined ? { warning } : {}),
      });
    }
    return facts;
  }

  private async requireSource(sourceId: string): Promise<SourceRecordLike> {
    if (this.sourceRegistry === undefined) throw new Error('Context graph source ingestion requires SourceRegistry.');
    const source = await this.sourceRegistry.getSource(sourceId);
    if (source === null) throw new Error(`Unknown source "${sourceId}".`);
    if (source.permissionState === 'denied') throw new Error(`Source "${sourceId}" is denied and cannot be ingested.`);
    return source;
  }

  private async latestSourceVersionId(sourceId: string): Promise<string | undefined> {
    if (this.sourceRegistry?.sourceVersions === undefined) return undefined;
    const versions = await this.sourceRegistry.sourceVersions(sourceId).catch(() => []);
    return versions.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0]?.id;
  }

  private async enqueueEntityProjection(entity: ContextEntity): Promise<void> {
    const cypher = [
      'MERGE (e:CortexEntity {id: $id})',
      'SET e.workspaceId = $workspaceId, e.type = $type, e.canonicalName = $canonicalName, e.aliases = $aliases, e.identifiers = $identifiers, e.sensitivity = $sensitivity, e.updatedAt = $updatedAt',
    ].join('\n');
    await this.upsertProjectionOperation('merge_entity', entity.workspaceId, cypher, {
      id: entity.id,
      workspaceId: entity.workspaceId,
      type: entity.type,
      canonicalName: entity.canonicalName,
      aliases: entity.aliases,
      identifiers: entity.identifiers,
      sensitivity: entity.sensitivity,
      updatedAt: entity.updatedAt,
    });
  }

  private async enqueueRelationshipProjection(relationship: ContextRelationshipAssertion, subject: ContextEntity, object: ContextEntity): Promise<void> {
    const relType = relationshipType(relationship.predicate);
    const cypher = [
      'MERGE (s:CortexEntity {id: $subjectEntityId})',
      'MERGE (o:CortexEntity {id: $objectEntityId})',
      `MERGE (s)-[r:${relType} {id: $id}]->(o)`,
      'SET r.workspaceId = $workspaceId, r.predicate = $predicate, r.confidence = $confidence, r.extractionMethod = $extractionMethod, r.sourceId = $sourceId, r.sourceVersionId = $sourceVersionId, r.validFrom = $validFrom, r.validTo = $validTo, r.updatedAt = $updatedAt',
    ].join('\n');
    await this.upsertProjectionOperation('merge_relationship', relationship.workspaceId, cypher, {
      id: relationship.id,
      workspaceId: relationship.workspaceId,
      subjectEntityId: subject.id,
      objectEntityId: object.id,
      predicate: relationship.predicate,
      confidence: relationship.confidence,
      extractionMethod: relationship.extractionMethod,
      sourceId: relationship.sourceId,
      sourceVersionId: relationship.sourceVersionId ?? null,
      validFrom: relationship.validFrom ?? null,
      validTo: relationship.validTo ?? null,
      updatedAt: relationship.updatedAt,
    });
  }

  private async upsertProjectionOperation(operationType: Neo4jProjectionOperation['operationType'], workspaceId: string, cypher: string, parameters: Record<string, unknown>): Promise<void> {
    const operationHash = hashPayload({ operationType, cypher, parameters });
    const id = hashId('context-neo4j-projection', [workspaceId, operationHash]);
    const existing = await this.projectionOps.get(id);
    const timestamp = nowIso();
    await this.projectionOps.set(id, {
      id,
      version: randomUUID(),
      workspaceId,
      operationHash,
      operationType,
      cypher,
      parameters,
      status: existing?.status ?? 'queued',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(existing?.error !== undefined ? { error: existing.error } : {}),
    });
  }
}

interface ContextGraphActionInput {
  action: string;
  entity?: ContextEntityInput;
  relationship?: ContextRelationshipAssertionInput;
  sourceId?: string;
  sourceIds?: string[];
  sourceVersionId?: string;
  text?: string;
  extractionMethod?: ExtractionMethod;
  workspaceId?: string;
  terms?: string[];
  entityId?: string;
  startEntityId?: string;
  targetEntityId?: string;
  maxDepth?: number;
  maxRelationships?: number;
  query?: StoreQuery;
}

function createContextGraphTool(graph: ContextGraph): Tool {
  return {
    name: 'context_graph_action',
    description:
      'Manage Cortex context graph entities, source-backed relationship assertions, deterministic source extraction, Neo4j projection operations, and source-filtered graph retrieval.\n\n' +
      'Actions: list, upsert_entity, assert_relationship, extract_source, search_entities, neighbors, path_search, retrieve, projection_log.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'upsert_entity', 'assert_relationship', 'extract_source', 'search_entities', 'neighbors', 'path_search', 'retrieve', 'projection_log'] },
        entity: { type: 'object' },
        relationship: { type: 'object' },
        sourceId: { type: 'string' },
        sourceIds: { type: 'array', items: { type: 'string' } },
        sourceVersionId: { type: 'string' },
        text: { type: 'string' },
        extractionMethod: { type: 'string', enum: ['deterministic', 'connector_metadata', 'model_extracted', 'user_confirmed'] },
        workspaceId: { type: 'string' },
        terms: { type: 'array', items: { type: 'string' } },
        entityId: { type: 'string' },
        startEntityId: { type: 'string' },
        targetEntityId: { type: 'string' },
        maxDepth: { type: 'number' },
        maxRelationships: { type: 'number' },
        query: { type: 'object' },
      },
    },
    executor: {
      async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
        const parsed = input && typeof input === 'object' ? input as ContextGraphActionInput : { action: '' };
        try {
          switch (parsed.action) {
            case 'list':
              yield { type: 'result', value: {
                entities: await graph.queryEntities(parsed.query),
                relationships: await graph.queryRelationships(parsed.query),
                extractionRuns: await graph.queryExtractionRuns(parsed.query),
              } };
              return;
            case 'upsert_entity':
              if (parsed.entity === undefined) { yield { type: 'error', message: 'context_graph_action upsert_entity requires "entity".' }; return; }
              yield { type: 'result', value: await graph.upsertEntity(parsed.entity) };
              return;
            case 'assert_relationship':
              if (parsed.relationship === undefined) { yield { type: 'error', message: 'context_graph_action assert_relationship requires "relationship".' }; return; }
              yield { type: 'result', value: await graph.assertRelationship(parsed.relationship) };
              return;
            case 'extract_source':
              if (parsed.sourceId === undefined) { yield { type: 'error', message: 'context_graph_action extract_source requires "sourceId".' }; return; }
              yield { type: 'result', value: await graph.ingestSource({
                sourceId: parsed.sourceId,
                ...(parsed.sourceVersionId !== undefined ? { sourceVersionId: parsed.sourceVersionId } : {}),
                ...(parsed.text !== undefined ? { text: parsed.text } : {}),
                ...(parsed.extractionMethod !== undefined ? { extractionMethod: parsed.extractionMethod } : {}),
              }) };
              return;
            case 'search_entities':
              if (parsed.workspaceId === undefined) { yield { type: 'error', message: 'context_graph_action search_entities requires "workspaceId".' }; return; }
              yield { type: 'result', value: { entities: await graph.searchEntities(parsed.workspaceId, parsed.terms ?? [], parsed.maxRelationships) } };
              return;
            case 'neighbors':
              if (parsed.entityId === undefined) { yield { type: 'error', message: 'context_graph_action neighbors requires "entityId".' }; return; }
              yield { type: 'result', value: await graph.neighbors(parsed.entityId, {
                ...(parsed.maxDepth !== undefined ? { depth: parsed.maxDepth } : {}),
                ...(parsed.maxRelationships !== undefined ? { maxRelationships: parsed.maxRelationships } : {}),
              }) };
              return;
            case 'path_search':
              if (parsed.startEntityId === undefined || parsed.targetEntityId === undefined) { yield { type: 'error', message: 'context_graph_action path_search requires "startEntityId" and "targetEntityId".' }; return; }
              yield { type: 'result', value: { paths: await graph.pathSearch(parsed.startEntityId, parsed.targetEntityId, {
                ...(parsed.maxDepth !== undefined ? { maxDepth: parsed.maxDepth } : {}),
              }) } };
              return;
            case 'retrieve':
              if (parsed.workspaceId === undefined) { yield { type: 'error', message: 'context_graph_action retrieve requires "workspaceId".' }; return; }
              yield { type: 'result', value: await graph.retrieveGraphContext({
                workspaceId: parsed.workspaceId,
                terms: parsed.terms ?? [],
                ...(parsed.entityId !== undefined ? { entityIds: [parsed.entityId] } : {}),
                ...(parsed.sourceIds !== undefined ? { sourceIds: parsed.sourceIds } : {}),
                ...(parsed.maxDepth !== undefined ? { maxDepth: parsed.maxDepth } : {}),
                ...(parsed.maxRelationships !== undefined ? { maxRelationships: parsed.maxRelationships } : {}),
              }) };
              return;
            case 'projection_log':
              yield { type: 'result', value: { operations: await graph.projectionOperations(parsed.query) } };
              return;
            default:
              yield { type: 'error', message: `Unknown context_graph_action "${String(parsed.action)}".` };
          }
        } catch (error) {
          yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
        }
      },
    },
  };
}

export function createContextGraph(services: MatbotMachine): ContextGraph {
  const sourceRegistry = services.get('SourceRegistry' as never) as SourceRegistryLike | undefined;
  return new StoreBackedContextGraph(
    services.createStore<ContextEntity>(ENTITY_STORE),
    services.createStore<ContextRelationshipAssertion>(RELATIONSHIP_STORE),
    services.createStore<ContextExtractionRun>(EXTRACTION_RUN_STORE),
    services.createStore<Neo4jProjectionOperation>(PROJECTION_STORE),
    sourceRegistry,
  );
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Registers ContextGraph and context_graph_action for source-backed entity and relationship retrieval.',
  },
  async setup(services: MatbotMachine) {
    const graph = createContextGraph(services);
    await services.register('ContextGraph', graph);
    services.tools.register(createContextGraphTool(graph));
  },
};

export default plugin;
