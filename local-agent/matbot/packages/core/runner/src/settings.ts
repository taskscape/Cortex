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
 */
export function makePluginSettings(store: Store<SettingsDoc>, namespace: string): PluginSettings {
  const id = slugSettingsNamespace(namespace);

  // Handles migration from the old flat-object format (pre-Store).
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

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return (await getDoc())?.data[key] as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
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
    },
    async delete(key: string): Promise<void> {
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
    },
  };
}
