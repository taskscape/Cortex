export { OpenRouterAdapter, OpenRouterError } from './adapter.js';
export { validateOpenRouterConfig, OPENROUTER_API_ORIGIN, OPENROUTER_COMPLETIONS_URL } from './config.js';
export type { OpenRouterCapabilities, OpenRouterReasoning, OpenRouterRouting, ValidatedOpenRouterConfig } from './config.js';
export { checkOpenRouterKey } from './diagnostics.js';
export type { OpenRouterKeyDiagnostic } from './diagnostics.js';
export { fetchOpenRouterCatalog, normalizeOpenRouterModel, OpenRouterCatalogService } from './models.js';
export type { OpenRouterModelMetadata, OpenRouterCatalogSnapshot, OpenRouterCatalogServiceOptions } from './models.js';

import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { OpenRouterAdapter } from './adapter.js';

/** Node-only provider plugin; browser bundles never receive OpenRouter credentials. */
export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  provider: () => new OpenRouterAdapter(),
};
