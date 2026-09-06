import {
  createSessionRunner, freezeInvocationPolicy, HookRegistry, SystemContextRegistryImpl, ToolRegistryImpl,
  resolveProviderFactory, getPluginNameForSpecifier, recordServiceKey,
  installPrincipalCarrier, createConstantPrincipalCarrier,
  createMessage, MissingSecretError, loadPlugins,
  unloadPlugin as unloadPluginFn, unifyServices,
  forwardingProxy, makeSwappable, singleTurnRequest,
  createMountTable, onContextQuiesce, flushIfQuiescent,
} from '@matatbread/matbot-core';
import type {
  MatbotMachine, MatbotServices, Store, Session, ProviderConfig, ProviderAdapter,
  PluginSettings, Vault, SessionRunner, KnowledgeIndex,
  PluginResolver, StorageBackend, FileStore, PromptFn, MatbotPlugin, Principal, Runtime, SwapFn,
} from '@matatbread/matbot-plugin-api';
import { LookupKnowledgeIndex } from '@matatbread/matbot-knowledge';
import { BrowserStorageBackend, LocalStorageVault } from '@matatbread/matbot-browser';
import { runProviderSetup, type AvailableProvider, type ProviderDraft } from './setup.js';
import type {} from '@matatbread/matbot-runtime-admin/browser';

/** Shape of the inlined config baked into the artifact (the browser analogue of matbot.yaml). */
export interface BrowserConfig {
  plugins:   string[];                                    // importable specifiers (synthetic ids)
  providers: Record<string, Omit<ProviderConfig, 'name'>>; // module is already an importable specifier
  /** Adapter types the startup wizard can offer when no provider is configured. */
  availableProviders: AvailableProvider[];
  /** Baked-but-idle plugins (the browser analogue of node's on-disk packages): present in the
   *  artifact + import map but not auto-loaded, offered for on-demand load by package name. */
  availablePlugins?: { name: string; specifier: string; matbotRuntime?: readonly Runtime[]; description?: string }[];
  defaultProvider?: string;
  permissions?: MatbotServices['ToolInvocationPolicy'];
  /** Boot identity for this single-principal realm. Absent ⇒ the anonymous web user.
   *  A user-associated bundle (served per-tenant) bakes the tenant's identity here. */
  principal?: Principal;
}

const PROVIDERS_KEY = 'matbot.providers';

/**
 * Load the provider configs persisted from earlier sessions.
 *
 * Reads the {@link PROVIDERS_KEY} entry from `localStorage` and JSON-parses it. Storage and
 * parse failures are swallowed.
 *
 * @returns Name-keyed provider configs (the name is the map key and is omitted from each
 *          value). Empty when nothing is persisted or storage is unavailable; key order is
 *          unspecified.
 * @throws Never.
 */
function loadPersistedProviders(): Record<string, Omit<ProviderConfig, 'name'>> {
  try {
    const raw = globalThis.localStorage?.getItem(PROVIDERS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Omit<ProviderConfig, 'name'>>) : {};
  } catch { return {}; }
}

/**
 * Persist one provider config to `localStorage`, merging it over the previously saved set.
 *
 * The config's `name` becomes the map key and is stripped from the stored value.
 *
 * @param cfg - Full provider config to persist.
 * @returns Nothing.
 * @throws Never — storage unavailability and quota failures are swallowed by design.
 */
function savePersistedProvider(cfg: ProviderConfig): void {
  const cur = loadPersistedProviders();
  const { name, ...rest } = cfg;
  cur[name] = rest;
  try { globalThis.localStorage?.setItem(PROVIDERS_KEY, JSON.stringify(cur)); } catch { /* unavailable */ }
}

/**
 * Remove a previously persisted provider config from `localStorage`.
 *
 * No-op when no config under that name is persisted; storage failures are swallowed.
 *
 * @param name - Provider name (persistence key) to delete.
 * @returns Nothing.
 * @throws Never.
 */
function removePersistedProvider(name: string): void {
  const cur = loadPersistedProviders();
  if (!(name in cur)) return;
  delete cur[name];
  try { globalThis.localStorage?.setItem(PROVIDERS_KEY, JSON.stringify(cur)); } catch { /* unavailable */ }
}

