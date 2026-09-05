import { readFile } from 'node:fs/promises';
import { parseConfig } from '@matatbread/matbot-config';
import type { MatbotMachine, ProviderConfig } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-capabilities-types';
import { configurationVersion, mutateConfigurationFile } from './config-file.js';
export function registerModelConfiguration(services: MatbotMachine, live: Map<string, ProviderConfig>) {
    if (!services.configPath)
        return;
    const file = services.configPath;
    const models = (text: string) => Object.fromEntries([...parseConfig(text).providers].map(([name, config]) => [name, config.model]));
    const validate = async (value: unknown) => { if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Models must map provider names to model names'); const entries = Object.entries(value); if (entries.length !== live.size || entries.some(([name, model]) => !live.has(name) || typeof model !== 'string' || !model.trim()))
        throw new Error('Provide one non-empty model name per configured provider. Add or remove providers with the provider tool.'); };
    services.contributions?.register('configuration', 'provider-models', { title: 'Provider models', scope: 'workspace', schema: { type: 'object', additionalProperties: { type: 'string' } }, secretPaths: [], apply: 'immediate', async read() { const text = await readFile(file, 'utf8'); return { version: configurationVersion(text), value: models(text) }; }, validate,
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
