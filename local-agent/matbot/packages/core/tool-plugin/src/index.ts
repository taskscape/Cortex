/**
 * Barrel of the built-in tool-plugin package: plugin/provider management tools and the
 * remote-plugin fetch-and-cache used to materialise them.
 * @module
 */
import type { Tool } from '@matatbread/matbot-plugin-api';
export { pluginTool }           from './tools/plugin.js';
export { createProviderTool }   from './tools/provider.js';
export { classifySpecifier, fetchRemoteManifest, materializeRemote } from './remote-cache.js';
export type { Classified, RemoteManifest } from './remote-cache.js';

import { pluginTool } from './tools/plugin.js';

/**
 * Assemble the default set of built-in tools registered by this package.
 *
 * @returns The built-in tool list (currently just {@link pluginTool}).
 */
export function createBuiltinTools(): Tool[] {
  return [pluginTool];
}