/** Host services the in-page loader provides to the bootstrap (see loader.js / __mbLoader). */
export interface LoaderApi {
  /**
   * Fetch a remote .ts plugin, type-strip it, and return a specifier importable right now, plus
   * the name and declared matbotRuntime read from its sibling package.json.
   * @param url - Source URL of the remote plugin entry module.
   * @returns `spec` — an import specifier valid for this session (an ephemeral blob: URL),
   *          `name` — the canonical plugin name, and `runtimes` — the declared matbotRuntime
   *          when the plugin declares one.
   * @throws Error - The fetch or type-strip fails.
   */
  loadRemote(url: string): Promise<{ spec: string; name: string; runtimes?: readonly Runtime[] }>;
}

/**
 * Everything the browser bootstrap needs to start the in-page runtime: the baked
 * config, assembler-provided specifier metadata, and the in-page remote loader.
 */
export interface BootEnv {
  config:    BrowserConfig;
  /** specifier → canonical plugin name, baked by the assembler so the resolver needn't walk a tree. */
  specNames: Record<string, string>;
  /** specifier → declared matbotRuntime, baked by the assembler; absent entry means "not declared". */
  specRuntimes?: Record<string, readonly Runtime[]>;
  loader:    LoaderApi;
}

const NEVER_ABORT = new AbortController().signal;
const WEB_USER: Principal = { id: 'web-user', type: 'user' };

/**
 * Resolve `${NAME}` placeholders, prompting (once, persisted) for any the vault is missing.
 *
 * Loops on {@link MissingSecretError}: prompts via `globalThis.prompt` for each missing key,
 * writes the entered value into the vault, and retries resolution. Any vault error other than
 * {@link MissingSecretError} propagates unchanged.
 *
 * @param ref - Text containing `${NAME}` placeholders (or a bare key) to resolve.
 * @param vault - Vault to resolve against and to persist prompted values into.
 * @returns The fully resolved text.
 * @throws Error - The user cancelled the prompt or entered an empty value for a missing secret.
 */
async function resolveInteractive(ref: string, vault: Vault): Promise<string> {
  for (;;) {
    try {
      return await vault.resolve(ref);
    } catch (e) {
      if (!(e instanceof MissingSecretError)) throw e;
      for (const name of e.missingKeys) {
        const val = globalThis.prompt?.(`matbot needs the secret "${name}" (e.g. an API key):`) ?? '';
        if (!val.trim()) throw new Error(`No value provided for required secret "${name}".`);
        await vault.writeSecret(name, val.trim());
      }
    }
  }
}

/**
 * Resolve every value in a provider's credentials map through the vault, prompting (and
 * persisting) for any missing secret.
 * @param creds - Credential values, each a `${NAME}` placeholder or bare key reference.
 * @param vault - Vault to resolve against.
 * @returns A new map with every value resolved to its secret text.
 * @throws Error - A secret cannot be resolved interactively (see resolveInteractive).
 */
async function resolveCredentials(creds: Record<string, string>, vault: Vault): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) out[k] = await resolveInteractive(v, vault);
  return out;
}

/**
 * Boot the browser matbot runtime: install the single-principal carrier, wire up the
 * swappable vault/storage/knowledge services, load the first-run provider wizard when
 * no provider is configured, pre-scan for a plugin-supplied StorageBackend, register
 * the `provider` and `single_turn` tools, and load all baked plugins.
 * @param env Baked config, specifier metadata, and the in-page loader API.
 * @returns Resolves when the runtime is fully wired and plugins are loaded.
 * @throws When a required secret cannot be resolved interactively or a plugin load
 *         fails irrecoverably.
 */
