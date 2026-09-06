import type { Message, Tool, JSONSchema } from '@matatbread/matbot-plugin-api';

// ── Internal OpenAI API types ─────────────────────────────────────────────────

/** The four chat-completions message roles. */
type OAIRole    = 'system' | 'user' | 'assistant' | 'tool';

/** One message in OpenAI chat-completions wire format. */
export interface OAIMessage {
  role:         OAIRole;
  content?:     string | OAIContentPart[] | null;
  tool_calls?:  OAIToolCall[];
  tool_call_id?: string;
  name?:        string;
}

/** Anthropic-style `cache_control` directive, honoured by OpenRouter-routed providers. */
type CacheControl = { type: 'ephemeral' };

/** One multimodal content part: text (optionally ending a cache breakpoint) or an image URL. */
type OAIContentPart =
  | { type: 'text';      text: string; cache_control?: CacheControl }
  | { type: 'image_url'; image_url: { url: string } };

/** One function tool call emitted by the model. */
interface OAIToolCall {
  id:       string;
  type:     'function';
  function: { name: string; arguments: string };
}

/** A tool definition in OpenAI's wire format, optionally carrying a cache breakpoint. */
export interface OAIToolDef {
  type:     'function';
  function: { name: string; description: string; parameters: JSONSchema };
  cache_control?: CacheControl;
}

// ── Message conversion ────────────────────────────────────────────────────────

// Prompt caching for OpenAI-compatible providers that honour Anthropic-style breakpoints when
// routed through OpenRouter (Anthropic / Gemini / Qwen). Opt-in via the provider's `promptCache`
// parameter — a plain OpenAI or local (ollama/vLLM) endpoint that doesn't understand `cache_control`
// must never see it, so the default stays the flat OpenAI wire shape. Mirrors the native anthropic
// adapter: cache the system prefix, the tool defs, and the second-to-last user turn (the newest
// content is left fresh — it changes next request anyway, so caching it just churns the write).
/**
 * Mark one message's last text content with an ephemeral `cache_control` breakpoint, converting a
 * plain-string `content` to a single text part when necessary.
 *
 * @param msg - The message to mark; mutated in place.
 * @throws Never.
 */
function markCacheable(msg: OAIMessage): void {
  if (typeof msg.content === 'string') {
    msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  if (Array.isArray(msg.content)) {
    for (let i = msg.content.length - 1; i >= 0; i--) {
      const part = msg.content[i]!;
      if (part.type === 'text') { part.cache_control = { type: 'ephemeral' }; return; }
    }
  }
}

/**
 * Add cache breakpoints to a converted message list: on the last `system` message and on the
 * second-to-last user turn. The newest user turn stays fresh — it changes next request anyway.
 *
 * @param result - The converted messages; mutated in place.
 * @throws Never.
 */
function applyCacheBreakpoints(result: OAIMessage[]): void {
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i]!.role === 'system') { markCacheable(result[i]!); break; }
  }
  const userTurns = result.reduce<number[]>((acc, m, i) => { if (m.role === 'user') acc.push(i); return acc; }, []);
  if (userTurns.length >= 2) markCacheable(result[userTurns[userTurns.length - 2]!]!);
}

/**
 * Serialize a matbot tool result for the `tool` role. Error results carry an explicit `is_error`
 * marker inside the JSON payload so OpenAI-compatible models can distinguish failures from
 * successful payloads (the wire format itself has no error flag — spec R4).
 *
 * @param result - The tool's return value; `undefined` and `null` both become JSON `null`.
 * @param isError - When true, embeds `is_error: true` in the payload: object results are spread
 *                  and extended, anything else is wrapped as `{ result: String(result) }`.
 * @returns The JSON string sent as the tool message's `content`.
 * @throws When `result` is not JSON-serializable (e.g. a circular structure).
 */
export function serializeToolResult(result: unknown, isError?: boolean): string {
  if (!isError) return JSON.stringify(result ?? null);
  const base: Record<string, unknown> = result !== null && typeof result === 'object' && !Array.isArray(result)
    ? { ...result as Record<string, unknown> }
    : { result: String(result ?? null) };
  base['is_error'] = true;
  return JSON.stringify(base);
}

