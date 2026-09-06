import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

register('./ts-hooks.js', pathToFileURL(fileURLToPath(new URL('../local-agent/matbot/apps/cli/ts-hooks.js', import.meta.url))));
const { OpenRouterAdapter } = await import('../local-agent/matbot/packages/plugins/providers/openrouter/src/adapter.ts');
const { toOAIMessages } = await import('../local-agent/matbot/packages/plugins/providers/openai-compat/src/convert.ts');
const { runSession } = await import('../local-agent/matbot/packages/core/runner/src/runner.ts');

const encoder = new TextEncoder();
function sse(...frames) {
  return new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(typeof frame === 'string' ? encoder.encode(frame) : frame); controller.close(); } }), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}
function profile(parameters = {}) {
  return { name: 'OpenRouter Chat', module: 'openrouter', model: 'vendor/exact-model', credentials: { apiKey: 'fake-openrouter-key' }, parameters };
}
async function collect(adapter, config = profile(), tools = []) {
  const events = [];
  for await (const event of adapter.complete([{ id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: '', traceId: '' }], config, tools, new AbortController().signal)) events.push(event);
  return events;
}

test('OR-03 through OR-05 sends only the exact selected model and approved OpenRouter dialect fields', async () => {
  let url; let request;
  const adapter = new OpenRouterAdapter(async (input, init) => {
    url = String(input); request = init;
    return sse('data: {"id":"gen-1","model":"vendor/exact-model","choices":[{"delta":{"content":"ok"}}]}\r\n\r\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n');
  });
  const events = await collect(adapter, profile({ maxOutputTokens: 123, temperature: 0.2, topP: 0.7, stopSequences: ['END'], openrouter: { appTitle: 'Cortex test', httpReferer: 'https://cortex.example', provider: { only: ['provider-a'] } } }));
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.authorization, 'Bearer fake-openrouter-key');
  assert.equal(request.headers['x-openrouter-title'], 'Cortex test');
  assert.equal(request.headers['http-referer'], 'https://cortex.example');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'vendor/exact-model');
  assert.equal(body.max_tokens, 123);
  assert.equal(body.top_p, 0.7);
  assert.deepEqual(body.stop, ['END']);
  assert.deepEqual(body.provider, { require_parameters: true, allow_fallbacks: true, only: ['provider-a'] });
  assert.equal(body.stream_options, undefined);
  assert.equal(request.headers['openai-organization'], undefined);
  assert.equal(events.at(-1).type, 'done');
  assert.ok(events.some(event => event.type === 'completion-metadata' && event.generationId === 'gen-1'));
});

test('OR-06 joins byte-split multiline SSE data, ignores comments, and accounts only once', async () => {
  const multiline = encoder.encode('data: {"choices":[{"delta":\ndata: {"content":"Zażółć"}}]}\n\n');
  const splitAt = multiline.findIndex((byte, index) => index > 20 && byte >= 0x80) + 1;
  const adapter = new OpenRouterAdapter(async () => sse(
    ': heartbeat\n\n',
    multiline.slice(0, splitAt), multiline.slice(splitAt),
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2,"cache_write_tokens":1},"cost":0},"choices":[{"delta":{"content":"","role":"assistant"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ));
  const events = await collect(adapter);
  assert.equal(events.filter(event => event.type === 'text-delta').map(event => event.delta).join(''), 'Zażółć');
  const usage = events.filter(event => event.type === 'usage');
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0], { type: 'usage', inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 1, costUsd: 0 });
});

test('OR-07 still rejects non-empty content after a terminal finish reason', async () => {
  const adapter = new OpenRouterAdapter(async () => sse(
    'data: {"choices":[{"delta":{"content":"first"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[{"delta":{"content":" late"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ));
  await assert.rejects(collect(adapter), /content after the terminal/);
});

test('OR-07 does not release tool calls without both a terminal finish and [DONE]', async () => {
  const adapter = new OpenRouterAdapter(async () => sse(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"write","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  ));
  const seen = [];
  await assert.rejects(async () => {
    for await (const event of adapter.complete([], profile(), [{ name: 'write', description: 'write', inputSchema: { type: 'object' } }], new AbortController().signal)) seen.push(event);
  }, /sentinel/);
  assert.ok(seen.every(event => event.type !== 'tool-call' && event.type !== 'done'));
});

test('OR-07 rejects tool deltas that contradict a stop finish reason', async () => {
  const adapter = new OpenRouterAdapter(async () => sse(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"write","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ));
  const seen = [];
  await assert.rejects(async () => {
    for await (const event of adapter.complete([], profile(), [{ name: 'write', description: 'write', inputSchema: { type: 'object' } }], new AbortController().signal)) seen.push(event);
  }, /stop after emitting tool calls/);
  assert.ok(seen.every(event => event.type !== 'tool-call' && event.type !== 'done'));
});

test('OR-08 turns a length-truncated tool call into a non-executable corrective result', async () => {
  const adapter = new OpenRouterAdapter(async () => sse(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"write","arguments":"{}"}}]},"finish_reason":"length"}]}\n\n',
    'data: [DONE]\n\n',
  ));
  const events = await collect(adapter, profile(), [{ name: 'write', description: 'write', inputSchema: { type: 'object' } }]);
  const call = events.find(event => event.type === 'tool-call');
  assert.match(call.parseError, /output limit/);
});

