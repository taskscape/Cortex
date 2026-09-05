import { registerModelConfiguration } from './configuration.js';
import { getRegisteredPlugins } from '@matatbread/matbot-core';
import type {} from '@matatbread/matbot-capabilities-types';
import { uiContribution } from './ui.js';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, ProviderConfig } from '@matatbread/matbot-plugin-api';
import { pluginTool } from './plugin.js';
import { createProviderTool } from './provider.js';
declare module '@matatbread/matbot-plugin-api' {
    interface MatbotServices {
        readonly RuntimeAdminConfig?: {
            providers: Map<string, ProviderConfig>;
            originalPaths: ReadonlyMap<string, string>;
            expectedPlugins?: readonly string[];
        };
    }
}
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION, async setup(services) {
        services.contributions?.register('webui', 'runtime', uiContribution);
        const config = services.RuntimeAdminConfig;
        if (!config)
            throw new Error('runtime-admin requires host provider persistence');
        registerModelConfiguration(services, config.providers);
        services.contributions?.register('health', 'runtime-plugins', { async probe() { const loaded = getRegisteredPlugins().map(p => p.name); const missing = (config.expectedPlugins ?? []).filter(name => !loaded.includes(name)); return { state: missing.length ? 'degraded' : 'ready', details: { loaded, missing, providers: [...config.providers.keys()] } }; } });
        await services.tools.register(pluginTool);
        await services.tools.register(createProviderTool(config.providers, config.originalPaths));
    } };
