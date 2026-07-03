import { createHash, randomUUID } from "node:crypto";
import type {
  ExpertConfig,
  ExpertOpinion,
  ExpertRecommendation,
  ExpertReviewMode,
  ExpertReviewRecord,
  ExpertReviewStatus,
  ExpertReviewTargetType,
  ExpertSource,
  Store,
  StoreFilter,
  StoreQuery,
  StructuredExpertOpinion,
  MatbotMachine,
  MatbotPluginSpec,
  Tool,
  ToolContext,
  ToolEvent
} from "./types.js";
import { loadExpertConfig } from "./config.js";
import { FileExpertKnowledge } from "./file-knowledge.js";

interface ExpertPanelInput {
  action?: "list" | "ask" | "review" | "get_review" | "list_reviews";
  question?: string;
  experts?: string[];
  mode?: "parallel" | "review" | "debate";
  reviewMode?: ExpertReviewMode;
  targetType?: ExpertReviewTargetType;
  targetId?: string;
  workflowId?: string;
  workflowRunId?: string;
  dossierId?: string;
  reviewId?: string;
  status?: ExpertReviewStatus;
  query?: StoreQuery;
  maxCitationsPerExpert?: number;
  synthesize?: boolean;
}

interface ExpertRuntime {
  config: ExpertConfig;
  knowledge: FileExpertKnowledge;
}

class ExpertPanel {
  private readonly services: MatbotMachine;
  private readonly experts: ExpertRuntime[];
  private readonly reviews: Store<ExpertReviewRecord>;
  private readonly defaultProvider?: string;

  constructor(
    services: MatbotMachine,
    experts: ExpertRuntime[],
    reviews: Store<ExpertReviewRecord>,
    defaultProvider?: string
  ) {
    this.services = services;
    this.experts = experts;
    this.reviews = reviews;
    this.defaultProvider = defaultProvider;
  }

  list(): ExpertConfig[] {
    return this.experts.map(expert => expert.config);
  }

  async askPanel(input: Required<Pick<ExpertPanelInput, "question" | "mode" | "synthesize">> & ExpertPanelInput, ctx: ToolContext): Promise<{
    question: string;
    mode: string;
    experts: ExpertOpinion[];
    synthesis?: string;
  }> {
    const selected = this.selectExperts(input.experts);
    const citationLimit = clamp(input.maxCitationsPerExpert ?? 5, 1, 12);

    const opinions = await Promise.all(selected.map(expert =>
      this.askExpert(expert, input.question, input.mode, citationLimit, ctx)
    ));

    const result: {
      question: string;
      mode: string;
      experts: ExpertOpinion[];
      synthesis?: string;
    } = {
      question: input.question,
      mode: input.mode,
      experts: opinions
    };

    if (input.synthesize) {
      result.synthesis = await this.synthesize(input.question, input.mode, opinions, ctx);
    }

    return result;
  }

  async createReview(input: Required<Pick<ExpertPanelInput, "question" | "mode" | "synthesize" | "reviewMode" | "targetType">> & ExpertPanelInput, ctx: ToolContext): Promise<{
    review: ExpertReviewRecord;
    panel: {
      question: string;
      mode: string;
      experts: ExpertOpinion[];
      synthesis?: string;
    };
  }> {
    const panel = await this.askPanel(input, ctx);
    const experts = panel.experts.map(opinion => structureOpinion(opinion, input.reviewMode));
    const timestamp = new Date().toISOString();
    const review: ExpertReviewRecord = {
      id: randomUUID(),
      version: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
      question: input.question,
      mode: input.mode,
      reviewMode: input.reviewMode,
      targetType: input.targetType,
      status: reviewStatus(experts),
      expertIds: experts.map(expert => expert.expertId),
      experts,
      sourceIds: unique(experts.flatMap(expert => expert.evidenceIds)),
      consensus: consensusForExperts(experts),
      disagreements: disagreementsForExperts(experts),
      blockers: unique(experts.flatMap(expert => expert.blockers)),
      mitigations: unique(experts.flatMap(expert => expert.mitigations)),
      approvalChecklist: unique(experts.flatMap(expert => expert.approvalChecklist)),
      riskRegister: riskRegisterForExperts(experts),
      ...(panel.synthesis !== undefined ? { synthesis: panel.synthesis } : {}),
      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
      ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
      ...(input.workflowRunId !== undefined ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.dossierId !== undefined ? { dossierId: input.dossierId } : {})
    };
    await this.reviews.set(review.id, review);
    return { review, panel };
  }

