import type {} from '@matatbread/matbot-capabilities-types';
import {uiContribution} from './ui.js';
/**
 * Structured-data plugin: a governed semantic data catalog (connections,
 * tables, columns, metrics), deterministic read-only SQL planning with
 * approval-gated execution against Postgres, exposed via the `DataCatalog`
 * and `SqlPlanner` services and the `structured_data_action` tool.
 *
 * @packageDocumentation
 */

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

/** SQL dialect of a data connection. */
export type DataDialect = 'postgres' | 'sqlserver' | 'snowflake' | 'bigquery' | 'duckdb';
/** Logical type of a catalog column. */
export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'unknown';
/** Aggregation applied by a metric definition. */
export type MetricAggregation = 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max' | 'ratio' | 'custom';
/** Lifecycle status of a planned query run. */
export type QueryRunStatus = 'planned' | 'approved' | 'running' | 'succeeded' | 'failed' | 'cancelled';
/** Comparison operators supported in semantic filters. */
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'string_contains';

/**
 * A registered (read-only) database connection.
 */
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

/**
 * Input for registering a data connection. Omitted fields are preserved from
 * the existing record or defaulted.
 */
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

/**
 * A governed table entry in the catalog: the physical schema/table on a
 * connection, its access flags, and optional row-level constraint SQL.
 */
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

/** Input for upserting a table (optionally with its columns). */
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

/**
 * A governed column of a catalog table: its logical type, analytical role,
 * and whether query planning may reference it.
 */
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

/**
 * Input for upserting a column; omitted fields keep existing values or
 * default, and `workspaceId` is inferred from the parent table when omitted.
 */
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

/**
 * A governed business metric: an aggregation expression over a base table
 * with approved dimension/filter columns.
 */
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

/**
 * Input for creating or updating a metric definition; omitted fields keep
 * existing values on update.
 */
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

/**
 * A single semantic filter clause: one comparison against a column approved
 * for filtering by the metric.
 */
export interface SemanticFilter {
  columnId: string;
  op: FilterOperator;
  value: string | number | boolean | Array<string | number | boolean>;
}

/** Input describing the query to plan against a metric. */
export interface QueryPlanInput {
  workspaceId: string;
  metricId?: string;
  metricName?: string;
  dimensions?: string[];
  filters?: SemanticFilter[];
  limit?: number;
}

/**
 * Outcome of validating rendered SQL for read-only safety.
 */
export interface SqlValidationResult {
  valid: boolean;
  readOnly: boolean;
  hasExplicitLimit: boolean;
  reasons: string[];
  sqlHash: string;
}

/**
 * Heuristic complexity estimate for a planned query.
 */
export interface QueryCostEstimate {
  complexity: 'low' | 'medium' | 'high';
  score: number;
  factors: string[];
}

/**
 * A persisted query run lifecycle record: the planned SQL, its hash and
 * semantic inputs, approval token state, and the execution outcome.
 */
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

/**
 * The full artifact produced by planning: the persisted run, the resolved
 * metric and base table, dimension columns, filters, validation outcome, and
 * a heuristic cost estimate.
 */
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

/**
 * Result of an executed query run.
 */
export interface ExecuteQueryResult {
  run: QueryRun;
  rows: Record<string, unknown>[];
  fields: string[];
  citation?: {
    sourceId: string;
    text: string;
  };
}

/**
 * The semantic catalog service: stable id derivation and CRUD over
 * connections, tables, columns and metric definitions.
 */
