import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn }                        from 'node:child_process';
import path                             from 'node:path';
import process                          from 'node:process';
import type { MatbotPlugin }            from '@matatbread/matbot-core';
import { backfillPluginDescription }    from './plugin-description.js';

// ── Package manager detection ───────────────────────��─────────────────────────

/**
 * Detect the project's package manager by probing for its lockfile.
 * @param dir - Project directory to probe.
 * @returns 'pnpm', 'yarn', or 'bun' when their lockfile exists; 'npm' otherwise (the default).
 * @throws Never.
 */
async function detectPackageManager(dir: string): Promise<string> {
  for (const [pm, lockfile] of [['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lockb']] as const) {
    try { await access(path.join(dir, lockfile)); return pm; } catch { /* not present */ }
  }
  return 'npm';
}

// ── Shell runner ───────────────────────��───────────────────────────────���──────

/**
 * Run a command in a directory, inheriting the parent's stdio. Uses the shell on Windows so
 * `.cmd` shims (npm/pnpm/yarn/bun) resolve without an explicit extension.
 * @param cmd - Executable to run (e.g. the detected package manager).
 * @param args - Command-line arguments passed verbatim.
 * @param cwd - Working directory for the child process.
 * @returns Resolves when the child exits with code 0.
 * @throws Error - Rejects when the child exits with a non-zero code.
 */
function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${String(code)}`));
    });
  });
}

// ── matbot.yaml updater ──────────────────────────��────────────────────────────

/**
 * Add a plugin specifier to the `plugins:` list of a matbot.yaml file. A no-op (with a stderr
 * notice) when the specifier is already listed; otherwise the specifier is inserted into the
 * existing `plugins:` block, a new block is created before `providers:`, or a new block is
 * prepended to the file, which is then rewritten.
 * @param configPath - Path to the matbot.yaml to update.
 * @param specifier - Plugin specifier to add (exactly as it should appear in the YAML).
 * @returns Resolves once the file has been written (or the specifier was already present).
 * @throws Error - When the config file cannot be read or written.
 */
async function addToPluginsList(configPath: string, specifier: string): Promise<void> {
  const text = await readFile(configPath, 'utf8');

  // Check if this specifier is already listed
  if (text.includes(`- ${specifier}`)) {
    process.stderr.write(`"${specifier}" is already in plugins list.\n`);
    return;
  }

  let updated: string;
  const pluginsBlockMatch = text.match(/^(plugins:\s*\n(?:[ \t]+-[^\n]*\n)*)/m);

  if (pluginsBlockMatch) {
    const insertAt = pluginsBlockMatch.index! + pluginsBlockMatch[0].length;
    updated = text.slice(0, insertAt) + `  - ${specifier}\n` + text.slice(insertAt);
  } else {
    // Insert a new plugins: section before providers: (or at the top)
    const providersIdx = text.indexOf('\nproviders:');
    if (providersIdx !== -1) {
      updated = text.slice(0, providersIdx) + `\nplugins:\n  - ${specifier}\n` + text.slice(providersIdx);
    } else {
      updated = `plugins:\n  - ${specifier}\n\n` + text;
    }
  }

  await writeFile(configPath, updated, 'utf8');
}

// ── Main install flow ─────────────────────���─────────────────────────────────��─

/**
 * Install a plugin into the project: install the npm package via the detected package
 * manager (skipped for local paths), inspect its manifest to surface the description,
 * and add the specifier to the `plugins:` list in matbot.yaml.
 * @param specifier Plugin specifier — a local path or an npm package name.
 * @param configPath Path to the matbot.yaml to update.
 * @returns Resolves when installation completes; throws if the package manager command fails.
 * @throws Error When the package-manager invocation exits non-zero.
 * @throws Error When matbot.yaml cannot be read or updated.
 */
export async function installPlugin(specifier: string, configPath: string): Promise<void> {
  const projectDir = path.dirname(configPath);

  // 1. Install via package manager (skip for local paths — already on disk)
  const isLocalPath = specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier);
  if (!isLocalPath) {
    const pm = await detectPackageManager(projectDir);
    process.stderr.write(`\nInstalling "${specifier}" with ${pm}...\n`);
    await runCommand(pm, ['add', specifier], projectDir);
  }

  // 2. Inspect the plugin manifest
  let plugin: MatbotPlugin | undefined;
  try {
    const mod = await import(specifier) as Record<string, unknown>;
    plugin = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
  } catch {
    process.stderr.write(`[warn] Could not import "${specifier}" to inspect its manifest.\n`);
  }

  if (plugin !== undefined) await backfillPluginDescription(plugin, specifier, projectDir);

  if (plugin?.manifest?.description) {
    process.stderr.write(`\n${plugin.manifest.description}\n`);
  }

  // 3. Update matbot.yaml
  await addToPluginsList(configPath, specifier);
  process.stderr.write(`Added "${specifier}" to plugins in ${path.basename(configPath)}\n`);

  // Secrets a plugin needs are gathered lazily on first use: the plugin raises
  // MissingSecretError naming the key, and the model supplies it via `plugin store-key`.
  process.stderr.write(`\nPlugin installed.\n`);
}
