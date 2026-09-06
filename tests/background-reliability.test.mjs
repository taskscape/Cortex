import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
await import('../local-agent/matbot/apps/cli/register.js');
const { waitForBackgroundChild, installBackgroundTestHooks, plugin } = await import('../local-agent/matbot/packages/plugins/background/src/index.ts');

class Child extends EventEmitter {
  kill() { return true; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(10); }
  assert.fail('condition did not settle');
}
class Store {
  docs = new Map();
  async get(id) { return structuredClone(this.docs.get(id) ?? null); }
  async set(id, value) { this.docs.set(id, structuredClone(value)); }
  async delete(id) { return this.docs.delete(id); }
  async query() { return { items: structuredClone([...this.docs.values()]), total: this.docs.size }; }
}
const machine = store => ({ configPath: 'C:/disposable/matbot.yaml', isSubAgent: () => false, createStore: () => store, files: {} });
const schedule = id => ({ id, version: '1', prompt: 'test', intervalMs: 10000, active: true, createdAt: new Date().toISOString(), nextRun: new Date().toISOString() });

test('REL-04 real missing executable settles without crashing the host', async () => {
  const child = spawn(`cortex-missing-${crypto.randomUUID()}`, [], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const result = await waitForBackgroundChild(child);
  assert.equal(result.status, 'launch_failed');
  assert.match(result.error, /ENOENT/);
});

test('REL-04 spawn and input-pipe errors settle once and tolerate trailing exit', async () => {
  for (const pipe of [false, true]) {
    const child = new Child(); child.stdin = new PassThrough();
    const completion = waitForBackgroundChild(child);
    (pipe ? child.stdin : child).emit('error', new Error(pipe ? 'EPIPE' : 'EAGAIN'));
    child.emit('exit', 0); child.emit('close', 0);
    const result = await completion;
    assert.equal(result.status, pipe ? 'failed' : 'launch_failed');
    assert.match(result.error, /EPIPE|EAGAIN/);
    child.stdin.destroy();
  }
});

test('REL-04 cancellation and output draining are bounded', async () => {
  const child = new Child(); let kills = 0; child.kill = () => { kills++; return true; };
  const ac = new AbortController(); ac.abort();
  const cancelled = await waitForBackgroundChild(child, ac.signal, 20);
  assert.equal(cancelled.status, 'failed'); assert.equal(kills, 2);
  const piped = new Child(); piped.stdout = new PassThrough();
  const completion = waitForBackgroundChild(piped, undefined, 20);
  piped.emit('exit', 0);
  assert.match((await completion).error, /drain deadline/);
  assert.equal(piped.stdout.destroyed, true);
  const broken = new Child(); broken.pid = 1; broken.stdin = new PassThrough();
  const signals = []; broken.kill = signal => { signals.push(signal ?? 'SIGTERM'); return true; };
  const failed = waitForBackgroundChild(broken, undefined, 20);
  broken.stdin.emit('error', new Error('EPIPE'));
  assert.equal((await failed).status, 'failed');
  await delay(30);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(broken.stdin.destroyed, true);
  broken.emit('close', 1);
});

test('REL-04 scheduler persists launch failure as a terminal occurrence', async () => {
  const store = new Store(); await store.set('failed', schedule('failed'));
  const restore = installBackgroundTestHooks({ startupDelayMs: 0, launchJob: () => {
    const child = new Child(); queueMicrotask(() => child.emit('error', new Error('EAGAIN'))); return child;
  } });
  try {
    await plugin.setup(machine(store));
    await until(async () => (await store.get('failed')).lastStatus === 'launch_failed');
    assert.equal((await store.get('failed')).runCount, 1);
  } finally { await plugin.teardown(); restore(); }
});

async function every(action, id) {
  const tool = plugin.tools.find(tool => tool.name === 'every_action');
  const events = [];
  for await (const event of tool.executor.execute({ action, id }, {})) events.push(event);
  return events.find(e => e.type === 'result')?.value;
}
for (const phase of ['read', 'prepare', 'prepare-ack', 'complete', 'complete-ack']) {
  test(`REL-09 scheduler recovers from ${phase} failure without duplicating an occurrence`, async () => {
    const store = new Store(); await store.set('recover', schedule('recover'));
    const get = store.get.bind(store), set = store.set.bind(store);
    let failed = false, launches = 0;
    store.get = async id => { if (phase === 'read' && !failed) { failed = true; throw new Error('transient read'); } return get(id); };
    store.set = async (id, value) => {
      if (!failed && ((phase.startsWith('prepare') && value.lastStatus === 'running') || (phase.startsWith('complete') && value.lastStatus === 'succeeded'))) {
        failed = true; if (phase.endsWith('ack')) await set(id, value); throw new Error('transient acknowledgement/write');
      }
      return set(id, value);
    };
    const restore = installBackgroundTestHooks({ startupDelayMs: 0, launchJob: () => { launches++; const child = new Child(); queueMicrotask(() => child.emit('exit', 0)); return child; } });
    try {
      await plugin.setup(machine(store));
      await until(async () => (await get('recover')).runCount === 1);
      await until(async () => (await every('list'))[0].schedulerState === 'armed');
      await delay(30);
      assert.equal(launches, 1); assert.equal((await get('recover')).runCount, 1);
      assert.equal((await get('recover')).lastStatus, 'succeeded');
    } finally { await plugin.teardown(); restore(); }
  });
}

test('REL-09 suspension survives completion persistence retries and resume rearms a stopped record', async () => {
  const store = new Store(); await store.set('suspended', schedule('suspended'));
  const set = store.set.bind(store); let blocked = true, attempts = 0, launches = 0;
  store.set = async (id, value) => {
    if (value.lastStatus === 'succeeded' && blocked) { attempts++; throw new Error('completion store unavailable'); }
    return set(id, value);
  };
  const restore = installBackgroundTestHooks({ startupDelayMs: 0, launchJob: () => { launches++; const child = new Child(); queueMicrotask(() => child.emit('exit', 0)); return child; } });
  try {
    await plugin.setup(machine(store));
    await until(() => attempts > 0);
    assert.equal((await every('list'))[0].schedulerState, 'recovering');
    await every('suspend', 'suspended'); blocked = false;
    await until(async () => (await store.get('suspended')).runCount === 1);
    assert.equal((await store.get('suspended')).active, false); assert.equal(launches, 1);
    await every('cancel', 'suspended');
    // A record restored after setup has no armed loop until resume ensures one.
    await set('restored', schedule('restored'));
    await every('resume', 'restored');
    await until(async () => (await store.get('restored')).runCount === 1);
    assert.equal(launches, 2);
  } finally { await plugin.teardown(); restore(); }
});

test('REL-09 restart records an uncertain running occurrence without replaying it', async () => {
  const store = new Store(); await store.set('uncertain', { ...schedule('uncertain'), lastStatus: 'running', lastOccurrenceId: 'old-occurrence' });
  let launches = 0;
  const restore = installBackgroundTestHooks({ startupDelayMs: 0, launchJob: () => { launches++; return undefined; } });
  try {
    await plugin.setup(machine(store));
    await until(async () => (await store.get('uncertain')).lastStatus === 'failed');
    assert.equal(launches, 0); assert.match((await store.get('uncertain')).lastSchedulerError, /effects are unknown/);
    assert.ok(Date.parse((await store.get('uncertain')).nextRun) > Date.now());
  } finally { await plugin.teardown(); restore(); }
});

test('REL-09 a lost acknowledgement while deferring uncertain work still honours the new due time', async () => {
  const store = new Store(); await store.set('uncertain-ack', { ...schedule('uncertain-ack'), lastStatus: 'running', lastOccurrenceId: 'old-occurrence' });
  const set = store.set.bind(store); let failed = false, launches = 0;
  store.set = async (id, value) => {
    await set(id, value);
    if (!failed && value.lastStatus === 'failed') { failed = true; throw new Error('defer acknowledgement lost'); }
  };
  const restore = installBackgroundTestHooks({ startupDelayMs: 0, launchJob: () => { launches++; return undefined; } });
  try {
    await plugin.setup(machine(store));
    await until(async () => (await every('list'))[0].schedulerState === 'recovering');
    await until(async () => (await every('list'))[0].schedulerState === 'armed');
    assert.equal(launches, 0);
    assert.equal((await store.get('uncertain-ack')).lastStatus, 'failed');
    assert.ok(Date.parse((await store.get('uncertain-ack')).nextRun) > Date.now());
  } finally { await plugin.teardown(); restore(); }
});
