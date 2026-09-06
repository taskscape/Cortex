import type {} from '@matatbread/matbot-capabilities-types';
import { uiContribution } from './ui.js';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { createBrowserPluginTool } from '@matatbread/matbot-browser';
import type { ExtraPlugins } from '@matatbread/matbot-browser';
import { createBrowserProviderTool } from './browser-provider.js';
import type { ProviderAdmin } from './browser-provider.js';
declare module '@matatbread/matbot-plugin-api' {
    interface MatbotServices {
        readonly BrowserProviderAdmin?: ProviderAdmin;
        readonly BrowserPluginPersistence?: ExtraPlugins;
    }
}
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION,
    /**
     * Boots the browser runtime-admin plugin: contributes the admin web UI, then registers the
     * browser `plugin` and `provider` management tools.
     *
     * Assumes the browser host has already mounted `BrowserProviderAdmin` and
     * `BrowserPluginPersistence` (provided by the browser persistence plugin); this plugin does not
     * register them itself.
     *
     * @param services - The service registry handed to every plugin's setup; read for contributions,
     *   the two required browser services, and the tool registration surface.
     * @returns Resolves once both tools are registered.
     * @throws Error - If `BrowserProviderAdmin` or `BrowserPluginPersistence` is absent.
     */
    async setup(services) {
        services.contributions?.register('webui', 'runtime', uiContribution);
        if (!services.BrowserProviderAdmin || !services.BrowserPluginPersistence)
            throw new Error('runtime-admin requires browser persistence');
        await services.tools.register(createBrowserPluginTool(services.BrowserPluginPersistence));
        await services.tools.register(createBrowserProviderTool(services.BrowserProviderAdmin));
    } };
