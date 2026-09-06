import {uiContribution} from './ui.js';
import { createHash, randomUUID } from "node:crypto";
import type {
  ExpertConfig,
  ExpertOpinion,
  ExpertProviderResolution,
  ExpertProviderSource,
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
import {FileExpertDefinitionSource,fileExpertKnowledge,RagExpertKnowledge} from './providers.js';
import type {ExpertDefinitionSource,ExpertKnowledgeFactory,ExpertKnowledgeSource} from './providers.js';
export * from './providers.js';

/** Parsed input for the `expert_panel` tool; every field is optional before parsing applies defaults. */
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

/** One expert paired with its knowledge source, ready for panel execution. */
interface ExpertRuntime {
  config: ExpertConfig;
  knowledge: ExpertKnowledgeSource;
}

/** Panel ask result: per-expert opinions plus the optional synthesis. */
interface ExpertPanelResult {
  question: string;
  mode: string;
  experts: ExpertOpinion[];
  synthesis?: string;
  synthesisProviderResolution?: ExpertProviderResolution;
}

/** One link in the provider fallback chain before availability is evaluated. */
interface ProviderCandidate {
  source: Exclude<ExpertProviderSource, "first_available">;
  provider: string | undefined;
}

/**
 * Runs the configured expert panel: selects experts, retrieves grounded knowledge per
 * expert, issues single-turn LLM calls, resolves providers via a fallback chain, and
 * persists structured review records to the review store.
 */
class ExpertPanel {
  private readonly services: MatbotMachine;
  private readonly experts: ExpertRuntime[];
  private readonly reviews: Store<ExpertReviewRecord>;
  private readonly defaultProvider: string | undefined;

  /**
   * Creates a panel over the given experts.
   * @param services Host machine used for single-turn calls and provider lookup.
   * @param experts Configured experts paired with their knowledge sources.
   * @param reviews Durable store for expert review records.
   * @param defaultProvider Panel-level provider fallback used after the per-expert and
   *        per-turn candidates.
   */
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

  /**
   * List the configured experts.
   * @returns Expert configs in configuration order.
   * @throws Never.
   */
  list(): ExpertConfig[] {
    return this.experts.map(expert => expert.config);
  }

  /**
   * Ask the selected experts the same question concurrently and optionally synthesize
   * the panel. Experts run independently; a failure of one expert's knowledge source
   * or LLM call rejects the whole panel.
   * @param input Parsed tool input; `question` is required, `mode`/`synthesize` are
   *        defaulted during parsing, `maxCitationsPerExpert` is clamped to 1-12
   *        (default 5).
   * @param ctx Tool context providing the turn's provider and cancellation signal.
   * @returns Per-expert opinions plus the synthesis when requested.
   * @throws Error when requested expert ids are unknown, no provider is available, or
   *         a knowledge search or LLM call fails.
   */
  async askPanel(input: Required<Pick<ExpertPanelInput, "question" | "mode" | "synthesize">> & ExpertPanelInput, ctx: ToolContext): Promise<ExpertPanelResult> {
    const selected = this.selectExperts(input.experts);
    const citationLimit = clamp(input.maxCitationsPerExpert ?? 5, 1, 12);

    const opinions = await Promise.all(selected.map(expert =>
      this.askExpert(expert, input.question, input.mode, citationLimit, ctx)
    ));

    const result: ExpertPanelResult = {
      question: input.question,
      mode: input.mode,
      experts: opinions
    };

    if (input.synthesize) {
      const synthesis = await this.synthesize(input.question, input.mode, opinions, ctx);
      result.synthesis = synthesis.text;
      result.synthesisProviderResolution = synthesis.providerResolution;
    }

    return result;
  }

  /**
   * Run the panel, structure each opinion (recommendation, confidence, risks, blockers,
   * mitigations, approval checklist), derive consensus/disagreements and the risk
   * register, and persist the record to the review store.
   * @param input Parsed tool input; `question`, `mode`, `reviewMode`, and `targetType`
   *        are required (defaults applied during parsing).
   * @param ctx Tool context providing the turn's provider and cancellation signal.
   * @returns The stored review record plus the underlying panel result.
   * @throws Error under the same conditions as `askPanel`, plus review-store write
   *         failures.
   */
  async createReview(input: Required<Pick<ExpertPanelInput, "question" | "mode" | "synthesize" | "reviewMode" | "targetType">> & ExpertPanelInput, ctx: ToolContext): Promise<{
    review: ExpertReviewRecord;
    panel: ExpertPanelResult;
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

  /**
   * Fetch one stored review by id.
   * @param id Review record id.
   * @returns The record, or null when absent.
   * @throws Whatever the underlying review store throws.
   */
  getReview(id: string): Promise<ExpertReviewRecord | null> {
    return this.reviews.get(id);
  }

  /**
   * List stored reviews.
   * @param query Optional filter/sort/limit; the store's `total` is discarded.
   * @returns Matching review records in store order.
   * @throws Whatever the underlying review store throws.
   */
  async listReviews(query?: StoreQuery): Promise<ExpertReviewRecord[]> {
    const result = await this.reviews.query(query);
    return result.items;
  }

  /**
   * Resolve the experts to run: all configured experts when `ids` is empty or
   * undefined, otherwise a case-insensitive id match in configuration order.
   * @param ids Requested expert ids; empty or undefined selects everyone.
   * @returns Selected expert runtimes.
   * @throws Error naming the unknown ids and the available experts.
   */
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

  /**
   * Answer one expert: resolve its provider chain (expert → turn → panel default),
   * search its knowledge source, build the mode-specific prompt, and issue a
   * single-turn LLM call.
   * @param expert Expert runtime to consult.
   * @param question Question to ask.
   * @param mode Panel mode controlling prompt instructions.
   * @param citationLimit Maximum grounded sources shown to this expert.
   * @param ctx Tool context providing the turn's provider and cancellation signal.
   * @returns The expert's formatted answer with citations, warnings, provider
   *          resolution, and usage.
   * @throws Error when no provider is available or the knowledge search or LLM call
   *         fails; aborts propagate.
   */
  private async askExpert(expert: ExpertRuntime, question: string, mode: string, citationLimit: number, ctx: ToolContext): Promise<ExpertOpinion> {
    const providerResolution = this.resolveProvider([
      { source: "expert", provider: expert.config.provider },
      { source: "turn", provider: ctx.provider },
      { source: "panel_default", provider: this.defaultProvider }
    ], `expert:${expert.config.id}`);
    const knowledge = await expert.knowledge.searchWithDiagnostics(question, citationLimit, ctx.signal);
    const sources = knowledge.sources;
    const prompt = expertPrompt(question, mode, sources);
    const response = await this.services.singleTurn({
      provider: providerResolution.selectedProvider,
      system: expert.config.systemPrompt,
      prompt,
      signal: ctx.signal
    });
    const formatted = formatExpertModeAnswer(mode, response.text.trim());

    return {
      expertId: expert.config.id,
      title: expert.config.title,
      answer: formatted.answer,
      providerResolution,
      warnings: knowledge.warnings,
      modeFormat: formatted.modeFormat,
      citations: sources.map(source => ({
        id: source.id,
        path: source.path,
        title: source.title,
        score: source.score
      })),
      usage: response.usage
    };
  }

  /**
   * Run the orchestrator pass collating expert opinions into consensus, disagreements,
   * risks, and a final recommendation. Provider chain: turn provider → panel default.
   * @param question Original panel question.
   * @param mode Panel mode the opinions were produced under.
   * @param opinions Collected expert opinions.
   * @param ctx Tool context providing the turn's provider and cancellation signal.
   * @returns Trimmed synthesis text plus the provider resolution audit.
   * @throws Error when no provider is available or the LLM call fails; aborts propagate.
   */
  private async synthesize(question: string, mode: string, opinions: ExpertOpinion[], ctx: ToolContext): Promise<{
    text: string;
    providerResolution: ExpertProviderResolution;
  }> {
    const providerResolution = this.resolveProvider([
      { source: "turn", provider: ctx.provider },
      { source: "panel_default", provider: this.defaultProvider }
    ], "synthesis");
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
      provider: providerResolution.selectedProvider,
      system: "You are an orchestrating agent. Collate expert opinions faithfully, preserve disagreements, and make a final decision only after weighing the evidence.",
      prompt,
      signal: ctx.signal
    });

    return { text: response.text.trim(), providerResolution };
  }

  /**
   * Evaluate provider candidates in order against the host's registered providers and
   * pick the first available one; if none is available, fall back to the first
   * registered provider. Fallbacks are logged via `console.info` with the evaluated
   * chain.
   * @param candidates Ordered candidate list to evaluate.
   * @param scope Label used in fallback log lines.
   * @returns The selected provider, its source, the fallback flag, and the audited chain.
   * @throws Error when no provider is configured at all.
   */
  private resolveProvider(candidates: ProviderCandidate[], scope: string): ExpertProviderResolution {
    const chain = candidates.map(candidate => ({
      ...candidate,
      available: candidate.provider !== undefined && this.services.providers.has(candidate.provider)
    }));
    const selected = chain.find(candidate => candidate.available);
    let selectedProvider: string;
    let source: ExpertProviderSource;

    if (selected?.provider) {
      selectedProvider = selected.provider;
      source = selected.source;
    } else {
      const first = this.services.providers.keys().next().value as string | undefined;
      if (!first) {
        throw new Error("No provider is configured for expert_panel.");
      }
      selectedProvider = first;
      source = "first_available";
    }

    const fallback = source !== candidates[0]?.source;
    if (fallback) {
      const attempted = chain
        .map(candidate => `${candidate.source}=${candidate.provider ?? "unset"}${candidate.available ? "" : " (unavailable)"}`)
        .join(", ");
      console.info(
        `[expert-panel] provider fallback scope=${scope} selected=${selectedProvider} source=${source}; chain: ${attempted}`
      );
    }

    return { selectedProvider, source, fallback, chain };
  }
}

