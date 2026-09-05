import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-file-services-types';
export function createFileIndexClientPlugin(): MatbotPluginSpec {
    const lifetime = new AbortController();
    return { apiVersion: PLUGIN_API_VERSION, async setup(services) {
            if (services.FileIndex)
                throw new Error('FileIndex already has an owner');
            const base = process.env.FILE_INDEX_BASE_URL ?? 'http://localhost:8877';
            const request = async (route: string, body?: unknown, caller?: AbortSignal) => { const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120000), ...(caller ? [caller] : [])]); const response = await fetch(new URL(route, base), { method: body === undefined ? 'GET' : 'POST', signal, headers: { 'content-type': 'application/json', ...(process.env.CORTEX_FILE_INDEX_TOKEN ? { 'x-cortex-token': process.env.CORTEX_FILE_INDEX_TOKEN } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok)
                throw new Error('File index HTTP ' + response.status); return response.json(); };
            await services.register('FileIndex', { health: () => request('/health'), index: (root, signal) => request('/index', root ? { root } : {}, signal), search: (query, limit, signal) => request('/search', { query, limit }, signal), cancel: async (id) => await request('/cancel', id ? { id } : {}) as {
                    cancelled: number;
                } });
        }, async teardown() { lifetime.abort(); } };
}
export const plugin = createFileIndexClientPlugin();
