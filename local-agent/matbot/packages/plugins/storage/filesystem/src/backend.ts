import { join } from 'node:path';
import type { Store, FileStore, StorageBackend } from '@matatbread/matbot-plugin-api';
import { FilesystemFileStore } from '@matatbread/matbot-files-node';
import { FilesystemStore } from './store.js';

// Reproduces, as an explicit registered backend, the exact layout the node host already falls back to
// when no StorageBackend is registered: each namespace is a directory `<dotData>/<namespace>` of
// per-id JSON files (FilesystemStore), and files live under `<dotData>/files` (FilesystemFileStore).
// Installing the plugin therefore changes nothing about *where* data lives — its point is that the
// filesystem store becomes nameable, so you can assert it to override another backend instead of only
// reaching it implicitly by unregistering whatever is in force. Stores mkdir lazily, so open() opens
// nothing eagerly (cf. SQLite, which must create its db file).
/**
 * A {@link StorageBackend} mapping each namespace to a directory of per-id
 * JSON files under `<dotData>/<namespace>`, with binary files under
 * `<dotData>/files`. Mirrors the node host's implicit default layout, but as a
 * nameable registered backend. Nothing is opened eagerly — stores mkdir lazily.
 */
export class FilesystemStorageBackend implements StorageBackend {
  /** FileStore rooted at `<dotData>/files`. */
  readonly fileStore: FileStore;
  private readonly dotData: string;

  /**
   * Creates the backend. Nothing is opened or created eagerly — the file store
   * root and namespace directories materialise on first use.
   * @param dotData - Root directory for all namespaces and files.
   * @throws Never.
   */
  constructor(dotData: string) {
    this.dotData   = dotData;
    this.fileStore = new FilesystemFileStore(join(dotData, 'files'));
  }

  /**
   * Creates the backend (kept async to match the StorageBackend contract).
   * @param dotData - Root directory.
   * @returns The new backend instance.
   */
  static open(dotData: string): Promise<FilesystemStorageBackend> {
    return Promise.resolve(new FilesystemStorageBackend(dotData));
  }

  /**
   * Creates a JSON-file store for a namespace directory.
   * @param namespace - Subdirectory name under the data root.
   * @returns A store persisting documents of type `T`.
   * @template T - Stored document shape ({ id, version } at minimum).
   */
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    return new FilesystemStore<T>(join(this.dotData, namespace));
  }
}
