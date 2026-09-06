import type { ProviderAdapter, ProviderConfig, Message, Tool, CompletionEvent, HealthStatus } from '@matatbread/matbot-plugin-api';
import { parseSSE, fetchWithRetry, withCompletionDeadline, type CompletionDeadline } from '@matatbread/matbot-providers-base';
import { toOAIMessages, toOAITools } from './convert.js';

const DEFAULT_ENDPOINT   = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Feature switches read from `parameters.capabilities` that gate optional request fields
 * (tools, parallel tool calls) for endpoints with varying OpenAI compatibility.
 */
interface OpenAICompatCapabilities {
  tools?:                boolean;
  images?:               boolean;
  parallel_tool_calls?:  boolean;
  prompt_cache_key?:     boolean;
  chat_completions?:     boolean;
  interleaved_reasoning?: boolean;
}

/**
 * Extract the `capabilities` object from provider parameters.
 *
 * @param config - Provider configuration whose `parameters.capabilities` is consulted.
 * @returns The capabilities object, or an empty object when absent or not a plain object.
 * @throws Never.
 */
function capabilities(config: ProviderConfig): OpenAICompatCapabilities {
  const value = config.parameters?.['capabilities'];
  return (typeof value === 'object' && value !== null && !Array.isArray(value))
    ? value as OpenAICompatCapabilities
    : {};
}

/**
 * Resolve the chat-completions URL: `config.endpoint`, else `parameters.apiUrl`, else the OpenAI
 * default; trailing slashes are trimmed and `/chat/completions` is appended unless already
 * present.
 *
 * @param config - Provider configuration.
 * @returns The absolute chat-completions endpoint URL.
 * @throws Never.
 */
