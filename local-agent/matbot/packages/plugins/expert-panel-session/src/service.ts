import type { Session, Store, Message, MessageContent, Tool, ToolContext, ToolEvent, SessionRunner } from '@matatbread/matbot-plugin-api';
import { appendMessage, createMessage } from '@matatbread/matbot-core';
/**
 * Normalized request body for an expert panel submission. Built by
 * {@link normaliseExpertPanelSubmitBody} from a raw request payload.
 */
interface ExpertPanelSubmitBody {
    question: string;
    provider: string;
    experts?: string[];
    mode?: 'parallel' | 'review' | 'debate';
    synthesize?: boolean;
    maxCitationsPerExpert?: number;
    traceId?: string;
}
/**
 * Checks whether a value is a plain, non-array object.
 * @param value - Value to test.
 * @returns True when `value` is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Resolves after `ms` milliseconds; the only waiting primitive used by CAS retries. */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/**
 * Validates and normalizes a raw expert panel submission payload.
 *
 * Requires a `question` and a `provider`; tolerates missing or malformed
 * optional fields by dropping them. `mode` defaults to `parallel` for anything
 * unrecognized, and `experts` entries that are not strings are silently
 * filtered out (an array of only empty/invalid entries becomes no `experts`
 * field at all, meaning "all experts").
 *
 * @param value - Raw request body of unknown shape.
 * @returns Either `{ ok: true, body }` with the normalized submission, or
 *   `{ ok: false, error }` with a client-facing message.
 * @throws Never - validation failures are reported in the returned `ok: false` shape.
 */
function normaliseExpertPanelSubmitBody(value: unknown): {
    ok: true;
    body: ExpertPanelSubmitBody;
} | {
    ok: false;
    error: string;
} {
    if (!isRecord(value))
        return { ok: false, error: 'Request body must be an object.' };
    const question = typeof value.question === 'string' ? value.question.trim() : '';
    if (!question)
        return { ok: false, error: '"question" is required.' };
    const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
    if (!provider)
        return { ok: false, error: '"provider" is required.' };
    const mode = value.mode === 'review' || value.mode === 'debate' || value.mode === 'parallel'
        ? value.mode
        : 'parallel';
    let experts: string[] | undefined;
    if (Object.prototype.hasOwnProperty.call(value, 'experts')) {
        if (!Array.isArray(value.experts))
            return { ok: false, error: '"experts" must be an array of expert ids.' };
        experts = value.experts
            .filter((item): item is string => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean);
    }
    const maxCitationsPerExpert = typeof value.maxCitationsPerExpert === 'number'
        ? value.maxCitationsPerExpert
        : undefined;
    return {
        ok: true,
        body: {
            question,
            provider,
            mode,
            ...(experts !== undefined ? { experts } : {}),
            ...(typeof value.synthesize === 'boolean' ? { synthesize: value.synthesize } : {}),
            ...(maxCitationsPerExpert !== undefined ? { maxCitationsPerExpert } : {}),
            ...(typeof value.traceId === 'string' && value.traceId.trim() ? { traceId: value.traceId.trim() } : {}),
        },
    };
}
/**
 * Builds the user-visible text appended to the session when an expert panel
 * question is queued: a header with mode, expert selection, and synthesis flag,
 * followed by the question itself.
 *
 * @param question - The submitted question text.
 * @param selected - Selected expert ids, or `undefined` meaning all experts.
 * @param mode - Panel mode label (`parallel`, `review`, or `debate`).
 * @param synthesize - Whether a synthesis step was requested.
 * @returns The multi-line summary text.
 * @throws Never.
 */
function expertUserSummary(question: string, selected: readonly string[] | undefined, mode: string, synthesize: boolean): string {
    return [
        `Expert panel (${mode})`,
        `Experts: ${selected && selected.length ? selected.join(', ') : 'all'}`,
        `Synthesize decision: ${synthesize ? 'yes' : 'no'}`,
        '',
        question,
    ].join('\n');
}
/**
 * Returns `value` when it is a string, otherwise `fallback`.
 * @param value - Value to coerce.
 * @param fallback - Value to use when `value` is not a string; defaults to `''`.
 * @returns The string value or the fallback.
 * @throws Never.
 */
