import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolConfig, QueryResult } from 'pg';
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
    readonly DataCatalog?: DataCatalog;
    readonly SqlPlanner?: SqlPlanner;
  }
}

export type DataDialect = 'postgres' | 'sqlserver' | 'snowflake' | 'bigquery' | 'duckdb';
export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'unknown';
export type MetricAggregation = 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max' | 'ratio' | 'custom';
export type QueryRunStatus = 'planned' | 'approved' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'string_contains';

export interface DataConnection {
  id: string;
  version: string;
  workspaceId: string;
  connectorInstanceId: string;
  dialect: DataDialect;
  readOnly: boolean;
  credentialRef: string;
  rowLimitDefault: number;
  timeoutMsDefault: number;
  createdAt: string;
  updatedAt: string;
  displayName?: string;
  defaultSchema?: string;
}

export type DataConnectionInput = {
  id?: string;
  workspaceId: string;
  connectorInstanceId?: string;
  dialect?: DataDialect;
  readOnly?: boolean;
  credentialRef?: string;
  rowLimitDefault?: number;
  timeoutMsDefault?: number;
  displayName?: string;
  defaultSchema?: string;
};

export interface DataTable {
  id: string;
  version: string;
  workspaceId: string;
  connectionId: string;
  schemaName: string;
  tableName: string;
  displayName: string;
  sourceId?: string;
  primaryKey: string[];
  allowed: boolean;
  rowLevelConstraintSql?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export type DataTableInput = {
  id?: string;
  workspaceId: string;
  connectionId: string;
  schemaName: string;
  tableName: string;
  displayName?: string;
  sourceId?: string;
  primaryKey?: string[];
  allowed?: boolean;
  rowLevelConstraintSql?: string;
  description?: string;
  columns?: DataColumnInput[];
};

export interface DataColumn {
  id: string;
  version: string;
  workspaceId: string;
  tableId: string;
  name: string;
  displayName: string;
  dataType: ColumnType;
  nullable: boolean;
  role: 'dimension' | 'measure' | 'identifier' | 'timestamp' | 'unknown';
  allowed: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export type DataColumnInput = {
  id?: string;
  workspaceId?: string;
  tableId: string;
  name: string;
  displayName?: string;
  dataType?: ColumnType;
  nullable?: boolean;
  role?: DataColumn['role'];
  allowed?: boolean;
  description?: string;
};

export interface MetricDefinition {
  id: string;
  version: string;
  workspaceId: string;
  name: string;
  businessName: string;
  baseTableId: string;
  expression: string;
  aggregation: MetricAggregation;
  allowedDimensions: string[];
  allowedFilters: string[];
  createdAt: string;
  updatedAt: string;
  description?: string;
  ownerPrincipalId?: string;
  sourceId?: string;
}

export type MetricDefinitionInput = {
  id?: string;
  workspaceId: string;
  name: string;
  businessName?: string;
  description?: string;
  baseTableId: string;
  expression: string;
  aggregation: MetricAggregation;
  allowedDimensions?: string[];
  allowedFilters?: string[];
  ownerPrincipalId?: string;
  sourceId?: string;
};

export interface SemanticFilter {
  columnId: string;
  op: FilterOperator;
  value: string | number | boolean | Array<string | number | boolean>;
}

export interface QueryPlanInput {
  workspaceId: string;
  metricId?: string;
  metricName?: string;
  dimensions?: string[];
  filters?: SemanticFilter[];
  limit?: number;
}

export interface SqlValidationResult {
  valid: boolean;
  readOnly: boolean;
  hasExplicitLimit: boolean;
  reasons: string[];
  sqlHash: string;
}

export interface QueryCostEstimate {
  complexity: 'low' | 'medium' | 'high';
  score: number;
  factors: string[];
}

export interface QueryRun {
  id: string;
  version: string;
  workspaceId: string;
  dataConnectionId: string;
  principalId: string;
  status: QueryRunStatus;
  sql: string;
  sqlHash: string;
  semanticInputs: string[];
  parameters: unknown[];
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
  rowLimit?: number;
  rowCount?: number;
  executedAt?: string;
  resultSourceId?: string;
  error?: string;
  approvalTokenHash?: string;
  approvedAt?: string;
  approvalExpiresAt?: string;
}

export interface QueryPlan {
  queryRun: QueryRun;
  metric: MetricDefinition;
  table: DataTable;
  dimensions: DataColumn[];
  filters: SemanticFilter[];
  validation: SqlValidationResult;
  costEstimate: QueryCostEstimate;
  rowCapWarning?: string;
}

export interface ExecuteQueryResult {
  run: QueryRun;
  rows: Record<string, unknown>[];
  fields: string[];
  citation?: {
    sourceId: string;
    text: string;
  };
}

export interface DataCatalog {
  stableConnectionId(workspaceId: string, dialect: DataDialect, displayName: string): string;
  stableTableId(connectionId: string, schemaName: string, tableName: string): string;
  stableColumnId(tableId: string, columnName: string): string;
  stableMetricId(workspaceId: string, name: string): string;
  upsertConnection(input: DataConnectionInput): Promise<DataConnection>;
  upsertTable(input: DataTableInput): Promise<DataTable>;
  upsertColumn(input: DataColumnInput): Promise<DataColumn>;
  upsertMetric(input: MetricDefinitionInput): Promise<MetricDefinition>;
  getConnection(id: string): Promise<DataConnection | null>;
  getTable(id: string): Promise<DataTable | null>;
  getColumn(id: string): Promise<DataColumn | null>;
  getMetric(id: string): Promise<MetricDefinition | null>;
  metricByName(workspaceId: string, name: string): Promise<MetricDefinition | null>;
  queryConnections(query?: StoreQuery): Promise<DataConnection[]>;
  queryTables(query?: StoreQuery): Promise<DataTable[]>;
  queryColumns(query?: StoreQuery): Promise<DataColumn[]>;
  queryMetrics(query?: StoreQuery): Promise<MetricDefinition[]>;
}

export interface SqlPlanner {
  planQuery(input: QueryPlanInput): Promise<QueryPlan>;
  approveQuery(queryRunId: string): Promise<{ queryRun: QueryRun; approvalToken: string }>;
  executeQuery(queryRunId: string, approvalToken: string, ctx: ToolContext): Promise<ExecuteQueryResult>;
  validateSql(sql: string, options?: { requireLimit?: boolean }): SqlValidationResult;
  queryRuns(query?: StoreQuery): Promise<QueryRun[]>;
  getQueryRun(id: string): Promise<QueryRun | null>;
}

interface SourceRegistryLike {
  upsertSource(input: Record<string, unknown>): Promise<{ id: string }>;
  upsertVersion(input: Record<string, unknown>): Promise<{ id: string }>;
  resolveCitation(sourceId: string, versionId?: string): Promise<{ text: string }>;
}

const CONNECTION_STORE = 'structured_data_connections';
const TABLE_STORE = 'structured_data_tables';
const COLUMN_STORE = 'structured_data_columns';
const METRIC_STORE = 'structured_data_metrics';
const QUERY_RUN_STORE = 'structured_data_query_runs';
const DEFAULT_ROW_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CREDENTIAL_REF = '${CORTEX_STRUCTURED_POSTGRES_URL}';
const DEFAULT_CONNECTOR_INSTANCE_ID = 'connector-instance:postgres-readonly:local';

function nowIso(): string {
  return new Date().toISOString();
}

function hashId(prefix: string, parts: readonly string[]): string {
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `${prefix}:${hash}`;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function principalId(): string {
  return tryCurrentPrincipal()?.id ?? 'system';
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier "${value}".`);
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function scalarValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

async function queryAll<T extends { id: string; version: string }>(store: Store<T>, query?: StoreQuery): Promise<T[]> {
  const result = await store.query(query ?? {});
  return result.items;
}

class StoreBackedDataCatalog implements DataCatalog {
  private readonly connections: Store<DataConnection>;
  private readonly tables: Store<DataTable>;
  private readonly columns: Store<DataColumn>;
  private readonly metrics: Store<MetricDefinition>;
  private readonly sourceRegistry: SourceRegistryLike | undefined;

  constructor(
    connections: Store<DataConnection>,
    tables: Store<DataTable>,
    columns: Store<DataColumn>,
    metrics: Store<MetricDefinition>,
    sourceRegistry: SourceRegistryLike | undefined,
  ) {
    this.connections = connections;
    this.tables = tables;
    this.columns = columns;
    this.metrics = metrics;
    this.sourceRegistry = sourceRegistry;
  }

  stableConnectionId(workspaceId: string, dialect: DataDialect, displayName: string): string {
    return hashId('data-connection', [workspaceId, dialect, displayName]);
  }

  stableTableId(connectionId: string, schemaName: string, tableName: string): string {
    return hashId('data-table', [connectionId, schemaName, tableName]);
  }

  stableColumnId(tableId: string, columnName: string): string {
    return hashId('data-column', [tableId, columnName]);
  }

  stableMetricId(workspaceId: string, name: string): string {
    return hashId('data-metric', [workspaceId, normalizeName(name)]);
  }

  async upsertConnection(input: DataConnectionInput): Promise<DataConnection> {
    const displayName = input.displayName ?? `${input.dialect ?? 'postgres'}:${input.workspaceId}`;
    const id = input.id ?? this.stableConnectionId(input.workspaceId, input.dialect ?? 'postgres', displayName);
    const existing = await this.connections.get(id);
    const timestamp = nowIso();
    const connection: DataConnection = {
      id,
      version: randomUUID(),
      workspaceId: input.workspaceId,
      connectorInstanceId: input.connectorInstanceId ?? existing?.connectorInstanceId ?? DEFAULT_CONNECTOR_INSTANCE_ID,
      dialect: input.dialect ?? existing?.dialect ?? 'postgres',
      readOnly: input.readOnly ?? existing?.readOnly ?? true,
      credentialRef: input.credentialRef ?? existing?.credentialRef ?? DEFAULT_CREDENTIAL_REF,
      rowLimitDefault: input.rowLimitDefault ?? existing?.rowLimitDefault ?? DEFAULT_ROW_LIMIT,
      timeoutMsDefault: input.timeoutMsDefault ?? existing?.timeoutMsDefault ?? DEFAULT_TIMEOUT_MS,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      displayName,
      ...(input.defaultSchema ?? existing?.defaultSchema !== undefined ? { defaultSchema: (input.defaultSchema ?? existing?.defaultSchema)! } : {}),
    };
    if (!connection.readOnly) throw new Error('Structured data connections must be readOnly.');
    if (connection.dialect !== 'postgres') throw new Error(`Structured data MVP supports postgres only, not "${connection.dialect}".`);
    await this.connections.set(id, connection);
    return connection;
  }

  async upsertTable(input: DataTableInput): Promise<DataTable> {
    const id = input.id ?? this.stableTableId(input.connectionId, input.schemaName, input.tableName);
    const existing = await this.tables.get(id);
    const timestamp = nowIso();
    const table: DataTable = {
      id,
      version: randomUUID(),
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      schemaName: input.schemaName,
      tableName: input.tableName,
      displayName: input.displayName ?? existing?.displayName ?? `${input.schemaName}.${input.tableName}`,
      primaryKey: uniq(input.primaryKey ?? existing?.primaryKey ?? []),
      allowed: input.allowed ?? existing?.allowed ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(input.sourceId ?? existing?.sourceId !== undefined ? { sourceId: (input.sourceId ?? existing?.sourceId)! } : {}),
      ...(input.rowLevelConstraintSql ?? existing?.rowLevelConstraintSql !== undefined ? { rowLevelConstraintSql: (input.rowLevelConstraintSql ?? existing?.rowLevelConstraintSql)! } : {}),
      ...(input.description ?? existing?.description !== undefined ? { description: (input.description ?? existing?.description)! } : {}),
    };
    await this.tables.set(id, table);
    for (const column of input.columns ?? []) {
      await this.upsertColumn({
        ...column,
        workspaceId: input.workspaceId,
        tableId: id,
      });
    }
    await this.registerTableSource(table);
    return table;
  }

  async upsertColumn(input: DataColumnInput): Promise<DataColumn> {
    const table = await this.tables.get(input.tableId);
    const workspaceId = input.workspaceId ?? table?.workspaceId;
    if (workspaceId === undefined) throw new Error(`Cannot infer workspaceId for column "${input.name}".`);
    const id = input.id ?? this.stableColumnId(input.tableId, input.name);
    const existing = await this.columns.get(id);
    const timestamp = nowIso();
    const column: DataColumn = {
      id,
      version: randomUUID(),
      workspaceId,
      tableId: input.tableId,
      name: input.name,
      displayName: input.displayName ?? existing?.displayName ?? input.name,
      dataType: input.dataType ?? existing?.dataType ?? 'unknown',
      nullable: input.nullable ?? existing?.nullable ?? true,
      role: input.role ?? existing?.role ?? 'unknown',
      allowed: input.allowed ?? existing?.allowed ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(input.description ?? existing?.description !== undefined ? { description: (input.description ?? existing?.description)! } : {}),
    };
    await this.columns.set(id, column);
    return column;
  }

  async upsertMetric(input: MetricDefinitionInput): Promise<MetricDefinition> {
    const id = input.id ?? this.stableMetricId(input.workspaceId, input.name);
    const existing = await this.metrics.get(id);
    const timestamp = nowIso();
    const metric: MetricDefinition = {
      id,
      version: randomUUID(),
      workspaceId: input.workspaceId,
      name: normalizeName(input.name),
      businessName: input.businessName ?? existing?.businessName ?? input.name,
      baseTableId: input.baseTableId,
      expression: input.expression,
      aggregation: input.aggregation,
      allowedDimensions: uniq(input.allowedDimensions ?? existing?.allowedDimensions ?? []),
      allowedFilters: uniq(input.allowedFilters ?? existing?.allowedFilters ?? []),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(input.description ?? existing?.description !== undefined ? { description: (input.description ?? existing?.description)! } : {}),
      ...(input.ownerPrincipalId ?? existing?.ownerPrincipalId !== undefined ? { ownerPrincipalId: (input.ownerPrincipalId ?? existing?.ownerPrincipalId)! } : {}),
      ...(input.sourceId ?? existing?.sourceId !== undefined ? { sourceId: (input.sourceId ?? existing?.sourceId)! } : {}),
    };
    await this.metrics.set(id, metric);
    return metric;
  }

  getConnection(id: string): Promise<DataConnection | null> { return this.connections.get(id); }
  getTable(id: string): Promise<DataTable | null> { return this.tables.get(id); }
  getColumn(id: string): Promise<DataColumn | null> { return this.columns.get(id); }
  getMetric(id: string): Promise<MetricDefinition | null> { return this.metrics.get(id); }

  async metricByName(workspaceId: string, name: string): Promise<MetricDefinition | null> {
    const metrics = await this.queryMetrics({
      where: {
        op: 'and',
        clauses: [
          { op: 'eq', field: 'workspaceId', value: workspaceId },
          { op: 'eq', field: 'name', value: normalizeName(name) },
        ],
      },
    });
    return metrics[0] ?? null;
  }

  queryConnections(query?: StoreQuery): Promise<DataConnection[]> { return queryAll(this.connections, query); }
  queryTables(query?: StoreQuery): Promise<DataTable[]> { return queryAll(this.tables, query); }
  queryColumns(query?: StoreQuery): Promise<DataColumn[]> { return queryAll(this.columns, query); }
  queryMetrics(query?: StoreQuery): Promise<MetricDefinition[]> { return queryAll(this.metrics, query); }

  private async registerTableSource(table: DataTable): Promise<void> {
    if (this.sourceRegistry === undefined) return;
    const connection = await this.connections.get(table.connectionId);
    const source = await this.sourceRegistry.upsertSource({
      workspaceId: table.workspaceId,
      connectorType: 'structured-data',
      connectorInstanceId: connection?.connectorInstanceId ?? DEFAULT_CONNECTOR_INSTANCE_ID,
      externalId: `table:${table.connectionId}:${table.schemaName}.${table.tableName}`,
      uri: `structured-data://${table.connectionId}/${table.schemaName}.${table.tableName}`,
      title: table.displayName,
      sourceKind: 'table',
      schemaOrDocumentType: 'postgres-table',
      sensitivity: 'internal',
      permissionState: table.allowed ? 'allowed' : 'denied',
      trustLevel: 'medium',
      citationPolicy: 'cite_query',
      healthState: 'healthy',
      lastObservedAt: nowIso(),
      lastSuccessfulReadAt: nowIso(),
      knownLimitations: [
        'Structured data catalog metadata is generated from configured semantic table definitions.',
        'Row-level constraints are enforced by generated SQL and should be backed by database RLS for defense in depth.',
      ],
    });
    await this.tables.set(table.id, { ...table, version: randomUUID(), sourceId: source.id, updatedAt: nowIso() });
  }
}

