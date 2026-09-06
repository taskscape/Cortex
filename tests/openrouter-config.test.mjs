import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

register('./ts-hooks.js', pathToFileURL(fileURLToPath(new URL('../local-agent/matbot/apps/cli/ts-hooks.js', import.meta.url))));

const { parseConfig } = await import('../local-agent/matbot/packages/core/config/src/loader.ts');
const { parseYaml, serializeYamlScalar } = await import('../local-agent/matbot/packages/core/config/src/yaml.ts');
const { validateOpenRouterConfig } = await import('../local-agent/matbot/packages/plugins/providers/openrouter/src/config.ts');
const { OpenRouterCatalogService } = await import('../local-agent/matbot/packages/plugins/providers/openrouter/src/models.ts');
const { PluginContributions } = await import('../local-agent/matbot/packages/core/runner/src/contributions.ts');
const { registerOpenRouterProfileConfiguration } = await import('../local-agent/matbot/packages/plugins/runtime-admin/src/openrouter-configuration.ts');
const { createOpenRouterTool } = await import('../local-agent/matbot/packages/plugins/runtime-admin/src/openrouter.ts');

test('OR-01 native nested provider parameters survive config parsing exactly', () => {
  const parsed = parseConfig([
    'providers:', '  OpenRouter Reasoning:', '    module: ./packages/plugins/providers/openrouter', '    model: vendor/reasoning-model',
    '    credentials:', '      apiKey: ${OPENROUTER_API_KEY}', '    parameters:', '      maxTokens: "8192"', '      stopSequences:', '        - "END#MARK"',
    '      capabilities:', '        tools: true', '        images: false', '      openrouter:', '        provider:', '          require_parameters: true', '          order:', '            - first', '            - second',
    '        reasoning:', '          effort: medium', '',
  ].join('\n'));
  const profile = parsed.providers.get('OpenRouter Reasoning');
  assert.equal(profile?.parameters?.maxTokens, 8192);
  assert.deepEqual(profile?.parameters?.stopSequences, ['END#MARK']);
  assert.deepEqual(profile?.parameters?.capabilities, { tools: true, images: false });
  assert.deepEqual(profile?.parameters?.openrouter, {
    provider: { require_parameters: true, order: ['first', 'second'] }, reasoning: { effort: 'medium' },
  });
});

test('OR-01 YAML scalar serializer round-trips strings that could alter a provider block', () => {
  const value = 'name # with "quotes" and \\ slash';
  assert.equal(parseYaml(`value: ${serializeYamlScalar(value)}\n`).value, value);
});

test('OR-02 rejects unresolved credentials, a non-official endpoint, and conflicting routing locally', () => {
  const base = { name: 'OR', module: 'openrouter', model: 'openai/gpt-4o', credentials: { apiKey: '${OPENROUTER_API_KEY}' } };
  assert.throws(() => validateOpenRouterConfig(base), /no resolved apiKey/);
  assert.throws(() => validateOpenRouterConfig({ ...base, credentials: { apiKey: 'fake' }, endpoint: 'https://proxy.example/api/v1' }), /endpoint must be/);
  assert.throws(() => validateOpenRouterConfig({ ...base, credentials: { apiKey: 'fake' }, parameters: { openrouter: { provider: { only: ['a'], ignore: ['a'] } } } }), /cannot contain the same provider/);
  assert.throws(() => validateOpenRouterConfig({ ...base, name: 'bad\u0000profile', credentials: { apiKey: 'fake' } }), /profile name/);
});

test('OR-05 OpenRouter configuration validates output and reasoning limits before requests', () => {
  const base = { name: 'OR', module: 'openrouter', model: 'openai/gpt-4o', credentials: { apiKey: 'fake' } };
  assert.throws(() => validateOpenRouterConfig({ ...base, parameters: { tokenLimitParam: 'max_completion_tokens' } }), /max_tokens/);
  assert.throws(() => validateOpenRouterConfig({ ...base, parameters: { maxTokens: 10, openrouter: { reasoning: { max_tokens: 10 } } } }), /leave room/);
  const valid = validateOpenRouterConfig({ ...base, parameters: { maxOutputTokens: 12, topP: 0.5, stopSequences: ['END'], openrouter: { reasoning: { max_tokens: 4 } } } });
  assert.equal(valid.outputTokens, 12);
  assert.equal(valid.topP, 0.5);
  assert.deepEqual(valid.stop, ['END']);
});