test('OR-08 releases split tool arguments only after a confirmed stream', async () => {
  const adapter = new OpenRouterAdapter(async () => sse(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"write","arguments":"{\\\"a\\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n', 'data: [DONE]\n\n',
  ));
  const events = await collect(adapter, profile(), [{ name: 'write', description: 'write', inputSchema: { type: 'object' } }]);
  assert.deepEqual(events.find(event => event.type === 'tool-call'), { type: 'tool-call', id: 'call-1', name: 'write', input: { a: 1 } });
});

test('OR-10 preserves opaque reasoning for the same OpenRouter model and elides it after a model switch', () => {
  const message = {
    id: 'a', role: 'assistant', createdAt: '', traceId: '', content: [
      { type: 'unknown-content', blockType: 'openrouter.reasoning.v1', raw: { version: 1, apiOrigin: 'https://openrouter.ai/api/v1', requestedModel: 'vendor/exact-model', details: [{ type: 'reasoning.encrypted', data: 'opaque' }] } },
      { type: 'tool-call', id: 'call-1', name: 'write', input: {} },
    ],
  };
  assert.deepEqual(toOAIMessages([message], false, { apiOrigin: 'https://openrouter.ai/api/v1', model: 'vendor/exact-model' })[0].reasoning_details, [{ type: 'reasoning.encrypted', data: 'opaque' }]);
  assert.equal(toOAIMessages([message], false, { apiOrigin: 'https://openrouter.ai/api/v1', model: 'other-model' })[0].reasoning_details, undefined);
});

test('OR-02 performs no request when profile validation fails', async () => {
  let calls = 0;
  const adapter = new OpenRouterAdapter(async () => { calls++; return sse(); });
  await assert.rejects(collect(adapter, { ...profile(), credentials: { apiKey: '${OPENROUTER_API_KEY}' } }), /no resolved apiKey/);
  assert.equal(calls, 0);
});

test('OR-12 persists safe OpenRouter completion metadata and preserves unknown cost', async () => {
  let persisted;
  const session = {
    id: 'runner-openrouter', version: '1', ownerPrincipalId: 'test', status: 'active', contexts: [], createdAt: '', updatedAt: '',
    messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }], createdAt: '', traceId: '' }],
  };
  const provider = {
    name: 'openrouter', async health() { return { status: 'ok' }; },
    async *complete() {
      yield { type: 'completion-metadata', gateway: 'openrouter', requestedModel: 'vendor/exact-model', returnedModel: 'vendor/exact-model', generationId: 'gen-2', finishReason: 'length', truncated: true };
      yield { type: 'text-delta', delta: 'partial' };
      yield { type: 'done' };
    },
  };
  for await (const _event of runSession({
    session, config: { provider: 'OpenRouter Chat', traceId: 'trace-or' }, provider,
    providerConfig: profile(), store: { async set(_id, value) { persisted = structuredClone(value); } },
    signal: new AbortController().signal, async loadPlugin() {}, async unloadPlugin() { return false; },
  })) { /* terminal event asserted through persistence */ }
  const assistant = persisted.messages.find(message => message.role === 'assistant');
  assert.deepEqual(assistant.metadata.completion, {
    gateway: 'openrouter', requestedModel: 'vendor/exact-model', returnedModel: 'vendor/exact-model', generationId: 'gen-2', finishReason: 'length', truncated: true,
  });
});

test('OR-12 does not invent a cache partition when the gateway omitted prompt_tokens', async () => {
  const adapter = new OpenRouterAdapter(async () => sse(
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"usage":{"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2,"cache_write_tokens":1}}}\n\n',
    'data: [DONE]\n\n',
  ));
  const events = await collect(adapter);
  assert.deepEqual(events.find(event => event.type === 'usage'), { type: 'usage', inputTokens: 0, outputTokens: 3 });
});