  getReview(id: string): Promise<ExpertReviewRecord | null> {
    return this.reviews.get(id);
  }

  async listReviews(query?: StoreQuery): Promise<ExpertReviewRecord[]> {
    const result = await this.reviews.query(query);
    return result.items;
  }

  private selectExperts(ids?: string[]): ExpertRuntime[] {
    if (!ids || ids.length === 0) {
      return this.experts;
    }

    const requested = new Set(ids.map(id => id.toLowerCase()));
    const selected = this.experts.filter(expert => requested.has(expert.config.id.toLowerCase()));
    const found = new Set(selected.map(expert => expert.config.id.toLowerCase()));
    const missing = [...requested].filter(id => !found.has(id));

    if (missing.length > 0) {
      throw new Error(`Unknown expert(s): ${missing.join(", ")}. Available experts: ${this.experts.map(expert => expert.config.id).join(", ")}`);
    }

    return selected;
  }

  private async askExpert(expert: ExpertRuntime, question: string, mode: string, citationLimit: number, ctx: ToolContext): Promise<ExpertOpinion> {
    const provider = this.resolveProvider(expert.config.provider ?? ctx.provider ?? this.defaultProvider);
    const sources = await expert.knowledge.search(question, citationLimit, ctx.signal);
    const prompt = expertPrompt(question, mode, sources);
    const response = await this.services.singleTurn({
      provider,
      system: expert.config.systemPrompt,
      prompt,
      signal: ctx.signal
    });

    return {
      expertId: expert.config.id,
      title: expert.config.title,
      answer: response.text.trim(),
      citations: sources.map(source => ({
        id: source.id,
        path: source.path,
        title: source.title,
        score: source.score
      })),
      usage: response.usage
    };
  }

  private async synthesize(question: string, mode: string, opinions: ExpertOpinion[], ctx: ToolContext): Promise<string> {
    const provider = this.resolveProvider(ctx.provider ?? this.defaultProvider);
    const prompt = [
      `Question:\n${question}`,
      `Mode: ${mode}`,
      "Expert opinions:",
      ...opinions.map(opinion => [
        `## ${opinion.title} (${opinion.expertId})`,
        opinion.answer,
        `Citations: ${opinion.citations.map(citation => citation.id).join(", ") || "(none)"}`
      ].join("\n")),
      "Synthesize the panel. Return: consensus, disagreements, risks/assumptions, and a final recommendation. Name which expert perspective was most decisive and why."
    ].join("\n\n");

    const response = await this.services.singleTurn({
      provider,
      system: "You are an orchestrating agent. Collate expert opinions faithfully, preserve disagreements, and make a final decision only after weighing the evidence.",
      prompt,
      signal: ctx.signal
    });

    return response.text.trim();
  }

