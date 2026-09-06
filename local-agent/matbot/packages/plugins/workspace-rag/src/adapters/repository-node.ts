import { MemoryRagV2Repository } from '../v2/memory-repository.js';
import { PostgresRagV2Repository } from '../v2/postgres-repository.js';
import type { RagV2Repository } from '../v2/repository.js';
/** Creates the RAG v2 persistence backend for a configured mode. */
export type RagRepositoryFactory = (mode: string) => RagV2Repository;
/**
 * Builds a {@link RagV2Repository} for the adapter mode a workspace configured.
 *
 * @param mode - Repository mode name; "memory" and "postgres" are supported.
 * @returns A new repository instance for the requested mode.
 * @throws {Error} When mode is neither "memory" nor "postgres".
 */
export const createRagRepository: RagRepositoryFactory = mode => { if (mode === 'memory')
    return new MemoryRagV2Repository(); if (mode === 'postgres')
    return new PostgresRagV2Repository(); throw new Error('Unsupported RAG repository: ' + mode); };
