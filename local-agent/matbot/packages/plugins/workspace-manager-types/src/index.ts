import type {} from '@matatbread/matbot-plugin-api';
/**
 * Public view of a registered workspace: identity, config-file location,
 * timestamps, and whether it is the currently active workspace.
 */
export interface WorkspaceSummary {
    id: string;
    name: string;
    configPath: string;
    createdAt: string;
    updatedAt: string;
    active: boolean;
}
/**
 * Verdict on whether a workspace can currently be deleted. When `canDelete` is
 * false, `reason` explains why; `locked`, `state`, and `message` carry optional
 * participant-supplied detail.
 */
export interface WorkspaceDeleteReadiness {
    canDelete: boolean;
    locked: boolean;
    reason?: string;
    state?: string;
    message?: string;
}
/**
 * Handle returned when a participant acquires a workspace for deletion:
 * `commit` finalizes participant-side cleanup after the registry commit, while
 * `release` is always invoked to undo the acquisition.
 */
export interface WorkspaceDeletionLease {
    commit?(): Promise<void>;
    release(): void;
}
/**
 * Extension point consulted before a workspace is deleted: reports deletion
 * readiness and hands out deletion leases, keyed by a stable participant `id`.
 */
export interface WorkspaceLifecycleParticipant {
    id: string;
    readiness(workspaceId: string): WorkspaceDeleteReadiness;
    acquireDeletion(workspaceId: string): Promise<WorkspaceDeletionLease>;
}
/**
 * Immutable identity of the booting workspace: its id, resolved config path,
 * and optional registry-file location.
 */
export interface WorkspaceContext {
    readonly id: string;
    readonly configPath: string;
    readonly registryPath?: string;
}
/**
 * Registry-backed management of named workspaces: query the active workspace,
 * list, create, rename, and delete workspaces, switch the active one, and
 * optionally pre-check deletions and register lifecycle participants.
 */
export interface WorkspaceManager {
    current(): Promise<WorkspaceSummary>;
    list(): Promise<{
        active: string;
        workspaces: WorkspaceSummary[];
    }>;
    create(name: string): Promise<WorkspaceSummary>;
    rename(id: string, name: string): Promise<WorkspaceSummary>;
    delete(id: string): Promise<{
        id: string;
        deleted: true;
        cleanupLog?: string[];
        cleanupPending?: true;
        pendingCleanupPath?: string;
    }>;
    switch(id: string): Promise<{
        active: string;
        restarting: boolean;
    }>;
    deleteCheck?(id: string): Promise<WorkspaceDeleteReadiness>;
    registerParticipant?(participant: WorkspaceLifecycleParticipant): () => void;
}
declare module '@matatbread/matbot-plugin-api' {
    interface MatbotServices {
        readonly WorkspaceManager?: WorkspaceManager;
        readonly WorkspaceContext?: WorkspaceContext;
        readonly WorkspaceBootstrap?: {
            manager: WorkspaceManager;
            context: WorkspaceContext;
        };
    }
}
