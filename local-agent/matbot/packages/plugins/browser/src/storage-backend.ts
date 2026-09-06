import type { Store, FileStore, StorageBackend } from '@matatbread/matbot-core';
import { IDBStore }      from './idb-store.js';
import { OPFSFileStore } from './opfs-file-store.js';

/**
 * Refuse to run anywhere that isn't a browser realm. This plugin's whole contract — IndexedDB stores,
 * an OPFS file store — is browser-only, so if a node install accidentally lists it, the storage
 * pre-scan would otherwise swap in a backend that cannot work and brick the config. Throwing here
 * (and in setup) makes the host fall back to its real backend and skip the plugin instead.
 *
 * `process` is referenced via globalThis so this stays free of `@types/node` (the package is
 * platform-neutral); the IndexedDB check is the positive signal, the node check sharpens the message.
 *
 * @returns Nothing.
 * @throws Error - When not running in a browser realm (no IndexedDB available, or a Node
 *          runtime detected).
 */
export function assertBrowserRealm(): void {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
  if (typeof indexedDB === 'undefined' || node !== undefined) {
    throw new Error(
      '@matatbread/matbot-browser is a browser-only plugin (IndexedDB + OPFS backend) and cannot run under Node' +
      (node !== undefined ? ` (detected Node ${node})` : '') +
      '. Remove it from this installation — the node app already uses the filesystem storage backend by default.',
    );
  }
}

/**
 * Browser `StorageBackend`: document stores in IndexedDB, files in OPFS — the browser analogue of
 * the node filesystem backend. Each namespace gets its own IndexedDB database (`matbot-<ns>`) with a
 * single `docs` object store, sidestepping the version-1 upgrade race that opening many object
 * stores in one database would hit. Instances are cached per namespace so repeated `createStore`
 * calls reuse one connection.
 *
 * `open()` ignores its `dotData` argument — there is no filesystem path in the browser; the IDB
 * database names and the OPFS `matbot-files` directory are the durable locations.
 */
export class BrowserStorageBackend implements StorageBackend {
  private readonly stores = new Map<string, Store<{ id: string; version: string }>>();
  readonly fileStore: FileStore = new OPFSFileStore();

  /**
   * Returns (creating and caching if needed) the document store for a namespace.
   * @param namespace Logical namespace; each gets its own IndexedDB database.
   * @returns A `Store<T>` backed by IndexedDB for that namespace.
   * @throws Never — the database opens lazily; connection failures surface on store use.
   */
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    let store = this.stores.get(namespace);
    if (store === undefined) {
      store = new IDBStore<{ id: string; version: string }>(`matbot-${namespace}`, 'docs');
      this.stores.set(namespace, store);
    }
    return store as Store<T>;
  }

  // IndexedDB connections close with the realm; nothing to flush. OPFS writes are durable on close.
  /**
   * Release resources; nothing to do — IndexedDB connections close with the realm and OPFS
   * writes are durable on close.
   * @returns Resolves immediately.
   * @throws Never.
   */
  async close(): Promise<void> {}

  /**
   * Opens the backend after verifying a browser realm.
   * @param _dotData Unused in the browser; durable locations are IDB databases and OPFS.
   * @returns A ready `BrowserStorageBackend` instance.
   * @throws If the code runs under Node or lacks IndexedDB.
   */
  static async open(_dotData: string): Promise<BrowserStorageBackend> {
    assertBrowserRealm();
    return new BrowserStorageBackend();
  }
}
