import { executeToolInvocation, createInvocationState } from './tool-invocation.js';
import type {
  Session, MessageContent,
  PipelineEvent, RunConfig, ProviderAdapter, ProviderConfig,
  Tool, ToolRegistry, ToolContext, Store, FileStore, SystemContextRegistry, Vault, PromptFn, FormField,
  ObservabilityEvent, ObservabilitySink, ObservabilityStatus,
} from './types.js';
import type { MatbotPlugin } from './plugin.js';
import type { ToolOutputLimits } from './truncate.js';
import type { PermissionAction, PermissionRule } from './permissions.js';
import { isToolHiddenByRules } from './permissions.js';
import { HookRegistry } from './hooks.js';
import { appendMessage, createMessage } from './session.js';

/** Loop budget policy for one agentic turn (spec R1). Absent fields are unlimited. */
export interface LoopPolicy {
  /** Maximum provider calls (iterations) per turn. Default unlimited. */
  maxIterations?:       number;
  /** Maximum tool calls executed per turn; excess calls receive a budget error result. Default unlimited. */
  maxToolCallsPerTurn?: number;
  /** Cumulative input+output token budget across the turn's provider calls. Default unlimited. */
  tokenBudgetTokens?:   number;
  /** Consecutive identical (name + input) calls allowed before interception. Default 3; 0 disables. */
  doomLoopThreshold?:   number;
}

/** Permission gate configuration (spec R8). Defaults preserve pre-permission behavior (`allow`). */
export interface PermissionConfig {
  rules?:         PermissionRule[];
  /** Action when no rule matches. Default `'allow'`. */
  defaultAction?: PermissionAction;
}

/** Everything one agentic turn needs: session, provider wiring, registries, and injection points. */
export interface RunSessionOpts {
  /** The session to run the turn against (already screen-shaped by the caller? no — screened here). */
  session:        Session;
  /** Provider key, persona, and trace correlation for this turn. */
  config:         RunConfig;
  /** The resolved provider adapter to call. */
  provider:       ProviderAdapter;
  /** The named provider profile (endpoint, model, credentials, parameters). */
  providerConfig: ProviderConfig;
  /** Turn-start snapshot of tools advertised to the model. */
  tools?:         ReadonlyMap<string, Tool>;
  /**
   * Live registry consulted to *resolve the executor* at call time. The `tools` map above is a
   * turn-start snapshot — the stable menu advertised to the model for the whole turn — but a tool
   * that mutates the registry mid-turn (`plugin reload`/`add`/`remove`) must take effect for any
   * call later in the *same* turn, so execution resolves against this live registry rather than the
   * snapshot. Present ⇒ authoritative (a tool removed mid-turn resolves to null ⇒ "Unknown tool",
   * which is correct); absent ⇒ falls back to the snapshot (direct callers / tests that pass only
   * `tools`).
   */
  toolRegistry?:  ToolRegistry;
  /** Store the session is persisted to at turn end and abort points. */
  store:          Store<Session>;
  /** Pipeline hook registry (screen/contribute/toolcall/toolresult). */
  hooks?:         HookRegistry;
  /** System-prompt contributor registry, built once per submission. */
  systemContext?: SystemContextRegistry;
  /** Aborting ends the turn (persisting partial content) with an `aborted` event. */
  signal:         AbortSignal;
  /** Vault handed to tools for secret resolution; defaults to a pass-through stub. */
  vault?:         Vault;
  /** Default working directory forwarded to tool contexts. */
  workdir?:       string;
  /** Config file path forwarded to tool contexts. */
  configPath?:    string;
  /** File store forwarded to tool contexts. */
  files?:         FileStore;
  /** Supply a prompt implementation to allow tools to ask interactive questions. */
  prompt?:        PromptFn;
  /**
   * Turn-scoped context to inject ephemerally, exactly like a `screen` hook's `ephemeral` (tail-folded
   * onto the freshest non-marker message, never persisted) — merged ahead of whatever `screen` adds.
   * The pump supplies this for an agent-phase retract-redo: the trigger tool's output rides into the
   * re-run of the originating user turn. Empty/absent for an ordinary turn.
   */
  injectedEphemeral?: MessageContent[];
  /** Frontend-supplied per-submit context. It follows screen-hook context so an explicit
   *  interaction choice remains the freshest instruction for the provider. */
  tailEphemeral?: MessageContent[];
  /** Optional durable trace sink for turn/provider/tool spans. */
  observability?: ObservabilitySink;
  /** Loop budget policy (iterations, tool-call cap, token budget, doom-loop threshold). */
  loopPolicy?:    LoopPolicy;
  /** Permission gate rules; when absent every tool call is allowed unchanged. */
  permissions?:   PermissionConfig;
  /** Output limits applied to tool results before they enter model context. */
  toolOutput?:    ToolOutputLimits;
  /** Hot-load a plugin (delegated into tool contexts). */
  loadPlugin:     (specifier: string, prompt?: PromptFn) => Promise<MatbotPlugin>;
  /** Hot-unload a plugin (delegated into tool contexts). */
  unloadPlugin:   (specifier: string) => Promise<boolean>;
}

