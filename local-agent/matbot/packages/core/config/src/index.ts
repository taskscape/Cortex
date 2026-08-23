/**
 * Barrel of the config package: the minimal YAML parser and `matbot.yaml` loading.
 * @module
 */
export { parseYaml }               from './yaml.js';
export type { YamlMap, YamlValue } from './yaml.js';
export { parseConfig }             from './loader.js';
export type { MatbotConfig }       from './loader.js';
