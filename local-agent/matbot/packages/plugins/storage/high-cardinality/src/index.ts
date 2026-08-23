import { dirname, join } from 'node:path';
import type { MatbotMachine, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { HighCardinalityStorageBackend } from './backend.js';

export { HIGH_CARDINALITY_NAMESPACES, HighCardinalityStorageBackend } from './backend.js';

/**
 * Plugin routing high-cardinality namespaces (source registry, context graph)
 * to WAL-mode SQLite while leaving other state filesystem-backed.
 *
 * @returns The plugin specification.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Routes high-cardinality source-registry and context-graph stores to WAL-mode SQLite while preserving ordinary filesystem-backed state.',
  },
  storageBackend: {
    open: (dotData: string) => HighCardinalityStorageBackend.open(dotData),
  },
  async setup(services: MatbotMachine) {
    if (services.StorageBackend instanceof HighCardinalityStorageBackend) return;
    if (!services.configPath) return;
    const dotData = join(dirname(services.configPath), '.data');
    await services.register('StorageBackend', await HighCardinalityStorageBackend.open(dotData));
  },
};

export default plugin;
