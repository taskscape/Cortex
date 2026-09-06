import type { ProviderConfig } from '@matatbread/matbot-plugin-api';

export const OPENROUTER_API_ORIGIN = 'https://openrouter.ai/api/v1';
export const OPENROUTER_COMPLETIONS_URL = `${OPENROUTER_API_ORIGIN}/chat/completions`;
const DEFAULT_MAX_TOKENS = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface OpenRouterCapabilities {
  tools?: boolean;
  images?: boolean;
  parallel_tool_calls?: boolean;
  chat_completions?: boolean;
  [key: string]: unknown;
}

export interface OpenRouterRouting {
  require_parameters: boolean;
  allow_fallbacks: boolean;
  order?: string[];
  only?: string[];
  ignore?: string[];
  data_collection?: 'allow' | 'deny';
  zdr?: boolean;
}

export interface OpenRouterReasoning {
  enabled?: boolean;
  effort?: 'low' | 'medium' | 'high';
  max_tokens?: number;
  exclude?: boolean;
}

export interface ValidatedOpenRouterConfig {
  completionUrl: string;
  apiOrigin: string;
  model: string;
  apiKey: string;
  outputTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  capabilities: OpenRouterCapabilities;
  cache: boolean;
  routing: OpenRouterRouting;
  reasoning?: OpenRouterReasoning;
  appTitle?: string;
  httpReferer?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OpenRouter ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`OpenRouter ${label} must be a positive integer.`);
  }
  return value;
}

function optionalFinite(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`OpenRouter ${label} must be a finite number from ${min} to ${max}.`);
  }
  return value;
}

function stringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 || value.some(v => typeof v !== 'string' || !v.trim() || CONTROL.test(v))) {
    throw new Error(`OpenRouter ${label} must be a non-empty bounded list of non-empty strings.`);
  }
  return value.map(v => (v as string).trim());
}

function normalizeEndpoint(value: unknown): { completionUrl: string; apiOrigin: string } {
  const raw = value === undefined ? OPENROUTER_API_ORIGIN : value;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('OpenRouter endpoint must be a non-empty HTTPS URL.');
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('OpenRouter endpoint must be a valid HTTPS URL.'); }
  const path = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'openrouter.ai' || url.port || url.username || url.password || url.search || url.hash ||
      (path !== '/api/v1' && path !== '/api/v1/chat/completions')) {
    throw new Error(`OpenRouter endpoint must be ${OPENROUTER_API_ORIGIN} or its /chat/completions URL.`);
  }
  return { completionUrl: OPENROUTER_COMPLETIONS_URL, apiOrigin: OPENROUTER_API_ORIGIN };
}

function validateModel(value: string): string {
  if (!value || value !== value.trim() || CONTROL.test(value) || /^https?:\/\//i.test(value)) {
    throw new Error('OpenRouter model must be a trimmed, non-empty opaque model ID, not a URL.');
  }
  return value;
}

function validateProfileName(value: string): string {
  if (!value || value !== value.trim() || CONTROL.test(value) || value.includes('\n') || value.includes('\r')) {
    throw new Error('OpenRouter profile name must be a trimmed, non-empty single-line name without control characters.');
  }
  return value;
}

function validateCapabilities(value: unknown): OpenRouterCapabilities {
  const caps = record(value, 'parameters.capabilities');
  for (const key of ['tools', 'images', 'parallel_tool_calls', 'chat_completions']) {
    if (caps[key] !== undefined && typeof caps[key] !== 'boolean') {
      throw new Error(`OpenRouter parameters.capabilities.${key} must be a boolean.`);
    }
  }
  return caps as OpenRouterCapabilities;
}

function validateRouting(value: unknown): OpenRouterRouting {
  const raw = record(value, 'parameters.openrouter.provider');
  const allowed = new Set(['require_parameters', 'allow_fallbacks', 'order', 'only', 'ignore', 'data_collection', 'zdr']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`OpenRouter parameters.openrouter.provider.${key} is not supported.`);
  const boolean = (key: 'require_parameters' | 'allow_fallbacks' | 'zdr', fallback?: boolean): boolean | undefined => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error(`OpenRouter parameters.openrouter.provider.${key} must be a boolean.`);
    return value;
  };
  const only = stringList(raw['only'], 'parameters.openrouter.provider.only');
  const ignore = stringList(raw['ignore'], 'parameters.openrouter.provider.ignore');
  const order = stringList(raw['order'], 'parameters.openrouter.provider.order');
  const zdr = boolean('zdr');
  if (only !== undefined && ignore !== undefined && only.some(value => ignore.includes(value))) {
    throw new Error('OpenRouter parameters.openrouter.provider.only and ignore cannot contain the same provider.');
  }
  const dataCollection = raw['data_collection'];
  if (dataCollection !== undefined && dataCollection !== 'allow' && dataCollection !== 'deny') {
    throw new Error('OpenRouter parameters.openrouter.provider.data_collection must be "allow" or "deny".');
  }
  return {
    require_parameters: boolean('require_parameters', true)!,
    allow_fallbacks: boolean('allow_fallbacks', true)!,
    ...(order !== undefined ? { order } : {}),
    ...(only !== undefined ? { only } : {}),
    ...(ignore !== undefined ? { ignore } : {}),
    ...(dataCollection !== undefined ? { data_collection: dataCollection } : {}),
    ...(zdr !== undefined ? { zdr } : {}),
  };
}

