import type {} from '@matatbread/matbot-capabilities-types';
import type {} from '@matatbread/matbot-workspace-manager-types';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, KnowledgeEntry, Store } from '@matatbread/matbot-plugin-api';
import { PersistBGEKnowledgeIndex } from './knowledge-index.js';

/**
 * Build the persist-ki-bge plugin spec. On setup it creates a `knowledge` store and registers
 * {@link PersistBGEKnowledgeIndex} as the machine's `KnowledgeIndex`, replacing the default.
 * It also claims the `MemoryWriteSink` service (routing writes into the index) and registers
 * a workspace-scoped `persistent-memory` retrieval source; the `KnowledgeIndex` swap is
 * skipped when a retrieval federation is present.
 *
 * @returns The matbot plugin specification.
 * @throws Never - the factory only builds the spec; `setup` raises errors.
 */
export function createPersistKIBGEPlugin(): MatbotPluginSpec {
  return {
    apiVersion: PLUGIN_API_VERSION,

    /**
     * Installation guidance: announces the active index and how to enable the
     * optional Cloudflare BGE reranker via stored secrets.
     * @returns A human-readable installation message.
     */
    async installationMessage() {
      return 'Persistent knowledge index is active. It can optionally use a Cloudflare ' +
        'BGE reranker for sharper semantic search; without it, search falls back to ' +
        'entity- and heading-based scoring. To enable the reranker, store two secrets ' +
        'with the `plugin` tool (action "store-key"): CLOUDFLARE_ACCOUNT_ID and ' +
        'SKILL_RANK_API_KEY. Offer to do this now, but it is optional.';
    },

    /**
     * Brings the persistent index online: creates the `knowledge` store,
     * claims the `MemoryWriteSink`, registers the `persistent-memory`
     * retrieval source, and swaps the machine `KnowledgeIndex` unless a
     * `RetrievalFederation` service is already selected.
     *
     * @param services - Machine services; `MemoryWriteSink` must be unclaimed.
     * @throws Error - If a `MemoryWriteSink` is already selected by another plugin.
     */
    async setup(services) {
      const store = services.createStore<KnowledgeEntry>('knowledge') as Store<KnowledgeEntry>;
      if (services.MemoryWriteSink) throw new Error('A memory write sink is already selected; unload it before selecting persist-ki-bge');
      const index = new PersistBGEKnowledgeIndex(store, services.Vault);
      const workspaceId = services.WorkspaceContext?.id ?? 'default';
      /**
       * Persists one knowledge entry into the index, rejecting when the
       * caller's signal is already aborted.
       * @param entry - Knowledge entry to index.
       * @param signal - Optional caller abort signal.
       * @throws Error - If the caller's signal is aborted or the index write fails.
       */
      await services.register('MemoryWriteSink', { async index(entry, signal) { signal?.throwIfAborted(); await index.index(entry); } });
      services.contributions?.register('retrieval', 'persistent-memory', {
        title: 'Persistent memories', scope: 'workspace',
        /**
         * Searches the persistent index for this plugin's workspace. Search
         * may hit the Cloudflare BGE reranker over the network (see
         * {@link PersistBGEKnowledgeIndex.search}); failures degrade to local
         * ranking rather than failing the query.
         *
         * @param query - Retrieval parameters: terms, limit, workspace id,
         *   principal, and abort signal.
         * @returns Hits built from the matched knowledge entries, truncated to
         *   `query.limit`, each citing the entry's source.
         * @throws Error - If `query.workspaceId` differs from this plugin's
         *   workspace, or the underlying index search throws.
         */
        async search(query) {
          if (query.workspaceId !== workspaceId) throw new Error('Persistent memory workspace mismatch');
          const entries = await index.search([{ term: query.query }], query.signal);
          return entries.slice(0, query.limit).map(knowledge => ({ id: knowledge.id, sourceId: 'persistent-memory', workspaceId, content: knowledge.content, knowledge, citation: knowledge.source }));
        },
      });
      // The legacy minimal host can still consume this backend directly. A federation,
      // when selected, remains the sole KnowledgeIndex owner and uses the contribution.
      if (!services.RetrievalFederation) await services.register('KnowledgeIndex', index);
    },
  };
}

/** The default plugin instance produced by {@link createPersistKIBGEPlugin}. */
export const plugin: MatbotPluginSpec = createPersistKIBGEPlugin();
