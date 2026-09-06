import { createFileBrokerServer } from '@local-agent/file-broker/http';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-file-services-types';
/**
 * Build the plugin that exposes the `HostFileAccess` service over HTTP via
 * {@link createFileBrokerServer}, bound to `127.0.0.1` on `FILE_BROKER_PORT` (default 8878) and
 * optionally protected by `CORTEX_FILE_BROKER_TOKEN`.
 *
 * @returns The plugin spec.
 * @throws Never - Service and listen failures surface in `setup`.
 */
export function createHttpPlugin(): MatbotPluginSpec {
    let server: ReturnType<typeof createFileBrokerServer> | undefined;
    return { apiVersion: PLUGIN_API_VERSION, /**
     * Build the delegating backend over the live `HostFileAccess` service and start the broker
     * server. The backend re-resolves the service on every call, so unloading the owning plugin
     * is noticed immediately.
     *
     * @param services - Machine services; `HostFileAccess` must be present.
     * @returns Nothing.
     * @throws Error - If `HostFileAccess` is unavailable, or the server emits `error` or fails to
     *           listen.
     */
    async setup(services) {
            /**
             * Resolve the live `HostFileAccess` service, re-checked on every delegated call so
             * unloading the owning plugin is noticed immediately.
             *
             * @returns The current `HostFileAccess` service.
             * @throws Error - If the service is unavailable.
             */
            const resolve = () => { const service = services.HostFileAccess; if (!service)
                throw new Error('HostFileAccess unavailable'); return service; };
            resolve();
            const backend = { health: (...args: Parameters<NonNullable<typeof services.HostFileAccess>['health']>) => resolve().health(...args), list: (...args: Parameters<NonNullable<typeof services.HostFileAccess>['list']>) => resolve().list(...args), read: (...args: Parameters<NonNullable<typeof services.HostFileAccess>['read']>) => resolve().read(...args), write: (...args: Parameters<NonNullable<typeof services.HostFileAccess>['write']>) => resolve().write(...args) };
            server = createFileBrokerServer(backend, process.env.CORTEX_FILE_BROKER_TOKEN);
            await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(Number(process.env.FILE_BROKER_PORT ?? 8878), '127.0.0.1', resolve); });
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
