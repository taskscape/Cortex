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

export interface KnowledgeIndex {
  index(entry: KnowledgeEntry): Promise<void>;
  search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]>;
  entries?(): Iterable<KnowledgeEntry>;
}

export interface MatbotServices {
  register(name: "KnowledgeIndex", service: KnowledgeIndex): Promise<void> | void;
}

export interface MatbotPluginSpec {
  apiVersion: string;
  setup(services: MatbotServices): Promise<void>;
}
