import { createFileIndexServer } from '@local-agent/file-index/http';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-file-services-types';
/**
 * Build the plugin that exposes the `FileIndex` service over HTTP via
 * {@link createFileIndexServer}, bound to `127.0.0.1` on `FILE_INDEX_PORT` (default 8877) and
 * optionally protected by `CORTEX_FILE_INDEX_TOKEN`.
 *
 * @returns The plugin spec.
 * @throws Never - Service and listen failures surface in `setup`.
 */
export function createHttpPlugin(): MatbotPluginSpec {
    let server: ReturnType<typeof createFileIndexServer> | undefined;
    return { apiVersion: PLUGIN_API_VERSION, /**
     * Build the delegating backend over the live `FileIndex` service and start the index server.
     * The backend re-resolves the service on every call, so unloading the owning plugin is
     * noticed immediately.
     *
     * @param services - Machine services; `FileIndex` must be present.
     * @returns Nothing.
     * @throws Error - If `FileIndex` is unavailable, or the server emits `error` or fails to
     *           listen.
     */
    async setup(services) {
            /**
             * Resolve the live `FileIndex` service, re-checked on every delegated call so
             * unloading the owning plugin is noticed immediately.
             *
             * @returns The current `FileIndex` service.
             * @throws Error - If the service is unavailable.
             */
            const resolve = () => { const service = services.FileIndex; if (!service)
                throw new Error('FileIndex unavailable'); return service; };
            resolve();
            const backend = { health: (...args: Parameters<NonNullable<typeof services.FileIndex>['health']>) => resolve().health(...args), index: (...args: Parameters<NonNullable<typeof services.FileIndex>['index']>) => resolve().index(...args), search: (...args: Parameters<NonNullable<typeof services.FileIndex>['search']>) => resolve().search(...args), cancel: (...args: Parameters<NonNullable<typeof services.FileIndex>['cancel']>) => resolve().cancel(...args) };
            server = createFileIndexServer(backend, process.env.CORTEX_FILE_INDEX_TOKEN);
            await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(Number(process.env.FILE_INDEX_PORT ?? 8877), '127.0.0.1', resolve); });
        }, /**
     * Close all open connections, then stop the server.
     *
     * @returns Nothing.
     * @throws Error - If the server reports an error while closing.
     */
    async teardown() { if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
            server = undefined;
        } } };
}
export const plugin = createHttpPlugin();
