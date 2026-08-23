export { AnthropicAdapter } from './adapter.js';

import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { AnthropicAdapter }  from './adapter.js';

/** Provider plugin exposing the {@link AnthropicAdapter} for every configured profile. */
export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  provider: (_config) => new AnthropicAdapter(),
};
