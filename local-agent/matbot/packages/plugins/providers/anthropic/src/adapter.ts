import type { ProviderAdapter, ProviderConfig, Message, Tool, CompletionEvent, HealthStatus } from '@matatbread/matbot-plugin-api';
import { parseSSE, fetchWithRetry, withCompletionDeadline, type CompletionDeadline } from '@matatbread/matbot-providers-base';
import { toAnthropicMessages, toAnthropicSystem, toAnthropicTools } from './convert.js';

const DEFAULT_ENDPOINT   = 'https://api.anthropic.com';
const ANTHROPIC_VERSION  = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Minimal shape of an Anthropic SSE event — just the discriminating `type` plus loose payload
 * fields, enough to drive completion-event emission without modelling the full API.
 */
interface AEvent { type: string; [k: string]: unknown }

/**
 * Provider adapter for the Anthropic Messages API. Streams completions over SSE via `fetch`
 * (no SDK), translating matbot messages/tools to Anthropic's wire format and emitting
 * text deltas, thinking blocks (including redacted and unknown block types), tool calls,
 * usage, and a final `done`. Throws on truncated/malformed tool-call JSON and stream errors.
 */
export class AnthropicAdapter implements ProviderAdapter {
  /** Adapter name used in provider configuration (`anthropic`). */
  readonly name = 'anthropic';

  /**
   * Request a streaming completion.
   * @param messages The conversation, including system, tool, and thinking content.
   * @param config Provider configuration (endpoint, model, credentials, parameters).
   * @param tools Tools offered to the model.
   * @param signal Abort signal for the underlying request.
   * @returns Stream of completion events ending with `done`.
   * @throws On non-OK HTTP responses, mid-stream `error` events, or tool-call arguments that fail to parse (e.g. truncation at max_tokens).
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
   * Stream one Anthropic Messages API completion and translate it into matbot completion events.
   *
   * Builds the request from the neutral conversation via {@link toAnthropicMessages},
   * {@link toAnthropicSystem}, and {@link toAnthropicTools}; always sets `stream: true`; takes
   * `max_tokens` from `parameters.maxTokens` (default 4096) and `temperature` when configured;
   * sends the prompt-caching beta header plus the interleaved-thinking beta when
   * `parameters.thinking` is set. The POST goes through {@link fetchWithRetry} bounded by
   * `deadline.requestTimeoutMs`, and SSE frames are parsed with {@link parseSSE}:
   * `message_start` yields input usage (including cache read/creation counts),
   * `content_block_delta` yields text and thinking deltas, closed blocks yield
   * thinking/redacted-thinking/unknown-block/tool-call events, `message_delta` tracks the stop
   * reason and output usage, and `message_stop` flushes any tool block left open (truncation can
   * end the response before `content_block_stop`) before `done`.
   *
   * @param messages - The conversation, including system, tool, and thinking content.
   * @param config - Provider configuration (endpoint, model, credentials, parameters).
   * @param tools - Tools offered to the model.
   * @param deadline - Completion lifetime combining the caller's signal with request/idle/overall deadlines.
   * @returns Stream of completion events ending with `done`.
   * @throws Error - On a non-OK HTTP response (status plus body text), a mid-stream `error` event, or when the stream ends before `message_stop`. Caller/deadline aborts propagate the combined signal's reason.
   */
  private async *stream(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    deadline: CompletionDeadline,
  ): AsyncIterable<CompletionEvent> {
    const signal = deadline.signal;
    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    const apiKey   = config.credentials?.['apiKey'] ?? '';

    const body: Record<string, unknown> = {
      model:      config.model,
      max_tokens: config.parameters?.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages:   toAnthropicMessages(messages),
      stream:     true,
    };

    const system = toAnthropicSystem(messages);
    if (system) body['system'] = system;

    const toolDefs = toAnthropicTools(tools);
    if (toolDefs.length > 0) body['tools'] = toolDefs;

    if (config.parameters?.temperature !== undefined) {
      body['temperature'] = config.parameters.temperature;
    }

    const headers: Record<string, string> = {
      'content-type':     'application/json',
      'x-api-key':        apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };

    // Enable extended thinking + prompt caching betas if requested
    const betas: string[] = ['prompt-caching-2024-07-31'];
    if (config.parameters?.['thinking']) betas.push('interleaved-thinking-2025-05-14');
    headers['anthropic-beta'] = betas.join(',');

    const res = await fetchWithRetry(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers,
      body:   JSON.stringify(body),
      signal,
    }, undefined, { timeoutMs: deadline.requestTimeoutMs });

