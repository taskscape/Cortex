import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { setupSkills } from '@matatbread/matbot-skills';
import path from 'node:path';
import process from 'node:process';
import { watchAndImportSkillDir } from './watcher.js';

/**
 * Configuration for the node skills plugin.
 */
export interface SkillsNodePluginConfig {
  /** Directory to import and watch for `.md` skill files. */
  skillsDir: string;
  /** Polling interval (ms) used when filesystem watch is unavailable. Default 5000. */
  pollMs?:   number;
}

/**
 * The node skills plugin. It is a specialization of @matatbread/matbot-skills — "skills, plus a
 * local filesystem watch" — so it hard-depends on the base (declared in package.json) and reuses
 * its setup directly via {@link setupSkills}, then attaches a `.md` importer/watcher to the same
 * SkillManager. One plugin, one lifecycle: no second resident plugin, no service discovery.
 *
 * @param config - Plugin configuration; `skillsDir` is required, `pollMs` optional.
 * @returns The plugin specification.
 * @throws Never.
 */
export function createSkillsNodePlugin(config: SkillsNodePluginConfig): MatbotPluginSpec {
  let abortController: AbortController | undefined;
  let clear: (() => void) | undefined;

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      config:      ['skillsDir'],
      description: 'Node skills: embeds @matatbread/matbot-skills CRUD and adds a local filesystem (.md) import + watch.',
    },

    /**
     * Explains that skills load on demand by name and how to wire automatic application through
     * the triggers plugin.
     *
     * @returns The installation message text.
     * @throws Never.
     */
    async installationMessage() {
      return 'Skills are active (skill_action, plus a local .md import + watch). A skill is loaded on ' +
        'demand by name; to make one apply automatically on a behavioural condition, add a trigger ' +
        '(trigger_action) whose invoke is skill_action with { action: "use", name } — install ' +
        '@matatbread/matbot-triggers for that.';
    },

    /**
     * Runs the shared skills setup and starts the `.md` directory watcher against a fresh abort
     * controller; both are stopped again in teardown.
     *
     * @param services - Runtime machine passed through to {@link setupSkills}.
     * @returns A promise that resolves once the manager is loaded and the watcher started (the
     *   watcher itself runs detached).
     * @throws Error - Propagates {@link setupSkills} failures (store load, registration).
     */
    async setup(services) {
      const manager = await setupSkills(services);
      clear = () => manager.clear();

      abortController = new AbortController();
      void watchAndImportSkillDir(config.skillsDir, manager, abortController.signal, config.pollMs);
    },

    /**
     * Aborts the directory watcher and clears the manager's in-memory state (ending its
     * mounted-swap subscription and in-flight analyses).
     *
     * @returns A promise that resolves once both stops have run (no-ops when setup never ran).
     * @throws Never.
     */
    async teardown() {
      abortController?.abort();
      clear?.();
    },
  };
}

/**
 * Default plugin instance watching `.data/skills` in the current working
 * directory.
 *
 * @returns The default node skills plugin specification.
 */
export const plugin: MatbotPluginSpec = createSkillsNodePlugin({
  skillsDir: path.join(process.cwd(), '.data', 'skills'),
});