function textValue(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}
/**
 * Formats an expert panel tool result as markdown for the session transcript:
 * one section per expert opinion (with optional citation list) plus an optional
 * synthesis section, or a "no response" note when nothing was returned.
 *
 * @param result - Raw tool result of unknown shape (the `expert_panel` tool's
 *   result value with `experts` opinions and optional `synthesis`).
 * @returns The formatted markdown text.
 * @throws Never.
 */
function formatExpertPanelResult(result: unknown): string {
    const record = isRecord(result) ? result : {};
    const lines = [
        '## Expert panel',
        `Mode: ${textValue(record.mode, 'parallel')}`,
    ];
    const opinions = Array.isArray(record.experts) ? record.experts : [];
    for (const rawOpinion of opinions) {
        const opinion = isRecord(rawOpinion) ? rawOpinion : {};
        lines.push('', `### ${textValue(opinion.title, textValue(opinion.expertId, 'Expert'))}`, textValue(opinion.answer, '(No answer returned.)'));
        const citations = Array.isArray(opinion.citations) ? opinion.citations : [];
        if (citations.length) {
            lines.push('', 'Citations:');
            for (const rawCitation of citations) {
                const citation = isRecord(rawCitation) ? rawCitation : {};
                const title = textValue(citation.title, textValue(citation.id, textValue(citation.path, 'source')));
                const path = typeof citation.path === 'string' && citation.path ? ` - ${citation.path}` : '';
                lines.push(`- ${title}${path}`);
            }
        }
    }
    if (typeof record.synthesis === 'string' && record.synthesis) {
        lines.push('', '### Synthesis', record.synthesis);
    }
    if (!opinions.length && !record.synthesis) {
        lines.push('', 'No expert response was returned.');
    }
    return lines.join('\n');
}
/**
 * Sums the token usage reported across all expert opinions in a panel result.
 * @param result - Raw tool result of unknown shape.
 * @returns Total `inputTokens`/`outputTokens`, or `null` when no opinion
 *   reported any usage at all.
 * @throws Never.
 */
function expertPanelUsage(result: unknown): {
    inputTokens: number;
    outputTokens: number;
} | null {
    const record = isRecord(result) ? result : {};
    const opinions = Array.isArray(record.experts) ? record.experts : [];
    let inputTokens = 0;
    let outputTokens = 0;
    for (const rawOpinion of opinions) {
        const opinion = isRecord(rawOpinion) ? rawOpinion : {};
        const usage = isRecord(opinion.usage) ? opinion.usage : {};
        if (typeof usage.inputTokens === 'number')
            inputTokens += usage.inputTokens;
        if (typeof usage.outputTokens === 'number')
            outputTokens += usage.outputTokens;
    }
    return inputTokens || outputTokens ? { inputTokens, outputTokens } : null;
}
/**
 * Derives a session title from a question: the first eight words, truncated to
 * 60 characters when longer.
 * @param question - Question text to summarize.
 * @returns The derived title, or `undefined` when the question has no words.
 * @throws Never.
 */
function titleFromQuestion(question: string): string | undefined {
    const words = question.trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
    if (!words)
        return undefined;
    return words.length > 60 ? `${words.slice(0, 60)}...` : words;
}
/**
 * HTTP-style error raised by the expert session service. `status` carries the
 * transport-level status code the web layer should reply with (e.g. 400 for
 * invalid input, 409 for conflicts, 503 when the service is unloaded).
 */
export class ExpertSessionError extends Error {
    readonly status: number;
    /**
     * Creates the error.
     * @param status - HTTP-style status code for the failure.
     * @param message - Human-readable failure description.
     */
    constructor(status: number, message: string) { super(message); this.status = status; }
}
/**
 * Dependencies of the {@link ExpertSessionService}: the session store and
 * runner status it operates on, plus pluggable tool resolution, tool
 * invocation, and optional async session titling. Supplied by the plugin's
 * `setup` and easily replaced in tests.
 */
export interface ExpertSessionDeps {
    store: Store<Session>;
    run: Pick<SessionRunner, 'status'>;
    resolve: (name: string) => Tool | null;
    invoke: (tool: Tool, input: unknown, ctx: ToolContext) => AsyncIterable<ToolEvent>;
    titleSession?: (input: {
        sessionId: string;
        provider: string;
    }) => Promise<unknown>;
}
/**
 * Runs one-shot expert panel consultations inside existing sessions.
 *
 * Each {@link ExpertSessionService.submit} validates the request, guards
 * against busy sessions, invokes the `expert_panel` tool under an
 * {@link AbortController} linked to the caller's signal, and appends both the
 * queued user message and the assistant answer to the session via
 * compare-and-swap appends. Only one submit may run per session at a time;
 * `close` aborts every in-flight submit.
 */
