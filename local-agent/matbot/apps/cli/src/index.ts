#!/usr/bin/env node
import {selectCapabilityProfile,profilePlugins} from './capability-profiles.js';
import type {} from '@matatbread/matbot-file-services-types';
import { FileWorkspaceManager } from '@matatbread/matbot-workspace-manager-node';
export { FileWorkspaceManager } from '@matatbread/matbot-workspace-manager-node';
export type { WorkspaceDeletionHooks, WorkspaceDeletionResult, FileWorkspaceManagerOptions } from '@matatbread/matbot-workspace-manager-node';
import type {} from '@matatbread/matbot-workspace-manager-types';
import type {} from '@matatbread/matbot-runtime-admin';
import type {} from '@matatbread/matbot-frontend-cli-node';
import { loadConfig, loadConfigFromText, loadDotEnv } from './config.js';
import { serializeYamlScalar }             from '@matatbread/matbot-config';
import { installPlugin }                    from './install.js';
import { loadPluginsWithDescriptions, readPluginMeta, type PluginLoadRequest } from './plugin-description.js';
import { nodePluginResolver }               from './plugin-resolver.js';
import type { Principal, ProviderAdapter,
              ProviderConfig, Session,
              Store,
              MessageContent, FileStore } from '@matatbread/matbot-core';
import { appendMessage, createMessage,
         createSession,
         createSessionRunner, freezeInvocationPolicy,
         HookRegistry, SystemContextRegistryImpl, ToolRegistryImpl,
         resolveProviderFactory,
         teardownPlugins,
         unloadPlugin as unloadPluginFn,
         getPluginNameForSpecifier, getRegisteredPlugins, recordServiceKey,
         installPrincipalCarrier, enterPrincipal, currentPrincipal,
         unifyServices, forwardingProxy, makeSwappable, singleTurnRequest,
         createMountTable, onContextQuiesce, flushIfQuiescent,
         MissingSecretError }              from '@matatbread/matbot-core';
import type { MatbotMachine, MatbotServices, PluginSettings, Vault, SessionRunner,
              MatbotPlugin, StorageBackend, KnowledgeIndex, PromptFn, FormField, SwapFn } from '@matatbread/matbot-core';
import { systemPrincipal }                 from '@matatbread/matbot-security';
import { createAlsPrincipalCarrier }       from './principal-als.js';
import { EnvFileVault }                     from './env-vault.js';
import { FilesystemFileStore }             from '@matatbread/matbot-files-node';
import { classifySpecifier, materializeRemote } from '@matatbread/matbot-tool-plugin';
import { LookupKnowledgeIndex }               from '@matatbread/matbot-knowledge';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { access, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface }                 from 'node:readline/promises';
import { createRequire }                   from 'node:module';
import { fileURLToPath, pathToFileURL }     from 'node:url';
import process                             from 'node:process';
import path                                from 'node:path';
import { spawn, type ChildProcess }        from 'node:child_process';
import { createWorkspaceStore, MemoryStore, workspaceDataDirectory } from './storage-isolation.js';

// Prefix all console output with ISO timestamp + PID so parent and spawned
// background processes are distinguishable in shared terminal output.
const _pid = process.pid;

// How long a shutdown may take before the process stops waiting for a clean teardown and exits. Any
// exit path that waits unconditionally on teardown can be held open forever by one plugin that will
// not settle — and a server process that will not exit keeps its ports, which is what turned a
// workspace switch into two live runtimes fighting over one port.
const SHUTDOWN_DEADLINE_MS = 4000;
const isBackground = process.env.IS_SUB_AGENT === '1';
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console) as (...a: unknown[]) => void;
  console[level] = (label, ...args: unknown[]) => {
    if (!isBackground || level === 'error')
      orig(`[${new Date().toISOString()} ${_pid}] ${label}`, ...args);
  };
}
/**
 * Write a progress/status line to stderr, or drop it when running as a background sub-agent
 * (IS_SUB_AGENT=1) so child output does not interleave with the parent's terminal.
 * @param text - Text to write; no trailing newline is added.
 * @returns Nothing.
 * @throws Never.
 */
const write = isBackground ? (text: string) => {} : (text: string) => process.stderr.write(text);

/**
 * Given a package exports field (or any nested value), return the first
 * string entry point, preferring "import" > "default" > first value.
 * @param value - A package.json `exports` value, or any nested sub-object of one.
 * @returns The first string entry point found, or `undefined` when the value contains none.
 * @throws Never.
 */
function resolveExportsEntry(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  // Subpath map: { ".": ... } → unwrap the "." entry
  if ('.' in obj) return resolveExportsEntry(obj['.']);
  // Condition map: prefer import > default > first
  for (const key of ['import', 'default', ...Object.keys(obj)]) {
    if (key in obj) return resolveExportsEntry(obj[key]);
  }
  return undefined;
}

/**
 * Resolve config/human plugin specifiers into fully-formed load requests for the platform-neutral
 * loader. Each request keeps the original `spec` (recorded as `plugin.specifier`, so it matches the
 * matbot.yaml entry the user added) alongside the `importSpec` (a file: URL the loader actually
 * imports) and the `name`/`runtimes` read from the resolved package.json. Per the classifier:
 *  - local  → resolve package.json exports["."] so matbot.yaml can reference the package folder
 *             rather than a deep src/ path;
 *  - remote → fetch the module graph into `.plugins/` (idempotent; a restart loads from cache) and
 *             point at the cached entry — bare imports then resolve up to the host's node_modules;
 *  - npm / tarball / git → resolved through the project's module graph (pnpm installs them); a bare
 *             name passes through if not yet on disk so loadPlugins can emit the warning.
 *
 * This is the single funnel for both startup and runtime (`plugin add` / hot-load) resolution.
 * @param specifiers - Raw plugin specifiers in config order.
 * @param configDir - Project directory that paths, `.plugins/`, and node module resolution anchor against.
 * @returns One load request per input, in input order; unresolvable specifiers pass through unchanged so the loader can surface the failure.
 * @throws TypeError - When a `file:` specifier is malformed (via {@link readPluginMeta}).
 */
async function resolvePluginSpecifiers(specifiers: readonly string[], configDir: string): Promise<PluginLoadRequest[]> {
  const req = createRequire(path.join(configDir, '_'));
  const dotPlugins = path.join(configDir, '.plugins');
  const results: PluginLoadRequest[] = [];

  for (const spec of specifiers) {
    const classified = await classifySpecifier(spec, configDir);
    let importSpec: string;

    if (classified.kind === 'remote') {
      try {
        importSpec = pathToFileURL(await materializeRemote(spec, dotPlugins, configDir)).href;
      } catch (e) {
        console.warn(`[matbot] Could not fetch remote plugin "${spec}": ${e instanceof Error ? e.message : String(e)}`);
        results.push({ spec, importSpec: spec });  // unresolved — let loadPlugins surface the failure
        continue;
      }
    } else if (classified.kind === 'local' || classified.kind === 'missing-path') {
      const absDir = classified.kind === 'local' ? classified.dir : classified.resolved;
      importSpec = pathToFileURL(absDir).href;
      try {
        const pkg  = JSON.parse(await readFile(path.join(absDir, 'package.json'), 'utf8')) as Record<string, unknown>;
        const main = resolveExportsEntry(pkg['exports']);
        if (typeof main === 'string') importSpec = pathToFileURL(path.resolve(absDir, main)).href;
      } catch { /* no package.json or unparseable — import the directory */ }
    } else {
      // npm / pnpm-url: installed in node_modules under the package name (the stored specifier).
      try {
        importSpec = pathToFileURL(req.resolve(spec)).href;
      } catch {
        results.push({ spec, importSpec: spec });  // not on disk — let loadPlugins emit the warning
        continue;
      }
    }

    const meta = await readPluginMeta(importSpec, configDir);
    results.push({
      spec,
      importSpec,
      ...(meta.name     !== undefined ? { name:     meta.name }     : {}),
      ...(meta.runtimes !== undefined ? { runtimes: meta.runtimes } : {}),
    });
  }

  return results;
}

/**
 * Walk up from `start` until we find a file named `filename`, or return null.
 * @param filename - File name to look for in each directory.
 * @param start - Directory to start from; defaults to the process cwd.
 * @returns The absolute path of the first match, or `null` when the filesystem root is reached.
 * @throws Never.
 */
