export interface CompletionResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface SingleTurnRequest {
  provider: string;
  prompt: string;
  system?: string;
  signal?: AbortSignal;
}

export interface ToolContext {
  signal: AbortSignal;
  provider?: string;
}

export type ToolEvent =
  | { type: "stdout"; chunk: string }
  | { type: "progress"; pct: number; message?: string }
  | { type: "result"; value: unknown }
  | { type: "error"; message: string };

export interface ToolExecutor {
  execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executor: ToolExecutor;
}

export interface ToolRegistry {
  register(tool: Tool): void;
}

export type StoreQuery =
  | {
      where?: StoreFilter;
      sort?: Array<{ field: string | string[]; dir?: "asc" | "desc" }>;
      limit?: number;
    }
  | undefined;

export type StoreFilter =
  | { op: "eq"; field: string | string[]; value: unknown }
  | { op: "and"; clauses: StoreFilter[] }
  | { op: "or"; clauses: StoreFilter[] };

export interface Store<T extends { id: string; version: string }> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  query(query?: StoreQuery): Promise<{ items: T[]; total: number }>;
}

export interface MatbotMachine {
  singleTurn(req: SingleTurnRequest): Promise<CompletionResponse>;
  tools: ToolRegistry;
  providers: ReadonlyMap<string, unknown>;
  createStore?<T extends { id: string; version: string }>(namespace: string): Store<T>;
  register?(key: string, value: unknown): Promise<void> | void;
}

export interface MatbotPluginSpec {
  apiVersion: string;
  setup(services: MatbotMachine): Promise<void> | void;
}

export interface ExpertConfig {
  id: string;
  title: string;
  description: string;
  provider?: string;
  roots: string[];
  systemPrompt: string;
  tags?: string[];
}

export interface ExpertPanelConfig {
  defaultProvider?: string;
  experts: ExpertConfig[];
}

export interface ExpertSource {
  id: string;
  expertId: string;
  path: string;
  title: string;
  content: string;
  score: number;
}

export type ExpertProviderSource = "expert" | "turn" | "panel_default" | "first_available";

export interface ExpertProviderCandidate {
  source: Exclude<ExpertProviderSource, "first_available">;
  provider: string | undefined;
  available: boolean;
}

export interface ExpertProviderResolution {
  selectedProvider: string;
  source: ExpertProviderSource;
  fallback: boolean;
  chain: ExpertProviderCandidate[];
}

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

export type ExpertReviewMode =
  | "quick_review"
  | "full_approval_review"
  | "red_team_review"
  | "pre_automation_review"
  | "post_incident_review";

export type ExpertReviewTargetType =
  | "decision_dossier"
  | "workflow"
  | "workflow_run"
  | "alert"
  | "investigation"
  | "chat"
  | "other";

export type ExpertReviewStatus = "draft" | "under_review" | "approved" | "rejected" | "needs_changes";
export type ExpertRecommendation = "approve" | "approve_with_changes" | "block" | "needs_more_evidence";
export type ExpertRiskSeverity = "low" | "medium" | "high" | "critical";

export interface StructuredExpertOpinion extends ExpertOpinion {
  recommendation: ExpertRecommendation;
  confidence: number;
  evidenceIds: string[];
  risks: string[];
  blockers: string[];
  mitigations: string[];
  approvalChecklist: string[];
}

export interface ExpertRiskRegisterItem {
  id: string;
  severity: ExpertRiskSeverity;
  description: string;
  ownerExpertId?: string;
  mitigation?: string;
}

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
