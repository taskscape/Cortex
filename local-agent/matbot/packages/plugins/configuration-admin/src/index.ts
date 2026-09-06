import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolEvent, Store } from '@matatbread/matbot-plugin-api';
import { uiContribution } from './ui.js';
const MASK = '[REDACTED]';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
/**
 * Splits a dotted secret path into segments and rejects prototype-polluting segments.
 * @param path - Dotted path such as `"credentials.apiKey"`; each segment must be
 *   non-empty and not one of the forbidden keys (`__proto__`, `prototype`, `constructor`).
 * @returns The path segments, in order.
 * @throws Error - If any segment is empty or forbidden.
 */
function partsOf(path: string) { const parts = path.split('.'); if (parts.some(p => !p || forbidden.has(p)))
    throw new Error('Invalid secret path'); return parts; }
/**
 * Reads the value at a dotted path inside an arbitrary object tree.
 * @param value - Root object to read from; non-objects yield `undefined`.
 * @param parts - Path segments as produced by {@link partsOf}.
 * @returns The value at the path, or `undefined` if any segment is missing or not traversable.
 * @throws Never.
 */
function at(value: unknown, parts: string[]): unknown { let node: any = value; for (const part of parts) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part))
        return undefined;
    node = node[part];
} return node; }
/**
 * Writes `replacement` at a dotted path inside an object tree, in place.
 * Creates intermediate objects as needed. Deleting when `replacement` is
 * `undefined`; otherwise the replacement is deep-cloned so later mutations of
 * the caller's value do not leak into the tree.
 * @param value - Object tree to mutate; left untouched if not an object.
 * @param parts - Path segments as produced by {@link partsOf}.
 * @param replacement - Value to store; `undefined` deletes the key instead.
 * @returns Nothing; mutates `value` in place.
 * @throws Never.
 */
function put(value: any, parts: string[], replacement: unknown) { let node = value; if (!node || typeof node !== 'object')
    return; for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(node, part) || !node[part] || typeof node[part] !== 'object')
        node[part] = {};
    node = node[part];
} const last = parts.at(-1)!; if (replacement === undefined)
    delete node[last];
else
    node[last] = structuredClone(replacement); }
/**
 * Returns a deep clone of a configuration value with all secret paths replaced
 * by a fixed `[REDACTED]` mask. The input value is never mutated.
 * @param value - Configuration value to clone and mask; may be of any shape.
 * @param paths - Dotted secret paths declared by the contributor; entries whose
 *   target is absent are silently skipped.
 * @returns The masked deep clone.
 * @throws Error - If any path is invalid (see {@link partsOf}).
 */
export function redactConfiguration(value: unknown, paths: readonly string[]) { const copy = structuredClone(value); for (const path of paths) {
    const parts = partsOf(path);
    if (at(copy, parts) !== undefined)
        put(copy, parts, MASK);
} return copy; }
/**
 * One recorded configuration change attempt for a contributor, persisted in the
 * plugin's `configuration_history` store. Written as `pending` before the
 * contributor's update runs, then flipped to `applied` or `failed`.
 */
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
/**
 * Arguments for the `configuration_action` tool, dispatched on `action`.
 * Which optional fields are meaningful depends on the action: `get`/`update`/
 * `history`/`restore` require `id`; `update`/`restore` require `expectedVersion`;
 * `restore` additionally requires `historyId`; `history` may carry a `cursor`.
 */
interface Arguments {
    action: string;
    id?: string;
    value?: unknown;
    expectedVersion?: string;
    historyId?: string;
    cursor?: string;
}
/**
 * Tool-side administration of configuration contributors: list contributors,
 * read redacted snapshots, page through change history, and apply updates or
 * restores under optimistic concurrency (compare-and-swap on the contributor's
 * snapshot version). Secret paths are always masked in returned values and
 * retained from the current value on writes — the vault owns secret changes.
 * Updates for one contributor id are serialized through a per-id promise queue.
 */