class StoreBackedSqlPlanner implements SqlPlanner {
  private readonly catalog: DataCatalog;
  private readonly queryRunStore: Store<QueryRun>;
  private readonly sourceRegistry: SourceRegistryLike | undefined;
  private readonly services: MatbotMachine;

  constructor(catalog: DataCatalog, queryRuns: Store<QueryRun>, sourceRegistry: SourceRegistryLike | undefined, services: MatbotMachine) {
    this.catalog = catalog;
    this.queryRunStore = queryRuns;
    this.sourceRegistry = sourceRegistry;
    this.services = services;
  }

  async planQuery(input: QueryPlanInput): Promise<QueryPlan> {
    const metric = input.metricId !== undefined
      ? await this.catalog.getMetric(input.metricId)
      : input.metricName !== undefined
        ? await this.catalog.metricByName(input.workspaceId, input.metricName)
        : null;
    if (metric === null) throw new Error('plan_query requires a known metricId or metricName.');
    if (metric.workspaceId !== input.workspaceId) throw new Error(`Metric "${metric.id}" does not belong to workspace "${input.workspaceId}".`);
    const table = await this.catalog.getTable(metric.baseTableId);
    if (table === null || !table.allowed) throw new Error(`Metric "${metric.name}" references an unavailable or denied table.`);
    const connection = await this.catalog.getConnection(table.connectionId);
    if (connection === null) throw new Error(`Missing data connection "${table.connectionId}".`);
    if (!connection.readOnly) throw new Error(`Data connection "${connection.id}" is not read-only.`);

    const columns = await this.catalog.queryColumns({ where: { op: 'eq', field: 'tableId', value: table.id } });
    const dimensions = this.resolveColumns(input.dimensions ?? [], columns, metric.allowedDimensions, 'dimension');
    const filters = input.filters ?? [];
    for (const filter of filters) this.requireAllowedColumn(filter.columnId, columns, metric.allowedFilters, 'filter');

    const requestedLimit = input.limit ?? connection.rowLimitDefault;
    const cappedLimit = Math.min(Math.max(1, requestedLimit), connection.rowLimitDefault);
    const rowCapWarning = requestedLimit > connection.rowLimitDefault
      ? `Requested limit ${requestedLimit} exceeds row cap ${connection.rowLimitDefault}; using ${cappedLimit}.`
      : undefined;
    const rendered = this.renderSql(metric, table, columns, dimensions, filters, dimensions.length > 0 ? cappedLimit : undefined);
    const validation = this.validateSql(rendered.sql, { requireLimit: dimensions.length > 0 });
    if (!validation.valid) throw new Error(`Generated SQL failed validation: ${validation.reasons.join('; ')}`);
    const costScore = dimensions.length * 2 + filters.length + (cappedLimit > 500 ? 3 : cappedLimit > 100 ? 2 : 0);
    const costEstimate: QueryCostEstimate = {
      complexity: costScore >= 6 ? 'high' : costScore >= 3 ? 'medium' : 'low',
      score: costScore,
      factors: [
        `${dimensions.length} dimension${dimensions.length === 1 ? '' : 's'}`,
        `${filters.length} filter${filters.length === 1 ? '' : 's'}`,
        `row limit ${dimensions.length > 0 ? cappedLimit : 'aggregate-only'}`,
      ],
    };
    const timestamp = nowIso();
    const run: QueryRun = {
      id: randomUUID(),
      version: randomUUID(),
      workspaceId: input.workspaceId,
      dataConnectionId: connection.id,
      principalId: principalId(),
      status: 'planned',
      sql: rendered.sql,
      sqlHash: validation.sqlHash,
      semanticInputs: [metric.id, ...dimensions.map(column => column.id), ...filters.map(filter => filter.columnId)],
      parameters: rendered.parameters,
      sourceIds: uniq([table.sourceId, metric.sourceId].filter((value): value is string => typeof value === 'string')),
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(dimensions.length > 0 ? { rowLimit: cappedLimit } : {}),
    };
    await this.queryRunStore.set(run.id, run);
    return {
      queryRun: run,
      metric,
      table,
      dimensions,
      filters,
      validation,
      costEstimate,
      ...(rowCapWarning !== undefined ? { rowCapWarning } : {}),
    };
  }

