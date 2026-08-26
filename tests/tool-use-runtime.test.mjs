import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

// Remap *.js specifiers to *.ts so Node's native type-stripping can load matbot sources.
register(new URL('../local-agent/matbot/apps/cli/ts-hooks.js', import.meta.url));

const { runSession } = await import('../local-agent/matbot/packages/core/runner/src/runner.ts');
const { createSession } = await import('../local-agent/matbot/packages/core/runner/src/session.ts');
const { validateAgainstSchema, formatValidationIssues } =
  await import('../local-agent/matbot/packages/core/runner/src/schema-validator.ts');
const { evaluatePermission, wildcardMatch } =
  await import('../local-agent/matbot/packages/core/runner/src/permissions.ts');
const { truncateToolResult } = await import('../local-agent/matbot/packages/core/runner/src/truncate.ts');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSession() {
  return createSession({ ownerPrincipal: { id: 'test-user', type: 'user' } });
}

/** A provider adapter scripted per iteration: each entry is the event list for one complete() call. */
function scriptedProvider(iterations) {
  let i = 0;
  return {
    name: 'scripted',
    async health() { return { status: 'ok' }; },
    async *complete() {
      const events = iterations[i] ?? [];
      i++;
      yield* events;
      yield { type: 'done' };
    },
  };
}

function memoryStore() {
  const saved = new Map();
  return {
    saved,
    async set(id, session) { saved.set(id, session); },
    async get(id) { return saved.get(id) ?? null; },
  };
}

function toolCtx(overrides = {}) {
  return {
    callId: 'call-1',
    session: makeSession(),
    signal: new AbortController().signal,
    vault: { resolve: async r => r, scrub: t => t, hasKey: () => false, createSecret: async (n) => n, writeSecret: async () => {} },
    prompt: async () => 'allow',
    loadPlugin: async () => { throw new Error('not available in tests'); },
    unloadPlugin: async () => false,
    ...overrides,
  };
}

function simpleTool(name, { execute, schema, serial, permission } = {}) {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: schema ?? { type: 'object' },
    ...(serial !== undefined ? { serial } : {}),
    ...(permission !== undefined ? { permission } : {}),
    executor: {
      async *execute(input, ctx) {
        if (execute) yield* execute(input, ctx);
        else yield { type: 'result', value: { ok: true, tool: name, input } };
      },
    },
  };
}

async function runTurn({ provider, tools, opts = {} }) {
  const session = makeSession();
  session.messages.push({
    id: 'm-user', role: 'user', content: [{ type: 'text', text: 'go' }],
    createdAt: new Date().toISOString(), traceId: '',
  });
  const store = memoryStore();
  const events = [];
  for await (const ev of runSession({
    session,
    config: { provider: 'scripted' },
    provider,
    providerConfig: { name: 'scripted', module: 'test', model: 'test-model' },
    tools: new Map(tools.map(t => [t.name, t])),
    store,
    signal: new AbortController().signal,
    loadPlugin: async () => { throw new Error('n/a'); },
    unloadPlugin: async () => false,
    ...opts,
  })) {
    events.push(ev);
  }
  return { events, finalSession: store.saved.get(session.id) };
}

const toolCall = (id, name, input) => ({ type: 'tool-call', id, name, input });
const text = t => ({ type: 'text-delta', delta: t });

// ── Schema validator (spec R3) ───────────────────────────────────────────────

test('schema validator accepts conforming input and reports precise issues', () => {
  const schema = {
    type: 'object',
    required: ['filePath'],
    properties: {
      filePath: { type: 'string' },
      offset:   { type: 'integer', minimum: 1 },
      mode:     { type: 'string', enum: ['a', 'b'] },
      tags:     { type: 'array', items: { type: 'string' } },
    },
  };
  assert.deepEqual(validateAgainstSchema({ filePath: '/x', offset: 2, mode: 'a', tags: ['t'] }, schema), []);
  const issues = validateAgainstSchema({ offset: 0, mode: 'z', tags: [1], extraOk: true }, schema);
  const messages = issues.map(i => i.message).join('; ');
  assert.match(messages, /missing required property "filePath"/);
  assert.match(messages, /must be >= 1/);
  assert.match(messages, /must be one of "a", "b"/);
  assert.match(messages, /expected string, got integer/);
});

