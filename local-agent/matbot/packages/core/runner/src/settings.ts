import type { PluginSettings, Store } from '@matatbread/matbot-plugin-api';

/** The persisted settings document backing a plugin's scoped key-value store. */
export interface SettingsDoc {
  /** Document id — the slugged namespace. */
  id:      string;
  /** Optimistic-concurrency version. */
  version: string;
  /** The plugin's settings payload. */
  data:    Record<string, unknown>;
}

/**
 * Runtime shape check distinguishing a settings document from the legacy flat-object format.
 *
 * @param v - Any value read from the settings store.
 * @returns True when `v` is a well-formed {@link SettingsDoc}.
 */
export function isSettingsDoc(v: unknown): v is SettingsDoc {
  return typeof v === 'object' && v !== null &&
    typeof (v as SettingsDoc).id      === 'string' &&
    typeof (v as SettingsDoc).version === 'string' &&
    typeof (v as SettingsDoc).data    === 'object' && (v as SettingsDoc).data !== null;
}

/**
 * Settings namespaces double as Store document ids, which the filesystem store restricts to
 * /^[\w-]+$/. Plugin names are now loader-derived package names (`@scope/pkg`), so slug them to a
 * safe id. Collisions are theoretically possible but irrelevant for this install scale.
 *
 * @param name - Namespace to slug, typically a plugin name.
 * @returns The namespace with every run of characters outside `[\w-]` replaced by `_`.
 * @throws Never.
 */
export function slugSettingsNamespace(name: string): string {
  return name.replace(/[^\w-]+/g, '_');
}

// Millisecond timestamps collide under burst writes, so each version carries a same-ms sequence
// number — unique and monotonic across the process. CAS retries are bounded: a perpetually
// contended document fails loudly instead of livelocking the loop.
const MAX_CAS_ATTEMPTS = 8;

let versionMs  = 0;
let versionSeq = 0;
/**
 * Produce a unique, process-monotonic version string for a settings write.
 *
 * Format `<Date.now() ms>.<same-millisecond sequence>`: the sequence increments within one
 * millisecond and resets on the next, so versions never repeat or move backwards within this
 * process. Mutates module-level sequencing state.
 *
 * @returns The new version string.
 * @throws Never.
 */
function nextVersion(): string {
  const ms = Date.now();
  if (ms === versionMs) versionSeq++;
  else { versionMs = ms; versionSeq = 0; }
  return `${ms}.${versionSeq}`;
}

/**
 * Build a PluginSettings facade over the shared settings store, scoped to one document id.
 * Writes use compare-and-swap with retry; a pre-Store flat-object document is migrated on read.
 *
 * @param store - The shared settings store (namespace 'settings').
 * @param namespace - The plugin's settings namespace (slugged to a document id).
 * @returns A get/set/delete view scoped to that namespace.
 * @throws Error - Thrown by the returned view's methods: on compare-and-swap conflicts or
 *   exhausted retries, and when a stored document has an unexpected (corrupted) shape.
 */
