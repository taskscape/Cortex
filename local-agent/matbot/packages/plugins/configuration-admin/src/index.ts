import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolEvent, Store } from '@matatbread/matbot-plugin-api';
import { uiContribution } from './ui.js';
const MASK = '[REDACTED]';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function partsOf(path: string) { const parts = path.split('.'); if (parts.some(p => !p || forbidden.has(p)))
    throw new Error('Invalid secret path'); return parts; }
function at(value: unknown, parts: string[]): unknown { let node: any = value; for (const part of parts) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part))
        return undefined;
    node = node[part];
} return node; }
function put(value: any, parts: string[], replacement: unknown) { let node = value; if (!node || typeof node !== 'object')
    return; for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(node, part) || !node[part] || typeof node[part] !== 'object')
        node[part] = {};
    node = node[part];
} const last = parts.at(-1)!; if (replacement === undefined)
    delete node[last];
else
    node[last] = structuredClone(replacement); }
export function redactConfiguration(value: unknown, paths: readonly string[]) { const copy = structuredClone(value); for (const path of paths) {
    const parts = partsOf(path);
    if (at(copy, parts) !== undefined)
        put(copy, parts, MASK);
} return copy; }
interface Change {
    id: string;
    version: string;
    contributor: string;
    at: string;
    value: unknown;
    sourceVersion: string;
    state: 'pending' | 'applied' | 'failed';
    resultVersion?: string;
}
interface Arguments {
    action: string;
    id?: string;
    value?: unknown;
    expectedVersion?: string;
    historyId?: string;
    cursor?: string;
}
export class ConfigurationAdmin {
    private readonly services: MatbotMachine;
    private readonly history: Store<Change>;
    private queues = new Map<string, Promise<unknown>>();
    constructor(services: MatbotMachine) { this.services = services; this.history = services.createStore<Change>('configuration_history'); }
    private contributor(id: string) { const row = this.services.contributions?.list('configuration').find(row => row.id === id); if (!row || row.signal.aborted)
        throw new Error('Configuration contributor unavailable: ' + id); return row; }
    async execute(args: Arguments, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted();
        if (args.action === 'list')
            return (this.services.contributions?.list('configuration') ?? []).map(({ id, owner, value: c }) => ({ id, owner, title: c.title, scope: c.scope, schema: c.schema, apply: c.apply }));
        if (!args.id)
            throw new Error('Configuration id is required');
        const row = this.contributor(args.id), c = row.value;
        if (args.action === 'get') {
            const snapshot = await c.read();
            row.signal.throwIfAborted();
            return { ...snapshot, value: redactConfiguration(snapshot.value, c.secretPaths), apply: c.apply };
        }
        if (args.action === 'history') {
            const page = await this.history.query({ where: { op: 'eq', field: 'contributor', value: args.id }, sort: [{ field: 'at', dir: 'desc' }], limit: 50, ...(args.cursor ? { cursor: args.cursor } : {}) });
            return { ...page, items: page.items.map(record => ({ ...record, value: redactConfiguration(record.value, c.secretPaths) })) };
        }
        if (args.action !== 'update' && args.action !== 'restore')
            throw new Error('Unknown configuration action');
        if (!args.expectedVersion)
            throw new Error('expectedVersion is required');
        const update = async () => {
            row.signal.throwIfAborted();
            signal?.throwIfAborted();
            const current = await c.read();
            if (current.version !== args.expectedVersion)
                throw new Error('Configuration conflict; reload before editing');
            let value = structuredClone(args.value);
            if (args.action === 'restore') {
                if (!args.historyId)
                    throw new Error('historyId is required');
                const record = await this.history.get(args.historyId);
                if (!record || record.contributor !== args.id || record.state !== 'applied')
                    throw new Error('Applied history entry not found');
                value = record.value;
            }
            // The vault owns secret changes. Updates and historical restore retain today's secrets.
            for (const path of c.secretPaths) {
                const parts = partsOf(path);
                put(value, parts, at(current.value, parts));
            }
            await c.validate(value);
            row.signal.throwIfAborted();
            signal?.throwIfAborted();
            const id = crypto.randomUUID();
            const intent: Change = { id, version: crypto.randomUUID(), contributor: args.id!, at: new Date().toISOString(), value: redactConfiguration(current.value, c.secretPaths), sourceVersion: current.version, state: 'pending' };
            await this.history.set(id, intent);
            let result;
            try {
                row.signal.throwIfAborted();
                signal?.throwIfAborted();
                result = await c.update(value, args.expectedVersion!);
            }
            catch (error) {
                await this.history.set(id, { ...intent, version: crypto.randomUUID(), state: 'failed' });
                throw error;
            }
            let historyPending = false;
            try {
                await this.history.set(id, { ...intent, version: crypto.randomUUID(), state: 'applied', resultVersion: result.version });
            }
            catch {
                historyPending = true;
            }
            return { ...result, value: redactConfiguration(result.value, c.secretPaths), apply: c.apply, ...(historyPending ? { historyPending: true, historyId: id } : {}) };
        };
        const prior = this.queues.get(args.id) ?? Promise.resolve();
        const next = prior.catch(() => { }).then(update);
        this.queues.set(args.id, next);
        try {
            return await next;
        }
        finally {
            if (this.queues.get(args.id) === next)
                this.queues.delete(args.id);
        }
    }
}
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION, async setup(services) {
        if (!services.contributions)
            throw new Error('configuration-admin requires contribution registry');
        const admin = new ConfigurationAdmin(services);
        services.contributions.register('webui', 'configuration', uiContribution);
        services.tools.register({ name: 'configuration_action', description: 'Discover configuration owners, read redacted settings, update with expectedVersion, inspect history or restore a previous value. Secrets use the vault.', serial: true, inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['list', 'get', 'update', 'history', 'restore'] }, id: { type: 'string' }, value: {}, expectedVersion: { type: 'string' }, historyId: { type: 'string' }, cursor: { type: 'string' } } }, executor: { async *execute(input, ctx): AsyncIterable<ToolEvent> { yield { type: 'result', value: await admin.execute(input as Arguments, ctx.signal) }; } } });
    } };
