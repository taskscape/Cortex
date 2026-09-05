import type {} from '@matatbread/matbot-plugin-api';
export interface WorkspaceSummary {
    id: string;
    name: string;
    configPath: string;
    createdAt: string;
    updatedAt: string;
    active: boolean;
}
export interface WorkspaceDeleteReadiness {
    canDelete: boolean;
    locked: boolean;
    reason?: string;
    state?: string;
    message?: string;
}
export interface WorkspaceDeletionLease {
    commit?(): Promise<void>;
    release(): void;
}
export interface WorkspaceLifecycleParticipant {
    id: string;
    readiness(workspaceId: string): WorkspaceDeleteReadiness;
    acquireDeletion(workspaceId: string): Promise<WorkspaceDeletionLease>;
}
export interface WorkspaceContext {
    readonly id: string;
    readonly configPath: string;
    readonly registryPath?: string;
}
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
