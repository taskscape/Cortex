export type * from '@matatbread/matbot-plugin-api';

// ── Internal types (not part of the plugin API) ───────────────────────────────

import type {
  ProviderAdapter,
} from '@matatbread/matbot-plugin-api';

/** Internal provider-adapter registry: register adapters by plugin name and resolve them for turns. */
export interface ProviderRegistry {
  /**
   * Register a provider adapter.
   *
   * @param adapter - The adapter to register under its own name.
   */
  register(adapter: ProviderAdapter): void;
  /**
   * Resolve a registered adapter by name.
   *
   * @param name - The adapter's name.
   * @returns The matching adapter.
   * @throws When no adapter is registered under this name.
   */
  resolve(name: string): ProviderAdapter;
}

