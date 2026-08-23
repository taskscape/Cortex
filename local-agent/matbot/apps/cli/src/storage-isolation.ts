import { join, dirname } from 'node:path';
import type { CASResult, QueryResult, StorageBackend, Store, StoreQuery } from '@matatbread/matbot-core';
import { executeQuery } from '@matatbread/matbot-storage-base';
import { FilesystemStore } from '@matatbread/matbot-storage-filesystem';

/** In-memory store used for every namespace in an ephemeral host process. */
export class MemoryStore<T extends { id: string; version: string }> implements Store<T> {
  private readonly items = new Map<string, T>();

  /**
   * Retrieve a document by id.
   * @param id Document identifier.
   * @returns The stored document, or null when absent.
   */
  async get(id: string): Promise<T | null> {
    return this.items.get(id) ?? null;
  }

  /**
   * Unconditionally overwrite a document.
   * @param id Document identifier.
   * @param value Full document to store.
   * @returns Resolves when the write completes.
   */
  async set(id: string, value: T): Promise<void> {
    this.items.set(id, value);
  }

  /**
   * Compare-and-swap write: replace the document only if its version matches.
   * @param id Document identifier.
   * @param expected Version the caller believes is current.
   * @param next Replacement document.
   * @returns `{ ok: true, doc }` on success, or `{ ok: false, current }` with the live document (possibly null) otherwise.
   */
  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    const current = this.items.get(id) ?? null;
    if (current === null || current.version !== expected) return { ok: false, current };
    this.items.set(id, next);
    return { ok: true, doc: next };
  }

  /**
   * Delete a document, optionally guarded by an expected version.
   * @param id Document identifier.
   * @param expectedVersion When given, deletion only proceeds if the stored version matches.
   * @returns True if the document was deleted (or was already absent without a version guard).
   */
  async delete(id: string, expectedVersion?: string): Promise<boolean> {
    if (expectedVersion !== undefined) {
      const current = this.items.get(id);
      if (current === undefined || current.version !== expectedVersion) return false;
    }
    return this.items.delete(id);
  }

  /**
   * Filter/sort/limit over all in-memory documents.
   * @param q Translatable store query.
   * @returns Matching items plus the total count before limit.
   */
  async query(q: StoreQuery): Promise<QueryResult<T>> {
    return executeQuery([...this.items.values()], q);
  }
}

/**
 * Resolve the `.data` directory that belongs to a workspace config file: the
 * `.data` sibling of `matbot.yaml`.
 * @param configPath Path to the workspace's matbot.yaml.
 * @returns Absolute path of the adjacent `.data` directory.
 */
export function workspaceDataDirectory(configPath: string): string {
  return join(dirname(configPath), '.data');
}

/**
 * Create a document store for one namespace in a workspace, honouring isolation:
 * ephemeral hosts get a MemoryStore so nothing is written to a real workspace,
 * otherwise the configured backend is used with FilesystemStore as fallback.
 * @param options Ephemeral flag, namespace name, `.data` directory, sessions directory, and optional backend.
 * @returns A Store bound to the namespace (in-memory when ephemeral).
 */
export function createWorkspaceStore<T extends { id: string; version: string }>(options: {
  ephemeral: boolean;
  namespace: string;
  dotData: string;
  sessionsDir: string;
  backend?: StorageBackend;
}): Store<T> {
  // Ephemeral means all document stores, not only sessions. This prevents
  // tests, one-shot prompts, and background probes from writing cognition,
  // settings, skill, trigger, or tool-store records into a real workspace.
  if (options.ephemeral) return new MemoryStore<T>();
  return options.backend?.createStore<T>(options.namespace)
    ?? new FilesystemStore<T>(options.namespace === 'sessions'
      ? options.sessionsDir
      : join(options.dotData, options.namespace));
}
