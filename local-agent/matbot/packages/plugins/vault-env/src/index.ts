import path from 'node:path';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { EnvFileVault } from './vault.js';
export { EnvFileVault };
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION, async setup(services) {
        if (!services.configPath)
            throw new Error('vault-env requires a host config path');
        await services.register('Vault', new EnvFileVault(path.join(path.dirname(services.configPath), '.env'), process.env));
    } };
