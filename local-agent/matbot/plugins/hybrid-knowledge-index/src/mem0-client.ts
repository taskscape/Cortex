import type { KnowledgeEntry } from "./types.js";
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
  /**
   * @param options Base URL plus optional API key, user id (defaults to "local-agent"),
   *                and workspace id (defaults to "default").
   */
  constructor(private readonly options: Mem0ClientOptions) {}

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
   * POST to the first candidate endpoint that works: 404 responses fall through to the
   * next path, other non-OK statuses and network errors are captured (a later path may
   * still succeed), and the last error is rethrown once all paths are exhausted.
   * @param paths Candidate endpoint paths, tried in order.
   * @param init Fetch init (method, body, optional signal); content-type and the
   *        bearer token header are added here.
   * @returns The parsed JSON body, or `{}` for a 204 response.
   * @throws Error — the last captured failure when every candidate endpoint fails.
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
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/**
 * Coerce an unknown value into a plain object record.
 * @param value Value to inspect.
 * @returns The value when it is a non-array object, else `{}`.
 * @throws Never.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Narrow an unknown value to a non-empty string.
 * @param value Value to inspect.
 * @returns The string, or undefined when empty or not a string.
 * @throws Never.
 */
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Narrow an unknown value to a finite number.
 * @param value Value to inspect.
 * @returns The number, or undefined when not a finite number.
 * @throws Never.
 */
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrow an unknown value to a non-empty array of non-empty strings.
 * @param value Value to inspect.
 * @returns The filtered strings, or undefined when absent, empty, or malformed.
 * @throws Never.
 */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}
