import type { Tool, ToolContext, ToolEvent, MessageContent, PipelineEvent, ObservabilityEvent, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { HookRegistry } from './hooks.js';
import type { RunSessionOpts } from './runner.js';
import type { PermissionAction, PermissionRule } from './permissions.js';
import { evaluatePermission } from './permissions.js';
import { validateAgainstSchema, formatValidationIssues } from './schema-validator.js';
import { DEFAULT_OUTPUT_LIMITS, truncateToolResult } from './truncate.js';
import type { FormField } from './types.js';
/**
 * Permission answers and prompt serialization live for one invocation group/turn: a promise chain
 * serializing permission-gate entry across a parallel batch (so mid-batch "always allow" answers
 * are visible to sibling calls before they prompt), plus the `always allow` rules approved so far.
 *
 * @returns A fresh, mutable invocation state; share one instance across the calls of a group/turn.
 * @throws Never.
 */
export function createInvocationState() { return { chain: Promise.resolve(), approved: [] as PermissionRule[] }; }
/** Outcome of one validated, permission-gated tool invocation. */
export interface ToolInvocationResult {
    result: unknown;
    isError: boolean;
    abortReason?: string;
}
/**
 * Everything one tool invocation needs: the turn context (session, config, signal, wiring shared
 * with {@link RunSessionOpts}), the call and resolved tool, and optional invocation-scoped state,
 * progress, marker, and span plumbing.
 */
export interface ToolInvocationOptions extends Pick<RunSessionOpts, 'session' | 'config' | 'signal' | 'vault' | 'prompt' | 'hooks' | 'permissions' | 'toolOutput' | 'files' | 'workdir' | 'configPath' | 'loadPlugin' | 'unloadPlugin'> {
    call: {
        id: string;
        name: string;
        input: unknown;
    };
    tool: Tool;
    state?: ReturnType<typeof createInvocationState>;
    interactive?: boolean;
    onProgress?: (event: Extract<ToolEvent, {
        type: 'progress';
    }>) => void;
    markers?: MessageContent[];
    spanId?: string;
    observe?: (event: Omit<ObservabilityEvent, 'traceId' | 'rootTraceId' | 'timestamp'>) => Promise<void>;
}
/**
 * Shared validated, permission-gated execution for model turns and direct frontends. Validates
 * `call.input` against the tool's schema (spec R3), evaluates permission rules with
 * session-approved (`always allow`) rules appended last, serializes `ask` gates across a parallel
 * batch through the shared {@link createInvocationState} chain, runs the `toolcall`/`toolresult`
 * hooks, truncates the result to the output limits, and records guardrail/tool spans. Tool
 * failures are captured as error results, never rethrown.
 *
 * @param opts - The invocation's context, call, and resolved tool; `vault` is required.
 * @param push - Sink for `permission:ask`/`permission:reply` and tool stdout/stderr/file events;
 *               defaults to a no-op.
 * @returns The invocation outcome: the (possibly truncated) result, its error flag, and the abort
 *          reason when a `toolcall` hook or cancelled permission prompt requested abort.
 * @throws Error - When `opts.vault` is missing.
 * @throws The abort signal's reason if abort lands after the gates but just before executor
 *          dispatch (aborts while the executor streams are captured as error results instead).
 */
export async function executeToolInvocation(opts: ToolInvocationOptions, push: (event: PipelineEvent) => void = () => { }): Promise<ToolInvocationResult> {
    const { session, config, tool } = opts;
    const signal = tool.signal ? AbortSignal.any([opts.signal, tool.signal]) : opts.signal;
    const tc = opts.call;
    const index = 0;
    const sessionId = session.id;
    const traceId = config.traceId ?? tc.id;
    const rootTraceId = config.rootTraceId ?? traceId;
    const toolSpanId = opts.spanId ?? tc.id;
    const toolStartedAt = Date.now();
    const state = opts.state ?? createInvocationState();
    /**
     * Effective permission rules: configured rules first, then session-approved (`always allow`)
     * rules appended last so they win under last-match evaluation.
     *
     * @returns A fresh array of the rules in force.
     * @throws Never.
     */
    const permissionRules = () => [...(opts.permissions?.rules ?? []), ...state.approved];
    const hookReg = opts.hooks ?? new HookRegistry();
    const toolMarkers = opts.markers ?? [];
    const outputLimits = opts.toolOutput ?? DEFAULT_OUTPUT_LIMITS;
    const observe = opts.observe ?? (async () => { });
    const promptFn = opts.prompt ?? (async () => { throw new Error('Non-interactive context'); });
    if (!opts.vault)
        throw new Error('Tool invocation requires a vault');
    const vault = opts.vault;
    let abortReason: string | undefined;
    let approval: ToolContext['approval'];
    let outcome: ToolInvocationResult = { result: undefined, isError: false };
    let processed = false;
    /**
     * Local skip recorder: the shared invocation has no pipeline queue or span of its own for
     * skipped calls (caller-side gate bookkeeping already covered those), so it only records the
     * error outcome.
     *
     * @param _call - Ignored call descriptor.
     * @param _index - Ignored call index.
     * @param _span - Ignored span id.
     * @param _started - Ignored span start (epoch ms).
     * @param result - Error payload recorded as the outcome.
     * @param _push - Ignored event sink.
     * @returns Nothing.
     * @throws Never.
     */
    const finishSkipped = (_call: unknown, _index: number, _span: string, _started: number, result: unknown, _push: unknown): void => {
        outcome = { result, isError: true };
    };
    /**
     * Run the gate pipeline for one call and (when approved) the tool executor, recording the
     * outcome in `outcome` and any abort request in `abortReason`. Gates: pre-execution abort
     * check, input schema validation, permission evaluation (deny, or interactive `ask` with
     * serialized gate entry and `always allow` learning), then `toolcall` hooks. The executor's
     * events stream through `push`; executor failures are captured as error results. `processed`
     * marks that the success path already ran the `toolresult` hooks and truncation, so the
     * caller must not run them again on a skipped outcome.
     *
     * @returns Resolves when the call has a recorded outcome.
     * @throws The abort signal's reason if abort lands after the gates but just before executor
     *           dispatch (aborts during streaming are captured as error results instead).
     */
    const execute = async (): Promise<void> => {
        if (signal.aborted) {
            outcome = { result: { error: 'Invocation cancelled.', code: 'aborted' }, isError: true };
            return;
        }
        // Input validation at the boundary (spec R3): invalid input never reaches the executor.
        const issues = validateAgainstSchema(tc.input, tool.inputSchema);
        if (issues.length > 0) {
            finishSkipped(tc, index, toolSpanId, toolStartedAt, { error: formatValidationIssues(tc.name, issues), code: 'invalid_input' }, push);
            return;
        }
        // Permission gate (spec R8/R9). Configured rules first; session-approved ('always') rules
        // appended later win under last-match evaluation.
        const permKey = tool.permission?.action ?? tc.name;
        const patterns = tool.permission?.patterns?.(tc.input) ?? ['*'];
        const permFallback = opts.permissions?.defaultAction ?? 'allow';
        let gate: PermissionAction = (() => {
            const d = patterns.map(p => evaluatePermission(permissionRules(), permKey, p, permFallback));
            return d.includes('deny') ? 'deny' : d.includes('ask') ? 'ask' : 'allow';
        })();
        if (gate === 'deny') {
            finishSkipped(tc, index, toolSpanId, toolStartedAt, {
                error: `Permission denied by policy: ${permKey} (${patterns.join(', ')}).`,
                code: 'permission_denied',
            }, push);
            return;
        }
        const requiresApproval = tool.permission?.requiresApproval?.(tc.input) === true;
        if (gate === 'allow' && requiresApproval)
            gate = 'ask';
        if (gate === 'ask' && opts.interactive === false) {
            finishSkipped(tc, index, toolSpanId, toolStartedAt, { error: 'This operation requires interactive approval.', code: 'approval_required' }, push);
            return;
        }
        if (gate === 'ask') {
            // The gate slot is held through the whole prompt round-trip: an "always allow" answered
            // for one call must be visible to sibling calls in the same parallel batch before they
            // decide to prompt, and prompts are presented one at a time.
            const prevGate = state.chain;
            let releaseGate!: () => void;
            state.chain = new Promise<void>(r => { releaseGate = r; });
            try {
                await prevGate;
                const d = patterns.map(p => evaluatePermission(permissionRules(), permKey, p, permFallback));
                gate = d.includes('deny') ? 'deny' : d.includes('ask') ? 'ask' : 'allow';
                if (gate === 'deny') {
                    finishSkipped(tc, index, toolSpanId, toolStartedAt, {
                        error: `Permission denied by policy: ${permKey} (${patterns.join(', ')}).`,
                        code: 'permission_denied',
                    }, push);
                    return;
                }
                if (gate === 'allow' && requiresApproval)
                    gate = 'ask';
                if (gate === 'ask') {
                    const askId = crypto.randomUUID();
                    push({ type: 'permission:ask', askId, callId: tc.id, toolName: tc.name, permission: permKey, patterns, traceId });
                    let answer: string;
                    try {
                        answer = (await promptFn({
                            name: 'permission',
                            label: `Allow ${tc.name}? (${permKey}: ${patterns.join(', ')})`,
                            type: 'select',
                            options: ['allow', 'always allow', 'deny'],
                            required: true,
                        } satisfies FormField)).trim().toLowerCase();
                    }
                    catch (e) {
                        push({ type: 'permission:reply', askId, outcome: 'cancelled', traceId });
                        abortReason = e instanceof Error && e.name === 'PromptCancelledError' ? 'permission prompt cancelled' : String(e);
                        finishSkipped(tc, index, toolSpanId, toolStartedAt, { error: 'Permission prompt was cancelled.', code: 'aborted' }, push);
                        return;
                    }
                    if (answer === 'deny' || answer === 'no') {
                        push({ type: 'permission:reply', askId, outcome: 'deny', traceId });
                        finishSkipped(tc, index, toolSpanId, toolStartedAt, {
                            error: `The user denied this request (${permKey}: ${patterns.join(', ')}). Do not retry it without asking first.`,
                            code: 'permission_denied',
                        }, push);
                        return;
                    }
                    if (answer === 'always allow' || answer === 'always') {
                        for (const p of patterns)
                            state.approved.push({ permission: permKey, pattern: p, action: 'allow' });
                        push({ type: 'permission:reply', askId, outcome: 'always', traceId });
                    }
                    else if (answer === 'allow' || answer === 'yes') {
                        push({ type: 'permission:reply', askId, outcome: 'allow', traceId });
                    }
                    else {
                        outcome = { result: { error: 'Approval was not granted', code: 'permission_denied' }, isError: true };
                        return;
                    }
                    approval = Object.freeze({ permission: permKey, patterns: Object.freeze([...patterns]) });
                }
            }
            finally {
                releaseGate();
            }
        }
        const decision = await hookReg.runToolCall({
            session, config, signal,
            toolCall: { id: tc.id, name: tc.name, input: tc.input },
            tool,
        });
        if (decision.abort) {
            abortReason = decision.abort;
            finishSkipped(tc, index, toolSpanId, toolStartedAt, { error: decision.abort, code: 'aborted' }, push);
            const policySpanId = crypto.randomUUID();
            await observe({
                phase: 'end', kind: 'guardrail', name: `${tc.name}.policy`, spanId: policySpanId,
                parentSpanId: toolSpanId, sessionId, status: 'error', durationMs: 0,
                attributes: { callId: tc.id, policyOutcome: 'aborted', reason: decision.abort },
            });
            return;
        }
        if (decision.rejectTool) {
            const err = { error: decision.rejectTool.message };
            finishSkipped(tc, index, toolSpanId, toolStartedAt, err, push);
            const policySpanId = crypto.randomUUID();
            await observe({
                phase: 'end', kind: 'guardrail', name: `${tc.name}.policy`, spanId: policySpanId,
                parentSpanId: toolSpanId, sessionId, status: 'error', durationMs: 0,
                attributes: { callId: tc.id, policyOutcome: 'denied', reason: decision.rejectTool.message },
            });
            return;
        }
        let result: unknown;
        let isError = false;
        const startedAt = Date.now();
        signal.throwIfAborted();
        const toolCtx: ToolContext = {
            callId: tc.id, session, signal, vault,
            ...(approval ? { approval } : {}),
            provider: config.provider,
            traceId,
            rootTraceId,
            parentSpanId: toolSpanId,
            prompt: promptFn,
            loadPlugin: (specifier: string) => opts.loadPlugin(specifier, promptFn),
            unloadPlugin: opts.unloadPlugin,
            ...(opts.workdir !== undefined ? { workdir: opts.workdir } : {}),
            ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
            ...(opts.files !== undefined ? { files: opts.files } : {}),
        };
        try {
            for await (const toolEv of tool.executor.execute(tc.input, toolCtx)) {
                signal.throwIfAborted();
                switch (toolEv.type) {
                    case 'stdout':
                        push({ type: 'tool:stdout', callId: tc.id, chunk: toolEv.chunk, traceId });
                        break;
                    case 'stderr':
                        push({ type: 'tool:stderr', callId: tc.id, chunk: toolEv.chunk, traceId });
                        break;
                    case 'file':
                        push({ type: 'file', handle: toolEv.handle, traceId });
                        break;
                    case 'result':
                        result = toolEv.value;
                        break;
                    case 'marker':
                        toolMarkers.push({ type: 'marker', creator: toolEv.creator, data: toolEv.data });
                        break;
                    case 'progress':
                        opts.onProgress?.(toolEv);
                        break;
                    case 'error':
                        result = {
                            error: toolEv.message,
                            ...(toolEv.code !== undefined ? { code: toolEv.code } : {}),
                            ...(toolEv.stdout !== undefined ? { stdout: toolEv.stdout } : {}),
                            ...(toolEv.stderr !== undefined ? { stderr: toolEv.stderr } : {}),
                        };
                        isError = true;
                        break;
                }
            }
        }
        catch (e) {
            result = { error: String(e) };
            isError = true;
        }
        // toolresult — last chance to transform the result before it's recorded/yielded (hard redaction),
        // or to observe it (auditing: args + result + timing). Owns the LLM-facing + persisted surfaces.
        result = await hookReg.runToolResult({
            session, config, signal,
            toolCall: { id: tc.id, name: tc.name, input: tc.input },
            tool, result, isError, durationMs: Date.now() - startedAt,
        });
        // Universal output truncation (spec R16) — applied after hooks so redaction wins.
        const truncation = await truncateToolResult(result, outputLimits, opts.files, `${sessionId}/${tc.name}`);
        result = truncation.result;
        processed = true;
        outcome = { result, isError };
    };
    await execute();
    if (!processed) {
        outcome.result = await hookReg.runToolResult({ session, config, signal, toolCall: tc, tool,
            result: outcome.result, isError: outcome.isError, durationMs: Date.now() - toolStartedAt });
        outcome.result = (await truncateToolResult(outcome.result, outputLimits, opts.files, sessionId + '/' + tc.name)).result;
    }
    if (abortReason !== undefined)
        outcome.abortReason = abortReason;
    return outcome;
}
/**
 * Adapt the common invocation to a frontend's tool-event stream; results are emitted after result
 * hooks. Runs {@link executeToolInvocation} in the background, translating its pipeline push
 * events (stdout/stderr/file) and progress callbacks into {@link ToolEvent}s buffered in arrival
 * order, followed by any collected markers, then the terminal event. Consumption is lazy — events
 * are pulled as the consumer iterates — and aborting `ctx.signal`, or leaving the iterator early,
 * cancels the underlying execution.
 *
 * @param tool - The tool to invoke.
 * @param input - Raw call input (validated inside the invocation).
 * @param ctx - Tool context supplying session, vault, provider, ids, signal, and plugin wiring.
 * @param options - Optional hooks, permissions, output limits, interactivity, and span observer;
 *                  defaults to non-interactive.
 * @returns The tool-event stream: zero or more progress/stdout/stderr/file events in arrival
 *          order, then markers, then exactly one `error` or `result`.
 * @throws Never - Execution failures surface as a terminal `error` event.
 */
export async function* invokeToolEvents(tool: Tool, input: unknown, ctx: ToolContext, options: Pick<ToolInvocationOptions, 'hooks' | 'permissions' | 'toolOutput' | 'interactive' | 'observe'> = {}): AsyncIterable<ToolEvent> {
    const controller = new AbortController();
    const events: ToolEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    /**
     * Wake a parked consumer, if any.
     *
     * @returns Nothing.
     * @throws Never.
     */
    const notify = () => { wake?.(); wake = undefined; };
    const markers: MessageContent[] = [];
    const task = executeToolInvocation({ ...options, tool, call: { id: ctx.callId, name: tool.name, input },
        session: ctx.session, config: { provider: ctx.provider ?? '', traceId: ctx.traceId ?? ctx.callId, rootTraceId: ctx.rootTraceId ?? ctx.callId },
        signal: AbortSignal.any([ctx.signal, controller.signal]), vault: ctx.vault,
        onProgress: event => { events.push(event); notify(); }, prompt: ctx.prompt, interactive: options.interactive ?? false,
        loadPlugin: ctx.loadPlugin, unloadPlugin: ctx.unloadPlugin, markers,
        ...(ctx.files !== undefined ? { files: ctx.files } : {}),
        ...(ctx.workdir !== undefined ? { workdir: ctx.workdir } : {}),
        ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
    }, event => {
        if (event.type === 'tool:stdout')
            events.push({ type: 'stdout', chunk: event.chunk });
        else if (event.type === 'tool:stderr')
            events.push({ type: 'stderr', chunk: event.chunk });
        else if (event.type === 'file')
            events.push({ type: 'file', handle: event.handle });
        notify();
    }).then(outcome => {
        for (const marker of markers)
            if (marker.type === 'marker')
                events.push(marker);
        if (outcome.isError) {
            const value = outcome.result as {
                error?: unknown;
                code?: number | string;
            } | undefined;
            events.push({ type: 'error', message: String(value?.error ?? outcome.result), ...(value?.code !== undefined ? { code: value.code } : {}) });
        }
        else if (outcome.result !== undefined)
            events.push({ type: 'result', value: outcome.result });
    }).catch(error => { events.push({ type: 'error', message: String(error) }); }).finally(() => { done = true; notify(); });
    try {
        while (!done || events.length) {
            if (events.length)
                yield events.shift()!;
            else
                await new Promise<void>(resolve => { wake = resolve; });
        }
        await task;
    }
    finally {
        controller.abort();
    }
}
/**
 * Copy and freeze the host policy before loading any capability plugins, so a plugin can neither
 * mutate the live rules nor observe later mutation of them. The envelope, the rules array, and
 * each rule are frozen individually.
 *
 * @param policy - The host's invocation policy (rules plus defaults).
 * @returns A frozen copy of the policy.
 * @throws DOMException - `DataCloneError` if the policy cannot be structured-cloned (e.g. it
 *          carries functions or other non-cloneable values).
 */
export function freezeInvocationPolicy(policy: NonNullable<MatbotMachine['ToolInvocationPolicy']>) {
    const copy = structuredClone(policy);
    for (const rule of copy.rules ?? [])
        Object.freeze(rule);
    if (copy.rules)
        Object.freeze(copy.rules);
    return Object.freeze(copy);
}
/**
 * Bind host services without capturing replaceable feature services: the returned invoker reads
 * `hooks`, `Observability`, and `ToolInvocationPolicy` from the live machine on each call, so
 * plugin reloads and service swaps are honored. Each invocation requires the host policy (a
 * missing policy yields a `policy_unavailable` error event) and is observed as a tool span whose
 * end status reflects failure, abort, and completion.
 *
 * @param services - The live machine whose services back each invocation.
 * @returns An invoker yielding the tool-event stream for one call, with `error` events for
 *          policy and execution failures.
 * @throws Never - Failures are yielded as `error` events.
 */
export function createToolInvoker(services: MatbotMachine) {
    return {
        /**
         * Invoke one tool against the host's live services.
         *
         * @param tool - The tool to execute.
         * @param input - Raw call input (validated inside the invocation).
         * @param ctx - Tool context for this call (session, vault, ids, signal).
         * @returns The tool-event stream, ending with `result` or `error`; when the host policy
         *           is unavailable, the stream is a single `policy_unavailable` error event.
         * @throws Never - Failures surface as `error` events.
         */
        async *invoke(tool: Tool, input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
            const started = Date.now(), spanId = ctx.callId;
            let failed = false;
            let completed = false;
            /**
             * Record a span event against the machine's observability sink, stamping the call's
             * trace ids; sink failures are swallowed (they neither authorize nor block execution).
             *
             * @param event - Span event without correlation fields; the timestamp is filled in.
             * @returns Resolves once the sink has been invoked (or the failure swallowed).
             * @throws Never.
             */
            const observe = async (event: Omit<ObservabilityEvent, 'traceId' | 'rootTraceId' | 'timestamp'>) => { try {
                await services.Observability?.record({ ...event, traceId: ctx.traceId ?? ctx.callId, rootTraceId: ctx.rootTraceId ?? ctx.callId, timestamp: new Date().toISOString() });
            }
            catch { /* Observability failures do not authorize or block execution. */ } };
            await observe({ phase: 'start', kind: 'tool', name: tool.name, spanId, sessionId: ctx.session.id });
            try {
                const policy = services.ToolInvocationPolicy;
                if (!policy) {
                    failed = true;
                    yield { type: 'error', code: 'policy_unavailable', message: 'Host invocation policy is unavailable' };
                    return;
                }
                for await (const event of invokeToolEvents(tool, input, ctx, { hooks: services.hooks, observe, permissions: policy })) {
                    if (event.type === 'error')
                        failed = true;
                    yield event;
                }
                completed = true;
            }
            finally {
                await observe({ phase: 'end', kind: 'tool', name: tool.name, spanId, sessionId: ctx.session.id, status: failed || !completed || ctx.signal.aborted || tool.signal?.aborted ? 'error' : 'ok', durationMs: Date.now() - started });
            }
        } };
}
