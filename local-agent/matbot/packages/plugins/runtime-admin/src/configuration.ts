import { readFile } from 'node:fs/promises';
import { parseConfig } from '@matatbread/matbot-config';
import type { MatbotMachine, ProviderConfig } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-capabilities-types';
import { configurationVersion, mutateConfigurationFile } from './config-file.js';
/**
 * Registers the `provider-models` workspace configuration contribution, which lets an administrator
 * edit each configured provider's model directly in `matbot.yaml` and keeps the live provider map
 * in sync with the file afterwards. Writes go through {@link mutateConfigurationFile}, so they are
 * serialized, compare-and-swap guarded, and atomically replaced.
 *
 * @param services - Machine services; `configPath` locates the YAML file and `contributions`
 *   receives the registration. No-op if `configPath` is absent (non-file-backed configuration).
 * @param live - The runtime's mutable provider-name → config map; after each successful update its
 *   entries' `model` fields are rewritten in place to match the saved file.
 * @returns Nothing.
 * @throws Never (registration only; validation and I/O errors surface from the contribution's
 *   `read`/`update` calls).
 */
export function registerModelConfiguration(services: MatbotMachine, live: Map<string, ProviderConfig>) {
    if (!services.configPath)
        return;
    const file = services.configPath;
    /**
     * Extracts the current provider name → model mapping from configuration text.
     * @param text - Full `matbot.yaml` contents.
     * @returns Plain object with one `model` string per configured provider, in file order.
     * @throws Error - If `text` is not parseable configuration.
     */
    const models = (text: string) => Object.fromEntries([...parseConfig(text).providers].map(([name, config]) => [name, config.model]));
    /**
     * Checks that a proposed models mapping covers exactly the live providers with non-empty names.
     * @param value - Candidate mapping as submitted by the UI; must be a plain object whose keys
     *   match `live` one-for-one and whose values are non-blank strings.
     * @throws Error - If the value is not a plain object, its provider set differs from the live
     *   map, or any model name is missing or blank.
     */
    const validate = async (value: unknown) => { if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Models must map provider names to model names'); const entries = Object.entries(value); if (entries.length !== live.size || entries.some(([name, model]) => !live.has(name) || typeof model !== 'string' || !model.trim()))
        throw new Error('Provide one non-empty model name per configured provider. Add or remove providers with the provider tool.'); };
    services.contributions?.register('configuration', 'provider-models', { title: 'Provider models', scope: 'workspace', schema: { type: 'object', additionalProperties: { type: 'string' } }, secretPaths: [], apply: 'immediate',
        /**
         * Reads the current provider models from disk for display in the configuration UI.
         * @returns `{ version, value }` where `version` is the file's {@link configurationVersion}
         *   token (pass it back to `update`) and `value` maps each provider name to its model.
         * @throws Error - If the file cannot be read or its YAML fails to parse.
         */
        async read() { const text = await readFile(file, 'utf8'); return { version: configurationVersion(text), value: models(text) }; }, validate,
        /**
         * Validates and persists a new provider-models mapping, rewriting only the `model:` lines
         * under the `providers:` block of the YAML (all other formatting is preserved; CRLF is
         * normalized to LF). The result is re-parsed before commit, and the live provider map is
         * updated in place afterwards so the runtime matches the saved file.
         *
         * @param value - Proposed provider name → model mapping; must pass `validate`.
         * @param expectedVersion - Version token from a prior `read`; `undefined` skips the
         *   optimistic-concurrency check.
         * @returns `{ version, value }` reflecting the post-write state: the new file version token
         *   and the models as re-read from the updated text.
         * @throws Error - If `value` fails validation, `expectedVersion` does not match the file's
         *   current version, the file changed outside this runtime, a provider's `model:` line
         *   cannot be located in the YAML, or the rewritten text fails to parse.
         */
        async update(value, expectedVersion) {
            await validate(value);
            const next = await mutateConfigurationFile(file, text => {
                const normalized = text.replace(/\r\n/g, '\n');
                const lines = normalized.split('\n');
                let inside = false, current: string | undefined;
                const changed = new Set<string>();
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i]!;
                    if (/^providers:\s*$/.test(line)) {
                        inside = true;
                        continue;
                    }
                    if (inside && /^\S/.test(line) && !line.startsWith('#'))
                        inside = false;
                    if (!inside)
                        continue;
                    const match = /^  ([^:]+):\s*$/.exec(line);
                    if (match)
                        current = match[1]!.trim();
                    if (current && /^    model:/.test(line) && Object.hasOwn(value as object, current)) {
                        lines[i] = '    model: ' + JSON.stringify((value as Record<string, string>)[current]);
                        changed.add(current);
                    }
                }
                if (changed.size !== Object.keys(value as object).length)
                    throw new Error('Cannot locate every provider model in this configuration');
                const updated = lines.join('\n');
                parseConfig(updated);
                return { text: updated, value: { version: configurationVersion(updated), value: models(updated) } };
            }, expectedVersion);
            for (const [name, model] of Object.entries(next.value))
                live.set(name, { ...live.get(name)!, model });
            return next;
        } });
}