test('OR-16 shares catalog refreshes and retains a marked-stale complete catalog after failure', async () => {
  let calls = 0;
  const service = new OpenRouterCatalogService({
    fetchImpl: async () => {
      calls++;
      if (calls > 1) throw new Error('offline');
      return new Response(JSON.stringify({ data: [{ id: 'vendor/exact', name: 'Exact', context_length: 128, supported_parameters: ['tools'] }] }));
    },
  });
  const [first, same] = await Promise.all([service.get(true), service.get(true)]);
  assert.equal(calls, 1);
  assert.deepEqual(first, same);
  assert.equal(first.models[0].id, 'vendor/exact');
  const stale = await service.get(true);
  assert.equal(stale.stale, true);
  assert.equal(stale.models[0].id, 'vendor/exact');
});

test('OR-18 updates OpenRouter profiles atomically, validates settings, and preserves unrelated YAML', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cortex-openrouter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'matbot.yaml');
  const original = [
    '# preserve this comment',
    'providers:',
    '  Local:',
    '    module: ./local',
    '    model: local-model',
    '  OpenRouter Chat: # preserve profile-header comment while replacing its settings',
    '    module: ./packages/plugins/providers/openrouter',
    '    model: vendor/original',
    '    credentials:',
    '      apiKey: ${OPENROUTER_API_KEY}',
    '    parameters:',
    '      maxTokens: 64',
    'plugins:',
    '  - ./runtime-admin',
    '',
  ].join('\n');
  await writeFile(configPath, original, 'utf8');
  const registry = new PluginContributions();
  const services = { configPath, contributions: registry.forOwner('openrouter-test') };
  const live = new Map([
    ['Local', { name: 'Local', module: './local', model: 'local-model' }],
    ['OpenRouter Chat', { name: 'OpenRouter Chat', module: './packages/plugins/providers/openrouter', model: 'vendor/original', credentials: { apiKey: '${OPENROUTER_API_KEY}' }, parameters: { maxTokens: 64 } }],
  ]);
  registerOpenRouterProfileConfiguration(services, live);
  const contributor = services.contributions.list('configuration').find(row => row.id === 'openrouter-profiles').value;
  const snapshot = await contributor.read();
  assert.equal(snapshot.value['OpenRouter Chat'].model, 'vendor/original');
  const nextValue = structuredClone(snapshot.value);
  nextValue['OpenRouter Chat'].model = 'vendor/updated#safe';
  nextValue['OpenRouter Chat'].parameters = { maxTokens: 128, capabilities: { tools: true }, openrouter: { provider: { only: ['provider-a'] } } };
  await contributor.update(nextValue, snapshot.version);
  const updated = await readFile(configPath, 'utf8');
  assert.match(updated, /# preserve this comment/);
  assert.match(updated, /Local:/);
  assert.match(updated, /model: "vendor\/updated#safe"/);
  assert.equal(live.get('OpenRouter Chat').model, 'vendor/updated#safe');
  await assert.rejects(() => contributor.update(nextValue, snapshot.version), /conflict/);
  const invalid = structuredClone(nextValue);
  invalid['OpenRouter Chat'].endpoint = 'https://proxy.example/api/v1';
  await assert.rejects(() => contributor.validate(invalid), /endpoint must be/);
});

test('OR-17 validates configuration through the explicit diagnostic tool without exposing the resolved key', async () => {
  const tool = createOpenRouterTool(new Map([['OpenRouter Chat', {
    name: 'OpenRouter Chat', module: './packages/plugins/providers/openrouter', model: 'vendor/exact', credentials: { apiKey: '${OPENROUTER_API_KEY}' },
  }]]));
  const context = {
    signal: new AbortController().signal,
    vault: {
      async resolve(value) { return value === '${OPENROUTER_API_KEY}' ? 'synthetic-openrouter-secret' : value; },
      scrub(value) { return value.replace('synthetic-openrouter-secret', '[REDACTED]'); },
    },
  };
  const events = [];
  for await (const event of tool.executor.execute({ action: 'validate', profile: 'OpenRouter Chat', mode: 'configuration' }, context)) events.push(event);
  assert.deepEqual(events, [{ type: 'result', value: { ok: true, profile: 'OpenRouter Chat', model: 'vendor/exact', endpoint: 'https://openrouter.ai/api/v1', mode: 'configuration' } }]);
  assert.doesNotMatch(JSON.stringify(events), /synthetic-openrouter-secret/);
});
