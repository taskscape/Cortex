import type { Contribution, ContributionKinds, ContributionRegistry } from '@matatbread/matbot-plugin-api';
/**
 * Registry of plugin contributions (declarative entries such as HTTP routes), keyed by
 * `kind:id` and attributed to the plugin that registered them.
 *
 * Each entry carries its own {@link AbortController}; removing an entry aborts its signal so
 * consumers (e.g. HTTP route handlers) can stop serving it.
 */
export class PluginContributions {
    private entries = new Map<string, {
        entry: Contribution;
        kind: keyof ContributionKinds;
        abort: AbortController;
    }>();
    /**
     * Create a contribution-registry view scoped to one plugin owner.
     *
     * The returned `register` validates ids, enforces the HTTP-route contract for `http`
     * contributions, and rejects duplicates against every owner; each registration is stamped
     * with `owner` and its own abort signal. The returned `list` is not owner-scoped: it returns
     * matching contributions from all owners in registration order.
     *
     * @param owner - Plugin identity stamped on every contribution registered through the view.
     * @returns A {@link ContributionRegistry} attributing its registrations to `owner`.
     * @throws Never - Validation happens inside the returned `register`.
     */
    forOwner(owner: string): ContributionRegistry {
        return {
            /**
             * Register one contribution for this owner.
             *
             * @typeParam K - The contribution kind being registered.
             * @param kind - Contribution kind; forms the registry key together with `id`.
             * @param id - Contribution id; must match `[a-zA-Z0-9._-]+`.
             * @param value - Kind-specific payload; for `http`, a route with a `method`
             *   (GET/POST/PUT/DELETE) and an `/api/...` `path` without `//`.
             * @returns A disposer that aborts the entry's signal and removes it — but only if it
             *   is still the current registration for its key.
             * @throws Error - On an invalid id, an invalid or duplicate HTTP route, or a
             *   duplicate `kind:id` key (from any owner).
             */
            register: <K extends keyof ContributionKinds>(kind: K, id: string, value: ContributionKinds[K]) => {
                if (!/^[a-zA-Z0-9._-]+$/.test(id))
                    throw new Error('Invalid contribution id');
                if (String(kind) === 'http') {
                    const route = value as {
                        method?: string;
                        path?: string;
                    };
                    if (!route.method || !['GET', 'POST', 'PUT', 'DELETE'].includes(route.method) || !route.path || !/^\/api\/[a-zA-Z0-9/_-]+$/.test(route.path) || route.path.includes('//'))
                        throw new Error('Plugin HTTP routes require a method and an /api/ path');
                    for (const row of this.entries.values()) {
                        if (String(row.kind) !== 'http')
                            continue;
                        const existing = row.entry.value as typeof route;
                        if (existing.method === route.method && existing.path === route.path)
                            throw new Error('Duplicate plugin HTTP route');
                    }
                }
                const key = String(kind) + ':' + id;
                if (this.entries.has(key))
                    throw new Error('Duplicate contribution ' + key);
                const abort = new AbortController();
                const entry = { id, owner, value, signal: abort.signal };
                this.entries.set(key, { entry, kind, abort });
                return () => { const current = this.entries.get(key); if (current?.entry === entry) {
                    abort.abort();
                    this.entries.delete(key);
                } };
            },
            /**
             * List all registered contributions of one kind, across every owner.
             *
             * @typeParam K - The contribution kind to list.
             * @param kind - Contribution kind to filter by.
             * @returns Matching contributions in registration order.
             * @throws Never.
             */
            list: <K extends keyof ContributionKinds>(kind: K) => [...this.entries.values()].filter(row => row.kind === kind).map(row => row.entry as Contribution<K>),
        };
    }
    /**
     * Abort and remove every contribution registered by one owner.
     *
     * @param owner - Plugin whose contributions are removed; other owners are untouched.
     * @returns Nothing.
     * @throws Never.
     */
    removeOwner(owner: string) { for (const [key, row] of this.entries) {
        if (row.entry.owner === owner) {
            row.abort.abort();
            this.entries.delete(key);
        }
    } }
    /**
     * Abort every contribution and empty the registry, regardless of owner.
     *
     * @returns Nothing.
     * @throws Never.
     */
    clear() { for (const row of this.entries.values())
        row.abort.abort(); this.entries.clear(); }
}
