import type { RagV2IngestionPolicy, RagV2Mode } from './types.js';

const MIB = 1024 * 1024;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function ragV2ModeFromEnv(): RagV2Mode {
  const value = String(process.env['CORTEX_RAG_V2_MODE'] ?? 'off').trim().toLowerCase();
  return value === 'shadow' || value === 'primary' ? value : 'off';
}

export function ragV2PolicyFromEnv(): RagV2IngestionPolicy {
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
  };
}

export function ragV2RerankerUrlFromEnv(): string | undefined {
  const value = String(process.env['CORTEX_RAG_V2_RERANKER_URL'] ?? '').trim();
  return value || undefined;
}

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

export function ragV2ColbertUrlFromEnv(): string | undefined {
  const value = process.env['CORTEX_RAG_V2_COLBERT_URL']?.trim();
  return value || undefined;
}
