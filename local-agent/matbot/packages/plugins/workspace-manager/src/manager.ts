import path from 'node:path';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { WorkspaceManager, WorkspaceDeleteReadiness, WorkspaceLifecycleParticipant, WorkspaceDeletionLease } from '@matatbread/matbot-workspace-manager-types';
/**
 * Checks whether a path exists and is accessible.
 *
 * @param filePath Path to test.
 * @returns True when `access` succeeds, false on any failure.
 */
async function exists(filePath: string): Promise<boolean> { try {
    await access(filePath);
    return true;
}
catch {
    return false;
} }
/**
 * One registry entry: a named workspace directory with its config location and timestamps.
 */
interface CortexWorkspaceRecord {
    id: string;
    name: string;
    configPath: string;
    createdAt: string;
    updatedAt: string;
}
/**
 * On-disk shape of `cortex-workspaces.json`: the active workspace id plus its records.
 */
interface CortexWorkspaceRegistry {
    active: string;
    workspaces: CortexWorkspaceRecord[];
}
/**
 * A {@link CortexWorkspaceRecord} annotated with whether it is the active workspace.
 */
interface CortexWorkspaceSummary extends CortexWorkspaceRecord {
    active: boolean;
}
/**
 * Internal subset of the public {@link WorkspaceManager} contract, typed against
 * the manager's own summary/record shapes.
 */
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
/**
 * Renders a value as a YAML single-quoted scalar, doubling embedded single quotes.
 *
 * @param value Value to quote.
 * @returns The YAML-safe single-quoted string.
 */
function yamlSingleQuoted(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}
/**
 * Normalizes a path for YAML output by replacing backslashes with forward slashes.
 *
 * @param value Path to normalize.
 * @returns The forward-slashed path string.
 */
function yamlPath(value: string): string {
    return value.replace(/\\/g, '/');
}
/**
 * Derives a directory-safe workspace id from a human-readable name.
 *
 * Lower-cases, collapses non-alphanumeric runs to `-`, trims edge dashes, and
 * caps at 48 characters; falls back to a timestamp-based id when the result is empty.
 *
 * @param name Human-readable workspace name.
 * @returns The slug used as the workspace id (made unique by callers).
 */
function slugifyWorkspaceName(name: string): string {
    const slug = name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug || `workspace-${Date.now().toString(36)}`;
}
/**
 * Path-containment check: true when `child` equals `parent` or lies beneath it,
 * using `path.relative` so sibling prefixes are rejected.
 *
 * @param child Candidate descendant path.
 * @param parent Candidate ancestor path.
 * @returns True when `child` is `parent` or inside it.
 */