// Serialize first-write initialization across facades sharing this runtime's store.
const settingsQueues = new WeakMap<object,Map<string,Promise<unknown>>>();
export function makePluginSettings(store: Store<SettingsDoc>, namespace: string): PluginSettings {
  const id = slugSettingsNamespace(namespace);

  // Handles migration from the old flat-object format (pre-Store).
  /**
   * Read this namespace's settings document, migrating the legacy flat-object format on the way.
   *
   * @returns The current document, or null when nothing is stored yet. A legacy flat
   *   `{ key: value }` record is wrapped with version `'0'` so the next write upgrades it.
   * @throws Error - When the stored document is neither a {@link SettingsDoc} nor a plain object.
   */
  const getDoc = async (): Promise<SettingsDoc | null> => {
    const raw = await store.get(id);
    if (raw === null) return null;
    if (isSettingsDoc(raw)) return raw;
    // Old format: flat { key: value } — wrap it so subsequent writes upgrade the file. Guarded:
    // a corrupted non-object document fails loudly here instead of flowing through as an
    // empty payload.
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Settings document "${id}" has unexpected shape (${Array.isArray(raw) ? 'array' : typeof raw}); refusing to treat it as a flat settings record`);
    }
    return { id, version: '0', data: raw as unknown as Record<string, unknown> };
  };

  const queues = settingsQueues.get(store) ?? new Map<string,Promise<unknown>>(); settingsQueues.set(store,queues);
  /**
   * Run an operation serialized after any pending operation for this namespace, so concurrent
   * read-modify-write callers cannot interleave.
   *
   * @typeParam T - The operation's result type.
   * @param operation - Async operation to run; its rejection propagates to the caller without
   *   blocking queued successors.
   * @returns The operation's result.
   * @throws Whatever `operation` rejects with.
   */
  const serial = async <T>(operation:()=>Promise<T>):Promise<T> => {
    const previous=queues.get(id)??Promise.resolve();const next=previous.catch(()=>{}).then(operation);queues.set(id,next);
    try{return await next;}finally{if(queues.get(id)===next)queues.delete(id);}
  };
  return {
    /**
     * Read the current settings payload and its version.
     *
     * @returns A `{ version, data }` snapshot with a deep-cloned payload; `version` is
     *   `'absent'` and `data` empty when nothing is stored yet.
     * @throws Error - When the stored document has an unexpected shape.
     */
    async snapshot(){return serial(async()=>{const doc=await getDoc();return {version:doc?.version??'absent',data:structuredClone(doc?.data??{})};});},
    /**
     * Replace the whole settings payload, guarded by optimistic concurrency.
     *
     * @param data - New payload; stored deep-cloned.
     * @param expectedVersion - Version the caller last observed (`'absent'` for a fresh
     *   document); the write is rejected when it no longer matches.
     * @returns The new version and a clone of the stored payload.
     * @throws Error - When `expectedVersion` no longer matches, or the compare-and-swap loses.
     */
    async replace(data,expectedVersion){return serial(async()=>{
      const doc=await getDoc();if((doc?.version??'absent')!==expectedVersion)throw new Error('Configuration conflict; reload before editing');
      const next={id,version:crypto.randomUUID(),data:structuredClone(data)};
      if(doc===null||doc.version==='0')await store.set(id,next);
      else if(!(await store.cas(id,doc.version,next)).ok)throw new Error('Configuration conflict; reload before editing');
      return {version:next.version,data:structuredClone(next.data)};
    });},
    /**
     * Read one settings value.
     *
     * @typeParam T - Expected value type; not validated at runtime.
     * @param key - Settings key.
     * @returns The value, or undefined when the document or the key is absent.
     * @throws Error - When the stored document has an unexpected shape.
     */
    async get<T>(key: string): Promise<T | undefined> {
      return (await getDoc())?.data[key] as T | undefined;
    },
    /**
     * Write one settings value with compare-and-swap retry.
     *
     * Retries on concurrent modification with a small backoff; a migrated-but-unwritten
     * document (version `'0'`) is upgraded with a plain set.
     *
     * @typeParam T - Value type to store.
     * @param key - Settings key to write.
     * @param value - Value to store.
     * @returns Nothing.
     * @throws Error - When the write fails after {@link MAX_CAS_ATTEMPTS} attempts, or the
     *   stored document has an unexpected shape.
     */
    async set<T>(key: string, value: T): Promise<void> { return serial(async()=>{
      for (let attempt = 0; ; attempt++) {
        const doc  = await getDoc();
        const data = { ...(doc?.data ?? {}), [key]: value as unknown };
        const next: SettingsDoc = { id, version: nextVersion(), data };
        // version '0' means migrated-but-not-yet-written — use set to upgrade the file.
        if (doc === null || doc.version === '0') { await store.set(id, next); return; }
        const r = await store.cas(id, doc.version, next);
        if (r.ok) return;
        if (attempt + 1 >= MAX_CAS_ATTEMPTS) {
          throw new Error(`Settings write for "${id}" failed after ${MAX_CAS_ATTEMPTS} concurrent attempts`);
        }
        await new Promise(resolve => setTimeout(resolve, attempt * 5));
      }
    });},
    /**
     * Remove one settings value with compare-and-swap retry.
     *
     * A no-op when nothing is stored; retries on concurrent modification like `set`.
     *
     * @param key - Settings key to remove.
     * @returns Nothing.
     * @throws Error - When the delete fails after {@link MAX_CAS_ATTEMPTS} attempts, or the
     *   stored document has an unexpected shape.
     */
    async delete(key: string): Promise<void> { return serial(async()=>{
      for (let attempt = 0; ; attempt++) {
        const doc = await getDoc();
        if (doc === null) return;
        const data = { ...doc.data };
        delete data[key];
        const next: SettingsDoc = { id, version: nextVersion(), data };
        if (doc.version === '0') { await store.set(id, next); return; }
        const r = await store.cas(id, doc.version, next);
        if (r.ok) return;
        if (attempt + 1 >= MAX_CAS_ATTEMPTS) {
          throw new Error(`Settings delete for "${id}" failed after ${MAX_CAS_ATTEMPTS} concurrent attempts`);
        }
        await new Promise(resolve => setTimeout(resolve, attempt * 5));
      }
    });},
  };
}
