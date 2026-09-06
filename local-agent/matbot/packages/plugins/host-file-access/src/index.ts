import type {} from '@matatbread/matbot-capabilities-types';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostFileAccessService } from '@local-agent/file-broker';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-file-services-types';
const configRoot = fileURLToPath(new URL('../../../../../config/', import.meta.url));
/**
 * Build the plugin that owns the host file-access backend.
 *
 * On `setup` it constructs a {@link HostFileAccessService} from the workspace and security-policy
 * config (paths overridable via `WORKSPACES_CONFIG` / `SECURITY_POLICY_CONFIG`, backup root via
 * `CORTEX_FILE_BROKER_BACKUP_ROOT`), health-checks it, registers it as the `HostFileAccess`
 * service, and adds a `health` contribution probe. `teardown` closes the service.
 *
 * @returns The plugin spec.
 * @throws Never - Ownership and service failures surface in `setup`.
 */
export function createHostFileAccessPlugin(): MatbotPluginSpec {
    let service: HostFileAccessService | undefined;
    return { apiVersion: PLUGIN_API_VERSION, /**
     * Construct and register the {@link HostFileAccessService}.
     *
     * @param services - Machine services; checked for an existing `HostFileAccess` owner and used
     *          to register the service and the health probe.
     * @returns Nothing.
     * @throws Error - If `HostFileAccess` already has an owner, or service construction or its
     *           initial health check fails.
     */
    async setup(services) {
            if (services.HostFileAccess)
                throw new Error('HostFileAccess already has an owner');
            service = new HostFileAccessService({ workspaceConfigPath: path.resolve(process.env.WORKSPACES_CONFIG ?? path.join(configRoot, 'workspaces.json')), securityPolicyPath: path.resolve(process.env.SECURITY_POLICY_CONFIG ?? path.join(configRoot, 'security-policy.json')), ...(process.env.CORTEX_FILE_BROKER_BACKUP_ROOT ? { backupRoot: process.env.CORTEX_FILE_BROKER_BACKUP_ROOT } : {}) });
            await service.health();
            await services.register('HostFileAccess', service);
            services.contributions?.register('health', 'host-file-access', { async probe(signal) { const backend = services.HostFileAccess; if (!backend)
                    throw new Error('Host file access unloaded'); return { state: 'ready', details: await backend.health(signal) }; } });
        }, /**
     * Close the service and clear the reference.
     *
     * @returns Nothing.
     * @throws Error - If closing the service fails.
     */
    async teardown() { await service?.close(); service = undefined; } };
}
export const plugin = createHostFileAccessPlugin();