async function findUp(filename: string, start = process.cwd()): Promise<string | null> {
  let dir = path.resolve(start);
  while (true) {
    const candidate = path.join(dir, filename);
    try { await access(candidate); return candidate; } catch { /* not here */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;  // filesystem root
    dir = parent;
  }
}

/**
 * Check whether a filesystem path exists.
 * @param filePath - Path to test.
 * @returns `true` when the path is accessible, `false` otherwise (including on any access error).
 * @throws Never.
 */
async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

/**
 * Resolve after a delay.
 * @param ms - Delay in milliseconds.
 * @returns Resolves once the timer fires.
 * @throws Never.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resolve every `${NAME}` placeholder in a credentials record through the vault.
 * @param credentials - Map of credential name to raw placeholder text.
 * @param vault - Vault used to resolve placeholders (the live forwarding proxy).
 * @returns A new record with each value resolved.
 * @throws MissingSecretError - When a placeholder names a secret the vault cannot resolve.
 */
async function resolveCredentials(
  credentials: Record<string, string>,
  vault: Vault,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(credentials)) {
    resolved[k] = await vault.resolve(v);
  }
  return resolved;
}

/**
 * Resolve provider credentials at boot, prompting on the terminal for unresolved secrets.
 *
 * The bootstrap path needs the provider credential before any LLM exists, so it cannot
 * be gathered lazily via the `plugin store-key` tool. On a MissingSecretError, prompt
 * out-of-band for the unresolved keys, store them in the vault (which persists to .env),
 * and retry until every placeholder resolves.
 * @param credentials - Map of credential name to raw placeholder text.
 * @param vault - Vault to resolve against and to persist prompted secrets into.
 * @returns A record with every placeholder resolved.
 * @throws Error - When the user provides no value for a required secret; other vault errors propagate unchanged.
 */
async function resolveCredentialsInteractive(
  credentials: Record<string, string>,
  vault: Vault,
): Promise<Record<string, string>> {
  for (;;) {
    try {
      return await resolveCredentials(credentials, vault);
    } catch (e) {
      if (!(e instanceof MissingSecretError)) throw e;
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        for (const name of e.missingKeys) {
          const value = await rl.question(`Secret required — ${name}: `);
          if (!value.trim()) throw new Error(`No value provided for required secret "${name}".`);
          // writeSecret, not createSecret: the placeholder named this exact key, so store verbatim.
          await vault.writeSecret(name, value.trim());
        }
      } finally {
        rl.close();
      }
    }
  }
}

// Reused as the no-op signal fallback; never aborted.
const NEVER_ABORT_SIGNAL = new AbortController().signal;

// ── Arg parsing ────────────────────────────────────────────────────────────────

/**
 * Parsed command-line options for a matbot invocation. `config` always has a value
 * (defaulting to `./matbot.yaml`); every other field is present only when the corresponding
 * flag was supplied.
 */
interface CliOpts {
  provider?:   string;
  session?:    string;
  system?:     string;
  config:      string;
  promptFile?: string;
  ephemeral:   boolean;
  principal?:  string;
}

/**
 * Parse process.argv into options plus a positional prompt. Unknown flags are ignored;
 * bare positionals are collected in order and joined as the prompt.
 * @param argv - The full `process.argv` array; the first two entries are ignored.
 * @returns The parsed options and the joined positional prompt (`undefined` when there are none).
 * @throws Never - A `--help` flag prints usage via {@link printHelp} and exits the process.
 */
function parseArgs(argv: string[]): { opts: CliOpts; prompt: string | undefined } {
  const args = argv.slice(2);
  const opts: CliOpts = { config: './matbot.yaml', ephemeral: false };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case '--provider':    { const v = args[++i]; if (v !== undefined) opts.provider   = v; } break;
      case '--session':     { const v = args[++i]; if (v !== undefined) opts.session    = v; } break;
      case '--system':      { const v = args[++i]; if (v !== undefined) opts.system     = v; } break;
      case '--config':      { const v = args[++i]; if (v !== undefined) opts.config     = v; } break;
      case '--prompt-file': { const v = args[++i]; if (v !== undefined) opts.promptFile = v; } break;
      case '--principal':   { const v = args[++i]; if (v !== undefined) opts.principal  = v; } break;
      case '--ephemeral':   opts.ephemeral = true; break;
      case '--help': printHelp(); process.exit(0);
      default:
        if (!arg.startsWith('-')) positional.push(arg);
    }
  }

  return { opts, prompt: positional.length ? positional.join(' ') : undefined };
}

/**
 * Parse a principal supplied as a CLI flag or env var: either a bare id (type "user") or the JSON
 * `{"id","type"}` that spawners (e.g. the background plugin) write to MATBOT_PRINCIPAL.
 * @param raw - Raw flag/env value.
 * @returns The parsed principal, or `undefined` when the value is empty or not a valid id/JSON principal.
 * @throws Never.
 */
function parsePrincipalArg(raw: string): Principal | undefined {
  const s = raw.trim();
  if (s === '') return undefined;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s) as { id?: unknown; type?: unknown };
      if (typeof o.id === 'string' && o.id !== '' &&
          (o.type === 'user' || o.type === 'agent' || o.type === 'system')) {
        return { id: o.id, type: o.type };
      }
    } catch { /* fall through to invalid */ }
    return undefined;
  }
  return { id: s, type: 'user' };
}

/**
 * The process boot identity, resolved once at the entry. Precedence, most specific first:
 *   --principal flag  →  MATBOT_PRINCIPAL env  →  config principal:  →  system.
 * The env slot is the cross-process transport: a parent (pod/sandbox, or the background plugin
 * delegating its creator) sets it; the child re-establishes that identity here.
 * @param opts - Parsed CLI options; `opts.principal` wins when present.
 * @param config - Loaded matbot config supplying the `principal:` fallback.
 * @returns The boot principal.
 * @throws Error - When `--principal` or `MATBOT_PRINCIPAL` is present but invalid.
 */
function resolveBootPrincipal(opts: CliOpts, config: import('./config.js').MatbotConfig): Principal {
  if (opts.principal !== undefined) {
    const p = parsePrincipalArg(opts.principal);
    if (p === undefined) throw new Error(`Invalid --principal "${opts.principal}". Use an id (e.g. "alice") or JSON {"id","type"}.`);
    return p;
  }
  const env = process.env['MATBOT_PRINCIPAL'];
  if (env !== undefined && env.trim() !== '') {
    const p = parsePrincipalArg(env);
    if (p === undefined) throw new Error(`Invalid MATBOT_PRINCIPAL "${env}". Use an id or JSON {"id","type"}.`);
    return p;
  }
  if (config.principal !== undefined) return config.principal;
  return systemPrincipal();
}

// ── Cortex workspaces ────────────────────────────────────────────────────────

/**
 * Check whether a value looks like a filesystem path rather than a bare package specifier.
 * @param value - Raw specifier text.
 * @returns `true` for relative, absolute, or drive-letter paths on any platform.
 * @throws Never.
 */
function isPathLikeSpecifier(value: string): boolean {
  return value.startsWith('.') || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Absolutize a Node CLI option value against `baseDir`, converting path-like values to `file:`
 * URLs for the module-loading flags.
 * @param flag - The option flag the value belongs to; `--import`/`--loader`/`--experimental-loader` get `file:` URLs, others get absolute paths.
 * @param value - The option value; returned unchanged when not path-like.
 * @param baseDir - Directory relative paths resolve against.
 * @returns The absolutized (possibly URL-form) value.
 * @throws Never.
 */
function absolutizeNodeOptionValue(flag: string, value: string, baseDir: string): string {
  if (!isPathLikeSpecifier(value)) return value;
  const absolute = path.isAbsolute(value) ? value : path.resolve(baseDir, value);
  return flag === '--import' || flag === '--loader' || flag === '--experimental-loader'
    ? pathToFileURL(absolute).href
    : absolute;
}

/**
 * Rewrite a Node `execArgv` so every path-bearing option (`--env-file`, `--import`, `--loader`,
 * `--require`, and aliases) is absolutized against `baseDir`, surviving a child process that
 * runs from a different working directory.
 * @param args - Original execArgv entries (values may be attached with `=` or follow the flag).
 * @param baseDir - Directory relative paths resolve against.
 * @returns A new array with path values absolutized; non-path entries pass through unchanged.
 * @throws Never.
 */
function absolutizeNodeExecArgv(args: readonly string[], baseDir: string): string[] {
  const pathValueFlags = new Set([
    '--env-file',
    '--env-file-if-exists',
    '--experimental-loader',
    '--import',
    '--loader',
    '--require',
    '-r',
  ]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      const flag = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      out.push(pathValueFlags.has(flag) ? `${flag}=${absolutizeNodeOptionValue(flag, value, baseDir)}` : arg);
      continue;
    }
    out.push(arg);
    if (pathValueFlags.has(arg) && i + 1 < args.length) {
      out.push(absolutizeNodeOptionValue(arg, args[++i]!, baseDir));
    }
  }
  return out;
}

