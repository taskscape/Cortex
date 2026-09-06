import type { RagV2RankedHit } from '../v2/types.js';
/** Response payload returned by an HTTP reranker service. */
export interface RerankResponse {
    model?: string;
    /** Relevance score per input hit, aligned by index with the hits passed to the reranker. */
    scores: number[];
}
/** Scores a query against candidate hits by delegating to a remote reranker. */
export type RagV2Reranker = (query: string, hits: readonly RagV2RankedHit[], signal?: AbortSignal) => Promise<RerankResponse>;
/**
 * Calls a reranker service's /rerank endpoint with the query and hit texts
 * (truncation requested) under a 5-second timeout combined with the caller's
 * signal, then normalizes the response. Two shapes are accepted: an array of
 * `{index, score}` items (missing or invalid entries are left as 0) or an
 * object with a finite `scores` array whose length matches `hits`.
 *
 * @param url - Reranker service base URL; "/rerank" is appended.
 * @param query - Search query the hits are scored against.
 * @param hits - Candidate hits; only their `text` fields are sent.
 * @param callerSignal - Optional abort signal; also aborted after 5000 ms.
 * @returns The reporting model name when present, plus one score per hit in hit order.
 * @throws {Error} When the HTTP status is not ok or the response shape is unsupported.
 * @throws {TypeError} When the network request fails.
 * @throws {DOMException} "AbortError" when the caller aborts or the timeout elapses.
 */
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
/**
 * Binds a reranker endpoint into a reusable {@link RagV2Reranker}.
 *
 * @param url - Reranker service base URL forwarded to {@link rerankHttp}.
 * @returns A reranker that scores queries against hits via the configured service.
 * @throws Never.
 */
export function createHttpReranker(url: string): RagV2Reranker { return (query, hits, signal) => rerankHttp(url, query, hits, signal); }