export interface DataCatalog {
  /**
   * Derives the deterministic id for a connection.
   * @param workspaceId - Owning workspace.
   * @param dialect - Connection dialect.
   * @param displayName - Display name distinguishing same-dialect connections.
   * @returns Hash-derived stable id.
   */
  stableConnectionId(workspaceId: string, dialect: DataDialect, displayName: string): string;
  /**
   * Derives the deterministic id for a table.
   * @param connectionId - Parent connection id.
   * @param schemaName - Database schema name.
   * @param tableName - Table name within the schema.
   * @returns Hash-derived stable id.
   */
  stableTableId(connectionId: string, schemaName: string, tableName: string): string;
  /**
   * Derives the deterministic id for a column.
   * @param tableId - Parent table id.
   * @param columnName - Physical column name.
   * @returns Hash-derived stable id.
   */
  stableColumnId(tableId: string, columnName: string): string;
  /**
   * Derives the deterministic id for a metric.
   * @param workspaceId - Owning workspace.
   * @param name - Metric name; normalised before hashing.
   * @returns Hash-derived stable id.
   */
  stableMetricId(workspaceId: string, name: string): string;
  /**
   * Creates or updates a connection (must be read-only, postgres only).
   * @param input - Connection fields.
   * @returns The stored connection.
   * @throws When the connection is not read-only or uses an unsupported dialect.
   */
  upsertConnection(input: DataConnectionInput): Promise<DataConnection>;
  /**
   * Creates or updates a table (and any embedded column definitions), then
   * registers it as a source-registry source.
   * @param input - Table fields.
   * @returns The stored table.
   * @throws When the optional source registry rejects the source registration.
   */
  upsertTable(input: DataTableInput): Promise<DataTable>;
  /**
   * Creates or updates a column of a table.
   * @param input - Column fields; workspaceId inferred from the table when omitted.
   * @returns The stored column.
   * @throws When the workspace cannot be inferred from the table.
   */
  upsertColumn(input: DataColumnInput): Promise<DataColumn>;
  /**
   * Creates or updates a metric definition.
   * @param input - Metric fields.
   * @returns The stored metric.
   */
  upsertMetric(input: MetricDefinitionInput): Promise<MetricDefinition>;
  /**
   * Fetches a connection by id.
   * @param id - Connection id.
   * @returns The connection, or null when absent.
   */
  getConnection(id: string): Promise<DataConnection | null>;
  /**
   * Fetches a table by id.
   * @param id - Table id.
   * @returns The table, or null when absent.
   */
  getTable(id: string): Promise<DataTable | null>;
  /**
   * Fetches a column by id.
   * @param id - Column id.
   * @returns The column, or null when absent.
   */
  getColumn(id: string): Promise<DataColumn | null>;
  /**
   * Fetches a metric by id.
   * @param id - Metric id.
   * @returns The metric, or null when absent.
   */
  getMetric(id: string): Promise<MetricDefinition | null>;
  /**
   * Resolves a metric by its normalised name within a workspace.
   * @param workspaceId - Workspace to search.
   * @param name - Metric name; matched after normalisation.
   * @returns The metric, or null when unknown.
   */
  metricByName(workspaceId: string, name: string): Promise<MetricDefinition | null>;
  /**
   * Queries stored connections.
   * @param query - Optional filter/sort/paging; empty means all.
   * @returns Matching connections.
   */
  queryConnections(query?: StoreQuery): Promise<DataConnection[]>;
  /**
   * Queries stored tables.
   * @param query - Optional filter/sort/paging; empty means all.
   * @returns Matching tables.
   */
  queryTables(query?: StoreQuery): Promise<DataTable[]>;
  /**
   * Queries stored columns.
   * @param query - Optional filter/sort/paging; empty means all.
   * @returns Matching columns.
   */
  queryColumns(query?: StoreQuery): Promise<DataColumn[]>;
  /**
   * Queries stored metrics.
   * @param query - Optional filter/sort/paging; empty means all.
   * @returns Matching metrics.
   */
  queryMetrics(query?: StoreQuery): Promise<MetricDefinition[]>;
}

/**
 * The governed SQL planner service: plans deterministic semantic SQL from
 * metrics/dimensions/filters, validates read-only safety, approves runs with
 * expiring tokens, and executes approved queries against Postgres.
 */
