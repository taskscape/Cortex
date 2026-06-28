import type {
  ExpertConfig,
  ExpertOpinion,
  ExpertSource,
  MatbotMachine,
  MatbotPluginSpec,
  Tool,
  ToolContext,
  ToolEvent
} from "./types.js";
import { loadExpertConfig } from "./config.js";
import { FileExpertKnowledge } from "./file-knowledge.js";

interface ExpertPanelInput {
  action?: "list" | "ask";
  question?: string;
  experts?: string[];
  mode?: "parallel" | "review" | "debate";
  maxCitationsPerExpert?: number;
  synthesize?: boolean;
}

interface ExpertRuntime {
  config: ExpertConfig;
  knowledge: FileExpertKnowledge;
}

class ExpertPanel {
  constructor(
    private readonly services: MatbotMachine,
    private readonly experts: ExpertRuntime[],
    private readonly defaultProvider?: string
  ) {}

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
    const panel = new ExpertPanel(
      services,
      config.experts.map(expert => ({ config: expert, knowledge: new FileExpertKnowledge(expert) })),
      config.defaultProvider
    );

    services.tools.register(createExpertPanelTool(panel));
  }
};

export default plugin;

function createExpertPanelTool(panel: ExpertPanel): Tool {
  return {
    name: "expert_panel",
    description:
      "Ask a selected panel of domain experts to answer the same question from grounded knowledge files, then optionally synthesize their opinions. " +
      "Use this when the user wants multiple perspectives, disagreement, review, or a decision informed by design, finance, engineering, or other configured experts.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "ask"],
          default: "ask",
          description: "list: return configured expert metadata. ask: run the panel. Defaults to ask."
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

        if (!parsed.question) {
          yield { type: "error", message: 'expert_panel requires "question".' };
          return;
        }

        try {
          yield { type: "progress", pct: 10, message: "Running expert panel" };
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
  const action = value.action === "list" ? "list" : "ask";
  const experts = Array.isArray(value.experts)
    ? value.experts.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;

  return {
    action,
    question: typeof value.question === "string" ? value.question.trim() : undefined,
    experts,
    mode,
    maxCitationsPerExpert: typeof value.maxCitationsPerExpert === "number" ? value.maxCitationsPerExpert : undefined,
    synthesize: typeof value.synthesize === "boolean" ? value.synthesize : true
  };
}

function expertPrompt(question: string, mode: string, sources: ExpertSource[]): string {
  return [
    `Question:\n${question}`,
    `Panel mode: ${mode}`,
    "Use your domain expertise and the grounded sources below. If the sources do not cover part of the question, say so explicitly instead of inventing evidence.",
    "Return sections: answer, evidence, assumptions, risks, confidence.",
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