function pathIsInsideOrEqual(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}
/**
 * Rewrites root-relative plugin specifiers in a config text to absolute paths so
 * cloned workspace configs keep resolving plugins against the root directory.
 * Matches bare list entries (`- ./x`) and `module:` values that start with `./`
 * or `../`; comments and line suffixes are preserved.
 *
 * @param text Config file contents.
 * @param configDir Directory the config's relative specifiers resolve against.
 * @returns The rewritten config text.
 */
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
    /**
     * Registers a deletion-lifecycle participant under its unique id.
     *
     * @param participant Participant whose `readiness` and `acquireDeletion` are
     *   consulted by {@link deleteCheck} and {@link delete}.
     * @returns An unsubscribe function that removes the participant if it is still the one registered under its id.
     * @throws Error - When a participant with the same id is already registered.
     */
    registerParticipant(participant: WorkspaceLifecycleParticipant): () => void {
        if (this.participants.has(participant.id))
            throw new Error('Duplicate workspace participant: ' + participant.id);
        this.participants.set(participant.id, participant);
        return () => { if (this.participants.get(participant.id) === participant)
            this.participants.delete(participant.id); };
    }
    /**
     * Serializes all mutating registry operations through a single promise chain,
     * so only one create/rename/delete/switch runs at a time on this manager.
     *
     * @typeParam T - Result type of the serialized operation.
     * @param operation Async work to run while holding the mutation chain.
     * @returns The result of `operation`.
     * @throws `Error` - Whatever `operation` throws; the chain always advances.
     */
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
    /**
     * Reports whether a workspace can currently be deleted, without mutating
     * anything. Blocks unknown ids, the active workspace, the last remaining
     * workspace, and any participant that reports it is not ready.
     *
     * @param id Id of the workspace to check.
     * @returns The first blocking participant's readiness verdict, or a synthesized one.
     * @throws Error - If the workspace registry cannot be loaded.
     */
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
    /**
     * Creates a workspace; see {@link FileWorkspaceManager.createOwned}.
     *
     * @param name Human-readable workspace name; must be non-empty.
     * @returns The created workspace summary.
     * @throws Error - As thrown by {@link FileWorkspaceManager.createOwned}.
     */
    async create(name: string): Promise<CortexWorkspaceSummary> { return this.mutate(() => this.createOwned(name)); }
    /**
     * Renames a workspace; see {@link FileWorkspaceManager.renameOwned}.
     *
     * @param id Id of the workspace to rename.
     * @param name New human-readable name; must be non-empty.
     * @returns The updated workspace summary.
     * @throws Error - As thrown by {@link FileWorkspaceManager.renameOwned}.
     */
    async rename(id: string, name: string): Promise<CortexWorkspaceSummary> { return this.mutate(() => this.renameOwned(id, name)); }
    /**
     * Activates a workspace; see {@link FileWorkspaceManager.switchOwned}.
     *
     * @param id Id of the workspace to activate.
     * @returns The new active id and whether a restart was performed.
     * @throws Error - As thrown by {@link FileWorkspaceManager.switchOwned}.
     */
    async switch(id: string): Promise<{
        active: string;
        restarting: boolean;
    }> { return this.mutate(() => this.switchOwned(id)); }
    /**
     * Deletes a workspace after checking readiness and acquiring every
     * participant's deletion lease. Leases are released (in reverse acquisition
     * order) whether or not the deletion succeeds; committed leases only take
     * effect once the registry commit has succeeded.
     *
     * @param id Id of the workspace to delete.
     * @returns The deletion result with its audit log.
     * @throws Error - With the blocking `reason` when {@link deleteCheck} reports the workspace cannot be deleted, or as thrown by the underlying deletion.
     */
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
     *
     * @param restarter Async callback receiving the id of the newly activated workspace.
     * @returns Nothing.
     * @throws Never.
     */
    setRestarter(restarter: (id: string) => Promise<void>): void {
        this.restarter = restarter;
    }
    /**
     * Reports the registry file backing this manager.
     *
     * @returns The path of the registry file (`cortex-workspaces.json`).
     * @throws Never.
     */
    getRegistryPath(): string {
        return this.registryPath;
    }
    /**
     * Summarizes the currently active workspace, falling back to the first
     * registry entry when the active id has no record.
     *
     * @returns The currently active workspace summary.
     * @throws Error - If the workspace registry cannot be loaded.
     */
    async current(): Promise<CortexWorkspaceSummary> {
        const registry = await this.load();
        const current = registry.workspaces.find(w => w.id === registry.active) ?? registry.workspaces[0]!;
        return this.summarize(current, current.id === registry.active);
    }
    /**
     * Lists every registered workspace in registry order.
     *
     * @returns The active workspace id plus a summary of every registered workspace.
     * @throws Error - If the workspace registry cannot be loaded.
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
        /**
         * Appends an audit message to the result log and forwards it to the
         * configured deletion logger.
         *
         * @param operation Short description of the audit step performed.
         * @returns Nothing.
         */
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
     * Picks the boot config, preferring the workspace named by the
     * `CORTEX_WORKSPACE_ID` environment variable when it exists, then the
     * registry's active entry, then the first entry. The selection is persisted
     * as the registry's active entry.
     *
     * @returns Absolute path of the selected workspace's matbot.yaml.
     * @throws Error - If the registry cannot be loaded or saved.
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
     * workspaces get the specifier absolutized to the root directory. Workspaces
     * whose config file is missing are skipped.
     *
     * @param rootRelativeSpecifier Root-relative path of the plugin to add.
     * @param options Optional `before` specifier anchoring insertion order in each config.
     * @returns Nothing.
     * @throws Error - If the registry cannot be loaded or a workspace config cannot be read or written.
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
    /**
     * Copies a registry record and stamps it with the active flag.
     *
     * @param record Registry entry to project.
     * @param active Whether the entry is the active workspace.
     * @returns The record's summary form.
     */
    private summarize(record: CortexWorkspaceRecord, active: boolean): CortexWorkspaceSummary {
        return { ...record, active };
    }
    /**
     * Derives the workspace directory this record owns, trusting the record only
     * when the id-derived directory lies under `workspaces/` and the record's
     * config directory lies inside it; otherwise deletion staging is refused.
     *
     * @param record Registry entry to locate on disk.
     * @returns The expected workspace directory, or `undefined` when the record is not trusted.
     */
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
    /**
     * Loads the workspace registry, creating a default single-workspace registry
     * file on first use and repairing a dangling active id by falling back to
     * the first entry.
     *
     * @returns The parsed registry.
     * @throws SyntaxError - If the registry file contains invalid JSON.
     * @throws Error - If the registry file is unreadable or structurally invalid (no workspaces), or the freshly created registry cannot be saved.
     */
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
    /**
     * Persists the registry atomically: writes a unique temp sibling, renames it
     * over the registry file, and always removes the temp file afterwards.
     *
     * @param registry Registry state to write.
     * @returns Nothing.
     * @throws Error - If the registry directory cannot be created or the write/rename fails.
     */
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
/**
 * Inserts a plugin specifier into a config's `plugins:` list unless already
 * present, trying in order: directly above the `beforeSpecifier` entry (keeping
 * its indentation), inside the existing `plugins:` block, or as a new block
 * appended to the file.
 *
 * @param configPath Path of the workspace config to edit in place.
 * @param specifier Plugin specifier to insert (already quoted/absolutized when needed).
 * @param beforeSpecifier Optional specifier anchoring the insertion point.
 * @returns Nothing.
 * @throws Error - If the config cannot be read or written.
 */
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
/**
 * Escapes regular-expression metacharacters in a string.
 *
 * @param value Text to escape.
 * @returns A string safe to embed in a `RegExp` as a literal.
 */
function escapeRegExp(value: string): string {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