  async approveQuery(queryRunId: string): Promise<{ queryRun: QueryRun; approvalToken: string }> {
    const run = await this.queryRunStore.get(queryRunId);
    if (run === null) throw new Error(`Unknown query run "${queryRunId}".`);
    if (run.status !== 'planned' && run.status !== 'approved') throw new Error(`Cannot approve query run in status "${run.status}".`);
    const token = randomUUID();
    const approvedAt = new Date();
    const configuredTtl = Number(process.env['CORTEX_SQL_APPROVAL_TTL_MS'] ?? 300_000);
    const ttlMs = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 300_000;
    const approved: QueryRun = {
      ...run,
      version: randomUUID(),
      status: 'approved',
      approvalTokenHash: hashText(token),
      approvedAt: approvedAt.toISOString(),
      approvalExpiresAt: new Date(approvedAt.getTime() + ttlMs).toISOString(),
      updatedAt: nowIso(),
    };
    await this.queryRunStore.set(run.id, approved);
    return { queryRun: approved, approvalToken: token };
  }

  async executeQuery(queryRunId: string, approvalToken: string, ctx: ToolContext): Promise<ExecuteQueryResult> {
    const run = await this.queryRunStore.get(queryRunId);
    if (run === null) throw new Error(`Unknown query run "${queryRunId}".`);
    if (run.status !== 'approved') throw new Error(`Query run "${queryRunId}" must be approved before execution.`);
    if (run.approvalTokenHash !== hashText(approvalToken)) throw new Error('Invalid approval token for query execution.');
    if (run.principalId !== principalId()) throw new Error('Query approval belongs to a different principal.');
    if (run.approvalExpiresAt !== undefined && Date.parse(run.approvalExpiresAt) <= Date.now()) {
      const {
        approvalTokenHash: _approvalTokenHash,
        approvedAt: _approvedAt,
        approvalExpiresAt: _approvalExpiresAt,
        ...unapproved
      } = run;
      await this.updateRun({
        ...unapproved,
        status: 'planned',
        updatedAt: nowIso(),
      });
      throw new Error('Query approval expired; review and approve the plan again.');
    }
    const connection = await this.catalog.getConnection(run.dataConnectionId);
    if (connection === null) throw new Error(`Missing data connection "${run.dataConnectionId}".`);
    if (!connection.readOnly || connection.dialect !== 'postgres') throw new Error('Structured data execution requires a read-only Postgres connection.');
    const validation = this.validateSql(run.sql, { requireLimit: run.rowLimit !== undefined });
    if (!validation.valid) throw new Error(`SQL validation failed before execution: ${validation.reasons.join('; ')}`);

    await this.updateRun({ ...run, status: 'running', updatedAt: nowIso() });
    const pool = new Pool(await this.poolConfig(connection, ctx));
    let result: QueryResult<Record<string, unknown>>;
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(connection.timeoutMsDefault))}`);
        result = await client.query<Record<string, unknown>>(run.sql, run.parameters);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const failed = {
        ...run,
        version: randomUUID(),
        status: 'failed' as const,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: nowIso(),
      };
      await this.queryRunStore.set(run.id, failed);
      throw error;
    } finally {
      await pool.end().catch(() => undefined);
    }

    const executedAt = nowIso();
    const rows = result.rows.slice(0, run.rowLimit ?? result.rows.length);
    const fields = result.fields.map(field => field.name);
    const resultSource = await this.recordQueryResultSource(run, connection, rows.length, executedAt);
    const succeeded: QueryRun = {
      ...run,
      version: randomUUID(),
      status: 'succeeded',
      rowCount: rows.length,
      executedAt,
      ...(resultSource?.sourceId !== undefined ? { resultSourceId: resultSource.sourceId } : {}),
      updatedAt: executedAt,
    };
    await this.queryRunStore.set(run.id, succeeded);
    return {
      run: succeeded,
      rows,
      fields,
      ...(resultSource !== undefined ? { citation: resultSource } : {}),
    };
  }

  validateSql(sql: string, options: { requireLimit?: boolean } = {}): SqlValidationResult {
    const normalized = stripSql(sql).trim();
    const reasons: string[] = [];
    const readOnly = /^select\b/i.test(normalized);
    if (!readOnly) reasons.push('Only SELECT statements are allowed.');
    if (hasMultipleStatements(normalized)) reasons.push('Multiple SQL statements are not allowed.');
    if (/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|execute|do|vacuum|analyze|set|reset|begin|commit|rollback)\b/i.test(normalized)) {
      reasons.push('SQL contains a disallowed write, DDL, session, or procedural keyword.');
    }
    if (/\bcross\s+join\b/i.test(normalized)) reasons.push('CROSS JOIN is not allowed.');
    const hasExplicitLimit = /\blimit\s+\d+\b/i.test(normalized);
    if (options.requireLimit === true && !hasExplicitLimit) reasons.push('A row-limited query must include an explicit LIMIT.');
    return {
      valid: reasons.length === 0,
      readOnly,
      hasExplicitLimit,
      reasons,
      sqlHash: hashText(normalized),
    };
  }

  queryRuns(query?: StoreQuery): Promise<QueryRun[]> {
    return queryAll(this.queryRunStore, query);
  }

  getQueryRun(id: string): Promise<QueryRun | null> {
    return this.queryRunStore.get(id);
  }

  private async updateRun(run: QueryRun): Promise<void> {
    await this.queryRunStore.set(run.id, { ...run, version: randomUUID() });
  }

  private resolveColumns(requested: readonly string[], columns: readonly DataColumn[], allowed: readonly string[], purpose: string): DataColumn[] {
    return requested.map(id => this.requireAllowedColumn(id, columns, allowed, purpose));
  }

  private requireAllowedColumn(id: string, columns: readonly DataColumn[], allowed: readonly string[], purpose: string): DataColumn {
    const column = columns.find(item => item.id === id || item.name === id || normalizeName(item.displayName) === normalizeName(id));
    if (column === undefined) throw new Error(`Unknown ${purpose} column "${id}".`);
    if (!column.allowed) throw new Error(`Column "${column.name}" is not allowed.`);
    if (!allowed.includes('*') && !allowed.includes(column.id) && !allowed.includes(column.name)) {
      throw new Error(`Column "${column.name}" is not approved as a ${purpose} for this metric.`);
    }
    return column;
  }

  private renderSql(
    metric: MetricDefinition,
    table: DataTable,
    columns: readonly DataColumn[],
    dimensions: readonly DataColumn[],
    filters: readonly SemanticFilter[],
    limit: number | undefined,
  ): { sql: string; parameters: unknown[] } {
    const metricSql = this.renderMetric(metric, columns);
    const tableSql = `${quoteIdent(table.schemaName)}.${quoteIdent(table.tableName)}`;
    const dimensionSelects = dimensions.map(column => `${quoteIdent(column.name)} AS ${quoteIdent(column.name)}`);
    const select = [...dimensionSelects, `${metricSql} AS ${quoteIdent(metric.name)}`].join(', ');
    const parameters: unknown[] = [];
    const clauses: string[] = [];
    if (table.rowLevelConstraintSql !== undefined && table.rowLevelConstraintSql.trim() !== '') {
      const validation = this.validateSql(`SELECT 1 FROM ${tableSql} WHERE ${table.rowLevelConstraintSql} LIMIT 1`, { requireLimit: true });
      if (!validation.valid) throw new Error(`Table row-level constraint failed validation: ${validation.reasons.join('; ')}`);
      clauses.push(`(${table.rowLevelConstraintSql})`);
    }
    for (const filter of filters) {
      const column = this.requireAllowedColumn(filter.columnId, columns, ['*', ...filters.map(item => item.columnId)], 'filter');
      clauses.push(this.renderFilter(column, filter, parameters));
    }
    const whereSql = clauses.length > 0 ? `\nWHERE ${clauses.join(' AND ')}` : '';
    const groupSql = dimensions.length > 0 ? `\nGROUP BY ${dimensions.map(column => quoteIdent(column.name)).join(', ')}` : '';
    const orderSql = dimensions.length > 0 ? `\nORDER BY ${dimensions.map(column => quoteIdent(column.name)).join(', ')}` : '';
    const limitSql = limit !== undefined ? `\nLIMIT ${Math.max(1, Math.trunc(limit))}` : '';
    return {
      sql: `SELECT ${select}\nFROM ${tableSql}${whereSql}${groupSql}${orderSql}${limitSql}`,
      parameters,
    };
  }

  private renderMetric(metric: MetricDefinition, columns: readonly DataColumn[]): string {
    if (metric.aggregation === 'custom' || metric.aggregation === 'ratio') {
      throw new Error(`Metric aggregation "${metric.aggregation}" requires a later semantic expression hardening slice.`);
    }
    if (metric.aggregation === 'count' && metric.expression.trim() === '*') return 'count(*)';
    const column = columns.find(item => item.id === metric.expression || item.name === metric.expression);
    if (column === undefined) throw new Error(`Metric "${metric.name}" references unknown expression column "${metric.expression}".`);
    if (!column.allowed) throw new Error(`Metric "${metric.name}" references denied column "${column.name}".`);
    const col = quoteIdent(column.name);
    switch (metric.aggregation) {
      case 'sum':
      case 'avg':
      case 'min':
      case 'max':
        return `${metric.aggregation}(${col})`;
      case 'count':
        return `count(${col})`;
      case 'count_distinct':
        return `count(distinct ${col})`;
    }
  }

  private renderFilter(column: DataColumn, filter: SemanticFilter, parameters: unknown[]): string {
    const col = quoteIdent(column.name);
    const push = (value: unknown): string => {
      if (!scalarValue(value)) throw new Error(`Filter for "${column.name}" requires a scalar value.`);
      parameters.push(value);
      return `$${parameters.length}`;
    };
    switch (filter.op) {
      case 'eq': return `${col} = ${push(filter.value)}`;
      case 'neq': return `${col} <> ${push(filter.value)}`;
      case 'gt': return `${col} > ${push(filter.value)}`;
      case 'gte': return `${col} >= ${push(filter.value)}`;
      case 'lt': return `${col} < ${push(filter.value)}`;
      case 'lte': return `${col} <= ${push(filter.value)}`;
      case 'string_contains': return `${col} ILIKE ${push(`%${String(filter.value)}%`)}`;
      case 'in': {
        if (!Array.isArray(filter.value) || filter.value.length === 0) throw new Error(`Filter "in" for "${column.name}" requires non-empty values.`);
        const placeholders = filter.value.map(value => push(value));
        return `${col} IN (${placeholders.join(', ')})`;
      }
    }
  }

  private async poolConfig(connection: DataConnection, ctx: ToolContext): Promise<PoolConfig> {
    const resolved = await resolveCredentialRef(connection.credentialRef, ctx, this.services);
    if (resolved.startsWith('postgres://') || resolved.startsWith('postgresql://')) {
      return {
        connectionString: resolved,
        max: 1,
        statement_timeout: connection.timeoutMsDefault,
        query_timeout: connection.timeoutMsDefault,
      };
    }
    const env = process.env[resolved];
    if (env !== undefined && env.trim() !== '') {
      return {
        connectionString: env,
        max: 1,
        statement_timeout: connection.timeoutMsDefault,
        query_timeout: connection.timeoutMsDefault,
      };
    }
    throw new Error(`Unable to resolve Postgres credentialRef "${connection.credentialRef}".`);
  }

  private async recordQueryResultSource(
    run: QueryRun,
    connection: DataConnection,
    rowCount: number,
    executedAt: string,
  ): Promise<{ sourceId: string; text: string } | undefined> {
    if (this.sourceRegistry === undefined) return undefined;
    const source = await this.sourceRegistry.upsertSource({
      workspaceId: run.workspaceId,
      connectorType: 'structured-data',
      connectorInstanceId: connection.connectorInstanceId,
      externalId: `query-run:${run.id}`,
      uri: `structured-data://${connection.id}/query-runs/${run.id}`,
      title: `Structured query result ${run.id}`,
      sourceKind: 'query_result',
      schemaOrDocumentType: 'postgres-query-result',
      sensitivity: 'internal',
      permissionState: 'allowed',
      trustLevel: 'medium',
      citationPolicy: 'cite_query',
      healthState: 'healthy',
      lastObservedAt: executedAt,
      lastSuccessfulReadAt: executedAt,
      knownLimitations: [
        `SQL hash: ${run.sqlHash}`,
        `Data connection: ${connection.id}`,
        `Row count: ${rowCount}`,
        `Source tables/metrics: ${run.sourceIds.join(', ') || 'none recorded'}`,
      ],
    });
    const version = await this.sourceRegistry.upsertVersion({
      sourceId: source.id,
      contentHash: hashText(`${run.sqlHash}:${executedAt}:${rowCount}`),
      observedAt: executedAt,
      provenance: { activityId: `structured-data:${run.id}:execute` },
    });
    const citation = await this.sourceRegistry.resolveCitation(source.id, version.id).catch(() => undefined);
    return { sourceId: source.id, text: citation?.text ?? `${source.id} executed at ${executedAt}` };
  }
}