/**
 * The expert-panel plugin: on setup(), loads experts.json, opens the durable review
 * store, registers an `ExpertPanel` service, and exposes the `expert_panel` tool for
 * listing experts, running grounded panel asks, and creating/inspecting structured
 * expert review records.
 * @param options Optional overrides: `definitions` replaces the file-based config
 *        source; `knowledge` replaces the per-expert knowledge factory (without it,
 *        `CORTEX_EXPERT_KNOWLEDGE` selects `file` or `workspace-rag`).
 * @returns The plugin spec for the matbot loader.
 */
export function createExpertPanelPlugin(options:{definitions?:ExpertDefinitionSource;knowledge?:ExpertKnowledgeFactory}={}):MatbotPluginSpec {
 return {apiVersion:'0.1',async setup(services){
  const definitions=options.definitions??new FileExpertDefinitionSource();const selected=process.env.CORTEX_EXPERT_KNOWLEDGE??'file';if(!options.knowledge&&!['file','workspace-rag'].includes(selected))throw new Error('Unknown expert knowledge source: '+selected);const knowledge=options.knowledge??(selected==='workspace-rag'?(expert=>new RagExpertKnowledge(expert,()=>services.WorkspaceRagManager)):fileExpertKnowledge);const reviewStore=createReviewStore(services);
  let current:{version:string;panel:ExpertPanel}|undefined;let refresh:Promise<ExpertPanel>|undefined;
  /**
   * Resolve the current panel, coalescing concurrent refreshes into one in-flight
   * reload and rebuilding the panel only when the config version (content hash)
   * changes.
   * @returns The up-to-date panel.
   * @throws Error when the definition source fails to load or validate the config.
   */
  const snapshot=async()=>{
   if(refresh)return refresh;
   const run=(async()=>{const next=await definitions.snapshot();if(!current||current.version!==next.version)current={version:next.version,panel:new ExpertPanel(services,next.config.experts.map(expert=>({config:expert,knowledge:knowledge(expert)})),reviewStore,next.config.defaultProvider)};return current.panel;})();refresh=run;try{return await run;}finally{if(refresh===run)refresh=undefined;}
  };
  await snapshot();
  services.contributions?.register('webui','experts',uiContribution);
  await services.register?.('ExpertPanel',{list:async()=>(await snapshot()).list(),askPanel:async(input:Parameters<ExpertPanel['askPanel']>[0],ctx:ToolContext)=>(await snapshot()).askPanel(input,ctx),createReview:async(input:Parameters<ExpertPanel['createReview']>[0],ctx:ToolContext)=>(await snapshot()).createReview(input,ctx),getReview:async(id:string)=>(await snapshot()).getReview(id),listReviews:async(query?:StoreQuery)=>(await snapshot()).listReviews(query)});
  services.tools.register(createExpertPanelTool(snapshot));
 }};
}
export const plugin=createExpertPanelPlugin();

