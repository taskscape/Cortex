import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

register('./ts-hooks.js', pathToFileURL(fileURLToPath(new URL('../local-agent/matbot/apps/cli/ts-hooks.js', import.meta.url))));

const enabled = process.env.CORTEX_OPENROUTER_INTEGRATION === '1';
const configuredPath = process.env.CORTEX_OPENROUTER_CONFIG;
const configuredProfile = process.env.CORTEX_OPENROUTER_PROFILE;

function skipWithoutLiveCheck(t, reason) {
  const warning = `WARNING: OpenRouter end-to-end tests have not been performed: ${reason}`;
  t.diagnostic(warning);
  t.skip(warning);
}

function isOpenRouterProfile(profile) {
  return profile.module === '@matatbread/matbot-provider-openrouter' ||
    /(?:^|[\\/])openrouter(?:[\\/]index(?:\.\w+)?)?$/i.test(profile.module);
}

class MemoryStore {
  constructor() { this.docs = new Map(); }
  async get(id) { const value = this.docs.get(id); return value === undefined ? null : structuredClone(value); }
  async set(id, value) { this.docs.set(id, structuredClone(value)); }
  async cas(id, expected, next) {
    const current = this.docs.get(id) ?? null;
    if (current === null || current.version !== expected) return { ok: false, current };
    this.docs.set(id, structuredClone(next));
    return { ok: true, doc: next };
  }
  async delete(id) { return this.docs.delete(id); }
  async query() { return { items: [...this.docs.values()].map(structuredClone), total: this.docs.size }; }
}

async function loadConfiguredProfile(t) {
  if (!enabled) {
    skipWithoutLiveCheck(t, 'set CORTEX_OPENROUTER_INTEGRATION=1 to authorize a live request.');
    return null;
  }
  if (!configuredPath) {
    skipWithoutLiveCheck(t, 'set CORTEX_OPENROUTER_CONFIG to an explicit workspace matbot.yaml.');
    return null;
  }

  const configPath = path.resolve(configuredPath);
  const { loadConfig, loadDotEnv } = await import('../local-agent/matbot/apps/cli/src/config.ts');
  const { EnvFileVault } = await import('../local-agent/matbot/packages/plugins/vault-env/src/vault.ts');
  const { validateOpenRouterConfig } = await import('../local-agent/matbot/packages/plugins/providers/openrouter/src/config.ts');
  let config;
  try {
    ({ config } = await loadConfig(configPath));
    // This is intentionally explicit: the test never searches for or loads a developer workspace
    // unless its configuration path was supplied by the operator.
    await loadDotEnv(path.dirname(configPath));
  } catch {
    skipWithoutLiveCheck(t, 'the explicit configuration could not be loaded.');
    return null;
  }

  const candidates = [...config.providers.values()].filter(isOpenRouterProfile);
  const profile = configuredProfile === undefined
    ? candidates.find(candidate => candidate.name === config.defaultProvider) ?? candidates[0]
    : config.providers.get(configuredProfile);
  if (profile === undefined || !isOpenRouterProfile(profile) || typeof profile.model !== 'string' || !profile.model.trim()) {
    skipWithoutLiveCheck(t, 'the explicit configuration has no selected OpenRouter profile with a model name.');
    return null;
  }
  const keyReference = profile.credentials?.apiKey;
  if (typeof keyReference !== 'string' || !keyReference.trim()) {
    skipWithoutLiveCheck(t, 'the selected OpenRouter profile has no apiKey reference.');
    return null;
  }

  const vault = new EnvFileVault(path.join(path.dirname(configPath), '.env'), process.env);
  let apiKey;
  let endpoint;
  try {
    apiKey = await vault.resolve(keyReference);
    endpoint = profile.endpoint === undefined ? undefined : await vault.resolve(profile.endpoint);
  } catch {
    skipWithoutLiveCheck(t, 'the selected OpenRouter apiKey reference could not be resolved.');
    return null;
  }
  if (!apiKey || /^\$\{[^}]+\}$/.test(apiKey)) {
    skipWithoutLiveCheck(t, 'the selected OpenRouter apiKey is not configured.');
    return null;
  }

  const resolved = {
    ...profile,
    ...(endpoint === undefined ? {} : { endpoint }),
    credentials: { ...profile.credentials, apiKey },
    // The test validates the configured model/profile but bounds its paid response to one short word.
    parameters: { ...(profile.parameters ?? {}), maxTokens: 16, completionTimeoutMs: 60_000 },
  };
  try {
    validateOpenRouterConfig(resolved);
  } catch {
    skipWithoutLiveCheck(t, 'the selected OpenRouter profile does not contain a valid model/key configuration.');
    return null;
  }
  return resolved;
}

test('OpenRouter configured E2E runs a selected profile through Cortex session persistence', async t => {
  const profile = await loadConfiguredProfile(t);
  if (profile === null) return;

  const { OpenRouterAdapter } = await import('../local-agent/matbot/packages/plugins/providers/openrouter/src/adapter.ts');
  const { runSession } = await import('../local-agent/matbot/packages/core/runner/src/runner.ts');
  const store = new MemoryStore();
  const session = {
    id: 'openrouter-configured-e2e', version: '1', ownerPrincipalId: 'openrouter-e2e', status: 'active', contexts: [],
    messages: [{
      id: 'openrouter-configured-e2e-user', role: 'user', traceId: 'openrouter-configured-e2e', createdAt: new Date().toISOString(),
      content: [{ type: 'text', text: 'Reply with only the single word ok. Do not call tools.' }],
    }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await store.set(session.id, session);
  const events = [];
  for await (const event of runSession({
    session,
    config: { provider: profile.name, sessionId: session.id, traceId: 'openrouter-configured-e2e' },
    provider: new OpenRouterAdapter(), providerConfig: profile, tools: new Map(), store,
    signal: new AbortController().signal,
    async loadPlugin() { throw new Error('No plugin load is expected in the OpenRouter E2E smoke.'); },
    async unloadPlugin() { return false; },
  })) events.push(event);

  const terminal = events.at(-1);
  if (terminal?.type === 'error' && /OpenRouter request failed \((?:401|402|403|404|429)\b/.test(terminal.error)) {
    skipWithoutLiveCheck(t, 'the configured OpenRouter key, account quota, or model was rejected by the service.');
    return;
  }
  assert.equal(terminal?.type, 'done', terminal?.type === 'error' ? terminal.error : 'the live turn did not complete successfully');
  assert.ok(events.some(event => event.type === 'text-delta'), 'the configured model must stream text through the Cortex runner');
  const persisted = await store.get(session.id);
  const assistant = persisted?.messages.find(message => message.role === 'assistant');
  assert.ok(assistant, 'Cortex must persist the completed assistant turn');
  assert.equal(assistant.providerName, profile.name);
  assert.equal(assistant.metadata?.completion?.gateway, 'openrouter');
  assert.equal(assistant.metadata?.completion?.requestedModel, profile.model);
});
