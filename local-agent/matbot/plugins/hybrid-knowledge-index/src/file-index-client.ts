import type { KnowledgeEntry } from "./types.js";

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
    return (data.results ?? []).map(result => ({
      content: result.snippet,
      source: "file-index",
      kind: "file-context",
      metadata: {
        path: result.path,
        relativePath: result.relativePath,
        score: result.score,
        ...result.metadata
      }
    }));
  }
}
