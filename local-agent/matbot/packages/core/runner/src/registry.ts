import {PluginContributions} from './contributions.js';
import type { Tool, ToolRegistry, Hook, PromptFn, FormField, FrontendInfo, PluginRegistryEvent } from './types.js';
import { createBroadcaster } from '@matatbread/matbot-plugin-api';
import type {
  MatbotPlugin, MatbotMachine, Mounted,
  ProviderAdapterFactory, StoreFactory,
} from './plugin.js';
import { PLUGIN_API_VERSION, unifyServices } from './plugin.js';
import { HookRegistry } from './hooks.js';
import { makePluginSettings } from './settings.js';
import type { SettingsDoc } from './settings.js';

// ── Internal state ────────────────────────────────────────────────────────────

// Mutable arrays/maps held in a single object to make _resetRegistry() simple.
const contributions = new PluginContributions();
const state = {
  plugins:         [] as MatbotPlugin[],
  lifetimes: new Map<string,AbortController>(),
  providers:       new Map<string, ProviderAdapterFactory>(),
  storage:         new Map<string, StoreFactory>(),
  toolRegistry:    undefined as ToolRegistry | undefined,
  frontendPlugins:  new Map<string, FrontendInfo>(),  // pluginName → info, written by services.registerFrontend()
  serviceOwners: new Map<string, string>(),
  serviceKeys:     new Map<string, string[]>(),  // pluginName → MatbotMachine keys it registered
  hookPlugins:        new Set<string>(),         // plugins that registered at least one hook
  systemContextPlugins: new Set<string>(),       // plugins that registered a system-context contributor
  overwriteAllTools: undefined as boolean | undefined,  // persisted "overwrite on collision, this install" choice, loaded lazily
};

// Read-only observation of plugin load/unload, for consumers that key off plugin presence (e.g. the
// web plugins panel refreshing live when a backend restores a plugin set out of band). Module-level,
// not in `state` — it owns subscribers across the registry's lifetime, not per-plugin data.
const pluginEvents = createBroadcaster<PluginRegistryEvent>();

/**
 * Plugin-scoped hook surface handed to a plugin's setup(): registrations are stamped with the
 * owning plugin and removal is delegated to the host registry. Subclasses the real registry so
 * the full public contract holds without a boundary cast — dispatch always runs against the
 * host instance, so hooks registered during setup() are visible to every later turn.
 */
class ScopedHookRegistry extends HookRegistry {
  private readonly owner: string;
  private readonly host: HookRegistry;

  /**
   * Bind a scoped registry to one plugin and its host registry.
   *
   * @param owner - Plugin name stamped onto every hook registered through this view.
   * @param host - Registry that actually stores and dispatches hooks.
   * @throws Never.
   */
  constructor(owner: string, host: HookRegistry) {
    super();
    this.owner = owner;
    this.host = host;
  }

  /**
   * Register a hook attributed to the owning plugin.
   *
   * Marks the owner as a hook plugin and delegates to the host with `pluginName` stamped, so
   * {@link unloadPlugin} can remove the hook again.
   *
   * @param hook - Hook to register; any `pluginName` it carries is overwritten with the owner.
   * @returns Nothing.
   * @throws Never.
   */
  register(hook: Hook): void {
    state.hookPlugins.add(this.owner);
    this.host.register({ ...hook, pluginName: this.owner } as Hook);
  }

  /**
   * Remove all hooks registered by a plugin, delegating to the host registry.
   *
   * @param pluginName - Plugin whose hooks are removed.
   * @returns Nothing.
   * @throws Never.
   */
  removeByPlugin(pluginName: string): void {
    this.host.removeByPlugin(pluginName);
  }
}

/**
 * Observe plugin load/unload events for the registry's lifetime.
 *
 * @param signal - Optional abort signal; aborting ends the iteration.
 * @returns An async iterable of plugin loaded/unloaded events.
 * @throws Never.
 */
export function watchPlugins(signal?: AbortSignal): AsyncIterable<PluginRegistryEvent> {
  return pluginEvents.subscribe(signal);
}

