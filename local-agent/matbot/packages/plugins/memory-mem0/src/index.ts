import path from 'node:path';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-capabilities-types';
import type {} from '@matatbread/matbot-workspace-manager-types';
import { Mem0Client } from './mem0-client.js';
export { Mem0Client };
export function workspaceIdFromConfigPath(configPath: string | undefined) { if (!configPath)
    return 'default'; const dir = path.dirname(path.resolve(configPath)); return path.basename(path.dirname(dir)).toLowerCase() === 'workspaces' ? path.basename(dir) : 'default'; }
export const workspaceScopedMem0UserId = (base: string, workspace: string) => base + ':workspace:' + workspace;
export function createMem0Plugin(): MatbotPluginSpec {
    let lifetime = new AbortController();
    return { apiVersion: PLUGIN_API_VERSION, async setup(services) {
            lifetime = new AbortController();
            if (services.MemoryWriteSink)
                throw new Error('A memory write sink is already selected');
            const workspaceId = services.WorkspaceContext?.id ?? workspaceIdFromConfigPath(services.configPath);
            const client = new Mem0Client({ baseUrl: process.env.MEM0_BASE_URL ?? 'http://localhost:8888', ...(process.env.MEM0_API_KEY !== undefined ? { apiKey: process.env.MEM0_API_KEY } : {}), userId: workspaceScopedMem0UserId(process.env.MEM0_USER_ID ?? 'local-agent', workspaceId), workspaceId });
            await services.register('MemoryWriteSink', { index: (entry, signal) => client.add(entry, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])])) });
            services.contributions?.register('retrieval', 'mem0', { title: 'Mem0 memories', scope: 'workspace', async search(query) { if (query.workspaceId !== workspaceId)
                    throw new Error('Mem0 workspace mismatch'); const entries = await client.search(query.query, AbortSignal.any([lifetime.signal, query.signal])); return entries.slice(0, query.limit).map(knowledge => ({ id: knowledge.id, sourceId: 'mem0', workspaceId, content: knowledge.content, knowledge, citation: knowledge.source })); } });
            services.contributions?.register('health', 'mem0', { async probe(signal) { await client.search('__cortex_health_probe__', signal); return { state: 'ready' }; } });
        }, async teardown() { lifetime.abort(); } };
}
export const plugin = createMem0Plugin();