export interface SqlPlanner {
  /**
   * Plans a query run from a semantic request.
   * @param input - Metric, dimensions, filters and row limit.
   * @returns The persisted plan (run + validation + cost estimate).
   * @throws When the metric/table/connection is unknown, denied, non-read-only,
   * or the generated SQL fails validation.
   */
  planQuery(input: QueryPlanInput): Promise<QueryPlan>;
  /**
   * Approves a planned run, minting a one-time approval token with a TTL.
   * @param queryRunId - The planned run to approve.
   * @returns The updated run plus the approval token (shown once).
   * @throws When the run is unknown or not in an approvable status.
   */
  approveQuery(queryRunId: string): Promise<{ queryRun: QueryRun; approvalToken: string }>;
  /**
   * Executes an approved run in a read-only transaction.
   * @param queryRunId - Approved run id.
   * @param approvalToken - Token minted at approval time.
   * @param ctx - Tool context used to resolve credentials.
   * @returns Rows, fields and the result citation.
   * @throws When the token is invalid/expired, the principal differs, SQL fails
   * re-validation, credentials cannot be resolved, or the database errors.
   */
  executeQuery(queryRunId: string, approvalToken: string, ctx: ToolContext): Promise<ExecuteQueryResult>;
  /**
   * Validates raw SQL for read-only safety without executing it.
   * @param sql - SQL to check.
   * @param options - `requireLimit` forces an explicit LIMIT clause.
   * @returns Validation outcome including reasons and a normalised SQL hash.
   */
  validateSql(sql: string, options?: { requireLimit?: boolean }): SqlValidationResult;
  /**
   * Queries stored query runs.
   * @param query - Optional filter/sort/paging; empty means all.
   * @returns Matching runs.
   */
  queryRuns(query?: StoreQuery): Promise<QueryRun[]>;
  /**
   * Fetches a query run by id.
   * @param id - Query run id.
   * @returns The run, or null when absent.
   */
  getQueryRun(id: string): Promise<QueryRun | null>;
}

/**
 * Minimal SourceRegistry service subset used for provenance: source/version
 * upserts plus citation resolution. Optional — the catalog and planner work
 * without it, simply not recording sources.
 */