// Settings namespace + key under which the user's "overwrite all colliding tools" choice
// is persisted for the installation. The namespace doubles as a Store document id, so it must
// satisfy the storage id charset (/^[\w-]+$/) — hence underscores, not '@matbot/core'. The
// dunder marks it reserved (internal), so it won't collide with a real plugin's settings.
const CORE_SETTINGS_NS    = '__matbot_core__';
const OVERWRITE_TOOLS_KEY = 'overwriteToolsOnCollision';

/**
 * Decide whether an incoming tool registration may overwrite an existing tool of the
 * same name owned by a different plugin. Returns true to overwrite, false to keep the
 * existing one and drop the incoming registration.
 *
 * Resolution order: a persisted "overwrite all (this install)" choice short-circuits to
 * true; otherwise the user is prompted [n / Y / all] where only an explicit "Overwrite"
 * or "Always overwrite" answer overwrites — any other or unrecognized answer keeps the
 * existing tool. 'Always overwrite' persists the choice. With no prompt available
 *   (non-interactive host) we overwrite — the default — preserving matbot's historical
 *   last-registration-wins behaviour.
 *
 * @param services - Host machine; supplies the settings store used to persist the
 *   "always overwrite" choice.
 * @param toolName - Tool name both registrations collide on.
 * @param existingOwner - Plugin owning the incumbent tool, or undefined when the incumbent is
 *   a built-in.
 * @param incomingOwner - Plugin attempting to register the colliding tool.
 * @param prompt - Host prompt for interactive resolution; undefined means non-interactive.
 * @returns True to overwrite the incumbent, false to keep it and drop the incoming tool.
 * @throws Error - When persisting the "always overwrite" choice fails after repeated CAS
 *   conflicts, or the core settings document cannot be read.
 */
async function resolveToolCollision(
  services:      MatbotMachine,
  toolName:      string,
  existingOwner: string | undefined,
  incomingOwner: string,
  prompt:        PromptFn | undefined,
): Promise<boolean> {
  const coreSettings = makePluginSettings(services.createStore<SettingsDoc>('settings'), CORE_SETTINGS_NS);
  if (state.overwriteAllTools === undefined) {
    state.overwriteAllTools = (await coreSettings.get<boolean>(OVERWRITE_TOOLS_KEY)) ?? false;
  }
  if (state.overwriteAllTools) return true;

  const owner = existingOwner !== undefined ? `"${existingOwner}"` : 'a built-in';
  const label = `Tool \`"${toolName}"\` is already registered by **${owner}**. Overwrite it with the one from **"${incomingOwner}"**?`;

  if (prompt === undefined) {
    console.warn(`[matbot] ${label} — non-interactive, overwriting (default).`);
    return true;
  }

  const field: FormField = {
    name:    'overwrite',
    label,
    type:    'select',
    options: ['Keep existing', 'Overwrite', 'Always overwrite'],
    default: 'Overwrite',
  };
  const answer = (await prompt(field)).trim().toLowerCase();
  if (answer.startsWith('a')) {  // "Always overwrite" — persist for the installation
    state.overwriteAllTools = true;
    await coreSettings.set(OVERWRITE_TOOLS_KEY, true);
    return true;
  }
  // Fail closed: only an explicit "Overwrite" answer replaces the existing tool. Anything
  // else — empty input, a stray keystroke, free text — keeps the incumbent rather than
  // interpreting it as consent to clobber.
  return answer === 'overwrite';
}

// ── Version check ─────────────────────────────────────────────────────────────

/**
 * Strictly parse a `major.minor` version string. Returns undefined for anything else —
 * a malformed version must never silently become NaN and slip past the comparisons below.
 *
 * @param version - Version string to parse; trimmed first.
 * @returns The parsed major/minor pair, or undefined unless `version` is exactly
 *   `major.minor` digits.
 * @throws Never.
 */
function parseApiVersion(version: string): { major: number; minor: number } | undefined {
  const m = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (m === null) return undefined;
  return { major: Number(m[1]!), minor: Number(m[2]!) };
}

