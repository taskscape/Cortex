import type {} from '@matatbread/matbot-capabilities-types';
import type {} from '@matatbread/matbot-workspace-manager-types';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, KnowledgeEntry, Store } from '@matatbread/matbot-plugin-api';
import { PersistBGEKnowledgeIndex } from './knowledge-index.js';

/**
 * Build the persist-ki-bge plugin spec. On setup it creates a `knowledge` store and registers
 * {@link PersistBGEKnowledgeIndex} as the machine's `KnowledgeIndex`, replacing the default.
 */
export function createPersistKIBGEPlugin(): MatbotPluginSpec {
  return {
    apiVersion: PLUGIN_API_VERSION,

    async installationMessage() {
      return 'Persistent knowledge index is active. It can optionally use a Cloudflare ' +
        'BGE reranker for sharper semantic search; without it, search falls back to ' +
        'entity- and heading-based scoring. To enable the reranker, store two secrets ' +
        'with the `plugin` tool (action "store-key"): CLOUDFLARE_ACCOUNT_ID and ' +
        'SKILL_RANK_API_KEY. Offer to do this now, but it is optional.';
    },

    async setup(services) {
      const store = services.createStore<KnowledgeEntry>('knowledge') as Store<KnowledgeEntry>;
      if (services.MemoryWriteSink) throw new Error('A memory write sink is already selected; unload it before selecting persist-ki-bge');
      const index = new PersistBGEKnowledgeIndex(store, services.Vault);
      const workspaceId = services.WorkspaceContext?.id ?? 'default';
      await services.register('MemoryWriteSink', { async index(entry, signal) { signal?.throwIfAborted(); await index.index(entry); } });
      services.contributions?.register('retrieval', 'persistent-memory', {
        title: 'Persistent memories', scope: 'workspace',
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
