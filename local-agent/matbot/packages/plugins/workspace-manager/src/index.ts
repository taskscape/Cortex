import type {} from '@matatbread/matbot-capabilities-types';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-workspace-manager-types';
export { FileWorkspaceManager } from './manager.js';
export type { WorkspaceDeletionHooks, WorkspaceDeletionResult, FileWorkspaceManagerOptions } from './manager.js';
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION, async setup(services) {
        const bootstrap = services.WorkspaceBootstrap;
        if (!bootstrap)
            throw new Error('workspace-manager requires workspace bootstrap context');
        await services.register('WorkspaceContext', Object.freeze({ ...bootstrap.context }));
        await services.register('WorkspaceManager', bootstrap.manager);
        services.contributions?.register('health', 'workspaces', { async probe(signal) { signal.throwIfAborted(); const list = await bootstrap.manager.list(); return { state: 'ready', details: { active: bootstrap.context.id, count: list.workspaces.length } }; } });
    } };
