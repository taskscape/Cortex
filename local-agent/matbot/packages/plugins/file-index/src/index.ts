import type {} from '@matatbread/matbot-capabilities-types';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileIndexService } from '@local-agent/file-index';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, ToolEvent } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-file-services-types';
const localRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
/**
 * Build the plugin that owns the host text-file index.
 *
 * On `setup` it constructs a {@link FileIndexService} (store path, workspace config, security
 * policy, and per-file size cap — overridable via `FILE_INDEX_STORE`, `WORKSPACES_CONFIG`,
 * `SECURITY_POLICY_CONFIG`, and `FILE_INDEX_MAX_FILE_BYTES`), health-checks it, and registers it
 * as the `FileIndex` service. `teardown` closes it.
 *
 * @returns The plugin spec.
 * @throws Never - Ownership and service failures surface in `setup`.
 */
export function createFileIndexPlugin(): MatbotPluginSpec {
    let service: FileIndexService | undefined;
    return { apiVersion: PLUGIN_API_VERSION, /**
     * Construct and register the {@link FileIndexService}.
     *
     * @param services - Machine services; checked for an existing `FileIndex` owner and used to
     *          register the service.
     * @returns Nothing.
     * @throws Error - If `FileIndex` already has an owner, or service construction or its initial
     *           health check fails.
     */
    async setup(services) {
            if (services.FileIndex)
                throw new Error('FileIndex already has an owner');
            service = new FileIndexService({ storePath: path.resolve(process.env.FILE_INDEX_STORE ?? path.join(localRoot, 'file-index/data/index.json')), workspaceConfigPath: path.resolve(process.env.WORKSPACES_CONFIG ?? path.join(localRoot, 'config/workspaces.json')), securityPolicyPath: path.resolve(process.env.SECURITY_POLICY_CONFIG ?? path.join(localRoot, 'config/security-policy.json')), maxFileBytes: Number(process.env.FILE_INDEX_MAX_FILE_BYTES ?? 1000000) });
            await service.health();
            await services.register('FileIndex', service);
        }, /**
     * Close the index service and clear the reference.
     *
     * @returns Nothing.
     * @throws Error - If closing the service fails.
     */
    async teardown() { await service?.close(); service = undefined; } };
}
export const plugin = createFileIndexPlugin();
