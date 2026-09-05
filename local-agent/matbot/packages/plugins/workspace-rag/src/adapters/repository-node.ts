import { MemoryRagV2Repository } from '../v2/memory-repository.js';
import { PostgresRagV2Repository } from '../v2/postgres-repository.js';
import type { RagV2Repository } from '../v2/repository.js';
export type RagRepositoryFactory = (mode: string) => RagV2Repository;
export const createRagRepository: RagRepositoryFactory = mode => { if (mode === 'memory')
    return new MemoryRagV2Repository(); if (mode === 'postgres')
    return new PostgresRagV2Repository(); throw new Error('Unsupported RAG repository: ' + mode); };
