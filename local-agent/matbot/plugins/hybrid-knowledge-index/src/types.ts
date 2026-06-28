export interface KnowledgeEntry {
  content: string;
  source?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeIndex {
  index(entry: KnowledgeEntry): Promise<void>;
  search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]>;
}

export interface MatbotServices {
  register(name: "KnowledgeIndex", service: KnowledgeIndex): Promise<void> | void;
}

export interface MatbotPluginSpec {
  apiVersion: string;
  setup(services: MatbotServices): Promise<void>;
}
