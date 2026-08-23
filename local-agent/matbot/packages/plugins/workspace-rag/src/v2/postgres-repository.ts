import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { Pool as PgPool, PoolClient, PoolConfig } from 'pg';
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
  RagV2Publication,
  RagV2RegexRunRecord,
  RagV2Repository,
  RagV2RetrievalRunRecord,
  RagV2SearchScope,
  RagV2StoredRetrievalHit,
} from './repository.js';

const DEFAULT_SCHEMA = 'workspace_rag_v2';
const INSERT_BATCH_SIZE = 128;

interface PostgresSettings {
  poolConfig: PoolConfig;
  migrationPoolConfig?: PoolConfig;
  schema: string;
}

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

function sanitizeIdentifier(value: string): string {
  const result = value.replace(/[^a-zA-Z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 48);
  if (!result) return DEFAULT_SCHEMA;
  return /^[0-9]/u.test(result) ? `_${result}` : result;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function quoteRole(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Unsafe PostgreSQL role name.');
  return `"${value.replace(/"/gu, '""')}"`;
}

function settingsFromEnv(): PostgresSettings {
  const connectionString = process.env['CORTEX_RAG_POSTGRES_URL']?.trim();
  const poolConfig: PoolConfig = {
    max: Number(process.env['CORTEX_RAG_V2_POOL_MAX'] ?? 8),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env['CORTEX_RAG_V2_POOL_CONNECTION_TIMEOUT_MS'] ?? 30_000),
  };
  if (connectionString) poolConfig.connectionString = connectionString;
  else {
    poolConfig.host = process.env['CORTEX_RAG_POSTGRES_HOST']?.trim()
      || process.env['POSTGRES_HOST']?.trim()
      || 'localhost';
    poolConfig.port = Number(process.env['CORTEX_RAG_POSTGRES_PORT'] ?? process.env['POSTGRES_PORT'] ?? 5432);
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

function toVector(vector: readonly number[]): string {
  return `[${vector.map(value => Number.isFinite(value) ? value : 0).join(',')}]`;
}

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function numeric(value: string | null): number | undefined {
  return value === null ? undefined : Number(value);
}

export class PostgresRagV2Repository implements RagV2Repository {
  readonly backend = 'postgres-pgvector' as const;
  private readonly pool: PgPool;
  private readonly migrationPool: PgPool | undefined;
  private readonly schema: string;
  private readonly schemaSql: string;
  private vectorizer: RagV2VectorizerInfo | undefined;
  private embeddingsTableSql: string | undefined;
  private readonly vectorIndexMode: 'full' | 'half' | 'binary';

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
  }

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
  }

  async close(): Promise<void> {
    await this.pool.end();
    await this.migrationPool?.end();
  }

  async beginGeneration(workspaceId: string, contextId: string, generationId: string): Promise<void> {
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
        WHERE generation_id = (
          SELECT generation_id FROM ${this.table('publications')}
          WHERE workspace_id = $2 AND context_id = $3 AND active = TRUE
          LIMIT 1
        )
        ON CONFLICT (generation_id, document_id) DO NOTHING
      `, [generationId, workspaceId, contextId]);
    });
  }

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
      `, [workspaceId, contextId, generationId, state]);
    });
  }

  async validateGeneration(workspaceId: string, contextId: string, generationId: string) {
    return this.withWorkspace(
      workspaceId,
      client => this.validateGenerationWithClient(client, workspaceId, contextId, generationId),
    );
  }

  async createJob(job: RagV2Job): Promise<void> {
    await this.writeJob(job);
  }

  async updateJob(job: RagV2Job): Promise<void> {
    await this.writeJob(job);
  }

  async currentJob(workspaceId: string, contextId: string): Promise<RagV2Job | undefined> {
    const result = await this.withWorkspace(workspaceId, client => client.query<{ payload: RagV2Job }>(`
      SELECT payload FROM ${this.table('ingestion_jobs')}
      WHERE workspace_id = $1 AND context_id = $2
      ORDER BY created_at DESC
      LIMIT 1
    `, [workspaceId, contextId]));
    return result.rows[0]?.payload;
  }

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

  async beginDocument(_generationId: string, document: RagV2DocumentRecord): Promise<void> {
    await this.withWorkspace(document.workspaceId, client => this.upsertDocument(client, document));
  }

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

  async lexicalSearch(level: RagV2Level, query: string, scope: RagV2SearchScope): Promise<RagV2RankedHit[]> {
    const result = await this.withWorkspace(scope.workspaceId, client => client.query<SearchRow>(
      this.searchSql(level, 'lexical', scope.lexicalLanguage),
      this.searchParameters(scope, query),
    ));
    return result.rows.map((row, index) => this.rowToHit(row, `${level}_lexical`, index + 1));
  }

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

  async createRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void> {
    await this.writeRetrievalRun(run);
  }

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

  async finishRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void> {
    await this.writeRetrievalRun(run);
  }

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

  private table(name: string): string {
    return `${this.schemaSql}.${quoteIdentifier(name)}`;
  }

  private getEmbeddingsTable(): string {
    if (!this.embeddingsTableSql) throw new Error('Workspace RAG V2 repository is not initialized.');
    return this.embeddingsTableSql;
  }

  private ddlPool(): PgPool {
    return this.migrationPool ?? this.pool;
  }

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

  private async createIndexes(vectorizer: RagV2VectorizerInfo): Promise<void> {
    const embeddings = this.getEmbeddingsTable();
    await this.ddlPool().query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier('uq_rag_v2_active_publication')}
        ON ${this.table('publications')} (workspace_id, context_id) WHERE active = TRUE;
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier('idx_rag_v2_publication_documents_version')}
        ON ${this.table('publication_documents')} (generation_id, document_version_id);
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
