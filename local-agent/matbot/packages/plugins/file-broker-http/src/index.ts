import { createFileBrokerServer } from '@local-agent/file-broker/http';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-file-services-types';
export function createHttpPlugin(): MatbotPluginSpec {
    let server: ReturnType<typeof createFileBrokerServer> | undefined;
    return { apiVersion: PLUGIN_API_VERSION, async setup(services) {
            const resolve = () => { const service = services.HostFileAccess; if (!service)
                throw new Error('HostFileAccess unavailable'); return service; };
            resolve();
            const backend = { health: (...args: Parameters<NonNullable<typeof services.HostFileAccess>['health']>) => resolve().health(...args), list: (...args: Parameters<NonNullable<typeof services.HostFileAccess>['list']>) => resolve().list(...args), read: (...args: Parameters<NonNullable<typeof services.HostFileAccess>['read']>) => resolve().read(...args), write: (...args: Parameters<NonNullable<typeof services.HostFileAccess>['write']>) => resolve().write(...args) };
            server = createFileBrokerServer(backend, process.env.CORTEX_FILE_BROKER_TOKEN);
            await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(Number(process.env.FILE_BROKER_PORT ?? 8878), '127.0.0.1', resolve); });
        }, async teardown() { if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
            server = undefined;
        } } };
}
export const plugin = createHttpPlugin();
