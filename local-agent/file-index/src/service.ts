import { evaluateRealAccess, indexExclusions, loadSecurityPolicy, loadWorkspaceConfig } from '@local-agent/paths';
import { resolveIndexRoot } from './index-root.js';
import { indexRoot, summarize } from './indexer.js';
import { searchChunks } from './search.js';
import { loadStore, saveStore } from './store.js';
export interface FileIndexOptions {
    storePath: string;
    workspaceConfigPath: string;
    securityPolicyPath: string;
    maxFileBytes: number;
}
/** Owns one index snapshot, serialized publication, job cancellation and scoped search. */
export class FileIndexService {
    private snapshot;
    private queue: Promise<void> = Promise.resolve();
    private readonly lifetime = new AbortController();
    private readonly jobs = new Map<string, AbortController>();
    private readonly options: FileIndexOptions;
    constructor(options: FileIndexOptions) { this.options = options; this.snapshot = loadStore(options.storePath); }
    async health(): Promise<unknown> {
        this.lifetime.signal.throwIfAborted();
        return { ok: true, storePath: this.options.storePath, ...summarize(await this.snapshot), jobs: [...this.jobs.keys()] };
    }
    cancel(id?: string): {
        cancelled: number;
    } {
        let cancelled = 0;
        for (const [jobId, controller] of this.jobs)
            if (id === undefined || jobId === id) {
                controller.abort();
                cancelled++;
            }
        return { cancelled };
    }
    async close(): Promise<void> { this.lifetime.abort(); this.cancel(); await this.queue; }
    async index(root?: string, signal?: AbortSignal): Promise<unknown> {
        this.lifetime.signal.throwIfAborted();
        const id = crypto.randomUUID();
        const controller = new AbortController();
        const combined = AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
        this.jobs.set(id, controller);
        const run = this.queue.then(async () => {
            combined.throwIfAborted();
            const [config, policy] = await Promise.all([loadWorkspaceConfig(this.options.workspaceConfigPath), loadSecurityPolicy(this.options.securityPolicyPath)]);
            const resolvedRoot = await resolveIndexRoot(root, config);
            const next = await indexRoot({ root: resolvedRoot, indexExcludedPatterns: indexExclusions(config), maxFileBytes: this.options.maxFileBytes, workspaces: config, policy, signal: combined }, await this.snapshot);
            combined.throwIfAborted();
            await saveStore(this.options.storePath, next);
            this.snapshot = Promise.resolve(next);
            return { ok: true, root: resolvedRoot, ...summarize(next) };
        });
        this.queue = run.then(() => { }, () => { });
        try {
            return await run;
        }
        finally {
            this.jobs.delete(id);
        }
    }
    async search(query: string, limit = 10, signal?: AbortSignal): Promise<unknown> {
        this.lifetime.signal.throwIfAborted();
        signal?.throwIfAborted();
        if (!query.trim())
            throw new Error('Search query is required');
        const [snapshot, workspaces, policy] = await Promise.all([this.snapshot, loadWorkspaceConfig(this.options.workspaceConfigPath), loadSecurityPolicy(this.options.securityPolicyPath)]);
        // Re-evaluate current policy before returning persisted chunks, including after policy edits.
        const allowed = new Map<string, boolean>();
        for (const chunk of snapshot.chunks) {
            if (allowed.has(chunk.path))
                continue;
            signal?.throwIfAborted();
            this.lifetime.signal.throwIfAborted();
            const decision = await evaluateRealAccess(chunk.path, 'read', workspaces, policy);
            allowed.set(chunk.path, decision.allowed && !decision.highRisk);
        }
        const chunks = snapshot.chunks.filter(chunk => allowed.get(chunk.path));
        signal?.throwIfAborted();
        this.lifetime.signal.throwIfAborted();
        return { ok: true, results: searchChunks(chunks, query, Math.min(Math.max(1, limit), 50)) };
    }
}
