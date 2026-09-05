import type { ModelParameters, Principal, ProviderConfig } from '@matatbread/matbot-plugin-api';
import { parseYaml, type YamlMap, type YamlValue } from './yaml.js';

/** Parsed contents of a `matbot.yaml` file (optionally merged over a base document). */
export interface MatbotConfig {
  permissions?:NonNullable<import('@matatbread/matbot-plugin-api').MatbotServices['ToolInvocationPolicy']>;
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

function asString(v: YamlValue | undefined, label: string): string {
  if (typeof v === 'string') return v;
  throw new Error(`Config: expected string for "${label}", got ${v === undefined ? 'undefined' : typeof v}`);
}

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

function toModelParameters(raw: YamlMap): ModelParameters {
  const params: ModelParameters = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' || typeof v === 'boolean') {
      params[k] = v;
    } else if (typeof v === 'string') {
      if (NUMERIC_PARAMETER_NAMES.has(k)) {
        const n = Number(v.trim());
        params[k] = v.trim() !== '' && !Number.isNaN(n) ? n : v;
      } else {
        params[k] = v;
      }
    } else {
      console.warn(
        `Config: provider parameter "${k}" must be a number, string, or boolean; got ${Array.isArray(v) ? 'a sequence' : 'a mapping'} — skipping`,
      );
    }
  }
  return params;
}

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

function optionalNumber(v: YamlValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function providerNameForModel(groupName: string, models: YamlValue[], modelName: string): string {
  return models.length === 1 ? groupName : `${groupName}-${modelName}`;
}

function setProvider(providers: Map<string, ProviderConfig>, name: string, config: ProviderConfig): void {
  if (providers.has(name)) {
    console.warn(`Config: provider "${name}" is defined more than once; the later definition replaces the earlier one`);
  }
  providers.set(name, config);
}

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

function parseInvocationPolicy(value:YamlValue):NonNullable<MatbotConfig['permissions']>{
 const raw=asRecord(value,'permissions');const action=(v:YamlValue|undefined)=>{if(v!=='allow'&&v!=='ask'&&v!=='deny')throw new Error('Invalid permission action');return v;};
 const rules=raw['rules'];if(rules!==undefined&&!Array.isArray(rules))throw new Error('permissions.rules must be an array');
 return {defaultAction:raw['defaultAction']===undefined?'allow':action(raw['defaultAction']),rules:(rules as YamlValue[]??[]).map(row=>{const rule=asRecord(row,'permission rule');return {permission:asString(rule['permission'],'permission'),pattern:asString(rule['pattern'],'pattern'),action:action(rule['action'])};})};
}
function parseCapabilityProfile(value:YamlValue):NonNullable<MatbotConfig['capabilityProfile']>{if(value==='standard'||value==='minimal'||value==='compatibility')return value;throw new Error('Unknown capabilityProfile');}
