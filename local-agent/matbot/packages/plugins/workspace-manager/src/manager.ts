import path from 'node:path';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { WorkspaceManager, WorkspaceDeleteReadiness, WorkspaceLifecycleParticipant, WorkspaceDeletionLease } from '@matatbread/matbot-workspace-manager-types';
async function exists(filePath: string): Promise<boolean> { try {
    await access(filePath);
    return true;
}
catch {
    return false;
} }
interface CortexWorkspaceRecord {
    id: string;
    name: string;
    configPath: string;
    createdAt: string;
    updatedAt: string;
}
interface CortexWorkspaceRegistry {
    active: string;
    workspaces: CortexWorkspaceRecord[];
}
interface CortexWorkspaceSummary extends CortexWorkspaceRecord {
    active: boolean;
}
interface CortexWorkspaceManager {
    current(): Promise<CortexWorkspaceSummary>;
    list(): Promise<{
        active: string;
        workspaces: CortexWorkspaceSummary[];
    }>;
    create(name: string): Promise<CortexWorkspaceSummary>;
    rename(id: string, name: string): Promise<CortexWorkspaceSummary>;
    delete(id: string): Promise<{
        id: string;
        deleted: true;
    }>;
    switch(id: string): Promise<{
        active: string;
        restarting: boolean;
    }>;
}
/**
 * Optional lifecycle callbacks invoked during workspace deletion, letting callers
 * (e.g. the local agent) run cleanup or auditing at well-defined points.
 */
export interface WorkspaceDeletionHooks {
    /** Called after staging but before the registry commit; throwing aborts and rolls back. */
    beforeRegistryCommit?(workspaceId: string): void | Promise<void>;
    /** Called with the staged path just before it is purged from disk. */
    beforePurge?(workspaceId: string, stagedPath: string): void | Promise<void>;
}
/**
 * Outcome of a successful workspace deletion, including an audit log of every
 * cleanup step performed (and whether disk purge is still pending).
 */