export default plugin;

/**
 * Build the `expert_panel` tool descriptor. The executor snapshots the current panel
 * (picking up config reloads) on each invocation, handles list/get_review/list_reviews
 * inline, and reports ask/review failures as tool error events.
 * @param snapshot Resolves the current {@link ExpertPanel}, refreshing config as needed.
 * @returns The tool descriptor for registration.
 * @throws Never.
 */
function createExpertPanelTool(snapshot:()=>Promise<ExpertPanel>): Tool {
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
          enum: ["decision_dossier", "workflow", "workflow_run", "alert", "investigation", "chat", "other"],
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
        const panel=await snapshot();
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

/**
 * Normalize and validate raw tool input, applying defaults: `action` → "ask", `mode` →
 * "parallel", `reviewMode` → "quick_review", `targetType` → "chat", `synthesize` →
 * true. Unknown enum values fall back to the defaults; non-string or empty expert ids
 * are dropped; optional string fields are kept only when present.
 * @param input Raw executor input.
 * @returns Parsed input with `mode` and `synthesize` always set.
 * @throws Never.
 */
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
    ...(typeof value.question === "string" ? { question: value.question.trim() } : {}),
    ...(experts !== undefined ? { experts } : {}),
    mode,
    reviewMode,
    targetType,
    ...(typeof value.targetId === "string" ? { targetId: value.targetId } : {}),
    ...(typeof value.workflowId === "string" ? { workflowId: value.workflowId } : {}),
    ...(typeof value.workflowRunId === "string" ? { workflowRunId: value.workflowRunId } : {}),
    ...(typeof value.dossierId === "string" ? { dossierId: value.dossierId } : {}),
    ...(typeof value.reviewId === "string" ? { reviewId: value.reviewId } : {}),
    ...(typeof value.query === "object" && value.query !== null ? { query: value.query as StoreQuery } : {}),
    ...(typeof value.maxCitationsPerExpert === "number" ? { maxCitationsPerExpert: value.maxCitationsPerExpert } : {}),
    synthesize: typeof value.synthesize === "boolean" ? value.synthesize : true
  };
}

