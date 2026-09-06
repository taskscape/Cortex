import { dirname, join } from 'node:path';
import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { SQLiteStorageBackend } from './backend.js';

export { SQLiteStore } from './store.js';
export { SQLiteStorageBackend } from './backend.js';

/**
 * SQLite storage backend plugin — persists all namespaces and files in a
 * single WAL-mode database under `<config dir>/.data/matbot.db`.
 *
 * @returns The plugin specification.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  storageBackend: {
    open: (dotData: string) => SQLiteStorageBackend.open(dotData),
  },
  /**
   * Activates the SQLite backend when the plugin is hot-loaded. No-op when the
   * pre-scan already opened this backend at boot, or when no config path is
   * available to derive the data root from.
   * @param services - Runtime machine used to register the backend.
   * @returns Resolves once the backend is registered (or the no-op exits).
   * @throws Propagates errors from {@link SQLiteStorageBackend.open} or
   *   `services.register`.
   */
  async setup(services: MatbotMachine) {
    // Pre-scan already opened this backend at startup — nothing to do.
    if (services.StorageBackend instanceof SQLiteStorageBackend) return;
    // Hot-loaded at runtime: activate now.
    if (!services.configPath) return;
    const dotData = join(dirname(services.configPath), '.data');
    await services.register('StorageBackend', await SQLiteStorageBackend.open(dotData));
  },
};