/**
 * Run one agentic turn: screen hooks, system context, then loop provider calls and tool
 * executions until the model produces a turn with no tool calls. Persists the session at
 * every exit (done, abort, error) before yielding the terminal event.
 *
 * @param opts - Session, provider wiring, registries, and injection points.
 * @returns The turn's pipeline event stream, ending with exactly one terminal event
 *          (`done`, `aborted`, or `error`).
 */
export async function* runSession(opts: RunSessionOpts): AsyncIterable<PipelineEvent> {
  const traceId = opts.config.traceId ?? crypto.randomUUID();
  try {
    yield* runSessionTurn({ ...opts, config: { ...opts.config, traceId } });
  } catch (error) {
    yield { type: 'error', error: error instanceof Error ? error.message : String(error), traceId };
  }
}

/**
 * Drive one agentic turn end-to-end: screen the submission, build system context, then loop
 * provider calls and parallel tool executions until the model replies without tool calls or a
 * budget/abort condition ends the turn. The session is persisted after every complete tool
 * round-trip and at every exit path, and `matbot.turn`/`gen_ai.chat`/tool spans are reported to
 * the observability sink when one is configured.
 *
 * Internal: called only by {@link runSession}, which maps any thrown failure into an `error`
 * event, so callers never see these exceptions directly.
 *
 * @param opts - Session, provider wiring, registries, and injection points, with
 *               `config.traceId` already resolved.
 * @returns The pipeline event stream, ending with exactly one terminal event (`done`,
 *           `aborted`, or `error`).
 * @throws Error - If a session persistence write fails on an exit path not guarded here
 *           (persist wraps store failures in a descriptive error).
 * @throws The abort signal's reason if abort lands inside a tool execution after its gates but
 *           before executor dispatch.
 */
