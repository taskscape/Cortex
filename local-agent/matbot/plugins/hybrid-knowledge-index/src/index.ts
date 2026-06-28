import { LocalFileIndexClient } from "./file-index-client.js";
import { Mem0Client } from "./mem0-client.js";
import { mergeRankAndDeduplicate } from "./ranking.js";
import type { KnowledgeEntry, KnowledgeIndex, MatbotPluginSpec } from "./types.js";

export class HybridKnowledgeIndex implements KnowledgeIndex {
  constructor(
    private readonly mem0: Mem0Client,
    private readonly fileIndex: LocalFileIndexClient
  ) {}

  async index(entry: KnowledgeEntry): Promise<void> {
    await this.mem0.add({
      content: entry.content,
      source: entry.source ?? "matbot",
      kind: entry.kind ?? "knowledge",
      metadata: {
        source: entry.source ?? "matbot",
        kind: entry.kind ?? "knowledge",
        scope: entry.metadata?.scope ?? "global",
        project: entry.metadata?.project,
        path: entry.metadata?.path,
        createdBy: "matbot"
      }
    });
  }

  async search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]> {
    const query = terms
      .map(item => item.context ? `${item.term}: ${item.context}` : item.term)
      .join("\n");

    const [memoryResults, fileResults] = await Promise.allSettled([
      this.mem0.search(query, signal),
      this.fileIndex.search(query, signal)
    ]);

    const entries = [
      ...(memoryResults.status === "fulfilled" ? memoryResults.value : []),
      ...(fileResults.status === "fulfilled" ? fileResults.value : [])
    ];

    return mergeRankAndDeduplicate(entries);
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: "0.1",
  async setup(services) {
    const mem0 = new Mem0Client({
      baseUrl: process.env.MEM0_BASE_URL ?? "http://localhost:8888",
      apiKey: process.env.MEM0_API_KEY,
      userId: process.env.MEM0_USER_ID ?? "local-agent"
    });

    const fileIndex = new LocalFileIndexClient({
      baseUrl: process.env.FILE_INDEX_BASE_URL ?? "http://localhost:8877"
    });

    await services.register("KnowledgeIndex", new HybridKnowledgeIndex(mem0, fileIndex));
  }
};

export default plugin;
