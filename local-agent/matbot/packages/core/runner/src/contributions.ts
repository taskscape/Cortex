import type { Contribution, ContributionKinds, ContributionRegistry } from '@matatbread/matbot-plugin-api';
export class PluginContributions {
    private entries = new Map<string, {
        entry: Contribution;
        kind: keyof ContributionKinds;
        abort: AbortController;
    }>();
    forOwner(owner: string): ContributionRegistry {
        return {
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
            }, list: <K extends keyof ContributionKinds>(kind: K) => [...this.entries.values()].filter(row => row.kind === kind).map(row => row.entry as Contribution<K>),
        };
    }
    removeOwner(owner: string) { for (const [key, row] of this.entries) {
        if (row.entry.owner === owner) {
            row.abort.abort();
            this.entries.delete(key);
        }
    } }
    clear() { for (const row of this.entries.values())
        row.abort.abort(); this.entries.clear(); }
}
