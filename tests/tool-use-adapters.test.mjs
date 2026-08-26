import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register(new URL('../local-agent/matbot/apps/cli/ts-hooks.js', import.meta.url));

const { toOAIMessages, serializeToolResult } =
  await import('../local-agent/matbot/packages/plugins/providers/openai-compat/src/convert.ts');

const msg = (role, content) => ({ id: `m-${role}-${JSON.stringify(content).length}`, role, content, createdAt: new Date().toISOString(), traceId: '' });

test('successful tool results serialize unchanged (no is_error marker)', () => {
  const wire = toOAIMessages([
    msg('tool', [{ type: 'tool-result', id: 'c1', result: { ok: true, data: [1, 2] } }]),
  ]);
  assert.equal(wire.length, 1);
  assert.equal(wire[0].tool_call_id, 'c1');
  assert.deepEqual(JSON.parse(wire[0].content), { ok: true, data: [1, 2] });
});

test('error tool results carry an explicit is_error flag on the wire (spec R4)', () => {
  const wire = toOAIMessages([
    msg('tool', [{ type: 'tool-result', id: 'c2', result: { error: 'File not found: /x', code: 'not_found' }, isError: true }]),
  ]);
  const parsed = JSON.parse(wire[0].content);
  assert.equal(parsed.is_error, true);
  assert.equal(parsed.error, 'File not found: /x');
});

test('non-object error results are wrapped so is_error always survives', () => {
  const wrapped = JSON.parse(serializeToolResult('plain failure text', true));
  assert.equal(wrapped.is_error, true);
  assert.equal(wrapped.result, 'plain failure text');

  const scalar = JSON.parse(serializeToolResult(42, false));
  assert.equal(scalar, 42);

  // Null results (silent side-effect tools) stay "null" without an error flag.
  assert.equal(serializeToolResult(undefined, false), 'null');
});

// ── Runner-side parseError handling is covered in tool-use-runtime.test.mjs;
// here we verify the adapter-level flush contract through the exported class
// with a stubbed fetch returning a truncated tool-call stream.

const { OpenAICompatAdapter } =
  await import('../local-agent/matbot/packages/plugins/providers/openai-compat/src/adapter.ts');

test('openai-compat adapter surfaces unparseable tool arguments as failed calls instead of throwing', async () => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-x', function: { name: 'edit', arguments: '{"filePath":' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  const originalFetch = globalThis.fetch;
  const sse = `${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  globalThis.fetch = async () => ({
    ok: true,
    body: new Response(sse).body,
    text: async () => '',
  });
  try {
    const adapter = new OpenAICompatAdapter();
    const events = [];
    for await (const ev of adapter.complete([], { name: 'p', module: 'm', model: 'gpt-test' }, [], new AbortController().signal)) {
      events.push(ev);
    }
    const call = events.find(e => e.type === 'tool-call');
    assert.ok(call, 'a tool-call event must still be emitted');
    assert.equal(call.id, 'call-x');
    assert.equal(call.name, 'edit');
    assert.match(call.parseError, /token limit mid tool-call/);
    assert.ok(events.some(e => e.type === 'done'), 'the stream must finish normally');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
