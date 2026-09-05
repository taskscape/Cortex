import { createFileIndexServer } from '@local-agent/file-index/http';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-file-services-types';
export function createHttpPlugin(): MatbotPluginSpec {
    let server: ReturnType<typeof createFileIndexServer> | undefined;
    return { apiVersion: PLUGIN_API_VERSION, async setup(services) {
            const resolve = () => { const service = services.FileIndex; if (!service)
                throw new Error('FileIndex unavailable'); return service; };
            resolve();
            const backend = { health: (...args: Parameters<NonNullable<typeof services.FileIndex>['health']>) => resolve().health(...args), index: (...args: Parameters<NonNullable<typeof services.FileIndex>['index']>) => resolve().index(...args), search: (...args: Parameters<NonNullable<typeof services.FileIndex>['search']>) => resolve().search(...args), cancel: (...args: Parameters<NonNullable<typeof services.FileIndex>['cancel']>) => resolve().cancel(...args) };
            server = createFileIndexServer(backend, process.env.CORTEX_FILE_INDEX_TOKEN);
            await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(Number(process.env.FILE_INDEX_PORT ?? 8877), '127.0.0.1', resolve); });
        }, async teardown() { if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
            server = undefined;
        } } };
}
export const plugin = createHttpPlugin();