interface SourceRegistryLike {
  /**
   * Creates or updates a source record from a loose field bag.
   * @param input - Source fields as understood by the registry.
   * @returns The stored source id.
   */
  upsertSource(input: Record<string, unknown>): Promise<{ id: string }>;
  /**
   * Creates or updates a version record for a source.
   * @param input - Version fields as understood by the registry.
   * @returns The stored version id.
   */
  upsertVersion(input: Record<string, unknown>): Promise<{ id: string }>;
  /**
   * Resolves display text citing a source (optionally a specific version).
   * @param sourceId - Source to cite.
   * @param versionId - Specific version to cite; registry default when undefined.
   * @returns Citation text.
   */
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

/**
 * Returns the current time as an ISO-8601 UTC string.
 * @returns Current timestamp in ISO format.
 * @throws Never.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Builds a deterministic prefixed id by hashing its parts with SHA-256.
 * @param prefix - Id namespace prefix (e.g. `data-connection`).
 * @param parts - Ordered components joined with a NUL separator before hashing.
 * @returns `<prefix>:<32 hex chars>` derived from the parts.
 * @throws Never.
 */
function hashId(prefix: string, parts: readonly string[]): string {
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `${prefix}:${hash}`;
}

/**
 * Computes the full SHA-256 hex digest of a text.
 * @param text - Text to hash.
 * @returns 64-character lowercase hex digest.
 * @throws Never.
 */
function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Trims, drops empties, and de-duplicates string values.
 * @param values - Values to normalise.
 * @returns New array of unique non-empty trimmed values, in first-occurrence order.
 * @throws Never.
 */
function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

/**
 * Returns the ambient security principal id, falling back to 'system'.
 * @returns Current principal id, or 'system' when no principal is in scope.
 * @throws Never.
 */
function principalId(): string {
  return tryCurrentPrincipal()?.id ?? 'system';
}

/**
 * Quotes a SQL identifier for Postgres.
 * @param value - Identifier to quote; must be a plain `[A-Za-z_][A-Za-z0-9_]*` token.
 * @returns Double-quoted identifier with embedded quotes doubled.
 * @throws Error - When the value is not a plain SQL identifier.
 */
function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier "${value}".`);
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Normalises a name to a lowercase identifier-like token: trims, lowercases,
 * collapses non-alphanumeric runs to underscores, and strips edge underscores.
 * @param value - Name to normalise.
 * @returns Normalised name, or 'unnamed' when nothing remains.
 * @throws Never.
 */
function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

/**
 * Type guard for filter parameter values.
 * @param value - Value to test.
 * @returns True when the value is a string, number, or boolean.
 * @throws Never.
 */
function scalarValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Runs a store query and returns its items.
 * @typeParam T - Stored record shape with `id` and `version`.
 * @param store - Store to query.
 * @param query - Filter/sort/paging query; undefined means all records.
 * @returns Matching records.
 * @throws Never.
 */
async function queryAll<T extends { id: string; version: string }>(store: Store<T>, query?: StoreQuery): Promise<T[]> {
  const result = await store.query(query ?? {});
  return result.items;
}

/**
 * Store-backed {@link DataCatalog}: upserts merge omitted fields from the
 * existing record and write with a fresh version via `set` (last write wins,
 * no compare-and-swap), so concurrent writers can clobber each other.
 * Ids are deterministic, so re-upserting the same identity updates in place.
 */
class StoreBackedDataCatalog implements DataCatalog {
  private readonly connections: Store<DataConnection>;
  private readonly tables: Store<DataTable>;
  private readonly columns: Store<DataColumn>;
  private readonly metrics: Store<MetricDefinition>;
  private readonly sourceRegistry: SourceRegistryLike | undefined;

  /**
   * @param connections - Store for registered connections.
   * @param tables - Store for catalog tables.
   * @param columns - Store for catalog columns.
   * @param metrics - Store for metric definitions.
   * @param sourceRegistry - Optional source registry used to register tables
   *   as sources; when undefined, no provenance is recorded.
   */
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

  /**
   * Derives the deterministic id for a connection.
   * @param workspaceId - Owning workspace.
   * @param dialect - Connection dialect.
   * @param displayName - Display name distinguishing same-dialect connections.
   * @returns Hash-derived stable id.
   */
  stableConnectionId(workspaceId: string, dialect: DataDialect, displayName: string): string {
    return hashId('data-connection', [workspaceId, dialect, displayName]);
  }

  /**
   * Derives the deterministic id for a table.
   * @param connectionId - Parent connection id.
   * @param schemaName - Database schema name.
   * @param tableName - Table name within the schema.
   * @returns Hash-derived stable id.
   */
  stableTableId(connectionId: string, schemaName: string, tableName: string): string {
    return hashId('data-table', [connectionId, schemaName, tableName]);
  }

  /**
   * Derives the deterministic id for a column.
   * @param tableId - Parent table id.
   * @param columnName - Physical column name.
   * @returns Hash-derived stable id.
   */
  stableColumnId(tableId: string, columnName: string): string {
    return hashId('data-column', [tableId, columnName]);
  }

  /**
   * Derives the deterministic id for a metric.
   * @param workspaceId - Owning workspace.
   * @param name - Metric name; normalised before hashing.
   * @returns Hash-derived stable id.
   */
  stableMetricId(workspaceId: string, name: string): string {
    return hashId('data-metric', [workspaceId, normalizeName(name)]);
  }

  /**
   * Creates or updates a connection, preserving omitted fields from the
   * existing record and defaulting display name, dialect, limits, and
   * credential ref.
   * @param input - Connection fields.
   * @returns The stored connection.
   * @throws Error - When the resulting connection is not read-only or its
   *   dialect is not postgres.
   */
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

  /**
   * Creates or updates a table and any embedded column definitions, then
   * registers it with the optional source registry.
   * @param input - Table fields; embedded columns are upserted in order.
   * @returns The stored table as it was before source registration, so a
   *   registry-assigned `sourceId` is not reflected in the returned object.
   * @throws Error - When the source registry rejects the table source registration.
   */
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

  /**
   * Creates or updates a column of a table, preserving omitted fields from
   * the existing record.
   * @param input - Column fields; workspaceId inferred from the table when omitted.
   * @returns The stored column.
   * @throws Error - When the workspace cannot be inferred from the table.
   */
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

  /**
   * Creates or updates a metric definition, normalising `name` and preserving
   * omitted fields from the existing record.
   * @param input - Metric fields.
   * @returns The stored metric.
   * @throws Never.
   */
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

  /**
   * Fetches a connection by id.
   * @param id - Connection id.
   * @returns The connection, or null when absent.
   */
  getConnection(id: string): Promise<DataConnection | null> { return this.connections.get(id); }
  /**
   * Fetches a table by id.
   * @param id - Table id.
   * @returns The table, or null when absent.
   */
  getTable(id: string): Promise<DataTable | null> { return this.tables.get(id); }
  /**
   * Fetches a column by id.
   * @param id - Column id.
   * @returns The column, or null when absent.
   */
  getColumn(id: string): Promise<DataColumn | null> { return this.columns.get(id); }
  /**
   * Fetches a metric by id.
   * @param id - Metric id.
   * @returns The metric, or null when absent.
   */
  getMetric(id: string): Promise<MetricDefinition | null> { return this.metrics.get(id); }

  /**
   * Resolves a metric by its normalised name within a workspace.
   * @param workspaceId - Workspace to search.
   * @param name - Metric name; matched after normalisation.
   * @returns The first matching metric, or null when unknown.
   */
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

  /**
   * Queries stored connections.
   * @param query - Optional filter/sort/paging; empty means all.
   * @returns Matching connections.
   */
  queryConnections(query?: StoreQuery): Promise<DataConnection[]> { return queryAll(this.connections, query); }
  /**
   * Queries stored tables.
   * @param query - Optional filter/sort/paging; empty means all.
   * @returns Matching tables.
   */
  queryTables(query?: StoreQuery): Promise<DataTable[]> { return queryAll(this.tables, query); }
  /**
   * Queries stored columns.
   * @param query - Optional filter/sort/paging; empty means all.
   * @returns Matching columns.
   */
  queryColumns(query?: StoreQuery): Promise<DataColumn[]> { return queryAll(this.columns, query); }
  /**
   * Queries stored metrics.
   * @param query - Optional filter/sort/paging; empty means all.
   * @returns Matching metrics.
   */
  queryMetrics(query?: StoreQuery): Promise<MetricDefinition[]> { return queryAll(this.metrics, query); }

  /**
   * Registers a table as a structured-data source in the optional source
   * registry and stores the assigned `sourceId` back onto the table record.
   * No-op when no registry is wired.
   * @param table - Table to register.
   * @throws Error - When the source registry rejects the source upsert.
   */
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

/**
 * Store-backed {@link SqlPlanner}: renders deterministic parameterised SQL
 * from semantic inputs, validates read-only safety, approves runs with
 * hashed expiring tokens, and executes approved queries in a read-only
 * Postgres transaction. Execution re-checks the ambient principal, so calls
 * must run inside the principal scope that approved the run. Run records are
 * written with fresh versions via `set` (no compare-and-swap).
 */
class StoreBackedSqlPlanner implements SqlPlanner {
  private readonly catalog: DataCatalog;
  private readonly queryRunStore: Store<QueryRun>;
  private readonly sourceRegistry: SourceRegistryLike | undefined;
  private readonly services: MatbotMachine;

  /**
   * @param catalog - Catalog resolving metrics, tables, columns, and connections.
   * @param queryRuns - Store persisting query run lifecycle records.
   * @param sourceRegistry - Optional source registry for result provenance.
   * @param services - Runtime machine used as fallback Vault for credentials.
   */
  constructor(catalog: DataCatalog, queryRuns: Store<QueryRun>, sourceRegistry: SourceRegistryLike | undefined, services: MatbotMachine) {
    this.catalog = catalog;
    this.queryRunStore = queryRuns;
    this.sourceRegistry = sourceRegistry;
    this.services = services;
  }

  /**
   * Plans a query run from a semantic request: resolves the metric by id or
   * normalised name, verifies workspace ownership and table/connection access,
   * resolves approved dimension and filter columns, caps the requested row
   * limit at the connection default, renders parameterised SQL, and validates
   * it before persisting the run in `planned` status.
   * @param input - Metric, dimensions, filters and row limit.
   * @returns The persisted plan (run + validation + cost estimate).
   * @throws Error - When the metric/table/connection is unknown, denied, or
   *   non-read-only; a requested column is unknown or unapproved; or the
   *   generated SQL fails validation.
   */
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

  /**
   * Approves a planned run, minting a one-time approval token that is stored
   * only as a hash, with a TTL read from `CORTEX_SQL_APPROVAL_TTL_MS`
   * (default 5 minutes). The plaintext token is returned once and never
   * persisted.
   * @param queryRunId - The planned run to approve.
   * @returns The updated run plus the approval token (shown once).
   * @throws Error - When the run is unknown or not in an approvable status
   *   (`planned` or `approved`).
   */
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

  /**
   * Executes an approved run in a read-only Postgres transaction: re-validates
   * the token hash, owning principal, expiry, connection read-only posture,
   * and SQL safety, then runs the statement under `BEGIN READ ONLY` with a
   * statement timeout, truncating rows to the planned limit. On failure the
   * run is marked `failed` and the error rethrown; on success a result source
   * and citation are registered when a source registry is wired.
   * @param queryRunId - Approved run id.
   * @param approvalToken - Token minted at approval time.
   * @param ctx - Tool context used to resolve credentials.
   * @returns Rows (truncated to the run's row limit), field names, the
   *   succeeded run, and a citation when provenance was recorded.
   * @throws Error - When the token is invalid/expired, the principal differs,
   *   SQL fails re-validation, credentials cannot be resolved, or the
   *   database errors.
   */
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

  /**
   * Validates raw SQL for read-only safety without executing it: masks string
   * literals and comments, then rejects anything that is not a single SELECT
   * or contains disallowed write, DDL, session, or procedural keywords, or a
   * CROSS JOIN.
   * @param sql - SQL to check.
   * @param options - `requireLimit` forces an explicit LIMIT clause.
   * @returns Validation outcome including reasons and a normalised SQL hash.
   * @throws Never.
   */
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

  /**
   * Queries stored query runs.
   * @param query - Optional filter/sort/paging; empty means all.
   * @returns Matching runs.
   */
  queryRuns(query?: StoreQuery): Promise<QueryRun[]> {
    return queryAll(this.queryRunStore, query);
  }

  /**
   * Fetches a query run by id.
   * @param id - Query run id.
   * @returns The run, or null when absent.
   */
  getQueryRun(id: string): Promise<QueryRun | null> {
    return this.queryRunStore.get(id);
  }

  /**
   * Persists a run with a freshly generated version (no compare-and-swap).
   * @param run - Run record to store; `id` identifies the record.
   * @throws Never.
   */
  private async updateRun(run: QueryRun): Promise<void> {
    await this.queryRunStore.set(run.id, { ...run, version: randomUUID() });
  }

  /**
   * Resolves requested column references to allowed catalog columns.
   * @param requested - Column ids, names, or display names, in request order.
   * @param columns - Catalog columns of the metric's base table.
   * @param allowed - Column ids/names (or '*') approved by the metric.
   * @param purpose - Role being resolved ('dimension' or 'filter'); used in
   *   error messages.
   * @returns Resolved columns in request order.
   * @throws Error - When a column is unknown, denied, or not approved for the purpose.
   */
  private resolveColumns(requested: readonly string[], columns: readonly DataColumn[], allowed: readonly string[], purpose: string): DataColumn[] {
    return requested.map(id => this.requireAllowedColumn(id, columns, allowed, purpose));
  }

  /**
   * Resolves one column by id, name, or normalised display name and enforces
   * both catalog and metric approvals.
   * @param id - Column id, name, or display name to resolve.
   * @param columns - Catalog columns of the base table.
   * @param allowed - Approved column ids/names; '*' approves every
   *   catalog-allowed column.
   * @param purpose - 'dimension' or 'filter'; used in error messages.
   * @returns The matching column.
   * @throws Error - When the column is unknown, denied in the catalog, or not
   *   approved for this purpose on the metric.
   */
  private requireAllowedColumn(id: string, columns: readonly DataColumn[], allowed: readonly string[], purpose: string): DataColumn {
    const column = columns.find(item => item.id === id || item.name === id || normalizeName(item.displayName) === normalizeName(id));
    if (column === undefined) throw new Error(`Unknown ${purpose} column "${id}".`);
    if (!column.allowed) throw new Error(`Column "${column.name}" is not allowed.`);
    if (!allowed.includes('*') && !allowed.includes(column.id) && !allowed.includes(column.name)) {
      throw new Error(`Column "${column.name}" is not approved as a ${purpose} for this metric.`);
    }
    return column;
  }

  /**
   * Renders deterministic parameterised SELECT SQL for a metric over its base
   * table: quoted identifiers, the table's row-level constraint (validated
   * before inclusion), parameterised filter clauses, and GROUP BY/ORDER BY/
   * LIMIT for dimensional queries. Filter values become positional parameters
   * and are never inlined.
   * @param metric - Metric being planned.
   * @param table - Base table to select from.
   * @param columns - Catalog columns of the table.
   * @param dimensions - Approved dimension columns.
   * @param filters - Semantic filters to apply.
   * @param limit - Row limit for dimensional queries; undefined omits LIMIT.
   * @returns Rendered SQL and the ordered positional parameters.
   * @throws Error - When the row-level constraint fails validation, the
   *   metric expression is unsupported, a filter column is unknown or
   *   unapproved, or a filter value is non-scalar.
   */
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

  /**
   * Renders the metric's aggregation expression over its approved base column.
   * @param metric - Metric definition to render.
   * @param columns - Catalog columns of the base table.
   * @returns Aggregation SQL fragment (e.g. `sum("col")`); `count(*)` when the
   *   expression is `*`.
   * @throws Error - When the aggregation is `custom` or `ratio` (not yet
   *   supported), or the expression references an unknown or denied column.
   */
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

  /**
   * Renders one filter clause with positional `$n` placeholders; values are
   * appended in order so placeholders match the parameters array.
   * @param column - Resolved filter column.
   * @param filter - Semantic filter to render.
   * @param parameters - Accumulating array of bound values; appended to in place.
   * @returns SQL fragment comparing the column to bound parameters.
   * @throws Error - When a filter value is non-scalar, or an `in` filter has
   *   an empty or non-array value.
   */
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

  /**
   * Resolves the connection's credentialRef into a single-connection pool
   * config carrying the connection's statement/query timeouts. A `${NAME}`
   * placeholder is resolved from the environment first, then the request
   * vault, then the machine Vault; a bare ref is treated as an environment
   * variable name.
   * @param connection - Connection whose credentials to resolve.
   * @param ctx - Tool context providing the request-scoped vault.
   * @returns Pool config bound to the resolved connection string.
   * @throws Error - When the credential cannot be resolved to a connection string.
   */
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

  /**
   * Registers the executed query result as a source and version in the
   * optional source registry and resolves its citation text.
   * @param run - Executed run (workspace, SQL hash, and semantic source ids).
   * @param connection - Connection the query ran against.
   * @param rowCount - Number of rows returned after truncation.
   * @param executedAt - Execution timestamp (ISO) used for observation metadata.
   * @returns Source id and citation text, or undefined when no registry is
   *   wired.
   * @throws Error - When the registry rejects the source or version upsert;
   *   citation resolution failures are swallowed.
   */
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

/**
 * Resolves a credential reference to a secret value. A `${NAME}` placeholder
 * is resolved from the environment; anything else goes through the
 * request-scoped vault, then the machine Vault, falling back to the raw ref.
 * @param ref - Credential reference (vault key or `${NAME}` placeholder).
 * @param ctx - Tool context providing the request-scoped vault.
 * @param services - Runtime machine providing the fallback Vault.
 * @returns Resolved secret, or the original ref when every source fails.
 * @throws Never.
 */
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

/**
 * Masks SQL string literals and removes line and block comments so the result
 * is safe for keyword scanning. Literal contents are replaced with spaces;
 * double-quoted identifiers are preserved. Input is assumed well-formed
 * (quotes balanced); malformed input may leak literal text into the scan.
 * @param sql - SQL text to strip.
 * @returns Stripped SQL suitable for keyword scanning.
 * @throws Never.
 */
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

/**
 * Detects multiple SQL statements by looking for an interior semicolon;
 * trailing semicolons are allowed.
 * @param sql - Stripped SQL to inspect.
 * @returns True when more than one statement is present.
 * @throws Never.
 */
function hasMultipleStatements(sql: string): boolean {
  const trimmed = sql.trim();
  if (!trimmed.includes(';')) return false;
  return trimmed.replace(/;+\s*$/, '').includes(';');
}

/**
 * Loose input shape accepted by the `structured_data_action` tool: the fields
 * relevant to the chosen `action` are required, the rest are ignored.
 */
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

/**
 * Builds the `structured_data_action` multi-action tool over a catalog and a
 * planner. Every action failure — including errors thrown by the catalog or
 * planner — is yielded as an `error` event rather than propagated.
 * @param catalog - Catalog backing the catalog/register actions.
 * @param planner - Planner backing the plan/validate/approve/execute/runs actions.
 * @returns The tool specification.
 */
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

/**
 * Builds the store-backed {@link DataCatalog}, optionally wired to a
 * `SourceRegistry` for provenance registration.
 * @param services - Runtime machine providing stores.
 * @returns The catalog instance.
 */
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

/**
 * Builds the store-backed {@link SqlPlanner} over a catalog, optionally wired
 * to a `SourceRegistry` for result provenance.
 * @param services - Runtime machine providing stores and vault access.
 * @param catalog - The catalog resolving metrics/tables/columns/connections.
 * @returns The planner instance.
 */
export function createSqlPlanner(services: MatbotMachine, catalog: DataCatalog): SqlPlanner {
  const sourceRegistry = services.get('SourceRegistry' as never) as SourceRegistryLike | undefined;
  return new StoreBackedSqlPlanner(
    catalog,
    services.createStore<QueryRun>(QUERY_RUN_STORE),
    sourceRegistry,
    services,
  );
}

/**
 * Default plugin specification registering DataCatalog, SqlPlanner and the
 * `structured_data_action` tool.
 *
 * @returns The plugin specification.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Registers DataCatalog, SqlPlanner, and structured_data_action for governed semantic SQL planning and read-only Postgres execution.',
  },
  /**
   * Registers the web UI contribution, builds the catalog and planner, and
   * registers the DataCatalog/SqlPlanner services plus the
   * `structured_data_action` tool.
   * @param services - Runtime machine to register services and tools into.
   */
  async setup(services: MatbotMachine) {
    services.contributions?.register('webui','sql',uiContribution);
    const catalog = createDataCatalog(services);
    const planner = createSqlPlanner(services, catalog);
    await services.register('DataCatalog', catalog);
    await services.register('SqlPlanner', planner);
    services.tools.register(createStructuredDataTool(catalog, planner));
  },
};

export default plugin;
