import path from 'node:path';
import { evaluateRealAccess, loadSecurityPolicy, loadWorkspaceConfig } from '@local-agent/paths';
import { ReloadingConfig } from './config-cache.js';
import { listDirectory, readCappedText } from './file-reader.js';
import { openVerified, writeTextFile } from './file-writer.js';
/**
 * HTTP-mapped denial raised by {@link HostFileAccessService}: carries the
 * status code and JSON payload the endpoint should return verbatim.
 */
export class FileAccessError extends Error {
    readonly status: number;
    readonly payload: Record<string, unknown>;
    /**
     * Creates a file-access error.
     *
     * @param status - HTTP status code to respond with (403 for denials, 409
     * for unapproved high-risk writes).
     * @param payload - JSON body to send; its `error` or `reason` field (if
     * present) also becomes the Error message.
     */
    constructor(status: number, payload: Record<string, unknown>) {
        super(String(payload.error ?? payload.reason ?? 'File access denied'));
        this.status = status;
        this.payload = payload;
    }
}
/** Construction parameters for {@link HostFileAccessService}. */
export interface FileAccessOptions {
    /** Path of the `workspaces.json` file, hot-reloaded on change. */
    workspaceConfigPath: string;
    /** Path of the `security-policy.json` file, hot-reloaded on change. */
    securityPolicyPath: string;
    /** Backup directory override; defaults to the policy's `backupRoot`. */
    backupRoot?: string;
}
/** Policy-enforcing host-file service shared by the local plugin and HTTP compatibility host. */
export class HostFileAccessService {
    private readonly workspaces;
    private readonly policy;
    private closed = false;
    private readonly options: FileAccessOptions;
    /**
     * Creates the service.
     *
     * @param options - Config and policy file locations plus optional backup
     * root. Files are read lazily and re-read on change; they must exist by
     * the time the first operation runs.
     */
    constructor(options: FileAccessOptions) {
        this.options = options;
        this.workspaces = new ReloadingConfig(options.workspaceConfigPath, loadWorkspaceConfig);
        this.policy = new ReloadingConfig(options.securityPolicyPath, loadSecurityPolicy);
    }
    private readonly operations = new Set<Promise<unknown>>();
    private readonly lifetime = new AbortController();
    /**
     * Shuts the service down: marks it closed, aborts in-flight operations via
     * the lifetime signal, and waits for all outstanding operation promises to
     * settle. Subsequent operations throw; the promise resolves even if
     * individual operations rejected.
     */
    async close(): Promise<void> { this.closed = true; this.lifetime.abort(); await Promise.allSettled([...this.operations]); }
    /**
     * Runs one operation under lifetime supervision: rejects immediately when
     * closed or the caller signal is already aborted; otherwise combines the
     * caller signal with the lifetime signal and tracks the pending promise so
     * {@link close} can await it.
     *
     * @param run - The operation body, receiving the combined abort signal.
     * @param signal - Optional caller abort signal.
     * @returns Whatever `run` resolves with.
     * @throws Error 'Host file access is unloaded' when closed.
     * @throws AbortError when either signal aborts.
     * @throws Whatever `run` throws.
     */
    private async operation<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> { this.check(signal); const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]); const pending = run(combined); this.operations.add(pending); try {
        return await pending;
    }
    finally {
        this.operations.delete(pending);
    } }
    /** Reports service health: root count and the read limit from current policy. */
    health(signal?: AbortSignal) { return this.operation(s => this.healthOwned(s), signal); }
    /** Lists a directory after policy authorization (`list` action). */
    list(target: string, signal?: AbortSignal) { return this.operation(s => this.listOwned(target, s), signal); }
    /** Reads a file after policy authorization, capped at the policy read limit. */
    read(target: string, signal?: AbortSignal) { return this.operation(s => this.readOwned(target, s), signal); }
    /** Writes a file after policy authorization; high-risk targets require `approved`. */
    write(target: string, content: string, approved: boolean, signal?: AbortSignal) { return this.operation(s => this.writeOwned(target, content, approved, s), signal); }
    /**
     * Guard applied before and during operations: rejects an already-aborted
     * caller signal and refuses work after {@link close}.
     *
     * @param signal - Optional caller abort signal to honour.
     * @throws AbortError when `signal` is aborted.
     * @throws Error 'Host file access is unloaded' when the service is closed.
     */
    private check(signal?: AbortSignal): void {
        signal?.throwIfAborted();
        if (this.closed)
            throw new Error('Host file access is unloaded');
    }
    /**
     * Returns current config/policy state for the health endpoint.
     *
     * @param signal - Combined abort signal from {@link operation}.
     * @returns `{ ok, roots, maxReadBytes }`.
     * @throws Whatever loading the config or policy files throws.
     */
    private async healthOwned(signal?: AbortSignal): Promise<unknown> {
        this.check(signal);
        const [workspaces, policy] = await Promise.all([this.workspaces.get(), this.policy.get()]);
        return { ok: true, roots: workspaces.roots.length, maxReadBytes: policy.maxReadBytes };
    }
    /**
     * Loads the current workspace config and security policy, then evaluates
     * real-path access for the requested operation.
     *
     * @param target - Filesystem path being accessed.
     * @param operation - Which broker action is requested.
     * @param signal - Combined abort signal from {@link operation}.
     * @returns The loaded config, policy, and the {@link AccessDecision}.
     * @throws {@link FileAccessError} 403 when access is denied.
     * @throws Whatever loading the config or policy files throws.
     */
    private async authorize(target: string, operation: 'list' | 'read' | 'write', signal?: AbortSignal) {
        this.check(signal);
        const [workspaces, policy] = await Promise.all([this.workspaces.get(), this.policy.get()]);
        const decision = await evaluateRealAccess(target, operation, workspaces, policy);
        if (!decision.allowed)
            throw new FileAccessError(403, { ...decision });
        this.check(signal);
        return { workspaces, policy, decision };
    }
    /**
     * Authorized directory listing.
     *
     * @param target - Directory to enumerate.
     * @param signal - Combined abort signal from {@link operation}.
     * @returns `{ ok, entries }` with each entry's name, path, type, and size.
     * @throws {@link FileAccessError} when denied; filesystem errors otherwise.
     */
    private async listOwned(target: string, signal?: AbortSignal): Promise<unknown> {
        await this.authorize(target, 'list', signal);
        return { ok: true, entries: await listDirectory(target) };
    }
    /**
     * Authorized file read: verifies the target through {@link openVerified},
     * rejects non-files, and caps the returned content at the policy's
     * `maxReadBytes`.
     *
     * @param target - File to read.
     * @param signal - Combined abort signal from {@link operation}.
     * @returns `{ ok, content, truncated, size }`.
     * @throws {@link FileAccessError} when denied; {@link HttpError} 403 when
     * verification fails; Error when the path is not a file.
     */
    private async readOwned(target: string, signal?: AbortSignal): Promise<unknown> {
        const { workspaces, policy } = await this.authorize(target, 'read', signal);
        const handle = await openVerified(target, workspaces);
        try {
            const stats = await handle.stat();
            if (!stats.isFile())
                throw new Error('Path is not a file.');
            this.check(signal);
            return { ok: true, ...await readCappedText(handle, stats.size, policy.maxReadBytes) };
        }
        finally {
            await handle.close();
        }
    }
    /**
     * Authorized file write: refuses high-risk targets (e.g. `.env`, `.pem`)
     * unless explicitly approved, then delegates to {@link writeTextFile} with
     * backup and diff production.
     *
     * @param target - File to write.
     * @param content - Full replacement text.
     * @param approved - Caller's explicit approval for high-risk writes.
     * @param signal - Combined abort signal from {@link operation}.
     * @returns `{ ok, path, diff, backupPath?, highRisk }`.
     * @throws {@link FileAccessError} 403 when denied, 409 when a high-risk
     * write is not approved; write/backup filesystem errors otherwise.
     */
    private async writeOwned(target: string, content: string, approved: boolean, signal?: AbortSignal): Promise<unknown> {
        const { workspaces, policy, decision } = await this.authorize(target, 'write', signal);
        if (decision.highRisk && !approved)
            throw new FileAccessError(409, { ...decision, error: 'High-risk write requires approved=true.' });
        this.check(signal);
        const backupRoot = path.resolve(this.options.backupRoot ?? policy.backupRoot);
        return { ok: true, ...await writeTextFile(target, content, backupRoot, workspaces), highRisk: decision.highRisk };
    }
}
