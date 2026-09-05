import type { Tool, ToolContext, ToolEvent, MessageContent, PipelineEvent, ObservabilityEvent, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { HookRegistry } from './hooks.js';
import type { RunSessionOpts } from './runner.js';
import type { PermissionAction, PermissionRule } from './permissions.js';
import { evaluatePermission } from './permissions.js';
import { validateAgainstSchema, formatValidationIssues } from './schema-validator.js';
import { DEFAULT_OUTPUT_LIMITS, truncateToolResult } from './truncate.js';
import type { FormField } from './types.js';
/** Permission answers and prompt serialization live for one invocation group/turn. */
export function createInvocationState() { return { chain: Promise.resolve(), approved: [] as PermissionRule[] }; }
export interface ToolInvocationResult {
    result: unknown;
    isError: boolean;
    abortReason?: string;
}
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
/** Shared validated, permission-gated execution for model turns and direct frontends. */
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
    const finishSkipped = (_call: unknown, _index: number, _span: string, _started: number, result: unknown, _push: unknown): void => {
        outcome = { result, isError: true };
    };
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
/** Adapt the common invocation to a frontend's tool-event stream; results are emitted after result hooks. */
export async function* invokeToolEvents(tool: Tool, input: unknown, ctx: ToolContext, options: Pick<ToolInvocationOptions, 'hooks' | 'permissions' | 'toolOutput' | 'interactive' | 'observe'> = {}): AsyncIterable<ToolEvent> {
    const controller = new AbortController();
    const events: ToolEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
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
/** Copy and freeze the host policy before loading any capability plugins. */
export function freezeInvocationPolicy(policy: NonNullable<MatbotMachine['ToolInvocationPolicy']>) {
    const copy = structuredClone(policy);
    for (const rule of copy.rules ?? [])
        Object.freeze(rule);
    if (copy.rules)
        Object.freeze(copy.rules);
    return Object.freeze(copy);
}
/** Bind host services without capturing replaceable feature services. */
export function createToolInvoker(services: MatbotMachine) {
    return { async *invoke(tool: Tool, input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
            const started = Date.now(), spanId = ctx.callId;
            let failed = false;
            let completed = false;
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
