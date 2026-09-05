import path from 'node:path';
import { evaluateRealAccess, loadSecurityPolicy, loadWorkspaceConfig } from '@local-agent/paths';
import { ReloadingConfig } from './config-cache.js';
import { listDirectory, readCappedText } from './file-reader.js';
import { openVerified, writeTextFile } from './file-writer.js';
export class FileAccessError extends Error {
    readonly status: number;
    readonly payload: Record<string, unknown>;
    constructor(status: number, payload: Record<string, unknown>) {
        super(String(payload.error ?? payload.reason ?? 'File access denied'));
        this.status = status;
        this.payload = payload;
    }
}
export interface FileAccessOptions {
    workspaceConfigPath: string;
    securityPolicyPath: string;
    backupRoot?: string;
}
/** Policy-enforcing host-file service shared by the local plugin and HTTP compatibility host. */
export class HostFileAccessService {
    private readonly workspaces;
    private readonly policy;
    private closed = false;
    private readonly options: FileAccessOptions;
    constructor(options: FileAccessOptions) {
        this.options = options;
        this.workspaces = new ReloadingConfig(options.workspaceConfigPath, loadWorkspaceConfig);
        this.policy = new ReloadingConfig(options.securityPolicyPath, loadSecurityPolicy);
    }
    private readonly operations = new Set<Promise<unknown>>();
    private readonly lifetime = new AbortController();
    async close(): Promise<void> { this.closed = true; this.lifetime.abort(); await Promise.allSettled([...this.operations]); }
    private async operation<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> { this.check(signal); const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]); const pending = run(combined); this.operations.add(pending); try {
        return await pending;
    }
    finally {
        this.operations.delete(pending);
    } }
    health(signal?: AbortSignal) { return this.operation(s => this.healthOwned(s), signal); }
    list(target: string, signal?: AbortSignal) { return this.operation(s => this.listOwned(target, s), signal); }
    read(target: string, signal?: AbortSignal) { return this.operation(s => this.readOwned(target, s), signal); }
    write(target: string, content: string, approved: boolean, signal?: AbortSignal) { return this.operation(s => this.writeOwned(target, content, approved, s), signal); }
    private check(signal?: AbortSignal): void {
        signal?.throwIfAborted();
        if (this.closed)
            throw new Error('Host file access is unloaded');
    }
    private async healthOwned(signal?: AbortSignal): Promise<unknown> {
        this.check(signal);
        const [workspaces, policy] = await Promise.all([this.workspaces.get(), this.policy.get()]);
        return { ok: true, roots: workspaces.roots.length, maxReadBytes: policy.maxReadBytes };
    }
    private async authorize(target: string, operation: 'list' | 'read' | 'write', signal?: AbortSignal) {
        this.check(signal);
        const [workspaces, policy] = await Promise.all([this.workspaces.get(), this.policy.get()]);
        const decision = await evaluateRealAccess(target, operation, workspaces, policy);
        if (!decision.allowed)
            throw new FileAccessError(403, { ...decision });
        this.check(signal);
        return { workspaces, policy, decision };
    }
    private async listOwned(target: string, signal?: AbortSignal): Promise<unknown> {
        await this.authorize(target, 'list', signal);
        return { ok: true, entries: await listDirectory(target) };
    }
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
    private async writeOwned(target: string, content: string, approved: boolean, signal?: AbortSignal): Promise<unknown> {
        const { workspaces, policy, decision } = await this.authorize(target, 'write', signal);
        if (decision.highRisk && !approved)
            throw new FileAccessError(409, { ...decision, error: 'High-risk write requires approved=true.' });
        this.check(signal);
        const backupRoot = path.resolve(this.options.backupRoot ?? policy.backupRoot);
        return { ok: true, ...await writeTextFile(target, content, backupRoot, workspaces), highRisk: decision.highRisk };
    }
}
