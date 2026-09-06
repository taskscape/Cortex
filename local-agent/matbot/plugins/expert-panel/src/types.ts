/** Minimal completion result the plugin expects back from a single-turn LLM call. */
export interface CompletionResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** One-shot completion request issued through the host machine. */
export interface SingleTurnRequest {
  provider: string;
  prompt: string;
  system?: string;
  signal?: AbortSignal;
}

/** Subset of tool context this plugin consumes. */
export interface ToolContext {
  signal: AbortSignal;
  provider?: string;
}

/** Events a tool executor may yield while running. */
export type ToolEvent =
  | { type: "stdout"; chunk: string }
  | { type: "progress"; pct: number; message?: string }
  | { type: "result"; value: unknown }
  | { type: "error"; message: string };

/** Async executor contract for a tool. */
export interface ToolExecutor {
  execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent>;
}

/** Tool descriptor registered with the host's tool registry. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executor: ToolExecutor;
}

/** Registry the plugin registers its tools with. */
export interface ToolRegistry {
  register(tool: Tool): void;
}

/** Query shape for filtering/sorting/limiting store contents (undefined matches everything). */
export type StoreQuery =
  | {
      where?: StoreFilter;
      sort?: Array<{ field: string | string[]; dir?: "asc" | "desc" }>;
      limit?: number;
    }
  | undefined;

/** Filter tree over document fields: equality leaves combined by and/or. */
export type StoreFilter =
  | { op: "eq"; field: string | string[]; value: unknown }
  | { op: "and"; clauses: StoreFilter[] }
  | { op: "or"; clauses: StoreFilter[] };

/** Minimal versioned document store used for durable expert review records. */
export interface Store<T extends { id: string; version: string }> {
  /**
   * Retrieve a document by its identifier.
   * @param id Document identifier. @returns The document, or null when absent.
   */
  get(id: string): Promise<T | null>;
  /**
   * Store a full document under the given id, replacing any prior value.
   * @param id Document identifier. @param value Full document to store.
   */
  set(id: string, value: T): Promise<void>;
  /**
   * List documents matching an optional filter/sort/limit query.
   * @param query Optional filter/sort/limit. @returns Matching items plus total count before limit.
   */
  query(query?: StoreQuery): Promise<{ items: T[]; total: number }>;
}

/** Host services surface this plugin relies on. */
export interface MatbotMachine {
  WorkspaceRagManager?:import('./providers.js').ExpertRagSearch;
  contributions?:{register(kind:'webui',id:string,value:unknown):()=>void};
  singleTurn(req: SingleTurnRequest): Promise<CompletionResponse>;
  tools: ToolRegistry;
  providers: ReadonlyMap<string, unknown>;
  createStore?<T extends { id: string; version: string }>(namespace: string): Store<T>;
  register?(key: string, value: unknown): Promise<void> | void;
}

/** Plugin entry-point contract expected by the matbot loader. */
export interface MatbotPluginSpec {
  apiVersion: string;
  setup(services: MatbotMachine): Promise<void> | void;
}

/** Configuration of one domain expert on the panel. */
export interface ExpertConfig {
  id: string;
  title: string;
  description: string;
  /** Preferred provider name; falls back to the turn's or panel default provider when unset. */
  provider?: string;
  /** Knowledge root directories or files searched for grounding evidence. */
  roots: string[];
  systemPrompt: string;
  tags?: string[];
}

/** Top-level experts.json configuration. */
export interface ExpertPanelConfig {
  defaultProvider?: string;
  experts: ExpertConfig[];
}

/** One retrieved knowledge source handed to an expert as grounding evidence. */
export interface ExpertSource {
  id: string;
  expertId: string;
  path: string;
  title: string;
  content: string;
  score: number;
}

/** Which link in the provider resolution chain was selected. */
export type ExpertProviderSource = "expert" | "turn" | "panel_default" | "first_available";

/** One evaluated candidate in the provider fallback chain. */
export interface ExpertProviderCandidate {
  source: Exclude<ExpertProviderSource, "first_available">;
  provider: string | undefined;
  available: boolean;
}

/** Full audit of how a provider was chosen for an expert or synthesis call. */
export interface ExpertProviderResolution {
  selectedProvider: string;
  source: ExpertProviderSource;
  fallback: boolean;
  chain: ExpertProviderCandidate[];
}

/** A single expert's answer plus grounding and provider diagnostics. */
export interface ExpertOpinion {
  expertId: string;
  title: string;
  answer: string;
  providerResolution: ExpertProviderResolution;
  warnings: string[];
  modeFormat: {
    schema: "parallel-v1" | "review-v1" | "debate-v1";
    requiredSections: string[];
  };
  citations: Array<{
    id: string;
    path: string;
    title: string;
    score: number;
  }>;
  usage: { inputTokens: number; outputTokens: number };
}

/** Structured review mode selecting which approval checklist items apply. */
export type ExpertReviewMode =
  | "quick_review"
  | "full_approval_review"
  | "red_team_review"
  | "pre_automation_review"
  | "post_incident_review";

/** Kind of artifact a stored review is linked to. */
export type ExpertReviewTargetType =
  | "decision_dossier"
  | "workflow"
  | "workflow_run"
  | "alert"
  | "investigation"
  | "chat"
  | "other";

/** Lifecycle state derived from the experts' recommendations. */
export type ExpertReviewStatus = "draft" | "under_review" | "approved" | "rejected" | "needs_changes";
/** Per-expert verdict extracted from their answer text. */
export type ExpertRecommendation = "approve" | "approve_with_changes" | "block" | "needs_more_evidence";
/** Severity assigned to risk-register entries based on the owner expert's verdict. */
export type ExpertRiskSeverity = "low" | "medium" | "high" | "critical";

/** An opinion enriched with structured recommendation, risks, blockers, and checklist data. */
export interface StructuredExpertOpinion extends ExpertOpinion {
  recommendation: ExpertRecommendation;
  confidence: number;
  evidenceIds: string[];
  risks: string[];
  blockers: string[];
  mitigations: string[];
  approvalChecklist: string[];
}

/** One entry in a review's consolidated risk register. */
export interface ExpertRiskRegisterItem {
  id: string;
  severity: ExpertRiskSeverity;
  description: string;
  ownerExpertId?: string;
  mitigation?: string;
}

/** Durable record of a structured expert review persisted to the reviews store. */
export interface ExpertReviewRecord {
  id: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  question: string;
  mode: "parallel" | "review" | "debate";
  reviewMode: ExpertReviewMode;
  targetType: ExpertReviewTargetType;
  status: ExpertReviewStatus;
  expertIds: string[];
  experts: StructuredExpertOpinion[];
  sourceIds: string[];
  consensus: string[];
  disagreements: string[];
  blockers: string[];
  mitigations: string[];
  approvalChecklist: string[];
  riskRegister: ExpertRiskRegisterItem[];
  synthesis?: string;
  targetId?: string;
  workflowId?: string;
  workflowRunId?: string;
  dossierId?: string;
}
