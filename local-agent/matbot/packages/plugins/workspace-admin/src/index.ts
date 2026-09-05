import type {} from '@matatbread/matbot-capabilities-types';
import { uiContribution } from './ui.js';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, ToolEvent } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-workspace-manager-types';
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION, async setup(services) {
        services.contributions?.register('webui', 'workspace', uiContribution);
        services.tools.register({ name: 'workspace_admin_action', description: 'Manage Cortex workspaces. Files-panel artifacts use workspace_action.', serial: true,
            inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['current', 'list', 'create', 'rename', 'delete_check', 'delete', 'switch'] }, id: { type: 'string' }, name: { type: 'string' } } },
            executor: { async *execute(input, ctx): AsyncIterable<ToolEvent> {
                    ctx.signal.throwIfAborted();
                    const manager = services.WorkspaceManager;
                    if (!manager) {
                        yield { type: 'error', message: 'Workspace manager unavailable' };
                        return;
                    }
                    const args = input as {
                        action: string;
                        id?: string;
                        name?: string;
                    };
                    const id = () => { if (!args.id)
                        throw new Error('Workspace id is required'); return args.id; };
                    const name = () => { if (!args.name?.trim())
                        throw new Error('Workspace name is required'); return args.name; };
                    let result: unknown;
                    switch (args.action) {
                        case 'current':
                            result = await manager.current();
                            break;
                        case 'list':
                            result = await manager.list();
                            break;
                        case 'create':
                            result = await manager.create(name());
                            break;
                        case 'rename':
                            result = await manager.rename(id(), name());
                            break;
                        case 'delete_check':
                            result = await manager.deleteCheck?.(id());
                            break;
                        case 'delete':
                            result = await manager.delete(id());
                            break;
                        case 'switch':
                            result = await manager.switch(id());
                            break;
                        default: throw new Error('Unknown workspace action');
                    }
                    yield { type: 'result', value: result };
                } } });
    } };