async function resolveCredentialRef(ref: string, ctx: ToolContext, services: MatbotMachine): Promise<string> {
  if (ref.startsWith('${') && ref.endsWith('}')) {
    const key = ref.slice(2, -1);
    const env = process.env[key];
    if (env !== undefined && env.trim() !== '') return env;
  }
  try {
    return await ctx.vault.resolve(ref);
  } catch {
    try {
      return await services.Vault.resolve(ref);
    } catch {
      return ref;
    }
  }
}

function stripSql(sql: string): string {
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      out += ' ';
      i++;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      out += ch;
      i++;
      continue;
    }
    out += inSingle ? ' ' : ch;
    i++;
  }
  return out;
}

function hasMultipleStatements(sql: string): boolean {
  const trimmed = sql.trim();
  if (!trimmed.includes(';')) return false;
  return trimmed.replace(/;+\s*$/, '').includes(';');
}

interface StructuredDataActionInput {
  action: string;
  connection?: DataConnectionInput;
  table?: DataTableInput;
  column?: DataColumnInput;
  metric?: MetricDefinitionInput;
  plan?: QueryPlanInput;
  queryRunId?: string;
  approvalToken?: string;
  sql?: string;
  query?: StoreQuery;
}

function createStructuredDataTool(catalog: DataCatalog, planner: SqlPlanner): Tool {
  return {
    name: 'structured_data_action',
    description:
      'Inspect structured data catalog records, plan deterministic semantic SQL, validate read-only SQL, approve query runs, and execute approved read-only Postgres queries with row caps.\n\n' +
      'Actions: catalog, register_connection, upsert_table, upsert_column, upsert_metric, plan_query, validate_sql, approve_query, execute_query, runs.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['catalog', 'register_connection', 'upsert_table', 'upsert_column', 'upsert_metric', 'plan_query', 'validate_sql', 'approve_query', 'execute_query', 'runs'] },
        connection: { type: 'object' },
        table: { type: 'object' },
        column: { type: 'object' },
        metric: { type: 'object' },
        plan: { type: 'object' },
        queryRunId: { type: 'string' },
        approvalToken: { type: 'string' },
        sql: { type: 'string' },
        query: { type: 'object' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const parsed = input && typeof input === 'object' ? input as StructuredDataActionInput : { action: '' };
        try {
          switch (parsed.action) {
            case 'catalog':
              yield { type: 'result', value: {
                connections: await catalog.queryConnections(parsed.query),
                tables: await catalog.queryTables(parsed.query),
                columns: await catalog.queryColumns(parsed.query),
                metrics: await catalog.queryMetrics(parsed.query),
              } };
              return;
            case 'register_connection':
              if (parsed.connection === undefined) { yield { type: 'error', message: 'register_connection requires "connection".' }; return; }
              yield { type: 'result', value: await catalog.upsertConnection(parsed.connection) };
              return;
            case 'upsert_table':
              if (parsed.table === undefined) { yield { type: 'error', message: 'upsert_table requires "table".' }; return; }
              yield { type: 'result', value: await catalog.upsertTable(parsed.table) };
              return;
            case 'upsert_column':
              if (parsed.column === undefined) { yield { type: 'error', message: 'upsert_column requires "column".' }; return; }
              yield { type: 'result', value: await catalog.upsertColumn(parsed.column) };
              return;
            case 'upsert_metric':
              if (parsed.metric === undefined) { yield { type: 'error', message: 'upsert_metric requires "metric".' }; return; }
              yield { type: 'result', value: await catalog.upsertMetric(parsed.metric) };
              return;
            case 'plan_query':
              if (parsed.plan === undefined) { yield { type: 'error', message: 'plan_query requires "plan".' }; return; }
              yield { type: 'result', value: await planner.planQuery(parsed.plan) };
              return;
            case 'validate_sql':
              if (parsed.sql === undefined) { yield { type: 'error', message: 'validate_sql requires "sql".' }; return; }
              yield { type: 'result', value: planner.validateSql(parsed.sql, { requireLimit: true }) };
              return;
            case 'approve_query':
              if (parsed.queryRunId === undefined) { yield { type: 'error', message: 'approve_query requires "queryRunId".' }; return; }
              yield { type: 'result', value: await planner.approveQuery(parsed.queryRunId) };
              return;
            case 'execute_query':
              if (parsed.queryRunId === undefined || parsed.approvalToken === undefined) {
                yield { type: 'error', message: 'execute_query requires "queryRunId" and "approvalToken".' };
                return;
              }
              yield { type: 'result', value: await planner.executeQuery(parsed.queryRunId, parsed.approvalToken, ctx) };
              return;
            case 'runs':
              yield { type: 'result', value: { runs: await planner.queryRuns(parsed.query) } };
              return;
            default:
              yield { type: 'error', message: `Unknown structured_data_action "${String(parsed.action)}".` };
          }
        } catch (error) {
          yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
        }
      },
    },
  };
}

