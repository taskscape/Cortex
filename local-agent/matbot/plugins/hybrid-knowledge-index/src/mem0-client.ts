import type { KnowledgeEntry } from "./types.js";

export interface Mem0ClientOptions {
  baseUrl: string;
  apiKey?: string;
  userId?: string;
}

export class Mem0Client {
  constructor(private readonly options: Mem0ClientOptions) {}

  async add(entry: KnowledgeEntry, signal?: AbortSignal): Promise<void> {
    const payload = {
      messages: [{ role: "user", content: entry.content }],
      user_id: this.options.userId ?? "local-agent",
      metadata: entry.metadata ?? {}
    };

    await this.request(["/memories", "/v1/memories"], {
      method: "POST",
      body: JSON.stringify(payload),
      signal
    });
  }

  async search(query: string, signal?: AbortSignal): Promise<KnowledgeEntry[]> {
    const payload = {
      query,
      user_id: this.options.userId ?? "local-agent",
      limit: 10
    };

    const data = await this.request(["/search", "/v1/memories/search"], {
      method: "POST",
      body: JSON.stringify(payload),
      signal
    });

    const rows = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : [];
    return rows.map((item: Record<string, unknown>) => ({
      content: String(item.memory ?? item.text ?? item.content ?? ""),
      source: "mem0",
      kind: "memory",
      metadata: {
        score: item.score,
        id: item.id
      }
    })).filter(entry => entry.content.length > 0);
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
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