function validateReasoning(value: unknown, outputTokens: number): OpenRouterReasoning | undefined {
  if (value === undefined) return undefined;
  const raw = record(value, 'parameters.openrouter.reasoning');
  const allowed = new Set(['enabled', 'effort', 'max_tokens', 'exclude']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`OpenRouter parameters.openrouter.reasoning.${key} is not supported.`);
  const enabled = raw['enabled'];
  const effort = raw['effort'];
  const maxTokens = raw['max_tokens'];
  const exclude = raw['exclude'];
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('OpenRouter reasoning.enabled must be a boolean.');
  if (effort !== undefined && effort !== 'low' && effort !== 'medium' && effort !== 'high') throw new Error('OpenRouter reasoning.effort must be low, medium, or high.');
  if (maxTokens !== undefined) positiveInteger(maxTokens, 'reasoning.max_tokens');
  if (exclude !== undefined && typeof exclude !== 'boolean') throw new Error('OpenRouter reasoning.exclude must be a boolean.');
  if (effort !== undefined && maxTokens !== undefined) throw new Error('OpenRouter reasoning.effort and max_tokens cannot be used together.');
  if (enabled === false && (effort !== undefined || maxTokens !== undefined)) throw new Error('OpenRouter disabled reasoning cannot specify effort or max_tokens.');
  if (typeof maxTokens === 'number' && maxTokens >= outputTokens) throw new Error('OpenRouter reasoning.max_tokens must leave room inside the output token limit.');
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
  };
}

function optionalHeader(value: unknown, label: string, url = false): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || CONTROL.test(value)) throw new Error(`OpenRouter ${label} must be a short single-line string.`);
  const trimmed = value.trim();
  if (url) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
    } catch { throw new Error(`OpenRouter ${label} must be an absolute http(s) URL.`); }
  }
  return trimmed;
}

/** Validate and normalize the dedicated OpenRouter profile without mutating the source profile. */
export function validateOpenRouterConfig(config: ProviderConfig): ValidatedOpenRouterConfig {
  const parameters = config.parameters ?? {};
  validateProfileName(config.name);
  const endpoints = normalizeEndpoint(config.endpoint);
  const model = validateModel(config.model);
  const apiKey = config.credentials?.['apiKey'];
  if (typeof apiKey !== 'string' || !apiKey.trim() || /^\$\{[^}]+\}$/.test(apiKey.trim())) {
    throw new Error(`OpenRouter profile "${config.name}" has no resolved apiKey. Configure or unlock its credential reference.`);
  }
  const maxOutput = parameters['maxOutputTokens'];
  const maxTokens = parameters['maxTokens'];
  const outputTokens = maxOutput !== undefined ? positiveInteger(maxOutput, 'parameters.maxOutputTokens') :
    maxTokens !== undefined ? positiveInteger(maxTokens, 'parameters.maxTokens') : DEFAULT_MAX_TOKENS;
  if (parameters['tokenLimitParam'] !== undefined && parameters['tokenLimitParam'] !== 'max_tokens') {
    throw new Error('OpenRouter parameters.tokenLimitParam must be omitted or "max_tokens".');
  }
  const stop = stringList(parameters['stopSequences'], 'parameters.stopSequences');
  const topP = optionalFinite(parameters['topP'], 'parameters.topP', Number.MIN_VALUE, 1);
  const temperature = optionalFinite(parameters['temperature'], 'parameters.temperature', 0, 2);
  const openrouter = record(parameters['openrouter'], 'parameters.openrouter');
  const allowed = new Set(['appTitle', 'httpReferer', 'provider', 'reasoning']);
  for (const key of Object.keys(openrouter)) if (!allowed.has(key)) throw new Error(`OpenRouter parameters.openrouter.${key} is not supported.`);
  const reasoning = validateReasoning(openrouter['reasoning'], outputTokens);
  const appTitle = optionalHeader(openrouter['appTitle'], 'parameters.openrouter.appTitle');
  const httpReferer = optionalHeader(openrouter['httpReferer'], 'parameters.openrouter.httpReferer', true);
  return {
    ...endpoints,
    model,
    apiKey: apiKey.trim(),
    outputTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(stop !== undefined ? { stop } : {}),
    capabilities: validateCapabilities(parameters['capabilities']),
    cache: parameters['promptCache'] === true,
    routing: validateRouting(openrouter['provider']),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(appTitle !== undefined ? { appTitle } : {}),
    ...(httpReferer !== undefined ? { httpReferer } : {}),
  };
}
