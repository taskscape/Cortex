import type { PluginSettings } from '@matatbread/matbot-plugin-api';
import type { ConfigurationContributor } from '@matatbread/matbot-capabilities-types';
/**
 * A configuration owner edits only its declared keys in one settings CAS.
 *
 * Builds a {@link ConfigurationContributor} over a plugin's versioned
 * {@link PluginSettings}: reads project the settings object down to the declared
 * keys, updates merge only those keys back into the stored settings under a
 * compare-and-swap on the settings snapshot version. No secret paths are
 * declared and changes apply immediately. Requires a host whose plugin settings
 * support `snapshot`/`replace`.
 *
 * @param settings - The plugin's settings object; must expose versioned
 *   `snapshot` and `replace`, otherwise all reads and writes fail.
 * @param options - Contributor definition: `title` shown in the admin UI,
 *   `keys` the only setting keys this contributor may read or write, `schema`
 *   the JSON schema advertised for the projected value, and `validate` an extra
 *   domain check run after structural validation.
 * @returns A `plugin`-scoped, immediate-apply configuration contributor.
 */
export function settingsContributor(settings: PluginSettings, options: {
    title: string;
    keys: readonly string[];
    schema: unknown;
    validate(value: Record<string, unknown>): void | Promise<void>;
}): ConfigurationContributor {
    /**
     * Reads the current versioned settings snapshot from the host.
     * @returns The settings snapshot with its CAS version token.
     * @throws Error - If the host's plugin settings lack `snapshot`/`replace`.
     */
    const snapshot = async () => { if (!settings.snapshot || !settings.replace)
        throw new Error('Versioned plugin settings are unavailable in this host'); return settings.snapshot(); };
    /**
     * Projects a settings record down to the contributor's declared keys.
     * @param data - Full settings record to project.
     * @returns A new object containing only the declared keys present in `data`.
     * @throws Never.
     */
    const select = (data: Record<string, unknown>) => Object.fromEntries(options.keys.filter(k => Object.hasOwn(data, k)).map(k => [k, data[k]]));
    /**
     * Structurally validates a candidate value, then delegates to the
     * contributor's own domain validation.
     * @param value - Candidate value; must be a non-array object whose keys are
     *   all within the declared `keys`.
     * @throws Error - If `value` is not an object, contains an undeclared key,
     *   or fails the contributor's domain validation.
     */
    const validate = async (value: unknown) => { if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Settings must be an object'); for (const key of Object.keys(value))
        if (!options.keys.includes(key))
            throw new Error('Unknown setting: ' + key); await options.validate(value as Record<string, unknown>); };
    return { title: options.title, scope: 'plugin', schema: options.schema, secretPaths: [], apply: 'immediate', /**
         * Reads the current projected settings value.
         * @returns A snapshot whose `value` contains only the declared keys and
         *   whose `version` is the settings snapshot's CAS token.
         * @throws Error - If versioned plugin settings are unavailable in this host.
         */
        async read() { const row = await snapshot(); return { version: row.version, value: select(row.data) }; }, validate,
        /**
         * Validates and applies a new projected value via a compare-and-swap on
         * the settings snapshot version. Other settings keys outside the
         * declared set are preserved.
         * @param value - New value; must pass {@link validate} and contain only declared keys.
         * @param expectedVersion - CAS token from a previous snapshot; the write
         *   is rejected if the settings changed since.
         * @returns The new snapshot: fresh version token and the projected value.
         * @throws Error - On validation failure, version conflict, or if versioned
         *   plugin settings are unavailable in this host.
         */
        async update(value, expectedVersion) { await validate(value); const current = await snapshot(); if (current.version !== expectedVersion)
            throw new Error('Configuration conflict; reload before editing'); const data = { ...current.data }; for (const key of options.keys)
            delete data[key]; Object.assign(data, value); const next = await settings.replace!(data, expectedVersion); return { version: next.version, value: select(next.data) }; } };
}
/**
 * Validates that provider pin settings name known providers.
 *
 * For each settings key in `keys`, a pin must be `undefined`, `null`, or the
 * name of a provider present in `providers`. Any other value is rejected.
 *
 * @param value - Candidate settings record whose pin fields are checked.
 * @param keys - The settings keys expected to hold provider names.
 * @param providers - Map of known provider names to their registrations; only
 *   its keys are consulted.
 * @throws Error - If any checked key holds a non-string pin or a string naming
 *   a provider not present in `providers`.
 */
export function validateProviderPins(value: Record<string, unknown>, keys: readonly string[], providers: ReadonlyMap<string, unknown>) { for (const key of keys) {
    const pin = value[key];
    if (pin !== undefined && pin !== null && (typeof pin !== 'string' || !providers.has(pin)))
        throw new Error('Unknown provider for ' + key);
} }