export interface WorkspaceDeletionResult {
    id: string;
    deleted: true;
    /** Ordered audit messages for each cleanup operation attempted. */
    cleanupLog: string[];
    /** True when the directory purge failed or was interrupted and must be retried. */
    cleanupPending?: true;
    /** Staged path awaiting purge when `cleanupPending` is set. */
    pendingCleanupPath?: string;
}
/** Options for constructing a {@link FileWorkspaceManager}. */
export interface FileWorkspaceManagerOptions {
    /** Lifecycle callbacks invoked during workspace deletion. */
    deletionHooks?: WorkspaceDeletionHooks;
    /** Sink for deletion audit messages; defaults to console.info. */
    deletionLogger?: (message: string) => void;
}
function yamlSingleQuoted(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}
function yamlPath(value: string): string {
    return value.replace(/\\/g, '/');
}
function slugifyWorkspaceName(name: string): string {
    const slug = name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug || `workspace-${Date.now().toString(36)}`;
}
function pathIsInsideOrEqual(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}
function absolutizeLocalConfigSpecifiers(text: string, configDir: string): string {
    return text.replace(/^(\s*(?:-\s+|module:\s+))(['"]?)(\.{1,2}[\\/][^#\r\n'"]+)\2(\s*(?:#.*)?$)/gm, (_whole, prefix: string, _quote: string, spec: string, suffix: string) => {
        const abs = yamlPath(path.resolve(configDir, spec.trim()));
        return `${prefix}${yamlSingleQuoted(abs)}${suffix}`;
    });
}
/**
 * File-backed manager for Cortex workspaces: a JSON registry of named workspace
 * directories (each with its own matbot.yaml/.env) plus create/rename/delete/switch
 * operations. Deletion stages the directory under a `.deleting-` name so a failed
 * registry commit rolls back, and an optional restarter hook re-launches the runtime
 * on switch.
 */
export class FileWorkspaceManager implements WorkspaceManager {
    private readonly participants = new Map<string, WorkspaceLifecycleParticipant>();
    private mutation = Promise.resolve();
    registerParticipant(participant: WorkspaceLifecycleParticipant): () => void {
        if (this.participants.has(participant.id))
            throw new Error('Duplicate workspace participant: ' + participant.id);
        this.participants.set(participant.id, participant);
        return () => { if (this.participants.get(participant.id) === participant)
            this.participants.delete(participant.id); };
    }
    private async mutate<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.mutation;
        let release!: () => void;
        this.mutation = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
    async deleteCheck(id: string): Promise<WorkspaceDeleteReadiness> {
        const registry = await this.load();
        if (!registry.workspaces.some(w => w.id === id))
            return { canDelete: false, locked: false, reason: 'Unknown workspace "' + id + '".' };
        if (registry.active === id)
            return { canDelete: false, locked: false, reason: 'Cannot delete the active workspace. Switch to another workspace first.' };
        if (registry.workspaces.length <= 1)
            return { canDelete: false, locked: false, reason: 'Cannot delete the only workspace.' };
        for (const participant of this.participants.values()) {
            const status = participant.readiness(id);
            if (!status.canDelete)
                return status;
        }
        return { canDelete: true, locked: false };
    }
    async create(name: string): Promise<CortexWorkspaceSummary> { return this.mutate(() => this.createOwned(name)); }
    async rename(id: string, name: string): Promise<CortexWorkspaceSummary> { return this.mutate(() => this.renameOwned(id, name)); }
    async switch(id: string): Promise<{
        active: string;
        restarting: boolean;
    }> { return this.mutate(() => this.switchOwned(id)); }
    async delete(id: string): Promise<WorkspaceDeletionResult> {
        return this.mutate(async () => {
            const readiness = await this.deleteCheck(id);
            if (!readiness.canDelete)
                throw new Error(readiness.reason ?? 'Workspace deletion is blocked');
            const leases: WorkspaceDeletionLease[] = [];
            try {
                for (const participant of this.participants.values())
                    leases.push(await participant.acquireDeletion(id));
                return await this.deleteOwned(id, leases);
            }
            finally {
                for (const lease of leases.reverse())
                    lease.release();
            }
        });
    }
    private restarter: ((id: string) => Promise<void>) | undefined;
    private readonly registryPath: string;
    private readonly rootConfigPath: string;
    private readonly deletionHooks: WorkspaceDeletionHooks;
    private readonly deletionLogger: (message: string) => void;
    /**
     * Create the manager over a workspace registry file.
     * @param registryPath Path to cortex-workspaces.json (created on first use).
     * @param rootConfigPath Path to the root matbot.yaml new workspaces are cloned from.
     * @param options Optional deletion hooks and audit logger.
     */
    constructor(registryPath: string, rootConfigPath: string, options: FileWorkspaceManagerOptions = {}) {
        this.registryPath = registryPath;
        this.rootConfigPath = rootConfigPath;
        this.deletionHooks = options.deletionHooks ?? {};
        this.deletionLogger = options.deletionLogger ?? (message => console.info(message));
    }
    /**
     * Register the restart callback used by {@link switch} to relaunch the runtime
     * after the active workspace changes.
     * @param restarter Async callback receiving the id of the newly activated workspace.
     */
    setRestarter(restarter: (id: string) => Promise<void>): void {
        this.restarter = restarter;
    }
    /**
     * @returns The path of the registry file backing this manager.
     */
    getRegistryPath(): string {
        return this.registryPath;
    }
    /**
     * @returns The currently active workspace summary.
     */
    async current(): Promise<CortexWorkspaceSummary> {
        const registry = await this.load();
        const current = registry.workspaces.find(w => w.id === registry.active) ?? registry.workspaces[0]!;
        return this.summarize(current, current.id === registry.active);
    }
    /**
     * @returns The active workspace id plus a summary of every registered workspace.
     */
    async list(): Promise<{
        active: string;
        workspaces: CortexWorkspaceSummary[];
    }> {
        const registry = await this.load();
        return {
            active: registry.active,
            workspaces: registry.workspaces.map(w => this.summarize(w, w.id === registry.active)),
        };
    }
    /**
     * Create a new workspace: a directory under `workspaces/` containing a copy of the
     * root config (with local specifiers absolutized) and, if present, the root .env.
     * @param name Human-readable workspace name; must be non-empty.
     * @returns The created workspace summary.
     * @exception Error When the name is empty.
     */
    private async createOwned(name: string): Promise<CortexWorkspaceSummary> {
        const cleanName = name.trim();
        if (!cleanName)
            throw new Error('Workspace name is required.');
        const registry = await this.load();
        const existingIds = new Set(registry.workspaces.map(w => w.id));
        const baseId = slugifyWorkspaceName(cleanName);
        let id = baseId;
        let suffix = 2;
        while (existingIds.has(id))
            id = `${baseId}-${suffix++}`;
        const rootDir = path.dirname(this.rootConfigPath);
        const workspaceDir = path.join(rootDir, 'workspaces', id);
        await mkdir(workspaceDir, { recursive: true });
        const sourceConfig = await readFile(this.rootConfigPath, 'utf8');
        const workspaceConfig = absolutizeLocalConfigSpecifiers(sourceConfig, rootDir);
        await writeFile(path.join(workspaceDir, 'matbot.yaml'), workspaceConfig, 'utf8');
        const rootEnv = path.join(rootDir, '.env');
        if (await exists(rootEnv))
            await copyFile(rootEnv, path.join(workspaceDir, '.env'));
        const nowIso = new Date().toISOString();
        const record: CortexWorkspaceRecord = {
            id,
            name: cleanName,
            configPath: yamlPath(path.relative(path.dirname(this.registryPath), path.join(workspaceDir, 'matbot.yaml'))),
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        registry.workspaces.push(record);
        await this.save(registry);
        return this.summarize(record, false);
    }
    /**
     * Rename an existing workspace, updating its `updatedAt` timestamp.
     * @param id Id of the workspace to rename.
     * @param name New human-readable name; must be non-empty.
     * @returns The updated workspace summary.
     * @exception Error When the name is empty or the workspace id is unknown.
     */
    private async renameOwned(id: string, name: string): Promise<CortexWorkspaceSummary> {
        const cleanName = name.trim();
        if (!cleanName)
            throw new Error('Workspace name is required.');
        const registry = await this.load();
        const record = registry.workspaces.find(w => w.id === id);
        if (record === undefined)
            throw new Error(`Unknown workspace "${id}".`);
        record.name = cleanName;
        record.updatedAt = new Date().toISOString();
        await this.save(registry);
        return this.summarize(record, record.id === registry.active);
    }
    /**
     * Delete a workspace: stage its directory under a `.deleting-` name, commit the
     * registry removal (rolling back the rename on failure), then purge the staged
     * directory from disk.
     * @param id Id of the workspace to delete.
     * @returns A deletion result with an audit log; `cleanupPending` is set when the
     *          disk purge could not be completed and must be retried later.
     * @exception Error When the id is unknown, the workspace is active, or it is the only workspace.
     */
    private async deleteOwned(id: string, leases: WorkspaceDeletionLease[]): Promise<WorkspaceDeletionResult> {
        const registry = await this.load();
        const record = registry.workspaces.find(w => w.id === id);
        if (record === undefined)
            throw new Error(`Unknown workspace "${id}".`);
        if (record.id === registry.active) {
            throw new Error('Cannot delete the active workspace. Switch to another workspace first.');
        }
        if (registry.workspaces.length <= 1) {
            throw new Error('Cannot delete the only workspace.');
        }
        const cleanupLog: string[] = [];
        const audit = (operation: string): void => {
            const message = `[workspace-delete] workspace=${id} ${operation}`;
            cleanupLog.push(message);
            this.deletionLogger(message);
        };
        const workspaceDir = this.ownedWorkspaceDirectory(record);
        const stagedPath = workspaceDir !== undefined && await exists(workspaceDir)
            ? `${workspaceDir}.deleting-${crypto.randomUUID()}`
            : undefined;
        if (stagedPath !== undefined && workspaceDir !== undefined) {
            await rename(workspaceDir, stagedPath);
            audit(`staged path=${stagedPath}`);
        }
        else {
            audit('no owned workspace directory to stage');
        }
        try {
            await this.deletionHooks.beforeRegistryCommit?.(id);
            registry.workspaces = registry.workspaces.filter(w => w.id !== id);
            await this.save(registry);
            audit('registry commit complete');
        }
        catch (error) {
            if (stagedPath !== undefined && workspaceDir !== undefined && await exists(stagedPath)) {
                await rename(stagedPath, workspaceDir);
                audit(`rolled back path=${workspaceDir}`);
            }
            audit(`aborted before commit error=${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
        try {
            for (const lease of leases)
                await lease.commit?.();
            if (stagedPath !== undefined) {
                await this.deletionHooks.beforePurge?.(id, stagedPath);
                await rm(stagedPath, { recursive: true, force: true });
                audit(`purged path=${stagedPath}`);
            }
        }
        catch (error) {
            audit(`cleanup pending path=${stagedPath} error=${error instanceof Error ? error.message : String(error)}`);
            return { id, deleted: true, cleanupLog, cleanupPending: true, ...(stagedPath ? { pendingCleanupPath: stagedPath } : {}) };
        }
        return { id, deleted: true, cleanupLog };
    }
    /**
     * Make a workspace active, persisting the registry and invoking the registered
     * restarter (if any) to relaunch the runtime against it.
     * @param id Id of the workspace to activate.
     * @returns The new active id and whether a restart was performed.
     * @exception Error When the id is unknown.
     */
    private async switchOwned(id: string): Promise<{
        active: string;
        restarting: boolean;
    }> {
        const registry = await this.load();
        if (!registry.workspaces.some(w => w.id === id))
            throw new Error(`Unknown workspace "${id}".`);
        registry.active = id;
        await this.save(registry);
        if (this.restarter === undefined)
            return { active: id, restarting: false };
        await this.restarter(id);
        return { active: id, restarting: true };
    }
    /**
     * Pick the config file the process should boot: the workspace named by
     * `CORTEX_WORKSPACE_ID` if valid, otherwise the active (or first) workspace.
     * The selection is persisted as the registry's active entry.
     * @returns Absolute path of the selected workspace's matbot.yaml.
     */
    async selectConfigPath(): Promise<string> {
        const registry = await this.load();
        const requested = process.env['CORTEX_WORKSPACE_ID'];
        const workspace = registry.workspaces.find(w => w.id === requested)
            ?? registry.workspaces.find(w => w.id === registry.active)
            ?? registry.workspaces[0]!;
        registry.active = workspace.id;
        await this.save(registry);
        return path.resolve(path.dirname(this.registryPath), workspace.configPath);
    }
    /**
     * Ensure a root-relative plugin specifier appears in the `plugins:` list of every
     * workspace config, inserting it before `options.before` when given. Non-root
     * workspaces get the specifier absolutized to the root directory.
     * @param rootRelativeSpecifier Root-relative path of the plugin to add.
     * @param options Optional `before` specifier anchoring insertion order in each config.
     */
    async ensurePluginInAllWorkspaces(rootRelativeSpecifier: string, options: {
        before?: string;
    } = {}): Promise<void> {
        const registry = await this.load();
        const rootDir = path.dirname(this.rootConfigPath);
        for (const workspace of registry.workspaces) {
            const configPath = path.resolve(path.dirname(this.registryPath), workspace.configPath);
            if (!(await exists(configPath)))
                continue;
            const specifier = path.resolve(configPath) === path.resolve(this.rootConfigPath)
                ? rootRelativeSpecifier
                : yamlSingleQuoted(yamlPath(path.resolve(rootDir, rootRelativeSpecifier)));
            const beforeSpecifier = options.before === undefined
                ? undefined
                : path.resolve(configPath) === path.resolve(this.rootConfigPath)
                    ? options.before
                    : yamlSingleQuoted(yamlPath(path.resolve(rootDir, options.before)));
            await addPluginToConfigIfMissing(configPath, specifier, beforeSpecifier);
        }
    }
    private summarize(record: CortexWorkspaceRecord, active: boolean): CortexWorkspaceSummary {
        return { ...record, active };
    }
    private ownedWorkspaceDirectory(record: CortexWorkspaceRecord): string | undefined {
        const rootDir = path.dirname(this.rootConfigPath);
        const workspacesDir = path.resolve(rootDir, 'workspaces');
        const expectedWorkspaceDir = path.resolve(workspacesDir, record.id);
        const configPath = path.resolve(path.dirname(this.registryPath), record.configPath);
        const configDir = path.dirname(configPath);
        if (!pathIsInsideOrEqual(expectedWorkspaceDir, workspacesDir))
            return undefined;
        if (!pathIsInsideOrEqual(configDir, expectedWorkspaceDir))
            return undefined;
        return expectedWorkspaceDir;
    }
    private async load(): Promise<CortexWorkspaceRegistry> {
        if (!(await exists(this.registryPath))) {
            const nowIso = new Date().toISOString();
            const registry: CortexWorkspaceRegistry = {
                active: 'default',
                workspaces: [{
                        id: 'default',
                        name: 'Default',
                        configPath: yamlPath(path.relative(path.dirname(this.registryPath), this.rootConfigPath)),
                        createdAt: nowIso,
                        updatedAt: nowIso,
                    }],
            };
            await this.save(registry);
            return registry;
        }
        const registry = JSON.parse(await readFile(this.registryPath, 'utf8')) as CortexWorkspaceRegistry;
        if (!Array.isArray(registry.workspaces) || registry.workspaces.length === 0) {
            throw new Error(`Invalid Cortex workspace registry: ${this.registryPath}`);
        }
        if (!registry.workspaces.some(w => w.id === registry.active))
            registry.active = registry.workspaces[0]!.id;
        return registry;
    }
    private async save(registry: CortexWorkspaceRegistry): Promise<void> {
        await mkdir(path.dirname(this.registryPath), { recursive: true });
        const temporary = this.registryPath + '.' + crypto.randomUUID() + '.tmp';
        try {
            await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', 'utf8');
            await rename(temporary, this.registryPath);
        }
        finally {
            await rm(temporary, { force: true }).catch(() => { });
        }
    }
}
async function addPluginToConfigIfMissing(configPath: string, specifier: string, beforeSpecifier?: string): Promise<void> {
    const text = await readFile(configPath, 'utf8');
    if (text.includes(`- ${specifier}`))
        return;
    let updated: string;
    if (beforeSpecifier !== undefined) {
        const beforeLine = new RegExp(`^([ \\t]*)- ${escapeRegExp(beforeSpecifier)}[ \\t]*$`, 'm');
        const match = beforeLine.exec(text);
        if (match?.index !== undefined) {
            const indent = match[1] ?? '  ';
            updated = text.slice(0, match.index) + `${indent}- ${specifier}\n` + text.slice(match.index);
            await writeFile(configPath, updated, 'utf8');
            return;
        }
    }
    const blockMatch = text.match(/^(plugins:\s*\n(?:[ \t]+-[^\n]*\n)*)/m);
    if (blockMatch) {
        const at = blockMatch.index! + blockMatch[0].length;
        updated = text.slice(0, at) + `  - ${specifier}\n` + text.slice(at);
    }
    else {
        updated = `${text.trimEnd()}\n\nplugins:\n  - ${specifier}\n`;
    }
    await writeFile(configPath, updated, 'utf8');
}
function escapeRegExp(value: string): string {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
