import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, KnowledgeEntry } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-capabilities-types';
import type {} from '@matatbread/matbot-workspace-manager-types';
import { LookupKnowledgeIndex } from '@matatbread/matbot-knowledge';
/**
 * Explicit local memory destination for deployments without a remote memory backend.
 *
 * On setup it claims the `MemoryWriteSink` service (failing if another sink is
 * already selected), persisting written knowledge entries into the local
 * `memory_knowledge` store; registers a workspace-scoped `retrieval` source
 * that scans the store through a fresh in-memory term-frequency index per
 * query; and registers a `health` probe that performs a minimal store query.
 * Teardown aborts the plugin lifetime, after which store writes and searches
 * are rejected.
 *
 * @returns The matbot plugin specification.
 * @throws Never - the factory only builds the spec; `setup` raises errors.
 */
export function createLocalMemoryPlugin(): MatbotPluginSpec {
    const lifetime = new AbortController();
    return { apiVersion: PLUGIN_API_VERSION, /**
             * Registers the write sink, retrieval source, and health probe described on
             * {@link createLocalMemoryPlugin}.
             *
             * @param services - Machine services; must not already have a `MemoryWriteSink`.
             * @throws Error - If a `MemoryWriteSink` is already selected by another plugin.
             */
            async setup(services) {
            if (services.MemoryWriteSink)
                throw new Error('A memory write sink is already selected');
            const store = services.createStore<KnowledgeEntry>('memory_knowledge');
            const workspaceId = services.WorkspaceContext?.id ?? 'default';
            /**
             * Persists one knowledge entry into the local `memory_knowledge`
             * store, rejecting after plugin teardown or caller abort.
             * @param entry - Knowledge entry to persist; keyed by its `id`.
             * @param signal - Optional caller abort signal.
             * @throws Error (via `throwIfAborted`) - If the plugin lifetime or the
             *   caller's signal is already aborted.
             */
            await services.register('MemoryWriteSink', { async index(entry, signal) { lifetime.signal.throwIfAborted(); signal?.throwIfAborted(); await store.set(entry.id, entry); } });
            /**
             * Searches local memories: pages the whole `memory_knowledge`
             * store into a fresh in-memory term-frequency index per call, then
             * runs a term search. Only meaningful for this plugin's own
             * workspace.
             *
             * @param query - Retrieval parameters: terms, limit, workspace id,
             *   principal, and abort signal.
             * @returns Hits built from the matched knowledge entries, truncated
             *   to `query.limit`, each citing the entry's `source`.
             * @throws Error - If `query.workspaceId` differs from this plugin's
             *   workspace, or (via `throwIfAborted`) if the query or plugin
             *   lifetime signal is aborted.
             */
            services.contributions?.register('retrieval', 'local-memory', { title: 'Local memories', scope: 'workspace', async search(query) { if (query.workspaceId !== workspaceId)
                    throw new Error('Local memory workspace mismatch'); const index = new LookupKnowledgeIndex(); let cursor: string | undefined; do {
                    query.signal.throwIfAborted();
                    lifetime.signal.throwIfAborted();
                    const page = await store.query({ limit: 500, ...(cursor ? { cursor } : {}) });
                    for (const entry of page.items)
                        await index.index(entry);
                    cursor = page.cursor;
                } while (cursor); const entries = await index.search([{ term: query.query }], query.signal); return entries.slice(0, query.limit).map(knowledge => ({ id: knowledge.id, sourceId: 'local-memory', workspaceId, content: knowledge.content, knowledge, citation: knowledge.source })); } });
            /**
             * Health probe: verifies the store answers a minimal query.
             * @param signal - Probe abort signal; aborting fails the probe.
             * @returns `ready` status when the store responds.
             */
            services.contributions?.register('health', 'local-memory', { async probe(signal) { signal.throwIfAborted(); await store.query({ limit: 1 }); return { state: 'ready' }; } });
        }, /**
             * Aborts the plugin lifetime, rejecting subsequent index writes and
             * searches that check the signal.
             */
            async teardown() { lifetime.abort(); } };
}
export const plugin = createLocalMemoryPlugin();
