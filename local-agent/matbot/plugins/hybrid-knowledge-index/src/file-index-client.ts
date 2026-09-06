import type { KnowledgeEntry } from "./types.js";
import { hashText, makeKnowledgeEntry } from "./entry.js";

/** Options for constructing a {@link LocalFileIndexClient}. */
export interface LocalFileIndexClientOptions {
  /** Base URL of the local file-index search service. */
  baseUrl: string;
}

/** One snippet result returned by the file-index search service. */
interface FileSearchResult {
  path: string;
  relativePath?: string;
  score: number;
  snippet: string;
  metadata: Record<string, unknown>;
}

/**
 * Client for the local file-index search service: POSTs queries to /search and maps
 * snippet results into `KnowledgeEntry` shape with deterministic file-index ids.
 */
export class LocalFileIndexClient {
  /**
   * Creates a client pointing at the file-index service.
   * @param options Client options; only `baseUrl` is required.
   */
  constructor(private readonly options: LocalFileIndexClientOptions) {}

  /**
   * Search the file index and map results into knowledge entries.
   * @param query Free-text query.
   * @param signal Optional cancellation signal.
   * @returns Up to 10 entries, one per search result snippet.
   * @throws Error when the service responds with a non-OK status.
   */
  async search(query: string, signal?: AbortSignal): Promise<KnowledgeEntry[]> {
    const response = await fetch(new URL("/search", this.options.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, limit: 10 }),
      ...(signal !== undefined ? { signal } : {})
    });

    if (!response.ok) {
      throw new Error(`File index request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { results?: FileSearchResult[] };
    return (data.results ?? []).map(result => {
      const sourceUuid = hashText(`${result.path}:${result.snippet}`);
      return makeKnowledgeEntry({
        id: `file-index:${sourceUuid}`,
        sourceType: "file-index",
        sourceUuid,
        content: result.snippet,
        summary: result.relativePath ?? result.path,
        entities: extractEntities(result),
        tags: ["file-index", "file-context", ...metadataTags(result.metadata)],
        confidence: result.score
      });
    });
  }
}

/**
 * Build entity strings from a result's paths: `relativePath` then `path`, keeping
 * non-empty strings and deduplicating.
 * @param result Search result to inspect.
 * @returns Unique non-empty path entities, `relativePath` first when present.
 * @throws Never.
 */
function extractEntities(result: FileSearchResult): string[] {
  const entities = [result.relativePath, result.path]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(entities)];
}

/**
 * Extract string tags from a result's metadata.
 * @param metadata Free-form metadata record from the search result.
 * @returns Non-empty string tags; empty when `metadata.tags` is missing or malformed.
 * @throws Never.
 */
function metadataTags(metadata: Record<string, unknown>): string[] {
  const tags = metadata.tags;
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
}
