import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendMessage,
  createMessage,
  createSession,
  HookRegistry,
  runSession,
} from '@matatbread/matbot-core';
import type {
  Message,
  ProviderAdapter,
  Session,
  Store,
} from '@matatbread/matbot-core';

test('frontend attachment context follows screen retrieval context and is not persisted', async () => {
  const principal = { id: 'attachment-test-user', type: 'user' as const };
  let stored = appendMessage(
    createSession({ ownerPrincipal: principal }),
    createMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Summarize README.md.' }],
      traceId: 'trace-attachment',
    }),
  );

  const store: Store<Session> = {
    async get(id) { return id === stored.id ? stored : null; },
    async set(_id, value) { stored = value; },
    async cas() { throw new Error('cas is not used by this test'); },
    async delete() { return false; },
    async query() { throw new Error('query is not used by this test'); },
  };

  const hooks = new HookRegistry();
  hooks.register({
    on: 'screen',
    handler: () => ({
      ephemeral: [{
        type: 'text',
        text: '[Workspace RAG context]\nHost path: C:/RAG-test/README.md',
      }],
    }),
  });

  let outgoing: Message[] = [];
  const provider: ProviderAdapter = {
    name: 'attachment-test',
    async *complete(messages) {
      outgoing = [...messages];
      yield { type: 'text-delta', delta: 'summary' };
      yield { type: 'done' };
    },
    async health() { return { status: 'ok' }; },
  };

  for await (const _event of runSession({
    session: stored,
    config: {
      provider: 'attachment-test',
      traceId: 'trace-attachment',
      rootTraceId: 'trace-attachment',
      sessionId: stored.id,
    },
    provider,
    providerConfig: {
      name: 'attachment-test',
      module: './attachment-test',
      model: 'attachment-test',
    },
    store,
    hooks,
    signal: new AbortController().signal,
    tailEphemeral: [{
      type: 'text',
      origin: 'robo',
      text: '[Explicit Cortex Files attachments]\nUse workspace_action for README.md.',
    }],
    async loadPlugin() { throw new Error('loadPlugin is not used by this test'); },
    async unloadPlugin() { return false; },
  })) {
    // Drain the turn so the provider call and final persistence complete.
  }

  const userMessage = outgoing.findLast(message => message.role === 'user');
  assert.ok(userMessage);
  assert.deepEqual(
    userMessage.content.filter(part => part.type === 'text').map(part => part.text),
    [
      'Summarize README.md.',
      '[Workspace RAG context]\nHost path: C:/RAG-test/README.md',
      '[Explicit Cortex Files attachments]\nUse workspace_action for README.md.',
    ],
  );

  const persistedText = stored.messages
    .flatMap(message => message.content)
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
  assert.doesNotMatch(persistedText, /Workspace RAG context|Explicit Cortex Files attachments/);
});