test('schema validator supports anyOf, $ref, additionalProperties:false, patterns', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { anyOf: [{ type: 'string', pattern: '^a' }, { const: 'b' }] },
      nested: { $ref: '#/properties/action' },
    },
  };
  assert.deepEqual(validateAgainstSchema({ action: 'abc' }, schema), []);
  const bad = validateAgainstSchema({ action: 'xyz', unknown: 1 }, schema).map(i => i.message).join('; ');
  assert.match(bad, /did not match any of the allowed shapes/);
  assert.match(bad, /unknown property/);
});

test('formatValidationIssues produces corrective model-facing text', () => {
  const msg = formatValidationIssues('read', [{ path: '$.offset', message: 'must be >= 1' }]);
  assert.match(msg, /Invalid input for tool 'read'/);
  assert.match(msg, /was not executed/);
  assert.match(msg, /\$\.offset: must be >= 1/);
});

// ── Permission evaluation (spec R8) ─────────────────────────────────────────

test('wildcard matching handles *, **, and ? segments', () => {
  assert.equal(wildcardMatch('git *', 'git status'), true);
  assert.equal(wildcardMatch('git *', 'git push origin'), true);
  assert.equal(wildcardMatch('rm *', 'git status'), false);
  assert.equal(wildcardMatch('**/*.env', 'a/b/.env'), true);
  assert.equal(wildcardMatch('**/*.env', 'a/b/env'), false);
  assert.equal(wildcardMatch('/root/*/file.txt', '/root/sub/file.txt'), true);
});

test('evaluatePermission uses last matching rule with fallback', () => {
  const rules = [
    { permission: 'edit', pattern: '*', action: 'ask' },
    { permission: 'edit', pattern: '**/*.md', action: 'allow' },
    { permission: 'bash', pattern: 'rm *', action: 'deny' },
  ];
  assert.equal(evaluatePermission(rules, 'edit', 'docs/a.md'), 'allow');
  assert.equal(evaluatePermission(rules, 'edit', 'src/a.ts'), 'ask');
  assert.equal(evaluatePermission(rules, 'bash', 'rm -rf /'), 'deny');
  assert.equal(evaluatePermission(rules, 'webfetch', 'https://x'), 'allow'); // default fallback
  assert.equal(evaluatePermission(rules, 'webfetch', 'https://x', 'ask'), 'ask');
});

// ── Output truncation (spec R16) ────────────────────────────────────────────

test('truncateToolResult caps oversized strings with head/tail preview', async () => {
  const big = `${'x'.repeat(60000)}\nEND-MARKER`;
  const out = await truncateToolResult(big, { maxBytes: 1000 }, undefined, undefined);
  assert.equal(out.truncated, true);
  assert.equal(out.totalBytes >= 60000, true);
  const text = out.result;
  assert.ok(text.includes('x'.repeat(10)));
  assert.ok(text.includes('[output truncated at 1000 bytes'));
  // Small strings pass through untouched.
  const small = await truncateToolResult('tiny', undefined, undefined, undefined);
  assert.equal(small.truncated, false);
  assert.equal(small.result, 'tiny');
});

test('truncateToolResult saves full output through the FileStore when available', async () => {
  const savedName = 'saved-output.txt';
  const files = {
    async putTemp(name, mimeType, data) {
      let total = '';
      for await (const chunk of data) total += new TextDecoder().decode(chunk);
      assert.equal(mimeType, 'text/plain');
      assert.ok(total.length >= 70000, 'full serialized output must be persisted');
      return { id: 'f1', version: 'v', name: savedName, mimeType, size: total.length, createdAt: '' , stream: async function*(){} };
    },
  };
  const out = await truncateToolResult({ huge: 'y'.repeat(70000) }, { maxBytes: 2000 }, files, 's/tool');
  assert.equal(out.truncated, true);
  assert.equal(out.savedTo, savedName);
  assert.match(out.result.hint, /saved as file "saved-output\.txt"/);
});

