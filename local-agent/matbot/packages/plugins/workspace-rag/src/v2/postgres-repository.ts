import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { Pool as PgPool, PoolClient, PoolConfig } from 'pg';
import { positiveInteger, ragV2AuditRetentionDaysFromEnv, ragV2GcSettingsFromEnv } from './config.js';
import type {
  RagV2CollectionRecord,
  RagV2DocumentRecord,
  RagV2EmbeddingState,
  RagV2Evidence,
  RagV2Job,
  RagV2JobItem,
  RagV2Level,
  RagV2PassageRecord,
  RagV2PublicationState,
  RagV2RankedHit,
  RagV2RoutingSummaryRecord,
  RagV2SectionRecord,
  RagV2VectorizerInfo,
} from './types.js';
import type {
  RagV2DocumentFingerprint,
  RagV2EmbeddingRecord,
  RagV2GcResult,
  RagV2Publication,
  RagV2RegexRunRecord,
  RagV2Repository,
  RagV2RetrievalRunRecord,
  RagV2SearchScope,
  RagV2StoredRetrievalHit,
} from './repository.js';

const DEFAULT_SCHEMA = 'workspace_rag_v2';
const INSERT_BATCH_SIZE = 128;
const TERMINAL_JOB_STATES = [
  'active_lexical',
  'active_hybrid_partial',
  'active_hybrid_complete',
  'cancelled',
  'retryable_failure',
  'permanent_failure',
  'quarantined',
] as const;

/**
 * Builds the zeroed {@link RagV2GcResult} used as the aggregation base for a
 * garbage-collection pass.
 *
 * @param deletionsSkipped - Whether the pass aborted before deleting (safety gate).
 * @returns An all-zero result carrying the given `deletionsSkipped` flag.
 * @throws Never.
 */
function emptyGcResult(deletionsSkipped = false): RagV2GcResult {
  return {
    documentsDeleted: 0,
    passagesDeleted: 0,
    sectionsDeleted: 0,
    embeddingsDeleted: 0,
    collectionsDeleted: 0,
    routingSummariesDeleted: 0,
    blobsDeleted: 0,
    deletionsSkipped,
  };
}

/**
 * Connection settings for the Postgres RAG v2 repository: the application
 * pool config, an optional dedicated migration pool config, and the target
 * schema name.
 */
interface PostgresSettings {
  poolConfig: PoolConfig;
  migrationPoolConfig?: PoolConfig;
  schema: string;
}

/**
 * Raw shape of one search-result row as Postgres returns it, before mapping
 * into {@link RagV2RankedHit}. Byte/line ranges arrive as strings or nulls,
 * and `score` carries the retriever-specific ranking expression value.
 */
interface SearchRow {
  level: RagV2Level;
  id: string;
  document_id: string;
  document_version_id: string;
  section_id: string | null;
  passage_id: string | null;
  path: string;
  title: string;
  heading_path: string[];
  start_byte: string | null;
  end_byte: string | null;
  start_line: string | null;
  end_line: string | null;
  language: string;
  text: string;
  content_sha256: string;
  source_id: string | null;
  source_version_id: string | null;
  object_path: string;
  line_index_path: string;
  embedding_state: string | null;
  score: number;
}

/**
 * Reduces an arbitrary string to a safe PostgreSQL identifier: disallowed
 * characters become underscores, leading/trailing underscores are trimmed, the
 * result is capped at 48 characters, and a leading digit is prefixed with an
 * underscore. Falls back to the default schema when nothing remains.
 *
 * @param value - Raw schema name, typically from the environment.
 * @returns A sanitized identifier safe to pass through {@link quoteIdentifier}.
 * @throws Never.
 */
