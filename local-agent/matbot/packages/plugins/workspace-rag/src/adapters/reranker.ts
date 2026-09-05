import type { RagV2RankedHit } from '../v2/types.js';
export interface RerankResponse {
    model?: string;
    scores: number[];
}
export type RagV2Reranker = (query: string, hits: readonly RagV2RankedHit[], signal?: AbortSignal) => Promise<RerankResponse>;
export async function rerankHttp(url: string, query: string, hits: readonly RagV2RankedHit[], callerSignal?: AbortSignal): Promise<RerankResponse> {
    const timeout = AbortSignal.timeout(5000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const response = await fetch(new URL('/rerank', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, texts: hits.map(hit => hit.text), truncate: true }),
        signal,
    });
    if (!response.ok)
        throw new Error(`Workspace RAG V2 reranker returned HTTP ${response.status}.`);
    const body = await response.json() as unknown;
    if (Array.isArray(body)) {
        const scores = new Array<number>(hits.length).fill(0);
        for (const value of body) {
            if (!value || typeof value !== 'object')
                continue;
            const item = value as Record<string, unknown>;
            const index = Number(item['index']);
            const score = Number(item['score']);
            if (Number.isInteger(index) && index >= 0 && index < scores.length && Number.isFinite(score))
                scores[index] = score;
        }
        return { scores };
    }
    if (body && typeof body === 'object') {
        const value = body as Record<string, unknown>;
        const scores = Array.isArray(value['scores']) ? value['scores'].map(Number) : [];
        if (scores.length === hits.length && scores.every(Number.isFinite)) {
            return {
                ...(typeof value['model'] === 'string' ? { model: value['model'] } : {}),
                scores,
            };
        }
    }
    throw new Error('Workspace RAG V2 reranker returned an unsupported response.');
}
export function createHttpReranker(url: string): RagV2Reranker { return (query, hits, signal) => rerankHttp(url, query, hits, signal); }
