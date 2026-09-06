import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION }               from '@matatbread/matbot-plugin-api';
import { makeSessionTools }                 from './tools.js';

/**
 * Plugin registering the `session_action` tool against the runtime's
 * session store, when one is present.
 *
 * @returns The plugin specification.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  /**
   * Registers the session tools against the runtime's session store.
   *
   * @param services - Runtime machine; a no-op when no sessions store is present.
   * @returns A promise that resolves once the tools are registered.
   * @throws Never.
   */
  async setup(services: MatbotMachine) {
    const store = services.sessions;
    if (!store) return;
    for (const tool of makeSessionTools(store)) {
      services.tools.register(tool);
    }
  },
};