/**
 * Compare a plugin's declared `apiVersion` against the runtime's {@link PLUGIN_API_VERSION}.
 *
 * An unparseable target version skips the check with a warning. A major-version mismatch
 * throws; a plugin targeting a newer minor than the runtime only warns.
 *
 * @param plugin - Plugin whose `apiVersion` is checked.
 * @returns Nothing.
 * @throws Error - When the plugin's API major version differs from the runtime's.
 */
function checkApiVersion(plugin: MatbotPlugin): void {
  const runtime = parseApiVersion(PLUGIN_API_VERSION)!;  // repo-internal constant
  const target  = parseApiVersion(plugin.apiVersion);

  if (target === undefined) {
    console.warn(
      `[matbot] Plugin "${plugin.name}" declares unparseable apiVersion "${plugin.apiVersion}" ` +
      `(runtime API is ${PLUGIN_API_VERSION}); skipping the compatibility check.`,
    );
    return;
  }

  if (target.major !== runtime.major) {
    throw new Error(
      `Plugin "${plugin.name}" requires API ${plugin.apiVersion} (major ${target.major}) ` +
      `but runtime provides ${PLUGIN_API_VERSION}. ` +
      `Update the plugin or the runtime.`,
    );
  }
  if (target.minor > runtime.minor) {
    console.warn(
      `[matbot] Plugin "${plugin.name}" targets API ${plugin.apiVersion} ` +
      `but runtime is ${PLUGIN_API_VERSION}. Some features may not be available.`,
    );
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register a loaded plugin: check its declared API version against the runtime, claim
 * provider/storage factory slots, and emit a `loaded` event. Does not run setup().
 *
 * @param plugin - The plugin (already identity-stamped by the loader).
 * @returns Nothing; on success the plugin is appended to the registry, its provider/storage
 *   factories are claimed, and a `loaded` event is emitted.
 * @throws On an incompatible API major version, a duplicate plugin/provider name, or a
 *         storage type already owned by another plugin.
 */
export function registerPlugin(plugin: MatbotPlugin): void {
  checkApiVersion(plugin);

  if (state.plugins.some(p => p.name === plugin.name)) {
    throw new Error(`Plugin "${plugin.name}" is already registered.`);
  }

  if (plugin.provider !== undefined && state.providers.has(plugin.name)) {
    throw new Error(`Provider "${plugin.name}" is already registered.`);
  }

  for (const type of Object.keys(plugin.storage ?? {})) {
    if (state.storage.has(type)) {
      const owner = state.plugins.find(p => p.storage?.[type] !== undefined)?.name ?? '?';
      throw new Error(
        `Storage type "${type}" is already registered by "${owner}". ` +
        `"${plugin.name}" cannot register it again.`,
      );
    }
  }

  state.plugins.push(plugin);

  if (plugin.provider !== undefined) {
    state.providers.set(plugin.name, plugin.provider);
  }
  for (const [type, factory] of Object.entries(plugin.storage ?? {})) {
    state.storage.set(type, factory);
  }

  pluginEvents.emit({ type: 'loaded', name: plugin.name });
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Look up the provider adapter factory registered by a provider plugin.
 *
 * @param module - The provider's module key (its plugin name).
 * @returns The factory for building that provider's adapter.
 * @throws When no provider plugin is registered under this module.
 */
export function resolveProviderFactory(module: string): ProviderAdapterFactory {
  const factory = state.providers.get(module);
  if (factory === undefined) {
    const available = [...state.providers.keys()].join(', ') || 'none';
    throw new Error(
      `No provider registered for module "${module}". ` +
      `Available: ${available}. ` +
      `Install and load the provider plugin.`,
    );
  }
  return factory;
}

/**
 * List all currently registered tools.
 *
 * @returns A read-only snapshot of registered tools; empty before any plugin has set up.
 */
export function getRegisteredTools(): readonly Tool[] {
  return state.toolRegistry?.list() ?? [];
}

/**
 * List all registered plugins in registration order.
 *
 * @returns A read-only view of the registered plugins.
 */
export function getRegisteredPlugins(): readonly MatbotPlugin[] {
  return state.plugins;
}

/**
 * Map plugin names to the frontend info they declared via `services.registerFrontend()`.
 *
 * @returns A read-only map of frontend plugins.
 */
export function getRegisteredFrontendPlugins(): ReadonlyMap<string, FrontendInfo> {
  return state.frontendPlugins;
}

/**
 * MatbotMachine keys a plugin registered at runtime via services.register() (e.g. 'KnowledgeIndex').
 *
 * @param pluginName - Plugin to look up.
 * @returns The plugin's service keys in registration order; empty when it registered none.
 * @throws Never.
 */
export function getRegisteredServiceKeys(pluginName: string): readonly string[] {
  return state.serviceKeys.get(pluginName) ?? [];
}

/**
 * Attribute a service key to a plugin out of band. The host uses this for a backend it opened at boot
 * *before* the registry knew the plugin's name — a storageBackend manifest pre-scan bypasses the scoped
 * register() that would normally record the key. Recording it makes the boot-opened backend unload-equal
 *   to a runtime register(): unloadPlugin() then calls unregister() for it, reverting to the host base.
 *
 * @param pluginName - Plugin to attribute the key to.
 * @param key - MatbotMachine service key (e.g. 'StorageBackend'); recorded once.
 * @returns Nothing.
 * @throws Never.
 */
export function recordServiceKey(pluginName: string, key: string): void {
  const keys = state.serviceKeys.get(pluginName) ?? [];
  if (!keys.includes(key)) keys.push(key);
  state.serviceKeys.set(pluginName, keys);
  state.serviceOwners.set(key, pluginName);
}

/**
 * Plugins that registered at least one hook in setup().
 *
 * @returns Plugin names as a read-only set.
 * @throws Never.
 */
export function getHookPlugins(): ReadonlySet<string> {
  return state.hookPlugins;
}

/**
 * Plugins that registered a system-context contributor in setup().
 *
 * @returns Plugin names as a read-only set.
 * @throws Never.
 */
export function getSystemContextPlugins(): ReadonlySet<string> {
  return state.systemContextPlugins;
}

/** Resolve a loaded plugin's name from the specifier used to load it. Each plugin carries its own
 *  specifier, so this is a scan of the plugin list — no side-map to keep in sync.
 *
 * @param specifier - Specifier recorded at load time.
 * @returns The matching plugin's name, or undefined when no plugin was loaded from it.
 * @throws Never.
 */
export function getPluginNameForSpecifier(specifier: string): string | undefined {
  return state.plugins.find(p => p.specifier === specifier)?.name;
}

/** Reverse of {@link getPluginNameForSpecifier} — finds the specifier used to load the named plugin.
 *
 * @param pluginName - Plugin to look up.
 * @returns The plugin's load specifier, or undefined when no plugin has that name.
 * @throws Never.
 */
export function getSpecifierForPlugin(pluginName: string): string | undefined {
  return state.plugins.find(p => p.name === pluginName)?.specifier;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Run setup() for a single plugin. Called by loadPlugins immediately after registration.
 *
 * `prompt`, when supplied by the host, makes tool-name collisions interactive: registering a
 * tool whose name a *different* plugin already owns asks the user whether to overwrite. Absent
 *   (non-interactive host), collisions overwrite silently — the historical default.
 *
 * @param plugin - Plugin to set up; must already be registered via {@link registerPlugin}.
 * @param services - Host machine the plugin's scoped machine is derived from.
 * @param prompt - Optional host prompt making tool-name collisions interactive.
 * @returns Nothing; on success the plugin's static tools are registered and setup() has run.
 * @throws Error - Propagates failures from the plugin's own setup(), from tool-collision
 *   resolution, or from registering/unregistering the reserved 'ToolInvocationPolicy' key or a
 *   service owned by another plugin. The caller rolls back partial registration.
 */
export async function setupPlugin(plugin: MatbotPlugin, services: MatbotMachine, prompt?: PromptFn): Promise<void> {
  state.toolRegistry ??= services.tools;
  const lifetime=new AbortController();state.lifetimes.set(plugin.name,lifetime);

  // Single choke point for every plugin tool registration (static `plugin.tools` and in-setup
  // `services.tools.register`). Stamps ownership and resolves name collisions. The no-collision
  // path runs synchronously (an async fn yields nothing before its first await), so fire-and-forget
  // callers that don't await still get the tool registered in the same tick.
  /**
   * Register one tool stamped with this plugin's identity and lifetime signal, resolving
   * name collisions against other plugins' tools.
   *
   * @param tool - Tool to register; registered as a copy with `pluginName` and `signal` set.
   * @returns Nothing.
   * @throws Error - When collision resolution fails (see {@link resolveToolCollision}).
   */
  const registerTool = async (tool: Tool): Promise<void> => {
    const stamped: Tool = { ...tool, pluginName: plugin.name,signal:lifetime.signal };
    const existing = services.tools.resolve(stamped.name);
    if (existing !== null && existing.pluginName !== plugin.name) {
      const overwrite = await resolveToolCollision(services, stamped.name, existing.pluginName, plugin.name, prompt);
      if (!overwrite) return;
    }
    services.tools.register(stamped);
  };

  // Plugin-scoped settings: bound to this plugin's identity, built once. A plugin reaches only its
  // own settings — there is no way to name another's.
  const ownSettings = makePluginSettings(services.createStore<SettingsDoc>('settings'), plugin.name);

  // Per-plugin `mounted`: a thin adapter over the host mount table that delivers *this plugin's* scoped
  // machine (and scoped onUnmount) to handlers. The stable `scoped` object reads through the host's
  // re-pointing proxies/registry, so `scoped[key]` is the host's live service by the time a transition
  // fires. Forward-referenced via `scoped`, assigned below; consume() only runs after setup.
  let scoped: MatbotMachine;
  const scopedMounted: Mounted = {
    /**
     * Subscribe to a service mount transition, delivering this plugin's scoped machine.
     *
     * @param options - Mount subscription options; a supplied `onUnmount` is wrapped to receive
     *   the scoped machine instead of the host's.
     * @param handler - Invoked with the plugin's scoped machine on each transition.
     * @returns Nothing.
     * @throws Never.
     */
    consume(options, handler) {
      // Forward to the host mount table but deliver *this plugin's* scoped machine — it reads through
      // the same proxies/registry, so scoped[key] is the host's live service. onUnmount is scoped too.
      const forwarded = options.onUnmount !== undefined
        ? { ...options, onUnmount: () => options.onUnmount!(scoped) }
        : options;
      services.mounted.consume(forwarded, () => handler(scoped as never));
    },
  };

  scoped = unifyServices({
    ...services,
    mounted: scopedMounted,
    contributions: contributions.forOwner(plugin.name),
    settings: () => ownSettings,
    self: {
      name:      plugin.name,
      specifier: plugin.specifier,
      ...(plugin.source !== undefined ? { source: plugin.source } : {}),
    },
    tools: {
      register:      registerTool,
      remove:        (name: string) => services.tools.remove(name),
      resolve:       (name: string) => services.tools.resolve(name),
      list:          ()             => services.tools.list(),
      removeByPlugin:(name: string) => services.tools.removeByPlugin(name),
      watch:         (signal?: AbortSignal) => services.tools.watch(signal),
    },
    hooks: new ScopedHookRegistry(plugin.name, services.hooks),
    systemContext: {
      register(contributor) {
        state.systemContextPlugins.add(plugin.name);
        services.systemContext.register(contributor, plugin.name);
      },
      removeByPlugin: (name: string) => services.systemContext.removeByPlugin(name),
      build:          (ctx)          => services.systemContext.build(ctx),
    },
    /**
     * Register a service on behalf of this plugin, recording ownership for unload.
     *
     * @param key - MatbotMachine service key to register under.
     * @param svc - Service implementation.
     * @returns Nothing.
     * @throws Error - For the host-reserved 'ToolInvocationPolicy' key, or when the underlying
     *   host registration rejects.
     */
    async register(key, svc) {
      if(key==='ToolInvocationPolicy')throw new Error('Invocation policy is owned by the host');
      await services.register(key, svc);
      recordServiceKey(plugin.name, key as string);
    },
    /**
     * Unregister a service previously registered by this plugin.
     *
     * @param key - MatbotMachine service key to unregister.
     * @returns Nothing.
     * @throws Error - For the host-reserved 'ToolInvocationPolicy' key, or when the key is
     *   owned by another plugin.
     */
    unregister(key) {
      if (key === 'ToolInvocationPolicy') throw new Error('Invocation policy is owned by the host');
      if (state.serviceOwners.get(key) !== plugin.name) throw new Error('Service is owned by another plugin: ' + key);
      services.unregister(key);
      state.serviceOwners.delete(key);
    },
    registerFrontend(info) {
      state.frontendPlugins.set(plugin.name, info);
    },
  });
  for (const tool of plugin.tools ?? []) {
    await registerTool(tool);
  }
  await plugin.setup?.(scoped);
}

/**
 * Tear down and fully unload a single plugin, removing all its registered contributions.
 *
 * All synchronous cleanup (lifetime signal, contributions, tools, hooks, system context,
 * services, provider/storage slots, frontend info) runs before the asynchronous teardown(), so
 * registry state stays consistent even if teardown() fails or hangs.
 *
 * @param pluginName - Name of the plugin to unload.
 * @param services - Host machine whose registries are cleaned.
 * @returns True when the plugin was found and unloaded; false when no plugin has that name.
 * @throws Error - When the plugin's teardown() rejects or exceeds the 10-second timeout.
 */
export async function unloadPlugin(pluginName: string, services: MatbotMachine): Promise<boolean> {
  console.warn(`[matbot] Unloading plugin "${pluginName}"`);
  const idx = state.plugins.findIndex(p => p.name === pluginName);
  if (idx === -1) return false;

  // Note: all synchronous cleanup (removing tools, hooks, services) is done before any asynchronous teardown() calls, to ensure a consistent state even if teardown() fails or hangs.
  const plugin = state.plugins[idx]!;

  state.lifetimes.get(pluginName)?.abort();state.lifetimes.delete(pluginName);
  contributions.removeOwner(pluginName);
  services.tools.removeByPlugin(pluginName);
  services.hooks.removeByPlugin(pluginName);
  services.systemContext.removeByPlugin(pluginName);

  for (const key of state.serviceKeys.get(pluginName) ?? []) {
    if (state.serviceOwners.get(key) === pluginName) {
      services.unregister(key);
      state.serviceOwners.delete(key);
    }
  }
  state.serviceKeys.delete(pluginName);
  state.hookPlugins.delete(pluginName);
  state.systemContextPlugins.delete(pluginName);

  if (plugin.provider !== undefined) state.providers.delete(plugin.name);
  for (const type of Object.keys(plugin.storage   ?? {})) state.storage.delete(type);

  state.frontendPlugins.delete(pluginName);

  state.plugins.splice(idx, 1);
  pluginEvents.emit({ type: 'unloaded', name: pluginName });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      plugin.teardown?.(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Teardown timeout for plugin ${pluginName}`)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return true;
}

/**
 * Run each plugin's teardown() in reverse-registration order. Errors are logged, not thrown.
 *
 * Aborts every plugin's lifetime signal and removes its contributions first; teardown()
 * rejections are collected and logged per plugin.
 *
 * @returns Nothing.
 * @throws Never.
 */
export async function teardownPlugins(): Promise<void> {
  const teardownOrder = [...state.plugins].reverse();
  for(const plugin of teardownOrder){state.lifetimes.get(plugin.name)?.abort();contributions.removeOwner(plugin.name);}
  const results = await Promise.allSettled(teardownOrder.map(plugin => plugin.teardown?.()));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[matbot] teardown error in plugin "${teardownOrder[i]?.name}":`, result.reason);
    }
  });
}

