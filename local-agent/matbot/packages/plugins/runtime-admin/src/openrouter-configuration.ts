import { readFile } from 'node:fs/promises';
import { parseConfig } from '@matatbread/matbot-config';
import type { MatbotMachine, ProviderConfig } from '@matatbread/matbot-plugin-api';
import { validateOpenRouterConfig } from '@matatbread/matbot-provider-openrouter';
import { configurationVersion, mutateConfigurationFile } from './config-file.js';
import { serializeProviderProfile } from './provider.js';

type ProfileEdit = { model: string; endpoint?: string; credentials: { apiKey: string }; parameters?: Record<string, unknown> };
type ProfileEdits = Record<string, ProfileEdit>;
const REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

function isOpenRouterProfile(config: ProviderConfig): boolean {
  return config.module === '@matatbread/matbot-provider-openrouter' || /(?:^|[\\/])openrouter(?:[\\/]index(?:\.\w+)?)?$/i.test(config.module);
}

function safeEdit(config: ProviderConfig): ProfileEdit {
  const apiKey = config.credentials?.['apiKey'];
  if (typeof apiKey !== 'string' || !REF.test(apiKey)) {
    throw new Error(`OpenRouter profile "${config.name}" must use an apiKey vault/environment reference before it can be edited.`);
  }
  return { model: config.model, credentials: { apiKey }, ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}), ...(config.parameters !== undefined ? { parameters: structuredClone(config.parameters) } : {}) };
}

function readProfiles(text: string): { configs: Map<string, ProviderConfig>; value: ProfileEdits } {
  const configs = parseConfig(text).providers;
  return { configs, value: Object.fromEntries([...configs].filter(([, config]) => isOpenRouterProfile(config)).map(([name, config]) => [name, safeEdit(config)])) };
}

function validateEdits(value: unknown, names: readonly string[]): asserts value is ProfileEdits {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('OpenRouter profiles must be an object keyed by configured profile names.');
  const entries = Object.entries(value);
  if (entries.length !== names.length || entries.some(([name]) => !names.includes(name))) throw new Error('OpenRouter profile edits must include exactly the existing OpenRouter profiles. Add or remove profiles with the provider tool.');
  for (const [name, candidate] of entries) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`OpenRouter profile "${name}" must be an object.`);
    const edit = candidate as Record<string, unknown>;
    if (Object.keys(edit).some(key => !['model', 'endpoint', 'credentials', 'parameters'].includes(key))) throw new Error(`OpenRouter profile "${name}" contains an unsupported field.`);
    const credentials = edit['credentials'];
    const apiKey = credentials !== null && typeof credentials === 'object' && !Array.isArray(credentials)
      ? (credentials as Record<string, unknown>)['apiKey']
      : undefined;
    if (typeof apiKey !== 'string' || !REF.test(apiKey)) throw new Error(`OpenRouter profile "${name}" needs an apiKey reference such as \${OPENROUTER_API_KEY}.`);
    try {
      validateOpenRouterConfig({ name, module: '@matatbread/matbot-provider-openrouter', model: edit['model'] as string, ...(edit['endpoint'] !== undefined ? { endpoint: edit['endpoint'] as string } : {}), credentials: { apiKey: 'validation-sentinel' }, ...(edit['parameters'] !== undefined ? { parameters: edit['parameters'] as Record<string, unknown> } : {}) });
    } catch (error) {
      throw new Error(error instanceof Error ? `Invalid OpenRouter profile "${name}": ${error.message}` : `Invalid OpenRouter profile "${name}".`);
    }
  }
}

function profileRange(lines: string[], name: string): { start: number; end: number } {
  const header = lines.findIndex(line => /^providers:\s*$/.test(line));
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const profileHeader = new RegExp(`^  ${escapedName}:\\s*(?:#.*)?$`);
  const start = header < 0 ? -1 : lines.findIndex((line, index) => index > header && profileHeader.test(line));
  if (start < 0) throw new Error(`Cannot locate OpenRouter profile "${name}" in this configuration.`);
  let end = start + 1;
  while (end < lines.length && (lines[end]!.startsWith(' ') || lines[end]!.trim() === '')) end++;
  return { start, end };
}

/** A versioned, non-secret editor for existing OpenRouter profiles. */
export function registerOpenRouterProfileConfiguration(services: MatbotMachine, live: Map<string, ProviderConfig>): void {
  if (!services.configPath) return;
  const file = services.configPath;
  services.contributions?.register('configuration', 'openrouter-profiles', {
    title: 'OpenRouter profiles', scope: 'workspace', apply: 'immediate', secretPaths: [],
    schema: { type: 'object', additionalProperties: { type: 'object', properties: { model: { type: 'string' }, endpoint: { type: 'string' }, credentials: { type: 'object', properties: { apiKey: { type: 'string' } } }, parameters: { type: 'object' } } } },
    async read() { const text = await readFile(file, 'utf8'); return { version: configurationVersion(text), value: readProfiles(text).value }; },
    async validate(value) { const text = await readFile(file, 'utf8'); validateEdits(value, Object.keys(readProfiles(text).value)); },
    async update(value, expectedVersion) {
      const next = await mutateConfigurationFile(file, text => {
        const current = readProfiles(text);
        validateEdits(value, Object.keys(current.value));
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        for (const name of Object.keys(value as ProfileEdits).sort((a, b) => b.localeCompare(a))) {
          const edit = (value as ProfileEdits)[name]!;
          const source = current.configs.get(name)!;
          const range = profileRange(lines, name);
          const block = serializeProviderProfile({ name, module: source.module, model: edit.model, ...(edit.endpoint !== undefined ? { endpoint: edit.endpoint } : {}), credentials: edit.credentials, ...(edit.parameters !== undefined ? { parameters: edit.parameters } : {}) });
          lines.splice(range.start, range.end - range.start, ...block.trimEnd().split('\n'));
        }
        const updated = lines.join('\n');
        const verified = readProfiles(updated);
        validateEdits(verified.value, Object.keys(current.value));
        return { text: updated, value: { version: configurationVersion(updated), value: verified.value } };
      }, expectedVersion);
      for (const [name, edit] of Object.entries(next.value)) {
        const old = live.get(name)!;
        const updated: ProviderConfig = { ...old, model: edit.model, credentials: edit.credentials };
        if (edit.endpoint === undefined) delete updated.endpoint;
        else updated.endpoint = edit.endpoint;
        if (edit.parameters === undefined) delete updated.parameters;
        else updated.parameters = edit.parameters;
        live.set(name, updated);
      }
      return next;
    },
  });
}
