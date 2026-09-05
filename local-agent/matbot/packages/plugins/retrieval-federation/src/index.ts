import { PLUGIN_API_VERSION, currentPrincipal } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, KnowledgeEntry } from '@matatbread/matbot-plugin-api';
import type { RetrievalFederation, RetrievalQuery, RetrievalResult, RetrievalHit } from '@matatbread/matbot-capabilities-types';
import type {} from '@matatbread/matbot-workspace-manager-types';
export class FederatedRetrieval implements RetrievalFederation {
    private readonly services: MatbotMachine;
    private closed = false;
    private lifetime = new AbortController();
    lastResult: RetrievalResult | undefined;
    constructor(services: MatbotMachine) { this.services = services; }
    close() { this.closed = true; this.lastResult = undefined; this.lifetime.abort(); }
    async search(query: RetrievalQuery): Promise<RetrievalResult> {
        if (this.closed)
            throw new Error('Retrieval federation unloaded');
        query.signal.throwIfAborted();
        const active = this.services.WorkspaceContext?.id ?? 'default';
        if (query.workspaceId !== active)
            throw new Error('Retrieval workspace does not match active runtime');
        const limit = Math.min(Math.max(Math.floor(query.limit) || 12, 1), 50);
        const rows = this.services.contributions?.list('retrieval') ?? [];
        const responses = await Promise.all(rows.map(async (row) => {
            const timeout = AbortSignal.timeout(5000);
            const signal = AbortSignal.any([query.signal, row.signal, this.lifetime.signal, timeout]);
            try {
                const hits = await Promise.race([row.value.search({ ...query, limit, signal }), new Promise<RetrievalHit[]>((_, reject) => { if (signal.aborted)
                        reject(signal.reason);
                    else
                        signal.addEventListener('abort', () => reject(signal.reason), { once: true }); })]);
                signal.throwIfAborted();
                return { row, hits: hits.filter(h => h.workspaceId === query.workspaceId).slice(0, limit) };
            }
            catch (error) {
                query.signal.throwIfAborted();
                return { row, hits: [] as RetrievalHit[], error: String(error) };
            }
        }));
        query.signal.throwIfAborted();
        if (this.closed)
            throw new Error('Retrieval federation unloaded');
        // Reciprocal rank fusion compares ranks, never engine-specific confidence values.
        const ranked = new Map<string, {
            hit: RetrievalHit;
            score: number;
        }>();
        for (const response of responses)
            response.hits.forEach((hit, index) => { const key = hit.workspaceId + ':' + hit.sourceId + ':' + hit.id; const existing = ranked.get(key); const score = 1 / (60 + index + 1); if (existing)
                existing.score += score;
            else
                ranked.set(key, { hit, score }); });
        const result = { hits: [...ranked.values()].sort((a, c) => c.score - a.score || a.hit.id.localeCompare(c.hit.id)).slice(0, limit).map(row => row.hit), sources: responses.map(({ row, hits, error }) => ({ id: row.id, state: error ? 'unavailable' as const : 'ready' as const, count: hits.length, ...(error ? { error } : {}) })), partial: responses.some(r => r.error !== undefined) };
        this.lastResult = result;
        return result;
    }
}
export function createRetrievalFederationPlugin(): MatbotPluginSpec {
    let owner: FederatedRetrieval | undefined;
    return { apiVersion: PLUGIN_API_VERSION, async setup(services) {
            if (!services.contributions)
                throw new Error('Retrieval federation requires contribution registry');
            if (services.RetrievalFederation)
                throw new Error('Retrieval federation already has an owner');
            owner = new FederatedRetrieval(services);
            const runtime = owner;
            await services.register('RetrievalFederation', runtime);
            await services.register('KnowledgeIndex', {
                async index(entry: KnowledgeEntry) { const sink = services.MemoryWriteSink; if (!sink)
                    throw new Error('No memory write sink selected'); await sink.index(entry); },
                async search(terms, signal) { const result = await runtime.search({ query: terms.map(t => t.context ? t.term + ': ' + t.context : t.term).join('\n'), limit: 12, workspaceId: services.WorkspaceContext?.id ?? 'default', principal: currentPrincipal(), signal }); return result.hits.map(hit => hit.knowledge ?? ({ id: hit.sourceId + ':' + hit.id, version: hit.id, entities: [], tags: [hit.sourceId], summary: hit.content.slice(0, 200), content: hit.content, source: { type: hit.sourceId, uuid: hit.id }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() })); },
            });
            services.contributions.register('health', 'retrieval', { async probe() { return { state: runtime.lastResult?.partial ? 'degraded' : 'ready', details: runtime.lastResult?.sources ?? [] }; } });
        }, async teardown() { owner?.close(); owner = undefined; } };
}
export const plugin = createRetrievalFederationPlugin();
