export { OpenAICompatAdapter } from './adapter.js';
// Shared OpenAI-chat conversion contracts are public so dialect adapters can reuse them without
// reaching into this package's private source path.
export { toOAIMessages, toOAITools, serializeToolResult } from './convert.js';
export type { OAIMessage, OAIToolDef, OpenRouterReplayOptions } from './convert.js';

import type { MatbotPluginSpec }     from '@matatbread/matbot-plugin-api';
import { OpenAICompatAdapter }   from './adapter.js';

/** Provider plugin exposing the {@link OpenAICompatAdapter} for every configured profile. */
export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  provider: (_config) => new OpenAICompatAdapter(),
};
