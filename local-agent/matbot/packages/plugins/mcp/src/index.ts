import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { createMCPPlugin } from './plugin.js';

/** The node MCP plugin: manages local (stdio) and remote (HTTP) MCP servers via `mcp_action`. */
export const plugin: MatbotPluginSpec = createMCPPlugin();
