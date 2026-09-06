import type { RagV2IngestionPolicy, RagV2Mode } from './types.js';

const MIB = 1024 * 1024;

/**
 * Orphan-GC cadence, grace, batching, and feature-gate settings.
 */
export interface RagV2GcSettings {
  enabled: boolean;
  intervalMs: number;
  graceMs: number;
  batchSize: number;
  retiredGenerationTtlMs: number;
  blobGcEnabled: boolean;
}

/**
 * Parses a raw string as a positive safe integer.
 * @param value - Raw value (typically an environment variable); undefined or empty yields the fallback.
 * @param fallback - Returned when `value` is not a safe integer greater than zero.
 * @returns The parsed integer, or `fallback`.
 * @throws Never.
 */
export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parses a raw string as a non-negative safe integer.
 * @param value - Raw value or undefined; undefined yields the fallback.
 * @param fallback - Returned when `value` is not a safe integer of at least zero.
 * @returns The parsed integer, or `fallback`.
 * @throws Never.
 */
function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Parses a raw string as an integer clamped into an inclusive range.
 * @param value - Raw value or undefined; non-finite or below-1 values yield the fallback rather than being clamped.
 * @param fallback - Returned when `value` is unusable.
 * @param min - Inclusive lower clamp.
 * @param max - Inclusive upper clamp.
 * @returns The floored and clamped integer, or `fallback`.
 * @throws Never.
 */
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/**
 * Reads a positive integer from a named environment variable.
 * @param name - Environment variable to read.
 * @param fallback - Returned when the variable is unset, empty, or not a positive safe integer; the invalid value is logged first.
 * @returns The parsed value, or `fallback`.
 * @throws Never.
 */
function gcPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  console.warn(`[workspace-rag-v2] invalid ${name}=${JSON.stringify(raw)}; using ${fallback}.`);
  return fallback;
}

/**
 * Reads a boolean from a named environment variable.
 * @param name - Environment variable to read.
 * @param fallback - Returned when the variable is unset, empty, or not one of `true`, `1`, `false`, `0` (case-insensitive); the invalid value is logged first.
 * @returns The parsed value, or `fallback`.
 * @throws Never.
 */
function gcBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  console.warn(`[workspace-rag-v2] invalid ${name}=${JSON.stringify(raw)}; using ${fallback}.`);
  return fallback;
}

/**
 * Reads orphan-GC cadence, grace, batching, and feature gates.
 * @returns Settings resolved from the `CORTEX_RAG_V2_GC_*` and `CORTEX_RAG_V2_RETIRED_GENERATION_TTL_MS` variables with built-in defaults.
 * @throws Never.
 */
export function ragV2GcSettingsFromEnv(): RagV2GcSettings {
  return {
    enabled: gcBoolean('CORTEX_RAG_V2_GC_ENABLED', true),
    intervalMs: gcPositiveInteger('CORTEX_RAG_V2_GC_INTERVAL_MS', 21_600_000),
    graceMs: gcPositiveInteger('CORTEX_RAG_V2_GC_GRACE_MS', 3_600_000),
    batchSize: gcPositiveInteger('CORTEX_RAG_V2_GC_BATCH_SIZE', 2_000),
    retiredGenerationTtlMs: gcPositiveInteger(
      'CORTEX_RAG_V2_RETIRED_GENERATION_TTL_MS',
      604_800_000,
    ),
    blobGcEnabled: gcBoolean('CORTEX_RAG_V2_BLOB_GC_ENABLED', false),
  };
}

/**
 * Reads the v2 mode from the environment.
 * @returns The configured {@link RagV2Mode} (default 'primary').
 */
export function ragV2ModeFromEnv(): RagV2Mode {
  const value = String(process.env['CORTEX_RAG_V2_MODE'] ?? 'primary').trim().toLowerCase();
  return value === 'off' ? 'off' : 'primary';
}

/**
 * Builds the ingestion policy from environment variables with defaults.
 * @returns The resolved {@link RagV2IngestionPolicy}.
 */
export function ragV2PolicyFromEnv(): RagV2IngestionPolicy {
  const rawFileConcurrency = process.env['CORTEX_RAG_V2_FILE_CONCURRENCY']?.trim();
  return {
    eagerPassageMaxBytes: positiveInteger(process.env['CORTEX_RAG_V2_EAGER_MAX_BYTES'], 20 * MIB),
    asyncPassageMaxBytes: positiveInteger(process.env['CORTEX_RAG_V2_ASYNC_MAX_BYTES'], 250 * MIB),
    eagerPassageVectorCap: positiveInteger(process.env['CORTEX_RAG_V2_EAGER_PASSAGE_VECTOR_CAP'], 20_000),
    parserMemoryBytes: positiveInteger(process.env['CORTEX_RAG_V2_PARSER_MEMORY_BYTES'], 32 * MIB),
    targetPassageTokens: positiveInteger(process.env['CORTEX_RAG_V2_TARGET_PASSAGE_TOKENS'], 800),
    hardMaxPassageTokens: positiveInteger(process.env['CORTEX_RAG_V2_HARD_MAX_PASSAGE_TOKENS'], 1_200),
    lineIndexStride: positiveInteger(process.env['CORTEX_RAG_V2_LINE_INDEX_STRIDE'], 1_024),
    storageBytesPerSecond: nonNegativeInteger(process.env['CORTEX_RAG_V2_STORAGE_BYTES_PER_SECOND'], 0),
    embeddingTextsPerSecond: nonNegativeInteger(process.env['CORTEX_RAG_V2_EMBEDDING_TEXTS_PER_SECOND'], 0),
    sourceMetadataOpsPerSecond: nonNegativeInteger(process.env['CORTEX_RAG_V2_SOURCE_METADATA_OPS_PER_SECOND'], 0),
    contextGraphOpsPerSecond: nonNegativeInteger(process.env['CORTEX_RAG_V2_CONTEXT_GRAPH_OPS_PER_SECOND'], 0),
    ...(rawFileConcurrency ? { fileConcurrency: boundedInteger(rawFileConcurrency, 1, 1, 8) } : {}),
    embedPipelineDepth: boundedInteger(process.env['CORTEX_RAG_V2_EMBED_PIPELINE_DEPTH'], 2, 1, 8),
  };
}

