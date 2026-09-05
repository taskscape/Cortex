import type { Session, Store, Message, MessageContent, Tool, ToolContext, ToolEvent, SessionRunner } from '@matatbread/matbot-plugin-api';
import { appendMessage, createMessage } from '@matatbread/matbot-core';
interface ExpertPanelSubmitBody {
    question: string;
    provider: string;
    experts?: string[];
    mode?: 'parallel' | 'review' | 'debate';
    synthesize?: boolean;
    maxCitationsPerExpert?: number;
    traceId?: string;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
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
function expertUserSummary(question: string, selected: readonly string[] | undefined, mode: string, synthesize: boolean): string {
    return [
        `Expert panel (${mode})`,
        `Experts: ${selected && selected.length ? selected.join(', ') : 'all'}`,
        `Synthesize decision: ${synthesize ? 'yes' : 'no'}`,
        '',
        question,
    ].join('\n');
}
function textValue(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}
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
function titleFromQuestion(question: string): string | undefined {
    const words = question.trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
    if (!words)
        return undefined;
    return words.length > 60 ? `${words.slice(0, 60)}...` : words;
}
export class ExpertSessionError extends Error {
    readonly status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
}
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
export class ExpertSessionService {
    private active = new Map<string, AbortController>();
    private closed = false;
    private readonly deps: ExpertSessionDeps;
    constructor(deps: ExpertSessionDeps) { this.deps = deps; }
    busy(id: string) { return this.active.has(id); }
    close() { this.closed = true; for (const ac of this.active.values())
        ac.abort(); }
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
