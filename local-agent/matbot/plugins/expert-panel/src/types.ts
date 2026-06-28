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

export interface MatbotMachine {
  singleTurn(req: SingleTurnRequest): Promise<CompletionResponse>;
  tools: ToolRegistry;
  providers: ReadonlyMap<string, unknown>;
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

export interface ExpertOpinion {
  expertId: string;
  title: string;
  answer: string;
  citations: Array<{
    id: string;
    path: string;
    title: string;
    score: number;
  }>;
  usage: { inputTokens: number; outputTokens: number };
}
