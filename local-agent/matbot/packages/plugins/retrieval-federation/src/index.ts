import { PLUGIN_API_VERSION, currentPrincipal } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, KnowledgeEntry } from '@matatbread/matbot-plugin-api';
import type { RetrievalFederation, RetrievalQuery, RetrievalResult, RetrievalHit } from '@matatbread/matbot-capabilities-types';
import type {} from '@matatbread/matbot-workspace-manager-types';
/**
 * The federation runtime: fans one query out to every registered `retrieval`
 * contribution in parallel (each bounded by a 5s timeout and per-source
 * signals), filters hits to the queried workspace, and merges results with
 * reciprocal rank fusion (rank-based scores, so heterogeneous engines compare
 * fairly). Per-source failures are isolated and reported rather than failing
 * the whole query. The most recent aggregate is kept in `lastResult` for the
 * health probe.
 */
export class FederatedRetrieval implements RetrievalFederation {
    private readonly services: MatbotMachine;
    private closed = false;
    private lifetime = new AbortController();
    lastResult: RetrievalResult | undefined;
    /**
     * Creates the federation over the machine's contribution registry.
     * @param services - Machine services; `contributions` must provide `retrieval` rows.
     */
    constructor(services: MatbotMachine) { this.services = services; }
    /**
     * Marks the federation closed: in-flight searches are aborted via the
     * lifetime signal, `lastResult` is cleared, and later searches throw.
     */
    close() { this.closed = true; this.lastResult = undefined; this.lifetime.abort(); }
    /**
     * Runs one federated search. Clamps `limit` to 1–50 (default 12), checks
     * the workspace against the active runtime, and dispatches to all
     * registered retrieval sources concurrently. Individual source failures
     * (timeouts, aborts, errors) become `unavailable` entries in
     * `sources` and set `partial`; the query's own signal is honored between
     * phases.
     *
     * @param query - Retrieval parameters; `workspaceId` must match the active
     *   workspace and `signal` aborts the whole search.
     * @returns The fused result: deduplicated hits sorted by descending RRF
     *   score (ties broken by hit id), per-source status with hit counts, and
     *   the `partial` flag.
     * @throws Error - If the federation is closed, `query.workspaceId` does not
     *   match the active runtime, or (via `throwIfAborted`) the query signal is
     *   aborted.
     */
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
/**
 * Builds the retrieval-federation plugin. On setup it claims the
 * `RetrievalFederation` service with a {@link FederatedRetrieval} runtime and
 * also takes over the machine `KnowledgeIndex`, routing indexing to the
 * selected `MemoryWriteSink` and searches through the federation. Registers a
 * `retrieval` health probe reporting degradation from the last federated
 * result. Teardown closes the runtime and releases the owner.
 *
 * @returns The matbot plugin specification.
 * @throws Never - the factory only builds the spec; `setup` raises errors.
 */
export function createRetrievalFederationPlugin(): MatbotPluginSpec {
    let owner: FederatedRetrieval | undefined;
    return { apiVersion: PLUGIN_API_VERSION, /**
             * Registers the federation runtime, the bridging `KnowledgeIndex`,
             * and the health probe described on
             * {@link createRetrievalFederationPlugin}.
             *
             * @param services - Machine services; requires the contribution
             *   registry and an unclaimed `RetrievalFederation`.
             * @throws Error - If the machine has no contribution registry or a
             *   `RetrievalFederation` is already selected.
             */
            async setup(services) {
            if (!services.contributions)
                throw new Error('Retrieval federation requires contribution registry');
            if (services.RetrievalFederation)
                throw new Error('Retrieval federation already has an owner');
            owner = new FederatedRetrieval(services);
            const runtime = owner;
            await services.register('RetrievalFederation', runtime);
            await services.register('KnowledgeIndex', {
                /**
                 * Routes one knowledge entry to the machine's selected
                 * `MemoryWriteSink`.
                 * @param entry - Knowledge entry to persist.
                 * @throws Error - If no memory write sink is currently selected.
                 */
                async index(entry: KnowledgeEntry) { const sink = services.MemoryWriteSink; if (!sink)
                    throw new Error('No memory write sink selected'); await sink.index(entry); },
                /**
                 * Searches the federation: terms (with optional context) are
                 * joined into a single query string, run under the ambient
                 * principal, and mapped back to knowledge entries. Hits
                 * without a full knowledge entry are synthesized with
                 * epoch timestamps and the source id as tag/type.
                 *
                 * @param terms - Search terms with optional context strings.
                 * @param signal - Abort signal forwarded to the federation.
                 * @returns Knowledge entries for the fused hits, best first.
                 * @throws Error - Under the same conditions as
                 *   {@link FederatedRetrieval.search} (closed, workspace
                 *   mismatch, aborted).
                 */
                async search(terms, signal) { const result = await runtime.search({ query: terms.map(t => t.context ? t.term + ': ' + t.context : t.term).join('\n'), limit: 12, workspaceId: services.WorkspaceContext?.id ?? 'default', principal: currentPrincipal(), signal }); return result.hits.map(hit => hit.knowledge ?? ({ id: hit.sourceId + ':' + hit.id, version: hit.id, entities: [], tags: [hit.sourceId], summary: hit.content.slice(0, 200), content: hit.content, source: { type: hit.sourceId, uuid: hit.id }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() })); },
            });
            /**
             * Health probe: `degraded` when the last federated search was
             * partial, otherwise `ready`; details carry the per-source states.
             * Before any search has run it reports `ready`.
             */
            services.contributions.register('health', 'retrieval', { async probe() { return { state: runtime.lastResult?.partial ? 'degraded' : 'ready', details: runtime.lastResult?.sources ?? [] }; } });
        }, /**
             * Closes the owning {@link FederatedRetrieval} and releases it, so
             * the registered services no longer resolve to this plugin's owner.
             */
            async teardown() { owner?.close(); owner = undefined; } };
}
export const plugin = createRetrievalFederationPlugin();