/**
 * Build one expert's grounded prompt: the question, panel mode instruction, response
 * section contract, and the numbered grounded sources (or a no-sources note).
 * @param question Question to answer.
 * @param mode Panel mode controlling the instruction block.
 * @param sources Grounded sources retrieved for this expert.
 * @returns The full prompt text.
 * @throws Never.
 */
function expertPrompt(question: string, mode: string, sources: ExpertSource[]): string {
  return [
    `Question:\n${question}`,
    `Panel mode: ${mode}`,
    expertModeInstruction(mode),
    "Use your domain expertise and the grounded sources below. If the sources do not cover part of the question, say so explicitly instead of inventing evidence.",
    "Return sections: answer, evidence, assumptions, risks, blockers, mitigations, approval checklist, confidence.",
    "Grounded sources:",
    sources.length === 0 ? "(No matching knowledge files were found for this expert.)" : sources.map(formatSource).join("\n\n")
  ].join("\n\n");
}

/**
 * Mode-specific required-section instruction: review sections for "review", debate
 * sections for "debate", independence for anything else.
 * @param mode Panel mode.
 * @returns The instruction sentence.
 * @throws Never.
 */
function expertModeInstruction(mode: string): string {
  if (mode === "review") {
    return "Required review sections: Strengths, Risks, Omissions, Practical concerns.";
  }
  if (mode === "debate") {
    return "Required debate sections: Position, Disagreements, Tradeoffs.";
  }
  return "Answer independently; do not assume access to another expert's answer.";
}

