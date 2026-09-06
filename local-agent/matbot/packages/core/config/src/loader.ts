import type { ModelParameters, Principal, ProviderConfig } from '@matatbread/matbot-plugin-api';
import { parseYaml, type YamlMap, type YamlValue } from './yaml.js';

/** Parsed contents of a `matbot.yaml` file (optionally merged over a base document). */
export interface MatbotConfig {
  /** Optional tool-invocation policy (ordered permission rules plus a default action). */
  permissions?:NonNullable<import('@matatbread/matbot-plugin-api').MatbotServices['ToolInvocationPolicy']>;
  /** Optional capability profile selecting a preset policy tier. */
  capabilityProfile?:'standard'|'minimal'|'compatibility';
  /** Ordered list of plugin specifiers to load at startup (npm names or URL paths) */
  plugins:    readonly string[];
  /** Named provider profiles, keyed by provider name. */
  providers:  Map<string, ProviderConfig>;
  /** If set, run this prompt as a single non-interactive turn then exit. */
  prompt?:           string;
  /** If true, do not persist the session. */
  ephemeral?:        boolean;
  /** Provider key to use when none is specified on the CLI. Falls back to the first provider. */
  defaultProvider?:  string;
  /** Install-default boot identity. The lowest-precedence source for the entry's principal
   *  (a `--principal` flag or `MATBOT_PRINCIPAL` env override it); absent ⇒ the system principal. */
  principal?:        Principal;
}

/**
 * Coerce a YAML value to a string, failing with a labeled error otherwise.
 *
 * @param v - The raw value (must already be a string).
 * @param label - Dotted path used in the error message.
 * @returns The string value.
 * @throws Error When `v` is not a string.
 */
function asString(v: YamlValue | undefined, label: string): string {
  if (typeof v === 'string') return v;
  throw new Error(`Config: expected string for "${label}", got ${v === undefined ? 'undefined' : typeof v}`);
}

/**
 * Coerce a YAML value to a mapping, failing with a labeled error otherwise.
 *
 * @param v - The raw value (must be a non-array object).
 * @param label - Dotted path used in the error message.
 * @returns The mapping.
 * @throws Error When `v` is not a mapping.
 */
function asRecord(v: YamlValue | undefined, label: string): YamlMap {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as YamlMap;
  throw new Error(`Config: expected mapping for "${label}", got ${v === undefined ? 'undefined' : typeof v}`);
}

const NUMERIC_PARAMETER_NAMES = new Set([
  'temperature',
  'maxTokens',
  'topP',
  'maxContextTokens',
  'maxOutputTokens',
  'maxCompletionTokens',
]);

/**
 * Convert a raw YAML mapping into model parameters, coercing well-known numeric settings
 * (e.g. `temperature`, `maxTokens`) written as strings into numbers. Provider parameters are
 * deliberately JSON-shaped: adapters own their individual schemas, while the loader preserves
 * nested maps and arrays so a valid provider-specific setting survives a restart.
 *
 * @param raw - The raw `parameters` mapping of a provider profile.
 * @returns The normalized parameters object.
 * @throws Never.
 */
const MAX_PARAMETER_DEPTH = 8;
const FORBIDDEN_PARAMETER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Copy a YAML value into a bounded, JSON-compatible value. Keeping this generic is important:
 * configuration loading must not reject another adapter's extension merely because OpenRouter
 * does not use it. The adapter validates its own namespace later, immediately before a request.
 */
