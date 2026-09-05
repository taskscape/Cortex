import type { PluginSettings } from '@matatbread/matbot-plugin-api';
import type { ConfigurationContributor } from '@matatbread/matbot-capabilities-types';
/** A configuration owner edits only its declared keys in one settings CAS. */
export function settingsContributor(settings: PluginSettings, options: {
    title: string;
    keys: readonly string[];
    schema: unknown;
    validate(value: Record<string, unknown>): void | Promise<void>;
}): ConfigurationContributor {
    const snapshot = async () => { if (!settings.snapshot || !settings.replace)
        throw new Error('Versioned plugin settings are unavailable in this host'); return settings.snapshot(); };
    const select = (data: Record<string, unknown>) => Object.fromEntries(options.keys.filter(k => Object.hasOwn(data, k)).map(k => [k, data[k]]));
    const validate = async (value: unknown) => { if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Settings must be an object'); for (const key of Object.keys(value))
        if (!options.keys.includes(key))
            throw new Error('Unknown setting: ' + key); await options.validate(value as Record<string, unknown>); };
    return { title: options.title, scope: 'plugin', schema: options.schema, secretPaths: [], apply: 'immediate', async read() { const row = await snapshot(); return { version: row.version, value: select(row.data) }; }, validate,
        async update(value, expectedVersion) { await validate(value); const current = await snapshot(); if (current.version !== expectedVersion)
            throw new Error('Configuration conflict; reload before editing'); const data = { ...current.data }; for (const key of options.keys)
            delete data[key]; Object.assign(data, value); const next = await settings.replace!(data, expectedVersion); return { version: next.version, value: select(next.data) }; } };
}
export function validateProviderPins(value: Record<string, unknown>, keys: readonly string[], providers: ReadonlyMap<string, unknown>) { for (const key of keys) {
    const pin = value[key];
    if (pin !== undefined && pin !== null && (typeof pin !== 'string' || !providers.has(pin)))
        throw new Error('Unknown provider for ' + key);
} }