/**
 * Validate an expert answer against its mode's required markdown sections
 * (case-insensitive heading match) and append placeholder sections for any that are
 * missing, so downstream structuring always finds them.
 * @param mode Panel mode determining the schema name and required sections.
 * @param answer Raw provider answer (already trimmed).
 * @returns The completed answer plus the applied `modeFormat` audit data.
 * @throws Never.
 */
function formatExpertModeAnswer(mode: string, answer: string): {
  answer: string;
  modeFormat: ExpertOpinion["modeFormat"];
} {
  const schema = mode === "review" ? "review-v1" : mode === "debate" ? "debate-v1" : "parallel-v1";
  const requiredSections = mode === "review"
    ? ["Strengths", "Risks", "Omissions", "Practical concerns"]
    : mode === "debate"
      ? ["Position", "Disagreements", "Tradeoffs"]
      : [];
  const missing = requiredSections.filter(section => !new RegExp(
    `^#{1,6}\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "im",
  ).test(answer));
  const completed = missing.length === 0
    ? answer
    : [answer, ...missing.map(section => `## ${section}\nNot explicitly identified in the provider response.`)].join("\n\n");
  return { answer: completed, modeFormat: { schema, requiredSections } };
}

/**
 * Format one grounded source as a numbered citation block.
 * @param source Source to format.
 * @param index Zero-based position; rendered 1-based.
 * @returns The formatted block.
 * @throws Never.
 */
function formatSource(source: ExpertSource, index: number): string {
  return [
    `[${index + 1}] ${source.title}`,
    `id: ${source.id}`,
    `path: ${source.path}`,
    `score: ${source.score}`,
    source.content
  ].join("\n");
}

/**
 * Floor a value and clamp it into an inclusive range.
 * @param value Value to clamp (floored first).
 * @param min Inclusive lower bound.
 * @param max Inclusive upper bound.
 * @returns The clamped integer.
 * @throws Never.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * Type guard for {@link ExpertReviewMode} values.
 * @param value Value to test.
 * @returns True when `value` is a known review mode.
 * @throws Never.
 */
function isReviewMode(value: unknown): value is ExpertReviewMode {
  return value === "quick_review"
    || value === "full_approval_review"
    || value === "red_team_review"
    || value === "pre_automation_review"
    || value === "post_incident_review";
}

/**
 * Type guard for {@link ExpertReviewTargetType} values.
 * @param value Value to test.
 * @returns True when `value` is a known target type.
 * @throws Never.
 */
function isTargetType(value: unknown): value is ExpertReviewTargetType {
  return value === "decision_dossier"
    || value === "workflow"
    || value === "workflow_run"
    || value === "alert"
    || value === "investigation"
    || value === "chat"
    || value === "other";
}

/**
 * Enrich one opinion with structured review data: risks/blockers/mitigations extracted
 * from answer lines by keyword matching, a heuristic recommendation and confidence,
 * evidence ids from citations, and the mode-appropriate approval checklist.
 * @param opinion Raw expert opinion to structure.
 * @param reviewMode Review mode selecting checklist items.
 * @returns The structured opinion (a superset of the input).
 * @throws Never.
 */
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

/**
 * Heuristic verdict from the answer text: "block" when blockers exist or blocking
 * language appears, "needs_more_evidence" without citations or with missing-evidence
 * language, "approve_with_changes" when risk/concern language appears, else "approve".
 * @param opinion Expert opinion to classify.
 * @param blockers Blocker lines already extracted from the answer.
 * @returns The recommendation.
 * @throws Never.
 */
function recommendationForOpinion(opinion: ExpertOpinion, blockers: string[]): ExpertRecommendation {
  const lower = opinion.answer.toLowerCase();
  if (blockers.length > 0 || /\b(block|reject|do not approve|cannot approve)\b/.test(lower)) return "block";
  if (opinion.citations.length === 0 || /\b(missing evidence|insufficient evidence|unknown)\b/.test(lower)) return "needs_more_evidence";
  if (/\b(risk|concern|mitigat|condition|change)\b/.test(lower)) return "approve_with_changes";
  return "approve";
}

/**
 * Heuristic confidence: 0.45 without citations, 0.55 with uncertainty language,
 * otherwise 0.65 plus 0.08 per citation capped at 0.95.
 * @param opinion Expert opinion to score.
 * @returns Confidence between 0.45 and 0.95.
 * @throws Never.
 */
function confidenceForOpinion(opinion: ExpertOpinion): number {
  const lower = opinion.answer.toLowerCase();
  if (opinion.citations.length === 0) return 0.45;
  if (/\b(uncertain|unknown|missing evidence|insufficient evidence)\b/.test(lower)) return 0.55;
  return Math.min(0.95, 0.65 + opinion.citations.length * 0.08);
}

/**
 * Placeholder risk used when no risk lines were extracted from an answer.
 * @param opinion Opinion the fallback is for.
 * @returns A no-evidence note when the opinion has no citations, else empty.
 * @throws Never.
 */
function fallbackRisk(opinion: ExpertOpinion): string[] {
  if (opinion.citations.length === 0) return [`${opinion.title}: no expert-specific evidence was retrieved.`];
  return [];
}

/**
 * Build the per-expert approval checklist: three base items plus one mode-specific
 * item (rollback, abuse scenarios, approval authority, or corrective action).
 * @param opinion Opinion the checklist belongs to.
 * @param reviewMode Review mode selecting the extra item.
 * @returns Checklist item strings, base items first.
 * @throws Never.
 */
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

/**
 * Extract answer lines matching any keyword, case-insensitively: text is split on
 * newlines and sentence boundaries (`.`/`;`), list markers are stripped, duplicates
 * removed, and results capped at 5.
 * @param text Answer text to scan.
 * @param keywords Lowercase substrings to match against each line.
 * @returns Up to 5 unique matching lines.
 * @throws Never.
 */
function extractLines(text: string, keywords: string[]): string[] {
  const lines = text.split(/\r?\n|[.;]/)
    .map(line => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean);
  const matches = lines.filter(line => keywords.some(keyword => line.toLowerCase().includes(keyword)));
  return unique(matches).slice(0, 5);
}

/**
 * Derive the review lifecycle status from expert verdicts, worst verdict first: any
 * "block" → rejected, any "needs_more_evidence" → needs_changes, any
 * "approve_with_changes" → under_review, else approved.
 * @param experts Structured opinions to summarize.
 * @returns The derived status.
 * @throws Never.
 */
function reviewStatus(experts: StructuredExpertOpinion[]): ExpertReviewStatus {
  if (experts.some(expert => expert.recommendation === "block")) return "rejected";
  if (experts.some(expert => expert.recommendation === "needs_more_evidence")) return "needs_changes";
  if (experts.some(expert => expert.recommendation === "approve_with_changes")) return "under_review";
  return "approved";
}

/**
 * One-line consensus summary: unanimous when all recommendations match, otherwise a
 * mixed-recommendations listing.
 * @param experts Structured opinions to summarize.
 * @returns A single consensus line.
 * @throws Never.
 */
function consensusForExperts(experts: StructuredExpertOpinion[]): string[] {
  const recommendations = unique(experts.map(expert => expert.recommendation));
  if (recommendations.length === 1) return [`All selected experts returned recommendation: ${recommendations[0]}.`];
  return [`Experts returned mixed recommendations: ${recommendations.join(", ")}.`];
}

/**
 * Group expert ids by recommendation; empty when all experts agree.
 * @param experts Structured opinions to compare.
 * @returns One "recommendation: ids" line per distinct recommendation, in first-seen
 *          order; empty when unanimous.
 * @throws Never.
 */
function disagreementsForExperts(experts: StructuredExpertOpinion[]): string[] {
  const byRecommendation = new Map<ExpertRecommendation, string[]>();
  for (const expert of experts) {
    byRecommendation.set(expert.recommendation, [...(byRecommendation.get(expert.recommendation) ?? []), expert.expertId]);
  }
  if (byRecommendation.size <= 1) return [];
  return [...byRecommendation.entries()].map(([recommendation, expertIds]) => `${recommendation}: ${expertIds.join(", ")}`);
}

/**
 * Flatten every expert's risk lines into one register: severity derived from the
 * expert's recommendation (block → high, needs_more_evidence → medium, else low) and
 * the expert's first mitigation attached when present.
 * @param experts Structured opinions to harvest.
 * @returns Register items in expert order, risks in extraction order.
 * @throws Never.
 */
function riskRegisterForExperts(experts: StructuredExpertOpinion[]): ExpertReviewRecord["riskRegister"] {
  return experts.flatMap(expert => expert.risks.map((risk, index) => ({
    id: stableId(`${expert.expertId}:${index}:${risk}`),
    severity: expert.recommendation === "block" ? "high" : expert.recommendation === "needs_more_evidence" ? "medium" : "low",
    description: risk,
    ownerExpertId: expert.expertId,
    ...(expert.mitigations[0] !== undefined ? { mitigation: expert.mitigations[0] } : {})
  })));
}

/**
 * Trim strings, drop empties, and deduplicate preserving first-occurrence order.
 * @param values Values to normalize.
 * @returns Unique non-empty trimmed values.
 * @throws Never.
 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

/**
 * Derive a stable short identifier from arbitrary text.
 * @param input Text to hash.
 * @returns First 16 hex characters of the SHA-256 digest.
 * @throws Never.
 */
function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Create the durable review store: the host's namespaced store when available, else an
 * in-memory fallback (non-durable, process-local).
 * @param services Host machine.
 * @returns A store of review records.
 * @throws Never.
 */
function createReviewStore(services: MatbotMachine): Store<ExpertReviewRecord> {
  return services.createStore?.<ExpertReviewRecord>("expert_panel_reviews") ?? new MemoryReviewStore();
}

/**
 * In-memory fallback {@link Store} for review records, used when the host offers no
 * `createStore`. Data is process-local and lost on restart; queries run against the
 * full record set.
 */
class MemoryReviewStore implements Store<ExpertReviewRecord> {
  private readonly docs = new Map<string, ExpertReviewRecord>();

  /**
   * Retrieve a review by id.
   * @param id Document identifier.
   * @returns The record, or null when absent.
   * @throws Never.
   */
  async get(id: string): Promise<ExpertReviewRecord | null> {
    return this.docs.get(id) ?? null;
  }

  /**
   * Insert or replace a review record.
   * @param id Document identifier.
   * @param value Full record to store.
   * @throws Never.
   */
  async set(id: string, value: ExpertReviewRecord): Promise<void> {
    this.docs.set(id, value);
  }

  /**
   * Filter, sort, and limit the stored records in memory. Each sort key is applied in
   * reverse so the first key dominates; comparisons are string-based via
   * `localeCompare`, with missing fields treated as empty strings.
   * @param query Optional filter/sort/limit.
   * @returns Matching records plus `total` counted before the limit is applied.
   * @throws Never.
   */
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

/**
 * Evaluate a filter tree against a record: equality leaves compare strictly, "and"
 * clauses are all-required, "or" clauses any-required.
 * @param item Record to test.
 * @param filter Filter tree.
 * @returns True when the record matches.
 * @throws Never.
 */
function matchesFilter(item: unknown, filter: StoreFilter): boolean {
  if (filter.op === "eq") return fieldValue(item, filter.field) === filter.value;
  if (filter.op === "and") return filter.clauses.every(clause => matchesFilter(item, clause));
  return filter.clauses.some(clause => matchesFilter(item, clause));
}

/**
 * Resolve a field path against a nested object.
 * @param item Object to traverse.
 * @param field Field path; a string is a single segment, an array successive segments.
 * @returns The value at the path, or undefined when traversal leaves an object.
 * @throws Never.
 */
function fieldValue(item: unknown, field: string | string[]): unknown {
  const parts = Array.isArray(field) ? field : [field];
  let value = item;
  for (const part of parts) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
