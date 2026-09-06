import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-file-services-types';
/**
 * Build the plugin that registers an HTTP client implementation of the `FileIndex` service,
 * backed by a remote file-index server at `FILE_INDEX_BASE_URL` (default `http://localhost:8877`).
 *
 * Every request combines the plugin-lifetime abort signal, a 120 s timeout, and any
 * caller-provided signal, and carries an `x-cortex-token` header when `CORTEX_FILE_INDEX_TOKEN`
 * is set. `teardown` aborts the lifetime signal, failing in-flight requests.
 *
 * @returns The plugin spec.
 * @throws Never - Ownership conflicts surface in `setup`; request failures surface per call.
 */
export function createFileIndexClientPlugin(): MatbotPluginSpec {
    const lifetime = new AbortController();
    return { apiVersion: PLUGIN_API_VERSION, /**
     * Register the HTTP-backed `FileIndex` service adapter.
     *
     * @param services - Machine services; checked for an existing `FileIndex` owner and used to
     *          register the adapter.
     * @returns Nothing.
     * @throws Error - If `FileIndex` already has an owner.
     */
    async setup(services) {
            if (services.FileIndex)
                throw new Error('FileIndex already has an owner');
            const base = process.env.FILE_INDEX_BASE_URL ?? 'http://localhost:8877';
            /**
             * Perform one JSON request against the file-index server.
             *
             * @param route - Path relative to the base URL (e.g. `/search`).
             * @param body - JSON request payload; `undefined` selects GET, any other value POST.
             * @param caller - Optional extra abort signal, combined with the lifetime signal and
             *          the 120 s timeout.
             * @returns The parsed JSON response body.
             * @throws Error - On fetch failure (including timeout or abort) or a non-OK HTTP status.
             */
            const request = async (route: string, body?: unknown, caller?: AbortSignal) => { const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120000), ...(caller ? [caller] : [])]); const response = await fetch(new URL(route, base), { method: body === undefined ? 'GET' : 'POST', signal, headers: { 'content-type': 'application/json', ...(process.env.CORTEX_FILE_INDEX_TOKEN ? { 'x-cortex-token': process.env.CORTEX_FILE_INDEX_TOKEN } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok)
                throw new Error('File index HTTP ' + response.status); return response.json(); };
            await services.register('FileIndex', { health: () => request('/health'), index: (root, signal) => request('/index', root ? { root } : {}, signal), search: (query, limit, signal) => request('/search', { query, limit }, signal), cancel: async (id) => await request('/cancel', id ? { id } : {}) as {
                    cancelled: number;
                } });
        }, /**
     * Abort the plugin-lifetime signal, failing any in-flight index requests.
     *
     * @returns Nothing.
     * @throws Never.
     */
    async teardown() { lifetime.abort(); } };
}
export const plugin = createFileIndexClientPlugin();
