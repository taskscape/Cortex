import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageBackend } from '@matatbread/matbot-core';
import { createWorkspaceStore, workspaceDataDirectory } from '../src/storage-isolation.js';

interface Fact {
  id: string;
  version: string;
  fact: string;
}

test('ephemeral stores never open or write to a configured persistent backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matbot-ephemeral-memory-'));
  let backendCalls = 0;
  const backend = {
    createStore() {
      backendCalls += 1;
      throw new Error('persistent backend must not be opened for an ephemeral store');
    },
  } as unknown as StorageBackend;

  try {
    const store = createWorkspaceStore<Fact>({
      ephemeral: true,
      namespace: 'remembered_facts',
      dotData: join(root, '.data'),
      sessionsDir: join(root, '.data', 'sessions'),
      backend,
    });
    await store.set('fact-1', { id: 'fact-1', version: 'v1', fact: 'test-only' });
    assert.equal((await store.get('fact-1'))?.fact, 'test-only');
    assert.equal(backendCalls, 0);
    await assert.rejects(access(join(root, '.data', 'remembered_facts')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the same memory id resolves independently in each workspace data directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matbot-workspace-memory-'));
  try {
    const configA = join(root, 'workspaces', 'alpha', 'matbot.yaml');
    const configB = join(root, 'workspaces', 'beta', 'matbot.yaml');
    const dataA = workspaceDataDirectory(configA);
    const dataB = workspaceDataDirectory(configB);
    assert.notEqual(dataA, dataB);

    const storeA = createWorkspaceStore<Fact>({
      ephemeral: false,
      namespace: 'remembered_facts',
      dotData: dataA,
      sessionsDir: join(dataA, 'sessions'),
    });
    const storeB = createWorkspaceStore<Fact>({
      ephemeral: false,
      namespace: 'remembered_facts',
      dotData: dataB,
      sessionsDir: join(dataB, 'sessions'),
    });

    await storeA.set('shared-id', { id: 'shared-id', version: 'a', fact: 'alpha-only' });
    await storeB.set('shared-id', { id: 'shared-id', version: 'b', fact: 'beta-only' });
    assert.equal((await storeA.get('shared-id'))?.fact, 'alpha-only');
    assert.equal((await storeB.get('shared-id'))?.fact, 'beta-only');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
