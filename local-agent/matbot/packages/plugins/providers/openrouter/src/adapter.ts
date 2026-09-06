import type { CompletionEvent, HealthStatus, Message, ProviderAdapter, ProviderConfig, Tool } from '@matatbread/matbot-plugin-api';
import { fetchWithRetry, parseSSEFrames, type CompletionDeadline, withCompletionDeadline } from '@matatbread/matbot-providers-base';
import { toOAIMessages, toOAITools } from '@matatbread/matbot-provider-openai-compat';
import { validateOpenRouterConfig } from './config.js';
import { OpenRouterError, openRouterHttpError, openRouterStreamError } from './errors.js';

type UnknownRecord = Record<string, unknown>;

interface OpenRouterDelta {
  content?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  reasoning_details?: unknown;
  tool_calls?: unknown;
}

interface AccumulatedToolCall { id: string; name: string; args: string }

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function hasUnsupportedAttachment(messages: readonly Message[]): string | undefined {
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'document' || part.type === 'audio' || part.type === 'file-ref') return part.type;
    }
  }
  return undefined;
}

function hasImages(messages: readonly Message[]): boolean {
  return messages.some(message => message.content.some(part => part.type === 'image' || part.type === 'image-url'));
}

function completionIdentity(chunk: UnknownRecord): Omit<Extract<CompletionEvent, { type: 'completion-metadata' }>, 'type' | 'finishReason' | 'truncated'> {
  const upstreamProvider = string(chunk['provider']) ?? string(chunk['provider_name']);
  const returnedModel = string(chunk['model']);
  const generationId = string(chunk['id']);
  return {
    gateway: 'openrouter',
    requestedModel: '', // filled by the caller: the request model is never trusted from a response frame.
    ...(returnedModel !== undefined ? { returnedModel } : {}),
    ...(generationId !== undefined ? { generationId } : {}),
    ...(upstreamProvider !== undefined ? { upstreamProvider } : {}),
  };
}

function sameMetadata(
  left: Omit<Extract<CompletionEvent, { type: 'completion-metadata' }>, 'type'> | undefined,
  right: Omit<Extract<CompletionEvent, { type: 'completion-metadata' }>, 'type'>,
): boolean {
  return left?.requestedModel === right.requestedModel && left?.returnedModel === right.returnedModel &&
    left?.generationId === right.generationId && left?.upstreamProvider === right.upstreamProvider &&
    left?.finishReason === right.finishReason && left?.truncated === right.truncated;
}

function finishReason(value: unknown): 'stop' | 'tool_calls' | 'length' | undefined {
  if (value === null || value === undefined) return undefined;
  if (value === 'stop' || value === 'tool_calls' || value === 'length') return value;
  if (value === 'content_filter' || value === 'error') throw openRouterStreamError(`completion ended with ${value}`);
  throw openRouterStreamError(`completion returned unsupported finish reason ${String(value)}`);
}

