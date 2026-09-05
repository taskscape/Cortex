import type { KnowledgeEntry } from "@matatbread/matbot-plugin-api";
import { makeKnowledgeEntry } from "./entry.js";
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
    /**
     * @param options Base URL plus optional API key, user id (defaults to "local-agent"),
     *                and workspace id (defaults to "default").
     */
    private readonly options: Mem0ClientOptions;
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
function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}
function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function stringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
    return strings.length > 0 ? strings : undefined;
}