export function createDataCatalog(services: MatbotMachine): DataCatalog {
  const sourceRegistry = services.get('SourceRegistry' as never) as SourceRegistryLike | undefined;
  return new StoreBackedDataCatalog(
    services.createStore<DataConnection>(CONNECTION_STORE),
    services.createStore<DataTable>(TABLE_STORE),
    services.createStore<DataColumn>(COLUMN_STORE),
    services.createStore<MetricDefinition>(METRIC_STORE),
    sourceRegistry,
  );
}

export function createSqlPlanner(services: MatbotMachine, catalog: DataCatalog): SqlPlanner {
  const sourceRegistry = services.get('SourceRegistry' as never) as SourceRegistryLike | undefined;
  return new StoreBackedSqlPlanner(
    catalog,
    services.createStore<QueryRun>(QUERY_RUN_STORE),
    sourceRegistry,
    services,
  );
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Registers DataCatalog, SqlPlanner, and structured_data_action for governed semantic SQL planning and read-only Postgres execution.',
  },
  async setup(services: MatbotMachine) {
    const catalog = createDataCatalog(services);
    const planner = createSqlPlanner(services, catalog);
    await services.register('DataCatalog', catalog);
    await services.register('SqlPlanner', planner);
    services.tools.register(createStructuredDataTool(catalog, planner));
  },
};

export default plugin;