function usageEvent(raw: unknown): Extract<CompletionEvent, { type: 'usage' }> | undefined {
  if (!isRecord(raw)) return undefined;
  const prompt = nonNegativeInteger(raw['prompt_tokens']);
  const output = nonNegativeInteger(raw['completion_tokens']);
  const promptDetails = isRecord(raw['prompt_tokens_details']) ? raw['prompt_tokens_details'] : {};
  const cached = nonNegativeInteger(promptDetails['cached_tokens']) ?? 0;
  const created = nonNegativeInteger(promptDetails['cache_write_tokens']) ?? 0;
  if (prompt !== undefined && cached + created > prompt) {
    throw openRouterStreamError('usage counters are inconsistent (cache subsets exceed prompt tokens)');
  }
  const cost = raw['cost'];
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) {
    throw openRouterStreamError('usage cost is invalid');
  }
  if (prompt === undefined && output === undefined && cost === undefined) return undefined;
  // Cache counters partition `prompt_tokens`. Without that total they cannot be represented
  // truthfully: emitting cache counts beside zero fresh input would violate the runner's token
  // invariant. Keep the independently known output/cost, but leave the partition unknown.
  const hasPromptTotal = prompt !== undefined;
  return {
    type: 'usage', inputTokens: Math.max(0, (prompt ?? 0) - cached - created), outputTokens: output ?? 0,
    ...(hasPromptTotal && cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(hasPromptTotal && created > 0 ? { cacheCreationTokens: created } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}

function flushToolCall(call: AccumulatedToolCall, reason: string): Extract<CompletionEvent, { type: 'tool-call' }> {
  if (!call.id || !call.name || /[\u0000-\u001f\u007f]/.test(call.id) || /[\u0000-\u001f\u007f]/.test(call.name)) {
    throw openRouterStreamError('tool call is missing a valid id or function name');
  }
  try {
    return { type: 'tool-call', id: call.id, name: call.name, input: JSON.parse(call.args || '{}') };
  } catch {
    return {
      type: 'tool-call', id: call.id, name: call.name, input: call.args,
      parseError: `${call.args.length} bytes received, finish_reason "${reason}". ` +
        (reason === 'length' ? 'The response hit the output limit mid tool-call; increase maxTokens.' : 'The provider returned malformed tool arguments.'),
    };
  }
}

/**
 * Dedicated OpenRouter Chat Completions adapter. It shares neutral OpenAI message/tool conversion
 * with the compatible adapter, but owns the gateway's strict host policy, dialect fields,
 * completion integrity, reasoning replay, and safe errors.
 */
export class OpenRouterAdapter implements ProviderAdapter {
  readonly name = 'openrouter';
  private readonly fetchImpl: typeof fetch | undefined;

  /** A fetch injection exists solely for deterministic local fixtures; profiles cannot configure another host. */
  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl;
  }

  complete(messages: Message[], config: ProviderConfig, tools: readonly Tool[], signal: AbortSignal): AsyncIterable<CompletionEvent> {
    return withCompletionDeadline(signal, config.parameters, deadline => this.stream(messages, config, tools, deadline));
  }

  private async *stream(
    messages: Message[], config: ProviderConfig, tools: readonly Tool[], deadline: CompletionDeadline,
  ): AsyncIterable<CompletionEvent> {
    const profile = validateOpenRouterConfig(config);
    const unsupported = hasUnsupportedAttachment(messages);
    if (unsupported !== undefined) {
      throw new Error(`OpenRouter profile "${config.name}" cannot submit ${unsupported} blocks directly. Extract or attach supported prompt context first.`);
    }
    if (hasImages(messages) && profile.capabilities.images !== true) {
      throw new Error(`OpenRouter profile "${config.name}" has unverified or disabled image support. Enable parameters.capabilities.images only for a compatible model.`);
    }

    const body: Record<string, unknown> = {
      model: profile.model,
      messages: toOAIMessages(messages, profile.cache, { apiOrigin: profile.apiOrigin, model: profile.model }),
      stream: true,
      max_tokens: profile.outputTokens,
      provider: profile.routing,
    };
    if (profile.temperature !== undefined) body['temperature'] = profile.temperature;
    if (profile.topP !== undefined) body['top_p'] = profile.topP;
    if (profile.stop !== undefined) body['stop'] = profile.stop;
    if (profile.reasoning !== undefined) body['reasoning'] = profile.reasoning;

    const toolDefs = toOAITools(tools, profile.cache);
    const toolsEnabled = toolDefs.length > 0 && profile.capabilities.tools !== false;
    if (toolsEnabled) {
      body['tools'] = toolDefs;
      if (profile.capabilities.parallel_tool_calls === true) body['parallel_tool_calls'] = true;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${profile.apiKey}`,
    };
    if (profile.appTitle !== undefined) headers['x-openrouter-title'] = profile.appTitle;
    if (profile.httpReferer !== undefined) headers['http-referer'] = profile.httpReferer;

    const response = await fetchWithRetry(profile.completionUrl, {
      method: 'POST', headers, body: JSON.stringify(body), signal: deadline.signal, redirect: 'error',
    }, undefined, {
      timeoutMs: deadline.requestTimeoutMs, honorRetryAfterFully: true,
      shouldRetryError: error => !/redirect/i.test(error instanceof Error ? error.message : String(error)),
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    });
    deadline.progress();
    if (!response.ok || !response.body) throw await openRouterHttpError(response);

    const toolsByIndex = new Map<number, AccumulatedToolCall>();
    const reasoningDetails: unknown[] = [];
    let reasoningText = '';
    let lastUsage: Extract<CompletionEvent, { type: 'usage' }> | undefined;
    let terminal: 'stop' | 'tool_calls' | 'length' | undefined;
    let sawSentinel = false;
    let metadata: Omit<Extract<CompletionEvent, { type: 'completion-metadata' }>, 'type'> | undefined;

    for await (const frame of parseSSEFrames(response.body, deadline.signal)) {
      if (frame.type === 'done') {
        sawSentinel = true;
        break;
      }
      let chunk: UnknownRecord;
      try { chunk = JSON.parse(frame.data) as UnknownRecord; }
      catch { throw openRouterStreamError('received malformed JSON'); }
      if (!isRecord(chunk)) throw openRouterStreamError('received a non-object event');
      if (chunk['error'] !== undefined) {
        const err = isRecord(chunk['error']) ? chunk['error'] : {};
        const generationId = string(chunk['id']);
        throw openRouterStreamError(string(err['message']) ?? 'gateway returned an error event', {
          ...(generationId !== undefined ? { generationId } : {}),
          receivedOutput: terminal !== undefined,
        });
      }
      deadline.progress();

      const identity = { ...completionIdentity(chunk), requestedModel: profile.model };
      if (!sameMetadata(metadata, identity)) {
        metadata = { ...metadata, ...identity };
        yield { type: 'completion-metadata', ...metadata };
      }
      const usage = usageEvent(chunk['usage']);
      if (usage !== undefined) lastUsage = usage;

      const choices = chunk['choices'];
      if (choices === undefined) continue;
      if (!Array.isArray(choices)) throw openRouterStreamError('choices must be an array');
      const choice = choices[0];
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice['delta']) ? choice['delta'] as OpenRouterDelta : {};
      const hadTerminal = terminal !== undefined;
      const reason = finishReason(choice['finish_reason']);
      if (reason !== undefined) {
        if (terminal !== undefined && terminal !== reason) throw openRouterStreamError('received contradictory finish reasons');
        terminal = reason;
      }
      const text = string(delta.content);
      const reasoning = string(delta.reasoning);
      const reasoningAlias = string(delta.reasoning_content);
      const details = delta.reasoning_details;
      const toolCalls = delta.tool_calls;
      // OpenRouter deliberately repeats the terminal finish reason in its final usage frame. That
      // Chat Completions accounting frame has an empty content delta (and often role=assistant),
      // so it is not a late response. Any substantive later text, reasoning, opaque detail, or
      // tool call remains contradictory and must never reach Cortex's runner.
      const hasLateText = text !== undefined && text.length > 0;
      const hasLateReasoning = (reasoning !== undefined && reasoning.length > 0) ||
        (reasoningAlias !== undefined && reasoningAlias.length > 0);
      const hasLateDetails = details !== undefined && (!Array.isArray(details) || details.length > 0);
      const hasLateToolCalls = toolCalls !== undefined && (!Array.isArray(toolCalls) || toolCalls.length > 0);
      if (hadTerminal && (hasLateText || hasLateReasoning || hasLateDetails || hasLateToolCalls)) {
        throw openRouterStreamError('received content after the terminal finish reason', { receivedOutput: true });
      }
      if (reasoning !== undefined) {
        reasoningText += reasoning;
        yield { type: 'thinking', delta: reasoning };
      }
      if (reasoningAlias !== undefined && reasoningAlias !== reasoning) {
        reasoningText += reasoningAlias;
        yield { type: 'thinking', delta: reasoningAlias };
      }
      if (Array.isArray(details)) reasoningDetails.push(...details);
      else if (details !== undefined) throw openRouterStreamError('reasoning_details must be an array');
      if (text !== undefined) yield { type: 'text-delta', delta: text };
      if (toolCalls !== undefined) {
        if (!toolsEnabled) throw openRouterStreamError('received tool calls when this profile did not offer tools');
        if (!Array.isArray(toolCalls)) throw openRouterStreamError('tool_calls must be an array');
        for (const rawCall of toolCalls) {
          if (!isRecord(rawCall) || !Number.isInteger(rawCall['index']) || (rawCall['index'] as number) < 0) {
            throw openRouterStreamError('tool call has no valid index');
          }
          const index = rawCall['index'] as number;
          const functionPart = isRecord(rawCall['function']) ? rawCall['function'] : {};
          const current = toolsByIndex.get(index);
          if (current === undefined) {
            toolsByIndex.set(index, { id: string(rawCall['id']) ?? '', name: string(functionPart['name']) ?? '', args: string(functionPart['arguments']) ?? '' });
          } else {
            if (string(rawCall['id']) !== undefined) current.id = string(rawCall['id'])!;
            if (string(functionPart['name']) !== undefined) current.name = string(functionPart['name'])!;
            if (string(functionPart['arguments']) !== undefined) current.args += string(functionPart['arguments'])!;
          }
        }
      }
    }

    if (!sawSentinel) throw openRouterStreamError('stream ended before the [DONE] sentinel', { ...(metadata?.generationId !== undefined ? { generationId: metadata.generationId } : {}) });
    if (terminal === undefined) throw openRouterStreamError('stream ended without a terminal finish reason', { ...(metadata?.generationId !== undefined ? { generationId: metadata.generationId } : {}) });
    const terminalMetadata = { ...metadata, gateway: 'openrouter', requestedModel: profile.model, finishReason: terminal, ...(terminal === 'length' ? { truncated: true } : {}) };
    if (!sameMetadata(metadata, terminalMetadata)) yield { type: 'completion-metadata', ...terminalMetadata };
    if (reasoningDetails.length > 0 || reasoningText) {
      yield {
        type: 'unknown-block', blockType: 'openrouter.reasoning.v1', raw: {
          version: 1, apiOrigin: profile.apiOrigin, requestedModel: profile.model,
          ...(metadata?.returnedModel !== undefined ? { returnedModel: metadata.returnedModel } : {}),
          ...(reasoningDetails.length > 0 ? { details: reasoningDetails } : {}),
          ...(reasoningText ? { reasoning: reasoningText } : {}),
        },
      };
    }
    // A `stop` response is not a tool-call response. Never let a malformed/malicious gateway
    // frame turn into local work just because it happened to carry a `tool_calls` delta. A
    // `length` response keeps Cortex's corrective-result path, but is never executed because the
    // synthetic parse error tells the runner that the tool arguments were truncated.
    if (toolsByIndex.size > 0 && terminal === 'stop') {
      throw openRouterStreamError('completion ended with stop after emitting tool calls', { receivedOutput: true });
    }
    for (const call of toolsByIndex.values()) {
      const event = flushToolCall(call, terminal);
      if (terminal === 'length') {
        yield {
          ...event,
          parseError: event.parseError ??
            'The response hit the output limit after emitting a tool call; Cortex did not execute it. Increase maxTokens and re-issue the call.',
        };
      } else {
        yield event;
      }
    }
    if (lastUsage !== undefined) yield lastUsage;
    yield { type: 'done' };
  }

  async health(): Promise<HealthStatus> {
    // Health intentionally describes local adapter liveness. Authenticated key/model diagnostics
    // are explicit actions because they consume network budget and must never run on every health probe.
    return { status: 'ok' };
  }
}

export { OpenRouterError };
