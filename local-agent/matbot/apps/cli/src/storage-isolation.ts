import { join, dirname } from 'node:path';
import type { CASResult, QueryResult, StorageBackend, Store, StoreQuery } from '@matatbread/matbot-core';
import { executeQuery } from '@matatbread/matbot-storage-base';
import { FilesystemStore } from '@matatbread/matbot-storage-filesystem';

/** In-memory store used for every namespace in an ephemeral host process. */
export class MemoryStore<T extends { id: string; version: string }> implements Store<T> {
  private readonly items = new Map<string, T>();

  async get(id: string): Promise<T | null> {
    return this.items.get(id) ?? null;
  }

  async set(id: string, value: T): Promise<void> {
    this.items.set(id, value);
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    const current = this.items.get(id) ?? null;
    if (current === null || current.version !== expected) return { ok: false, current };
    this.items.set(id, next);
    return { ok: true, doc: next };
  }

  async delete(id: string, expectedVersion?: string): Promise<boolean> {
    if (expectedVersion !== undefined) {
      const current = this.items.get(id);
      if (current === undefined || current.version !== expectedVersion) return false;
    }
    return this.items.delete(id);
  }

  async query(q: StoreQuery): Promise<QueryResult<T>> {
    return executeQuery([...this.items.values()], q);
  }
}

export function workspaceDataDirectory(configPath: string): string {
  return join(dirname(configPath), '.data');
}

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
