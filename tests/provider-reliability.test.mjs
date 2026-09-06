import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { getEventListeners } from 'node:events';
await import('../local-agent/matbot/apps/cli/register.js');
const { OpenAICompatAdapter } = await import('../local-agent/matbot/packages/plugins/providers/openai-compat/src/adapter.ts');
const { AnthropicAdapter } = await import('../local-agent/matbot/packages/plugins/providers/anthropic/src/adapter.ts');
const { fetchWithRetry } = await import('../local-agent/matbot/packages/core/providers/_base/src/http-retry.ts');

async function serverFor(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function collect(adapter, endpoint, parameters, signal = new AbortController().signal) {
  const events = [];
  for await (const event of adapter.complete([], { name: 'test', module: 'test', model: 'test', endpoint, parameters }, [], signal)) events.push(event);
  return events;
}
function content(Adapter) {
  return Adapter === OpenAICompatAdapter ? 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
    : 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n';
}
function terminal(Adapter) {
  return Adapter === OpenAICompatAdapter ? 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    : 'data: {"type":"message_stop"}\n\n';
}

for (const mode of ['status', 'network']) {
  test(`REL-07 cancellation interrupts ${mode} backoff without another request`, async () => {
    const original = globalThis.fetch;
    const ac = new AbortController(); let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      setTimeout(() => ac.abort(new Error('cancel backoff')), 20);
      if (mode === 'network') throw new Error('connect failure');
      return new Response('busy', { status: 429, headers: { 'retry-after': '60' } });
    };
    try {
      const started = Date.now();
      await assert.rejects(fetchWithRetry('http://test.invalid', { signal: ac.signal }), /cancel backoff/);
      assert.ok(Date.now() - started < 500); assert.equal(requests, 1);
      assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
    } finally { globalThis.fetch = original; }
  });
}

test('REL-07 pre-cancellation sends nothing and successful retry waits remove listeners', async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('', { status: requests < 5 ? 429 : 200, headers: { 'retry-after': '0' } }); };
  try {
    const ac = new AbortController(); ac.abort(new Error('already cancelled'));
    await assert.rejects(fetchWithRetry('http://test.invalid', { signal: ac.signal }), /already cancelled/);
    assert.equal(requests, 0);
    const running = new AbortController();
    assert.equal((await fetchWithRetry('http://test.invalid', { signal: running.signal }, 5)).status, 200);
    assert.equal(getEventListeners(running.signal, 'abort').length, 0);
  } finally { globalThis.fetch = original; }
});

for (const Adapter of [OpenAICompatAdapter, AnthropicAdapter]) {
  test(`REL-06 ${Adapter.name} bounds headers, idle streams, and total completion`, async t => {
    for (const mode of ['headers', 'idle', 'heartbeat', 'total']) {
      await t.test(mode, async t => {
        const endpoint = await serverFor(t, (_req, res) => {
          if (mode === 'headers') return;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': initial heartbeat\n\n');
          if (mode === 'idle') return;
          const timer = setInterval(() => res.write(mode === 'total' ? content(Adapter) : ': heartbeat\n\n'), 10);
          res.once('close', () => clearInterval(timer));
        });
        const started = Date.now();
        await assert.rejects(collect(new Adapter(), endpoint, {
          requestTimeoutMs: 100, streamIdleTimeoutMs: 60, completionTimeoutMs: 180,
        }), mode === 'total' ? /completion timed out/ : /timed out|idle timeout/);
        assert.ok(Date.now() - started < 1500);
      });
    }
  });

  test(`REL-06 ${Adapter.name} healthy streaming outlives the header attempt timer`, async t => {
    const endpoint = await serverFor(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(content(Adapter));
      let count = 0;
      const timer = setInterval(() => {
        if (++count === 5) { clearInterval(timer); res.end(terminal(Adapter)); }
        else res.write(content(Adapter));
      }, 20);
      res.once('close', () => clearInterval(timer));
    });
    const events = await collect(new Adapter(), endpoint, { requestTimeoutMs: 90, streamIdleTimeoutMs: 200, completionTimeoutMs: 1000 });
    assert.ok(events.some(event => event.type === 'text-delta'));
    assert.equal(events.at(-1).type, 'done');
  });

  test(`REL-06 ${Adapter.name} respects cancellation and validates deadline settings`, async t => {
    const endpoint = await serverFor(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': heartbeat\n\n'); });
    const ac = new AbortController();
    const pending = collect(new Adapter(), endpoint, {}, ac.signal);
    setTimeout(() => ac.abort(new Error('user cancelled')), 20);
    await assert.rejects(pending, /user cancelled/);
    await assert.rejects(collect(new Adapter(), endpoint, { completionTimeoutMs: 0 }), /must be an integer/);
  });
}

for (const [name, frames] of [
  ['error before content', [{ error: { message: 'upstream failed' } }]],
  ['error after content', [{ choices: [{ delta: { content: 'partial' } }] }, { error: { message: 'upstream failed' } }]],
  ['EOF after content', [{ choices: [{ delta: { content: 'partial' } }] }]],
  ['unconfirmed tool', [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'change', arguments: '{}' } }] } }] }]],
  ['error after tool finish', [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'change', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, { error: { message: 'late failure' } }]],
]) {
  test(`REL-08 ${name} fails without releasing tool calls or a done event`, async t => {
    const endpoint = await serverFor(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('')); });
    const events = [];
    await assert.rejects(async () => {
      for await (const event of new OpenAICompatAdapter().complete([], { name: 'test', module: 'test', model: 'test', endpoint }, [], new AbortController().signal)) events.push(event);
    }, /incomplete|stream error/);
    assert.ok(events.every(e => e.type !== 'done' && e.type !== 'tool-call'));
  });
}

test('REL-08 finish plus trailing usage produces one terminal event and ends at DONE', async t => {
  const endpoint = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(content(OpenAICompatAdapter));
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
    res.write('data: [DONE]\n\n'); // Deliberately do not close the HTTP response.
  });
  const events = await collect(new OpenAICompatAdapter(), endpoint, { streamIdleTimeoutMs: 500 });
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.ok(events.some(e => e.type === 'usage' && e.outputTokens === 5));
});