    deadline.progress();

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Anthropic ${res.status}: ${text}`);
    }

    // A tool_use block whose argument JSON failed to parse — almost always truncation mid-stream
    // (max_tokens) or malformed provider output. Surfaced as a failed call (parseError) so the
    // runner feeds a corrective error back to the model instead of aborting the turn (spec R4).
    /**
     * Finalize one accumulated tool call, parsing its streamed argument JSON.
     *
     * @param call - The accumulated block state: tool-use id, name, and raw argument text.
     * @param stop - The stop reason observed so far, echoed into the parse error when present.
     * @returns A `tool-call` event with the parsed `input`; on parse failure the raw text is
     *          returned as `input` alongside a `parseError` message (bytes received plus
     *          stop-reason guidance) instead of throwing.
     * @throws Never.
     */
    const flushToolCall = (
      call: { id: string; name: string; json: string },
      stop: string | undefined,
    ): { type: 'tool-call'; id: string; name: string; input: unknown; parseError?: string } => {
      try {
        return { type: 'tool-call', id: call.id, name: call.name, input: JSON.parse(call.json || '{}') };
      } catch {
        return {
          type: 'tool-call',
          id:   call.id || `unparsed-${crypto.randomUUID()}`,
          name: call.name,
          input: call.json,
          parseError:
            `${call.json.length} bytes received${stop ? `, stop_reason "${stop}"` : ''}. ` +
            (stop === 'max_tokens'
              ? 'The response hit the token limit mid tool-call; increase the provider\'s maxTokens.'
              : 'The provider returned malformed tool arguments.'),
        };
      }
    };

    // Accumulate content block state per index
    const toolInputs      = new Map<number, { id: string; name: string; json: string }>();
    const thinkingBlocks  = new Map<number, { thinking: string; signature: string }>();
    const redactedBlocks  = new Map<number, { data: string }>();
    const unknownBlocks   = new Map<number, { blockType: string; raw: unknown }>();
    let inputTokens = 0;
    let stopReason: string | undefined;

    for await (const line of parseSSE(res.body, signal)) {
      let ev: AEvent;
      try { ev = JSON.parse(line) as AEvent; } catch { continue; }
      if (ev.type !== 'ping') deadline.progress();

      switch (ev['type']) {
        case 'message_start': {
          const usage = (ev['message'] as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined)?.usage;
          if (usage?.input_tokens) {
            inputTokens = usage.input_tokens;
            yield {
              type: 'usage', inputTokens, outputTokens: 0,
              ...(usage.cache_read_input_tokens     ? { cacheReadTokens:     usage.cache_read_input_tokens     } : {}),
              ...(usage.cache_creation_input_tokens ? { cacheCreationTokens: usage.cache_creation_input_tokens } : {}),
            };
          }
          break;
        }

        case 'content_block_start': {
          const idx   = ev['index'] as number;
          const block = ev['content_block'] as { type: string; id?: string; name?: string; data?: string };
          if (block.type === 'tool_use') {
            toolInputs.set(idx, { id: block.id ?? '', name: block.name ?? '', json: '' });
          } else if (block.type === 'thinking') {
            thinkingBlocks.set(idx, { thinking: '', signature: '' });
          } else if (block.type === 'redacted_thinking') {
            redactedBlocks.set(idx, { data: block.data ?? '' });
          } else if (block.type !== 'text') {
            unknownBlocks.set(idx, { blockType: block.type, raw: ev['content_block'] });
          }
          break;
        }

        case 'content_block_delta': {
          const idx   = ev['index'] as number;
          const delta = ev['delta'] as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string };
          if (delta.type === 'text_delta' && delta.text) {
            yield { type: 'text-delta', delta: delta.text };
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            const call = toolInputs.get(idx);
            if (call) call.json += delta.partial_json;
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'thinking', delta: delta.thinking };
            const tb = thinkingBlocks.get(idx);
            if (tb) tb.thinking += delta.thinking;
          } else if (delta.type === 'signature_delta' && delta.signature) {
            const tb = thinkingBlocks.get(idx);
            if (tb) tb.signature = delta.signature;
          }
          break;
        }

        case 'content_block_stop': {
          const idx  = ev['index'] as number;
          const call = toolInputs.get(idx);
          if (call) {
            yield flushToolCall(call, stopReason);
            toolInputs.delete(idx);
          }
          const tb = thinkingBlocks.get(idx);
          if (tb) {
            yield { type: 'thinking-block', thinking: tb.thinking, signature: tb.signature };
            thinkingBlocks.delete(idx);
          }
          const rb = redactedBlocks.get(idx);
          if (rb) {
            yield { type: 'redacted-thinking', data: rb.data };
            redactedBlocks.delete(idx);
          }
          const ub = unknownBlocks.get(idx);
          if (ub) {
            yield { type: 'unknown-block', blockType: ub.blockType, raw: ub.raw };
            unknownBlocks.delete(idx);
          }
          break;
        }

        case 'message_delta': {
          const stop = (ev['delta'] as { stop_reason?: string } | undefined)?.stop_reason;
          if (stop) stopReason = stop;
          const usage = (ev['usage'] as { output_tokens?: number } | undefined);
          if (usage?.output_tokens) {
            yield { type: 'usage', inputTokens: 0, outputTokens: usage.output_tokens };
          }
          break;
        }

        case 'message_stop': {
          // Flush any tool block the stream left open (truncation can end the response before
          // content_block_stop). A complete-but-unclosed block still parses; an incomplete one
          // is recorded as truncated.
          for (const [, call] of toolInputs) {
            yield flushToolCall(call, stopReason);
          }
          toolInputs.clear();
          yield { type: 'done' };
          return;
        }

        case 'error': {
          const err = ev['error'] as { message?: string } | undefined;
          throw new Error(`Anthropic stream error: ${err?.message ?? JSON.stringify(ev)}`);
        }
      }
    }
    throw new Error('Anthropic completion is incomplete: stream ended before message_stop.');
  }

  /**
   * Lightweight health check — reports `ok` without contacting the API.
   * @returns Current health status.
   */
  async health(): Promise<HealthStatus> {
    // Lightweight check — just verify credentials key is present
    return { status: 'ok', latencyMs: 0 };
  }
}
