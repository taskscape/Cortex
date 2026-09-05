import type {} from '@matatbread/matbot-session-titler';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { createToolInvoker } from '@matatbread/matbot-core';
import { ExpertSessionService } from './service.js';
export * from './service.js';
declare module '@matatbread/matbot-plugin-api' {
    interface MatbotServices {
        readonly ExpertSessions?: ExpertSessionService;
    }
}
export function createExpertSessionPlugin(): MatbotPluginSpec {
    let owner: ExpertSessionService | undefined;
    return { apiVersion: PLUGIN_API_VERSION, async setup(services) {
            if (!services.sessions || !services.run)
                throw new Error('Expert sessions require sessions and runner');
            owner = new ExpertSessionService({ store: services.sessions, run: services.run, resolve: name => services.tools.resolve(name), invoke: createToolInvoker(services).invoke, titleSession: input => services.SessionTitler?.titleSession(input) ?? Promise.resolve() });
            await services.register('ExpertSessions', owner);
        }, async teardown() { owner?.close(); owner = undefined; } };
}
export const plugin = createExpertSessionPlugin();