export class ExpertSessionService {
    private active = new Map<string, AbortController>();
    private closed = false;
    private readonly deps: ExpertSessionDeps;
    /**
     * Creates the service.
     * @param deps - Session store, runner status accessor, tool resolve/invoke
     *   functions, and optional titler; see {@link ExpertSessionDeps}.
     */
    constructor(deps: ExpertSessionDeps) { this.deps = deps; }
    /**
     * Checks whether a submit is currently in flight for a session.
     * @param id - Session id to check.
     * @returns True while a submit for this session is active.
     * @throws Never.
     */
    busy(id: string) { return this.active.has(id); }
    /**
     * Marks the service closed and aborts every in-flight submit. Subsequent
     * submits are rejected with 503 until the service is unloaded.
     */
    close() { this.closed = true; for (const ac of this.active.values())
        ac.abort(); }
    /**
     * Runs one expert panel consultation in a session and persists the
     * transcript.
     *
     * Normalizes and validates the raw payload, rejects busy sessions, resolves
     * the `expert_panel` tool, and streams its events while capturing the
     * result, stdout/stderr, markers, and errors. The formatted answer (or
     * failure text) is appended as an assistant message; markers are appended
     * as a marker-role message first. Emits web-style events (`queued`,
     * `marker`, `text-delta`, `usage`, `done`) through `emit`. Session titles
     * are derived from the question when the session has none, and async
     * titling is kicked off fire-and-forget when a `titleSession` dep is set.
     * All appends go through CAS with bounded retries; the caller's abort
     * signal cancels the underlying tool invocation.
     *
     * @param sessionId - Target session id; must exist in the store.
     * @param raw - Raw request payload, validated by
     *   {@link normaliseExpertPanelSubmitBody}.
     * @param ctx - Tool context whose `signal` aborts the consultation; its
     *   session/provider fields are overridden for the tool invocation.
     * @param emit - Optional sink for transport events; defaults to a no-op.
     *   Event ordering matches the flow above; `done` is always last.
     * @returns The trace id, the committed session after the assistant message,
     *   the raw tool `result` when produced, and `isError`/`error` reflecting
     *   whether the panel itself failed (tool errors do not reject this promise).
     * @throws ExpertSessionError - 503 when closed, 400 for invalid input, 409
     *   when the session is busy or was concurrently modified beyond the CAS
     *   retry budget, 404 when the session or tool is missing.
     */
    async submit(sessionId: string, raw: unknown, ctx: ToolContext, emit: (event: Record<string, unknown> & {
        type: string;
    }) => void = () => { }) {
        if (this.closed)
            throw new ExpertSessionError(503, 'Expert session service unloaded');
        const normalised = normaliseExpertPanelSubmitBody(raw);
        if (!normalised.ok)
            throw new ExpertSessionError(400, normalised.error);
        const body = normalised.body;
        if (this.deps.run.status(sessionId).busy || this.busy(sessionId))
            throw new ExpertSessionError(409, 'Session is busy.');
        const tool = this.deps.resolve('expert_panel');
        if (!tool)
            throw new ExpertSessionError(404, 'Tool "expert_panel" not found');
        const ac = new AbortController();
        const cancel = () => ac.abort();
        ctx.signal.addEventListener('abort', cancel, { once: true });
        if (ctx.signal.aborted)
            ac.abort();
        this.active.set(sessionId, ac);
        const traceId = body.traceId ?? crypto.randomUUID();
        try {
            ac.signal.throwIfAborted();
            const synthesize = body.synthesize !== false, selected = body.experts?.length ? body.experts : undefined;
            const input = { action: 'ask', question: body.question, mode: body.mode ?? 'parallel', synthesize, maxCitationsPerExpert: body.maxCitationsPerExpert ?? 5, ...(selected ? { experts: selected } : {}) };
            const userContent: MessageContent[] = [{ type: 'text', text: expertUserSummary(body.question, selected, input.mode, synthesize) }];
            const userMessage = createMessage({ role: 'user', content: userContent, traceId, providerName: body.provider, metadata: { expertPanel: { mode: input.mode, synthesize, experts: selected ?? 'all' } } });
            let committed = await this.append(sessionId, [userMessage], current => {
                if (current.title || current.messages.some(m => m.role === 'user'))
                    return current;
                const title = titleFromQuestion(body.question);
                return title ? { ...current, title } : current;
            });
            if (!committed)
                throw new ExpertSessionError(404, 'Session not found');
            emit({ type: 'queued', content: userContent, queued: 0, concatQueue: false, traceId, rootTraceId: traceId });
            let result: unknown, errorMessage: string | undefined, stdout = '', stderr = '';
            const markers: MessageContent[] = [];
            try {
                for await (const ev of this.deps.invoke(tool, input, { ...ctx, signal: ac.signal, session: committed, provider: body.provider, traceId, rootTraceId: traceId })) {
                    if (ev.type === 'result')
                        result = ev.value;
                    else if (ev.type === 'stdout')
                        stdout += ev.chunk;
                    else if (ev.type === 'stderr')
                        stderr += ev.chunk;
                    else if (ev.type === 'marker')
                        markers.push({ type: 'marker', creator: ev.creator, data: ev.data });
                    else if (ev.type === 'error')
                        errorMessage = ev.message;
                }
            }
            catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
            }
            const assistantText = errorMessage ? 'Expert panel failed: ' + errorMessage : formatExpertPanelResult(result);
            const assistant = createMessage({ role: 'assistant', content: [{ type: 'text', text: assistantText }], traceId, providerName: body.provider, metadata: { expertPanel: { result, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) } } });
            const messages: Message[] = [];
            if (markers.length)
                messages.push(createMessage({ role: 'marker', content: markers, traceId }));
            messages.push(assistant);
            committed = await this.append(sessionId, messages);
            if (!committed)
                throw new ExpertSessionError(404, 'Session not found');
            if (markers.length)
                emit({ type: 'marker', content: markers, traceId });
            emit({ type: 'text-delta', delta: assistantText, traceId });
            const usage = expertPanelUsage(result);
            if (usage)
                emit({ type: 'usage', ...usage, traceId });
            emit({ type: 'done', session: committed, traceId });
            void this.deps.titleSession?.({ sessionId, provider: body.provider }).catch(() => { });
            return { traceId, session: committed, ...(result !== undefined ? { result } : {}), ...(errorMessage !== undefined ? { isError: true, error: errorMessage } : { isError: false }) };
        }
        finally {
            ctx.signal.removeEventListener('abort', cancel);
            this.active.delete(sessionId);
            ac.abort();
        }
    }
    /**
     * Appends messages to a session using compare-and-swap with randomized
     * backoff retries (at most 10 attempts, sub-second retry window).
     *
     * A contended append never bypasses CAS: it re-reads the session and
     * retries, and fails the request with 409 rather than dropping concurrent
     * messages. Optionally reshapes the freshly read session (e.g. to set a
     * derived title) before applying the appends.
     *
     * @param sessionId - Session to append to; must exist in the store.
     * @param messages - Messages to append, in order.
     * @param shapeSession - Optional pure transform applied to the current
     *   session before the messages are appended.
     * @returns The committed session document, or `null` when the session does
     *   not exist.
     * @throws ExpertSessionError - 409 when every CAS attempt loses the race.
     */
    private async append(sessionId: string, messages: readonly Message[], shapeSession?: (session: Session) => Session): Promise<Session | null> {
        // Never bypass CAS on a shared session document: a contended append retries with randomized
        // backoff and then fails the request with 409 instead of dropping concurrent messages.
        for (let attempt = 0; attempt < 10; attempt++) {
            const current = await this.deps.store.get(sessionId);
            if (!current)
                return null;
            const shaped = shapeSession ? shapeSession(current) : current;
            const next = messages.reduce((session, message) => appendMessage(session, message), shaped);
            const saved = await this.deps.store.cas(sessionId, current.version, next);
            if (saved.ok)
                return saved.doc;
            // Exponential start, clamped so the whole retry window stays sub-second.
            await sleep(Math.min(2 ** attempt * 5, 50) + Math.random() * 10);
        }
        throw new ExpertSessionError(409, 'Session was concurrently modified; retry the operation.');
    }
}
