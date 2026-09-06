import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadExpertConfig, expertConfigPath } from './config.js';
import { FileExpertKnowledge } from './file-knowledge.js';
import type { ExpertConfig, ExpertPanelConfig, ExpertSource } from './types.js';
/**
 * Source of expert-panel definitions, versioned by content so callers can detect
 * config changes without re-parsing.
 */
export interface ExpertDefinitionSource {
    snapshot(signal?: AbortSignal): Promise<{
        version: string;
        config: ExpertPanelConfig;
    }>;
}
/**
 * Knowledge retrieval for one expert: ranked sources plus non-fatal warnings about
 * unreadable or skipped material.
 */
export interface ExpertKnowledgeSource {
    searchWithDiagnostics(query: string, limit: number, signal: AbortSignal): Promise<{
        sources: ExpertSource[];
        warnings: string[];
    }>;
}
/** Creates the knowledge source used for one expert. */
export type ExpertKnowledgeFactory = (expert: ExpertConfig) => ExpertKnowledgeSource;
/**
 * {@link ExpertDefinitionSource} backed by experts.json on disk: each `snapshot()` call
 * re-reads and SHA-256 hashes the file, returning the cached parsed config while the
 * hash is unchanged.
 */
export class FileExpertDefinitionSource implements ExpertDefinitionSource {
    private cached: {
        version: string;
        config: ExpertPanelConfig;
    } | undefined;
    /**
     * Read and validate the current config, caching the parsed result by content hash.
     * @param signal Optional cancellation signal checked before and after work.
     * @returns The config plus the SHA-256 hex version of its raw text.
     * @throws Error when the file cannot be read or the config is invalid (see
     *         {@link loadExpertConfig}).
     */
    async snapshot(signal?: AbortSignal) { signal?.throwIfAborted(); const configPath = expertConfigPath(); const raw = await readFile(configPath, 'utf8'); const version = createHash('sha256').update(raw).digest('hex'); if (this.cached?.version === version)
        return this.cached; const config = await loadExpertConfig({ configPath, text: raw }); signal?.throwIfAborted(); this.cached = { version, config }; return this.cached; }
}
/**
 * Default knowledge factory: term-frequency file search over the expert's roots.
 * @param expert Expert whose roots are searched.
 * @returns A {@link FileExpertKnowledge} for the expert.
 * @throws Never.
 */
export const fileExpertKnowledge: ExpertKnowledgeFactory = expert => new FileExpertKnowledge(expert);
/**
 * Minimal RAG search surface this plugin consumes (the host's `WorkspaceRagManager`):
 * returns scored chunks with immutable ids.
 */
export interface ExpertRagSearch {
    searchCurrent(query: string, limit: number, signal: AbortSignal): Promise<Array<{
        chunkId: string;
        path: string;
        text: string;
        score: number;
        documentVersionId?: string;
    }>>;
}
/**
 * RAG supplies immutable passage IDs; configured expert roots still constrain accessible
 * evidence. Hits are over-fetched, filtered to the expert's roots, and truncated to the
 * requested limit.
 */
export class RagExpertKnowledge implements ExpertKnowledgeSource {
    private readonly expert: ExpertConfig;
    private readonly resolve: () => ExpertRagSearch | undefined;
    /**
     * Creates a RAG-backed knowledge source for one expert.
     * @param expert Expert whose roots constrain retrieved evidence.
     * @param resolve Lazy accessor for the RAG search service; may return `undefined`
     *        while the host service is absent (checked on every search).
     */
    constructor(expert: ExpertConfig, resolve: () => ExpertRagSearch | undefined) { this.expert = expert; this.resolve = resolve; }
    /**
     * Search the workspace RAG service, keeping only hits inside the expert's roots.
     * Requests `min(limit * 4, 50)` hits to compensate for root filtering; the
     * diagnostics list is always empty.
     * @param query Free-text query passed through to the RAG service.
     * @param limit Maximum number of sources to return.
     * @param signal Cancellation signal; aborts throw through to the caller.
     * @returns Root-filtered sources mapped from RAG chunks (score preserved), plus
     *          empty warnings.
     * @throws Error when the RAG service is unavailable; RAG and cancellation errors
     *         propagate from the underlying search.
     */
    async searchWithDiagnostics(query: string, limit: number, signal: AbortSignal) {
        const rag = this.resolve();
        if (!rag)
            throw new Error('Workspace RAG expert knowledge source unavailable');
        const hits = await rag.searchCurrent(query, Math.min(limit * 4, 50), signal);
        signal.throwIfAborted();
        const sources = hits.filter(hit => this.expert.roots.some(root => { const rel = path.relative(root, hit.path); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); })).slice(0, limit).map(hit => ({ id: hit.chunkId, expertId: this.expert.id, path: hit.path, title: path.basename(hit.path), content: hit.text, score: hit.score }));
        return { sources, warnings: [] };
    }
}