// ── Runtime behaviors through runSession ────────────────────────────────────

test('invalid tool inputs are rejected with corrective errors before execution (R3)', async () => {
  let executed = 0;
  const tool = simpleTool('strict', {
    schema: { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1 } } },
    *execute() { executed++; yield { type: 'result', value: 'ran' }; },
  });
  const { events, finalSession } = await runTurn({
    provider: scriptedProvider([[toolCall('t1', 'strict', { count: 0 }), text(' done')]]),
    tools: [tool],
  });
  assert.equal(executed, 0);
  const end = events.find(e => e.type === 'tool:end');
  assert.equal(end.isError, true);
  assert.match(end.result.error, /Invalid input for tool 'strict'/);
  assert.match(end.result.error, /must be >= 1/);
  assert.equal(finalSession.messages.filter(m => m.role === 'tool').length, 1);
});

test('parseError tool calls degrade to failed calls instead of aborting the turn (R4)', async () => {
  const { events } = await runTurn({
    provider: scriptedProvider([
      [{ type: 'tool-call', id: 'bad', name: 'anything', input: '{"trunc', parseError: '3 bytes received, finish_reason "length".' }],
      [text('recovered')],
    ]),
    tools: [simpleTool('anything')],
  });
  assert.ok(!events.some(e => e.type === 'error'), 'turn must not end in an error event');
  const end = events.find(e => e.type === 'tool:end');
  assert.equal(end.isError, true);
  assert.match(end.result.error, /could not be parsed.*Re-issue the call/);
  assert.ok(events.some(e => e.type === 'done'));
});

test('loop policy stops runaway turns gracefully at maxIterations (R1)', async () => {
  const echo = simpleTool('echo');
  const { events, finalSession } = await runTurn({
    provider: scriptedProvider([
      [toolCall('t1', 'echo', {})],
      [toolCall('t2', 'echo', {})],
      [toolCall('t3', 'echo', {})],
      [text('final answer')],
    ]),
    tools: [echo],
    opts: { loopPolicy: { maxIterations: 3 } },
  });
  const limits = events.filter(e => e.type === 'loop:limit');
  assert.equal(limits.length, 1);
  assert.equal(limits[0].reason, 'max-iterations');
  assert.equal(limits[0].iterations, 3);
  assert.ok(events.some(e => e.type === 'done'), 'graceful completion expected');
  const note = finalSession.messages.at(-1);
  assert.equal(note.role, 'assistant');
  assert.match(note.content[0].text, /\[Turn stopped by loop policy: max-iterations/);
});

test('loop policy answers excess tool calls with budget errors at maxToolCallsPerTurn (R1)', async () => {
  const echo = simpleTool('echo');
  const { events, finalSession } = await runTurn({
    provider: scriptedProvider([[toolCall('a', 'echo', {}), toolCall('b', 'echo', {}), toolCall('c', 'echo', {})]]),
    tools: [echo],
    opts: { loopPolicy: { maxToolCallsPerTurn: 2 } },
  });
  const ends = events.filter(e => e.type === 'tool:end');
  assert.equal(ends.length, 3, 'every emitted call must receive a paired result');
  const successes = ends.filter(e => !e.isError);
  const skipped = ends.filter(e => e.isError);
  assert.equal(successes.length, 2);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].result.error, /tool-call budget/);
  assert.ok(events.some(e => e.type === 'loop:limit' && e.reason === 'max-tool-calls'));
  // Persisted pairing: every tool-call block has a matching result.
  const calls = finalSession.messages.flatMap(m => m.content).filter(c => c.type === 'tool-call').map(c => c.id);
  const results = new Set(finalSession.messages.flatMap(m => m.content).filter(c => c.type === 'tool-result').map(c => c.id));
  for (const id of calls) assert.ok(results.has(id), `missing result for ${id}`);
});

