import type { KnowledgeEntry } from "@matatbread/matbot-plugin-api";
import { makeKnowledgeEntry } from "./entry.js";
/** Options for constructing a {@link Mem0Client}. */
export interface Mem0ClientOptions {
    baseUrl: string;
    apiKey?: string;
    userId?: string;
    workspaceId?: string;
}
/** Options for constructing a {@link Mem0Client}. */
export interface Mem0ClientOptions {
    baseUrl: string;
    apiKey?: string;
    userId?: string;
    workspaceId?: string;
}
/**
 * Client for a Mem0 memory service: adds knowledge entries as memories and searches
 * them, mapping responses back into `KnowledgeEntry` shape. Endpoint paths are tried
 * against both legacy and versioned API routes.
 */
export class Mem0Client {
    private readonly options: Mem0ClientOptions;
    /**
     * @param options Base URL plus optional API key, user id (defaults to "local-agent"),
     *                and workspace id (defaults to "default").
     */
    constructor(options: Mem0ClientOptions) { this.options = options; }
    /**
     * Add an entry to the memory store as a user message with full entry metadata.
     * @param entry The knowledge entry to persist.
     * @param signal Optional cancellation signal.
     * @returns Resolves when the memory is stored.
     * @throws Error when all candidate endpoints fail or return a non-OK status.
     */
    async add(entry: KnowledgeEntry, signal?: AbortSignal): Promise<void> {
        const payload = {
            messages: [{ role: "user", content: entry.content }],
            user_id: this.options.userId ?? "local-agent",
            metadata: {
                id: entry.id,
                version: entry.version,
                entities: entry.entities,
                tags: entry.tags,
                summary: entry.summary,
                source: entry.source,
                contentHash: entry.contentHash,
                confidence: entry.confidence,
                workspaceId: this.options.workspaceId ?? "default",
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt
            }
        };
        await this.request(["/memories", "/v1/memories"], {
            method: "POST",
            body: JSON.stringify(payload),
            ...(signal !== undefined ? { signal } : {})
        });
    }
    /**
     * Search the memory store and map results into knowledge entries, dropping rows
     * with empty content.
     * @param query Free-text query.
     * @param signal Optional cancellation signal.
     * @returns Up to 10 mapped entries (score used as confidence when present).
     * @throws Error when all candidate endpoints fail or return a non-OK status.
     */
    async search(query: string, signal?: AbortSignal): Promise<KnowledgeEntry[]> {
        const payload = {
            query,
            user_id: this.options.userId ?? "local-agent",
            limit: 10
        };
        const data = await this.request(["/search", "/v1/memories/search"], {
            method: "POST",
            body: JSON.stringify(payload),
            ...(signal !== undefined ? { signal } : {})
        });
        const rows = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : [];
        return rows.map((item: Record<string, unknown>) => {
            const content = String(item.memory ?? item.text ?? item.content ?? "");
            const metadata = asRecord(item.metadata);
            const source = asRecord(metadata.source);
            const sourceUuid = stringValue(source.uuid) ?? stringValue(item.id) ?? undefined;
            return makeKnowledgeEntry({
                id: stringValue(metadata.id) ?? (sourceUuid ? `mem0:${sourceUuid}` : undefined),
                sourceType: stringValue(source.type) ?? "mem0",
                sourceUuid,
                content,
                summary: stringValue(metadata.summary),
                entities: stringArray(metadata.entities),
                tags: stringArray(metadata.tags) ?? ["mem0", "memory"],
                confidence: numberValue(item.score) ?? numberValue(metadata.confidence),
                createdAt: stringValue(metadata.createdAt),
                updatedAt: stringValue(metadata.updatedAt)
            });
        }).filter(entry => entry.content.length > 0);
    }
    /**
     * Performs an HTTP request against the Mem0 backend, trying each candidate
     * path in order. A 404 advances to the next candidate; any other non-OK
     * status throws immediately. A 204 resolves to an empty object; other
     * success statuses resolve to the parsed JSON body. The caller's abort
     * signal short-circuits remaining candidates.
     *
     * @param paths - Candidate endpoint paths resolved against the base URL,
     *   tried in order.
     * @param init - Fetch init (method, body, optional abort signal); an
     *   `authorization` header is added when an API key is configured.
     * @returns The parsed JSON response body (object or array), or `{}` for 204.
     * @throws Error - The last candidate's failure: 404 "endpoint not found"
     *   errors, non-OK status errors, network failures, or JSON parse errors.
     */
    private async request(paths: string[], init: RequestInit): Promise<Record<string, unknown> | unknown[]> {
        let lastError: unknown;
        for (const requestPath of paths) {
            try {
                const response = await fetch(new URL(requestPath, this.options.baseUrl), {
                    ...init,
                    headers: {
                        "content-type": "application/json",
                        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
                    }
                });
                if (response.status === 404) {
                    lastError = new Error(`Mem0 endpoint not found: ${requestPath}`);
                    continue;
                }
                if (!response.ok) {
                    throw new Error(`Mem0 request failed: ${response.status} ${response.statusText}`);
                }
                if (response.status === 204) {
                    return {};
                }
                return await response.json() as Record<string, unknown> | unknown[];
            }
            catch (error) {
                init.signal?.throwIfAborted();
                lastError = error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
}
/**
 * Coerces an unknown value to a plain record, treating anything else as empty.
 * @param value - Value to coerce.
 * @returns `value` when it is a non-array object, otherwise `{}`.
 * @throws Never.
 */
function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}
/**
 * Extracts a non-empty string from an unknown value.
 * @param value - Value to extract from.
 * @returns The string, or `undefined` when it is not a non-empty string.
 * @throws Never.
 */
function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
/**
 * Extracts a finite number from an unknown value.
 * @param value - Value to extract from.
 * @returns The number, or `undefined` when it is not a finite number.
 * @throws Never.
 */
function numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/**
 * Extracts a non-empty string array from an unknown value.
 * @param value - Value to extract from.
 * @returns The filtered strings, or `undefined` when the value is not an array
 *   or contains no non-empty strings.
 * @throws Never.
 */
function stringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
    return strings.length > 0 ? strings : undefined;
}