/**
 * Convert neutral matbot messages to OpenAI chat-completions format. System messages become a
 * single `system` message; tool results become `tool` messages; provider-native thinking blocks
 * are stripped; images become data/URL content parts; text-only messages collapse to plain
 * strings; empty assistant turns are dropped. With `cache`, marks Anthropic-style ephemeral
 * breakpoints on the system message and second-to-last user turn.
 *
 * @param messages The conversation in neutral format.
 * @param cache Add `cache_control` breakpoints (only for endpoints that honour them).
 * @returns OpenAI-format messages.
 */
export function toOAIMessages(messages: Message[], cache = false): OAIMessage[] {
  const result: OAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = msg.content
        .filter(c => c.type === 'text')
        .map(c => (c as { type: 'text'; text: string }).text)
        .join('\n\n');
      result.push({ role: 'system', content: text });
      continue;
    }

    if (msg.role === 'tool') {
      for (const c of msg.content) {
        if (c.type === 'tool-result') {
          result.push({
            role:         'tool',
            tool_call_id: c.id,
            // `?? null` so a no-result tool (e.g. remember_fact, which yields only a marker) becomes
            // the string "null" rather than `JSON.stringify(undefined)` → undefined (a non-string the
            // API rejects). Every tool message must carry a string content.
            content:      serializeToolResult(c.result, c.isError),
          });
        }
      }
      continue;
    }

    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    const toolCalls = msg.content.filter(c => c.type === 'tool-call');
    const parts     = msg.content.filter(c => c.type !== 'tool-call');

    const contentParts: OAIContentPart[] = parts.flatMap((c): OAIContentPart[] => {
      switch (c.type) {
        case 'text':      return [{ type: 'text', text: c.text }];
        case 'image':     return [{ type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } }];
        case 'image-url': return [{ type: 'image_url', image_url: { url: c.url, ...(c.detail !== undefined ? { detail: c.detail } : {}) } }];
        case 'file-ref':  return [{ type: 'text', text: `[Attached file: ${c.name}]` }];
        case 'document':  return [{ type: 'text', text: `[Document: ${c.name ?? c.mimeType}]` }];
        case 'audio':     return [{ type: 'text', text: `[Audio: ${c.mimeType}]` }];
        case 'thinking':
        case 'redacted-thinking':
        case 'reasoning':
        case 'tool-result':    // only in role === 'tool' messages, handled above
        case 'refusal':
        case 'form':
        case 'form-response':
        case 'marker':         // opaque UI annotation; transparent to the model
        case 'unknown-content':
          return [];
      }
    });

    let content: string | OAIContentPart[] | undefined;
    const first = contentParts[0];
    if (contentParts.length === 1 && first !== undefined && first.type === 'text') {
      content = first.text;  // plain string for text-only messages
    } else if (contentParts.length > 0) {
      content = contentParts;
    }

    // Set `content` only when there is some — never an explicit `null`. The spec makes `content`
    // optional once `tool_calls` is present, and stricter validators (e.g. gpt-5.x) reject
    // `"content": null` with "expected a string, got null". So an assistant tool-call turn with no
    // text is sent as `{ role, tool_calls }`, content omitted.
    const oaiMsg: OAIMessage = { role: msg.role };
    if (content !== undefined) oaiMsg.content = content;

    if (toolCalls.length > 0) {
      oaiMsg.tool_calls = toolCalls.map(c => {
        if (c.type !== 'tool-call') return null!;
        return {
          id:       c.id,
          type:     'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        };
      }).filter(Boolean);
    }

    // Provider-specific reasoning/thinking blocks are intentionally stripped above. If that leaves a
    // message with neither content nor tool calls, drop it rather than send an empty one.
    if (oaiMsg.content === undefined && (oaiMsg.tool_calls?.length ?? 0) === 0) continue;

    result.push(oaiMsg);
  }

  if (cache) applyCacheBreakpoints(result);
  return result;
}

/**
 * Convert matbot tools to OpenAI function-tool definitions; with `cache`, marks the last
 * definition with an ephemeral breakpoint (tool defs are stable across turns).
 *
 * @param tools The tools offered to the model.
 * @param cache Add a `cache_control` breakpoint on the last tool definition.
 * @returns OpenAI-format tool definitions.
 */
export function toOAITools(tools: readonly Tool[], cache = false): OAIToolDef[] {
  const defs: OAIToolDef[] = tools.map(t => ({
    type:     'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  // Tool defs are stable across turns — cache them too (last breakpoint covers the whole array).
  if (cache && defs.length > 0) defs[defs.length - 1]!.cache_control = { type: 'ephemeral' };
  return defs;
}
