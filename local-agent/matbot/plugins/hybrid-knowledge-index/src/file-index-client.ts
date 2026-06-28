import type { KnowledgeEntry } from "./types.js";
import { hashText, makeKnowledgeEntry } from "./entry.js";

export interface LocalFileIndexClientOptions {
  baseUrl: string;
}

interface FileSearchResult {
  path: string;
  relativePath?: string;
  score: number;
  snippet: string;
  metadata: Record<string, unknown>;
}

export class LocalFileIndexClient {
  constructor(private readonly options: LocalFileIndexClientOptions) {}

  async search(query: string, signal?: AbortSignal): Promise<KnowledgeEntry[]> {
    const response = await fetch(new URL("/search", this.options.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, limit: 10 }),
      signal
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

function extractEntities(result: FileSearchResult): string[] {
  const entities = [result.relativePath, result.path]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(entities)];
}

function metadataTags(metadata: Record<string, unknown>): string[] {
  const tags = metadata.tags;
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
}
