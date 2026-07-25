import { LocalFileIndexClient } from "./file-index-client.js";
import { Mem0Client } from "./mem0-client.js";
import { mergeRankAndDeduplicate } from "./ranking.js";
import type { KnowledgeEntry, KnowledgeIndex, MatbotPluginSpec } from "./types.js";
import path from "node:path";

export function workspaceIdFromConfigPath(configPath: string | undefined): string {
  if (!configPath) return "default";
  const configDir = path.dirname(path.resolve(configPath));
  return path.basename(path.dirname(configDir)).toLowerCase() === "workspaces"
    ? path.basename(configDir)
    : "default";
}

export function workspaceScopedMem0UserId(baseUserId: string, workspaceId: string): string {
  // Scope every workspace, including default. Reusing the legacy unscoped id
  // for default could expose entries written by other workspaces before this
  // boundary existed. Those legacy entries remain untouched but unqueried.
  return `${baseUserId}:workspace:${workspaceId}`;
}

export class HybridKnowledgeIndex implements KnowledgeIndex {
  constructor(
    private readonly mem0: Mem0Client,
    private readonly fileIndex: LocalFileIndexClient
  ) {}

  async index(entry: KnowledgeEntry): Promise<void> {
    await this.mem0.add(entry);
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
    // The loaded config path is authoritative. An invalid/stale selector env
    // may be ignored by the workspace manager, so using it here could scope
    // memory differently from the workspace the process actually loaded.
    const workspaceId = workspaceIdFromConfigPath(services.configPath);
    const baseUserId = process.env.MEM0_USER_ID ?? "local-agent";
    const mem0 = new Mem0Client({
      baseUrl: process.env.MEM0_BASE_URL ?? "http://localhost:8888",
      ...(process.env.MEM0_API_KEY !== undefined ? { apiKey: process.env.MEM0_API_KEY } : {}),
      userId: workspaceScopedMem0UserId(baseUserId, workspaceId),
      workspaceId
    });

    const fileIndex = new LocalFileIndexClient({
      baseUrl: process.env.FILE_INDEX_BASE_URL ?? "http://localhost:8877"
    });

    await services.register("KnowledgeIndex", new HybridKnowledgeIndex(mem0, fileIndex));
  }
};

export default plugin;
