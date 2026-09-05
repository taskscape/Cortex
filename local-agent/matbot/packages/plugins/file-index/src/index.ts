import type {} from '@matatbread/matbot-capabilities-types';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileIndexService } from '@local-agent/file-index';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, ToolEvent } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-file-services-types';
const localRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
export function createFileIndexPlugin(): MatbotPluginSpec {
    let service: FileIndexService | undefined;
    return { apiVersion: PLUGIN_API_VERSION, async setup(services) {
            if (services.FileIndex)
                throw new Error('FileIndex already has an owner');
            service = new FileIndexService({ storePath: path.resolve(process.env.FILE_INDEX_STORE ?? path.join(localRoot, 'file-index/data/index.json')), workspaceConfigPath: path.resolve(process.env.WORKSPACES_CONFIG ?? path.join(localRoot, 'config/workspaces.json')), securityPolicyPath: path.resolve(process.env.SECURITY_POLICY_CONFIG ?? path.join(localRoot, 'config/security-policy.json')), maxFileBytes: Number(process.env.FILE_INDEX_MAX_FILE_BYTES ?? 1000000) });
            await service.health();
            await services.register('FileIndex', service);
        }, async teardown() { await service?.close(); service = undefined; } };
}
export const plugin = createFileIndexPlugin();
