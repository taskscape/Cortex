import type { MatbotPluginSpec, Tool } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { editTool, readTool, writeTool } from './files.js';
import { globTool, grepTool, listTool } from './search.js';
import { todowriteTool } from './todo.js';

export { applyReplacement } from './files.js';
export { clearSessionTodos, getSessionTodos, todowriteTool, type Todo, type TodoPriority, type TodoStatus } from './todo.js';
export { globTool, grepTool, listTool } from './search.js';
export { readTool, writeTool } from './files.js';
export { confine, HarnessError, requireRoot } from './paths.js';
export { globToRegExp, resetReadState, summarizeDiff, walkFiles } from './fsutil.js';

/** All harness tools in registration order. */
export const harnessTools: readonly Tool[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  listTool,
  todowriteTool,
];

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [...harnessTools],
};
