import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadExpertConfig, expertConfigPath } from './config.js';
import { FileExpertKnowledge } from './file-knowledge.js';
import type { ExpertConfig, ExpertPanelConfig, ExpertSource } from './types.js';
export interface ExpertDefinitionSource {
    snapshot(signal?: AbortSignal): Promise<{
        version: string;
        config: ExpertPanelConfig;
    }>;
}
export interface ExpertKnowledgeSource {
    searchWithDiagnostics(query: string, limit: number, signal: AbortSignal): Promise<{
        sources: ExpertSource[];
        warnings: string[];
    }>;
}
export type ExpertKnowledgeFactory = (expert: ExpertConfig) => ExpertKnowledgeSource;
export class FileExpertDefinitionSource implements ExpertDefinitionSource {
    private cached: {
        version: string;
        config: ExpertPanelConfig;
    } | undefined;
    async snapshot(signal?: AbortSignal) { signal?.throwIfAborted(); const configPath = expertConfigPath(); const raw = await readFile(configPath, 'utf8'); const version = createHash('sha256').update(raw).digest('hex'); if (this.cached?.version === version)
        return this.cached; const config = await loadExpertConfig({ configPath, text: raw }); signal?.throwIfAborted(); this.cached = { version, config }; return this.cached; }
}
export const fileExpertKnowledge: ExpertKnowledgeFactory = expert => new FileExpertKnowledge(expert);
export interface ExpertRagSearch {
    searchCurrent(query: string, limit: number, signal: AbortSignal): Promise<Array<{
        chunkId: string;
        path: string;
        text: string;
        score: number;
        documentVersionId?: string;
    }>>;
}
/** RAG supplies immutable passage IDs; configured expert roots still constrain accessible evidence. */
export class RagExpertKnowledge implements ExpertKnowledgeSource {
    private readonly expert: ExpertConfig;
    private readonly resolve: () => ExpertRagSearch | undefined;
    constructor(expert: ExpertConfig, resolve: () => ExpertRagSearch | undefined) { this.expert = expert; this.resolve = resolve; }
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