export class ConfigurationAdmin {
    private readonly services: MatbotMachine;
    private readonly history: Store<Change>;
    private queues = new Map<string, Promise<unknown>>();
    /**
     * Creates the admin facade and opens its history store.
     * @param services - Machine services used to reach the contribution registry
     *   and to create the `configuration_history` store.
     */
    constructor(services: MatbotMachine) { this.services = services; this.history = services.createStore<Change>('configuration_history'); }
    /**
     * Resolves a registered configuration contributor by id.
     * @param id - Contributor id as returned by the `list` action.
     * @returns The registry row for the contributor, including its value and lifecycle signal.
     * @throws Error - If no contributor with that id is registered or its contribution
     *   has already been aborted (unmounted).
     */
    private contributor(id: string) { const row = this.services.contributions?.list('configuration').find(row => row.id === id); if (!row || row.signal.aborted)
        throw new Error('Configuration contributor unavailable: ' + id); return row; }
    /**
     * Executes one configuration action against the registered contributors.
     *
     * `list` returns contributor metadata (no values). `get` returns the current
     * snapshot with secret paths redacted. `history` pages past changes (newest
     * first, up to 50 per page) with values redacted. `update` and `restore`
     * validate and apply a new value via the contributor's compare-and-swap
     * `update`, preserving the contributor's current secrets, and record the
     * attempt in the history store; conflicting concurrent edits are rejected.
     * Mutating actions for the same contributor id are serialized.
     *
     * @param args - Action and its parameters; see {@link Arguments} for which
     *   fields each action requires.
     * @param signal - Optional abort signal for the caller; aborted before and
     *   between phases, and the contributor's own unmount signal is also honored.
     * @returns Action-specific result: contributor metadata for `list`; a
     *   versioned snapshot for `get`; a history page for `history`; the new
     *   snapshot (plus `historyPending`/`historyId` if the history store write
     *   failed) for `update`/`restore`.
     * @throws Error - If the action is unknown, a required argument (`id`,
     *   `expectedVersion`, `historyId`) is missing, the contributor is
     *   unavailable, the version check detects a concurrent change, validation
     *   fails, or the contributor's update rejects.
     * @throws DOMException - If `signal` or the contributor's signal is aborted.
     */
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
        /**
         * Applies one update/restore for the selected contributor, serialized
         * per contributor id by the surrounding queue.
         *
         * Reads the current snapshot and rejects if it no longer matches
         * `args.expectedVersion`; resolves the target value (the submitted
         * `args.value`, or the stored value of an applied history entry for
         * `restore`); retains the contributor's current secrets at the declared
         * secret paths; validates; records a `pending` history intent; runs the
         * contributor's CAS update; then marks the history entry `applied`
         * (recording a `historyPending` flag if that final write fails) or
         * `failed` when the update throws.
         *
         * @returns The contributor's new snapshot with secrets redacted, plus
         *   `historyPending`/`historyId` when the applied-state write could not
         *   be persisted.
         * @throws Error - On version conflict, missing `historyId`, a restore
         *   target that is not an applied entry for this contributor, validation
         *   failure, or a failing contributor update (history marked `failed`).
         * @throws DOMException - If either abort signal fires before or between phases.
         */
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
/**
 * Plugin specification for configuration administration.
 * @returns The matbot plugin specification.
 * @throws Error - If the machine has no contribution registry, since the
 *   plugin needs it to discover configuration contributors and to register its UI.
 */
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION, async setup(services) {
        if (!services.contributions)
            throw new Error('configuration-admin requires contribution registry');
        const admin = new ConfigurationAdmin(services);
        services.contributions.register('webui', 'configuration', uiContribution);
        services.tools.register({ name: 'configuration_action', description: 'Discover configuration owners, read redacted settings, update with expectedVersion, inspect history or restore a previous value. Secrets use the vault.', serial: true, inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['list', 'get', 'update', 'history', 'restore'] }, id: { type: 'string' }, value: {}, expectedVersion: { type: 'string' }, historyId: { type: 'string' }, cursor: { type: 'string' } } }, executor: { async *execute(input, ctx): AsyncIterable<ToolEvent> { yield { type: 'result', value: await admin.execute(input as Arguments, ctx.signal) }; } } });
    } };