function sanitizeIdentifier(value: string): string {
  const result = value.replace(/[^a-zA-Z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 48);
  if (!result) return DEFAULT_SCHEMA;
  return /^[0-9]/u.test(result) ? `_${result}` : result;
}

/**
 * Quote a SQL identifier after gating it against the safe-identifier charset. Exported for
 * tests: the DO-block policy statements interpolate identifiers into string literals where
 * bind parameters cannot go, so every such name must pass this gate first.
 *
 * @param value - Identifier to quote; must match `[a-zA-Z_][a-zA-Z0-9_]*`.
 * @returns The identifier wrapped in double quotes.
 * @throws Error - When `value` contains characters outside the safe identifier set.
 */
export function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

/**
 * Quotes a PostgreSQL role name for interpolation into GRANT statements,
 * escaping embedded double quotes.
 *
 * @param value - Role name to quote; must be non-empty.
 * @returns The role name wrapped in double quotes.
 * @throws Error - When the name is empty or contains a NUL character.
 */
function quoteRole(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Unsafe PostgreSQL role name.');
  return `"${value.replace(/"/gu, '""')}"`;
}

/**
 * Builds {@link PostgresSettings} from the `CORTEX_RAG_*`/`POSTGRES_*`
 * environment variables, preferring a connection string over discrete
 * host/port/database settings and sanitizing the configured schema name.
 *
 * @returns Settings with pool sizing and timeouts, an optional separate
 * migration connection string, and the sanitized schema (default
 * `workspace_rag_v2`).
 * @throws Never.
 */
function settingsFromEnv(): PostgresSettings {
  const connectionString = process.env['CORTEX_RAG_POSTGRES_URL']?.trim();
  const poolConfig: PoolConfig = {
    max: positiveInteger(process.env['CORTEX_RAG_V2_POOL_MAX'], 8),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: positiveInteger(
      process.env['CORTEX_RAG_V2_POOL_CONNECTION_TIMEOUT_MS'],
      30_000,
    ),
  };
  if (connectionString) poolConfig.connectionString = connectionString;
  else {
    poolConfig.host = process.env['CORTEX_RAG_POSTGRES_HOST']?.trim()
      || process.env['POSTGRES_HOST']?.trim()
      || 'localhost';
    poolConfig.port = positiveInteger(
      process.env['CORTEX_RAG_POSTGRES_PORT'] ?? process.env['POSTGRES_PORT'],
      5432,
    );
    poolConfig.database = process.env['CORTEX_RAG_POSTGRES_DB']?.trim()
      || process.env['POSTGRES_DB']?.trim()
      || 'mem0';
    poolConfig.user = process.env['CORTEX_RAG_POSTGRES_USER']?.trim()
      || process.env['POSTGRES_USER']?.trim()
      || 'mem0';
    const password = process.env['CORTEX_RAG_POSTGRES_PASSWORD'] ?? process.env['POSTGRES_PASSWORD'];
    if (password) poolConfig.password = password;
  }
  const migrationConnectionString = process.env['CORTEX_RAG_V2_MIGRATION_POSTGRES_URL']?.trim();
  return {
    poolConfig,
    ...(migrationConnectionString
      ? { migrationPoolConfig: { connectionString: migrationConnectionString } }
      : {}),
    schema: sanitizeIdentifier(process.env['CORTEX_RAG_V2_POSTGRES_SCHEMA']?.trim() || DEFAULT_SCHEMA),
  };
}

/**
 * Renders a numeric vector as the PostgreSQL `vector` literal text form.
 *
 * @param vector - Embedding components; non-finite values are replaced with 0.
 * @returns Text like `[1,2,3]` for use with a `::vector` cast.
 * @throws Never.
 */
function toVector(vector: readonly number[]): string {
  return `[${vector.map(value => Number.isFinite(value) ? value : 0).join(',')}]`;
}

/**
 * Current UTC time as an ISO-8601 string: the canonical timestamp format used
 * for record timestamps written by this repository.
 *
 * @returns An ISO-8601 timestamp string.
 * @throws Never.
 */
function now(): string {
  return new Date().toISOString();
}

/**
 * Serializes a value for storage in a JSONB column.
 *
 * @param value - JSON-serializable payload.
 * @returns The JSON text.
 * @throws TypeError - If the value is circular or otherwise not serializable.
 */
function json(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Converts a nullable SQL text column (BIGINT/COUNT results arrive as strings)
 * into a number.
 *
 * @param value - Raw column text, or null.
 * @returns The parsed number, or undefined when the input is null.
 * @throws Never.
 */
function numeric(value: string | null): number | undefined {
  return value === null ? undefined : Number(value);
}

/**
 * Postgres/pgvector-backed {@link RagV2Repository}: durable generations,
 * publications, jobs, records, embeddings, searches, and audit runs.
 */
export class PostgresRagV2Repository implements RagV2Repository {
  readonly backend = 'postgres-pgvector' as const;
  private readonly pool: PgPool;
  private readonly migrationPool: PgPool | undefined;
  private readonly schema: string;
  private readonly schemaSql: string;
  private vectorizer: RagV2VectorizerInfo | undefined;
  private embeddingsTableSql: string | undefined;
  private readonly vectorIndexMode: 'full' | 'half' | 'binary';
  private readonly gcBatchSize: number;

  /**
   * Creates the repository and opens the application pool (plus the migration
   * pool with at most 2 clients when separately configured). Idle-client
   * errors are logged rather than thrown. Call
   * {@link PostgresRagV2Repository.initialize} before any other method.
   *
   * @param settings - Connection settings (defaults from the environment).
   */
  constructor(settings = settingsFromEnv()) {
    this.pool = new Pool(settings.poolConfig);
    this.pool.on('error', error => {
      console.warn(`[workspace-rag-v2] idle postgres client error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.migrationPool = settings.migrationPoolConfig
      ? new Pool({ ...settings.migrationPoolConfig, max: 2 })
      : undefined;
    this.migrationPool?.on('error', error => {
      console.warn(`[workspace-rag-v2] idle postgres migration client error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.schema = settings.schema;
    this.schemaSql = quoteIdentifier(settings.schema);
    const indexMode = process.env['CORTEX_RAG_V2_VECTOR_INDEX_MODE'];
    this.vectorIndexMode = indexMode === 'half' || indexMode === 'binary' ? indexMode : 'full';
    this.gcBatchSize = ragV2GcSettingsFromEnv().batchSize;
  }

  /**
   * Applies schema migrations and validates the stored vectorizer signature.
   * Installs extensions (`vector`, best-effort `pg_trgm`), creates the schema,
   * tables, per-dimension embeddings table, and indexes, enables row-level
   * security, grants the application role, and opportunistically prunes
   * expired audit records. Must complete before any other repository call.
   *
   * @param vectorizer - Active vectorizer descriptor.
   * @returns Resolves once the schema is ready for use.
   * @throws Error - Postgres client errors from DDL or DML; audit-pruning
   * failures are logged and swallowed instead.
   */
  async initialize(vectorizer: RagV2VectorizerInfo): Promise<void> {
    this.vectorizer = vectorizer;
    this.embeddingsTableSql = `${this.schemaSql}.${quoteIdentifier(`unit_embeddings_${vectorizer.dimensions}`)}`;
    await this.pool.query('SELECT 1');
    await this.ddlPool().query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.ddlPool().query('CREATE EXTENSION IF NOT EXISTS pg_trgm').catch(() => undefined);
    await this.ddlPool().query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql}`);
    await this.createTables(vectorizer);
    await this.runMigrations();
    await this.createIndexes(vectorizer);
    await this.enableRowSecurity();
    await this.grantApplicationRole();
    await this.pruneExpiredAuditRecords().catch(error => {
      console.warn(`[workspace-rag-v2] audit retention pruning skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Opportunistic startup pruning of audit payloads past the configured
   * retention window. Retrieval hits, query variants, and evidence cascade
   * from their run row.
   *
   * @returns Resolves immediately when retention is disabled (days <= 0).
   * @throws Error - Postgres client errors from the retention deletes.
   */
  private async pruneExpiredAuditRecords(): Promise<void> {
    const retentionDays = ragV2AuditRetentionDaysFromEnv();
    if (retentionDays <= 0) return;
    const client = await this.pool.connect();
    try {
      await client.query(`
        DELETE FROM ${this.table('retrieval_runs')}
        WHERE started_at < now() - make_interval(days => $1::int)
      `, [retentionDays]);
      await client.query(`
        DELETE FROM ${this.table('regex_runs')}
        WHERE created_at < now() - make_interval(days => $1::int)
      `, [retentionDays]);
    } finally {
      client.release();
    }
  }

  /**
   * Shuts down the application pool and, when present, the migration pool.
   *
   * @returns Resolves once all pooled clients have closed.
   * @throws Error - If a pool fails to terminate cleanly.
   */
  async close(): Promise<void> {
    await this.pool.end();
    await this.migrationPool?.end();
  }

  /**
   * Starts a staging publication for `generationId` (no-op on conflict) and
   * seeds its document membership from `sourceGenerationId`, falling back to
   * the context's active publication when omitted. Idempotent: re-invoking for
   * a generation an interrupted run left behind never resets it.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context being re-indexed.
   * @param generationId - New generation to stage.
   * @param sourceGenerationId - Generation whose membership to adopt; omit to
   * copy from the active publication.
   * @returns Resolves when the staging row and membership are written.
   * @throws Error - Postgres client errors from the transaction.
   */
  async beginGeneration(workspaceId: string, contextId: string, generationId: string, sourceGenerationId?: string): Promise<void> {
    await this.withWorkspace(workspaceId, async client => {
      await client.query(`
        INSERT INTO ${this.table('publications')} (
          generation_id, workspace_id, context_id, embedding_signature, state, active, created_at
        ) VALUES ($1, $2, $3, $4, 'staging', FALSE, $5)
        ON CONFLICT (generation_id) DO NOTHING
      `, [
        generationId, workspaceId, contextId,
        this.vectorizer?.signature ?? 'uninitialized', now(),
      ]);
      await client.query(`
        INSERT INTO ${this.table('publication_documents')} (
          generation_id, workspace_id, context_id, document_id, document_version_id, path
        )
        SELECT $1, workspace_id, context_id, document_id, document_version_id, path
        FROM ${this.table('publication_documents')}
        WHERE workspace_id = $2 AND context_id = $3 AND generation_id = COALESCE($4::text, (
          SELECT generation_id FROM ${this.table('publications')}
          WHERE workspace_id = $2 AND context_id = $3 AND active = TRUE
          LIMIT 1
        ))
        ON CONFLICT (generation_id, document_id) DO NOTHING
      `, [generationId, workspaceId, contextId, sourceGenerationId ?? null]);
    });
  }

  /**
   * Fetches one publication by generation id.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the publication.
   * @param generationId - Generation to look up.
   * @returns The publication record, or undefined when it does not exist.
   * @throws Error - Postgres client errors from the query.
   */
  async generation(
    workspaceId: string,
    contextId: string,
    generationId: string,
  ): Promise<RagV2Publication | undefined> {
    const result = await this.withWorkspace(workspaceId, client => client.query<{
      generation_id: string;
      workspace_id: string;
      context_id: string;
      embedding_signature: string;
      state: RagV2PublicationState;
      active: boolean;
      created_at: string;
      published_at: string | null;
    }>(`
      SELECT generation_id, workspace_id, context_id, embedding_signature,
        state, active, created_at, published_at
      FROM ${this.table('publications')}
      WHERE workspace_id = $1 AND context_id = $2 AND generation_id = $3
      LIMIT 1
    `, [workspaceId, contextId, generationId]));
    const row = result.rows[0];
    return row ? {
      generationId: row.generation_id,
      workspaceId: row.workspace_id,
      contextId: row.context_id,
      embeddingSignature: row.embedding_signature,
      state: row.state,
      active: row.active,
      createdAt: row.created_at,
      ...(row.published_at ? { publishedAt: row.published_at } : {}),
    } : undefined;
  }

  /**
   * Drops staging generations abandoned by earlier interrupted runs, keeping
   * the given one.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context whose staging generations are pruned.
   * @param keepGenerationId - Generation to preserve.
   * @returns How many staging publications were deleted.
   * @throws Error - Postgres client errors from the delete.
   */
  async pruneStagingGenerations(
    workspaceId: string,
    contextId: string,
    keepGenerationId: string,
  ): Promise<number> {
    const result = await this.withWorkspace(workspaceId, client => client.query(`
      DELETE FROM ${this.table('publications')}
      WHERE workspace_id = $1 AND context_id = $2 AND active = FALSE
        AND state = 'staging' AND generation_id <> $3
    `, [workspaceId, contextId, keepGenerationId]));
    return result.rowCount ?? 0;
  }

  /**
   * Deletes document versions that no active or staging publication protects
   * and whose `modified_at` precedes `olderThan`, repeating in batches of the
   * configured GC size until a batch deletes nothing. Section and passage
   * counts are derived from the doomed rows (the rows themselves cascade);
   * collection embeddings, stale routing summaries, derivative jobs, and
   * terminal ingestion jobs/items are then cleaned up. A non-terminal
   * ingestion job for the context unconditionally skips all deletions.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context to garbage-collect.
   * @param olderThan - ISO-8601 timestamp cast to `timestamptz`; documents
   * modified before it are eligible for deletion.
   * @returns Aggregated deletion counts; `deletionsSkipped` reports gating.
   * @throws Error - Postgres client errors from any batch.
   */
  async pruneOrphans(
    workspaceId: string,
    contextId: string,
    olderThan: string,
  ): Promise<RagV2GcResult> {
    const aggregate = emptyGcResult();
    for (;;) {
      const batch = await this.withWorkspace(workspaceId, async client => {
        if (await this.gcBlockedWithClient(client, workspaceId, contextId)) {
          return { skipped: true, documents: 0, sections: 0, passages: 0, embeddings: 0 };
        }
        const doomed = await client.query<{
          document_version_id: string;
          sections: string;
          passages: string;
        }>(`
          WITH live AS (
            SELECT DISTINCT pd.document_version_id
            FROM ${this.table('publication_documents')} pd
            JOIN ${this.table('publications')} p ON p.generation_id = pd.generation_id
            WHERE pd.workspace_id = $1 AND pd.context_id = $2
              AND p.state IN ('active_lexical', 'active_hybrid_partial', 'active_hybrid_complete', 'staging')
          )
          SELECT d.document_version_id,
            (SELECT COUNT(*)::text FROM ${this.table('sections')} s
              WHERE s.document_version_id = d.document_version_id) AS sections,
            (SELECT COUNT(*)::text FROM ${this.table('passages')} passage
              WHERE passage.document_version_id = d.document_version_id) AS passages
          FROM ${this.table('documents')} d
          WHERE d.workspace_id = $1 AND d.context_id = $2
            AND d.modified_at < $3::timestamptz
            AND NOT EXISTS (
              SELECT 1 FROM live WHERE live.document_version_id = d.document_version_id
            )
          ORDER BY d.document_version_id
          LIMIT $4
        `, [workspaceId, contextId, olderThan, this.gcBatchSize]);
        const ids = doomed.rows.map(row => row.document_version_id);
        if (ids.length === 0) {
          return { skipped: false, documents: 0, sections: 0, passages: 0, embeddings: 0 };
        }
        await client.query(`
          DELETE FROM ${this.table('publication_documents')} membership
          USING ${this.table('publications')} publication
          WHERE membership.generation_id = publication.generation_id
            AND membership.workspace_id = $1 AND membership.context_id = $2
            AND publication.state NOT IN (
              'active_lexical', 'active_hybrid_partial', 'active_hybrid_complete', 'staging'
            )
            AND membership.document_version_id = ANY($3::text[])
        `, [workspaceId, contextId, ids]);
        const embeddings = await client.query(`
          DELETE FROM ${this.getEmbeddingsTable()}
          WHERE workspace_id = $1 AND context_id = $2
            AND level <> 'collection' AND document_version_id = ANY($3::text[])
        `, [workspaceId, contextId, ids]);
        const documents = await client.query(`
          DELETE FROM ${this.table('documents')}
          WHERE workspace_id = $1 AND context_id = $2
            AND document_version_id = ANY($3::text[])
        `, [workspaceId, contextId, ids]);
        return {
          skipped: false,
          documents: documents.rowCount ?? 0,
          sections: doomed.rows.reduce((sum, row) => sum + Number(row.sections), 0),
          passages: doomed.rows.reduce((sum, row) => sum + Number(row.passages), 0),
          embeddings: embeddings.rowCount ?? 0,
        };
      });
      if (batch.skipped) {
        aggregate.deletionsSkipped = true;
        return aggregate;
      }
      aggregate.documentsDeleted += batch.documents;
      aggregate.sectionsDeleted += batch.sections;
      aggregate.passagesDeleted += batch.passages;
      aggregate.embeddingsDeleted += batch.embeddings;
      if (batch.documents === 0) break;
    }

    const cleanup = await this.withWorkspace(workspaceId, async client => {
      if (await this.gcBlockedWithClient(client, workspaceId, contextId)) return undefined;
      const collectionEmbeddings = await client.query(`
        DELETE FROM ${this.getEmbeddingsTable()} embedding
        WHERE embedding.workspace_id = $1 AND embedding.context_id = $2
          AND embedding.level = 'collection'
          AND NOT EXISTS (
            SELECT 1 FROM ${this.table('collections')} collection
            WHERE collection.collection_version_id = embedding.unit_id
              AND collection.workspace_id = $1 AND collection.context_id = $2
          )
      `, [workspaceId, contextId]);
      const routingSummaries = await client.query(`
        DELETE FROM ${this.table('routing_summaries')} summary
        WHERE summary.workspace_id = $1 AND summary.context_id = $2
          AND (
            (summary.document_version_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM ${this.table('documents')} document
              WHERE document.document_version_id = summary.document_version_id
                AND document.workspace_id = $1 AND document.context_id = $2
            ))
            OR NOT EXISTS (
              SELECT 1 FROM ${this.table('publications')} publication
              WHERE publication.generation_id = summary.generation_id
                AND publication.workspace_id = $1 AND publication.context_id = $2
                AND publication.state IN (
                  'active_lexical', 'active_hybrid_partial', 'active_hybrid_complete', 'staging'
                )
            )
          )
      `, [workspaceId, contextId]);
      await client.query(`
        DELETE FROM ${this.table('derivative_jobs')} derivative
        WHERE derivative.workspace_id = $1 AND derivative.context_id = $2
          AND derivative.updated_at < $3::timestamptz
          AND (
            (derivative.level = 'collection' AND NOT EXISTS (
              SELECT 1 FROM ${this.table('collections')} collection
              WHERE collection.collection_version_id = derivative.unit_id
            ))
            OR (derivative.level = 'document' AND NOT EXISTS (
              SELECT 1 FROM ${this.table('documents')} document
              WHERE document.document_version_id = derivative.unit_id
            ))
            OR (derivative.level = 'section' AND NOT EXISTS (
              SELECT 1 FROM ${this.table('sections')} section
              WHERE section.section_id = derivative.unit_id
            ))
            OR (derivative.level = 'passage' AND NOT EXISTS (
              SELECT 1 FROM ${this.table('passages')} passage
              WHERE passage.passage_id = derivative.unit_id
            ))
          )
      `, [workspaceId, contextId, olderThan]);
      await client.query(`
        DELETE FROM ${this.table('ingestion_job_items')} item
        WHERE item.workspace_id = $1 AND item.context_id = $2
          AND item.updated_at < $3::timestamptz
          AND EXISTS (
            SELECT 1 FROM ${this.table('ingestion_jobs')} job
            WHERE job.id = item.job_id AND job.state = ANY($4::text[])
          )
      `, [workspaceId, contextId, olderThan, [...TERMINAL_JOB_STATES]]);
      await client.query(`
        DELETE FROM ${this.table('ingestion_jobs')}
        WHERE workspace_id = $1 AND context_id = $2
          AND updated_at < $3::timestamptz AND state = ANY($4::text[])
      `, [workspaceId, contextId, olderThan, [...TERMINAL_JOB_STATES]]);
      return {
        embeddings: collectionEmbeddings.rowCount ?? 0,
        summaries: routingSummaries.rowCount ?? 0,
      };
    });
    if (!cleanup) aggregate.deletionsSkipped = true;
    else {
      aggregate.embeddingsDeleted += cleanup.embeddings;
      aggregate.routingSummariesDeleted += cleanup.summaries;
    }
    return aggregate;
  }

  /**
   * Deletes retired publication shells published before `olderThan` together
   * with their collections' embeddings. Returns 0 while a non-terminal
   * ingestion job is running for the context.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context whose retired generations are pruned.
   * @param olderThan - ISO-8601 timestamp cast to `timestamptz`.
   * @returns The number of retired generations deleted.
   * @throws Error - Postgres client errors from the delete.
   */
  async pruneRetiredGenerations(
    workspaceId: string,
    contextId: string,
    olderThan: string,
  ): Promise<number> {
    return this.withWorkspace(workspaceId, async client => {
      if (await this.gcBlockedWithClient(client, workspaceId, contextId)) return 0;
      const retired = await client.query<{ generation_id: string }>(`
        SELECT generation_id FROM ${this.table('publications')}
        WHERE workspace_id = $1 AND context_id = $2
          AND state = 'retired' AND published_at < $3::timestamptz
      `, [workspaceId, contextId, olderThan]);
      const generationIds = retired.rows.map(row => row.generation_id);
      if (generationIds.length === 0) return 0;
      const collections = await client.query<{ collection_version_id: string }>(`
        SELECT collection_version_id FROM ${this.table('collections')}
        WHERE workspace_id = $1 AND context_id = $2
          AND generation_id = ANY($3::text[])
      `, [workspaceId, contextId, generationIds]);
      await client.query(`
        DELETE FROM ${this.table('publications')}
        WHERE workspace_id = $1 AND context_id = $2
          AND generation_id = ANY($3::text[])
      `, [workspaceId, contextId, generationIds]);
      const collectionIds = collections.rows.map(row => row.collection_version_id);
      if (collectionIds.length > 0) {
        await client.query(`
          DELETE FROM ${this.getEmbeddingsTable()}
          WHERE workspace_id = $1 AND context_id = $2
            AND level = 'collection' AND unit_id = ANY($3::text[])
        `, [workspaceId, contextId, collectionIds]);
      }
      return generationIds.length;
    });
  }

  /**
   * Removes all non-audit persistence for a context: publications,
   * embeddings, documents, routing summaries, derivative jobs, and ingestion
   * jobs/items. Idempotent; audit rows are retained.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context being purged.
   * @returns Resolves when all deletes complete.
   * @throws Error - When ingestion is still running for the context, or on
   * Postgres client errors.
   */
  async purgeContext(workspaceId: string, contextId: string): Promise<void> {
    await this.withWorkspace(workspaceId, async client => {
      if (await this.gcBlockedWithClient(client, workspaceId, contextId)) {
        throw new Error(`Workspace RAG V2 cannot purge ${workspaceId}/${contextId} while ingestion is running.`);
      }
      await client.query(`DELETE FROM ${this.table('publications')} WHERE workspace_id = $1 AND context_id = $2`, [workspaceId, contextId]);
      await client.query(`DELETE FROM ${this.getEmbeddingsTable()} WHERE workspace_id = $1 AND context_id = $2`, [workspaceId, contextId]);
      await client.query(`DELETE FROM ${this.table('documents')} WHERE workspace_id = $1 AND context_id = $2`, [workspaceId, contextId]);
      await client.query(`DELETE FROM ${this.table('routing_summaries')} WHERE workspace_id = $1 AND context_id = $2`, [workspaceId, contextId]);
      await client.query(`DELETE FROM ${this.table('derivative_jobs')} WHERE workspace_id = $1 AND context_id = $2`, [workspaceId, contextId]);
      await client.query(`DELETE FROM ${this.table('ingestion_job_items')} WHERE workspace_id = $1 AND context_id = $2`, [workspaceId, contextId]);
      await client.query(`DELETE FROM ${this.table('ingestion_jobs')} WHERE workspace_id = $1 AND context_id = $2`, [workspaceId, contextId]);
    });
  }

  /**
   * Collects the distinct content hashes of every stored document across all
   * workspaces and contexts. Runs on the DDL pool, bypassing workspace
   * row-level security (the application role would see no rows without an
   * `app.workspace_id` setting).
   *
   * @returns A set of SHA-256 content hashes referenced by any document.
   * @throws Error - Postgres client errors from the query.
   */
  async listReferencedContentHashes(): Promise<Set<string>> {
    const result = await this.ddlPool().query<{ content_sha256: string }>(`
      SELECT DISTINCT content_sha256 FROM ${this.table('documents')}
    `);
    return new Set(result.rows.map(row => row.content_sha256));
  }

  /**
   * Fetches the context's currently active publication, if any.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context whose active publication is read.
   * @returns The active publication, or undefined when none exists.
   * @throws Error - Postgres client errors from the query.
   */
  async activePublication(workspaceId: string, contextId: string): Promise<RagV2Publication | undefined> {
    const result = await this.withWorkspace(workspaceId, client => client.query<{
      generation_id: string;
      workspace_id: string;
      context_id: string;
      embedding_signature: string;
      state: RagV2PublicationState;
      active: boolean;
      created_at: string;
      published_at: string | null;
    }>(`
      SELECT generation_id, workspace_id, context_id, embedding_signature,
        state, active, created_at, published_at
      FROM ${this.table('publications')}
      WHERE workspace_id = $1 AND context_id = $2 AND active = TRUE
      LIMIT 1
    `, [workspaceId, contextId]));
    const row = result.rows[0];
    return row ? {
      generationId: row.generation_id,
      workspaceId: row.workspace_id,
      contextId: row.context_id,
      embeddingSignature: row.embedding_signature,
      state: row.state,
      active: row.active,
      createdAt: row.created_at,
      ...(row.published_at ? { publishedAt: row.published_at } : {}),
    } : undefined;
  }

  /**
   * Promotes a staging generation to an active state: validates completeness,
   * retires the previously active publication, activates this one, and
   * propagates the new state onto every member document's
   * `publication_state`.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the generation.
   * @param generationId - Staging generation to publish.
   * @param state - Target active state (lexical, hybrid partial, or hybrid
   * complete).
   * @returns Resolves when the publication and document states are updated.
   * @throws Error - When generation validation fails, the staging row is
   * missing, or a Postgres client error occurs.
   */
  async publishGeneration(
    workspaceId: string,
    contextId: string,
    generationId: string,
    state: Extract<RagV2PublicationState, 'active_lexical' | 'active_hybrid_partial' | 'active_hybrid_complete'>,
  ): Promise<void> {
    await this.withWorkspace(workspaceId, async client => {
      const validation = await this.validateGenerationWithClient(client, workspaceId, contextId, generationId);
      if (!validation.valid) throw new Error(`Workspace RAG V2 generation validation failed: ${validation.errors.join(' ')}`);
      await client.query(`
        UPDATE ${this.table('publications')}
        SET active = FALSE, state = 'retired'
        WHERE workspace_id = $1 AND context_id = $2 AND active = TRUE
      `, [workspaceId, contextId]);
      const result = await client.query(`
        UPDATE ${this.table('publications')}
        SET active = TRUE, state = $4, published_at = $5
        WHERE generation_id = $3 AND workspace_id = $1 AND context_id = $2
      `, [workspaceId, contextId, generationId, state, now()]);
      if (result.rowCount !== 1) throw new Error(`Workspace RAG V2 staging generation not found: ${generationId}`);
      await client.query(`
        UPDATE ${this.table('documents')} d
        SET publication_state = $4
        FROM ${this.table('publication_documents')} pd
        WHERE pd.generation_id = $3 AND pd.document_version_id = d.document_version_id
          AND pd.workspace_id = $1 AND pd.context_id = $2
          AND d.publication_state IS DISTINCT FROM $4
      `, [workspaceId, contextId, generationId, state]);
    });
  }

  /**
   * Checks a generation's completeness without modifying it.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the generation.
   * @param generationId - Generation to validate.
   * @returns Counts of documents, sections, passages, lexical-ready passages,
   * and passage embeddings, plus `errors` describing each failed invariant
   * (`valid` is true only when `errors` is empty).
   * @throws Error - Postgres client errors from the validation queries.
   */
  async validateGeneration(workspaceId: string, contextId: string, generationId: string) {
    return this.withWorkspace(
      workspaceId,
      client => this.validateGenerationWithClient(client, workspaceId, contextId, generationId),
    );
  }

  /**
   * Persists a new ingestion job (upsert on job id).
   *
   * @param job - Full job record to write.
   * @returns Resolves when the row is written.
   * @throws Error - Postgres client errors from the upsert.
   */
  async createJob(job: RagV2Job): Promise<void> {
    await this.writeJob(job);
  }

  /**
   * Rewrites an existing ingestion job (upsert on job id).
   *
   * @param job - Full job record to write.
   * @returns Resolves when the row is written.
   * @throws Error - Postgres client errors from the upsert.
   */
  async updateJob(job: RagV2Job): Promise<void> {
    await this.writeJob(job);
  }

  /**
   * Reads the most recently created ingestion job for a context.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context whose latest job is read.
   * @returns The latest job payload, or undefined when none exists.
   * @throws Error - Postgres client errors from the query.
   */
  async currentJob(workspaceId: string, contextId: string): Promise<RagV2Job | undefined> {
    const result = await this.withWorkspace(workspaceId, client => client.query<{ payload: RagV2Job }>(`
      SELECT payload FROM ${this.table('ingestion_jobs')}
      WHERE workspace_id = $1 AND context_id = $2
      ORDER BY created_at DESC
      LIMIT 1
    `, [workspaceId, contextId]));
    return result.rows[0]?.payload;
  }

  /**
   * Inserts or updates one per-file job item, keyed by (job id, path).
   *
   * @param item - Job item record; its `workspaceId` selects the connection
   * scope.
   * @returns Resolves when the row is written.
   * @throws Error - Postgres client errors from the upsert.
   */
  async upsertJobItem(item: RagV2JobItem): Promise<void> {
    await this.withWorkspace(item.workspaceId, client => client.query(`
      INSERT INTO ${this.table('ingestion_job_items')} (
        job_id, workspace_id, context_id, path, state, payload, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (job_id, path) DO UPDATE SET
        state = EXCLUDED.state, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
    `, [
      item.jobId, item.workspaceId, item.contextId, item.path,
      item.state, json(item), now(),
    ]).then(() => undefined));
  }

  /**
   * Lists change-detection fingerprints for the documents held by a
   * generation, defaulting to the active publication. The summary signature is
   * the newest document-level summarizer signature for which every section of
   * the document also carries a summary with the same signature.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the generation.
   * @param generationId - Generation to fingerprint; omit for the active one.
   * @returns One fingerprint per member document with `modifiedAt`
   * normalized to ISO-8601 (no guaranteed order).
   * @throws Error - Postgres client errors from the query.
   */
  async listFingerprints(
    workspaceId: string,
    contextId: string,
    generationId?: string,
  ): Promise<RagV2DocumentFingerprint[]> {
    const result = await this.withWorkspace(workspaceId, client => client.query<{
      document_id: string;
      document_version_id: string;
      path: string;
      byte_length: string;
      modified_at: string | Date;
      content_sha256: string;
      embedding_signature: string;
      summary_signature: string | null;
    }>(`
      SELECT d.document_id, d.document_version_id, d.path, d.byte_length,
        d.modified_at, d.content_sha256, p.embedding_signature,
        summary.summarizer_signature AS summary_signature
      FROM ${this.table('publications')} p
      JOIN ${this.table('publication_documents')} pd ON pd.generation_id = p.generation_id
      JOIN ${this.table('documents')} d ON d.document_version_id = pd.document_version_id
      LEFT JOIN LATERAL (
        SELECT rs.summarizer_signature
        FROM ${this.table('routing_summaries')} rs
        WHERE rs.workspace_id = d.workspace_id AND rs.context_id = d.context_id
          AND rs.level = 'document' AND rs.unit_id = d.document_version_id
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.table('sections')} section
            WHERE section.workspace_id = d.workspace_id AND section.context_id = d.context_id
              AND section.document_version_id = d.document_version_id
              AND NOT EXISTS (
                SELECT 1
                FROM ${this.table('routing_summaries')} section_summary
                WHERE section_summary.workspace_id = section.workspace_id
                  AND section_summary.context_id = section.context_id
                  AND section_summary.level = 'section'
                  AND section_summary.unit_id = section.section_id
                  AND section_summary.summarizer_signature = rs.summarizer_signature
              )
          )
        ORDER BY rs.created_at DESC
        LIMIT 1
      ) summary ON TRUE
      WHERE p.workspace_id = $1 AND p.context_id = $2
        AND p.generation_id = COALESCE($3::TEXT, (
          SELECT generation_id FROM ${this.table('publications')}
          WHERE workspace_id = $1 AND context_id = $2 AND active = TRUE
          LIMIT 1
        ))
    `, [workspaceId, contextId, generationId ?? null]));
    return result.rows.map(row => ({
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      path: row.path,
      byteLength: Number(row.byte_length),
      // pg maps TIMESTAMPTZ to Date; the unchanged check compares against an ISO mtime string.
      modifiedAt: new Date(row.modified_at).toISOString(),
      contentSha256: row.content_sha256,
      embeddingSignature: row.embedding_signature,
      ...(row.summary_signature ? { summarySignature: row.summary_signature } : {}),
    }));
  }

  /**
   * Counts the document versions held for a generation, defaulting to the
   * active publication.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the generation.
   * @param generationId - Generation to count; omit for the active one.
   * @returns The number of member documents (0 when the generation is unknown).
   * @throws Error - Postgres client errors from the query.
   */
  async countGenerationDocuments(workspaceId: string, contextId: string, generationId?: string): Promise<number> {
    const result = await this.withWorkspace(workspaceId, client => client.query<{ count: string }>(`
      SELECT COUNT(*)::TEXT AS count
      FROM ${this.table('publication_documents')} pd
      WHERE pd.workspace_id = $1 AND pd.context_id = $2
        AND pd.generation_id = COALESCE($3::TEXT, (
          SELECT generation_id FROM ${this.table('publications')}
          WHERE workspace_id = $1 AND context_id = $2 AND active = TRUE
          LIMIT 1
        ))
    `, [workspaceId, contextId, generationId ?? null]));
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Upserts the document record at the start of ingestion. Generation
   * membership is recorded separately by
   * {@link PostgresRagV2Repository.finishDocument}.
   *
   * @param _generationId - Unused; retained for the repository contract.
   * @param document - Document record to upsert.
   * @returns Resolves when the row is written.
   * @throws Error - Postgres client errors from the upsert.
   */
  async beginDocument(_generationId: string, document: RagV2DocumentRecord): Promise<void> {
    await this.withWorkspace(document.workspaceId, client => this.upsertDocument(client, document));
  }

  /**
   * Batch-inserts sections (batches of 128 rows), updating the mutable tail
   * fields on conflict of `section_id`. All sections in one call must share
   * the same `workspaceId` (the first section's is used).
   *
   * @param sections - Section records to write; an empty array is a no-op.
   * @returns Resolves when every batch is written.
   * @throws Error - Postgres client errors from any batch.
   */
  async appendSections(sections: readonly RagV2SectionRecord[]): Promise<void> {
    for (let start = 0; start < sections.length; start += INSERT_BATCH_SIZE) {
      const batch = sections.slice(start, start + INSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const rows = batch.map(section => {
        const offset = values.length;
        values.push(
          section.sectionId, section.documentId, section.documentVersionId, section.workspaceId, section.contextId,
          section.ordinal, section.structuralType, section.headingPath, section.headingText,
          section.startByte, section.endByte, section.startLine, section.endLine,
          section.language, section.languageConfidence, section.contentSha256, section.tokenCount,
          section.routingSummary, section.embeddingState,
        );
        return `(${Array.from({ length: 19 }, (_, index) => `$${offset + index + 1}`).join(',')})`;
      });
      await this.withWorkspace(batch[0]!.workspaceId, client => client.query(`
        INSERT INTO ${this.table('sections')} (
          section_id, document_id, document_version_id, workspace_id, context_id,
          ordinal, structural_type, heading_path, heading_text,
          start_byte, end_byte, start_line, end_line, language, language_confidence,
          content_sha256, token_count, routing_summary, embedding_state
        ) VALUES ${rows.join(',')}
        ON CONFLICT (section_id) DO UPDATE SET
          end_byte = EXCLUDED.end_byte, end_line = EXCLUDED.end_line,
          language = EXCLUDED.language, language_confidence = EXCLUDED.language_confidence,
          content_sha256 = EXCLUDED.content_sha256, token_count = EXCLUDED.token_count,
          routing_summary = EXCLUDED.routing_summary, embedding_state = EXCLUDED.embedding_state
      `, values).then(() => undefined));
    }
  }

  /**
   * Batch-inserts passages (batches of 128 rows), updating text, lexical
   * derivative, and state columns on conflict of `passage_id`. The language
   * distribution is stored as JSONB and `lexicalText` falls back to `text`.
   * All passages in one call must share the same `workspaceId`.
   *
   * @param passages - Passage records to write; an empty array is a no-op.
   * @returns Resolves when every batch is written.
   * @throws Error - Postgres client errors from any batch.
   */
  async appendPassages(passages: readonly RagV2PassageRecord[]): Promise<void> {
    for (let start = 0; start < passages.length; start += INSERT_BATCH_SIZE) {
      const batch = passages.slice(start, start + INSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const rows = batch.map(passage => {
        const offset = values.length;
        values.push(
          passage.passageId, passage.documentId, passage.documentVersionId, passage.sectionId,
          passage.workspaceId, passage.contextId, passage.ordinal, passage.headingPath,
          passage.structuralType, passage.startByte, passage.endByte, passage.startLine, passage.endLine,
          passage.previousPassageId ?? null, passage.nextPassageId ?? null,
          passage.language, passage.languageConfidence, json(passage.languageDistribution), passage.script,
          passage.contentSha256, passage.tokenCount, passage.text, passage.lexicalText ?? passage.text,
          passage.lexicalState, passage.embeddingState,
        );
        const placeholders = Array.from({ length: 25 }, (_, index) => `$${offset + index + 1}`);
        placeholders[17] = `${placeholders[17]}::jsonb`;
        return `(${placeholders.join(',')})`;
      });
      await this.withWorkspace(batch[0]!.workspaceId, client => client.query(`
        INSERT INTO ${this.table('passages')} (
          passage_id, document_id, document_version_id, section_id, workspace_id, context_id,
          ordinal, heading_path, structural_type, start_byte, end_byte, start_line, end_line,
          previous_passage_id, next_passage_id, language, language_confidence,
          language_distribution, script, content_sha256, token_count, text, lexical_text,
          lexical_state, embedding_state
        ) VALUES ${rows.join(',')}
        ON CONFLICT (passage_id) DO UPDATE SET
          previous_passage_id = EXCLUDED.previous_passage_id,
          next_passage_id = EXCLUDED.next_passage_id,
          text = EXCLUDED.text, lexical_text = EXCLUDED.lexical_text,
          lexical_state = EXCLUDED.lexical_state,
          embedding_state = EXCLUDED.embedding_state
      `, values).then(() => undefined));
    }
  }

  /**
   * Batch-inserts embedding rows (batches of 128 rows) into the
   * dimension-specific embeddings table, upserting on (signature, level, unit)
   * and casting vectors to `::vector`; non-finite components are coerced to 0.
   * Afterwards marks every written unit `embedding_state = 'ready'` in its
   * owning table. Requires a completed
   * {@link PostgresRagV2Repository.initialize}.
   *
   * @param records - Embedding records to write; an empty array skips the
   * writes but the vectorizer check still applies.
   * @param vectorizer - Vectorizer that produced the vectors; its dimension
   * count must match the initialized one.
   * @returns Resolves when all rows and state updates are written.
   * @throws Error - On vectorizer dimension mismatch or Postgres client errors.
   */
  async putEmbeddings(records: readonly RagV2EmbeddingRecord[], vectorizer: RagV2VectorizerInfo): Promise<void> {
    if (records.length === 0) return;
    if (vectorizer.dimensions !== this.vectorizer?.dimensions) {
      throw new Error(`Workspace RAG V2 vector dimension mismatch: ${vectorizer.dimensions}.`);
    }
    const table = this.getEmbeddingsTable();
    for (let start = 0; start < records.length; start += INSERT_BATCH_SIZE) {
      const batch = records.slice(start, start + INSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const rows = batch.map(record => {
        const offset = values.length;
        values.push(
          record.level, record.unitId, record.documentVersionId, record.workspaceId,
          record.contextId, record.signature, toVector(record.vector), now(),
          record.inputSha256,
        );
        const placeholders = Array.from({ length: 9 }, (_, index) => `$${offset + index + 1}`);
        placeholders[6] = `${placeholders[6]}::vector`;
        return `(${placeholders.join(',')})`;
      });
      await this.withWorkspace(batch[0]!.workspaceId, client => client.query(`
        INSERT INTO ${table} (
          level, unit_id, document_version_id, workspace_id, context_id,
          embedding_signature, embedding, created_at, content_sha256
        ) VALUES ${rows.join(',')}
        ON CONFLICT (embedding_signature, level, unit_id) DO UPDATE SET
          embedding = EXCLUDED.embedding, created_at = EXCLUDED.created_at,
          content_sha256 = EXCLUDED.content_sha256
      `, values).then(() => undefined));
    }
    const byLevel = new Map<RagV2Level, string[]>();
    for (const record of records) {
      const values = byLevel.get(record.level) ?? [];
      values.push(record.unitId);
      byLevel.set(record.level, values);
    }
    if (byLevel.get('collection')?.length) {
      await this.withWorkspace(records[0]!.workspaceId, client => client.query(`
        UPDATE ${this.table('collections')} SET embedding_state = 'ready'
        WHERE collection_version_id = ANY($1::text[])
      `, [byLevel.get('collection')]).then(() => undefined));
    }
    if (byLevel.get('document')?.length) {
      await this.withWorkspace(records[0]!.workspaceId, client => client.query(`
        UPDATE ${this.table('documents')} SET embedding_state = 'ready'
        WHERE document_version_id = ANY($1::text[])
      `, [byLevel.get('document')]).then(() => undefined));
    }
    if (byLevel.get('section')?.length) {
      await this.withWorkspace(records[0]!.workspaceId, client => client.query(`
        UPDATE ${this.table('sections')} SET embedding_state = 'ready'
        WHERE section_id = ANY($1::text[])
      `, [byLevel.get('section')]).then(() => undefined));
    }
    if (byLevel.get('passage')?.length) {
      await this.withWorkspace(records[0]!.workspaceId, client => client.query(`
        UPDATE ${this.table('passages')} SET embedding_state = 'ready'
        WHERE passage_id = ANY($1::text[])
      `, [byLevel.get('passage')]).then(() => undefined));
    }
  }

  /**
   * Attempts to satisfy each record by copying an already-stored embedding
   * with the same vectorizer signature, level, and input content hash into the
   * target unit, avoiding re-embedding identical content; reused units are
   * marked `embedding_state = 'ready'`. Returns an empty set when the
   * vectorizer dimensions differ from the initialized ones (nothing reusable).
   *
   * @param records - Candidate records without vectors.
   * @param vectorizer - Active vectorizer descriptor.
   * @returns The unit ids whose embeddings were reused.
   * @throws Error - Postgres client errors from any query.
   */
  async reuseEmbeddings(
    records: readonly Omit<RagV2EmbeddingRecord, 'vector'>[],
    vectorizer: RagV2VectorizerInfo,
  ): Promise<Set<string>> {
    if (vectorizer.dimensions !== this.vectorizer?.dimensions) return new Set();
    const reused = new Set<string>();
    const table = this.getEmbeddingsTable();
    for (const record of records) {
      const result = await this.withWorkspace(record.workspaceId, client => client.query(`
        INSERT INTO ${table} (
          level, unit_id, document_version_id, workspace_id, context_id,
          embedding_signature, embedding, created_at, content_sha256
        )
        SELECT $1,$2,$3,$4,$5,$6,embedding,$7,$8
        FROM ${table}
        WHERE embedding_signature = $6 AND level = $1 AND content_sha256 = $8
        LIMIT 1
        ON CONFLICT (embedding_signature, level, unit_id) DO NOTHING
      `, [
        record.level, record.unitId, record.documentVersionId, record.workspaceId,
        record.contextId, record.signature, now(), record.inputSha256,
      ]));
      if (result.rowCount === 1) reused.add(record.unitId);
    }
    if (reused.size > 0) {
      const byLevel = new Map<RagV2Level, string[]>();
      for (const record of records) {
        if (!reused.has(record.unitId)) continue;
        const ids = byLevel.get(record.level) ?? [];
        ids.push(record.unitId);
        byLevel.set(record.level, ids);
      }
      if (byLevel.get('collection')?.length) {
        await this.withWorkspace(records[0]!.workspaceId, client => client.query(`UPDATE ${this.table('collections')} SET embedding_state = 'ready' WHERE collection_version_id = ANY($1::text[])`, [byLevel.get('collection')]).then(() => undefined));
      }
      if (byLevel.get('document')?.length) {
        await this.withWorkspace(records[0]!.workspaceId, client => client.query(`UPDATE ${this.table('documents')} SET embedding_state = 'ready' WHERE document_version_id = ANY($1::text[])`, [byLevel.get('document')]).then(() => undefined));
      }
      if (byLevel.get('section')?.length) {
        await this.withWorkspace(records[0]!.workspaceId, client => client.query(`UPDATE ${this.table('sections')} SET embedding_state = 'ready' WHERE section_id = ANY($1::text[])`, [byLevel.get('section')]).then(() => undefined));
      }
      if (byLevel.get('passage')?.length) {
        await this.withWorkspace(records[0]!.workspaceId, client => client.query(`UPDATE ${this.table('passages')} SET embedding_state = 'ready' WHERE passage_id = ANY($1::text[])`, [byLevel.get('passage')]).then(() => undefined));
      }
    }
    return reused;
  }

  /**
   * Deletes up to `limit` passage embeddings for a generation, oldest first
   * (by `created_at`, then unit id), and marks the affected passages
   * `embedding_state = 'evicted'`. Only rows matching the vectorizer signature
   * are considered. Returns 0 when the vectorizer dimensions differ from the
   * initialized ones.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the generation.
   * @param generationId - Generation whose passage embeddings may be evicted.
   * @param limit - Maximum number of embeddings to delete.
   * @param vectorizer - Active vectorizer descriptor.
   * @returns The number of embeddings actually deleted.
   * @throws Error - Postgres client errors from the delete.
   */
  async evictPassageEmbeddings(
    workspaceId: string,
    contextId: string,
    generationId: string,
    limit: number,
    vectorizer: RagV2VectorizerInfo,
  ): Promise<number> {
    if (vectorizer.dimensions !== this.vectorizer?.dimensions) return 0;
    return this.withWorkspace(workspaceId, async client => {
      const removed = await client.query<{ unit_id: string }>(`
        WITH candidates AS (
          SELECT embedding.unit_id
          FROM ${this.getEmbeddingsTable()} embedding
          JOIN ${this.table('passages')} passage ON passage.passage_id = embedding.unit_id
          JOIN ${this.table('publication_documents')} publication
            ON publication.document_version_id = passage.document_version_id
          WHERE embedding.workspace_id = $1 AND embedding.context_id = $2
            AND embedding.embedding_signature = $3 AND embedding.level = 'passage'
            AND publication.generation_id = $4
          ORDER BY embedding.created_at, embedding.unit_id
          LIMIT $5
        )
        DELETE FROM ${this.getEmbeddingsTable()} embedding
        USING candidates
        WHERE embedding.embedding_signature = $3
          AND embedding.level = 'passage'
          AND embedding.unit_id = candidates.unit_id
        RETURNING embedding.unit_id
      `, [workspaceId, contextId, vectorizer.signature, generationId, limit]);
      if (removed.rows.length > 0) {
        await client.query(`
          UPDATE ${this.table('passages')} SET embedding_state = 'evicted'
          WHERE passage_id = ANY($1::text[])
        `, [removed.rows.map(row => row.unit_id)]);
      }
      return removed.rows.length;
    });
  }

  /**
   * Upserts the document record and records its membership in the generation
   * (path and version id), marking that document's ingestion complete.
   *
   * @param generationId - Generation the document belongs to.
   * @param document - Document record to upsert.
   * @returns Resolves when both writes complete.
   * @throws Error - Postgres client errors from the transaction.
   */
  async finishDocument(generationId: string, document: RagV2DocumentRecord): Promise<void> {
    await this.withWorkspace(document.workspaceId, async client => {
      await this.upsertDocument(client, document);
      await client.query(`
        INSERT INTO ${this.table('publication_documents')} (
          generation_id, workspace_id, context_id, document_id, document_version_id, path
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (generation_id, document_id) DO UPDATE SET
          document_version_id = EXCLUDED.document_version_id,
          path = EXCLUDED.path
      `, [
        generationId,
        document.workspaceId,
        document.contextId,
        document.documentId,
        document.documentVersionId,
        document.path,
      ]);
    });
  }

  /**
   * Recomputes collection rows for a generation from its member documents:
   * groups by `collection_id`, deletes the generation's existing collection
   * rows, and inserts fresh ones with hashed content/version ids and
   * `embedding_state = 'queued'`. Each routing summary aggregates up to 50
   * member summaries and is truncated to 12,000 characters.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the generation.
   * @param generationId - Generation whose collections are rebuilt.
   * @returns One record per rebuilt collection (no guaranteed order).
   * @throws Error - Postgres client errors from the rebuild.
   */
  async rebuildCollections(
    workspaceId: string,
    contextId: string,
    generationId: string,
  ): Promise<RagV2CollectionRecord[]> {
    return this.withWorkspace(workspaceId, async client => {
      const grouped = await client.query<{
        collection_id: string;
        title: string;
        document_count: string;
        content_fingerprint: string;
        routing_summary: string;
      }>(`
        SELECT d.collection_id,
          COALESCE(MAX(d.collection_title), d.collection_id) AS title,
          COUNT(*)::text AS document_count,
          md5(string_agg(d.content_sha256, '' ORDER BY d.content_sha256)) AS content_fingerprint,
          COALESCE((
            SELECT string_agg(sample.title || ': ' || sample.routing_summary, E'\n' ORDER BY sample.title)
            FROM (
              SELECT member.title, member.routing_summary
              FROM ${this.table('publication_documents')} member_pd
              JOIN ${this.table('documents')} member ON member.document_version_id = member_pd.document_version_id
              WHERE member_pd.generation_id = $3 AND member.collection_id = d.collection_id
              ORDER BY member.title
              LIMIT 50
            ) sample
          ), '') AS routing_summary
        FROM ${this.table('publication_documents')} pd
        JOIN ${this.table('documents')} d ON d.document_version_id = pd.document_version_id
        WHERE pd.generation_id = $3 AND d.workspace_id = $1 AND d.context_id = $2
          AND d.collection_id IS NOT NULL
        GROUP BY d.collection_id
      `, [workspaceId, contextId, generationId]);
      await client.query(`DELETE FROM ${this.table('collections')} WHERE generation_id = $1`, [generationId]);
      const records: RagV2CollectionRecord[] = [];
      for (const row of grouped.rows) {
        const contentSha256 = createHash('sha256').update(row.content_fingerprint).digest('hex');
        const collectionVersionId = createHash('sha256')
          .update(`${generationId}\0${row.collection_id}\0${contentSha256}`)
          .digest('hex');
        const record: RagV2CollectionRecord = {
          collectionId: row.collection_id,
          collectionVersionId,
          generationId,
          workspaceId,
          contextId,
          title: row.title,
          documentCount: Number(row.document_count),
          contentSha256,
          routingSummary: row.routing_summary.slice(0, 12_000),
          embeddingState: 'queued',
          createdAt: now(),
        };
        await client.query(`
          INSERT INTO ${this.table('collections')} (
            collection_version_id, collection_id, generation_id, workspace_id, context_id,
            title, document_count, content_sha256, routing_summary, embedding_state, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [
          record.collectionVersionId, record.collectionId, record.generationId,
          record.workspaceId, record.contextId, record.title, record.documentCount,
          record.contentSha256, record.routingSummary, record.embeddingState, record.createdAt,
        ]);
        records.push(record);
      }
      return records;
    });
  }

  /**
   * Looks up the newest routing summary for a unit by source content hash and
   * summarizer signature, enabling summary reuse across generations.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the unit.
   * @param level - Summary level (collection, document, or section).
   * @param sourceContentSha256 - Content hash the summary was generated from.
   * @param summarizerSignature - Signature of the summarizing model.
   * @returns The newest matching summary, or undefined when none exists.
   * @throws Error - Postgres client errors from the query.
   */
  async findRoutingSummary(
    workspaceId: string,
    contextId: string,
    level: RagV2RoutingSummaryRecord['level'],
    sourceContentSha256: string,
    summarizerSignature: string,
  ): Promise<RagV2RoutingSummaryRecord | undefined> {
    const result = await this.withWorkspace(workspaceId, client => client.query<{
      summary_id: string; workspace_id: string; context_id: string; generation_id: string;
      level: RagV2RoutingSummaryRecord['level']; unit_id: string; document_version_id: string | null;
      source_content_sha256: string; summarizer_signature: string; summary: string; created_at: Date;
    }>(`
      SELECT * FROM ${this.table('routing_summaries')}
      WHERE workspace_id = $1 AND context_id = $2 AND level = $3
        AND source_content_sha256 = $4 AND summarizer_signature = $5
      ORDER BY created_at DESC LIMIT 1
    `, [workspaceId, contextId, level, sourceContentSha256, summarizerSignature]));
    const row = result.rows[0];
    return row ? {
      summaryId: row.summary_id,
      workspaceId: row.workspace_id,
      contextId: row.context_id,
      generationId: row.generation_id,
      level: row.level,
      unitId: row.unit_id,
      ...(row.document_version_id ? { documentVersionId: row.document_version_id } : {}),
      sourceContentSha256: row.source_content_sha256,
      summarizerSignature: row.summarizer_signature,
      summary: row.summary,
      createdAt: row.created_at.toISOString(),
    } : undefined;
  }

  /**
   * Upserts a routing summary row and mirrors the summary text onto the owning
   * unit (collection, document, or section).
   *
   * @param summary - Summary record; its `workspaceId` selects the connection
   * scope.
   * @returns Resolves when the row and the unit update are written.
   * @throws Error - Postgres client errors from the writes.
   */
  async putRoutingSummary(summary: RagV2RoutingSummaryRecord): Promise<void> {
    await this.withWorkspace(summary.workspaceId, async client => {
      await client.query(`
        INSERT INTO ${this.table('routing_summaries')} (
          summary_id, workspace_id, context_id, generation_id, level, unit_id,
          document_version_id, source_content_sha256, summarizer_signature, summary, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (summary_id) DO UPDATE SET summary = EXCLUDED.summary, created_at = EXCLUDED.created_at
      `, [
        summary.summaryId, summary.workspaceId, summary.contextId, summary.generationId,
        summary.level, summary.unitId, summary.documentVersionId ?? null,
        summary.sourceContentSha256, summary.summarizerSignature, summary.summary, summary.createdAt,
      ]);
      if (summary.level === 'collection') {
        await client.query(`UPDATE ${this.table('collections')} SET routing_summary = $1 WHERE collection_version_id = $2`, [summary.summary, summary.unitId]);
      } else if (summary.level === 'document') {
        await client.query(`UPDATE ${this.table('documents')} SET routing_summary = $1 WHERE document_version_id = $2`, [summary.summary, summary.unitId]);
      } else {
        await client.query(`UPDATE ${this.table('sections')} SET routing_summary = $1 WHERE section_id = $2`, [summary.summary, summary.unitId]);
      }
    });
  }

  /**
   * Removes generation membership rows whose path no longer appears among the
   * job's item paths, aligning a staged generation with what the job actually
   * processed.
   *
   * @param jobId - Ingestion job whose item paths define the surviving set.
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the generation.
   * @param generationId - Generation to reconcile.
   * @returns The number of membership rows deleted.
   * @throws Error - Postgres client errors from the delete.
   */
  async reconcileGeneration(
    jobId: string,
    workspaceId: string,
    contextId: string,
    generationId: string,
  ): Promise<number> {
    const result = await this.withWorkspace(workspaceId, client => client.query(`
      DELETE FROM ${this.table('publication_documents')} pd
      WHERE pd.generation_id = $1 AND pd.workspace_id = $2 AND pd.context_id = $3
        AND NOT EXISTS (
          SELECT 1 FROM ${this.table('ingestion_job_items')} item
          WHERE item.job_id = $4 AND item.path = pd.path
        )
    `, [generationId, workspaceId, contextId, jobId]));
    return result.rowCount ?? 0;
  }

  /**
   * Runs a websearch-to-tsquery full-text search over the level's generated
   * tsvector columns, selecting the `english`/`german`/`simple` configuration
   * from `scope.lexicalLanguage`.
   *
   * @param level - Level to search (collection, document, section, passage).
   * @param query - Websearch-syntax query string.
   * @param scope - Search scope providing authorization, filters, and limit.
   * @returns Hits ordered by descending ts_rank_cd score; `retrieverRank` is
   * 1-based in this order and the retriever label is `<level>_lexical`.
   * @throws Error - Postgres client errors from the query.
   */
  async lexicalSearch(level: RagV2Level, query: string, scope: RagV2SearchScope): Promise<RagV2RankedHit[]> {
    const result = await this.withWorkspace(scope.workspaceId, client => client.query<SearchRow>(
      this.searchSql(level, 'lexical', scope.lexicalLanguage),
      this.searchParameters(scope, query),
    ));
    return result.rows.map((row, index) => this.rowToHit(row, `${level}_lexical`, index + 1));
  }

  /**
   * Finds passages whose text contains any of the given reference substrings
   * (case-insensitive LIKE; `%`, `_`, and `\` in references are escaped).
   *
   * @param references - Literal substrings to match; an empty array returns no
   * hits.
   * @param scope - Search scope providing authorization, filters, and limit.
   * @returns Hits ordered by passage ordinal with a constant score of
   * max(1, number of references); the retriever label is `exact_reference`.
   * @throws Error - Postgres client errors from the query.
   */
  async exactSearch(references: readonly string[], scope: RagV2SearchScope): Promise<RagV2RankedHit[]> {
    if (references.length === 0) return [];
    const patterns = references.map(value => `%${value.toLocaleLowerCase().replace(/[%_\\]/gu, '\\$&')}%`);
    const result = await this.withWorkspace(scope.workspaceId, client => client.query<SearchRow>(`
      ${this.commonPassageSelect("GREATEST(1, cardinality($4::text[]))::float8")}
      WHERE pd.generation_id = $3
        AND d.workspace_id = $1 AND d.context_id = $2
        AND lower(p.text) LIKE ANY($4::text[])
        AND ($5::text[] IS NULL OR d.document_id = ANY($5::text[]))
        AND ($6::text[] IS NULL OR p.section_id = ANY($6::text[]))
        AND d.acl_tokens && $7::text[]
        AND ($9::text[] IS NULL OR lower(d.document_type) = ANY($9::text[]))
        AND ($10::text[] IS NULL OR lower(d.jurisdiction) = ANY($10::text[]))
        AND ($11::date IS NULL OR (
          (d.publication_date IS NULL OR d.publication_date <= $11::date)
          AND (d.valid_from IS NULL OR d.valid_from <= $11::date)
          AND (d.valid_to IS NULL OR d.valid_to >= $11::date)
        ))
        AND ($12::text[] IS NULL OR d.collection_id = ANY($12::text[]))
      ORDER BY p.ordinal
      LIMIT $8
    `, [
      scope.workspaceId, scope.contextId, scope.generationId, patterns,
      scope.documentIds ?? null, scope.sectionIds ?? null,
      scope.authorizationTokens ?? [`workspace:${scope.workspaceId}`], scope.limit,
      scope.documentTypes?.map(value => value.toLocaleLowerCase()) ?? null,
      scope.jurisdictions?.map(value => value.toLocaleLowerCase()) ?? null,
      scope.asOfDate ?? null,
      scope.collectionIds ?? null,
    ]));
    return result.rows.map((row, index) => this.rowToHit(row, 'exact_reference', index + 1));
  }

  /**
   * Runs a cosine-distance vector search over the level's embeddings inside a
   * dedicated transaction that applies the row-level-security settings and a
   * relaxed HNSW iterative-scan mode (best-effort). In approximate index
   * modes an oversized recall pool is fetched and re-ranked by exact score
   * before trimming to `scope.limit`.
   *
   * @param level - Level to search (collection, document, section, passage).
   * @param queryVector - Query embedding; must match the vectorizer's
   * dimension count or no hits are returned.
   * @param vectorizer - Active vectorizer descriptor providing the signature.
   * @param scope - Search scope providing authorization, filters, and limit.
   * @returns Hits ordered by descending exact cosine score; `retrieverRank`
   * is 1-based in this order and the retriever label is `<level>_dense`.
   * @throws Error - Postgres client errors from the transaction; the
   * transaction is rolled back before rethrowing.
   */
  async denseSearch(
    level: RagV2Level,
    queryVector: readonly number[],
    vectorizer: RagV2VectorizerInfo,
    scope: RagV2SearchScope,
  ): Promise<RagV2RankedHit[]> {
    if (queryVector.length !== vectorizer.dimensions) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.workspace_id', $1, TRUE)`, [scope.workspaceId]);
      await client.query(`SELECT set_config('app.principal_id', 'retrieval', TRUE)`);
      await client.query(`SELECT set_config('app.group_ids', $1, TRUE)`, [
        JSON.stringify(scope.authorizationTokens ?? []),
      ]);
      await client.query('SET LOCAL hnsw.iterative_scan = relaxed_order').catch(() => undefined);
      const result = await client.query<SearchRow>(
        this.searchSql(level, 'dense'),
        this.searchParameters(scope, toVector(queryVector), vectorizer.signature),
      );
      await client.query('COMMIT');
      return result.rows
        .sort((left, right) => Number(right.score) - Number(left.score))
        .slice(0, scope.limit)
        .map((row, index) => this.rowToHit(row, `${level}_dense`, index + 1));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Loads the passages of one section that belong to a generation, optionally
   * restricted to those whose embeddings are not ready (e.g. for
   * re-embedding).
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the section.
   * @param generationId - Generation limiting membership.
   * @param sectionId - Section whose passages are read.
   * @param onlyMissingEmbeddings - When true, excludes passages with
   * `embedding_state = 'ready'`.
   * @returns Passages ordered by ordinal.
   * @throws Error - Postgres client errors from the query.
   */
  async passagesForSection(
    workspaceId: string,
    contextId: string,
    generationId: string,
    sectionId: string,
    onlyMissingEmbeddings: boolean,
  ): Promise<RagV2PassageRecord[]> {
    const result = await this.withWorkspace(workspaceId, client => client.query<{
      passage_id: string; document_id: string; document_version_id: string; section_id: string;
      workspace_id: string; context_id: string; ordinal: number; heading_path: string[];
      structural_type: string; start_byte: string; end_byte: string; start_line: string; end_line: string;
      previous_passage_id: string | null; next_passage_id: string | null; language: string;
      language_confidence: number; language_distribution: Record<string, number>; script: string;
      content_sha256: string; token_count: number; text: string; lexical_text: string;
      lexical_state: 'pending' | 'ready' | 'failed';
      embedding_state: 'not_planned' | 'queued' | 'ready' | 'failed' | 'evicted';
    }>(`
      SELECT p.*
      FROM ${this.table('passages')} p
      JOIN ${this.table('publication_documents')} pd
        ON pd.document_version_id = p.document_version_id AND pd.generation_id = $3
      WHERE p.workspace_id = $1 AND p.context_id = $2 AND p.section_id = $4
        AND ($5::boolean = FALSE OR p.embedding_state <> 'ready')
      ORDER BY p.ordinal
    `, [workspaceId, contextId, generationId, sectionId, onlyMissingEmbeddings]));
    return result.rows.map(row => ({
      passageId: row.passage_id,
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      sectionId: row.section_id,
      workspaceId: row.workspace_id,
      contextId: row.context_id,
      ordinal: row.ordinal,
      headingPath: row.heading_path,
      structuralType: row.structural_type,
      startByte: Number(row.start_byte),
      endByte: Number(row.end_byte),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      ...(row.previous_passage_id ? { previousPassageId: row.previous_passage_id } : {}),
      ...(row.next_passage_id ? { nextPassageId: row.next_passage_id } : {}),
      language: row.language,
      languageConfidence: row.language_confidence,
      languageDistribution: row.language_distribution,
      script: row.script,
      contentSha256: row.content_sha256,
      tokenCount: row.token_count,
      text: row.text,
      ...(row.lexical_text !== row.text ? { lexicalText: row.lexical_text } : {}),
      lexicalState: row.lexical_state,
      embeddingState: row.embedding_state,
    }));
  }

  /**
   * Reads one document version as a full record, gated by ACL tokens.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the document.
   * @param documentVersionId - Version to read.
   * @param authorizationTokens - Tokens of the caller; at least one must
   * intersect the document's ACL for the row to be visible.
   * @returns The document record, or undefined when absent or not permitted.
   * @throws Error - Postgres client errors from the query.
   */
  async documentVersion(
    workspaceId: string,
    contextId: string,
    documentVersionId: string,
    authorizationTokens: readonly string[],
  ): Promise<RagV2DocumentRecord | undefined> {
    const result = await this.withWorkspace(workspaceId, client => client.query<{ payload: RagV2DocumentRecord }>(`
      SELECT jsonb_build_object(
        'documentId', d.document_id,
        'documentVersionId', d.document_version_id,
        'sourceId', d.source_id,
        'sourceVersionId', d.source_version_id,
        'workspaceId', d.workspace_id,
        'contextId', d.context_id,
        'aclTokens', to_jsonb(d.acl_tokens),
        'path', d.path,
        'title', d.title,
        'collectionId', d.collection_id,
        'collectionTitle', d.collection_title,
        'documentType', d.document_type,
        'jurisdiction', d.jurisdiction,
        'governingLaw', d.governing_law,
        'parties', d.parties,
        'publicationDate', d.publication_date,
        'validFrom', d.valid_from,
        'validTo', d.valid_to,
        'languageDistribution', d.language_distribution,
        'byteLength', d.byte_length,
        'lineCount', d.line_count,
        'contentSha256', d.content_sha256,
        'tableOfContents', d.table_of_contents,
        'routingSummary', d.routing_summary,
        'publicationState', d.publication_state,
        'objectPath', d.object_path,
        'lineIndexPath', d.line_index_path,
        'modifiedAt', d.modified_at,
        'embeddingState', d.embedding_state
      ) AS payload
      FROM ${this.table('documents')} d
      WHERE d.workspace_id = $1 AND d.context_id = $2 AND d.document_version_id = $3
        AND d.acl_tokens && $4::text[]
      LIMIT 1
    `, [workspaceId, contextId, documentVersionId, [...authorizationTokens]]));
    return result.rows[0]?.payload;
  }

  /**
   * Runs a case-insensitive PostgreSQL regex over the text of explicit
   * document versions inside a read-only transaction with a 2-second statement
   * timeout, bounding the cost of adversarial patterns.
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the documents.
   * @param generationId - Generation limiting membership.
   * @param documentVersionIds - Versions to search.
   * @param pattern - PostgreSQL regex (case-insensitive) applied to passage
   * text.
   * @param authorizationTokens - Tokens of the caller, intersected with each
   * document's ACL.
   * @param limit - Maximum number of hits returned.
   * @returns Hits ordered by document version id then passage ordinal, with
   * constant score 1; the retriever label is `narrowed_regex`.
   * @throws Error - Postgres client errors (including statement timeout); the
   * transaction is rolled back before rethrowing.
   */
  async grepDocuments(
    workspaceId: string,
    contextId: string,
    generationId: string,
    documentVersionIds: readonly string[],
    pattern: string,
    authorizationTokens: readonly string[],
    limit: number,
  ): Promise<RagV2RankedHit[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SELECT set_config('app.workspace_id', $1, TRUE)`, [workspaceId]);
      await client.query(`SELECT set_config('app.principal_id', 'regex-retrieval', TRUE)`);
      await client.query(`SELECT set_config('app.group_ids', $1, TRUE)`, [JSON.stringify(authorizationTokens)]);
      await client.query(`SET LOCAL statement_timeout = '2000ms'`);
      const result = await client.query<SearchRow>(`
        ${this.commonPassageSelect('1::float8')}
        WHERE pd.generation_id = $3
          AND d.workspace_id = $1 AND d.context_id = $2
          AND d.document_version_id = ANY($4::text[])
          AND d.acl_tokens && $5::text[]
          AND p.text ~* $6
        ORDER BY d.document_version_id, p.ordinal
        LIMIT $7
      `, [
        workspaceId, contextId, generationId, [...documentVersionIds],
        [...authorizationTokens], pattern, limit,
      ]);
      await client.query('COMMIT');
      return result.rows.map((row, index) => this.rowToHit(row, 'narrowed_regex', index + 1));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Persists the start of a retrieval run (upsert on run id).
   *
   * @param run - Retrieval run record to write.
   * @returns Resolves when the row is written.
   * @throws Error - Postgres client errors from the upsert.
   */
  async createRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void> {
    await this.writeRetrievalRun(run);
  }

  /**
   * Batch-inserts retrieval hits for a run (batches of 128 rows, plain
   * inserts).
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the run.
   * @param hits - Stored hits to write; each carries its run id.
   * @returns Resolves when every batch is written.
   * @throws Error - Postgres client errors from any batch.
   */
  async appendRetrievalHits(
    workspaceId: string,
    contextId: string,
    hits: readonly RagV2StoredRetrievalHit[],
  ): Promise<void> {
    for (let start = 0; start < hits.length; start += INSERT_BATCH_SIZE) {
      const batch = hits.slice(start, start + INSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const rows = batch.map(value => {
        const offset = values.length;
        values.push(
          value.runId, workspaceId, contextId, value.hit.id, value.hit.level, value.hit.retriever,
          value.hit.retrieverRank, value.hit.retrieverScore, value.hit.fusionScore ?? null,
          value.hit.rerankerScore ?? null, value.selectedForContext,
          value.exclusionReason ?? null, json(value.hit),
        );
        const placeholders = Array.from({ length: 13 }, (_, index) => `$${offset + index + 1}`);
        placeholders[12] = `${placeholders[12]}::jsonb`;
        return `(${placeholders.join(',')})`;
      });
      await this.withWorkspace(workspaceId, client => client.query(`
        INSERT INTO ${this.table('retrieval_hits')} (
          run_id, workspace_id, context_id, candidate_id, level, retriever, retriever_rank, retriever_score,
          fusion_score, reranker_score, selected_for_context, exclusion_reason, payload
        ) VALUES ${rows.join(',')}
      `, values).then(() => undefined));
    }
  }

  /**
   * Batch-inserts evidence rows for a run (batches of 128 rows), replacing the
   * payload on conflict of (run id, evidence id).
   *
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the run.
   * @param runId - Retrieval run the evidence belongs to.
   * @param evidence - Evidence records to write.
   * @returns Resolves when every batch is written.
   * @throws Error - Postgres client errors from any batch.
   */
  async appendRetrievalEvidence(
    workspaceId: string,
    contextId: string,
    runId: string,
    evidence: readonly RagV2Evidence[],
  ): Promise<void> {
    for (let start = 0; start < evidence.length; start += INSERT_BATCH_SIZE) {
      const batch = evidence.slice(start, start + INSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const rows = batch.map(value => {
        const offset = values.length;
        values.push(
          runId, workspaceId, contextId, value.evidenceId, value.passageId, value.documentVersionId,
          value.byteRange.from, value.byteRange.to,
          value.lineRange.from, value.lineRange.to,
          value.contentSha256, json(value),
        );
        const placeholders = Array.from({ length: 12 }, (_, index) => `$${offset + index + 1}`);
        placeholders[11] = `${placeholders[11]}::jsonb`;
        return `(${placeholders.join(',')})`;
      });
      await this.withWorkspace(workspaceId, client => client.query(`
        INSERT INTO ${this.table('retrieval_evidence')} (
          run_id, workspace_id, context_id, evidence_id, passage_id, document_version_id,
          start_byte, end_byte, start_line, end_line, content_sha256, payload
        ) VALUES ${rows.join(',')}
        ON CONFLICT (run_id, evidence_id) DO UPDATE SET payload = EXCLUDED.payload
      `, values).then(() => undefined));
    }
  }

  /**
   * Persists the completion of a retrieval run (upsert on run id).
   *
   * @param run - Retrieval run record with final status and timings.
   * @returns Resolves when the row is written.
   * @throws Error - Postgres client errors from the upsert.
   */
  async finishRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void> {
    await this.writeRetrievalRun(run);
  }

  /**
   * Upserts an evaluation run (status `succeeded`) and its metrics. Top-level
   * numeric metrics are stored under category `all`; entries of the
   * `metrics.byCategory` object are stored under their category. Each metric
   * row is upserted individually on (run id, metric, category).
   *
   * @param input - Evaluation run descriptor; only numeric metric values are
   * persisted, all others are ignored.
   * @returns Resolves when the run and all metric rows are written.
   * @throws Error - Postgres client errors from any write.
   */
  async saveEvaluationRun(input: {
    id: string;
    workspaceId: string;
    contextId: string;
    generationId: string;
    embeddingSignature: string;
    rerankerModel?: string;
    configuration: unknown;
    metrics: Record<string, unknown>;
    createdAt: string;
    completedAt: string;
  }): Promise<void> {
    await this.withWorkspace(input.workspaceId, client => client.query(`
      INSERT INTO ${this.table('evaluation_runs')} (
        id, workspace_id, context_id, index_generation_id, embedding_signature, reranker_model,
        configuration, status, created_at, completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'succeeded',$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status, completed_at = EXCLUDED.completed_at
    `, [
      input.id, input.workspaceId, input.contextId, input.generationId, input.embeddingSignature,
      input.rerankerModel ?? null, json(input.configuration), input.createdAt, input.completedAt,
    ]).then(() => undefined));
    const flattened: Array<{ metric: string; category: string; value: number; payload?: unknown }> = [];
    for (const [metric, value] of Object.entries(input.metrics)) {
      if (typeof value === 'number') flattened.push({ metric, category: 'all', value });
    }
    const byCategory = input.metrics['byCategory'];
    if (byCategory && typeof byCategory === 'object') {
      for (const [category, categoryMetrics] of Object.entries(byCategory as Record<string, unknown>)) {
        if (!categoryMetrics || typeof categoryMetrics !== 'object') continue;
        for (const [metric, value] of Object.entries(categoryMetrics as Record<string, unknown>)) {
          if (typeof value === 'number') flattened.push({ metric, category, value });
        }
      }
    }
    for (const value of flattened) {
      await this.withWorkspace(input.workspaceId, client => client.query(`
        INSERT INTO ${this.table('evaluation_metrics')} (
          run_id, workspace_id, context_id, metric, category, value, payload
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT (run_id, metric, category) DO UPDATE SET
          value = EXCLUDED.value, payload = EXCLUDED.payload
      `, [
        input.id, input.workspaceId, input.contextId,
        value.metric, value.category, value.value, json(value.payload ?? {}),
      ]).then(() => undefined));
    }
  }

  /**
   * Inserts one regex/grep retrieval audit record.
   *
   * @param run - Regex run record to write.
   * @returns Resolves when the row is written.
   * @throws Error - Postgres client errors from the insert.
   */
  async saveRegexRun(run: RagV2RegexRunRecord): Promise<void> {
    await this.withWorkspace(run.workspaceId, client => client.query(`
      INSERT INTO ${this.table('regex_runs')} (
        id, workspace_id, context_id, generation_id, pattern_hash,
        target_version_count, match_limit, match_count, result_bytes, duration_ms, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [
      run.id, run.workspaceId, run.contextId, run.generationId, run.patternHash,
      run.targetVersionCount, run.matchLimit, run.matchCount, run.resultBytes,
      run.durationMs, run.createdAt,
    ]).then(() => undefined));
  }

  /**
   * Renders a schema-qualified, quoted table name for the configured schema.
   *
   * @param name - Unqualified table name.
   * @returns The quoted `schema.name` SQL fragment.
   * @throws Error - When `name` is not a safe SQL identifier.
   */
  private table(name: string): string {
    return `${this.schemaSql}.${quoteIdentifier(name)}`;
  }

  /**
   * Returns the cached SQL name of the dimension-specific embeddings table.
   *
   * @returns The quoted `schema.unit_embeddings_<dimensions>` fragment.
   * @throws Error - When called before
   * {@link PostgresRagV2Repository.initialize}.
   */
  private getEmbeddingsTable(): string {
    if (!this.embeddingsTableSql) throw new Error('Workspace RAG V2 repository is not initialized.');
    return this.embeddingsTableSql;
  }

  /**
   * Selects the pool used for DDL and cross-workspace reads: the dedicated
   * migration pool when configured, otherwise the application pool. The
   * migration owner bypasses workspace row-level security.
   *
   * @returns The pool to run DDL and owner-privileged queries on.
   * @throws Never.
   */
  private ddlPool(): PgPool {
    return this.migrationPool ?? this.pool;
  }

  /**
   * Idempotently creates the schema's tables (publications, documents,
   * collections, memberships, sections, passages, jobs, summaries, and audit
   * tables) plus the dimension-specific embeddings table, then backfills the
   * embeddings' `content_sha256` for legacy rows.
   *
   * @param vectorizer - Vectorizer whose dimension count names the embeddings
   * table.
   * @returns Resolves when all DDL completes.
   * @throws Error - Postgres client errors from any DDL statement.
   */
  private async createTables(vectorizer: RagV2VectorizerInfo): Promise<void> {
    await this.ddlPool().query(`
      CREATE TABLE IF NOT EXISTS ${this.table('publications')} (
        generation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        embedding_signature TEXT NOT NULL,
        state TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL,
        published_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS ${this.table('documents')} (
        document_version_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        source_id TEXT,
        source_version_id TEXT,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        acl_tokens TEXT[] NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        collection_id TEXT,
        collection_title TEXT,
        document_type TEXT NOT NULL,
        jurisdiction TEXT,
        governing_law TEXT,
        parties JSONB NOT NULL,
        publication_date DATE,
        valid_from DATE,
        valid_to DATE,
        language_distribution JSONB NOT NULL,
        byte_length BIGINT NOT NULL,
        line_count BIGINT NOT NULL,
        content_sha256 TEXT NOT NULL,
        table_of_contents JSONB NOT NULL,
        routing_summary TEXT NOT NULL,
        publication_state TEXT NOT NULL,
        object_path TEXT NOT NULL,
        line_index_path TEXT NOT NULL,
        modified_at TIMESTAMPTZ NOT NULL,
        embedding_state TEXT NOT NULL,
        search_vector TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') ||
          setweight(to_tsvector('simple'::regconfig, coalesce(routing_summary, '')), 'B')
        ) STORED,
        search_vector_en TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english'::regconfig, coalesce(routing_summary, '')), 'B')
        ) STORED,
        search_vector_de TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('german'::regconfig, coalesce(title, '')), 'A') ||
          setweight(to_tsvector('german'::regconfig, coalesce(routing_summary, '')), 'B')
        ) STORED
      );
      CREATE TABLE IF NOT EXISTS ${this.table('collections')} (
        collection_version_id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL,
        generation_id TEXT NOT NULL REFERENCES ${this.table('publications')}(generation_id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        title TEXT NOT NULL,
        document_count BIGINT NOT NULL,
        content_sha256 TEXT NOT NULL,
        routing_summary TEXT NOT NULL,
        embedding_state TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        search_vector TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') ||
          setweight(to_tsvector('simple'::regconfig, coalesce(routing_summary, '')), 'B')
        ) STORED,
        search_vector_en TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english'::regconfig, coalesce(routing_summary, '')), 'B')
        ) STORED,
        search_vector_de TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('german'::regconfig, coalesce(title, '')), 'A') ||
          setweight(to_tsvector('german'::regconfig, coalesce(routing_summary, '')), 'B')
        ) STORED,
        UNIQUE (generation_id, collection_id)
      );
      CREATE TABLE IF NOT EXISTS ${this.table('publication_documents')} (
        generation_id TEXT NOT NULL REFERENCES ${this.table('publications')}(generation_id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_version_id TEXT NOT NULL REFERENCES ${this.table('documents')}(document_version_id),
        path TEXT NOT NULL,
        PRIMARY KEY (generation_id, document_id)
      );
      CREATE TABLE IF NOT EXISTS ${this.table('sections')} (
        section_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        document_version_id TEXT NOT NULL REFERENCES ${this.table('documents')}(document_version_id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        structural_type TEXT NOT NULL,
        heading_path TEXT[] NOT NULL,
        heading_text TEXT NOT NULL,
        start_byte BIGINT NOT NULL,
        end_byte BIGINT NOT NULL,
        start_line BIGINT NOT NULL,
        end_line BIGINT NOT NULL,
        language TEXT NOT NULL,
        language_confidence DOUBLE PRECISION NOT NULL,
        content_sha256 TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        routing_summary TEXT NOT NULL,
        embedding_state TEXT NOT NULL,
        search_vector TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('simple'::regconfig, coalesce(heading_text, '')), 'A') ||
          setweight(to_tsvector('simple'::regconfig, coalesce(routing_summary, '')), 'B')
        ) STORED,
        search_vector_en TSVECTOR GENERATED ALWAYS AS (
          CASE WHEN language = 'en'
            THEN setweight(to_tsvector('english'::regconfig, coalesce(heading_text, '')), 'A')
              || setweight(to_tsvector('english'::regconfig, coalesce(routing_summary, '')), 'B')
            ELSE ''::tsvector END
        ) STORED,
        search_vector_de TSVECTOR GENERATED ALWAYS AS (
          CASE WHEN language = 'de'
            THEN setweight(to_tsvector('german'::regconfig, coalesce(heading_text, '')), 'A')
              || setweight(to_tsvector('german'::regconfig, coalesce(routing_summary, '')), 'B')
            ELSE ''::tsvector END
        ) STORED
      );
      CREATE TABLE IF NOT EXISTS ${this.table('passages')} (
        passage_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        document_version_id TEXT NOT NULL REFERENCES ${this.table('documents')}(document_version_id) ON DELETE CASCADE,
        section_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        heading_path TEXT[] NOT NULL,
        structural_type TEXT NOT NULL,
        start_byte BIGINT NOT NULL,
        end_byte BIGINT NOT NULL,
        start_line BIGINT NOT NULL,
        end_line BIGINT NOT NULL,
        previous_passage_id TEXT,
        next_passage_id TEXT,
        language TEXT NOT NULL,
        language_confidence DOUBLE PRECISION NOT NULL,
        language_distribution JSONB NOT NULL,
        script TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        text TEXT NOT NULL,
        lexical_text TEXT NOT NULL,
        lexical_state TEXT NOT NULL,
        embedding_state TEXT NOT NULL,
        search_vector TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('simple'::regconfig, coalesce(lexical_text, '')), 'B')
        ) STORED,
        search_vector_en TSVECTOR GENERATED ALWAYS AS (
          CASE WHEN language = 'en'
            THEN setweight(to_tsvector('english'::regconfig, coalesce(lexical_text, '')), 'B')
            ELSE ''::tsvector END
        ) STORED,
        search_vector_de TSVECTOR GENERATED ALWAYS AS (
          CASE WHEN language = 'de'
            THEN setweight(to_tsvector('german'::regconfig, coalesce(lexical_text, '')), 'B')
            ELSE ''::tsvector END
        ) STORED
      );
      CREATE TABLE IF NOT EXISTS ${this.table('ingestion_jobs')} (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        state TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${this.table('ingestion_job_items')} (
        job_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        path TEXT NOT NULL,
        state TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (job_id, path)
      );
      CREATE TABLE IF NOT EXISTS ${this.table('derivative_jobs')} (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        level TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        embedding_signature TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${this.table('routing_summaries')} (
        summary_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        level TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        document_version_id TEXT,
        source_content_sha256 TEXT NOT NULL,
        summarizer_signature TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${this.table('retrieval_runs')} (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        question_hash TEXT NOT NULL,
        plan JSONB NOT NULL,
        embedding_signature TEXT NOT NULL,
        reranker_model TEXT,
        status TEXT NOT NULL,
        timings JSONB,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS ${this.table('retrieval_hits')} (
        id BIGSERIAL PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES ${this.table('retrieval_runs')}(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        level TEXT NOT NULL,
        retriever TEXT NOT NULL,
        retriever_rank INTEGER NOT NULL,
        retriever_score DOUBLE PRECISION NOT NULL,
        fusion_score DOUBLE PRECISION,
        reranker_score DOUBLE PRECISION,
        selected_for_context BOOLEAN NOT NULL,
        exclusion_reason TEXT,
        payload JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${this.table('retrieval_query_variants')} (
        run_id TEXT NOT NULL REFERENCES ${this.table('retrieval_runs')}(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        language TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload JSONB NOT NULL,
        PRIMARY KEY (run_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS ${this.table('retrieval_evidence')} (
        run_id TEXT NOT NULL REFERENCES ${this.table('retrieval_runs')}(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        passage_id TEXT NOT NULL,
        document_version_id TEXT NOT NULL,
        start_byte BIGINT NOT NULL,
        end_byte BIGINT NOT NULL,
        start_line BIGINT NOT NULL,
        end_line BIGINT NOT NULL,
        content_sha256 TEXT NOT NULL,
        payload JSONB NOT NULL,
        PRIMARY KEY (run_id, evidence_id)
      );
      CREATE TABLE IF NOT EXISTS ${this.table('regex_runs')} (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        pattern_hash TEXT NOT NULL,
        target_version_count INTEGER NOT NULL,
        match_limit INTEGER NOT NULL,
        match_count INTEGER NOT NULL,
        result_bytes BIGINT NOT NULL,
        duration_ms DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${this.table('evaluation_queries')} (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        query TEXT NOT NULL,
        category TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${this.table('relevance_judgments')} (
        query_id TEXT NOT NULL REFERENCES ${this.table('evaluation_queries')}(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        passage_id TEXT NOT NULL,
        relevance INTEGER NOT NULL,
        notes TEXT,
        PRIMARY KEY (query_id, passage_id)
      );
      CREATE TABLE IF NOT EXISTS ${this.table('evaluation_runs')} (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        index_generation_id TEXT NOT NULL,
        embedding_signature TEXT NOT NULL,
        reranker_model TEXT,
        configuration JSONB NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS ${this.table('evaluation_metrics')} (
        run_id TEXT NOT NULL REFERENCES ${this.table('evaluation_runs')}(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'all',
        value DOUBLE PRECISION NOT NULL,
        payload JSONB,
        PRIMARY KEY (run_id, metric, category)
      );
    `);
    await this.ddlPool().query(`
      CREATE TABLE IF NOT EXISTS ${this.getEmbeddingsTable()} (
        level TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        document_version_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        embedding_signature TEXT NOT NULL,
        embedding vector(${vectorizer.dimensions}) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        content_sha256 TEXT NOT NULL,
        PRIMARY KEY (embedding_signature, level, unit_id)
      )
    `);
    await this.ddlPool().query(`ALTER TABLE ${this.getEmbeddingsTable()} ADD COLUMN IF NOT EXISTS content_sha256 TEXT`);
    await this.ddlPool().query(`UPDATE ${this.getEmbeddingsTable()} SET content_sha256 = unit_id WHERE content_sha256 IS NULL`);
    await this.ddlPool().query(`ALTER TABLE ${this.getEmbeddingsTable()} ALTER COLUMN content_sha256 SET NOT NULL`);
  }

  /**
   * Idempotently creates join-supporting B-tree indexes, GIN tsvector indexes,
   * best-effort trigram indexes, per-level HNSW vector indexes for the
   * configured index mode, and the unique partial index guaranteeing a single
   * active publication per context. Trigram and HNSW failures are logged and
   * skipped, leaving the exact-search lanes available.
   *
   * @param vectorizer - Vectorizer whose dimension count parameterizes the
   * HNSW and content-reuse indexes.
   * @returns Resolves when all index DDL completes.
   * @throws Error - Postgres client errors from required index statements.
   */
  private async createIndexes(vectorizer: RagV2VectorizerInfo): Promise<void> {
    // Generation validation joins sections/passages by document membership alone; without
    // these, every publication on a large corpus degrades to full-table scans.
    const embeddings = this.getEmbeddingsTable();
    await this.ddlPool().query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier('uq_rag_v2_active_publication')}
        ON ${this.table('publications')} (workspace_id, context_id) WHERE active = TRUE;
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_publication_documents_version')}
        ON ${this.table('publication_documents')} (generation_id, document_version_id);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_sections_document_version')}
        ON ${this.table('sections')} (document_version_id);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_passages_document_version')}
        ON ${this.table('passages')} (document_version_id);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_documents_path')}
        ON ${this.table('documents')} (workspace_id, context_id, path);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_documents_collection')}
        ON ${this.table('documents')} (workspace_id, context_id, collection_id);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_collections_generation')}
        ON ${this.table('collections')} (workspace_id, context_id, generation_id, collection_id);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_collections_lexical')}
        ON ${this.table('collections')} USING GIN (search_vector);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_collections_lexical_en')}
        ON ${this.table('collections')} USING GIN (search_vector_en);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_collections_lexical_de')}
        ON ${this.table('collections')} USING GIN (search_vector_de);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_documents_lexical')}
        ON ${this.table('documents')} USING GIN (search_vector);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_documents_lexical_en')}
        ON ${this.table('documents')} USING GIN (search_vector_en);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_documents_lexical_de')}
        ON ${this.table('documents')} USING GIN (search_vector_de);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_sections_document')}
        ON ${this.table('sections')} (workspace_id, context_id, document_version_id, ordinal);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_sections_lexical')}
        ON ${this.table('sections')} USING GIN (search_vector);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_sections_lexical_en')}
        ON ${this.table('sections')} USING GIN (search_vector_en);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_sections_lexical_de')}
        ON ${this.table('sections')} USING GIN (search_vector_de);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_passages_section')}
        ON ${this.table('passages')} (workspace_id, context_id, section_id, ordinal);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_passages_lexical')}
        ON ${this.table('passages')} USING GIN (search_vector);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_passages_lexical_en')}
        ON ${this.table('passages')} USING GIN (search_vector_en);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_passages_lexical_de')}
        ON ${this.table('passages')} USING GIN (search_vector_de);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_jobs_context')}
        ON ${this.table('ingestion_jobs')} (workspace_id, context_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_retired_publications')}
        ON ${this.table('publications')} (workspace_id, context_id, published_at)
        WHERE state = 'retired';
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_retrieval_runs_context')}
        ON ${this.table('retrieval_runs')} (workspace_id, context_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_routing_summary_reuse')}
        ON ${this.table('routing_summaries')} (workspace_id, context_id, level, summarizer_signature, source_content_sha256);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_routing_summary_unit')}
        ON ${this.table('routing_summaries')} (workspace_id, context_id, level, unit_id, created_at DESC);
    `);
    await this.ddlPool().query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_documents_title_trgm')}
        ON ${this.table('documents')} USING GIN (lower(title) gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_documents_path_trgm')}
        ON ${this.table('documents')} USING GIN (lower(path) gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_passages_text_trgm')}
        ON ${this.table('passages')} USING GIN (lower(lexical_text) gin_trgm_ops);
    `).catch(error => {
      console.warn(
        `[workspace-rag-v2] pg_trgm indexes are unavailable; exact and full-text lanes remain active: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    for (const level of ['collection', 'document', 'section', 'passage'] as const) {
      const indexName = quoteIdentifier(
        `idx_rag_v2_${vectorizer.dimensions}_${level}_${this.vectorIndexMode}_hnsw`,
      );
      const indexedExpression = this.vectorIndexMode === 'half'
        ? `((embedding::halfvec(${vectorizer.dimensions})) halfvec_cosine_ops)`
        : this.vectorIndexMode === 'binary'
          ? `((binary_quantize(embedding)::bit(${vectorizer.dimensions})) bit_hamming_ops)`
          : `(embedding vector_cosine_ops)`;
      await this.ddlPool().query(`
        CREATE INDEX IF NOT EXISTS ${indexName}
        ON ${embeddings} USING hnsw ${indexedExpression}
        WHERE level = '${level}'
      `).catch(error => {
        console.warn(`[workspace-rag-v2] failed to create ${level} HNSW index; exact dense search remains available: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await this.ddlPool().query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_rag_v2_${vectorizer.dimensions}_content_reuse`)}
      ON ${embeddings} (embedding_signature, level, content_sha256)
    `);
  }

  /**
   * Applies the versioned schema migrations 1-7 inside a single transaction
   * serialized by a schema-scoped advisory lock, recording applied versions in
   * `schema_migrations`.
   *
   * @returns Resolves once all pending migrations are applied.
   * @throws Error - Postgres client errors; the transaction is rolled back
   * before rethrowing.
   */
  private async runMigrations(): Promise<void> {
    const client = await this.ddlPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${this.schema}:workspace-rag-v2-migrations`]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table('schema_migrations')} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(`
        INSERT INTO ${this.table('schema_migrations')} (version, name, applied_at)
        VALUES (1, 'baseline_hierarchical_catalog', $1)
        ON CONFLICT (version) DO NOTHING
      `, [now()]);
      const migrationTwo = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM ${this.table('schema_migrations')} WHERE version = 2
        ) AS exists
      `);
      if (!migrationTwo.rows[0]?.exists) {
        const lexicalColumn = await client.query<{ exists: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'passages' AND column_name = 'lexical_text'
          ) AS exists
        `, [this.schema]);
        if (!lexicalColumn.rows[0]?.exists) {
          await client.query(`ALTER TABLE ${this.table('passages')} ADD COLUMN lexical_text TEXT`);
          await client.query(`UPDATE ${this.table('passages')} SET lexical_text = text WHERE lexical_text IS NULL`);
          await client.query(`ALTER TABLE ${this.table('passages')} ALTER COLUMN lexical_text SET NOT NULL`);
        }
        const generated = await client.query<{ expression: string | null }>(`
          SELECT pg_get_expr(def.adbin, def.adrelid) AS expression
          FROM pg_attribute attribute
          JOIN pg_class relation ON relation.oid = attribute.attrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          LEFT JOIN pg_attrdef def
            ON def.adrelid = attribute.attrelid AND def.adnum = attribute.attnum
          WHERE namespace.nspname = $1 AND relation.relname = 'passages'
            AND attribute.attname = 'search_vector'
        `, [this.schema]);
        if (!generated.rows[0]?.expression?.includes('lexical_text')) {
          await client.query(`ALTER TABLE ${this.table('passages')} DROP COLUMN search_vector CASCADE`);
          await client.query(`
            ALTER TABLE ${this.table('passages')} ADD COLUMN search_vector TSVECTOR
            GENERATED ALWAYS AS (
              setweight(to_tsvector('simple'::regconfig, coalesce(lexical_text, '')), 'B')
            ) STORED
          `);
        }
        await client.query(`
          INSERT INTO ${this.table('schema_migrations')} (version, name, applied_at)
          VALUES (2, 'table_header_lexical_derivatives', $1)
        `, [now()]);
      }
      const migrationThree = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM ${this.table('schema_migrations')} WHERE version = 3
        ) AS exists
      `);
      if (!migrationThree.rows[0]?.exists) {
        for (const name of [
          'ingestion_job_items', 'retrieval_hits', 'retrieval_query_variants',
          'retrieval_evidence', 'evaluation_queries', 'relevance_judgments',
          'evaluation_runs', 'evaluation_metrics',
        ]) {
          await client.query(`ALTER TABLE ${this.table(name)} ADD COLUMN IF NOT EXISTS workspace_id TEXT`);
          await client.query(`ALTER TABLE ${this.table(name)} ADD COLUMN IF NOT EXISTS context_id TEXT`);
        }
        await client.query(`
          UPDATE ${this.table('ingestion_job_items')} child
          SET workspace_id = parent.workspace_id, context_id = parent.context_id
          FROM ${this.table('ingestion_jobs')} parent
          WHERE child.job_id = parent.id
            AND (child.workspace_id IS NULL OR child.context_id IS NULL)
        `);
        for (const name of ['retrieval_hits', 'retrieval_query_variants', 'retrieval_evidence']) {
          await client.query(`
            UPDATE ${this.table(name)} child
            SET workspace_id = parent.workspace_id, context_id = parent.context_id
            FROM ${this.table('retrieval_runs')} parent
            WHERE child.run_id = parent.id
              AND (child.workspace_id IS NULL OR child.context_id IS NULL)
          `);
        }
        await client.query(`
          UPDATE ${this.table('evaluation_runs')} run
          SET context_id = COALESCE((
            SELECT publication.context_id
            FROM ${this.table('publications')} publication
            WHERE publication.workspace_id = run.workspace_id
              AND publication.generation_id = run.index_generation_id
            LIMIT 1
          ), 'legacy')
          WHERE run.context_id IS NULL
        `);
        await client.query(`
          UPDATE ${this.table('evaluation_queries')} query
          SET context_id = COALESCE((
            SELECT publication.context_id
            FROM ${this.table('publications')} publication
            WHERE publication.workspace_id = query.workspace_id
            ORDER BY publication.active DESC, publication.created_at DESC
            LIMIT 1
          ), 'legacy')
          WHERE query.context_id IS NULL
        `);
        await client.query(`
          UPDATE ${this.table('relevance_judgments')} child
          SET workspace_id = parent.workspace_id, context_id = parent.context_id
          FROM ${this.table('evaluation_queries')} parent
          WHERE child.query_id = parent.id
            AND (child.workspace_id IS NULL OR child.context_id IS NULL)
        `);
        await client.query(`
          UPDATE ${this.table('evaluation_metrics')} child
          SET workspace_id = parent.workspace_id, context_id = parent.context_id
          FROM ${this.table('evaluation_runs')} parent
          WHERE child.run_id = parent.id
            AND (child.workspace_id IS NULL OR child.context_id IS NULL)
        `);
        for (const name of [
          'ingestion_job_items', 'retrieval_hits', 'retrieval_query_variants',
          'retrieval_evidence', 'evaluation_queries', 'relevance_judgments',
          'evaluation_runs', 'evaluation_metrics',
        ]) {
          await client.query(`ALTER TABLE ${this.table(name)} ALTER COLUMN workspace_id SET NOT NULL`);
          await client.query(`ALTER TABLE ${this.table(name)} ALTER COLUMN context_id SET NOT NULL`);
        }
        await client.query(`
          INSERT INTO ${this.table('schema_migrations')} (version, name, applied_at)
          VALUES (3, 'workspace_scoped_operational_rows', $1)
        `, [now()]);
      }
      const migrationFour = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM ${this.table('schema_migrations')} WHERE version = 4
        ) AS exists
      `);
      if (!migrationFour.rows[0]?.exists) {
        await client.query(`
          ALTER TABLE ${this.table('documents')} ADD COLUMN IF NOT EXISTS search_vector_en TSVECTOR
            GENERATED ALWAYS AS (
              setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
              setweight(to_tsvector('english'::regconfig, coalesce(routing_summary, '')), 'B')
            ) STORED;
          ALTER TABLE ${this.table('documents')} ADD COLUMN IF NOT EXISTS search_vector_de TSVECTOR
            GENERATED ALWAYS AS (
              setweight(to_tsvector('german'::regconfig, coalesce(title, '')), 'A') ||
              setweight(to_tsvector('german'::regconfig, coalesce(routing_summary, '')), 'B')
            ) STORED;
          ALTER TABLE ${this.table('sections')} ADD COLUMN IF NOT EXISTS search_vector_en TSVECTOR
            GENERATED ALWAYS AS (
              CASE WHEN language = 'en'
                THEN setweight(to_tsvector('english'::regconfig, coalesce(heading_text, '')), 'A')
                  || setweight(to_tsvector('english'::regconfig, coalesce(routing_summary, '')), 'B')
                ELSE ''::tsvector END
            ) STORED;
          ALTER TABLE ${this.table('sections')} ADD COLUMN IF NOT EXISTS search_vector_de TSVECTOR
            GENERATED ALWAYS AS (
              CASE WHEN language = 'de'
                THEN setweight(to_tsvector('german'::regconfig, coalesce(heading_text, '')), 'A')
                  || setweight(to_tsvector('german'::regconfig, coalesce(routing_summary, '')), 'B')
                ELSE ''::tsvector END
            ) STORED;
          ALTER TABLE ${this.table('passages')} ADD COLUMN IF NOT EXISTS search_vector_en TSVECTOR
            GENERATED ALWAYS AS (
              CASE WHEN language = 'en'
                THEN setweight(to_tsvector('english'::regconfig, coalesce(lexical_text, '')), 'B')
                ELSE ''::tsvector END
            ) STORED;
          ALTER TABLE ${this.table('passages')} ADD COLUMN IF NOT EXISTS search_vector_de TSVECTOR
            GENERATED ALWAYS AS (
              CASE WHEN language = 'de'
                THEN setweight(to_tsvector('german'::regconfig, coalesce(lexical_text, '')), 'B')
                ELSE ''::tsvector END
            ) STORED
        `);
        await client.query(`
          INSERT INTO ${this.table('schema_migrations')} (version, name, applied_at)
          VALUES (4, 'validated_language_lexical_fields', $1)
        `, [now()]);
      }
      const migrationFive = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM ${this.table('schema_migrations')} WHERE version = 5
        ) AS exists
      `);
      if (!migrationFive.rows[0]?.exists) {
        await client.query(
          `ALTER TABLE ${this.table('publications')} ADD COLUMN IF NOT EXISTS embedding_signature TEXT`,
        );
        await client.query(`
          UPDATE ${this.table('publications')}
          SET embedding_signature = $1
          WHERE embedding_signature IS NULL
        `, [this.vectorizer?.signature ?? 'legacy-unknown']);
        await client.query(
          `ALTER TABLE ${this.table('publications')} ALTER COLUMN embedding_signature SET NOT NULL`,
        );
        await client.query(`
          INSERT INTO ${this.table('schema_migrations')} (version, name, applied_at)
          VALUES (5, 'signature_scoped_derivative_generations', $1)
        `, [now()]);
      }
      const migrationSix = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM ${this.table('schema_migrations')} WHERE version = 6
        ) AS exists
      `);
      if (!migrationSix.rows[0]?.exists) {
        await client.query(`
          ALTER TABLE ${this.table('documents')} ADD COLUMN IF NOT EXISTS collection_id TEXT;
          ALTER TABLE ${this.table('documents')} ADD COLUMN IF NOT EXISTS collection_title TEXT
        `);
        await client.query(`
          INSERT INTO ${this.table('schema_migrations')} (version, name, applied_at)
          VALUES (6, 'versioned_semantic_summaries_and_collections', $1)
        `, [now()]);
      }
      const migrationSeven = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM ${this.table('schema_migrations')} WHERE version = 7
        ) AS exists
      `);
      if (!migrationSeven.rows[0]?.exists) {
        // Generations used to admit a document before its passages were written, so an interrupted
        // run could leave a half-ingested member behind. Drop those: resumption now trusts
        // membership, and a dropped member is simply re-ingested by the next scan.
        await client.query(`
          DELETE FROM ${this.table('publication_documents')} pd
          USING ${this.table('documents')} d
          WHERE d.document_version_id = pd.document_version_id
            AND d.line_count = 0 AND d.routing_summary = ''
        `);
        await client.query(`
          INSERT INTO ${this.table('schema_migrations')} (version, name, applied_at)
          VALUES (7, 'complete_documents_only_in_generations', $1)
        `, [now()]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Enables row-level security on every table and creates idempotent
   * workspace-isolation policies comparing `workspace_id` to the
   * `app.workspace_id` session setting. Policy names and identifiers are
   * interpolated into DO-block string literals where bind parameters cannot
   * go, so each is re-validated with {@link quoteIdentifier} at the
   * interpolation point.
   *
   * @returns Resolves when all policies are in place.
   * @throws Error - When an identifier fails the safety gate, or on Postgres
   * client errors.
   */
  private async enableRowSecurity(): Promise<void> {
    for (const name of [
      'publications', 'collections', 'documents', 'publication_documents', 'sections', 'passages',
      'ingestion_jobs', 'ingestion_job_items', 'derivative_jobs', 'routing_summaries',
      'retrieval_runs', 'retrieval_hits', 'retrieval_query_variants', 'retrieval_evidence',
      'evaluation_queries', 'relevance_judgments', 'evaluation_runs', 'evaluation_metrics',
      'regex_runs',
    ]) {
      await this.ddlPool().query(`ALTER TABLE ${this.table(name)} ENABLE ROW LEVEL SECURITY`);
      const policyName = `rag_v2_${name}_workspace`;
      // The DO block interpolates these into quoted string literals (bind parameters are not
      // possible there), so re-validate each at the interpolation point rather than trusting
      // upstream sanitization — quoteIdentifier throws on any character outside the safe set.
      quoteIdentifier(this.schema);
      quoteIdentifier(name);
      quoteIdentifier(policyName);
      await this.ddlPool().query(`
        DO $policy$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE schemaname = '${this.schema}'
              AND tablename = '${name}' AND policyname = '${policyName}'
          ) THEN
            CREATE POLICY ${quoteIdentifier(policyName)} ON ${this.table(name)}
              USING (workspace_id = current_setting('app.workspace_id', TRUE))
              WITH CHECK (workspace_id = current_setting('app.workspace_id', TRUE));
          END IF;
        END
        $policy$;
      `);
    }
    const embeddingsPolicy = `rag_v2_embeddings_${this.vectorizer?.dimensions ?? 0}_workspace`;
    // Same DO-block interpolation guard as the per-table loop above.
    quoteIdentifier(this.schema);
    quoteIdentifier(embeddingsPolicy);
    await this.ddlPool().query(`ALTER TABLE ${this.getEmbeddingsTable()} ENABLE ROW LEVEL SECURITY`);
    await this.ddlPool().query(`
      DO $policy$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE schemaname = '${this.schema}'
            AND tablename = 'unit_embeddings_${this.vectorizer?.dimensions ?? 0}'
            AND policyname = '${embeddingsPolicy}'
        ) THEN
          CREATE POLICY ${quoteIdentifier(embeddingsPolicy)} ON ${this.getEmbeddingsTable()}
            USING (workspace_id = current_setting('app.workspace_id', TRUE))
            WITH CHECK (workspace_id = current_setting('app.workspace_id', TRUE));
        END IF;
      END
      $policy$;
    `);
  }

  /**
   * Grants the application role DML on every table plus schema usage and
   * sequence access, and enforces role separation: the application role must
   * differ from the migration owner and must have neither SUPERUSER nor
   * BYPASSRLS.
   *
   * @returns Resolves once the grants are applied; resolves immediately when
   * no migration pool is configured and role separation is not required.
   * @throws Error - When role separation is required but unconfigured, when a
   * role check fails, or on Postgres client errors.
   */
  private async grantApplicationRole(): Promise<void> {
    const required = process.env['CORTEX_RAG_V2_REQUIRE_SEPARATE_DB_ROLES'] === '1';
    if (!this.migrationPool) {
      if (required) {
        throw new Error(
          'Workspace RAG V2 requires CORTEX_RAG_V2_MIGRATION_POSTGRES_URL so the application role does not own protected tables.',
        );
      }
      return;
    }
    const application = await this.pool.query<{
      name: string;
      superuser: boolean;
      bypassrls: boolean;
    }>(`
      SELECT current_user AS name, rol.rolsuper AS superuser, rol.rolbypassrls AS bypassrls
      FROM pg_roles rol WHERE rol.rolname = current_user
    `);
    const owner = await this.migrationPool.query<{ name: string }>('SELECT current_user AS name');
    const app = application.rows[0];
    const ownerName = owner.rows[0]?.name;
    if (!app || !ownerName || app.name === ownerName || app.superuser || app.bypassrls) {
      throw new Error(
        'Workspace RAG V2 application role must differ from the migration owner and have neither SUPERUSER nor BYPASSRLS.',
      );
    }
    const role = quoteRole(app.name);
    const tables = [
      'publications', 'collections', 'documents', 'publication_documents', 'sections', 'passages',
      'ingestion_jobs', 'ingestion_job_items', 'derivative_jobs', 'routing_summaries',
      'retrieval_runs', 'retrieval_hits', 'retrieval_query_variants', 'retrieval_evidence',
      'evaluation_queries', 'relevance_judgments', 'evaluation_runs', 'evaluation_metrics',
      'regex_runs',
    ].map(name => this.table(name));
    tables.push(this.getEmbeddingsTable());
    await this.migrationPool.query(`GRANT USAGE ON SCHEMA ${this.schemaSql} TO ${role}`);
    await this.migrationPool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables.join(', ')} TO ${role}`,
    );
    await this.migrationPool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${this.schemaSql} TO ${role}`);
    await this.migrationPool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${this.schemaSql} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await this.migrationPool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${this.schemaSql} GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
    );
  }

  /**
   * Runs `action` on a dedicated pool client inside a transaction with the
   * row-level-security settings applied (`app.workspace_id`,
   * `app.principal_id`, `app.group_ids`). Rolls back and rethrows on failure;
   * the client is always released.
   *
   * @typeParam T - Result type of the action.
   * @param workspaceId - Workspace set for the transaction's RLS checks.
   * @param action - Callback receiving the transaction client; it must not
   * commit or roll back the transaction itself.
   * @returns The action's result once the transaction commits.
   * @throws Error - Any error thrown by `action` or by Postgres; the
   * transaction is rolled back first.
   */
  private async withWorkspace<T>(workspaceId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.workspace_id', $1, TRUE)`, [workspaceId]);
      await client.query(`SELECT set_config('app.principal_id', 'workspace-rag-v2', TRUE)`);
      await client.query(`SELECT set_config('app.group_ids', '[]', TRUE)`);
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reports whether garbage collection must be skipped because the context's
   * most recent ingestion job has not reached a terminal state.
   *
   * @param client - Client positioned in the caller's workspace transaction.
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context whose latest job state is checked.
   * @returns True when a non-terminal job exists for the context.
   * @throws Error - Postgres client errors from the query.
   */
  private async gcBlockedWithClient(
    client: PoolClient,
    workspaceId: string,
    contextId: string,
  ): Promise<boolean> {
    const result = await client.query<{ state: string }>(`
      SELECT state
      FROM ${this.table('ingestion_jobs')}
      WHERE workspace_id = $1 AND context_id = $2
      ORDER BY created_at DESC
      LIMIT 1
    `, [workspaceId, contextId]);
    const state = result.rows[0]?.state;
    return state !== undefined && !(TERMINAL_JOB_STATES as readonly string[]).includes(state);
  }

  /**
   * Computes completeness counters for a generation and validates invariants:
   * a non-empty generation must contain passages, and no passage may have an
   * inverted byte/line range or a non-ready lexical state.
   *
   * @param client - Client positioned in the caller's workspace transaction.
   * @param workspaceId - Workspace owning the context.
   * @param contextId - Context of the generation.
   * @param generationId - Generation to validate.
   * @returns Counts plus an `errors` list (`valid` is true only when empty).
   * @throws Error - Postgres client errors from the queries.
   */
  private async validateGenerationWithClient(
    client: PoolClient,
    workspaceId: string,
    contextId: string,
    generationId: string,
  ) {
    const counts = await client.query<{
      documents: string; sections: string; passages: string; lexical_ready: string; passage_embeddings: string;
    }>(`
      SELECT
        COUNT(DISTINCT pd.document_version_id)::text AS documents,
        COUNT(DISTINCT s.section_id)::text AS sections,
        COUNT(DISTINCT p.passage_id)::text AS passages,
        COUNT(DISTINCT p.passage_id) FILTER (WHERE p.lexical_state = 'ready')::text AS lexical_ready,
        COUNT(DISTINCT embedding.unit_id)::text AS passage_embeddings
      FROM ${this.table('publication_documents')} pd
      LEFT JOIN ${this.table('sections')} s ON s.document_version_id = pd.document_version_id
      LEFT JOIN ${this.table('passages')} p ON p.document_version_id = pd.document_version_id
      LEFT JOIN ${this.getEmbeddingsTable()} embedding
        ON embedding.level = 'passage' AND embedding.unit_id = p.passage_id
        AND embedding.embedding_signature = $4
      WHERE pd.workspace_id = $1 AND pd.context_id = $2 AND pd.generation_id = $3
    `, [workspaceId, contextId, generationId, this.vectorizer?.signature ?? 'uninitialized']);
    const invalid = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM ${this.table('passages')} p
      JOIN ${this.table('publication_documents')} pd ON pd.document_version_id = p.document_version_id
      WHERE pd.generation_id = $1
        AND (p.end_byte <= p.start_byte OR p.end_line < p.start_line OR p.lexical_state <> 'ready')
    `, [generationId]);
    const row = counts.rows[0]!;
    const documents = Number(row.documents);
    const passages = Number(row.passages);
    const invalidCount = Number(invalid.rows[0]?.count ?? 0);
    const errors: string[] = [];
    if (documents > 0 && passages === 0) errors.push('Generation contains no passages.');
    if (invalidCount > 0) errors.push(`Generation contains ${invalidCount} invalid passage manifests.`);
    return {
      valid: errors.length === 0,
      documents,
      sections: Number(row.sections),
      passages,
      lexicalReady: Number(row.lexical_ready),
      passageEmbeddings: Number(row.passage_embeddings),
      errors,
    };
  }

  /**
   * Upserts an ingestion job row, storing the full job record as its JSONB
   * payload.
   *
   * @param job - Job record to write.
   * @returns Resolves when the row is written.
   * @throws Error - Postgres client errors from the upsert.
   */
  private async writeJob(job: RagV2Job): Promise<void> {
    await this.withWorkspace(job.workspaceId, client => client.query(`
      INSERT INTO ${this.table('ingestion_jobs')} (
        id, workspace_id, context_id, generation_id, state, payload, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        state = EXCLUDED.state, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
    `, [
      job.id, job.workspaceId, job.contextId, job.generationId,
      job.state, json(job), job.createdAt, job.updatedAt,
    ]).then(() => undefined));
  }

  /**
   * Inserts or updates a document row. On conflict of `document_version_id`,
   * mutable metadata is overwritten while existing source ids are preserved
   * when the incoming ones are absent.
   *
   * @param client - Client positioned in the caller's workspace transaction.
   * @param document - Document record to write.
   * @returns Resolves when the row is written.
   * @throws Error - Postgres client errors from the statement.
   */
  private async upsertDocument(client: PoolClient, document: RagV2DocumentRecord): Promise<void> {
    await client.query(`
      INSERT INTO ${this.table('documents')} (
        document_version_id, document_id, source_id, source_version_id, workspace_id, context_id,
        acl_tokens, path, title, collection_id, collection_title, document_type, jurisdiction, governing_law, parties,
        publication_date, valid_from, valid_to, language_distribution, byte_length, line_count,
        content_sha256, table_of_contents, routing_summary, publication_state, object_path,
        line_index_path, modified_at, embedding_state
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb,$20,$21,
        $22,$23::jsonb,$24,$25,$26,$27,$28,$29
      )
      ON CONFLICT (document_version_id) DO UPDATE SET
        source_id = COALESCE(EXCLUDED.source_id, ${this.table('documents')}.source_id),
        source_version_id = COALESCE(EXCLUDED.source_version_id, ${this.table('documents')}.source_version_id),
        title = EXCLUDED.title, collection_id = EXCLUDED.collection_id,
        collection_title = EXCLUDED.collection_title,
        language_distribution = EXCLUDED.language_distribution,
        line_count = EXCLUDED.line_count, table_of_contents = EXCLUDED.table_of_contents,
        routing_summary = EXCLUDED.routing_summary, publication_state = EXCLUDED.publication_state,
        embedding_state = EXCLUDED.embedding_state
    `, [
      document.documentVersionId, document.documentId, document.sourceId ?? null, document.sourceVersionId ?? null,
      document.workspaceId, document.contextId, document.aclTokens, document.path, document.title,
      document.collectionId ?? null, document.collectionTitle ?? null,
      document.documentType, document.jurisdiction ?? null, document.governingLaw ?? null,
      json(document.parties), document.publicationDate ?? null, document.validFrom ?? null,
      document.validTo ?? null, json(document.languageDistribution), document.byteLength, document.lineCount,
      document.contentSha256, json(document.tableOfContents), document.routingSummary,
      document.publicationState, document.objectPath, document.lineIndexPath, document.modifiedAt,
      document.embeddingState,
    ]);
  }

  /**
   * Builds the positional bind array shared by the search SQL templates:
   * $1 workspace, $2 context, $3 generation, $4 query text or vector literal,
   * $5 document ids, $6 section ids, $7 authorization tokens (defaulting to
   * `workspace:<id>`), $8 result limit, $9 vectorizer signature (null for
   * lexical), $10 document types, $11 jurisdictions, $12 as-of date, and
   * $13 collection ids. In approximate index modes the limit is scaled 4x
   * (capped at 10,000) so the re-ranking pass can trim.
   *
   * @param scope - Search scope with filters and limit.
   * @param queryOrVector - Lexical query text or the `vector` literal of the
   * query embedding.
   * @param signature - Vectorizer signature for dense search; omit for
   * lexical search.
   * @returns Bind values aligned with {@link PostgresRagV2Repository.searchSql}
   * and the exact-search SQL.
   * @throws Never.
   */
  private searchParameters(
    scope: RagV2SearchScope,
    queryOrVector: string,
    signature?: string,
  ): unknown[] {
    const values: unknown[] = [
      scope.workspaceId,
      scope.contextId,
      scope.generationId,
      queryOrVector,
      scope.documentIds ?? null,
      scope.sectionIds ?? null,
      scope.authorizationTokens ?? [`workspace:${scope.workspaceId}`],
      signature !== undefined && this.vectorIndexMode !== 'full'
        ? Math.min(10_000, scope.limit * 4)
        : scope.limit,
      signature ?? null,
      scope.documentTypes?.map(value => value.toLocaleLowerCase()) ?? null,
      scope.jurisdictions?.map(value => value.toLocaleLowerCase()) ?? null,
      scope.asOfDate ?? null,
      scope.collectionIds ?? null,
    ];
    return values;
  }

  /**
   * Composes the lexical or dense search SQL for document, section, or passage
   * levels on top of the common SELECT fragments. The tsquery configuration
   * (`english`/`german`/`simple`, from `lexicalLanguage`) is embedded as a
   * literal from a fixed set; all variable input flows through bind
   * parameters. The dense variant orders by exact or approximate cosine
   * distance according to the configured vector index mode.
   *
   * @param level - Level to search.
   * @param kind - `lexical` (full-text) or `dense` (vector).
   * @param lexicalLanguage - Language selecting the tsvector column and
   * tsquery configuration; defaults to `simple`.
   * @returns The SQL text with placeholders $1-$13.
   * @throws Error - For dense search when the repository is not initialized.
   */
  private searchSql(
    level: RagV2Level,
    kind: 'lexical' | 'dense',
    lexicalLanguage?: string,
  ): string {
    if (level === 'collection') return this.collectionSearchSql(kind, lexicalLanguage);
    if (kind === 'lexical') {
      const configuration = lexicalLanguage === 'en'
        ? 'english'
        : lexicalLanguage === 'de'
          ? 'german'
          : 'simple';
      const vectorColumn = lexicalLanguage === 'en'
        ? 'search_vector_en'
        : lexicalLanguage === 'de'
          ? 'search_vector_de'
          : 'search_vector';
      const score = `ts_rank_cd(x.search_vector, websearch_to_tsquery('${configuration}'::regconfig, $4), 32)`;
      const source = level === 'document'
        ? this.commonDocumentSelect(score)
        : level === 'section'
          ? this.commonSectionSelect(score)
          : this.commonPassageSelect(score);
      const idFilter = level === 'document'
        ? `AND ($6::text[] IS NULL OR TRUE)`
        : level === 'section'
          ? `AND ($6::text[] IS NULL OR s.section_id = ANY($6::text[]))`
          : `AND ($6::text[] IS NULL OR p.section_id = ANY($6::text[]))`;
      return `
        ${source}
        CROSS JOIN LATERAL (
          SELECT ${level === 'document' ? 'd' : level === 'section' ? 's' : 'p'}.${vectorColumn} AS search_vector
        ) x
        WHERE pd.generation_id = $3
          AND d.workspace_id = $1 AND d.context_id = $2
          AND x.search_vector @@ websearch_to_tsquery('${configuration}'::regconfig, $4)
          AND ($5::text[] IS NULL OR d.document_id = ANY($5::text[]))
          ${idFilter}
          AND d.acl_tokens && $7::text[]
          AND ($9::text IS NULL OR TRUE)
          AND ($10::text[] IS NULL OR lower(d.document_type) = ANY($10::text[]))
          AND ($11::text[] IS NULL OR lower(d.jurisdiction) = ANY($11::text[]))
          AND ($12::date IS NULL OR (
            (d.publication_date IS NULL OR d.publication_date <= $12::date)
            AND (d.valid_from IS NULL OR d.valid_from <= $12::date)
            AND (d.valid_to IS NULL OR d.valid_to >= $12::date)
          ))
          AND ($13::text[] IS NULL OR d.collection_id = ANY($13::text[]))
        ORDER BY score DESC
        LIMIT $8
      `;
    }
    const alias = level === 'document' ? 'd' : level === 'section' ? 's' : 'p';
    const unitId = level === 'document' ? 'd.document_version_id' : level === 'section' ? 's.section_id' : 'p.passage_id';
    const score = `GREATEST(0, 1 - (e.embedding <=> $4::vector))::float8`;
    const approximateOrder = this.vectorIndexMode === 'half'
      ? `(e.embedding::halfvec(${this.vectorizer?.dimensions ?? 1})) <=> (($4::vector)::halfvec(${this.vectorizer?.dimensions ?? 1}))`
      : this.vectorIndexMode === 'binary'
        ? `(binary_quantize(e.embedding)::bit(${this.vectorizer?.dimensions ?? 1})) <~> (binary_quantize($4::vector)::bit(${this.vectorizer?.dimensions ?? 1}))`
        : `e.embedding <=> $4::vector`;
    const source = level === 'document'
      ? this.commonDocumentSelect(score)
      : level === 'section'
        ? this.commonSectionSelect(score)
        : this.commonPassageSelect(score);
    const idFilter = level === 'document'
      ? `AND ($6::text[] IS NULL OR TRUE)`
      : level === 'section'
        ? `AND ($6::text[] IS NULL OR s.section_id = ANY($6::text[]))`
        : `AND ($6::text[] IS NULL OR p.section_id = ANY($6::text[]))`;
    return `
      ${source}
      JOIN ${this.getEmbeddingsTable()} e
        ON e.level = '${level}' AND e.unit_id = ${unitId} AND e.embedding_signature = $9
      WHERE pd.generation_id = $3
        AND d.workspace_id = $1 AND d.context_id = $2
        AND ($5::text[] IS NULL OR d.document_id = ANY($5::text[]))
        ${idFilter}
        AND d.acl_tokens && $7::text[]
        AND ($10::text[] IS NULL OR lower(d.document_type) = ANY($10::text[]))
        AND ($11::text[] IS NULL OR lower(d.jurisdiction) = ANY($11::text[]))
        AND ($12::date IS NULL OR (
          (d.publication_date IS NULL OR d.publication_date <= $12::date)
          AND (d.valid_from IS NULL OR d.valid_from <= $12::date)
          AND (d.valid_to IS NULL OR d.valid_to >= $12::date)
        ))
        AND ($13::text[] IS NULL OR d.collection_id = ANY($13::text[]))
      ORDER BY ${approximateOrder}
      LIMIT $8
    `;
  }

  /**
   * Composes collection-level search SQL. Authorization requires at least one
   * member document that passes the scope's filters; self-comparison
   * placeholders ($6/$9) keep parameter positions aligned with the shared
   * bind array built by {@link PostgresRagV2Repository.searchParameters}.
   *
   * @param kind - `lexical` (full-text) or `dense` (vector).
   * @param lexicalLanguage - Language selecting the tsvector column and
   * tsquery configuration; defaults to `simple`.
   * @returns The SQL text with placeholders $1-$13.
   * @throws Error - For dense search when the repository is not initialized.
   */
  private collectionSearchSql(kind: 'lexical' | 'dense', lexicalLanguage?: string): string {
    const authorization = `
      EXISTS (
        SELECT 1
        FROM ${this.table('publication_documents')} pd
        JOIN ${this.table('documents')} d ON d.document_version_id = pd.document_version_id
        WHERE pd.generation_id = c.generation_id
          AND d.collection_id = c.collection_id
          AND d.acl_tokens && $7::text[]
          AND ($5::text[] IS NULL OR d.document_id = ANY($5::text[]))
          AND ($10::text[] IS NULL OR lower(d.document_type) = ANY($10::text[]))
          AND ($11::text[] IS NULL OR lower(d.jurisdiction) = ANY($11::text[]))
          AND ($12::date IS NULL OR (
            (d.publication_date IS NULL OR d.publication_date <= $12::date)
            AND (d.valid_from IS NULL OR d.valid_from <= $12::date)
            AND (d.valid_to IS NULL OR d.valid_to >= $12::date)
          ))
      )
      AND $6::text[] IS NOT DISTINCT FROM $6::text[]
    `;
    if (kind === 'lexical') {
      const configuration = lexicalLanguage === 'en'
        ? 'english'
        : lexicalLanguage === 'de'
          ? 'german'
          : 'simple';
      const vectorColumn = lexicalLanguage === 'en'
        ? 'search_vector_en'
        : lexicalLanguage === 'de'
          ? 'search_vector_de'
          : 'search_vector';
      const score = `ts_rank_cd(c.${vectorColumn}, websearch_to_tsquery('${configuration}'::regconfig, $4), 32)`;
      return `
        ${this.commonCollectionSelect(score)}
        WHERE c.generation_id = $3 AND c.workspace_id = $1 AND c.context_id = $2
          AND c.${vectorColumn} @@ websearch_to_tsquery('${configuration}'::regconfig, $4)
          AND $9::text IS NOT DISTINCT FROM $9::text
          AND ($13::text[] IS NULL OR c.collection_id = ANY($13::text[]))
          AND ${authorization}
        ORDER BY score DESC
        LIMIT $8
      `;
    }
    const score = `GREATEST(0, 1 - (e.embedding <=> $4::vector))::float8`;
    const approximateOrder = this.vectorIndexMode === 'half'
      ? `(e.embedding::halfvec(${this.vectorizer?.dimensions ?? 1})) <=> (($4::vector)::halfvec(${this.vectorizer?.dimensions ?? 1}))`
      : this.vectorIndexMode === 'binary'
        ? `(binary_quantize(e.embedding)::bit(${this.vectorizer?.dimensions ?? 1})) <~> (binary_quantize($4::vector)::bit(${this.vectorizer?.dimensions ?? 1}))`
        : `e.embedding <=> $4::vector`;
    return `
      ${this.commonCollectionSelect(score)}
      JOIN ${this.getEmbeddingsTable()} e
        ON e.level = 'collection' AND e.unit_id = c.collection_version_id AND e.embedding_signature = $9
      WHERE c.generation_id = $3 AND c.workspace_id = $1 AND c.context_id = $2
        AND ($13::text[] IS NULL OR c.collection_id = ANY($13::text[]))
        AND ${authorization}
      ORDER BY ${approximateOrder}
      LIMIT $8
    `;
  }

  /**
   * Builds the shared collection SELECT fragment (column aliases matching
   * {@link SearchRow}) with the caller's score expression embedded.
   *
   * @param score - Trusted score SQL expression built by this module, never
   * user input.
   * @returns A `SELECT ... FROM <collections> c` fragment.
   * @throws Never.
   */
  private commonCollectionSelect(score: string): string {
    return `
      SELECT 'collection'::text AS level, c.collection_version_id AS id,
        c.collection_id AS document_id, c.collection_version_id AS document_version_id,
        NULL::text AS section_id, NULL::text AS passage_id,
        'collection:' || c.collection_id AS path, c.title, ARRAY[]::text[] AS heading_path,
        NULL::bigint AS start_byte, NULL::bigint AS end_byte, NULL::bigint AS start_line, NULL::bigint AS end_line,
        'und'::text AS language, c.title || E'\n' || c.routing_summary AS text,
        c.content_sha256, NULL::text AS source_id, NULL::text AS source_version_id,
        NULL::text AS object_path, NULL::text AS line_index_path, c.embedding_state,
        ${score} AS score
      FROM ${this.table('collections')} c
    `;
  }

  /**
   * Builds the shared document-level SELECT fragment (column aliases matching
   * {@link SearchRow}) joined through generation membership, with the caller's
   * score expression embedded.
   *
   * @param score - Trusted score SQL expression built by this module, never
   * user input.
   * @returns A `SELECT ... FROM <publication_documents>/<documents>` fragment.
   * @throws Never.
   */
  private commonDocumentSelect(score: string): string {
    return `
      SELECT 'document'::text AS level, d.document_version_id AS id,
        d.document_id, d.document_version_id, NULL::text AS section_id, NULL::text AS passage_id,
        d.path, d.title, ARRAY[]::text[] AS heading_path,
        NULL::bigint AS start_byte, NULL::bigint AS end_byte, NULL::bigint AS start_line, NULL::bigint AS end_line,
        COALESCE((SELECT key FROM jsonb_each_text(d.language_distribution) ORDER BY value::float DESC LIMIT 1), 'und') AS language,
        d.title || E'\\n' || d.routing_summary AS text, d.content_sha256,
        d.source_id, d.source_version_id, d.object_path, d.line_index_path, d.embedding_state,
        ${score} AS score
      FROM ${this.table('publication_documents')} pd
      JOIN ${this.table('documents')} d ON d.document_version_id = pd.document_version_id
    `;
  }

  /**
   * Builds the shared section-level SELECT fragment (column aliases matching
   * {@link SearchRow}) joined through generation membership, with the caller's
   * score expression embedded.
   *
   * @param score - Trusted score SQL expression built by this module, never
   * user input.
   * @returns A `SELECT ... FROM <publication_documents>/<documents>/<sections>`
   * fragment.
   * @throws Never.
   */
  private commonSectionSelect(score: string): string {
    return `
      SELECT 'section'::text AS level, s.section_id AS id,
        d.document_id, d.document_version_id, s.section_id, NULL::text AS passage_id,
        d.path, d.title, s.heading_path, s.start_byte, s.end_byte, s.start_line, s.end_line,
        s.language, s.heading_text || E'\\n' || s.routing_summary AS text, s.content_sha256,
        d.source_id, d.source_version_id, d.object_path, d.line_index_path, s.embedding_state,
        ${score} AS score
      FROM ${this.table('publication_documents')} pd
      JOIN ${this.table('documents')} d ON d.document_version_id = pd.document_version_id
      JOIN ${this.table('sections')} s ON s.document_version_id = d.document_version_id
    `;
  }

  /**
   * Builds the shared passage-level SELECT fragment (column aliases matching
   * {@link SearchRow}) joined through generation membership, with the caller's
   * score expression embedded.
   *
   * @param score - Trusted score SQL expression built by this module, never
   * user input.
   * @returns A `SELECT ... FROM <publication_documents>/<documents>/<passages>`
   * fragment.
   * @throws Never.
   */
  private commonPassageSelect(score: string): string {
    return `
      SELECT 'passage'::text AS level, p.passage_id AS id,
        d.document_id, d.document_version_id, p.section_id, p.passage_id,
        d.path, d.title, p.heading_path, p.start_byte, p.end_byte, p.start_line, p.end_line,
        p.language, p.text, p.content_sha256,
        d.source_id, d.source_version_id, d.object_path, d.line_index_path, p.embedding_state,
        ${score} AS score
      FROM ${this.table('publication_documents')} pd
      JOIN ${this.table('documents')} d ON d.document_version_id = pd.document_version_id
      JOIN ${this.table('passages')} p ON p.document_version_id = d.document_version_id
    `;
  }

  /**
   * Maps one raw search row to a ranked hit, copying optional range and source
   * fields only when present and synthesizing a single retrieval reason.
   *
   * @param row - Raw row returned by a search query.
   * @param retriever - Retriever label recorded on the hit.
   * @param retrieverRank - 1-based rank of the hit within its retriever.
   * @returns The mapped hit.
   * @throws Never.
   */
  private rowToHit(row: SearchRow, retriever: string, retrieverRank: number): RagV2RankedHit {
    return {
      level: row.level,
      id: row.id,
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      ...(row.section_id ? { sectionId: row.section_id } : {}),
      ...(row.passage_id ? { passageId: row.passage_id } : {}),
      path: row.path,
      title: row.title,
      headingPath: row.heading_path ?? [],
      ...(numeric(row.start_byte) !== undefined ? { startByte: numeric(row.start_byte)! } : {}),
      ...(numeric(row.end_byte) !== undefined ? { endByte: numeric(row.end_byte)! } : {}),
      ...(numeric(row.start_line) !== undefined ? { startLine: numeric(row.start_line)! } : {}),
      ...(numeric(row.end_line) !== undefined ? { endLine: numeric(row.end_line)! } : {}),
      language: row.language,
      text: row.text,
      contentSha256: row.content_sha256,
      retriever,
      retrieverRank,
      retrieverScore: Number(row.score),
      ...(row.source_id ? { sourceId: row.source_id } : {}),
      ...(row.source_version_id ? { sourceVersionId: row.source_version_id } : {}),
      objectPath: row.object_path,
      lineIndexPath: row.line_index_path,
      ...(row.embedding_state ? { embeddingState: row.embedding_state as RagV2EmbeddingState } : {}),
      retrievalReasons: [`${retriever} rank ${retrieverRank}`],
    };
  }

  /**
   * Upserts a retrieval run row and, for `running` runs, re-derives the query
   * variants from the plan JSON (the original query plus lexical expansions),
   * storing each with a SHA-256 query hash. Variant inserts are no-ops on
   * conflict.
   *
   * @param run - Retrieval run record to write.
   * @returns Resolves when the run row and its variants are written.
   * @throws Error - Postgres client errors from any write.
   */
  private async writeRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void> {
    await this.withWorkspace(run.workspaceId, async client => {
      await client.query(`
      INSERT INTO ${this.table('retrieval_runs')} (
        id, workspace_id, context_id, generation_id, question_hash, plan,
        embedding_signature, reranker_model, status, timings, started_at, completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status, timings = EXCLUDED.timings, completed_at = EXCLUDED.completed_at
    `, [
      run.id, run.workspaceId, run.contextId, run.generationId, run.questionHash,
      json(run.planJson), run.embeddingSignature, run.rerankerModel ?? null, run.status,
      run.timingsJson === undefined ? null : json(run.timingsJson), run.startedAt, run.completedAt ?? null,
      ]);
      if (run.status === 'running') {
      const plan = run.planJson && typeof run.planJson === 'object'
        ? run.planJson as Record<string, unknown>
        : {};
      const original = typeof plan['originalQuery'] === 'string' ? plan['originalQuery'] : '';
      const originalLanguage = typeof plan['queryLanguage'] === 'string' ? plan['queryLanguage'] : 'und';
      const expansions = Array.isArray(plan['lexicalVariants'])
        ? plan['lexicalVariants'].filter(value => value && typeof value === 'object') as Array<Record<string, unknown>>
        : [];
      const variants = [
        { language: originalLanguage, query: original, reason: 'original query' },
        ...expansions.map(value => ({
          language: typeof value['language'] === 'string' ? value['language'] : 'und',
          query: typeof value['query'] === 'string' ? value['query'] : '',
          reason: typeof value['reason'] === 'string' ? value['reason'] : 'query expansion',
        })),
      ];
      for (let index = 0; index < variants.length; index++) {
        const variant = variants[index]!;
        await client.query(`
          INSERT INTO ${this.table('retrieval_query_variants')} (
            run_id, workspace_id, context_id, ordinal, language, query_hash, reason, payload
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          ON CONFLICT (run_id, ordinal) DO NOTHING
        `, [
          run.id, run.workspaceId, run.contextId, index, variant.language,
          createHash('sha256').update(variant.query).digest('hex'),
          variant.reason, json(variant),
        ]);
        }
      }
    });
  }
}
