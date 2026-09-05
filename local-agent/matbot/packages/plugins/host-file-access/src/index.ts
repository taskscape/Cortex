import type {} from '@matatbread/matbot-capabilities-types';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostFileAccessService } from '@local-agent/file-broker';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-file-services-types';
const configRoot = fileURLToPath(new URL('../../../../../config/', import.meta.url));
export function createHostFileAccessPlugin(): MatbotPluginSpec {
    let service: HostFileAccessService | undefined;
    return { apiVersion: PLUGIN_API_VERSION, async setup(services) {
            if (services.HostFileAccess)
                throw new Error('HostFileAccess already has an owner');
            service = new HostFileAccessService({ workspaceConfigPath: path.resolve(process.env.WORKSPACES_CONFIG ?? path.join(configRoot, 'workspaces.json')), securityPolicyPath: path.resolve(process.env.SECURITY_POLICY_CONFIG ?? path.join(configRoot, 'security-policy.json')), ...(process.env.CORTEX_FILE_BROKER_BACKUP_ROOT ? { backupRoot: process.env.CORTEX_FILE_BROKER_BACKUP_ROOT } : {}) });
            await service.health();
            await services.register('HostFileAccess', service);
            services.contributions?.register('health', 'host-file-access', { async probe(signal) { const backend = services.HostFileAccess; if (!backend)
                    throw new Error('Host file access unloaded'); return { state: 'ready', details: await backend.health(signal) }; } });
        }, async teardown() { await service?.close(); service = undefined; } };
}
export const plugin = createHostFileAccessPlugin();
