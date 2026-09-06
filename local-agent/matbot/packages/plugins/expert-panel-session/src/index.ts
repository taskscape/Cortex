import type {} from '@matatbread/matbot-session-titler';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { createToolInvoker } from '@matatbread/matbot-core';
import { ExpertSessionService } from './service.js';
export * from './service.js';
declare module '@matatbread/matbot-plugin-api' {
    interface MatbotServices {
        /** Service owning expert panel sessions for this machine. */
        readonly ExpertSessions?: ExpertSessionService;
    }
}
/**
 * Builds the expert-panel-session plugin: on setup it constructs an
 * {@link ExpertSessionService} over the machine's session store and runner and
 * registers it as the `ExpertSessions` service; on teardown it closes the
 * service and unregisters the owner.
 *
 * @returns The matbot plugin specification.
 * @throws Never - the factory itself only builds the spec; errors are raised by `setup`.
 */
export function createExpertSessionPlugin(): MatbotPluginSpec {
    let owner: ExpertSessionService | undefined;
    return { apiVersion: PLUGIN_API_VERSION, /**
             * Validates the host and brings the expert session service online.
             * Requires the session store and runner; wires tool resolution and
             * invocation (via the core tool invoker) and optional session
             * titling through `SessionTitler` (a no-op when absent), then
             * registers the service under the `ExpertSessions` key.
             *
             * @param services - Machine services and runtime plumbing.
             * @throws Error - If `services.sessions` or `services.run` is missing.
             */
            async setup(services) {
            if (!services.sessions || !services.run)
                throw new Error('Expert sessions require sessions and runner');
            owner = new ExpertSessionService({ store: services.sessions, run: services.run, resolve: name => services.tools.resolve(name), invoke: createToolInvoker(services).invoke, titleSession: input => services.SessionTitler?.titleSession(input) ?? Promise.resolve() });
            await services.register('ExpertSessions', owner);
        }, /**
             * Closes the owning {@link ExpertSessionService} and releases it, so
             * the registered service no longer resolves to this plugin's owner.
             */
            async teardown() { owner?.close(); owner = undefined; } };
}
export const plugin = createExpertSessionPlugin();