/**
 * Express the CLI's own entry point as a specifier the child process can resolve from its own
 * working directory: a relative path when possible, otherwise an absolute `file:` URL.
 * @param entryArg - The current entry (typically `process.argv[1]`), a path or `file:` URL.
 * @param baseDir - Directory relative entry paths resolve against.
 * @param childCwd - Working directory the child will run in.
 * @returns A relative path or `file:` URL usable as the child's entry argument.
 * @throws Never.
 */
function nodeEntrySpecifier(entryArg: string, baseDir: string, childCwd: string): string {
  const absolute = entryArg.startsWith('file:')
    ? fileURLToPath(entryArg)
    : path.isAbsolute(entryArg) ? entryArg : path.resolve(baseDir, entryArg);
  const relative = path.relative(childCwd, absolute);
  return relative !== '' && !path.isAbsolute(relative) ? relative : pathToFileURL(absolute).href;
}

/**
 * Compute the out/err log file paths for a spawned replacement process, creating the shared
 * `logs` directory (sibling of the workspace registry's parent directory) if needed.
 * @param registryPath - Path of the cortex-workspaces registry file.
 * @returns Paths of `matbot.out.log` and `matbot.err.log` inside the logs directory.
 * @throws Error - When the logs directory cannot be created.
 */
function matbotLogPaths(registryPath: string): { out: string; err: string } {
  const logsDir = path.resolve(path.dirname(registryPath), '..', 'logs');
  mkdirSync(logsDir, { recursive: true });
  return {
    out: path.join(logsDir, 'matbot.out.log'),
    err: path.join(logsDir, 'matbot.err.log'),
  };
}

/**
 * Print CLI usage to stderr.
 * @returns Nothing.
 * @throws Never.
 */
function printHelp(): void {
  process.stderr.write(`
matbot — AI CLI

Usage:
  matbot [options] [prompt]

Options:
  --provider    <name>      Provider key from matbot.yaml (default: first in file)
  --session     <id>|create Resume an existing session, or "create" to start a new persistent one
  --system      <text>      System prompt injected at session start
  --config      <path>      Config file path (default: ./matbot.yaml)
  --prompt-file <path>      Read prompt from file; run single turn and exit
  --ephemeral               Keep sessions, memory, settings, and plugin stores in memory only
  --principal   <id|json>   Boot identity: an id (type "user") or JSON {"id","type"}.
                            Overrides MATBOT_PRINCIPAL and config principal:.
  --help                    Show this help

Sessions are ephemeral by default (discarded on exit). Use --session create to persist,
or --session <id> to resume a previously persisted session.

If [prompt] and --prompt-file are both omitted, starts an interactive REPL.
`.trimStart());
}

// ── Single turn ────────────────────────────────────────────────────────────────

// ── Main ───────────────────────────────────────────────────────────────────────

// ── Setup wizard ───────────────────────────────────────────────────────────────

/**
 * A provider adapter package discovered in the monorepo, pairing its directory name (`type`)
 * with its package `name` and location on disk.
 */
interface ProviderPackage { type: string; name: string; dir: string; }

/**
 * Scan the monorepo's provider plugin directory (resolved relative to this module's location)
 * for packages with a readable package.json.
 * @returns One entry per discovered provider package, in directory listing order; empty when the directory is missing or unreadable.
 * @throws Never.
 */
async function discoverProviders(): Promise<ProviderPackage[]> {
  const thisDir      = path.dirname(fileURLToPath(import.meta.url));
  const providersDir = path.resolve(thisDir, '../../../packages/plugins/providers');
  let entries: string[];
  try { entries = await readdir(providersDir); } catch { return []; }
  const results: ProviderPackage[] = [];
  for (const entry of entries) {
    const dir = path.join(providersDir, entry);
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      if (typeof pkg['name'] === 'string') results.push({ type: entry, name: pkg['name'] as string, dir });
    } catch { /* skip entries without a readable package.json */ }
  }
  return results;
}

/**
 * Probe an endpoint with a HEAD request (5s timeout) to sanity-check the URL entered during setup.
 * @param url - Endpoint URL to test.
 * @returns `false` when reachable, otherwise a diagnostic message — including a credentials hint for 401/403 responses.
 * @throws Never.
 */
async function testEndpointReachable(url: string): Promise<string | false> {
  try {
    const { status, statusText } = (await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }));
    return (status == 401 || status == 403) ? `Endpoint reachable but returned ${statusText} (check credentials)` : false;
  } catch (ex: any) {
    return `Endpoint failed (${ex?.message ?? String(ex)})`;
  }
}

/**
 * Interactive first-run wizard: prompts (stdin/stderr) for a provider type, name, model,
 * endpoint, and API key; appends the key to `<configDir>/.env`; writes a minimal matbot.yaml
 * with a relative module path; and returns the equivalent in-memory config. Declining an
 * unreachable-endpoint warning exits the process with code 1.
 * @param configPath - Path the generated matbot.yaml is written to.
 * @returns A config containing just the newly created provider.
 * @throws Error - When no provider packages can be discovered.
 */
