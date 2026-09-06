import type { KnowledgeEntry, Principal, ToolContext } from '@matatbread/matbot-plugin-api';
/**
 * A versioned snapshot of a configuration value, returned by
 * {@link ConfigurationContributor.read} and {@link ConfigurationContributor.update}.
 * The `version` token enables optimistic concurrency: it must be passed back as
 * `expectedVersion` when updating.
 */
export interface ConfigurationSnapshot {
    version: string;
    value: unknown;
}
/**
 * A contributor exposing one slice of configuration to administrative UIs.
 * Each contributor declares its scope, JSON schema, and where its secret
 * material lives, and implements a read/validate/update lifecycle where the
 * update is guarded by the snapshot version.
 */
export interface ConfigurationContributor {
    title: string;
    scope: 'installation' | 'workspace' | 'plugin';
    schema: unknown;
    secretPaths: readonly string[];
    apply: 'immediate' | 'reload' | 'restart';
    /**
     * Reads the current configuration value with its version token.
     * @returns A snapshot of the current value; `version` is the CAS token for updates.
     * @throws Error - If the contributor cannot reach or decode its backing configuration.
     */
    read(): Promise<ConfigurationSnapshot>;
    /**
     * Validates a candidate configuration value against the contributor's schema and rules.
     * @param value - Candidate value to validate; shape must match the contributor's `schema`.
     * @throws Error - If the value fails validation; the message describes the failure.
     */
    validate(value: unknown): Promise<void>;
    /**
     * Applies a new configuration value using optimistic concurrency.
     * @param value - New value; must pass {@link ConfigurationContributor.validate}.
     * @param expectedVersion - Version token from a previous {@link ConfigurationSnapshot};
     *   the update is rejected if the stored value has changed since.
     * @returns The snapshot written, with a fresh version token.
     * @throws Error - If validation fails or the version check detects a concurrent change.
     */
    update(value: unknown, expectedVersion: string): Promise<ConfigurationSnapshot>;
}
/**
 * The outcome of a single health probe. `degraded` means functioning but with
 * problems; `unavailable` means the capability cannot currently serve requests.
 */
export interface HealthStatus {
    state: 'ready' | 'degraded' | 'unavailable';
    message?: string;
    details?: unknown;
}
/**
 * A contributor that exposes a health probe for some capability, surfaced
 * through status/diagnostics endpoints. Probes may perform network calls or
 * other checks and should honor the abort signal.
 */
export interface HealthContributor {
    /**
     * Runs one health check.
     * @param signal - Abort signal for cancelling a slow probe; aborted probes may reject with an abort error.
     * @returns The current {@link HealthStatus}.
     * @throws Error - If the probe itself fails to execute (distinct from a negative `state`).
     */
    probe(signal: AbortSignal): Promise<HealthStatus>;
    timeoutMs?: number;
}
/**
 * Parameters for one federated retrieval search. Carries the origin principal
 * so each source can apply its own authorization to the query.
 */
export interface RetrievalQuery {
    query: string;
    limit: number;
    workspaceId: string;
    principal: Principal;
    signal: AbortSignal;
}
/**
 * A single search result produced by a {@link RetrievalSource}. Either carries a
 * `citation` (external source) or a full `knowledge` entry, depending on origin.
 */
export interface RetrievalHit {
    id: string;
    content: string;
    sourceId: string;
    workspaceId: string;
    citation?: unknown;
    knowledge?: KnowledgeEntry;
}
/**
 * A participant in retrieval federation: one named, scoped corpus that can be
 * searched. Sources are registered under the `retrieval` contribution kind and
 * are queried in parallel by the {@link RetrievalFederation}.
 */
export interface RetrievalSource {
    title: string;
    scope: 'workspace' | 'host';
    /**
     * Executes a search against this source.
     * @param query - The search parameters, including per-request principal and abort signal.
     * @returns Matching hits, ordered by decreasing relevance; empty if nothing matches.
     * @throws Error - If the source cannot perform the search (its per-source failure is
     *   reported in the {@link RetrievalResult} and does not fail sibling sources).
     */
    search(query: RetrievalQuery): Promise<RetrievalHit[]>;
}
/**
 * Aggregated outcome of one federated search across all registered sources:
 * merged hits plus per-source bookkeeping so callers can tell which sources
 * contributed, failed, or were unavailable. `partial` is true when at least one
 * selected source failed or was unavailable.
 */
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
/**
 * The federated retrieval service: fans a single {@link RetrievalQuery} out to
 * every registered {@link RetrievalSource} in parallel and aggregates the
 * results, isolating per-source failures. Registered under the `RetrievalFederation`
 * service key.
 */
export interface RetrievalFederation {
    /**
     * Executes one federated search.
     * @param query - Search parameters; the same query is passed to every contributing source.
     * @returns Aggregated {@link RetrievalResult}; never rejects due to an individual
     *   source failure (such failures are reflected in `sources`/`partial`).
     * @throws Error - Only if federation itself cannot be performed.
     */
    search(query: RetrievalQuery): Promise<RetrievalResult>;
}
/**
 * Declares a frontend UI contribution: a titled fragment (HTML, optional styles,
 * optional ES module source) mounted into a named slot, optionally gated on the
 * availability of named tools. Also optionally names a side panel and view.
 */
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
/**
 * Declares an HTTP route handled by a plugin: method and path plus a handler
 * that receives the parsed body, the request URL, and the ambient tool context.
 */
export interface HttpRouteContribution {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    /**
     * Handles one HTTP request routed to this contribution.
     * @param request - The request: parsed `body` (unknown), request `url`, and the
     *   caller's `context` ({@link ToolContext} with ambient principal).
     * @returns The response `status` code and a JSON-serializable `body`.
     * @throws Error - If handling fails; the transport turns this into an error response.
     */
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
        /** Optional sink that indexes written knowledge entries (e.g. into a memory backend). */
        readonly MemoryWriteSink?: {
            /**
             * Indexes one knowledge entry into the memory backend.
             * @param entry - The knowledge entry to index.
             * @param signal - Optional abort signal for cancelling a slow remote write.
             * @throws Error - If the backend rejects or fails to index the entry.
             */
            index(entry: KnowledgeEntry, signal?: AbortSignal): Promise<void>;
        };
    }
}
