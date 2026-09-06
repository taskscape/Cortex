/** A knowledge document stored in or returned from the index. */
export interface KnowledgeEntry {
  id: string;
  version: string;
  entities: string[];
  tags: string[];
  summary: string;
  content: string;
  contentHash?: string;
  source: { type: string; uuid: string };
  confidence?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The knowledge service contract this plugin implements: write entries to the index
 * and search it with term/context pairs.
 */
export interface KnowledgeIndex {
  /**
   * Persist an entry to the index.
   * @param entry Entry to add to the index.
   */
  index(entry: KnowledgeEntry): Promise<void>;
  /**
   * Search the index with term/context pairs.
   * @param terms Terms to search for, each with optional context.
   * @param signal Cancellation signal.
   * @returns Matching entries, ranked and deduplicated by the implementation.
   */
  search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]>;
  entries?(): Iterable<KnowledgeEntry>;
}

/** Subset of host services this plugin consumes. */
export interface MatbotServices {
  configPath?: string;
  register(name: "KnowledgeIndex", service: KnowledgeIndex): Promise<void> | void;
}

/** Plugin entry-point contract expected by the matbot loader. */
export interface MatbotPluginSpec {
  apiVersion: string;
  setup(services: MatbotServices): Promise<void>;
}
