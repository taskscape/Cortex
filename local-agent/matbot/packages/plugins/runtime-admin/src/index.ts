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
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION,
    /**
     * Boots the runtime-admin plugin: contributes the admin web UI, registers the provider-models
     * configuration editor and the runtime-plugins health probe, then registers the node `plugin`
     * and `provider` management tools.
     *
     * Assumes the host application has mounted `RuntimeAdminConfig` with the live providers map it
     * persists to `matbot.yaml`; this plugin does not own that persistence itself.
     *
     * @param services - The service registry handed to every plugin's setup; read for contributions,
     *   `RuntimeAdminConfig`, and the tool registration surface.
     * @returns Resolves once both tools are registered.
     * @throws Error - If `RuntimeAdminConfig` is absent.
     */
    async setup(services) {
        services.contributions?.register('webui', 'runtime', uiContribution);
        const config = services.RuntimeAdminConfig;
        if (!config)
            throw new Error('runtime-admin requires host provider persistence');
        registerModelConfiguration(services, config.providers);
        services.contributions?.register('health', 'runtime-plugins', {
            /**
             * Reports which plugins are loaded and whether any expected plugin is missing.
             * @returns `{ state, details }` where `state` is `'degraded'` if any name from
             *   `expectedPlugins` is absent from the registry (else `'ready'`), and `details`
             *   carries loaded plugin names, missing names, and configured provider names.
             * @throws Never.
             */
            async probe() { const loaded = getRegisteredPlugins().map(p => p.name); const missing = (config.expectedPlugins ?? []).filter(name => !loaded.includes(name)); return { state: missing.length ? 'degraded' : 'ready', details: { loaded, missing, providers: [...config.providers.keys()] } }; } });
        await services.tools.register(pluginTool);
        await services.tools.register(createProviderTool(config.providers, config.originalPaths));
    } };
