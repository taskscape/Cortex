import type { KnowledgeEntry, Principal, ToolContext } from '@matatbread/matbot-plugin-api';
export interface ConfigurationSnapshot {
    version: string;
    value: unknown;
}
export interface ConfigurationContributor {
    title: string;
    scope: 'installation' | 'workspace' | 'plugin';
    schema: unknown;
    secretPaths: readonly string[];
    apply: 'immediate' | 'reload' | 'restart';
    read(): Promise<ConfigurationSnapshot>;
    validate(value: unknown): Promise<void>;
    update(value: unknown, expectedVersion: string): Promise<ConfigurationSnapshot>;
}
export interface HealthStatus {
    state: 'ready' | 'degraded' | 'unavailable';
    message?: string;
    details?: unknown;
}
export interface HealthContributor {
    probe(signal: AbortSignal): Promise<HealthStatus>;
    timeoutMs?: number;
}
export interface RetrievalQuery {
    query: string;
    limit: number;
    workspaceId: string;
    principal: Principal;
    signal: AbortSignal;
}
export interface RetrievalHit {
    id: string;
    content: string;
    sourceId: string;
    workspaceId: string;
    citation?: unknown;
    knowledge?: KnowledgeEntry;
}
export interface RetrievalSource {
    title: string;
    scope: 'workspace' | 'host';
    search(query: RetrievalQuery): Promise<RetrievalHit[]>;
}
export interface RetrievalResult {
    hits: RetrievalHit[];
    sources: Array<{
        id: string;
        state: 'ready' | 'unavailable';
        count: number;
        error?: string;
    }>;
    partial: boolean;
}
export interface RetrievalFederation {
    search(query: RetrievalQuery): Promise<RetrievalResult>;
}
export interface WebUiContribution {
    panelTitle?: string;
    view?: string;
    fragments?: Array<{
        id: string;
        html: string;
    }>;
    title: string;
    slot: 'architecture' | 'sidebar' | 'composer';
    moduleSource: string;
    html?: string;
    styles?: string;
    requiresTools?: readonly string[];
}
export interface HttpRouteContribution {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handle(request: {
        body: unknown;
        context: ToolContext;
        url: string;
    }): Promise<{
        status: number;
        body: unknown;
    }>;
}
declare module '@matatbread/matbot-plugin-api' {
    interface ContributionKinds {
        configuration: ConfigurationContributor;
        health: HealthContributor;
        retrieval: RetrievalSource;
        webui: WebUiContribution;
        http: HttpRouteContribution;
    }
    interface MatbotServices {
        readonly RetrievalFederation?: RetrievalFederation;
        readonly MemoryWriteSink?: {
            index(entry: KnowledgeEntry, signal?: AbortSignal): Promise<void>;
        };
    }
}