async function runSetupWizard(configPath: string): Promise<import('./config.js').MatbotConfig> {
  const rl  = createInterface({ input: process.stdin, output: process.stderr });
    /**
     * Prompt on stderr and return the trimmed answer.
     * @param question - Question text (a `: ` suffix is appended).
     * @returns The trimmed user input.
     * @throws Error - Propagates readline errors when stdin closes or fails.
     */
    const ask = async (question: string): Promise<string> => {
    const answer = await rl.question(`${question}: `);
    return answer.trim();
  };
  /** Read a terminal secret without echoing it. Non-TTY callers retain normal readline behavior. */
  const askSecret = async (question: string): Promise<string> => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return ask(question);
    rl.pause();
    process.stderr.write(`${question}: `);
    return new Promise<string>((resolve, reject) => {
      let value = '';
      const stdin = process.stdin;
      const done = (error?: Error): void => {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        rl.resume();
        process.stderr.write('\n');
        if (error) reject(error); else resolve(value.trim());
      };
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          if (byte === 3) { done(new Error('Secret entry cancelled.')); return; }
          if (byte === 13 || byte === 10) { done(); return; }
          if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue; }
          if (byte >= 32) value += String.fromCharCode(byte);
        }
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    });
  };

  try {
    process.stderr.write('\nNo providers configured. Let\'s set one up.\n\n');

    const discovered = await discoverProviders();
    if (discovered.length === 0) {
      throw new Error('No provider packages found. Cannot continue setup.');
    }

    process.stderr.write('Available provider types:\n');
    for (let i = 0; i < discovered.length; i++) {
      process.stderr.write(`  ${i + 1}. ${discovered[i]!.type}  (${discovered[i]!.name})\n`);
    }
    process.stderr.write('\n');

    let chosen!: ProviderPackage;
    for (;;) {
      const choice = await ask(`Choose a type [1-${discovered.length}]`);
      const n = parseInt(choice, 10);
      if (n >= 1 && n <= discovered.length) { chosen = discovered[n - 1]!; break; }
      process.stderr.write(`Please enter a number between 1 and ${discovered.length}.\n`);
    }

    let providerName = '';
    for (;;) {
      providerName = await ask(`Provider name (how this LLM key is named in ${configPath} and presented to you)`);
      if (providerName) break;
      process.stderr.write('Provider name is required.\n');
    }

    let model = '';
    for (;;) {
      model = await ask('Model name');
      if (model) break;
      process.stderr.write('Model name is required.\n');
    }

    const isOpenRouter = chosen.type === 'openrouter';
    let endpoint = await ask(isOpenRouter ? 'Endpoint URL (blank uses https://openrouter.ai/api/v1)' : 'Endpoint URL');
    if (isOpenRouter && !endpoint) endpoint = 'https://openrouter.ai/api/v1';
    const apiKey = await askSecret('API key');

    if (endpoint && !endpoint.startsWith('http') && !isOpenRouter) {
      process.stderr.write(`\nTesting ${endpoint}… `);
      const reachable = await testEndpointReachable(endpoint);
      if (!reachable) {
        process.stderr.write('reachable\n');
      } else {
        process.stderr.write(reachable + '\n');
        const cont = await ask('Continue with this endpoint anyway? [y/N]');
        if (cont.toLowerCase() !== 'y') {
          process.stderr.write('Setup cancelled.\n');
          process.exit(1);
        }
      }
    }
    const configDir  = path.dirname(configPath);
    const envPath    = path.join(configDir, '.env');
    const envVarName = `MATBOT_API_KEY_${providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

    let envContent = '';
    try { envContent = await readFile(envPath, 'utf8'); } catch { /* no existing .env */ }
    const envLines = envContent
      ? envContent.split('\n').filter(l => !l.startsWith(`${envVarName}=`) && l !== '')
      : [];
    envLines.push(`${envVarName}=${apiKey}`);
    await writeFile(envPath, envLines.join('\n') + '\n', 'utf8');
    process.env[envVarName] = apiKey;

    // Write a relative path so the config is self-contained regardless of where matbot is installed.
    const relDir = path.relative(configDir, chosen.dir).replace(/\\/g, '/');
    const moduleSpec = relDir.startsWith('.') ? relDir : `./${relDir}`;

    if (providerName !== providerName.trim() || /[\u0000-\u001f\u007f:#]/.test(providerName)) {
      throw new Error('Provider name must be a non-empty single-line name without YAML control characters.');
    }
    const yaml = [
      'providers:',
      `  ${providerName}:`,
      `    module: ${serializeYamlScalar(moduleSpec)}`,
      `    endpoint: ${serializeYamlScalar(endpoint)}`,
      `    model: ${serializeYamlScalar(model)}`,
      `    credentials:`,
      `      apiKey: ${serializeYamlScalar(`\${${envVarName}}`)}`,
    ].join('\n') + '\n';

    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, yaml, 'utf8');
    process.stderr.write(`\nConfiguration written to ${configPath}\n\n`);

    return {
      plugins:   [],
      providers: new Map([[providerName, {
        name:        providerName,
        module:      moduleSpec,
        model,
        credentials: { apiKey },
        endpoint,
      }]]),
    };
  } finally {
    rl.close();
  }
}

/**
 * CLI entry point: dispatch the `install` subcommand, load configuration (from stdin via
 * `--config -`, or from disk through the workspace manager, falling back to the setup wizard),
 * establish the ambient principal carrier and boot principal, assemble the service machine
 * (vault, stores, storage pre-scan, deferred-swap machinery), load plugins, and hand off to
 * server mode or the interactive/single-turn CLI frontend.
 * @returns Resolves when the CLI frontend finishes (the runtime is released afterwards); in server mode it resolves once SIGINT/SIGTERM shutdown handlers are wired and the process waits on them.
 * @throws Error - On boot failures: invalid `--principal`/`MATBOT_PRINCIPAL`, unreadable or invalid config, `--config -` without a prompt, an unknown provider, a missing CLI frontend, or a frontend plugin that failed to load in server mode.
 */
async function main(): Promise<void> {
  const initialCwd = process.cwd();
  const serverMode = process.argv[2] === 'start';
  const restartDelay = Number(process.env['CORTEX_RESTART_DELAY_MS'] ?? '0');
  if (serverMode && Number.isFinite(restartDelay) && restartDelay > 0) await sleep(restartDelay);

  // ── install subcommand ────────────────────────────────────────────────────
  if (process.argv[2] === 'install') {
    const specifier = process.argv.slice(3).find(a => !a.startsWith('-'));
    if (!specifier) {
      process.stderr.write('Usage: matbot install <package>\n');
      process.exit(1);
    }
    const configFlag = process.argv.indexOf('--config');
    const configArg  = configFlag !== -1 ? process.argv[configFlag + 1] : undefined;
    const configPath = configArg !== undefined
      ? path.resolve(configArg)
      : (await findUp('matbot.yaml')) ?? path.resolve('matbot.yaml');
    await installPlugin(specifier, configPath);
    return;
  }

  const { opts, prompt: parsedPrompt } = parseArgs(process.argv);

  // ── Config loading ────────────────────────────────────────────────────────────

  let matbotConfig!: import('./config.js').MatbotConfig;
  let configPath: string;
  let workspaceManager: FileWorkspaceManager | undefined;

  if (opts.config === '-') {
    // Read YAML from stdin; project root anchors to the base config via extends:
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (c: Buffer) => chunks.push(c));
      process.stdin.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    });
    const { config, projectDir } = await loadConfigFromText(text, process.cwd());
    matbotConfig = config;
    configPath   = path.join(projectDir, 'matbot.yaml'); // virtual — used for plugin resolution
    process.chdir(projectDir);
    await loadDotEnv(projectDir);
  } else {
    // Resolve relative paths against INIT_CWD (set by pnpm/npm to the directory
    // from which the user ran the package manager) so --config foo.yaml lands
    // next to the user's project, not inside the CLI package directory.
    const userCwd = process.env['INIT_CWD'] ?? initialCwd;
    const requestedConfigPath = opts.config === './matbot.yaml'
      ? (await findUp('matbot.yaml')) ?? path.resolve(userCwd, 'matbot.yaml')
      : path.isAbsolute(opts.config) ? opts.config : path.resolve(userCwd, opts.config);
    const registryPath = process.env['CORTEX_WORKSPACES_FILE'] !== undefined
      ? path.resolve(process.env['CORTEX_WORKSPACES_FILE'])
      : path.join(path.dirname(requestedConfigPath), 'cortex-workspaces.json');
    workspaceManager = new FileWorkspaceManager(registryPath, requestedConfigPath);
    configPath = await workspaceManager.selectConfigPath();
    process.chdir(path.dirname(configPath));
    await loadDotEnv(path.dirname(configPath));
    let loadResult: { config: import('./config.js').MatbotConfig; projectDir: string } | null = null;
    try {
      loadResult = await loadConfig(configPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    if (loadResult !== null) {
      matbotConfig = loadResult.config;
      if (loadResult.projectDir !== path.dirname(configPath)) {
        process.chdir(loadResult.projectDir);
        configPath = path.join(loadResult.projectDir, 'matbot.yaml');
      }
    }
    if (loadResult === null || matbotConfig!.providers.size === 0) {
      matbotConfig = await runSetupWizard(configPath);
    }
  }

  // Merge prompt sources: CLI flag/arg > config file
  const argPrompt = opts.promptFile !== undefined
    ? await readFile(path.resolve(opts.promptFile), 'utf8')
    : (parsedPrompt ?? matbotConfig.prompt);

  // Ephemeral by default; opt into persistence with --session <id|create>.
  // config ephemeral:true (e.g. background sub-agents) is a hard override.
  // `start` is exempt from the session-less default: a server hosts many sessions over a long life and
  // has no single `--session` to name, so inferring "throwaway" from its absence silently downgraded
  // every store — sessions, remembered_facts, skills, triggers — to a MemoryStore that dies with the
  // process. Persistence must not depend on a launcher remembering to pass a flag.
  const isEphemeral = opts.ephemeral || matbotConfig.ephemeral === true || (!serverMode && opts.session === undefined);

  // Guard: stdin config without a prompt would consume stdin then hang on REPL
  if (opts.config === '-' && argPrompt === undefined) {
    throw new Error('--config - requires a prompt: field in the config or a positional prompt argument.');
  }

  // ── Plugin setup ─────────────────────────────────────────────────────────────

  // Install the ambient security carrier before anything that could read it. The node app uses an
  // AsyncLocalStorage carrier so concurrent turns / frontend requests stay isolated; entering the
  // boot principal here gives the CLI process its identity for any out-of-turn backend access
  // (frontend handlers and per-turn pumps shadow it with their own principal via runAs). The boot
  // identity is resolved at this entry — flag → MATBOT_PRINCIPAL → config → system — so a pod or a
  // delegating parent (the background plugin) can supply it without any shared-package env reads.
  installPrincipalCarrier(createAlsPrincipalCarrier());
  enterPrincipal(resolveBootPrincipal(opts, matbotConfig));

  // The vault is a capture-safe forwarding proxy over a swappable backend (mirrors StorageBackend):
  // EnvFileVault by default, replaced when a plugin calls register('Vault', impl). References to
  // `services.Vault` / `ctx.vault` captured before the swap keep resolving to the live impl.
  let activeVault: Vault = new EnvFileVault(
    path.join(path.dirname(configPath), '.env'),
    process.env as Record<string, string | undefined>,
  );
  const vault: Vault = forwardingProxy<Vault>(() => activeVault);

  // ── Stores (created early so plugins like frontend-web can use them) ──────────

  const dotData  = workspaceDataDirectory(configPath);
  const dataDir  = path.join(dotData, 'sessions');
  const workDir  = path.join(dotData, 'bash-cwd');
  const filesDir = path.join(dotData, 'files');

  // Resolve plugin specifiers here so we can pre-scan for a storage backend before
  // creating stores. Node caches the imported modules, so loadPlugins below is free.
  const providerModules: string[] = [];
  const seenProviderModules = new Set<string>();
  for (const cfg of matbotConfig.providers.values()) {
    const mod = cfg.module;
    if (!seenProviderModules.has(mod)) {
      seenProviderModules.add(mod);
      providerModules.push(mod);
    }
  }
  const resolvedProviderMods = await resolvePluginSpecifiers(providerModules, path.dirname(configPath));
  const capabilityProfile=selectCapabilityProfile(process.env.CORTEX_CAPABILITY_PROFILE??matbotConfig.capabilityProfile);
  const selectedPlugins=profilePlugins(capabilityProfile,matbotConfig.plugins,workspaceManager!==undefined,name=>fileURLToPath(new URL(name==='file-broker-tool'?'../../../plugins/file-broker':'../../../packages/plugins/'+name,import.meta.url)));
  const resolvedSelections=await resolvePluginSpecifiers(selectedPlugins,path.dirname(configPath));
  const selectedNames=new Set<string>();
  const resolvedPluginMods=resolvedSelections.filter(request=>{const key=request.name??request.importSpec;if(selectedNames.has(key))return false;selectedNames.add(key);return true;});
  const allSpecifiers        = [...resolvedProviderMods, ...resolvedPluginMods];

  // A plugin with storageBackend replaces the default filesystem stores.
  // It must be listed before any plugin whose setup() calls createStore.
  let activeStorageBackend: StorageBackend | undefined;
  let knowledgeImpl: KnowledgeIndex = new LookupKnowledgeIndex();
  // Capture-safe service handles (see forwardingProxy): a captured reference — including a destructure
  // like `const { KnowledgeIndex, StorageBackend } = services` — keeps resolving to the live impl across
  // a register()-driven swap, instead of pinning whatever was current at capture time.
  const knowledgeProxy      = forwardingProxy<KnowledgeIndex>(() => knowledgeImpl);
  const storageBackendProxy = forwardingProxy<StorageBackend>(() => activeStorageBackend);

  // The host's own boot base — captured *before* the pre-scan, so it is always the app default
  // (filesystem/memory), never a config-supplied backend. A StorageBackend swap reverts here when its
  // providing plugin is unloaded. A pre-scanned backend is treated as plugin-owned (see storageBootSpec
  // below), so unloading it lands on this same base.
  const bootBackend: StorageBackend | undefined = activeStorageBackend;
  const bootFileStore: FileStore = new FilesystemFileStore(filesDir);

  // The config entry of the plugin whose storageBackend the pre-scan opened, if any. Recorded against
  // its plugin name once the loader has resolved names, so its unload reverts storage like a register().
  let storageBootSpec: string | undefined;
  for (const { spec, importSpec } of isEphemeral ? [] : allSpecifiers) {
    try {
      const mod  = await import(/* @vite-ignore */ importSpec) as Record<string, unknown>;
      const plug = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
      if (plug?.storageBackend !== undefined) {
        activeStorageBackend = await plug.storageBackend.open(dotData);
        storageBootSpec = spec;
        break;
      }
    } catch { /* loadPlugins will surface errors */ }
  }

  if (activeStorageBackend === undefined) {
    const mkdirs: Promise<unknown>[] = [mkdir(filesDir, { recursive: true })];
    // Only create the sessions directory when we'll actually write to it.
    if (!isEphemeral) mkdirs.push(mkdir(dataDir, { recursive: true }));
    await Promise.all(mkdirs);
  }

  // Each Store and FileStore is a forwarding proxy (forwardingProxy/makeSwappable, shared with the
  // web bundle) backed by a mutable `current` target. Callers may freely capture references — all
  // method calls route through the proxy to whichever backend is current. register('StorageBackend',
  // …) calls each proxy's swap fn.
  /** Any {@link Store} regardless of document type; the erase target for the per-namespace proxies. */
  type AnyStore = Store<{ id: string; version: string }>;

  // One proxy per namespace, including 'sessions'. Keyed by namespace string.
  const storeProxies = new Map<string, [AnyStore, SwapFn<AnyStore>]>();

  /**
   * Create the concrete store for one namespace against the current storage state.
   * @param namespace - Namespace name (e.g. 'sessions').
   * @returns A {@link MemoryStore} when ephemeral, otherwise the active backend's store or the filesystem fallback.
   * @throws Error - Propagated from a configured backend's `createStore` (see {@link createWorkspaceStore}).
   */
  const makeStoreForNamespace = (namespace: string): AnyStore => createWorkspaceStore({
    ephemeral: isEphemeral,
    namespace,
    dotData,
    sessionsDir: dataDir,
    ...(activeStorageBackend === undefined ? {} : { backend: activeStorageBackend }),
  });

  /**
   * Create (or reuse) the forwarding-proxy store for a namespace. One proxy exists per namespace
   * for the life of the process, so every caller captures the same swap-safe reference.
   * @typeParam T - Document type the caller reads and writes through the proxy.
   * @param namespace - Namespace name keying the proxy.
   * @returns The shared proxy store for the namespace, typed to `T`.
   * @throws Error - Propagated from store creation (see {@link makeStoreForNamespace}).
   */
  const createStore = <T extends { id: string; version: string }>(namespace: string): Store<T> => {
    let entry = storeProxies.get(namespace);
    if (entry === undefined) {
      entry = makeSwappable<AnyStore>(makeStoreForNamespace(namespace));
      storeProxies.set(namespace, entry);
    }
    return entry[0] as Store<T>;
  };

  // sessions and fileStore are stable proxy references — safe to capture anywhere.
  const store     = createStore<Session>('sessions');

  // Boot defaults, captured for revert-on-unregister: a plugin that swaps a core service in via
  // register() reverts to these when it is unloaded, instead of leaving a dangling reference to the
  // now-gone impl. (bootBackend/bootFileStore are captured above, before the pre-scan, so a
  // config-supplied backend never poses as the host base.)
  const bootVault                  = activeVault;
  const bootKnowledge              = knowledgeImpl;

  // The live file proxy starts on the pre-scanned backend (if any), falling back to the host base.
  const [fileStore, swapFiles] = makeSwappable<FileStore>(activeStorageBackend?.fileStore ?? bootFileStore);

  /**
   * Re-point every store proxy and the file proxy at `next` (or the host base when undefined).
   *
   * Returns whether anything actually changed, so the caller can skip a redundant `mounted` emit.
   * Synchronous: the repoint completes before this returns, so readers see `next` at once and the
   * `mounted` emit can fire immediately. The displaced backend is closed in the *background* — a
   * slow or throwing close() (e.g. node:sqlite's db.close() rejecting on a still-open statement)
   * must never gate the swap or suppress the mounted notification, which was the cause of a swap
   * that "only took on the 2nd try". Driven only from the quiescent-edge flush — never mid-turn.
   * @param next - Incoming backend, or `undefined` to revert every proxy to the host base.
   * @returns Whether any proxy actually changed targets.
   * @throws Never - The displaced backend's `close()` is settled in the background; failures are logged, never propagated.
   */
  const swapStorage = (next: StorageBackend | undefined): boolean => {
    const removed = activeStorageBackend;
    if (removed === next) return false;
    activeStorageBackend = next;
    for (const [ns, [, swap]] of storeProxies) swap(makeStoreForNamespace(ns));
    swapFiles(next?.fileStore ?? bootFileStore);
    void Promise.resolve(removed?.close?.()).catch(e => console.error('[matbot] closing displaced StorageBackend:', e));
    return true;
  };

  // Deferred StorageBackend swap. register/unregister('StorageBackend') stage the desired backend here
  // (last write wins — only the final intended backend matters, so a slot, not a queue) and ask the
  // context-switch machinery to land it at the next quiescent edge. Swapping the system of record under
  // a running turn would split a compare-and-swap across two backends, so the apply waits for depth 0.
  // The mount table batches mount notifications to the quiescent edge: register/unregister mark a key
  // dirty; the edge computes each key's net presence transition (mount / remount / committed unload) and
  // multicasts to that key's subscribers. A reload (unregister+register within one turn) collapses to a
  // single remount. Notification timing is deliberately unspecified — see the `Mounted` contract.
  const mountTable = createMountTable(() => services);
  let pendingSwap: { next: StorageBackend | undefined } | undefined;
  /**
   * Stage the desired `StorageBackend` for the deferred swap (last write wins — only the final
   * intent matters, so a slot, not a queue) and ask the context-switch machinery to apply it at
   * the next quiescent edge.
   * @param next - Backend to apply, or `undefined` to revert to the host base.
   * @returns Nothing.
   * @throws Never.
   */
  const stageSwap = (next: StorageBackend | undefined): void => {
    pendingSwap = { next };
    flushIfQuiescent();
  };
  onContextQuiesce(() => {
    if (pendingSwap !== undefined) {
      const { next } = pendingSwap;
      pendingSwap = undefined;
      if (swapStorage(next)) mountTable.markDirty('StorageBackend');
    }
    mountTable.flush();
  });

  /**
   * Swap the KnowledgeIndex, draining the displaced impl's entries into the incoming one.
   * @param next - Incoming implementation; a no-op when it is already the current one.
   * @returns Nothing.
   * @throws Never.
   */
  const swapKnowledge = (next: KnowledgeIndex): void => {
    const prev = knowledgeImpl;
    if (prev === next) return;
    knowledgeImpl = next;
    if (prev.entries !== undefined) for (const e of prev.entries()) void next.index(e);
  };

  // toolReg is shared: plugins register into it via services, runSession reads it
  const toolReg = new ToolRegistryImpl();

  // hookReg is shared: plugins register hooks via services, runSession fires them
  const hookReg = new HookRegistry();
  const systemContextReg = new SystemContextRegistryImpl();

  const serviceRegistry     = new Map<string, unknown>();

  // Constructed just after the services object (it closes over services.loadPlugin); exposed via
  // the `run` getter below so frontends submit/observe through one serialiser instead of each
  // calling runSession directly.
  let sessionRunner: SessionRunner | undefined;

  const baseServices: MatbotMachine = {
    /**
     * Placeholder settings accessor on the base machine.
     *
     * Plugins always receive the plugin-scoped override built in setupPlugin; the base is never the
     * one a plugin calls. Core reads its reserved settings doc via makePluginSettings directly.
     * @returns Never returns.
     * @throws Error - Always; use the services instance passed to `setup()`.
     */
    settings(): PluginSettings {
      throw new Error('settings() is only available within a plugin scope (use the services passed to setup()).');
    },

    createStore,

    /**
     * Read a non-core service from the plain service registry.
     * @param key - Registry key (the interface name).
     * @returns The registered value (typed as `never` so augmentation narrows at the call site), or `undefined` when absent.
     * @throws Never.
     */
    get(key) { return serviceRegistry.get(key as string) as never; },
    /**
     * Register a service implementation, special-casing the swappable core members.
     *
     * StorageBackend is the system of record: it is staged and the quiescent edge applies it (idle →
     * now; mid-turn → at turn end) — its mount notification is marked dirty there, after the swap
     * lands. The other swap-keys repoint immediately, then mark dirty so the edge multicasts the mount.
     * @param key - Service key; `StorageBackend`, `KnowledgeIndex`, and `Vault` are handled specially.
     * @param value - Implementation to register (a backend instance for the swap-keys).
     * @returns Nothing.
     * @throws Error - When ephemeral and the incoming backend's `close()` fails.
     */
    async register(key, value) {
      if (key === 'StorageBackend') {
        if (isEphemeral) await (value as StorageBackend).close?.();
        else stageSwap(value as StorageBackend);
      }
      else if (key === 'KnowledgeIndex') swapKnowledge(value as KnowledgeIndex);
      else if (key === 'Vault')          activeVault = value as Vault;
      else serviceRegistry.set(key as string, value);
      if (key !== 'StorageBackend') { mountTable.markDirty(key); flushIfQuiescent(); }
    },
    /**
     * Remove a service, symmetric with {@link register}: a swap-key reverts to the app's captured
     * boot default instead of dangling on the unloaded plugin's impl; everything else is a plain
     * registry delete. Marking dirty lets the edge deliver a committed unload (or, if re-registered
     * before the edge, a single remount).
     * @param key - Service key to remove.
     * @returns Nothing.
     * @throws Never.
     */
    unregister(key: string) {
      if (key === 'StorageBackend') {
        if (!isEphemeral) stageSwap(bootBackend);
      }
      else if (key === 'KnowledgeIndex') knowledgeImpl = bootKnowledge;
      else if (key === 'Vault')          activeVault = bootVault;
      else serviceRegistry.delete(key);
      if (key !== 'StorageBackend') { mountTable.markDirty(key as keyof MatbotServices); flushIfQuiescent(); }
    },
    /**
     * No-op on the base machine; real transport binding happens per plugin in setupPlugin's scopedServices.
     * @returns Nothing.
     * @throws Never.
     */
    registerFrontend() { /* bound per-plugin in setupPlugin's scopedServices; base is a no-op */ },

    /**
     * Run a single non-interactive completion: resolve the named provider's config (credentials and
     * endpoint through the vault), stream the response, and aggregate text plus token usage. An
     * optional `system` prompt is prepended as a system message; a missing signal defaults to a
     * never-aborted one.
     * @param req - Completion request naming a configured provider.
     * @returns The full response text with input/output token usage.
     * @throws Error - When the provider name is unknown, a credential cannot be resolved ({@link MissingSecretError}), or the provider adapter fails.
     */
    async complete(req) {
      const rawCfg = matbotConfig.providers.get(req.provider);
      if (rawCfg === undefined) {
        throw new Error(
          `complete(): unknown provider "${req.provider}". ` +
          `Available: ${[...matbotConfig.providers.keys()].join(', ')}`,
        );
      }
      const resolved: ProviderConfig = {
        ...rawCfg,
        ...(rawCfg.credentials !== undefined ? { credentials: await resolveCredentials(rawCfg.credentials, vault) } : {}),
        ...(rawCfg.endpoint    !== undefined ? { endpoint: await vault.resolve(rawCfg.endpoint) } : {}),
      };
      const adpt = resolveProviderFactory(resolved.module)(resolved);
      const msgs = req.system !== undefined
        ? [
            createMessage({
              role:    'system',
              content: [{ type: 'text', text: req.system }],
              traceId: crypto.randomUUID(),
            }),
            ...req.messages,
          ]
        : req.messages;
      const signal = req.signal ?? NEVER_ABORT_SIGNAL;
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const ev of adpt.complete(msgs, resolved, [], signal)) {
        if (ev.type === 'text-delta') text += ev.delta;
        if (ev.type === 'usage') { inputTokens = ev.inputTokens; outputTokens = ev.outputTokens; }
      }
      return { text, usage: { inputTokens, outputTokens } };
    },
    /**
     * Run a single turn from a single-turn request shape, delegating to {@link complete}.
     * @param req - Single-turn request (prompt plus optional system/session bits).
     * @returns The aggregated response text and usage.
     * @throws Error - Same conditions as {@link complete}.
     */
    async singleTurn(req) {
      return this.complete(singleTurnRequest(req));
    },
    /**
     * Hot-load a plugin by specifier, bypassing the module cache and throwing on failure.
     * @param specifier - Plugin specifier (path, `file:` URL, or package name).
     * @param prompt - Optional user-prompt function handed to the plugin during setup.
     * @returns The freshly loaded plugin.
     * @throws Error - When resolution fails, the plugin fails to load (`onLoadError: 'throw'`), or no plugin results.
     */
    async loadPlugin(specifier: string, prompt?: PromptFn) {
      const resolved = await resolvePluginSpecifiers([specifier], path.dirname(configPath));
      const plugins  = await loadPluginsWithDescriptions(resolved, services, path.dirname(configPath), /* bustCache */ true, prompt, /* onLoadError */ 'throw');
      const plugin   = plugins[0];
      if (plugin === undefined) throw new Error(`No plugin loaded for specifier "${specifier}"`);
      return plugin;
    },
    /**
     * Unload a plugin by its config-level specifier (the matbot.yaml entry) or its canonical name;
     * no re-resolution is needed because `plugin.specifier` records the original specifier.
     * @param specifier - Config specifier or canonical plugin name.
     * @returns Whether a matching loaded plugin was found and unloaded; `false` (with a warning) when none matches.
     * @throws Error - Propagates unload-path failures from the core loader.
     */
    async unloadPlugin(specifier: string): Promise<boolean> {
      const name = getPluginNameForSpecifier(specifier)
        ?? (getRegisteredPlugins().some(p => p.name === specifier) ? specifier : undefined);
      if (name === undefined) {
        console.warn(`[matbot] No loaded plugin found for "${specifier}"`);
        return false;
      }
      return unloadPluginFn(name, services);
    },
    resolver:  nodePluginResolver(path.dirname(configPath)),
    providers: matbotConfig.providers,
    mounted:   mountTable.mounted,
    /**
     * Current storage backend, or `undefined` when none is active (ephemeral boot, no pre-scan hit).
     * @returns The live backend proxy, or `undefined` when none is active.
     * @throws Never.
     */
    get StorageBackend() { return activeStorageBackend === undefined ? undefined : storageBackendProxy; },
    sessions:  store,
    /**
     * The shared {@link SessionRunner} frontends submit and observe through.
     * @returns The runner once constructed (just after the services object), `undefined` before that.
     * @throws Never.
     */
    get run() { return sessionRunner; },
    files:     fileStore,
    Vault:     vault,
    hooks:          hookReg,
    tools:          toolReg,
    systemContext:  systemContextReg,
    workdir:    workDir,
    configPath,
    /**
     * Report whether this process runs as a background sub-agent.
     * @returns `true` when launched with `IS_SUB_AGENT=1`.
     * @throws Never.
     */
    isSubAgent: () => isBackground,
    /**
     * Live {@link KnowledgeIndex} proxy; always present (defaults to LookupKnowledgeIndex).
     * @returns The live knowledge-index proxy.
     * @throws Never.
     */
    get KnowledgeIndex() { return knowledgeProxy; },
  };
  const services: MatbotMachine = unifyServices(baseServices);
  // Authorization is available before the first plugin can expose a transport.
  serviceRegistry.set('ToolInvocationPolicy',freezeInvocationPolicy(matbotConfig.permissions??{defaultAction:'allow'}));
  if (capabilityProfile !== 'minimal') serviceRegistry.set('FileAccessSelection',{mode:capabilityProfile==='compatibility'?'http':'local'});

  /**
   * Shut the runtime down and give up its ports, but never let the shutdown itself become the reason
   * the process lingers: a hung teardown (a server close waiting on a keep-alive socket, a backend
   * that will not settle) used to leave the old process holding the web port forever, so the
   * replacement could never bind. Past the {@link SHUTDOWN_DEADLINE_MS} deadline we stop waiting and
   * resolve anyway.
   * @returns Resolves once teardown finishes or the deadline fires, whichever comes first.
   * @throws Never - Teardown failures are logged, never propagated.
   */
  const releaseRuntime = async (): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        console.error(`[matbot] shutdown did not complete within ${SHUTDOWN_DEADLINE_MS}ms; exiting anyway`);
        resolve();
      }, SHUTDOWN_DEADLINE_MS);
    });
    try {
      await Promise.race([
        teardownPlugins().then(async () => { await activeStorageBackend?.close?.(); }),
        deadline,
      ]);
    } catch (e) {
      console.error('[matbot] shutdown failed:', e instanceof Error ? e.message : String(e));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  if (workspaceManager !== undefined) {
    workspaceManager.setRestarter(async (workspaceId: string) => {
      if (!serverMode) return;
      if (process.env['CORTEX_SERVICE_SUPERVISED'] === '1') {
        console.error(`[matbot] workspace switch to "${workspaceId}" requested service-supervised restart`);
        setTimeout(() => { void releaseRuntime().then(() => process.exit(42)); }, 250);
        return;
      }
      const entryArg = process.argv[1] ?? fileURLToPath(import.meta.url);
      const childCwd = path.dirname(workspaceManager.getRegistryPath());
      const entry = nodeEntrySpecifier(entryArg, initialCwd, childCwd);
      const args = [...absolutizeNodeExecArgv(process.execArgv, initialCwd), entry, ...process.argv.slice(2)];
      const logs = matbotLogPaths(workspaceManager.getRegistryPath());

      // Deferred so the HTTP response for the switch request can flush before the server goes away.
      // The order below is the fix for a switch that "did nothing": this process releases its ports
      // FIRST and only then spawns its replacement. It used to spawn immediately and tear down on a
      // timer, betting that 900ms of child-side delay would outlast the teardown — and when it didn't,
      // the child could not bind, dropped its frontend, and ran on headless while the outgoing process
      // kept serving the old workspace to the browser.
      setTimeout(() => { void (async () => {
        await releaseRuntime();
        appendFileSync(
          logs.out,
          `[${new Date().toISOString()} ${_pid}] [matbot] restarting into workspace "${workspaceId}"\n`,
        );
        const outFd = openSync(logs.out, 'a');
        const errFd = openSync(logs.err, 'a');
        let child: ChildProcess;
        try {
          child = spawn(process.execPath, args, {
            cwd: childCwd,
            detached: true,
            stdio: ['ignore', outFd, errFd],
            env: {
              ...process.env,
              INIT_CWD: process.env['INIT_CWD'] ?? initialCwd,
              CORTEX_WORKSPACE_ID: workspaceId,
              CORTEX_WORKSPACES_FILE: workspaceManager.getRegistryPath(),
              // Only a margin for the OS to release the listening socket now that teardown has already
              // finished — no longer the thing the handoff depends on.
              CORTEX_RESTART_DELAY_MS: '400',
            },
          });
        } finally {
          closeSync(outFd);
          closeSync(errFd);
        }
        child.unref();
        process.exit(0);
      })(); }, 250);
    });
    const current = await workspaceManager.current();
    serviceRegistry.set('WorkspaceBootstrap', { manager: workspaceManager, context: Object.freeze({ id: current.id, configPath, registryPath: workspaceManager.getRegistryPath() }) });
    await loadPluginsWithDescriptions(await resolvePluginSpecifiers([
      fileURLToPath(new URL('../../../packages/plugins/workspace-manager', import.meta.url)),
    ], path.dirname(configPath)), services, path.dirname(configPath));
  }

  /**
   * Resolve a provider name to an adapter plus fully resolved config, reading
   * matbotConfig.providers lazily (per call), so it sees both the canonicalised module names and
   * any live `provider add/remove` edits.
   * @param name - Provider key from the config.
   * @returns The adapter and resolved config, or `null` when the name is unknown.
   * @throws MissingSecretError - When a credential placeholder cannot be resolved via the vault.
   */
  const resolveProvider = async (name: string): Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null> => {
    const cfg = matbotConfig.providers.get(name);
    if (cfg === undefined) return null;
    const resolved: ProviderConfig = {
      ...cfg,
      ...(cfg.credentials !== undefined ? { credentials: await resolveCredentials(cfg.credentials, vault) } : {}),
      ...(cfg.endpoint    !== undefined ? { endpoint: await vault.resolve(cfg.endpoint) } : {}),
    };
    return { adapter: resolveProviderFactory(resolved.module)(resolved), config: resolved };
  };

  /**
   * One runner per store: frontends share this one over the persistent sessions store, but the CLI
   * can instantiate its own over an ephemeral {@link MemoryStore} (see main). That a SessionRunner
   * composes over *any* Store is the point — nothing about the agentic loop is bound to a single
   * backend.
   * @param sessionStore - Store the runner reads and writes sessions through.
   * @returns A runner wired to the shared tools, hooks, providers, and stores.
   * @throws Never.
   */
  const makeRunner = (sessionStore: Store<Session>): SessionRunner => createSessionRunner({
    store:         sessionStore,
    resolveProvider,
    tools:         toolReg,
    hooks:         hookReg,
    systemContext: systemContextReg,
    vault,
    files:         fileStore,
    workdir:       workDir,
    configPath,
    loadPlugin:    services.loadPlugin.bind(services),
    unloadPlugin:  services.unloadPlugin.bind(services),
    permissions:()=>services.ToolInvocationPolicy,
    observability: () => services.get('Observability'),
  });

  sessionRunner = makeRunner(store);

  // Load provider plugins first so module names can be canonicalised before any
  // frontend plugin's setup() calls resolveProviderFactory(cfg.module).
  await loadPluginsWithDescriptions(resolvedProviderMods, services, path.dirname(configPath));

  // Canonicalise each provider config's module to the loaded plugin's name so that
  // resolveProviderFactory() (keyed by plugin.name) finds the factory regardless of
  // whether the config used an npm name, a relative path, or a file URL.
  for (const [key, cfg] of matbotConfig.providers) {
    // A loaded plugin records its config specifier (= cfg.module) as plugin.specifier.
    const pluginName = getPluginNameForSpecifier(cfg.module);
    if (pluginName !== undefined && pluginName !== cfg.module) {
      matbotConfig.providers.set(key, { ...cfg, module: pluginName });
    }
  }

  // Map plugin name → the original module specifier written in matbot.yaml.
  // Used by the provider tool so its description and list output show YAML-valid
  // specifiers, and so `provider add` writes a path the loader can resolve — never
  // the bare package name of a local plugin, which crashes startup.
  const pluginNameToOrigPath = new Map<string, string>();
  /**
   * Record each original specifier's plugin name into pluginNameToOrigPath (first occurrence wins).
   * plugin.specifier === the original config entry, so the name is looked up by that entry directly.
   * @param origs - Original config-level specifiers (provider modules, config plugins).
   * @returns Nothing.
   * @throws Never.
   */
  const recordOrigPaths = (origs: readonly string[]): void => {
    // plugin.specifier === the original config entry, so look up the name by that entry directly.
    for (const orig of origs) {
      const name = getPluginNameForSpecifier(orig);
      if (name !== undefined && !pluginNameToOrigPath.has(name)) pluginNameToOrigPath.set(name, orig);
    }
  };
  recordOrigPaths(providerModules);

  serviceRegistry.set('RuntimeAdminConfig',{providers:matbotConfig.providers,originalPaths:pluginNameToOrigPath,expectedPlugins:resolvedPluginMods.flatMap(request=>request.name?[request.name]:[])});
  const loadedPlugins = await loadPluginsWithDescriptions(resolvedPluginMods, services, path.dirname(configPath));

  // A plugin that fails to load is skipped rather than fatal (one bad entry must not brick startup).
  // That is wrong for a *frontend* in server mode: the process's whole job is to serve it. A frontend
  // that could not bind its port leaves a headless process holding this workspace's stores while some
  // other process still answers the browser — the state that makes a workspace switch look like it
  // silently did nothing. Fail loudly instead and let the supervisor restart us.
  if (serverMode) {
    const requestedFrontends = resolvedPluginMods.filter(m => /frontend/.test(m.spec));
    const loadedSpecifiers   = new Set(loadedPlugins.map(p => p.specifier));
    const missing            = requestedFrontends.filter(m => !loadedSpecifiers.has(m.spec));
    if (missing.length > 0) {
      throw new Error(
        `server mode requires its frontend(s), but ${missing.map(m => `"${m.spec}"`).join(', ')} failed to load ` +
        '(see the error above — a port already in use is the usual cause). Refusing to run headless.',
      );
    }
  }

  // The pre-scan opened a manifest storageBackend directly, before the loader knew the plugin's name,
  // so the scoped register() that records a service key never ran. Attribute it now that names exist,
  // making the boot-opened backend unload-equal to a runtime register(): unloading that plugin reverts
  // storage to the host base and closes the backend.
  if (storageBootSpec !== undefined) {
    const name = getPluginNameForSpecifier(storageBootSpec);
    if (name !== undefined) recordServiceKey(name, 'StorageBackend');
  }

  // A provider adapter may be loaded via the plugins list (as a path) rather than a
  // provider config. Record those too, so the provider tool knows the YAML-valid path
  // for every loaded adapter, not just ones already referenced by a provider profile.
  recordOrigPaths(matbotConfig.plugins);

  // ── Server mode ───────────────────────────────────────────────────────────────

  if (serverMode) {
    process.stderr.write(`[${new Date().toISOString()} ${_pid}] [matbot] memory: ${isEphemeral
      ? 'EPHEMERAL — sessions and remembered facts will be lost when this process exits'
      : `persistent (${dotData})`}\n`);
    process.stderr.write(`[${new Date().toISOString()} ${_pid}] [matbot] server running — press Ctrl+C to stop\n`);
    /**
     * Initiate a clean shutdown on SIGINT/SIGTERM: release the runtime, then exit 0.
     * @returns Nothing.
     * @throws Never.
     */
    const shutdown = (): void => {
      process.stderr.write('\n[matbot] shutting down…\n');
      void releaseRuntime().then(() => process.exit(0));
    };
    process.once('SIGINT',  shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  // ── Provider resolution ───────────────────────────────────────────────────────

  const providerName = opts.provider ?? matbotConfig.defaultProvider ?? (matbotConfig.providers.keys().next().value as string);
  const rawConfig    = matbotConfig.providers.get(providerName);
  if (!rawConfig) {
    throw new Error(
      `Unknown provider "${providerName}". Available: ${[...matbotConfig.providers.keys()].join(', ')}`
    );
  }

  const providerConfig: ProviderConfig = {
    name:        rawConfig.name,
    module:      rawConfig.module,
    model:       rawConfig.model,
    ...(rawConfig.credentials !== undefined ? { credentials: await resolveCredentialsInteractive(rawConfig.credentials, vault) } : {}),
    ...(rawConfig.endpoint    !== undefined ? { endpoint: await vault.resolve(rawConfig.endpoint) } : {}),
    ...(rawConfig.parameters  !== undefined ? { parameters: rawConfig.parameters } : {}),
    ...(rawConfig.fallback    !== undefined ? { fallback:   rawConfig.fallback   } : {}),
  };

  await loadPluginsWithDescriptions(await resolvePluginSpecifiers([fileURLToPath(new URL('../../../packages/plugins/frontend-cli',import.meta.url))],path.dirname(configPath)),services,path.dirname(configPath));
  if(!services.CliFrontend)throw new Error('CLI frontend unavailable');
  const runStore:Store<Session>=isEphemeral?new MemoryStore<Session>():store;
  try{await services.CliFrontend.start({store:runStore,run:isEphemeral?makeRunner(runStore):(sessionRunner??makeRunner(store)),provider:providerConfig.name,principal:currentPrincipal(),ephemeral:isEphemeral,...(opts.session?{session:opts.session}:{}),...(opts.system?{system:opts.system}:{}),...(argPrompt!==undefined?{prompt:argPrompt}:{})});}
  finally{await releaseRuntime();}

}

const invokedEntry = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedEntry === import.meta.url) {
  main().catch(e => {
    process.stderr.write(`Fatal: ${String(e)}\n`);
    process.exit(1);
  });
}
