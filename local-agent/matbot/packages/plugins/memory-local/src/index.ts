import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, KnowledgeEntry } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-capabilities-types';
import type {} from '@matatbread/matbot-workspace-manager-types';
import { LookupKnowledgeIndex } from '@matatbread/matbot-knowledge';
/** Explicit local memory destination for deployments without a remote memory backend. */
export function createLocalMemoryPlugin(): MatbotPluginSpec {
    const lifetime = new AbortController();
    return { apiVersion: PLUGIN_API_VERSION, async setup(services) {
            if (services.MemoryWriteSink)
                throw new Error('A memory write sink is already selected');
            const store = services.createStore<KnowledgeEntry>('memory_knowledge');
            const workspaceId = services.WorkspaceContext?.id ?? 'default';
            await services.register('MemoryWriteSink', { async index(entry, signal) { lifetime.signal.throwIfAborted(); signal?.throwIfAborted(); await store.set(entry.id, entry); } });
            services.contributions?.register('retrieval', 'local-memory', { title: 'Local memories', scope: 'workspace', async search(query) { if (query.workspaceId !== workspaceId)
                    throw new Error('Local memory workspace mismatch'); const index = new LookupKnowledgeIndex(); let cursor: string | undefined; do {
                    query.signal.throwIfAborted();
                    lifetime.signal.throwIfAborted();
                    const page = await store.query({ limit: 500, ...(cursor ? { cursor } : {}) });
                    for (const entry of page.items)
                        await index.index(entry);
                    cursor = page.cursor;
                } while (cursor); const entries = await index.search([{ term: query.query }], query.signal); return entries.slice(0, query.limit).map(knowledge => ({ id: knowledge.id, sourceId: 'local-memory', workspaceId, content: knowledge.content, knowledge, citation: knowledge.source })); } });
            services.contributions?.register('health', 'local-memory', { async probe(signal) { signal.throwIfAborted(); await store.query({ limit: 1 }); return { state: 'ready' }; } });
        }, async teardown() { lifetime.abort(); } };
}
export const plugin = createLocalMemoryPlugin();
