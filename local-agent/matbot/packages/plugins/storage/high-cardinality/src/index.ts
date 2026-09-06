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
  /**
   * Activates the backend when the plugin is hot-loaded: derives the data root
   * from the config path and registers the backend (opening the SQLite
   * database and running migrations). No-op when the pre-scan already opened
   * this backend at boot, or when no config path is available.
   * @param services - Runtime machine used to register the backend.
   * @returns Resolves once the backend is registered (or the no-op exits).
   * @throws Propagates backend open/migration errors or registration errors.
   */
  async setup(services: MatbotMachine) {
    if (services.StorageBackend instanceof HighCardinalityStorageBackend) return;
    if (!services.configPath) return;
    const dotData = join(dirname(services.configPath), '.data');
    await services.register('StorageBackend', await HighCardinalityStorageBackend.open(dotData));
  },
};

export default plugin;