async function* runSessionTurn(opts: RunSessionOpts): AsyncIterable<PipelineEvent> {
  const { config, provider, providerConfig, store, signal } = opts;
  /**
   * Persist a session snapshot to the store so the latest output and completed actions survive
   * any later failure.
   *
   * @param session - The session snapshot to write.
   * @returns Resolves when the store has accepted the write.
   * @throws Error - If the store write fails; the original failure is attached as `cause` and
   *           the message warns that the latest output may not be saved.
   */
  const persist = async (session: Session): Promise<void> => {
    try { await store.set(session.id, session); }
    catch (error) {
      throw new Error(`Session persistence failed; the latest output and completed actions may not be saved: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  // Tools fully denied by permission rules never reach the model's menu (spec R8) — the gate
  // below still covers them for direct callers that pass their own snapshot.
  const declaredTools = opts.tools ?? new Map<string, Tool>();
  const denyRules = opts.permissions?.rules;
  const tools   = denyRules !== undefined && denyRules.length > 0
    ? new Map([...declaredTools].filter(([name]) => !isToolHiddenByRules(denyRules, name)))
    : declaredTools;
  const hookReg = opts.hooks   ?? new HookRegistry();
  /**
   * Fallback prompt function for non-interactive contexts (when `opts.prompt` is absent):
   * resolves with the default answer when one is available, otherwise rejects — tools cannot
   * ask interactive questions here.
   *
   * @param p - The question text, or a form field whose `default` supplies the answer.
   * @param def - Default answer for a plain-string prompt; ignored for form fields.
   * @returns Resolves with the available default answer.
   * @throws Error - Via a rejected promise when no default answer exists.
   */
  const promptFn: PromptFn = opts.prompt ?? (((p: string | FormField, def?: string): Promise<string> => {
    const fallback = typeof p === 'string' ? def : p.default;
    if (fallback !== undefined) return Promise.resolve(fallback);
    const label = typeof p === 'string' ? p : p.label;
    return Promise.reject(new Error(`Non-interactive context: cannot prompt for "${label}"`));
  }) as PromptFn);
  const vault: Vault = opts.vault ?? {
    async createSecret() { throw new Error('No vault configured'); },
    async writeSecret()  { throw new Error('No vault configured'); },
    hasKey() { return false; },
    async resolve(ref: string) { return ref; },
    scrub(text: string) { return text; },
  };
  const traceId = config.traceId ?? crypto.randomUUID();
  const rootTraceId = config.rootTraceId ?? traceId;
  const sessionId = config.sessionId ?? opts.session.id;
  const turnSpanId = crypto.randomUUID();
  const turnStartedAt = Date.now();
  let turnFinished = false;
  /**
   * Record one observability span event, stamping the turn's trace/root-trace ids and a
   * timestamp. Sink failures are logged as warnings and swallowed so telemetry problems never
   * break the turn.
   *
   * @param event - Span event without correlation fields; `timestamp` is filled in when absent.
   * @returns Resolves once the sink has been invoked (or the event was dropped).
   * @throws Never.
   */
  const observe = async (event: Omit<ObservabilityEvent, 'traceId' | 'rootTraceId' | 'timestamp'> & { timestamp?: string }): Promise<void> => {
    if (opts.observability === undefined) return;
    try {
      await opts.observability.record({
        ...event,
        traceId,
        rootTraceId,
        timestamp: event.timestamp ?? new Date().toISOString(),
      });
    } catch (error) {
      console.warn(`[runner] observability sink failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  /**
   * Emit the terminal `matbot.turn` span end exactly once per turn, with the total duration, the
   * given status, and any terminal attributes; later calls are no-ops.
   *
   * @param status - Terminal span status (`ok` on success, `error` on abort or failure).
   * @param attributes - Extra attributes describing the terminal event (kind, reason, counts).
   * @returns Resolves when the end event has been observed.
   * @throws Never.
   */
  const finishTurn = async (status: ObservabilityStatus, attributes?: Record<string, unknown>): Promise<void> => {
    if (turnFinished) return;
    turnFinished = true;
    await observe({
      phase: 'end', kind: 'agent', name: 'matbot.turn', spanId: turnSpanId, sessionId,
      status, durationMs: Date.now() - turnStartedAt, ...(attributes !== undefined ? { attributes } : {}),
    });
  };
  /**
   * Scrub a span attribute through the vault before observability: strings pass through the
   * vault's scrubber directly; objects are serialized, scrubbed, and re-parsed, degrading to a
   * placeholder when not round-trippable; other values pass through unchanged.
   *
   * @param value - The span attribute value to scrub.
   * @returns The scrubbed value, safe to attach to an observability event.
   * @throws Never.
   */
  const scrubSpanValue = (value: unknown): unknown => {
    if (typeof value === 'string') return vault.scrub(value);
    if (value === null || typeof value !== 'object') return value;
    try {
      return JSON.parse(vault.scrub(JSON.stringify(value)));
    } catch {
      return '[unserializable]';
    }
  };

  // ── Loop policy state ─────────────────────────────────────────────────────
  const policy = opts.loopPolicy ?? {};
  const doomThreshold = policy.doomLoopThreshold === undefined ? 3 : Math.max(0, Math.trunc(policy.doomLoopThreshold));
  let iteration = 0;
  let executedToolCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // Attempted executions per distinct (name + input) call this turn — deterministic under
  // parallel execution, where "consecutive" is ill-defined.
  const turnCallCounts = new Map<string, number>();
  // Serializes permission-gate entry across a parallel batch so mid-batch "always allow"
  // answers are visible to sibling calls before they prompt.
  const invocationState = createInvocationState();

  /**
   * Append isError tool results for any assistant tool-call block that never received one — an
   * aborted turn must persist paired calls/results so provider submissions stay valid (spec R19).
   *
   * @param target - The session to scan for unanswered tool calls.
   * @param errorText - Error text placed on each synthesized `aborted` tool result.
   * @returns The session unchanged when every tool call is answered; otherwise a copy with one
   *           `tool`-role message carrying the synthesized results appended.
   * @throws Never.
   */
  const finalizeOrphanToolCalls = (target: Session, errorText: string): Session => {
    const answered = new Set<string>();
    for (const m of target.messages) {
      for (const c of m.content) if (c.type === 'tool-result') answered.add(c.id);
    }
    const orphans: MessageContent[] = [];
    for (const m of target.messages) {
      if (m.role !== 'assistant') continue;
      for (const c of m.content) {
        if (c.type === 'tool-call' && !answered.has(c.id)) {
          orphans.push({ type: 'tool-result', id: c.id, result: { error: errorText, code: 'aborted' }, isError: true });
        }
      }
    }
    if (orphans.length === 0) return target;
    return appendMessage(target, createMessage({ role: 'tool', content: orphans, traceId }));
  };

  /**
   * Push-based event queue so concurrent tool executions can stream pipeline events while the
   * generator yields them in arrival order.
   *
   * @typeParam T - Queued event type.
   * @returns A queue with `push` (buffer a value and wake a waiting consumer), `end` (mark the
   *           stream finished), and an async iterator yielding buffered values FIFO, then
   *           completing after `end` once the buffer is drained.
   * @throws Never.
   */
  function createEventQueue<T>() {
    const buffer: T[] = [];
    let ended = false;
    let wakeup: (() => void) | null = null;
    /**
     * Wake a parked consumer, if any.
     *
     * @returns Nothing.
     * @throws Never.
     */
    const release = (): void => { if (wakeup !== null) { const w = wakeup; wakeup = null; w(); } };
    return {
      push(v: T): void { buffer.push(v); release(); },
      end(): void { ended = true; release(); },
      async *[Symbol.asyncIterator](): AsyncIterator<T> {
        for (;;) {
          if (buffer.length > 0) { yield buffer.shift()!; continue; }
          if (ended) return;
          await new Promise<void>(resolve => { wakeup = resolve; });
        }
      },
    };
  }

  await observe({
    phase: 'start', kind: 'agent', name: 'matbot.turn', spanId: turnSpanId, sessionId,
    attributes: { provider: config.provider, persona: config.persona ?? null },
  });

  // ── 1. screen — once per turn: shape/abort the incoming submission ──────────

  const screen = await hookReg.runScreen({ session: opts.session, config, signal, prompt: promptFn });
  if (screen.abort) {
    // Hook-failure (and any other screen-injected) markers carried live, even on abort, so a
    // misconfigured hook surfaces this turn rather than only on a later reload.
    if (screen.markers.length > 0) yield { type: 'marker', content: screen.markers, traceId };
    await persist(screen.session);
    yield { type: 'aborted', reason: screen.abort, session: screen.session, traceId };
    await finishTurn('error', { terminal: 'aborted', reason: screen.abort });
    return;
  }
  // Durable context a screen hook folded onto the user message (e.g. a fired `contextual` trigger),
  // carried live so a frontend draws it now rather than only on a later reload. It is already part of
  // screen.session (origin: 'robo' blocks on the user turn) — this event is purely live delivery.
  // Emitted BEFORE the markers so the live order matches a reload: the durable blocks belong to the
  // user message (rendered with the turn), while screen markers were appended to the session AFTER it.
  if (screen.durable.length > 0) {
    yield { type: 'robo-user', content: screen.durable, traceId };
  }
  // Hook-failure (and any other screen-injected) markers, carried live so the UI shows them this turn
  // rather than only on a later session reload. They are already persisted in screen.session.
  if (screen.markers.length > 0) {
    yield { type: 'marker', content: screen.markers, traceId };
  }
  let session = screen.session;

  // Turn-scoped ephemeral context from screen — appended to the TAIL of the outgoing messages
  // (onto the content of the freshest history message, preserving its role), never persisted.
  // At the tail, not as a system prefix, because (a) a "do X now" directive needs the salience of
  // being the last thing the model reads — a system-block prefix sits above the whole history and
  // reads as stale once the turn has any momentum — and (b) per-turn content in the prefix would
  // bust the cached system/history prefix every turn; appended at the tail it leaves the prefix
  // byte-stable. Folding into the last message (rather than adding a trailing message) avoids
  // role-alternation hazards and survives both adapters (Anthropic folds system→system=; OpenAI
  // drops non-result content from tool-role messages — a separate trailing message would break on
  // one or the other).
  // injectedEphemeral (a pump-supplied retract-redo's context) leads, screen's own context follows,
  // then frontend-supplied tailEphemeral carries the freshest explicit interaction metadata.
  const ephemeral = [
    ...(opts.injectedEphemeral ?? []),
    ...screen.ephemeral,
    ...(opts.tailEphemeral ?? []),
  ];

  // ── 2. System context (built once per submit, never persisted) ─────────────

  const systemText = opts.systemContext
    ? await opts.systemContext.build({ session, signal })
    : null;

  const systemMsg = systemText !== null
    ? [createMessage({ role: 'system', content: [{ type: 'text', text: systemText }], traceId: '' })]
    : [];

  if (systemText !== null) {
    yield { type: 'system-context', text: systemText, traceId };
  }

  // ── 3. Agentic loop ────────────────────────────────────────────────────────

  for (;;) {
    // Respect an abort that arrived between turns (e.g. during tool execution).
    if (signal.aborted) {
      session = finalizeOrphanToolCalls(session, typeof signal.reason === 'string' ? `aborted: ${signal.reason}` : 'turn aborted');
      await persist(session);
      yield { type: 'aborted', reason: typeof signal.reason === 'string' ? signal.reason : 'user-abort', session, traceId };
      await finishTurn('error', { terminal: 'aborted', reason: String(signal.reason ?? 'user-abort') });
      return;
    }

    // Loop budget checks — enforced before the next provider call so a graceful stop lands after
    // the last complete tool round-trip (spec R1).
    const budgetReason =
      (policy.maxIterations   !== undefined && iteration >= policy.maxIterations)   ? 'max-iterations' as const :
      (policy.tokenBudgetTokens !== undefined && totalInputTokens + totalOutputTokens >= policy.tokenBudgetTokens)
                                                                            ? 'token-budget' as const :
      undefined;
    if (budgetReason !== undefined) {
      yield { type: 'loop:limit', reason: budgetReason, iterations: iteration, toolCalls: executedToolCalls, traceId };
      session = appendMessage(session, createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `[Turn stopped by loop policy: ${budgetReason}. Summarize progress and results so far in your final answer.]` }],
        traceId,
        providerName: config.provider,
        metadata: { loopLimit: budgetReason },
      }));
      break;
    }

    const pendingCalls: Array<{ id: string; name: string; input: unknown; parseError?: string }> = [];
    const assistantParts: MessageContent[] = [];
    let textAcc = '';

    // One provider call. The outgoing array (system context + history, with screen's ephemeral
    // blocks appended onto the tail message) is assembled here and handed to `contribute` hooks for
    // a final ephemeral transform — none of this is written back to the session.
    // Fold onto the last NON-marker message: markers are elided from the wire, so the literal last
    // message can be a marker (e.g. a retract-redo leaves the retraction marker as the tail) — folding
    // there would drop the ephemeral with it. -1 ⇒ nothing to fold onto (no non-marker history).
    const foldIdx = ephemeral.length > 0 ? session.messages.findLastIndex(m => m.role !== 'marker') : -1;
    const history = foldIdx >= 0
      ? session.messages.map((m, i) =>
          i === foldIdx ? { ...m, content: [...m.content, ...ephemeral] } : m)
      : session.messages;
    const outgoing = await hookReg.runContribute({
      outgoing: [...systemMsg, ...history],
      session, config, signal,
    });
    const providerSpanId = crypto.randomUUID();
    const providerStartedAt = Date.now();
    let firstTokenAt: number | undefined;
    let providerInputTokens = 0;
    let providerOutputTokens = 0;
    let providerCostUsd = 0;
    let providerCostKnown = false;
    let providerCacheReadTokens = 0;
    let providerCacheCreationTokens = 0;
    let completionMetadata: {
      gateway: string; requestedModel: string; returnedModel?: string; generationId?: string;
      upstreamProvider?: string; finishReason?: string; truncated?: boolean;
    } | undefined;
    let providerDone = false;
    await observe({
      phase: 'start', kind: 'llm', name: 'gen_ai.chat', spanId: providerSpanId,
      parentSpanId: turnSpanId, sessionId,
      attributes: { provider: config.provider, model: providerConfig.model, messageCount: outgoing.length, toolCount: tools.size },
    });
    try {
      for await (const ev of provider.complete(outgoing, providerConfig, [...tools.values()], signal)) {
        switch (ev.type) {
          case 'text-delta':
            firstTokenAt ??= Date.now();
            textAcc += ev.delta;
            yield { type: 'text-delta', delta: ev.delta, traceId };
            break;
          case 'thinking':
            firstTokenAt ??= Date.now();
            yield { type: 'thinking', delta: ev.delta, traceId };
            break;
          case 'thinking-block':
            assistantParts.push({ type: 'thinking', thinking: ev.thinking, signature: ev.signature });
            break;
          case 'redacted-thinking':
            assistantParts.push({ type: 'redacted-thinking', data: ev.data });
            break;
          case 'unknown-block':
            assistantParts.push({ type: 'unknown-content', blockType: ev.blockType, raw: ev.raw });
            break;
          case 'reasoning-block':
            assistantParts.push({ type: 'reasoning', reasoning: ev.reasoning });
            break;
          case 'tool-call':
            pendingCalls.push({ id: ev.id, name: ev.name, input: ev.input, ...(ev.parseError !== undefined ? { parseError: ev.parseError } : {}) });
            break;
          case 'usage':
            providerInputTokens += ev.inputTokens;
            providerOutputTokens += ev.outputTokens;
            totalInputTokens += ev.inputTokens;
            totalOutputTokens += ev.outputTokens;
            if (ev.costUsd !== undefined) {
              providerCostKnown = true;
              providerCostUsd += ev.costUsd;
            }
            providerCacheReadTokens += ev.cacheReadTokens ?? 0;
            providerCacheCreationTokens += ev.cacheCreationTokens ?? 0;
            yield { type: 'usage', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, traceId,
              ...(ev.costUsd              !== undefined ? { costUsd:              ev.costUsd              } : {}),
              ...(ev.cacheReadTokens     !== undefined ? { cacheReadTokens:     ev.cacheReadTokens     } : {}),
              ...(ev.cacheCreationTokens !== undefined ? { cacheCreationTokens: ev.cacheCreationTokens } : {}) };
            break;
          case 'completion-metadata':
            {
              const { type: _eventType, ...safeMetadata } = ev;
              completionMetadata = { ...completionMetadata, ...safeMetadata };
            }
            break;
          case 'done':
            providerDone = true;
            break;
        }
      }
      if (!providerDone) throw new Error('Provider stream ended without a terminal done event.');
      await observe({
        phase: 'end', kind: 'llm', name: 'gen_ai.chat', spanId: providerSpanId,
        parentSpanId: turnSpanId, sessionId, status: 'ok', durationMs: Date.now() - providerStartedAt,
        attributes: {
          provider: config.provider,
          model: providerConfig.model,
          inputTokens: providerInputTokens,
          outputTokens: providerOutputTokens,
          cacheReadTokens: providerCacheReadTokens,
          cacheCreationTokens: providerCacheCreationTokens,
          costUsd: providerCostKnown ? providerCostUsd : null,
          ...(completionMetadata !== undefined ? { completion: completionMetadata } : {}),
          timeToFirstTokenMs: firstTokenAt === undefined ? null : firstTokenAt - providerStartedAt,
          outputCharacters: textAcc.length,
          toolCallCount: pendingCalls.length,
        },
      });
    } catch (e) {
      // Unknown-typed catch: extract message/cause/stack via instanceof so an Error's stack
      // is not flattened to `String(e)` ("Error: msg") and non-Errors still surface.
      const err     = e instanceof Error ? e : undefined;
      const message = err !== undefined ? err.message : String(e);
      const stack   = err?.stack;
      const cause   = err?.cause;
      const detail  = cause !== undefined
        ? `${message} (${cause instanceof Error ? cause.message : String(cause)})`
        : message;
      await observe({
        phase: 'end', kind: 'llm', name: 'gen_ai.chat', spanId: providerSpanId,
        parentSpanId: turnSpanId, sessionId, status: 'error', durationMs: Date.now() - providerStartedAt,
        attributes: {
          provider: config.provider,
          error: detail,
          ...(stack !== undefined ? { errorStack: stack } : {}),
        },
      });
      // Preserve partial prose and completed rounds, but never release buffered
      // tool calls from an unconfirmed provider completion.
      if (textAcc) assistantParts.push({ type: 'text', text: textAcc });
      if (assistantParts.length > 0) {
        session = appendMessage(session, createMessage({
          role: 'assistant', content: assistantParts, traceId, providerName: config.provider,
          metadata: { incomplete: true, ...(completionMetadata !== undefined ? { completion: completionMetadata } : {}) },
        }));
      }
      session = appendMessage(session, createMessage({
        role: 'marker', content: [{ type: 'text', text: `Completion interrupted: ${detail}` }], traceId,
        metadata: { incomplete: true, providerError: detail },
      }));
      try { await persist(session); }
      catch (persistenceError) {
        const failure = `${detail}. ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`;
        yield { type: 'error', error: failure, traceId };
        await finishTurn('error', { terminal: 'error', error: failure });
        return;
      }
      if (signal.aborted) {
        yield { type: 'aborted', reason: typeof signal.reason === 'string' ? signal.reason : 'user-abort', session, traceId };
        await finishTurn('error', { terminal: 'aborted', reason: typeof signal.reason === 'string' ? signal.reason : 'user-abort' });
        return;
      }
      yield { type: 'error', error: detail, traceId };
      await finishTurn('error', { terminal: 'error', error: detail });
      return;
    }

    // Build and store assistant message
    if (textAcc)           assistantParts.push({ type: 'text', text: textAcc });
    for (const tc of pendingCalls) {
      assistantParts.push({ type: 'tool-call', id: tc.id, name: tc.name, input: tc.input });
    }

    if (assistantParts.length > 0) {
      const assistantMsg = createMessage({
        role:         'assistant',
        content:      assistantParts,
        traceId,
        providerName: config.provider,
        ...(completionMetadata !== undefined ? { metadata: { completion: completionMetadata } } : {}),
      });
      session = appendMessage(session, assistantMsg);
    } else {
      // Diagnostic: the provider returned no text, no tool calls, no thinking — a genuinely empty
      // completion. The turn will end with no assistant message, which reads as "the agent never
      // replied". Logged here so a silent no-reply turn is traceable. (textAcc length is shown to
      // tell a truly empty stream apart from one that was only whitespace.)
      console.warn(`[runner] empty completion (no assistant content) on traceId ${traceId}; textAcc=${textAcc.length} chars, provider=${config.provider}`);
    }

    // No tool calls → done
    if (pendingCalls.length === 0) break;
    iteration++;

    // ── 3. Execute tool calls (parallel with serial fallback — spec R2) ──────

    const toolResults: MessageContent[] = new Array<MessageContent>(pendingCalls.length);
    const toolMarkers: MessageContent[] = [];
    let abortReason: string | undefined;

    // Tool-call budget: calls beyond the cap receive a budget error result without executing.
    const callBudget = policy.maxToolCallsPerTurn !== undefined
      ? Math.max(0, Math.trunc(policy.maxToolCallsPerTurn) - executedToolCalls)
      : pendingCalls.length;
    executedToolCalls += pendingCalls.length;
    const budgetExceeded = callBudget < pendingCalls.length;

    const serialBatch = pendingCalls.some(tc => tools.get(tc.name)?.serial === true);

    const queue = createEventQueue<PipelineEvent>();
    /**
     * Execute the pending tool calls — up to 4 workers in parallel, or serially when any called
     * tool demands serial execution — recording each outcome in `toolResults` and streaming
     * `tool:start`/`tool:end` events through the queue. Calls refused by the budget, argument
     * -parse, doom-loop, or tool-resolution gates receive error results without running the tool;
     * calls that never ran (abort mid-batch) get paired `aborted` results in `finally`.
     *
     * @returns Resolves when every pending call has a recorded result and the queue is closed.
     * @throws The abort signal's reason if abort lands inside {@link executeToolInvocation} after
     *           its gates but before executor dispatch; other per-call failures are captured as
     *           error results, not rethrown.
     */
    const batch = (async (): Promise<void> => {
      try {
        /**
         * Record a call refused without executing (budget, parse, doom-loop, or unknown tool):
         * store its error result at the call's index, push a `tool:end` event, and close its
         * tool span with `error` status.
         *
         * @param tc - The skipped call (id and name).
         * @param index - Position of the call in `pendingCalls`; `toolResults` is written here.
         * @param spanId - Tool span id opened for this call.
         * @param startedAt - Epoch ms at which the span opened (span duration basis).
         * @param result - Error payload recorded as the call's result.
         * @param push - Sink for the pipeline event.
         * @returns Nothing; the span observation is fire-and-forget.
         * @throws Never.
         */
        const finishSkipped = (
          tc: { id: string; name: string },
          index: number,
          spanId: string,
          startedAt: number,
          result: unknown,
          push: (ev: PipelineEvent) => void,
        ): void => {
          toolResults[index] = { type: 'tool-result', id: tc.id, result, isError: true };
          push({ type: 'tool:end', callId: tc.id, result, isError: true, traceId });
          void observe({
            phase: 'end', kind: 'tool', name: tc.name, spanId,
            parentSpanId: turnSpanId, sessionId, status: 'error', durationMs: Date.now() - startedAt,
            attributes: { callId: tc.id, isError: true },
          });
        };

        /**
         * Execute one pending tool call end-to-end: open its observability span, then apply the
         * per-turn tool-call budget, argument-parse, doom-loop, and tool-resolution gates — each
         * yielding an error result without running the tool — before delegating the survivor to
         * {@link executeToolInvocation} and recording its outcome and any abort request.
         *
         * @param index - Position of the call in `pendingCalls`.
         * @param push - Sink for the call's `tool:start`/`tool:end` pipeline events.
         * @returns Resolves when the call has a recorded result in `toolResults`.
         * @throws The abort signal's reason if abort lands inside {@link executeToolInvocation}
         *           after its gates but before executor dispatch.
         */
        const execOne = async (index: number, push: (ev: PipelineEvent) => void): Promise<void> => {
          const tc = pendingCalls[index]!;
          const toolSpanId = crypto.randomUUID();
          const toolStartedAt = Date.now();
          await observe({
            phase: 'start', kind: 'tool', name: tc.name, spanId: toolSpanId,
            parentSpanId: turnSpanId, sessionId,
            attributes: { callId: tc.id, input: scrubSpanValue(tc.input) },
          });
          push({ type: 'tool:start', callId: tc.id, name: tc.name, input: tc.input, traceId });

          // Calls past the per-turn tool-call budget are answered without executing so pairing holds.
          if (index >= callBudget) {
            finishSkipped(tc, index, toolSpanId, toolStartedAt,
              { error: `Turn reached its tool-call budget (${policy.maxToolCallsPerTurn}); this call was not executed.`, code: 'budget_exceeded' }, push);
            return;
          }

          // A malformed/truncated argument stream degrades to a corrective failed call (spec R4).
          if (tc.parseError !== undefined) {
            finishSkipped(tc, index, toolSpanId, toolStartedAt, {
              error: `The arguments for '${tc.name}' could not be parsed and the call was not executed: ${tc.parseError} Re-issue the call with valid JSON arguments.`,
              code: 'invalid_input',
            }, push);
            return;
          }

          // Doom-loop interception (spec R6): after `doomLoopThreshold` prior identical attempts,
          // further identical calls are refused — the strategy is not working.
          const callKey = JSON.stringify({ name: tc.name, input: tc.input ?? null });
          const seenCount = turnCallCounts.get(callKey) ?? 0;
          if (doomThreshold > 0 && seenCount >= doomThreshold && tools.has(tc.name)) {
            finishSkipped(tc, index, toolSpanId, toolStartedAt, {
              error: `doom_loop: this exact ${tc.name} call has already been made ${seenCount} times this turn with identical input. Change strategy or ask the user for guidance.`,
              code: 'doom_loop',
            }, push);
            return;
          }
          turnCallCounts.set(callKey, seenCount + 1);

          const tool = opts.toolRegistry !== undefined ? opts.toolRegistry.resolve(tc.name) : tools.get(tc.name);
          if (!tool) {
            finishSkipped(tc, index, toolSpanId, toolStartedAt, { error: `Unknown tool: ${tc.name}`, code: 'not_found' }, push);
            return;
          }

          const outcome = await executeToolInvocation({
            ...opts, session, tool, call: tc, state: invocationState, markers: toolMarkers,
            vault, prompt: promptFn, hooks: hookReg, spanId: toolSpanId, observe,
          }, push);
          const { result, isError } = outcome;
          if (outcome.abortReason !== undefined) abortReason = outcome.abortReason;

          toolResults[index] = { type: 'tool-result', id: tc.id, result, isError };
          push({ type: 'tool:end', callId: tc.id, result, isError, traceId });
          await observe({
            phase: 'end', kind: 'tool', name: tc.name, spanId: toolSpanId,
            parentSpanId: turnSpanId, sessionId, status: isError ? 'error' : 'ok', durationMs: Date.now() - toolStartedAt,
            attributes: { callId: tc.id, result: scrubSpanValue(result), isError },
          });
        };

        let nextIndex = 0;
        /**
         * Take call indexes until exhausted or an abort is observed, executing them one at a time;
         * a fixed pool of these workers covers the batch (a single worker when the batch must run
         * serially). In-flight calls finish so every emitted call still gets a persisted result.
         *
         * @returns Resolves when the worker has no more calls to take.
         * @throws The abort signal's reason if abort lands inside an execution after its gates but
         *           before executor dispatch.
         */
        const worker = async (): Promise<void> => {
          for (;;) {
            const i = nextIndex++;
            if (i >= pendingCalls.length) break;
            await execOne(i, ev => queue.push(ev));
            // An abort (hook or cancelled permission prompt) stops NEW work; in-flight calls finish
            // so every emitted call still gets a persisted result.
            if (abortReason !== undefined) break;
          }
        };
        const concurrency = serialBatch ? 1 : Math.min(4, pendingCalls.length);
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
      } finally {
        // Any call that never ran (abort mid-batch) still needs a persisted paired result.
        for (let i = 0; i < pendingCalls.length; i++) {
          if (toolResults[i] !== undefined) continue;
          const tc = pendingCalls[i]!;
          toolResults[i] = { type: 'tool-result', id: tc.id, result: { error: `Not executed: ${abortReason ?? 'skipped'}.`, code: 'aborted' as const }, isError: true };
        }
        queue.end();
      }
    })();
    for await (const ev of queue) yield ev;
    await batch;

    // Add tool results message, then loop for the next provider call.
    const toolMsg = createMessage({ role: 'tool', content: toolResults, traceId });
    session = appendMessage(session, toolMsg);

    // Markers a tool emitted while running: persist as their own marker-role message (elided from
    // provider submission) and carry live so a frontend can render them without a reload.
    if (toolMarkers.length > 0) {
      session = appendMessage(session, createMessage({ role: 'marker', content: toolMarkers, traceId }));
      yield { type: 'marker', content: toolMarkers, traceId };
    }
    await persist(session);

    // A hook/cancelled-prompt abort during execution: results are now paired and persisted, so the
    // turn terminates cleanly with an `aborted` event.
    if (abortReason !== undefined) {
      session = finalizeOrphanToolCalls(session, abortReason);
      await persist(session);
      yield { type: 'aborted', reason: abortReason, session, traceId };
      await finishTurn('error', { terminal: 'aborted', reason: abortReason });
      return;
    }

    // Tool-call budget exhausted: stop gracefully after this complete round-trip.
    if (budgetExceeded) {
      yield { type: 'loop:limit', reason: 'max-tool-calls', iterations: iteration, toolCalls: executedToolCalls, traceId };
      session = appendMessage(session, createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `[Turn stopped by loop policy: max-tool-calls (${policy.maxToolCallsPerTurn}). Summarize progress and results so far in your final answer.]` }],
        traceId,
        providerName: config.provider,
        metadata: { loopLimit: 'max-tool-calls' },
      }));
      break;
    }
  }

  // ── 4. Persist and finish ──────────────────────────────────────────────────
  // `react` fires post-commit, in pump (the queue owner) — not here.

  await persist(session);

  yield { type: 'done', session, traceId };
  await finishTurn('ok', { terminal: 'done', messageCount: session.messages.length });
}