test('parallel tool calls execute concurrently unless marked serial (R2)', async () => {
  let active = 0;
  let maxActive = 0;
  const slowTool = simpleTool('slow', {
    async *execute() {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 40));
      active--;
      yield { type: 'result', value: 'done' };
    },
  });
  await runTurn({
    provider: scriptedProvider([[toolCall('p1', 'slow', {}), toolCall('p2', 'slow', {}), toolCall('p3', 'slow', {})]]),
    tools: [slowTool],
  });
  assert.equal(maxActive, 3, 'independent calls should overlap');

  maxActive = 0;
  const serialSlow = simpleTool('serial-slow', {
    serial: true,
    async *execute() {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 20));
      active--;
      yield { type: 'result', value: 'done' };
    },
  });
  await runTurn({
    provider: scriptedProvider([[toolCall('s1', 'serial-slow', {}), toolCall('s2', 'serial-slow', {})]]),
    tools: [serialSlow],
  });
  assert.equal(maxActive, 1, 'serial-marked tools must not overlap');
});

test('doom-loop interception blocks repeated identical calls (R6)', async () => {
  let executed = 0;
  const stuck = simpleTool('stuck', {
    *execute() { executed++; yield { type: 'result', value: 'same' }; },
  });
  const { events } = await runTurn({
    provider: scriptedProvider([
      [toolCall('same-id', 'stuck', { q: 1 })],
      [toolCall('same-id', 'stuck', { q: 1 })],
      [toolCall('same-id', 'stuck', { q: 1 })],
      [toolCall('same-id', 'stuck', { q: 1 })],
      [text('changing strategy')],
    ]),
    tools: [stuck],
    opts: { loopPolicy: { doomLoopThreshold: 3 } },
  });
  const ends = events.filter(e => e.type === 'tool:end');
  assert.equal(ends.length, 4, 'three executions plus one intercepted retry');
  assert.ok(ends.slice(0, 3).every(e => !e.isError));
  assert.equal(ends[3].isError, true);
  assert.match(ends[3].result.error, /doom_loop/);
  assert.equal(executed, 3);
});

test('hook-aborted turns persist paired tool-call results (R19)', async () => {
  const blocker = {
    on: 'toolcall',
    handler: ({ toolCall }) => (toolCall.name === 'guard' ? { abort: 'policy says stop' } : {}),
  };
  const { HookRegistry } = await import('../local-agent/matbot/packages/core/plugin-api/src/hooks.ts');
  const hooks = new HookRegistry();
  hooks.register(blocker);

  const guard = simpleTool('guard');
  const { events, finalSession } = await runTurn({
    provider: scriptedProvider([[toolCall('g1', 'guard', {}), toolCall('g2', 'guard', {})]]),
    tools: [guard],
    opts: { hooks },
  });
  assert.ok(events.some(e => e.type === 'aborted' && e.reason === 'policy says stop'));
  const calls = finalSession.messages.flatMap(m => m.content).filter(c => c.type === 'tool-call').map(c => c.id);
  const results = new Set(finalSession.messages.flatMap(m => m.content).filter(c => c.type === 'tool-result').map(c => c.id));
  assert.equal(calls.length, 2);
  for (const id of calls) assert.ok(results.has(id), `orphaned tool-call ${id} after abort`);
});

// ── Permission gate through the runner (spec R8/R9) ─────────────────────────

test('configured deny rules produce permission_denied results without execution', async () => {
  let executed = 0;
  const editor = simpleTool('edit', {
    permission: { action: 'edit', patterns: input => [input.filePath] },
    *execute() { executed++; yield { type: 'result', value: 'edited' }; },
  });
  const { events } = await runTurn({
    provider: scriptedProvider([[toolCall('e1', 'edit', { filePath: 'C:/tmp/x.ts' })]]),
    tools: [editor],
    // Scoped to one subtree, so `edit` itself remains visible in the menu but this subject is denied.
    opts: { permissions: { rules: [{ permission: 'edit', pattern: 'C:/tmp/*', action: 'deny' }] } },
  });
  const end = events.find(e => e.type === 'tool:end');
  assert.equal(end.isError, true);
  assert.match(end.result.error, /Permission denied by policy: edit/);
  assert.equal(executed, 0);
});

