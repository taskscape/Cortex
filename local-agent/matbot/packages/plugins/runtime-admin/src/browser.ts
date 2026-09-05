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
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION, async setup(services) {
        services.contributions?.register('webui', 'runtime', uiContribution);
        if (!services.BrowserProviderAdmin || !services.BrowserPluginPersistence)
            throw new Error('runtime-admin requires browser persistence');
        await services.tools.register(createBrowserPluginTool(services.BrowserPluginPersistence));
        await services.tools.register(createBrowserProviderTool(services.BrowserProviderAdmin));
    } };
