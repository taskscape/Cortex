import { LocalFileIndexClient } from "./file-index-client.js";
import { Mem0Client } from "./mem0-client.js";
import { mergeRankAndDeduplicate } from "./ranking.js";
import type { KnowledgeEntry, KnowledgeIndex, MatbotPluginSpec } from "./types.js";
import path from "node:path";

/**
 * Derive a workspace id from the loaded matbot config path: the config directory's
 * basename when it lives under a `workspaces/` parent, otherwise "default".
 * @param configPath Path of the loaded matbot.yaml (or undefined for no workspace).
 * @returns The scoped workspace id.
 */
export function workspaceIdFromConfigPath(configPath: string | undefined): string {
  if (!configPath) return "default";
  const configDir = path.dirname(path.resolve(configPath));
  return path.basename(path.dirname(configDir)).toLowerCase() === "workspaces"
    ? path.basename(configDir)
    : "default";
}

/**
 * Scope a Mem0 user id to a workspace so different workspaces never share memories,
 * including the default one (legacy unscoped entries stay stored but unqueried).
 * @param baseUserId The base Mem0 user id.
 * @param workspaceId Workspace scope to append.
 * @returns The scoped user id `<baseUserId>:workspace:<workspaceId>`.
 */
export function workspaceScopedMem0UserId(baseUserId: string, workspaceId: string): string {
  // Scope every workspace, including default. Reusing the legacy unscoped id
  // for default could expose entries written by other workspaces before this
  // boundary existed. Those legacy entries remain untouched but unqueried.
  return `${baseUserId}:workspace:${workspaceId}`;
}

/**
 * KnowledgeIndex backed by two remote sources: a Mem0 memory service (the write path)
 * and a local file-index search service. Searches fan out to both backends, tolerate
 * one failing, and merge/rank/deduplicate the combined results.
 */
export class HybridKnowledgeIndex implements KnowledgeIndex {
  /**
   * Creates a hybrid index over the two remote backends.
   * @param mem0 Client for the Mem0 memory service.
   * @param fileIndex Client for the local file-index search service.
   */
  constructor(
    private readonly mem0: Mem0Client,
    private readonly fileIndex: LocalFileIndexClient
  ) {}

  /**
   * Persist an entry to the Mem0 memory store (the index's write path).
   * @param entry Entry to add.
   * @throws Whatever the Mem0 client throws on request failure.
   */
  async index(entry: KnowledgeEntry): Promise<void> {
    await this.mem0.add(entry);
  }

  /**
   * Search both backends concurrently (a failing backend yields no results, not an
   * error) and return the merged, ranked, deduplicated entries.
   * @param terms Terms to search for, each with optional context.
   * @param signal Cancellation signal propagated to both clients.
   * @returns Up to 12 best-matching entries.
   */
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

/**
 * The hybrid-knowledge-index plugin: on setup(), derives the workspace id from the
 * loaded config path, builds Mem0 and file-index clients (endpoints/keys via
 * `MEM0_BASE_URL`/`MEM0_API_KEY`/`MEM0_USER_ID`/`FILE_INDEX_BASE_URL`), and registers
 * a `HybridKnowledgeIndex` as the host's KnowledgeIndex service.
 */
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