test('ask rules prompt via PromptFn; allow proceeds, always approves future calls', async () => {
  const prompts = [];
  const editor = simpleTool('edit', {
    permission: { action: 'edit', patterns: input => [input.filePath] },
    *execute(input) { yield { type: 'result', value: `edited ${input.filePath}` }; },
  });
  const asks = [];

  // First call: user allows once → prompt fires again for the second call.
  let answer = 'allow';
  const first = await runTurn({
    provider: scriptedProvider([[
      toolCall('a1', 'edit', { filePath: 'C:/w/a.txt' }),
      toolCall('a2', 'edit', { filePath: 'C:/w/b.txt' }),
    ]]),
    tools: [editor],
    opts: {
      permissions: { rules: [{ permission: 'edit', pattern: '*', action: 'ask' }] },
      prompt: field => { prompts.push(field.label); asks.push(field); return Promise.resolve(answer); },
    },
  });
  assert.equal(prompts.length, 2);
  assert.ok(first.events.some(e => e.type === 'permission:ask'));
  assert.ok(first.events.some(e => e.type === 'permission:reply' && e.outcome === 'allow'));
  assert.ok(first.events.filter(e => e.type === 'tool:end' && !e.isError).length === 2);

  // Second turn: user answers "always allow" for a specific path → later identical-subject
  // calls skip the prompt.
  prompts.length = 0;
  answer = 'always allow';
  const second = await runTurn({
    provider: scriptedProvider([[
      toolCall('b1', 'edit', { filePath: 'C:/w/same.txt' }),
      toolCall('b2', 'edit', { filePath: 'C:/w/same.txt' }),
    ]]),
    tools: [editor],
    opts: {
      permissions: { rules: [{ permission: 'edit', pattern: '*', action: 'ask' }] },
      prompt: field => { prompts.push(field.label); return Promise.resolve(answer); },
    },
  });
  assert.equal(prompts.length, 1, '"always" must suppress subsequent prompts within the turn');
  assert.ok(second.events.some(e => e.type === 'permission:reply' && e.outcome === 'always'));
  assert.ok(second.events.filter(e => e.type === 'tool:end' && !e.isError).length === 2);
});

test('denied permission asks feed rejection feedback back to the model', async () => {
  const editor = simpleTool('edit', {
    permission: { action: 'edit', patterns: input => [input.filePath] },
    *execute() { yield { type: 'result', value: 'should not run' }; },
  });
  const { events } = await runTurn({
    provider: scriptedProvider([[toolCall('d1', 'edit', { filePath: 'C:/w/x.txt' })]]),
    tools: [editor],
    opts: {
      permissions: { rules: [{ permission: 'edit', pattern: '*', action: 'ask' }] },
      prompt: () => Promise.resolve('deny'),
    },
  });
  const end = events.find(e => e.type === 'tool:end');
  assert.equal(end.isError, true);
  assert.match(end.result.error, /user denied/);
});

// ── Denied tools disappear from the model's menu (spec R8) ──────────────────

test('fully denied tools are absent from the advertised tool menu', async () => {
  const { isToolHiddenByRules } =
    await import('../local-agent/matbot/packages/core/runner/src/permissions.ts');
  const denyEdit = [{ permission: 'edit', pattern: '*', action: 'deny' }];
  assert.equal(isToolHiddenByRules(denyEdit, 'edit'), true);
  assert.equal(isToolHiddenByRules(denyEdit, 'read'), false);

  let advertised = [];
  const spyProvider = {
    name: 'spy',
    async health() { return { status: 'ok' }; },
    async *complete(_messages, _config, tools) {
      advertised = tools.map(t => t.name);
      yield { type: 'text-delta', delta: 'hi' };
      yield { type: 'done' };
    },
  };
  await runTurn({
    provider: spyProvider,
    tools: [simpleTool('edit'), simpleTool('read')],
    opts: { permissions: { rules: denyEdit } },
  });
  assert.deepEqual(advertised.sort(), ['read'], 'denied tools must not be advertised');
});
