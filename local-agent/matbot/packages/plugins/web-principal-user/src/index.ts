import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
// Type-only: brings the `WebPrincipalResolver` augmentation of MatbotMachine into scope so the
// register call below is typed. Erased at runtime — this plugin does NOT load the web frontend; it
// only offers a resolver the frontend reads per-request if it happens to be present.
import type { WebPrincipalResolver } from '@matatbread/matbot-frontend-web';
import process from 'node:process';

/**
 * Plugin registering a {@link WebPrincipalResolver} that derives the request
 * principal from the `USER` environment variable (falling back to `"unknown"`).
 * Type-only augmentation of the web frontend; no frontend is loaded here.
 *
 * @returns The plugin specification registering the resolver service.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  /**
   * Registers the `WebPrincipalResolver` service: resolves every request to
   * the `USER` environment variable (falling back to `"unknown"`), typed as
   * the web frontend's `user` principal type.
   *
   * @param services - Machine services receiving the resolver registration.
   */
  async setup(services: MatbotMachine) {
    /** Derives the request principal from the `USER` env var, defaulting to `"unknown"`. */
    const resolver: WebPrincipalResolver = () => ({
      id:   process.env['USER'] ?? 'unknown',
      type: 'user',
    });
    await services.register('WebPrincipalResolver', resolver);
  },
};
