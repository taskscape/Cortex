import type { ModelParameters, Principal, ProviderConfig } from '@matatbread/matbot-plugin-api';
import { parseYaml, type YamlMap, type YamlValue } from './yaml.js';

export interface MatbotConfig {
  /** Ordered list of plugin specifiers to load at startup (npm names or URL paths) */
  plugins:    readonly string[];
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

function toModelParameters(raw: YamlMap): ModelParameters {
  const params: ModelParameters = {};
  for (const [k, v] of Object.entries(raw)) {
    params[k] = v as ModelParameters[string];
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

      providers.set(providerName, {
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
      providers.set(name, config);
    }
  }

  if (providersRaw !== undefined) {
    const providersMap = asRecord(providersRaw, 'providers');
    for (const [name, raw] of Object.entries(providersMap)) {
      providers.set(name, toProviderConfig(name, asRecord(raw, `providers.${name}`)));
    }
  }

  const prompt           = typeof doc['prompt']            === 'string' ? doc['prompt']            : undefined;
  const ephemeral        = doc['ephemeral'] === true ? true : undefined;
  const defaultProvider  = typeof doc['default_provider'] === 'string' ? doc['default_provider']  : undefined;
  const principal        = toPrincipal(doc['principal']);

  return {
    plugins,
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