  private resolveProvider(candidate?: string): string {
    if (candidate && this.services.providers.has(candidate)) {
      return candidate;
    }

    const first = this.services.providers.keys().next().value as string | undefined;
    if (!first) {
      throw new Error("No provider is configured for expert_panel.");
    }

    return first;
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: "0.1",
  async setup(services) {
    const config = await loadExpertConfig();
    const reviewStore = createReviewStore(services);
    const panel = new ExpertPanel(
      services,
      config.experts.map(expert => ({ config: expert, knowledge: new FileExpertKnowledge(expert) })),
      reviewStore,
      config.defaultProvider
    );

    await services.register?.("ExpertPanel", panel);
    services.tools.register(createExpertPanelTool(panel));
  }
};

export default plugin;

function createExpertPanelTool(panel: ExpertPanel): Tool {
  return {
    name: "expert_panel",
    description:
      "Ask a selected panel of domain experts to answer the same question from grounded knowledge files, then optionally synthesize their opinions. " +
      "Use this when the user wants multiple perspectives, disagreement, review, durable expert review records, or a decision informed by design, finance, legal, security, operations, data-quality, customer-impact, engineering, or other configured experts.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "ask", "review", "get_review", "list_reviews"],
          default: "ask",
          description: "list: return configured expert metadata. ask: run the panel. review: run and store a structured expert review. get_review/list_reviews inspect durable review records. Defaults to ask."
        },
        question: {
          type: "string",
          description: "The user question or decision to put before the expert panel. Required for action=ask."
        },
        experts: {
          type: "array",
          items: { type: "string" },
          description: "Optional expert ids to run. Omit to run all configured experts."
        },
        mode: {
          type: "string",
          enum: ["parallel", "review", "debate"],
          default: "parallel",
          description: "parallel: independent answers. review: critique proposal. debate: emphasize tradeoffs and disagreement."
        },
        reviewMode: {
          type: "string",
          enum: ["quick_review", "full_approval_review", "red_team_review", "pre_automation_review", "post_incident_review"],
          default: "quick_review",
          description: "Structured review mode for action=review."
        },
        targetType: {
          type: "string",
          enum: ["decision_dossier", "workflow", "alert", "investigation", "chat", "other"],
          default: "chat",
          description: "Artifact type this review is linked to."
        },
        targetId: { type: "string", description: "Optional reviewed artifact id." },
        workflowId: { type: "string", description: "Optional workflow id linked to this review." },
        workflowRunId: { type: "string", description: "Optional workflow run id linked to this review." },
        dossierId: { type: "string", description: "Optional decision dossier id linked to this review." },
        reviewId: { type: "string", description: "Review id for action=get_review." },
        query: { type: "object", description: "Store query for action=list_reviews." },
        maxCitationsPerExpert: {
          type: "number",
          default: 5,
          description: "Maximum number of retrieved text sources to show each expert."
        },
        synthesize: {
          type: "boolean",
          default: true,
          description: "When true, run an orchestrator pass that collates the expert opinions into a final recommendation."
        }
      }
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const parsed = parseInput(input);
        if (parsed.action === "list") {
          yield {
            type: "result",
            value: {
              experts: panel.list().map(expert => ({
                id: expert.id,
                title: expert.title,
                description: expert.description,
                provider: expert.provider,
                tags: expert.tags ?? []
              }))
            }
          };
          return;
        }

        if (parsed.action === "get_review") {
          if (!parsed.reviewId) {
            yield { type: "error", message: 'expert_panel get_review requires "reviewId".' };
            return;
          }
          yield { type: "result", value: { review: await panel.getReview(parsed.reviewId) } };
          return;
        }

        if (parsed.action === "list_reviews") {
          yield { type: "result", value: { reviews: await panel.listReviews(parsed.query) } };
          return;
        }

        if (!parsed.question) {
          yield { type: "error", message: 'expert_panel requires "question".' };
          return;
        }

        try {
          yield { type: "progress", pct: 10, message: "Running expert panel" };
          if (parsed.action === "review") {
            const result = await panel.createReview(parsed as Required<Pick<ExpertPanelInput, "question" | "mode" | "synthesize" | "reviewMode" | "targetType">> & ExpertPanelInput, ctx);
            yield { type: "progress", pct: 100, message: "Expert review complete" };
            yield { type: "result", value: result };
            return;
          }
          const result = await panel.askPanel(parsed as Required<Pick<ExpertPanelInput, "question" | "mode" | "synthesize">> & ExpertPanelInput, ctx);
          yield { type: "progress", pct: 100, message: "Expert panel complete" };
          yield { type: "result", value: result };
        } catch (error) {
          yield { type: "error", message: error instanceof Error ? error.message : String(error) };
        }
      }
    }
  };
}

function parseInput(input: unknown): ExpertPanelInput & { mode: "parallel" | "review" | "debate"; synthesize: boolean } {
  const value = input !== null && typeof input === "object" ? input as Record<string, unknown> : {};
  const mode = value.mode === "review" || value.mode === "debate" || value.mode === "parallel" ? value.mode : "parallel";
  const action =
    value.action === "list" || value.action === "review" || value.action === "get_review" || value.action === "list_reviews"
      ? value.action
      : "ask";
  const reviewMode = isReviewMode(value.reviewMode) ? value.reviewMode : "quick_review";
  const targetType = isTargetType(value.targetType) ? value.targetType : "chat";
  const experts = Array.isArray(value.experts)
    ? value.experts.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;

  return {
    action,
    question: typeof value.question === "string" ? value.question.trim() : undefined,
    experts,
    mode,
    reviewMode,
    targetType,
    targetId: typeof value.targetId === "string" ? value.targetId : undefined,
    workflowId: typeof value.workflowId === "string" ? value.workflowId : undefined,
    workflowRunId: typeof value.workflowRunId === "string" ? value.workflowRunId : undefined,
    dossierId: typeof value.dossierId === "string" ? value.dossierId : undefined,
    reviewId: typeof value.reviewId === "string" ? value.reviewId : undefined,
    query: typeof value.query === "object" && value.query !== null ? value.query as StoreQuery : undefined,
    maxCitationsPerExpert: typeof value.maxCitationsPerExpert === "number" ? value.maxCitationsPerExpert : undefined,
    synthesize: typeof value.synthesize === "boolean" ? value.synthesize : true
  };
}