export async function boot(env: BootEnv): Promise<void> {
  const { config, specNames, loader } = env;
  const specRuntimes = env.specRuntimes ?? {};

  // One identity for the whole realm — the browser is single-principal, so the carrier is constant
  // and `runAs` is a passthrough (no AsyncLocalStorage needed; see CLAUDE.md "Platform split").
  // The realm's identity comes from config (a per-tenant bundle bakes it); WEB_USER is the
  // anonymous default.
  installPrincipalCarrier(createConstantPrincipalCarrier(config.principal ?? WEB_USER));

  // Vault behind a capture-safe proxy (like StorageBackend/KnowledgeIndex): a plugin may
  // `register('Vault', impl)` to swap in a different secret store (e.g. a Drive-backed one), and
  // every captured reference — complete(), resolveProvider(), the session runner — follows the swap
  // because resolution is lazy/per-turn through the proxy. The default boots from localStorage.
  let activeVault: Vault = new LocalStorageVault();
  const vault = forwardingProxy<Vault>(() => activeVault);

  // Store a wizard draft: key in the vault under a derived name, persist the config (with a ${ref},
  // never the raw key) to localStorage, and return the runnable config. A self-contained provider
  // (no endpoint/key — e.g. a local demo adapter) persists neither: only model + module.
  /**
   * Convert a wizard draft into a runnable {@link ProviderConfig}: store its API key in the
   * vault under a derived `APIKEY_<NAME>` name (referencing whatever the entered value
   * canonicalises to, per the vault's dedup policy), persist the resulting config — carrying a
   * `${...}` reference, never the raw key — to localStorage, and return it.
   * @param draft - Provider details collected by the setup wizard.
   * @returns The full provider config for the draft; credentials (when any) are vault references.
   * @throws Error - The vault rejects the secret write.
   */
  const persistDraft = async (draft: ProviderDraft): Promise<ProviderConfig> => {
    let credentials: Record<string, string> | undefined;
    if (draft.apiKey) {
      const varName = 'APIKEY_' + draft.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      // createSecret, not writeSecret: the entered value may already be a key name (a vault
      // substitution the user typed instead of the secret) or a value already stored under another
      // name — reference whatever name it canonicalises to, only minting APIKEY_<NAME> for a genuinely
      // new value. Mirrors the node `provider` tool.
      const keyName = await vault.createSecret(varName, draft.apiKey);
      credentials = { apiKey: '${' + keyName + '}' };
    }
    const cfg: ProviderConfig = {
      name:   draft.name,
      module: draft.module,
      model:  draft.model,
      ...(draft.endpoint   ? { endpoint: draft.endpoint } : {}),
      ...(credentials      ? { credentials }              : {}),
      ...(draft.parameters && Object.keys(draft.parameters).length > 0
        ? { parameters: draft.parameters as NonNullable<ProviderConfig['parameters']> }
        : {}),
    };
    savePersistedProvider(cfg);
    return cfg;
  };

  // providers map mirrors matbot.yaml's, name-keyed; canonicalised below once provider plugins load.
  // Baked providers (if any) are overlaid by anything the user configured in a previous session.
  const providers = new Map<string, ProviderConfig>();
  for (const [name, cfg] of Object.entries(config.providers))         providers.set(name, { ...cfg, name });
  for (const [name, cfg] of Object.entries(loadPersistedProviders())) providers.set(name, { ...cfg, name });

  // First run (or cleared storage): collect the full provider config — name, adapter, URL, model, key.
  if (providers.size === 0) {
    const cfg = await persistDraft(await runProviderSetup(config.availableProviders, { cancelable: false }));
    providers.set(cfg.name, cfg);
  }

  // ── Storage backend: IndexedDB + OPFS, discovered from a plugin or defaulted ──────────────
  let activeStorageBackend: StorageBackend | undefined;
  // The config entry of the plugin whose storageBackend the pre-scan opened, if any. Recorded against
  // its plugin name once the loader has resolved names, so its unload reverts storage like a register().
  let storageBootSpec: string | undefined;
  const providerSpecs = [...new Set([...providers.values()].map(p => p.module))];
  for (const spec of [...providerSpecs, ...config.plugins]) {
    try {
      const mod  = await import(/* @vite-ignore */ spec) as Record<string, unknown>;
      const plug = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
      if (plug?.storageBackend !== undefined) { activeStorageBackend = await plug.storageBackend.open(''); storageBootSpec = spec; break; }
    } catch { /* loadPlugins will surface load errors */ }
  }

  // The host's own boot base (OPFS/IDB) — the revert target when a swapped-in StorageBackend's plugin
  // unloads. With no pre-scan backend it *is* the active backend; a pre-scanned one is plugin-owned
  // (see storageBootSpec), so unloading it lands back here.
  const bootBackend: StorageBackend = new BrowserStorageBackend();
  activeStorageBackend ??= bootBackend;

  // ── Swappable store/file proxies (verbatim from the node bootstrap: register('StorageBackend')
  //    re-targets every captured reference) ───────────────────────────────────────────────────
  type AnyStore = Store<{ id: string; version: string }>;
  // forwardingProxy/makeSwappable are shared with the CLI (capture-safe service swap).
  const storeProxies = new Map<string, [AnyStore, SwapFn<AnyStore>]>();
  /**
   * Return the capture-safe {@link Store} proxy for a namespace, creating the underlying store
   * on the active backend at first use; later calls for the same namespace reuse the proxy,
   * which {@link makeSwappable} re-targets when the backend is swapped.
   * @typeParam T - Stored record shape; must carry the `id`/`version` CAS fields.
   * @param namespace - Backend namespace backing the store (e.g. `"sessions"`).
   * @returns The shared proxy store for the namespace.
   * @throws Never.
   */
  const createStore = <T extends { id: string; version: string }>(namespace: string): Store<T> => {
    let entry = storeProxies.get(namespace);
    if (entry === undefined) {
      entry = makeSwappable<AnyStore>(activeStorageBackend!.createStore(namespace));
      storeProxies.set(namespace, entry);
    }
    return entry[0] as Store<T>;
  };
  const store = createStore<Session>('sessions');
  const [fileStore, swapFiles] = makeSwappable<FileStore>(activeStorageBackend.fileStore);

  // ── Registries ────────────────────────────────────────────────────────────────────────────
  const toolReg          = new ToolRegistryImpl();
  const hookReg          = new HookRegistry();
  const systemContextReg = new SystemContextRegistryImpl();
  const serviceRegistry  = new Map<string, unknown>();
  serviceRegistry.set('ToolInvocationPolicy', freezeInvocationPolicy(config.permissions ?? { defaultAction: 'allow' }));

  let knowledgeImpl: KnowledgeIndex = new LookupKnowledgeIndex();
  // Capture-safe handles (see forwardingProxy): a captured reference, including a destructure like
  // `const { KnowledgeIndex, StorageBackend } = services`, follows register()-driven swaps.
  const knowledgeProxy      = forwardingProxy<KnowledgeIndex>(() => knowledgeImpl);
  const storageBackendProxy = forwardingProxy<StorageBackend>(() => activeStorageBackend);

  // Boot defaults captured for revert-on-unregister (mirrors the CLI host): a swap-key reverts here
  // when its plugin is unloaded, instead of dangling on the now-gone impl. (bootBackend is captured
  // above, before the pre-scan defaulting, so a config backend never poses as the host base.)
  const bootVault                   = activeVault;
  const bootKnowledge               = knowledgeImpl;

  // Re-point every store proxy + the file proxy at `next`. Returns whether anything actually changed,
  // so the caller can skip a redundant `mounted` emit. Synchronous: the repoint completes before this
  // returns, so readers see `next` at once and the `mounted` emit can fire immediately. The displaced
  // impl is closed in the *background* — a slow or throwing close() must never gate the swap or suppress
  // the mounted notification. Driven only from the quiescent-edge flush below — never mid-turn.
  /**
   * Re-point every store proxy and the file proxy at `next` synchronously, so readers observe
   * the new backend at once, and close the displaced backend in the background (a slow or
   * throwing close never gates the swap or suppresses the mounted notification). Driven only
   * from the quiescent-edge flush — never mid-turn.
   * @param next - Backend to make active.
   * @returns True when the active backend changed; false when `next` was already active, letting
   *          the caller skip a redundant `mounted` emit.
   * @throws Never — displaced-backend close failures are logged, not propagated.
   */
  const swapStorage = (next: StorageBackend): boolean => {
    const removed = activeStorageBackend;
    if (removed === next) return false;
    activeStorageBackend = next;
    for (const [ns, [, swap]] of storeProxies) swap(next.createStore(ns));
    swapFiles(next.fileStore);
    void Promise.resolve(removed?.close?.()).catch(e => console.error('[matbot] closing displaced StorageBackend:', e));
    return true;
  };

  // Deferred StorageBackend swap (mirrors the CLI host): register/unregister('StorageBackend') stage the
  // desired backend (last write wins — a slot, not a queue) and ask the context-switch machinery to land
  // it at the next quiescent edge, so a swap never splits a compare-and-swap across two backends.
  // The mount table batches mount notifications to the quiescent edge: register/unregister mark a key
  // dirty; the edge computes each key's net presence transition (mount / remount / committed unload) and
  // multicasts to that key's subscribers. A reload (unregister+register within one turn) collapses to a
  // single remount. Notification timing is deliberately unspecified — see the `Mounted` contract.
  const mountTable = createMountTable(() => services);
  let pendingSwap: { next: StorageBackend } | undefined;
  /**
   * Stage a deferred StorageBackend swap (last write wins: a slot, not a queue) and request a
   * flush at the next quiescent edge, so a swap never lands mid-turn and never splits a
   * compare-and-swap across two backends.
   * @param next - Backend to activate at the next quiescent edge.
   * @returns Nothing.
   * @throws Never.
   */
  const stageSwap = (next: StorageBackend): void => {
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
   * Re-point the knowledge index at `next` immediately (unlike StorageBackend, no deferral) and
   * re-index the previous implementation's entries into `next` fire-and-forget, so a live swap
   * does not silently drop indexed knowledge.
   * @param next - Knowledge index to make active.
   * @returns Nothing.
   * @throws Never — re-indexing is dispatched without awaiting; async failures surface as
   *          unhandled rejections.
   */
  const swapKnowledge = (next: KnowledgeIndex): void => {
    const prev = knowledgeImpl;
    if (prev === next) return;
    knowledgeImpl = next;
    if (prev.entries !== undefined) for (const e of prev.entries()) void next.index(e);
  };

  const resolver: PluginResolver = {
    /**
     * Map a plugin specifier to its canonical plugin name.
     * @param specifier - Import specifier: a baked synthetic id or a URL-like path.
     * @returns The baked name when known; otherwise the path's final segment with any query and
     *          extension stripped (the input itself when nothing remains to strip).
     * @throws Never.
     */
    async identify(specifier: string): Promise<string> {
      if (specNames[specifier] !== undefined) return specNames[specifier]!;
      const last = (specifier.split('?')[0] ?? specifier).replace(/\/+$/, '').split('/').pop() ?? specifier;
      return last.replace(/\.[^.]+$/, '') || specifier;
    },
    // Baked by the assembler from each plugin's package.json; absent means "not declared", so the
    // loader imports and falls back to load/rollback. A remote .ts added at runtime is undeclared.
    /**
     * Report the matbotRuntimes a plugin declares, as baked by the assembler from its
     * package.json.
     * @param specifier - Plugin specifier to look up.
     * @returns The declared runtimes, or undefined when not declared — the loader then imports
     *          the plugin and falls back to load/rollback.
     * @throws Never.
     */
    async runtimes(specifier: string): Promise<readonly Runtime[] | undefined> {
      return specRuntimes[specifier];
    },
  };

  let sessionRunner: SessionRunner | undefined;

  const baseServices: MatbotMachine = {
    /**
     * Placeholder on the base machine: plugin settings are scoped per plugin, not global.
     * @returns Nothing (always throws).
     * @throws Error - Always; callers must use the services instance passed to `setup()`.
     */
    settings(): PluginSettings {
      throw new Error('settings() is only available within a plugin scope (use the services passed to setup()).');
    },
    createStore,
    /**
     * Read a registered service by its interface-name key.
     * @param key - Service key (interface name) to read.
     * @returns The registered implementation, or undefined when the key is absent.
     * @throws Never.
     */
    get(key) { return serviceRegistry.get(key as string) as never; },
    /**
     * Provide a service under its interface-name key. `StorageBackend` is staged and applied at
     * the next quiescent edge (it is the system of record, so the swap must not split a CAS);
     * `KnowledgeIndex` and `Vault` repoint immediately; anything else is a plain registry set.
     * Every key is marked dirty so the mount table multicasts the remount at the quiescent edge.
     * @param key - Service key (interface name) being provided.
     * @param value - Implementation to register, cast per key.
     * @returns Resolves once the registration is recorded; a StorageBackend swap may still be
     *          pending until the quiescent edge.
     * @throws Never.
     */
    async register(key, value) {
      // StorageBackend is the system of record: stage it and let the quiescent edge apply it (idle →
      // now; mid-turn → at turn end) — its mount notification is marked dirty there, after the swap
      // lands. The other swap-keys repoint immediately, then mark dirty so the edge multicasts the mount.
      if (key === 'StorageBackend')      stageSwap(value as StorageBackend);
      else if (key === 'KnowledgeIndex') swapKnowledge(value as KnowledgeIndex);
      else if (key === 'Vault')          activeVault = value as Vault;
      else serviceRegistry.set(key as string, value);
      if (key !== 'StorageBackend') { mountTable.markDirty(key); flushIfQuiescent(); }
    },
    // Symmetric with register: a swap-key reverts to the app's captured boot default instead of
    // dangling on the unloaded plugin's impl; everything else is a plain registry delete. Marking dirty
    // lets the edge deliver a committed unload (or, if re-registered before the edge, a single remount).
    /**
     * Remove a service: swap-keys revert to the host's captured boot default rather than
     * dangling on the unloaded plugin's impl; everything else is a plain registry delete. Marks
     * the key dirty so the edge delivers a committed unload — or a single remount if the key is
     * re-registered before the edge.
     * @param key - Service key being removed.
     * @returns Nothing.
     * @throws Never.
     */
    unregister(key: string) {
      if (key === 'StorageBackend')      stageSwap(bootBackend);
      else if (key === 'KnowledgeIndex') knowledgeImpl = bootKnowledge;
      else if (key === 'Vault')          activeVault = bootVault;
      else serviceRegistry.delete(key);
      if (key !== 'StorageBackend') { mountTable.markDirty(key as keyof MatbotServices); flushIfQuiescent(); }
    },
    /**
     * Base no-op: frontend registration is bound per-plugin within `setupPlugin`'s scope.
     * @returns Nothing.
     * @throws Never.
     */
    registerFrontend() { /* bound per-plugin in setupPlugin's scope; base is a no-op */ },

    /**
     * Run a one-shot completion against a configured provider. Credential and endpoint `${...}`
     * placeholders are resolved through the vault first; a synthetic system message is prepended
     * when the request carries one; the adapter's streamed events are folded into a single text
     * result with token usage.
     * @param req - Completion request naming a configured provider; `signal` aborts the stream
     *              when supplied, and without it the request never aborts.
     * @returns The concatenated response text plus input/output token usage.
     * @throws Error - The provider name is unknown, a secret cannot be resolved interactively,
     *          or the provider adapter fails.
     */
    async complete(req) {
      const rawCfg = providers.get(req.provider);
      if (rawCfg === undefined) throw new Error(`complete(): unknown provider "${req.provider}". Available: ${[...providers.keys()].join(', ')}`);
      const resolved: ProviderConfig = {
        ...rawCfg,
        ...(rawCfg.credentials !== undefined ? { credentials: await resolveCredentials(rawCfg.credentials, vault) } : {}),
        ...(rawCfg.endpoint    !== undefined ? { endpoint: await resolveInteractive(rawCfg.endpoint, vault) } : {}),
      };
      const adpt = resolveProviderFactory(resolved.module)(resolved);
      const msgs = req.system !== undefined
        ? [createMessage({ role: 'system', content: [{ type: 'text', text: req.system }], traceId: crypto.randomUUID() }), ...req.messages]
        : req.messages;
      let text = '', inputTokens = 0, outputTokens = 0;
      for await (const ev of adpt.complete(msgs, resolved, [], req.signal ?? NEVER_ABORT)) {
        if (ev.type === 'text-delta') text += ev.delta;
        if (ev.type === 'usage') { inputTokens = ev.inputTokens; outputTokens = ev.outputTokens; }
      }
      return { text, usage: { inputTokens, outputTokens } };
    },

    /**
     * Convenience wrapper: normalize a single-turn request and run it through complete().
     * @param req - Single-turn request (provider, system prompt, messages).
     * @returns The completed text and usage, as complete() returns.
     * @throws Error - Whatever complete() throws.
     */
    async singleTurn(req) {
      return this.complete(singleTurnRequest(req));
    },

    /**
     * Load a plugin by specifier at runtime. Remote `http(s)`/root-absolute specifiers are
     * fetched and type-stripped by the in-page loader into an ephemeral blob: URL, imported, and
     * recorded under their source URL so identify()/unload resolve consistently across reloads;
     * baked specifiers import via the import map. Cache busting is disabled — a query stamp
     * would corrupt blob:/mbmod: specifiers and remote blobs are already fresh — so a true
     * reload in the browser is a realm reload.
     * @param specifier - Import specifier, remote `.ts` URL, or baked package name.
     * @param prompt - Optional prompt function forwarded to the loader for interactive setup.
     * @returns The loaded plugin.
     * @throws Error - Loading fails (configured to throw) or yields no plugin.
     */
    async loadPlugin(specifier: string, prompt?: PromptFn): Promise<MatbotPlugin> {
      // A runtime add of a remote .ts (URL or root-absolute path) is fetched and type-stripped by the
      // in-page loader into an ephemeral blob: URL; baked baseline specifiers are already importable
      // via the import map. For a remote, we import the blob but record the *source* URL as the
      // plugin's specifier (via { spec, importSpec }) — the blob is per-load and meaningless across
      // reloads, whereas the source URL is what `plugin list` should show and reload/remove address.
      let req: string | { spec: string; importSpec: string; runtimes?: readonly Runtime[] } = specifier;
      if (/^https?:\/\//.test(specifier) || (specifier.startsWith('/') && !specifier.startsWith('mbmod:'))) {
        const remote = await loader.loadRemote(specifier);
        specNames[specifier] = remote.name;   // identify()/unload resolve by the source URL (= spec)
        // Carry the declared matbotRuntime so the loader can gate a node-only remote before import and
        // stamp plugin.matbotRuntime (which `list` reports — a blob: importSpec can't be re-read later).
        req = { spec: specifier, importSpec: remote.spec, ...(remote.runtimes !== undefined ? { runtimes: remote.runtimes } : {}) };
      }
      // bustCache=false: the in-browser loader has no disk to re-read, and the query stamp toFreshUrl
      // appends would corrupt a blob:/mbmod: specifier (those don't take query strings) — making the
      // import reject. A remote spec is a freshly fetched blob, so it's already fresh; baked specs
      // re-import their existing blob. (True reload in the browser is a realm reload, by design.)
      const loaded = await loadPlugins([req], services, /* bustCache */ false, prompt, /* onLoadError */ 'throw');
      const plugin = loaded[0];
      if (plugin === undefined) throw new Error(`No plugin loaded for specifier "${specifier}"`);
      return plugin;
    },
    /**
     * Unload the plugin loaded for a specifier, resolving the specifier to its canonical name
     * first (loader registry, then the baked/remote specNames map).
     * @param specifier - Specifier the plugin was loaded under.
     * @returns True when a matching plugin was found and unloaded; false when none is loaded.
     * @throws Error - Plugin teardown fails or exceeds the core's 10-second teardown timeout.
     */
    async unloadPlugin(specifier: string): Promise<boolean> {
      const name = getPluginNameForSpecifier(specifier) ?? (specNames[specifier] !== undefined ? specNames[specifier] : undefined);
      if (name === undefined) { console.warn(`[matbot] No loaded plugin for specifier "${specifier}"`); return false; }
      return unloadPluginFn(name, services);
    },

    resolver,
    providers,
    mounted: mountTable.mounted,
    /**
     * The active storage backend behind a capture-safe proxy.
     * @returns The current {@link StorageBackend} proxy; undefined only before a backend has
     *          been initialised (never once boot has completed).
     */
    get StorageBackend() { return activeStorageBackend === undefined ? undefined : storageBackendProxy; },
    sessions: store,
    /**
     * The active session runner.
     * @returns The {@link SessionRunner}, or undefined before it is created during boot.
     */
    get run() { return sessionRunner; },
    files: fileStore,
    Vault: vault,
    hooks:         hookReg,
    tools:         toolReg,
    systemContext: systemContextReg,
    isSubAgent: () => false,
    /**
     * The active knowledge index behind a capture-safe proxy, following register()-driven swaps.
     * @returns The current {@link KnowledgeIndex} proxy.
     */
    get KnowledgeIndex() { return knowledgeProxy; },
  };
  const services: MatbotMachine = unifyServices(baseServices);

  /**
   * Resolve a provider name to its adapter and fully-resolved config, substituting `${...}`
   * credential and endpoint placeholders through the vault.
   * @param name - Configured provider name to look up.
   * @returns The adapter (factory resolved by the provider's module/plugin name) plus the
   *          resolved config, or null when the name is not configured.
   * @throws Error - Secret resolution fails or the module resolves to no provider factory.
   */
  const resolveProvider = async (name: string): Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null> => {
    const cfg = providers.get(name);
    if (cfg === undefined) return null;
    const resolved: ProviderConfig = {
      ...cfg,
      ...(cfg.credentials !== undefined ? { credentials: await resolveCredentials(cfg.credentials, vault) } : {}),
      ...(cfg.endpoint    !== undefined ? { endpoint: await resolveInteractive(cfg.endpoint, vault) } : {}),
    };
    return { adapter: resolveProviderFactory(resolved.module)(resolved), config: resolved };
  };

  sessionRunner = createSessionRunner({
    permissions: () => services.ToolInvocationPolicy,
    store,
    resolveProvider,
    tools:         toolReg,
    hooks:         hookReg,
    systemContext: systemContextReg,
    vault,
    files:         fileStore,
    loadPlugin:    services.loadPlugin.bind(services),
    unloadPlugin:  services.unloadPlugin.bind(services),
  });

  // Load provider plugins first, then canonicalise each provider's module to the loaded plugin's
  // name so resolveProviderFactory (keyed by plugin name) finds the adapter regardless of specifier.
  await loadPlugins(providerSpecs, services);
  for (const [key, cfg] of providers) {
    const pluginName = getPluginNameForSpecifier(cfg.module);
    if (pluginName !== undefined && pluginName !== cfg.module) providers.set(key, { ...cfg, module: pluginName });
  }

  // Apply a provider draft: persist it (config → localStorage, key → vault), load the adapter plugin
  // if new, canonicalise its module to the plugin name, and register it in the live providers map.
  // Shared by the wizard (UI), the runtime "+ Add provider" bridge, and the `provider` tool (LLM).
  /**
   * Apply a provider draft: persist it (config to localStorage, key to the vault), load the
   * adapter plugin when it is not loaded yet, canonicalise the module to the plugin name, and
   * register it in the live providers map. Shared by the wizard UI, the runtime "+ Add provider"
   * bridge, and the `provider` tool.
   * @param draft - Provider draft to apply.
   * @returns The provider's config name (the key it is registered under).
   * @throws Error - Persisting the draft or loading the adapter plugin fails.
   */
  const applyDraft = async (draft: ProviderDraft): Promise<string> => {
    const cfg = await persistDraft(draft);
    let name = getPluginNameForSpecifier(cfg.module);
    if (name === undefined) {
      await loadPlugins([cfg.module], services);
      name = getPluginNameForSpecifier(cfg.module);
    }
    providers.set(cfg.name, name !== undefined ? { ...cfg, module: name } : cfg);
    return cfg.name;
  };
  /**
   * Remove a provider from the live providers map and its persisted copy from localStorage.
   * @param name - Provider name to remove.
   * @returns True when the provider existed and was removed; false otherwise.
   * @throws Never.
   */
  const removeProvider = async (name: string): Promise<boolean> => {
    if (!providers.has(name)) return false;
    providers.delete(name);
    removePersistedProvider(name);
    return true;
  };

  // The portable `provider` tool — list/add/remove over the same persistence the wizard uses.
  serviceRegistry.set('BrowserProviderAdmin',{
    available: config.availableProviders,
    list: () => [...providers.values()].map(p => ({
      name: p.name, module: p.module, model: p.model,
      ...(p.endpoint   !== undefined ? { endpoint:   p.endpoint   } : {}),
      ...(p.parameters !== undefined ? { parameters: p.parameters } : {}),
      hasKey: p.credentials?.['apiKey'] !== undefined,
    })),
    add:    applyDraft,
    remove: removeProvider,
  });

  // single_turn: the same core tool the node app registers — a one-shot completion against any
  // configured provider (or the current turn's, when omitted). Pure (services only), so it runs
  // identically in the browser realm.


  // Let the frontend offer "add another provider" from the UI (runs the wizard form).
  (globalThis as unknown as Record<string, unknown>).__mbProviders = {
    add:  async () => applyDraft(await runProviderSetup(config.availableProviders, { title: 'Add a provider', cancelable: true })),
    list: () => [...providers.keys()],
  };

  // Then the rest — frontends, tools, storage, knowledge, hooks. The frontend plugin mounts the UI.
  await loadPlugins(config.plugins, services);

  // The pre-scan opened a manifest storageBackend before the loader knew the plugin's name, bypassing
  // the scoped register() that records a service key. Attribute it now, so unloading that plugin reverts
  // storage to the host base and closes the backend — unload-equal to a runtime register().
  if (storageBootSpec !== undefined) {
    const name = getPluginNameForSpecifier(storageBootSpec);
    if (name !== undefined) recordServiceKey(name, 'StorageBackend');
  }

  console.warn('[matbot] web runtime ready —', toolReg.list().length, 'tools,', providers.size, 'providers.');
}