/**
 * Reads the checkpoint publication interval (files) from the environment.
 * @returns Number of files between checkpoints (0 publishes only when the whole scan completes).
 */
export function ragV2CheckpointFilesFromEnv(): number {
  return nonNegativeInteger(process.env['CORTEX_RAG_V2_CHECKPOINT_FILES'], 250);
}

/**
 * Reads the reranker sidecar URL from the environment.
 * @returns The URL, or undefined when not configured.
 */
export function ragV2RerankerUrlFromEnv(): string | undefined {
  const value = String(process.env['CORTEX_RAG_V2_RERANKER_URL'] ?? '').trim();
  return value || undefined;
}

/**
 * Reads reciprocal-rank-fusion tuning from the environment.
 * @returns The RRF constant and per-retriever weights.
 */
export function ragV2RrfFromEnv(): { k: number; weights: Record<string, number> } {
  const k = positiveInteger(process.env['CORTEX_RAG_V2_RRF_K'], 60);
  const raw = process.env['CORTEX_RAG_V2_RRF_WEIGHTS']?.trim();
  if (!raw) return { k, weights: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { k, weights: {} };
    return {
      k,
      weights: Object.fromEntries(
        Object.entries(parsed)
          .map(([name, value]) => [name, Number(value)] as const)
          .filter((entry): entry is readonly [string, number] =>
            Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= 10),
      ),
    };
  } catch {
    return { k, weights: {} };
  }
}

/**
 * Reads cold-object retention settings from the environment.
 * @returns Retention thresholds controlling eviction of passage embeddings.
 * @throws Error - When retention mode is `external_immutable` and no `CORTEX_RAG_V2_EXTERNAL_OBJECT_ROOT` is set.
 */
export function ragV2ObjectRetentionFromEnv(): {
  mode: 'managed' | 'external_immutable' | 'manifest_only';
  externalRoot?: string;
} {
  const value = String(process.env['CORTEX_RAG_V2_OBJECT_RETENTION'] ?? 'managed').trim();
  const mode = value === 'external_immutable' || value === 'manifest_only' ? value : 'managed';
  const externalRoot = process.env['CORTEX_RAG_V2_EXTERNAL_OBJECT_ROOT']?.trim();
  if (mode === 'external_immutable' && !externalRoot) {
    throw new Error(
      'CORTEX_RAG_V2_EXTERNAL_OBJECT_ROOT is required when object retention is external_immutable.',
    );
  }
  return { mode, ...(externalRoot ? { externalRoot } : {}) };
}

/**
 * Reads the ColBERT late-interaction sidecar URL from the environment.
 * @returns The URL, or undefined when not configured.
 */
export function ragV2ColbertUrlFromEnv(): string | undefined {
  const value = process.env['CORTEX_RAG_V2_COLBERT_URL']?.trim();
  return value || undefined;
}

/**
 * Reads the object-store root override from the environment.
 * @returns The configured root, or undefined when per-workspace defaults apply.
 */
export function ragV2ObjectRootFromEnv(): string | undefined {
  return process.env['CORTEX_RAG_V2_OBJECT_ROOT']?.trim() || undefined;
}

/**
 * Reads the routing-summary concurrency cap from the environment.
 * @returns Concurrent summarizer calls permitted (clamped 1..8, default 4).
 */
export function ragV2SummaryConcurrencyFromEnv(): number {
  return boundedInteger(process.env['CORTEX_RAG_V2_SUMMARY_CONCURRENCY'], 4, 1, 8);
}

/**
 * Reads the routing-summary queue bound from the environment.
 * @returns Maximum queued summary tasks (clamped 16..4096, default 256).
 */
export function ragV2SummaryQueueLimitFromEnv(): number {
  return boundedInteger(process.env['CORTEX_RAG_V2_SUMMARY_QUEUE_LIMIT'], 256, 16, 4_096);
}

/**
 * Maximum time for one semantic summary and its embedding; default two minutes.
 * @returns Timeout in milliseconds, clamped to the range 10..3,600,000.
 * @throws Never.
 */
export function ragV2SummaryTimeoutMsFromEnv(): number {
  return boundedInteger(process.env['CORTEX_RAG_V2_SUMMARY_TIMEOUT_MS'], 120_000, 10, 3_600_000);
}

/**
 * Reads the audit-record retention window from the environment.
 * @returns Days to retain retrieval/regex audit rows (0 disables pruning).
 */
export function ragV2AuditRetentionDaysFromEnv(): number {
  return nonNegativeInteger(process.env['CORTEX_RAG_V2_AUDIT_RETENTION_DAYS'], 30);
}
