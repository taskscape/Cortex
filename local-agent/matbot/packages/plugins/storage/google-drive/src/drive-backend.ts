import type { FileStore, StorageBackend, Store } from '@matatbread/matbot-core';
import type { DriveAuth } from './drive-auth.js';
import { DriveClient }    from './drive-client.js';
import { DriveStore }     from './drive-store.js';
import { DriveFileStore } from './drive-file-store.js';

const FILES_FOLDER = '__files';

/** OAuth scope: per-file access (`drive.file`) — matbot only ever sees files it created. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * `StorageBackend` that persists every document store and file blob to a folder in the user's Google
 * Drive. Layout mirrors the filesystem backend: `<rootFolder>/<namespace>/<id>.json` for documents,
 * `<rootFolder>/__files/` for blob + sidecar pairs. Auth is in-browser via Google Identity Services
 * (see {@link DriveAuth}) — no server, no client secret.
 *
 * The root and per-namespace folders are resolved (and created) lazily and memoised, so activating
 * the backend costs one OAuth popup and the folder structure materialises on first use of each store.
 */
export class GoogleDriveStorageBackend implements StorageBackend {
  private readonly drive:    DriveClient;
  private readonly rootId:   Promise<string>;
  private readonly stores = new Map<string, Store<{ id: string; version: string }>>();
  readonly fileStore: FileStore;

  /**
   * Creates the backend and starts resolving the root folder (memoised
   * promise); the `__files` subfolder backing the file store is derived from
   * it. Use {@link GoogleDriveStorageBackend.fromAuth} — the constructor is
   * private.
   * @param drive - Authorised Drive client.
   * @param rootFolder - Name of the data-root folder under Drive root, created
   *   when missing.
   * @throws Never — folder-resolution errors surface when `rootId` is awaited
   *   (e.g. by {@link GoogleDriveStorageBackend.ready} or the stores).
   */
  private constructor(drive: DriveClient, rootFolder: string) {
    this.drive  = drive;
    this.rootId = drive.ensureFolderPath([rootFolder]);
    this.fileStore = new DriveFileStore(drive, this.rootId.then(r => drive.ensureFolder(FILES_FOLDER, r)));
  }

  /**
   * Returns the store for a namespace, creating the instance and its Drive
   * folder lazily. One store per namespace is cached; Drive errors surface
   * when the store is first used, not here.
   * @template T - Stored document shape ({ id, version } at minimum).
   * @param namespace - Subfolder name under the root folder.
   * @returns A {@link DriveStore} for the namespace.
   * @throws Never.
   */
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    let store = this.stores.get(namespace);
    if (store === undefined) {
      const folderId = this.rootId.then(r => this.drive.ensureFolder(namespace, r));
      store = new DriveStore<{ id: string; version: string }>(this.drive, folderId);
      this.stores.set(namespace, store);
    }
    return store as Store<T>;
  }

  /**
   * No-op: Drive holds no local resources to release. Present to satisfy the
   * StorageBackend contract.
   * @returns Resolves immediately.
   * @throws Never.
   */
  async close(): Promise<void> {}

  /**
   * Awaits resolution of the root folder — a real Drive round-trip. Used as a
   * connectivity probe *before* committing to this backend, so a broken Drive
   * never gets swapped in to brick every subsequent store operation.
   * @returns Resolves once the root folder exists.
   * @throws Error when Drive is unreachable or misconfigured (e.g. the Drive
   *   API is not enabled for the project, or the token lacks scope).
   */
  async ready(): Promise<void> {
    await this.rootId;
  }

  /**
   * Builds the backend from an already-authorised {@link DriveAuth}.
   * Authorisation is the caller's job (the setup overlay drives the GIS popup
   * from a user gesture, or a cached token is reused) — the backend itself does
   * no interactive auth, so it can be constructed off the gesture path.
   * @param auth - Authenticated Drive auth helper.
   * @param rootFolder - Name of the data-root folder under Drive root, created
   *   when missing.
   * @returns The new backend instance.
   * @throws Error when not running in a browser (no `document`), since
   *   authentication relies on Google Identity Services.
   */
  static fromAuth(auth: DriveAuth, rootFolder: string): GoogleDriveStorageBackend {
    if (typeof document === 'undefined') {
      throw new Error('@matatbread/matbot-storage-google-drive is browser-only (it authenticates via Google Identity Services).');
    }
    return new GoogleDriveStorageBackend(new DriveClient(auth), rootFolder);
  }
}
