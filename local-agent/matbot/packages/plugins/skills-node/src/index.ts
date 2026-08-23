/**
 * Public API of the node `skills` plugin: the base skills plugin plus a
 * filesystem `.md` importer/watcher.
 *
 * @packageDocumentation
 */
export { createSkillsNodePlugin, plugin } from './plugin.js';
export type { SkillsNodePluginConfig }    from './plugin.js';
export { watchAndImportSkillDir }         from './watcher.js';