function expertPrompt(question: string, mode: string, sources: ExpertSource[]): string {
  return [
    `Question:\n${question}`,
    `Panel mode: ${mode}`,
    "Use your domain expertise and the grounded sources below. If the sources do not cover part of the question, say so explicitly instead of inventing evidence.",
    "Return sections: answer, evidence, assumptions, risks, blockers, mitigations, approval checklist, confidence.",
    "Grounded sources:",
    sources.length === 0 ? "(No matching knowledge files were found for this expert.)" : sources.map(formatSource).join("\n\n")
  ].join("\n\n");
}

function formatSource(source: ExpertSource, index: number): string {
  return [
    `[${index + 1}] ${source.title}`,
    `id: ${source.id}`,
    `path: ${source.path}`,
    `score: ${source.score}`,
    source.content
  ].join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isReviewMode(value: unknown): value is ExpertReviewMode {
  return value === "quick_review"
    || value === "full_approval_review"
    || value === "red_team_review"
    || value === "pre_automation_review"
    || value === "post_incident_review";
}

function isTargetType(value: unknown): value is ExpertReviewTargetType {
  return value === "decision_dossier"
    || value === "workflow"
    || value === "alert"
    || value === "investigation"
    || value === "chat"
    || value === "other";
}

function structureOpinion(opinion: ExpertOpinion, reviewMode: ExpertReviewMode): StructuredExpertOpinion {
  const risks = extractLines(opinion.answer, ["risk", "concern", "exposure", "downside"]);
  const blockers = extractLines(opinion.answer, ["blocker", "must not", "cannot approve", "reject"]);
  const mitigations = extractLines(opinion.answer, ["mitigation", "mitigate", "recommend", "should", "next step"]);
  return {
    ...opinion,
    recommendation: recommendationForOpinion(opinion, blockers),
    confidence: confidenceForOpinion(opinion),
    evidenceIds: opinion.citations.map(citation => citation.id),
    risks: risks.length > 0 ? risks : fallbackRisk(opinion),
    blockers,
    mitigations: mitigations.length > 0 ? mitigations : [`${opinion.title}: require owner review before execution.`],
    approvalChecklist: approvalChecklistForOpinion(opinion, reviewMode)
  };
}

function recommendationForOpinion(opinion: ExpertOpinion, blockers: string[]): ExpertRecommendation {
  const lower = opinion.answer.toLowerCase();
  if (blockers.length > 0 || /\b(block|reject|do not approve|cannot approve)\b/.test(lower)) return "block";
  if (opinion.citations.length === 0 || /\b(missing evidence|insufficient evidence|unknown)\b/.test(lower)) return "needs_more_evidence";
  if (/\b(risk|concern|mitigat|condition|change)\b/.test(lower)) return "approve_with_changes";
  return "approve";
}

function confidenceForOpinion(opinion: ExpertOpinion): number {
  const lower = opinion.answer.toLowerCase();
  if (opinion.citations.length === 0) return 0.45;
  if (/\b(uncertain|unknown|missing evidence|insufficient evidence)\b/.test(lower)) return 0.55;
  return Math.min(0.95, 0.65 + opinion.citations.length * 0.08);
}

function fallbackRisk(opinion: ExpertOpinion): string[] {
  if (opinion.citations.length === 0) return [`${opinion.title}: no expert-specific evidence was retrieved.`];
  return [];
}

function approvalChecklistForOpinion(opinion: ExpertOpinion, reviewMode: ExpertReviewMode): string[] {
  const base = [
    `${opinion.title}: evidence reviewed`,
    `${opinion.title}: risks acknowledged`,
    `${opinion.title}: owner assigned for mitigations`
  ];
  if (reviewMode === "pre_automation_review") return [...base, `${opinion.title}: automation rollback path confirmed`];
  if (reviewMode === "red_team_review") return [...base, `${opinion.title}: abuse and failure scenarios challenged`];
  if (reviewMode === "full_approval_review") return [...base, `${opinion.title}: approval authority confirmed`];
  if (reviewMode === "post_incident_review") return [...base, `${opinion.title}: corrective action tracked`];
  return base;
}

function extractLines(text: string, keywords: string[]): string[] {
  const lines = text.split(/\r?\n|[.;]/)
    .map(line => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean);
  const matches = lines.filter(line => keywords.some(keyword => line.toLowerCase().includes(keyword)));
  return unique(matches).slice(0, 5);
}

function reviewStatus(experts: StructuredExpertOpinion[]): ExpertReviewStatus {
  if (experts.some(expert => expert.recommendation === "block")) return "rejected";
  if (experts.some(expert => expert.recommendation === "needs_more_evidence")) return "needs_changes";
  if (experts.some(expert => expert.recommendation === "approve_with_changes")) return "under_review";
  return "approved";
}

function consensusForExperts(experts: StructuredExpertOpinion[]): string[] {
  const recommendations = unique(experts.map(expert => expert.recommendation));
  if (recommendations.length === 1) return [`All selected experts returned recommendation: ${recommendations[0]}.`];
  return [`Experts returned mixed recommendations: ${recommendations.join(", ")}.`];
}

function disagreementsForExperts(experts: StructuredExpertOpinion[]): string[] {
  const byRecommendation = new Map<ExpertRecommendation, string[]>();
  for (const expert of experts) {
    byRecommendation.set(expert.recommendation, [...(byRecommendation.get(expert.recommendation) ?? []), expert.expertId]);
  }
  if (byRecommendation.size <= 1) return [];
  return [...byRecommendation.entries()].map(([recommendation, expertIds]) => `${recommendation}: ${expertIds.join(", ")}`);
}

function riskRegisterForExperts(experts: StructuredExpertOpinion[]): ExpertReviewRecord["riskRegister"] {
  return experts.flatMap(expert => expert.risks.map((risk, index) => ({
    id: stableId(`${expert.expertId}:${index}:${risk}`),
    severity: expert.recommendation === "block" ? "high" : expert.recommendation === "needs_more_evidence" ? "medium" : "low",
    description: risk,
    ownerExpertId: expert.expertId,
    ...(expert.mitigations[0] !== undefined ? { mitigation: expert.mitigations[0] } : {})
  })));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function createReviewStore(services: MatbotMachine): Store<ExpertReviewRecord> {
  return services.createStore?.<ExpertReviewRecord>("expert_panel_reviews") ?? new MemoryReviewStore();
}

class MemoryReviewStore implements Store<ExpertReviewRecord> {
  private readonly docs = new Map<string, ExpertReviewRecord>();

  async get(id: string): Promise<ExpertReviewRecord | null> {
    return this.docs.get(id) ?? null;
  }

  async set(id: string, value: ExpertReviewRecord): Promise<void> {
    this.docs.set(id, value);
  }

  async query(query?: StoreQuery): Promise<{ items: ExpertReviewRecord[]; total: number }> {
    let items = [...this.docs.values()];
    if (query?.where !== undefined) items = items.filter(item => matchesFilter(item, query.where!));
    if (Array.isArray(query?.sort)) {
      for (const sort of [...query.sort].reverse()) {
        items.sort((left, right) => {
          const a = fieldValue(left, sort.field);
          const b = fieldValue(right, sort.field);
          const dir = sort.dir === "desc" ? -1 : 1;
          return String(a ?? "").localeCompare(String(b ?? "")) * dir;
        });
      }
    }
    const total = items.length;
    if (typeof query?.limit === "number") items = items.slice(0, query.limit);
    return { items, total };
  }
}

function matchesFilter(item: unknown, filter: StoreFilter): boolean {
  if (filter.op === "eq") return fieldValue(item, filter.field) === filter.value;
  if (filter.op === "and") return filter.clauses.every(clause => matchesFilter(item, clause));
  return filter.clauses.some(clause => matchesFilter(item, clause));
}

function fieldValue(item: unknown, field: string | string[]): unknown {
  const parts = Array.isArray(field) ? field : [field];
  let value = item;
  for (const part of parts) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
