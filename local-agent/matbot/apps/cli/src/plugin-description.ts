import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadPlugins } from '@matatbread/matbot-core';
import type { MatbotPlugin, PluginManifest, MatbotMachine, PromptFn, Runtime } from '@matatbread/matbot-core';

/**
 * A fully host-resolved plugin load request. The CLI resolves a config/human specifier (`spec`) to
 * the URL it actually imports (`importSpec`) and reads the resolved package.json for `name`/`runtimes`,
 * so the loader records `spec` as `plugin.specifier` (matching matbot.yaml) while importing `importSpec`.
 */
export interface PluginLoadRequest {
  spec:       string;
  importSpec: string;
  name?:      string;
  runtimes?:  readonly Runtime[];
}

/**
 * Determine the directory where the upward package.json search for a plugin
 * specifier begins: file: URLs resolve to their file's directory, relative/absolute
 * paths resolve against `baseDir`, and bare npm names resolve through the project's
 * module graph (which only works once the package is on disk).
 * @param specifier Plugin specifier (file: URL, path, or bare package name).
 * @param baseDir Project directory used to resolve relative paths and module lookups.
 * @returns The start directory, or undefined if a bare name cannot be resolved.
 */
export function startDir(specifier: string, baseDir: string): string | undefined {
  const bare = (specifier.split('?')[0]) ?? specifier;
  if (bare.startsWith('file://')) return path.dirname(fileURLToPath(bare));
  if (bare.startsWith('./') || bare.startsWith('../') || path.isAbsolute(bare)) {
    return path.resolve(baseDir, bare);
  }
  try {
    const require = createRequire(pathToFileURL(path.join(baseDir, 'index.js')).href);
    return path.dirname(require.resolve(bare));
  } catch {
    return undefined;
  }
}

async function descriptionFromPackageJson(specifier: string, baseDir: string): Promise<string | undefined> {
  let dir = startDir(specifier, baseDir);
  if (dir === undefined) return undefined;
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { description?: string };
      if (pkg.description) return pkg.description;
    } catch { /* no package.json here, keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Read the canonical name (+ optional matbotRuntime) from the package.json governing a resolved
 * import URL — the node analogue of the web assembler's specNames. Walks up to the first package.json
 * carrying a `name` (a nameless intermediate is not the plugin's manifest), so the CLI can hand the
 * loader a precomputed identity and `plugin.specifier` can stay the human/config specifier.
 */
export async function readPluginMeta(specifier: string, baseDir: string): Promise<{ name?: string; runtimes?: Runtime[] }> {
  let dir = startDir(specifier, baseDir);
  if (dir === undefined) return {};
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string; matbotRuntime?: unknown };
      if (typeof pkg.name === 'string') {
        const runtimes = Array.isArray(pkg.matbotRuntime)
          ? pkg.matbotRuntime.filter((r): r is Runtime => typeof r === 'string')
          : undefined;
        return { name: pkg.name, ...(runtimes !== undefined ? { runtimes } : {}) };
      }
    } catch { /* no package.json here, keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

/**
 * Fill in `plugin.manifest.description` from the plugin's package.json, unless the plugin
 * already declares a description (a declared getter counts as declared and is left untouched).
 * @param plugin The freshly loaded plugin to annotate.
 * @param specifier Specifier the plugin was loaded with; used to locate its package.json.
 * @param baseDir Project directory that path/module resolution anchors against.
 * @returns Resolves when the manifest has been updated (or no description was found).
 */
export async function backfillPluginDescription(
  plugin:    MatbotPlugin,
  specifier: string,
  baseDir:   string,
): Promise<void> {
  if (plugin.manifest !== undefined && 'description' in plugin.manifest) return;
  const description = await descriptionFromPackageJson(specifier, baseDir);
  if (description === undefined) return;
  if (plugin.manifest !== undefined) {
    (plugin.manifest as { description?: string }).description = description;
  } else {
    (plugin as { manifest?: PluginManifest }).manifest = { description };
  }
}

/**
 * Node entry point for every CLI plugin load: delegates to the platform-neutral
 * `loadPlugins`, then folds each freshly loaded plugin's package.json description into
 * its manifest.
 * @param requests Host-resolved load requests (spec plus importSpec per plugin).
 * @param services Machine services passed through to the loader and plugin setup().
 * @param baseDir Project directory where package.json paths and node_modules resolve from.
 * @param bustCache When true, re-import plugins bypassing the module cache (hot reload).
 * @param prompt Optional user-prompt function handed to plugins during setup.
 * @param onLoadError Whether a failing load is skipped ('skip') or thrown ('throw').
 * @returns The loaded plugins, with descriptions backfilled.
 */
export async function loadPluginsWithDescriptions(
  requests:   readonly PluginLoadRequest[],
  services:   MatbotMachine,
  baseDir:    string,
  bustCache = false,
  prompt?:    PromptFn,
  onLoadError: 'skip' | 'throw' = 'skip',
): Promise<MatbotPlugin[]> {
  const plugins = await loadPlugins(requests, services, bustCache, prompt, onLoadError);
  // plugin.specifier is the config-level `spec`; the package.json lives at the resolved importSpec.
  const importByCfg = new Map(requests.map(r => [r.spec, r.importSpec]));
  for (const plugin of plugins) {
    await backfillPluginDescription(plugin, importByCfg.get(plugin.specifier) ?? plugin.specifier, baseDir);
  }
  return plugins;
}