function endpoint(config: ProviderConfig): string {
  const raw = config.endpoint ?? (
    typeof config.parameters?.['apiUrl'] === 'string'
      ? config.parameters['apiUrl']
      : undefined
  ) ?? DEFAULT_ENDPOINT;

  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * Determine the output token cap sent with the request.
 *
 * @param config - Provider configuration; `parameters.maxOutputTokens` wins over `parameters.maxTokens`.
 * @returns The token limit, defaulting to 4096 when neither parameter is set.
 * @throws Never.
 */
function outputTokenLimit(config: ProviderConfig): number {
  const maxOutput = config.parameters?.['maxOutputTokens'];
  if (typeof maxOutput === 'number') return maxOutput;
  return config.parameters?.maxTokens ?? DEFAULT_MAX_TOKENS;
}

// OpenAI renamed `max_tokens` → `max_completion_tokens` for its newer models. The two are mutually
// exclusive — OpenAI returns 400 if both are present — and the o-series / gpt-5 / 4o models reject
// the legacy name outright. The rest of the compat ecosystem (DeepSeek, vLLM, llama.cpp, ollama,
// legacy gpt-4/3.5) still wants `max_tokens`; DeepSeek in particular *silently ignores*
// `max_completion_tokens`, leaving the cap unenforced. So the field is chosen per model, with an
// explicit `tokenLimitParam` override for names this heuristic can't anticipate.
/**
 * Choose the wire field name for the output token limit.
 *
 * @param config - Provider configuration; `parameters.tokenLimitParam` overrides the model-name heuristic.
 * @returns `'max_completion_tokens'` for o-series/gpt-5/4o-style models, `'max_tokens'` otherwise.
 * @throws Never.
 */
function tokenLimitParam(config: ProviderConfig): 'max_tokens' | 'max_completion_tokens' {
  const override = config.parameters?.['tokenLimitParam'];
  if (override === 'max_tokens' || override === 'max_completion_tokens') return override;
  const m = config.model.toLowerCase();
  return /^o\d/.test(m) || m.startsWith('gpt-5') || m.includes('4o')
    ? 'max_completion_tokens'
    : 'max_tokens';
}

/**
 * One streamed choice delta: text, reasoning content, and/or incremental tool-call fragments
 * keyed by `tool_calls[].index`.
 */
interface OAIDelta {
  role?:               string;
  content?:            string | null;
  reasoning_content?:  string | null;
  tool_calls?:  Array<{
    index:    number;
    id?:      string;
    function?: { name?: string; arguments?: string };
  }>;
}

/**
 * One chat-completions SSE chunk: an optional error, per-choice deltas with finish reasons, and
 * trailing usage totals.
 */
interface OAIChunk {
  error?: { message?: string; type?: string };
  choices?: Array<{ delta?: OAIDelta; finish_reason?: string | null }>;
  usage?:   { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

// A tool call whose arguments never parsed (truncated at the token limit, malformed provider
// output) is surfaced as a failed call instead of aborting the whole turn — the runner feeds a
// corrective `is_error` result back so the model can retry (spec R4).
/**
 * Finalize one accumulated tool call, parsing its streamed argument JSON.
 *
 * @param call - The accumulated block state: tool-call id, name, and raw argument text.
 * @param finishReason - The stream's finish reason, echoed into the parse error for guidance.
 * @returns A `tool-call` event with the parsed `input`; on parse failure the raw text is returned
 *          as `input` alongside a `parseError` message (bytes received plus finish-reason
 *          guidance) instead of throwing.
 * @throws Never.
 */
function flushToolCall(
  call: { id: string; name: string; args: string },
  finishReason: string | null,
): { type: 'tool-call'; id: string; name: string; input: unknown; parseError?: string } {
  try {
    return { type: 'tool-call', id: call.id, name: call.name, input: JSON.parse(call.args || '{}') };
  } catch {
    return {
      type: 'tool-call',
      id:   call.id || `unparsed-${crypto.randomUUID()}`,
      name: call.name,
      input: call.args,
      parseError:
        `${call.args.length} bytes received, finish_reason "${finishReason ?? 'none'}". ` +
        (finishReason === 'length'
          ? 'The response hit the token limit mid tool-call; increase the provider\'s maxTokens.'
          : 'The provider returned malformed tool arguments.'),
    };
  }
}

/**
 * Provider adapter for any OpenAI-compatible chat-completions endpoint (OpenAI, DeepSeek,
 * OpenRouter, vLLM, ollama, …). Streams over SSE via `fetch` (no SDK), handles model-specific
 * quirks (token-limit parameter naming, optional prompt-cache breakpoints), and emits usage,
 * reasoning, text, and tool-call events. Throws on HTTP errors and truncated tool-call JSON.
 */
export class OpenAICompatAdapter implements ProviderAdapter {
  /** Adapter name reported to the runtime; configurable for multiple compat profiles. */
  readonly name: string;

  /**
   * Create an adapter, optionally under a custom profile name.
   * @param name - Adapter name; defaults to `'openai-compat'`.
   */
  constructor(name = 'openai-compat') {
    this.name = name;
  }

  /**
   * Request a streaming completion.
   * @param messages The conversation, including system, tool, and reasoning content.
   * @param config Provider configuration (endpoint/model/apiUrl, credentials, parameters such as `capabilities`, `promptCache`, `tokenLimitParam`).
   * @param tools Tools offered to the model (omitted when capabilities say `tools: false`).
   * @param signal Abort signal for the underlying request.
   * @returns Stream of usage/text/thinking/tool-call events ending with `done`.
   * @throws On non-OK HTTP responses or tool-call arguments that fail to parse (e.g. truncation at the token limit).
   */
  complete(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    return withCompletionDeadline(signal, config.parameters, deadline => this.stream(messages, config, tools, deadline));
  }

  /**
   * Stream one OpenAI-compatible chat completion and translate it into matbot completion events.
   *
   * Builds the request body (model, model-appropriate token-limit field, messages, `stream: true`
   * with `include_usage`, tools unless `capabilities.tools` is `false`, optional
   * `parallel_tool_calls` and `temperature`, opt-in Anthropic-style cache breakpoints) and POSTs
   * it via {@link fetchWithRetry} bounded by `deadline.requestTimeoutMs`. Chunks are parsed with
   * {@link parseSSE}: usage is split into fresh versus cached input tokens, `reasoning_content`
   * streams as thinking deltas, `content` as text deltas, and tool-call arguments accumulate by
   * index and are flushed after a recognized terminal `finish_reason` (`tool_calls`, `stop`, or
   * `length`). A completion that produced nothing is logged as a warning rather than failing.
   *
   * @param messages - The conversation, including system, tool, and reasoning content.
   * @param config - Provider configuration (endpoint/model/apiUrl, credentials, parameters such as `capabilities`, `promptCache`, `tokenLimitParam`).
   * @param tools - Tools offered to the model (omitted when capabilities say `tools: false`).
   * @param deadline - Completion lifetime combining the caller's signal with request/idle/overall deadlines.
   * @returns Stream of usage/text/thinking/tool-call events ending with `done`.
   * @throws Error - On a non-OK HTTP response, malformed JSON, a non-object event, a chunk carrying an `error` field, content arriving after the finish reason, or a missing/unrecognized terminal `finish_reason`. Caller/deadline aborts propagate the combined signal's reason.
   */
  private async *stream(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    deadline: CompletionDeadline,
  ): AsyncIterable<CompletionEvent> {
    const signal = deadline.signal;
    const endpointUrl = endpoint(config);
    const apiKey   = config.credentials?.['apiKey'] ?? '';
    const caps     = capabilities(config);
    // Opt-in prompt caching (Anthropic-style breakpoints, e.g. via OpenRouter). Off by default so a
    // plain OpenAI / ollama endpoint never receives `cache_control` it can't parse.
    const cache    = config.parameters?.['promptCache'] === true;

    const body: Record<string, unknown> = {
      model:    config.model,
      [tokenLimitParam(config)]: outputTokenLimit(config),
      messages:       toOAIMessages(messages, cache),
      stream:         true,
      stream_options: { include_usage: true },
    };

    const toolDefs = toOAITools(tools, cache);
    if (toolDefs.length > 0 && caps.tools !== false) body['tools'] = toolDefs;

    if (typeof caps.parallel_tool_calls === 'boolean') {
      body['parallel_tool_calls'] = caps.parallel_tool_calls;
    }

    if (config.parameters?.temperature !== undefined) {
      body['temperature'] = config.parameters.temperature;
    }

    const res = await fetchWithRetry(endpointUrl, {
      method:  'POST',
      headers: {
        'content-type':  'application/json',
        'authorization': `Bearer ${apiKey}`,
        ...(config.credentials?.['organization']
          ? { 'openai-organization': config.credentials?.['organization'] }
          : {}),
      },
      body:   JSON.stringify(body),
      signal,
    }, undefined, { timeoutMs: deadline.requestTimeoutMs });

    deadline.progress();

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`OpenAI-compat ${res.status}: ${text}`);
    }

    // Accumulate streaming tool call arguments and reasoning per index
    const toolAccum    = new Map<number, { id: string; name: string; args: string }>();
    let reasoningAcc = '';
    // Diagnostic state: did the model emit anything, and how did it finish? Used to surface a
    // genuinely empty completion (e.g. an Azure content filter, or a provider returning a bare stop)
    // rather than letting it vanish into a no-reply turn.
    let sawAny     = false;
    let lastFinish: string | null | undefined;

    for await (const line of parseSSE(res.body, signal)) {
      let chunk: OAIChunk;
      try { chunk = JSON.parse(line) as OAIChunk; }
      catch { throw new Error('OpenAI-compatible stream contained malformed JSON.'); }
      if (chunk === null || typeof chunk !== 'object') throw new Error('OpenAI-compatible stream contained an invalid event.');
      if (chunk.error) throw new Error(`OpenAI-compatible stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      deadline.progress();

      // Usage (some providers send at end of stream). `prompt_tokens` is the full input including any
      // cache hit; `prompt_tokens_details.cached_tokens` is the cached portion (OpenAI auto-cache,
      // DeepSeek, and Anthropic-via-OpenRouter all report it). Split them so inputTokens is the fresh
      // (full-price) part and cacheReadTokens the discounted part — matching the anthropic adapter.
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        const prompt = chunk.usage.prompt_tokens ?? 0;
        yield {
          type:         'usage',
          inputTokens:  Math.max(0, prompt - cached),
          outputTokens: chunk.usage.completion_tokens ?? 0,
          ...(cached > 0 ? { cacheReadTokens: cached } : {}),
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta ?? {};

      if (lastFinish && (delta.content || delta.reasoning_content || delta.tool_calls?.length)) {
        throw new Error('OpenAI-compatible stream contained content after its finish reason.');
      }
      if (choice.finish_reason) lastFinish = choice.finish_reason;

      if (delta.reasoning_content) {
        sawAny = true;
        reasoningAcc += delta.reasoning_content;
        yield { type: 'thinking', delta: delta.reasoning_content };
      }
      if (delta.content) {
        sawAny = true;
        yield { type: 'text-delta', delta: delta.content };
      }
      if ((delta.tool_calls?.length ?? 0) > 0) sawAny = true;

      for (const tc of delta.tool_calls ?? []) {
        const acc = toolAccum.get(tc.index);
        if (!acc) {
          toolAccum.set(tc.index, {
            id:   tc.id   ?? '',
            name: tc.function?.name ?? '',
            args: tc.function?.arguments ?? '',
          });
        } else {
          if (tc.id)                       acc.id   = tc.id;
          if (tc.function?.name)           acc.name = tc.function.name;
          if (tc.function?.arguments)      acc.args += tc.function.arguments;
        }
      }

    }

    // Wait through trailing usage/error frames before releasing executable calls.
    if (!lastFinish || !['tool_calls', 'stop', 'length'].includes(lastFinish)) {
      throw new Error(`OpenAI-compatible completion is incomplete or rejected: finish_reason=${lastFinish ?? '(missing)'}.`);
    }
    if (reasoningAcc) yield { type: 'reasoning-block', reasoning: reasoningAcc };
    for (const [, call] of toolAccum) {
      yield flushToolCall(call, lastFinish);
    }

    if (!sawAny) {
      console.warn(
        `[openai-compat] empty completion: finish_reason=${lastFinish ?? '(none)'}; sent ${messages.length} messages ` +
        `(roles: ${messages.map(m => m.role).join(',')}). A 'content_filter' finish_reason means the endpoint blocked it.`,
      );
    }
    yield { type: 'done' };
  }

  /**
   * Lightweight health check — always reports `ok` without contacting the endpoint.
   * @returns Current health status.
   */
  async health(): Promise<HealthStatus> {
    return { status: 'ok' };
  }
}