function normalizeParameter(value: YamlValue, path: string, depth = 0): unknown {
  if (depth > MAX_PARAMETER_DEPTH) {
    throw new Error(`Config: provider parameter "${path}" exceeds the maximum nesting depth of ${MAX_PARAMETER_DEPTH}`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Config: provider parameter "${path}" must be finite`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeParameter(item, `${path}[${index}]`, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PARAMETER_KEYS.has(key)) {
      throw new Error(`Config: provider parameter "${path}.${key}" uses a forbidden object key`);
    }
    result[key] = normalizeParameter(child, `${path}.${key}`, depth + 1);
  }
  return result;
}

function toModelParameters(raw: YamlMap): ModelParameters {
  const params: ModelParameters = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_PARAMETER_KEYS.has(k)) {
      throw new Error(`Config: provider parameter "${k}" uses a forbidden object key`);
    }
    if (typeof v === 'string') {
      if (NUMERIC_PARAMETER_NAMES.has(k)) {
        const n = Number(v.trim());
        params[k] = v.trim() !== '' && Number.isFinite(n) ? n : v;
      } else {
        params[k] = v;
      }
    } else {
      params[k] = normalizeParameter(v, k);
    }
  }
  return params;
}

/**
 * Build one named provider profile from its raw YAML mapping. `module` and `model` are required
 * strings; `credentials`, `endpoint`, `fallback`, and `parameters` are optional.
 *
 * @param name - The provider profile name (its key under `providers`).
 * @param raw - The raw profile mapping.
 * @returns The typed provider configuration.
 * @throws Error When a required field is missing or mis-typed, or an optional one is malformed
 *                (via {@link asString}/{@link asRecord}/{@link toModelParameters}).
 */
function toProviderConfig(name: string, raw: YamlMap): ProviderConfig {
  const module_ = asString(raw['module'], `providers.${name}.module`);
  const model   = asString(raw['model'],  `providers.${name}.model`);

  const credsRaw   = raw['credentials'];
  const credentials: Record<string, string> = {};
  if (credsRaw !== undefined) {
    const credsMap = asRecord(credsRaw, `providers.${name}.credentials`);
    for (const [k, v] of Object.entries(credsMap)) {
      credentials[k] = asString(v, `providers.${name}.credentials.${k}`);
    }
  }

  const config: ProviderConfig = { name, module: module_, model, credentials };

  if (raw['endpoint'] !== undefined) {
    config.endpoint = asString(raw['endpoint'], `providers.${name}.endpoint`);
  }
  if (raw['fallback'] !== undefined) {
    config.fallback = asString(raw['fallback'], `providers.${name}.fallback`);
  }
  if (raw['parameters'] !== undefined) {
    config.parameters = toModelParameters(asRecord(raw['parameters'], `providers.${name}.parameters`));
  }

  return config;
}

/**
 * Accept only a numeric YAML value.
 *
 * @param v - The raw YAML value.
 * @returns The number, or `undefined` for anything else (including numeric strings).
 * @throws Never.
 */
function optionalNumber(v: YamlValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/**
 * Derive the provider name for one model entry of an `openai_compatible` group: the bare group
 * name when the group declares a single model, otherwise `group-model`.
 *
 * @param groupName - The group name in the config.
 * @param models - The group's model entries (its length decides the naming shape).
 * @param modelName - The current entry's model name.
 * @returns The provider key to register the model under.
 * @throws Never.
 */
function providerNameForModel(groupName: string, models: YamlValue[], modelName: string): string {
  return models.length === 1 ? groupName : `${groupName}-${modelName}`;
}

/**
 * Insert a provider into the accumulator map, warning when the name is already taken (the later
 * definition replaces the earlier one).
 *
 * @param providers - The accumulator map of provider configs.
 * @param name - The provider key to set.
 * @param config - The provider configuration to store.
 * @returns Nothing.
 * @throws Never.
 */
function setProvider(providers: Map<string, ProviderConfig>, name: string, config: ProviderConfig): void {
  if (providers.has(name)) {
    console.warn(`Config: provider "${name}" is defined more than once; the later definition replaces the earlier one`);
  }
  providers.set(name, config);
}

/**
 * Expand the legacy `language_models.openai_compatible` section into one provider profile per
 * model, all routed through the built-in OpenAI-compatible adapter. Provider keys are derived
 * by {@link providerNameForModel}; `max_tokens`/`max_output_tokens`/`max_completion_tokens`
 * map onto the matching model parameters (falling back to 4096 output tokens).
 *
 * @param raw - The raw `openai_compatible` value; `undefined` yields an empty map.
 * @returns The derived provider configs, keyed by provider name.
 * @throws Error When the section is malformed (a non-mapping group, a missing `api_url`, a
 *                non-sequence `available_models`, or a malformed model entry).
 */
function toOpenAICompatibleProviderConfigs(raw: YamlValue | undefined): Map<string, ProviderConfig> {
  const providers = new Map<string, ProviderConfig>();
  if (raw === undefined) return providers;

  const root = asRecord(raw, 'language_models.openai_compatible');
  for (const [groupName, groupRaw] of Object.entries(root)) {
    const group = asRecord(groupRaw, `language_models.openai_compatible.${groupName}`);
    const apiUrl = asString(group['api_url'], `language_models.openai_compatible.${groupName}.api_url`);
    const models = group['available_models'];
    if (!Array.isArray(models)) {
      throw new Error(`Config: "language_models.openai_compatible.${groupName}.available_models" must be a sequence (list)`);
    }

    for (let i = 0; i < models.length; i++) {
      const model = asRecord(models[i], `language_models.openai_compatible.${groupName}.available_models[${i}]`);
      const modelName = asString(model['name'], `language_models.openai_compatible.${groupName}.available_models[${i}].name`);
      const providerName = providerNameForModel(groupName, models, modelName);

      const contextTokens = optionalNumber(model['max_tokens']);
      const outputTokens = optionalNumber(model['max_output_tokens']);
      const completionTokens = optionalNumber(model['max_completion_tokens']);
      const capabilities = model['capabilities'] !== undefined
        ? asRecord(model['capabilities'], `language_models.openai_compatible.${groupName}.available_models[${i}].capabilities`)
        : undefined;

      const parameters: ModelParameters = {
        apiUrl,
        maxTokens: outputTokens ?? completionTokens ?? contextTokens ?? 4096,
      };
      if (contextTokens !== undefined) parameters['maxContextTokens'] = contextTokens;
      if (outputTokens !== undefined) parameters['maxOutputTokens'] = outputTokens;
      if (completionTokens !== undefined) parameters['maxCompletionTokens'] = completionTokens;
      if (capabilities !== undefined) parameters['capabilities'] = capabilities;

      setProvider(providers, providerName, {
        name: providerName,
        module: './packages/plugins/providers/openai-compat',
        endpoint: apiUrl,
        model: modelName,
        parameters,
      });
    }
  }

  return providers;
}

/**
 * Parse a `matbot.yaml` document (optionally merged over a base document) into a {@link MatbotConfig}.
 *
 * @param text - The derived YAML source (the user's `matbot.yaml`).
 * @param base - Optional base YAML merged underneath; keys in `text` take precedence.
 * @returns The parsed configuration.
 * @throws If any field has the wrong type — e.g. `plugins` is not a list, a provider entry
 *         lacks a string `module`/`model`, or `principal` is neither a string id nor an
 *         `{ id, type? }` mapping.
 */
export function parseConfig(
  text:  string,
  base?: string,
): MatbotConfig {
  const derived = parseYaml(text);
  const doc: YamlMap = base !== undefined
    ? { ...parseYaml(base), ...derived }
    : derived;

  // plugins: optional ordered list of specifiers
  const pluginsRaw = doc['plugins'];
  const plugins: string[] = [];
  if (pluginsRaw !== undefined) {
    if (!Array.isArray(pluginsRaw)) {
      throw new Error('Config: "plugins" must be a sequence (list)');
    }
    for (let i = 0; i < pluginsRaw.length; i++) {
      plugins.push(asString(pluginsRaw[i], `plugins[${i}]`));
    }
  }

  const providersRaw = doc['providers'];
  const providers    = new Map<string, ProviderConfig>();

  const languageModels = doc['language_models'];
  if (languageModels !== undefined) {
    const languageModelsMap = asRecord(languageModels, 'language_models');
    for (const [name, config] of toOpenAICompatibleProviderConfigs(languageModelsMap['openai_compatible'])) {
      setProvider(providers, name, config);
    }
  }

  if (providersRaw !== undefined) {
    const providersMap = asRecord(providersRaw, 'providers');
    for (const [name, raw] of Object.entries(providersMap)) {
      setProvider(providers, name, toProviderConfig(name, asRecord(raw, `providers.${name}`)));
    }
  }

  const prompt           = typeof doc['prompt']            === 'string' ? doc['prompt']            : undefined;
  const ephemeral        = doc['ephemeral'] === true ? true : undefined;
  const defaultProvider  = typeof doc['default_provider'] === 'string' ? doc['default_provider']  : undefined;
  const principal        = toPrincipal(doc['principal']);

  return {
    plugins,
    ...(doc['permissions']!==undefined?{permissions:parseInvocationPolicy(doc['permissions'])}:{}),
    ...(doc['capabilityProfile']!==undefined?{capabilityProfile:parseCapabilityProfile(doc['capabilityProfile'])}:{}),
    providers,
    ...(prompt           !== undefined ? { prompt           } : {}),
    ...(ephemeral        !== undefined ? { ephemeral        } : {}),
    ...(defaultProvider  !== undefined ? { defaultProvider  } : {}),
    ...(principal        !== undefined ? { principal        } : {}),
  };
}

// principal: either a bare string id (type defaults to 'user') or a mapping { id, type? }.
/**
 * Convert the `principal` config value into a {@link Principal}: a bare string is an id of type
 * `user`; a mapping must carry a non-empty string `id` with an optional `type` (anything other
 * than `agent`/`system` coerces to `user`).
 *
 * @param v - The raw `principal` value (may be `undefined`).
 * @returns The principal, or `undefined` when unset.
 * @throws Error When the value is neither a string nor a mapping with a string `id`.
 */
function toPrincipal(v: YamlValue | undefined): Principal | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return { id: v, type: 'user' };
  if (typeof v === 'object' && !Array.isArray(v)) {
    const id   = (v as YamlMap)['id'];
    const type = (v as YamlMap)['type'];
    if (typeof id === 'string' && id !== '') {
      return { id, type: type === 'agent' || type === 'system' ? type : 'user' };
    }
  }
  throw new Error('Config: "principal" must be a string id or a mapping with a string "id" (and optional "type").');
}

/**
 * Validate and normalize the `permissions` node into the ToolInvocationPolicy shape. Every
 * action must be `allow`, `ask`, or `deny`; `defaultAction` defaults to `allow`.
 *
 * @param value - The raw `permissions` value.
 * @returns The normalized invocation policy.
 * @throws Error When `permissions` is not a mapping, `rules` is not an array, a rule is
 *                malformed, or an action is invalid.
 */
function parseInvocationPolicy(value:YamlValue):NonNullable<MatbotConfig['permissions']>{
 const raw=asRecord(value,'permissions');const action=(v:YamlValue|undefined)=>{if(v!=='allow'&&v!=='ask'&&v!=='deny')throw new Error('Invalid permission action');return v;};
 const rules=raw['rules'];if(rules!==undefined&&!Array.isArray(rules))throw new Error('permissions.rules must be an array');
 return {defaultAction:raw['defaultAction']===undefined?'allow':action(raw['defaultAction']),rules:(rules as YamlValue[]??[]).map(row=>{const rule=asRecord(row,'permission rule');return {permission:asString(rule['permission'],'permission'),pattern:asString(rule['pattern'],'pattern'),action:action(rule['action'])};})};
}
/**
 * Validate the `capabilityProfile` value against the known profiles.
 *
 * @param value - The raw `capabilityProfile` value.
 * @returns The profile name.
 * @throws Error When the value is not one of `standard`, `minimal`, or `compatibility`.
 */
function parseCapabilityProfile(value:YamlValue):NonNullable<MatbotConfig['capabilityProfile']>{if(value==='standard'||value==='minimal'||value==='compatibility')return value;throw new Error('Unknown capabilityProfile');}
