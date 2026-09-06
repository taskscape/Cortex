import { evaluateRealAccess, indexExclusions, loadSecurityPolicy, loadWorkspaceConfig } from '@local-agent/paths';
import { resolveIndexRoot } from './index-root.js';
import { indexRoot, summarize } from './indexer.js';
import { searchChunks } from './search.js';
import { loadStore, saveStore } from './store.js';
/** Construction parameters for {@link FileIndexService}. */
export interface FileIndexOptions {
    /** Path of the persisted index store JSON. */
    storePath: string;
    /** Path of the `workspaces.json` file, reloaded per operation. */
    workspaceConfigPath: string;
    /** Path of the `security-policy.json` file, reloaded per operation. */
    securityPolicyPath: string;
    /** Maximum file size in bytes eligible for indexing. */
    maxFileBytes: number;
}
/** Owns one index snapshot, serialized publication, job cancellation and scoped search. */
export class FileIndexService {
    private snapshot;
    private queue: Promise<void> = Promise.resolve();
    private readonly lifetime = new AbortController();
    private readonly jobs = new Map<string, AbortController>();
    private readonly options: FileIndexOptions;
    /**
     * Creates the service, loading the persisted store synchronously.
     *
     * @param options - Store location and the config/policy file paths used to
     * re-authorize every operation against current settings.
     */
    constructor(options: FileIndexOptions) { this.options = options; this.snapshot = loadStore(options.storePath); }
    /**
     * Reports service health: store path, index summary, and active job ids.
     *
     * @returns `{ ok, storePath, ...summary, jobs }`.
     * @throws AbortError when the service has been closed.
     */
    async health(): Promise<unknown> {
        this.lifetime.signal.throwIfAborted();
        return { ok: true, storePath: this.options.storePath, ...summarize(await this.snapshot), jobs: [...this.jobs.keys()] };
    }
    /**
     * Aborts running indexing jobs. Jobs are only checked at yield points, so
     * a cancel takes effect at the next abort check.
     *
     * @param id - Specific job id to cancel, or undefined to cancel all.
     * @returns How many jobs were aborted.
     */
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
    /**
     * Shuts the service down: aborts the lifetime signal, cancels all jobs,
     * and waits for the serialized job queue to drain. Subsequent operations
     * throw via the aborted lifetime signal.
     */
    async close(): Promise<void> { this.lifetime.abort(); this.cancel(); await this.queue; }
    /**
     * Runs one indexing pass over a requested root, serialized behind any
     * prior run via the internal queue. Combines the lifetime signal, a
     * per-job controller (see {@link cancel}), and the caller signal; reloads
     * workspace config and security policy fresh, resolves and authorizes the
     * root, indexes, and atomically publishes the new store to disk.
     *
     * @param root - Requested root path, or undefined for the first configured
     * root.
     * @param signal - Optional caller abort signal.
     * @returns `{ ok, root, ...summary }` for the published store.
     * @throws AbortError when any combined signal aborts (mid-run aborts leave
     * the persisted store untouched).
     * @throws {@link HttpError} from root authorization.
     * @throws Whatever indexing or saving the store throws.
     */
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
    /**
     * Searches the current snapshot after re-evaluating current policy for
     * every indexed file, so chunks whose file has become denied or high-risk
     * since indexing are withheld. Per-file decisions are cached per call.
     *
     * @param query - Free-text query; must contain non-whitespace.
     * @param limit - Requested result count; clamped to 1..50 (default 10).
     * @param signal - Optional caller abort signal.
     * @returns `{ ok, results }` sorted by descending score.
     * @throws Error when the query is blank.
     * @throws AbortError when the service is closed or a signal aborts.
     */
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
