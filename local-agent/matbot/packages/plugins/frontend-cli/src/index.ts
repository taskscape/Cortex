import { createInterface } from 'node:readline/promises';
import { appendMessage, createMessage, createSession } from '@matatbread/matbot-core';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, Session, SessionRunner, Principal, PromptFn, FormField, MessageContent, Store } from '@matatbread/matbot-plugin-api';
const isBackground = process.env.IS_SUB_AGENT === '1';
const _pid = process.pid;
const write = (s: string) => { if (!isBackground)
    process.stderr.write(s); };
// Colour only when writing to an interactive terminal — piped/background output stays clean.
const useColor = !isBackground && process.stderr.isTTY === true;
const yellow = (s: string): string => (useColor ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
// One marker block → a human-facing line. The dispatcher's hook-failure marker is a warning
// (amber); any other marker is shown dimmed and generic.
function formatMarker(part: Extract<MessageContent, {
    type: 'marker';
}>): string {
    if (part.creator === 'matbot-hooks') {
        const data = (part.data ?? {}) as {
            channel?: string;
            pluginName?: string;
            message?: string;
        };
        const who = data.pluginName !== undefined ? ` (${data.pluginName})` : '';
        return yellow(`⚠  ${data.channel ?? 'hook'} hook${who} failed and was skipped: ${data.message ?? 'unknown error'}`);
    }
    return dim(`🔖 ${part.creator}: ${JSON.stringify(part.data)}`);
}
async function runTurn(session: Session, content: string | MessageContent[], run: SessionRunner, providerName: string, principal: Principal, promptFn: PromptFn): Promise<Session> {
    const ac = new AbortController();
    // Ctrl-C aborts the running turn (and drops anything queued) through the runner.
    const onSigint = (): void => { run.abort(session.id); };
    process.once('SIGINT', onSigint);
    const contentArr: MessageContent[] = typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : content;
    let updated = session;
    let totalIn = 0;
    let totalOut = 0;
    let totalCostUsd = 0;
    let thinkingTicks = 0;
    const clearThinking = (): void => {
        if (thinkingTicks > 0) {
            process.stderr.write('\n');
            thinkingTicks = 0;
        }
    };
    try {
        // The runner appends + persists the user message and auto-titles at turn start.
        const view = await run.open({
            sessionId: session.id,
            signal: ac.signal,
            content: contentArr,
            provider: providerName,
            principal,
            prompt: promptFn,
        });
        for await (const ev of view.events) {
            if (ev.type === 'idle')
                continue; // session-level lifecycle signal, not this turn's
            if (ev.traceId !== view.traceId)
                continue;
            switch (ev.type) {
                case 'text-delta':
                    clearThinking();
                    process.stdout.write(ev.delta);
                    break;
                case 'thinking':
                    thinkingTicks++;
                    write(`\r[thinking… ×${thinkingTicks}]`);
                    break;
                case 'tool:start':
                    clearThinking();
                    write(`\n⚙  ${ev.name} ${JSON.stringify(ev.input)}\n`);
                    break;
                case 'tool:stdout':
                    write(ev.chunk);
                    break;
                case 'tool:stderr':
                    write(ev.chunk);
                    break;
                case 'tool:end':
                    write(`\n`);
                    break;
                case 'usage':
                    totalIn += ev.inputTokens;
                    totalOut += ev.outputTokens;
                    if (ev.costUsd !== undefined)
                        totalCostUsd += ev.costUsd;
                    break;
                case 'done':
                    clearThinking();
                    updated = ev.session;
                    break;
                case 'robo-user': {
                    // Machine-authored context folded onto the user turn by a screen hook (e.g. a fired
                    // `contextual` trigger) — system-supplied, not the user's words, so label it as such.
                    const text = ev.content
                        .filter((c): c is Extract<MessageContent, {
                        type: 'text';
                    }> => c.type === 'text')
                        .map(c => c.text).join('');
                    if (text)
                        write(`[context] ${text}\nassistant: `);
                    break;
                }
                case 'aborted': {
                    clearThinking();
                    updated = ev.session;
                    const formMsg = [...ev.session.messages].reverse().find(m => m.content.some(c => c.type === 'form'));
                    if (formMsg) {
                        const formPart = formMsg.content.find((c): c is Extract<MessageContent, {
                            type: 'form';
                        }> => c.type === 'form');
                        if (formPart) {
                            write('\n');
                            const values: Record<string, string> = {};
                            for (const field of formPart.fields) {
                                const hint = field.options ? ` [${field.options.join('/')}]` : '';
                                values[field.name] = await promptFn(`${field.label}${hint}`, field.default);
                            }
                            process.removeListener('SIGINT', onSigint);
                            ac.abort();
                            return await runTurn(ev.session, [{ type: 'form-response', values }], run, providerName, principal, promptFn);
                        }
                    }
                    else {
                        process.stderr.write(`\n[aborted: ${ev.reason}]\n`);
                    }
                    break;
                }
                case 'marker': {
                    clearThinking();
                    for (const part of ev.content) {
                        if (part.type === 'marker')
                            write(`\n${formatMarker(part)}\n`);
                    }
                    break;
                }
                case 'error':
                    clearThinking();
                    process.stderr.write(`\n[error: ${ev.error}]\n`);
                    break;
                default: break;
            }
            // One submission == one turn here; the per-session stream would otherwise keep yielding.
            if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error' || ev.type === 'cancelled')
                break;
        }
    }
    finally {
        process.removeListener('SIGINT', onSigint);
        ac.abort();
    }
    write('\n');
    if (totalIn > 0 || totalOut > 0) {
        const cost = totalCostUsd > 0 ? ` ≈$${totalCostUsd.toFixed(4)}` : '';
        write(`[↑${totalIn} ↓${totalOut} tokens${cost}]\n`);
    }
    return updated;
}
export interface CliFrontendOptions {
    store: Store<Session>;
    run: SessionRunner;
    provider: string;
    principal: Principal;
    session?: string;
    system?: string;
    prompt?: string;
    ephemeral: boolean;
}
export interface CliFrontend {
    start(options: CliFrontendOptions): Promise<void>;
}
declare module '@matatbread/matbot-plugin-api' {
    interface MatbotServices {
        readonly CliFrontend?: CliFrontend;
    }
}
export async function runCli(options: CliFrontendOptions): Promise<void> {
    const { store, principal, provider: providerName } = options;
    // ── Session ───────────────────────────────────────────────────────────────────
    // The session owner is the boot identity established at the entry, not a fresh system principal —
    // so a single-turn run launched as a specific user (pod / `--principal` / background delegation)
    // owns its session as that user.
    let session: Session;
    if (options.session && options.session !== 'create') {
        const existing = await store.get(options.session);
        if (!existing) {
            throw new Error(`Session "${options.session}" not found.`);
        }
        session = existing;
    }
    else {
        session = createSession({ ownerPrincipal: principal });
        if (options.system) {
            session = appendMessage(session, createMessage({
                role: 'system',
                content: [{ type: 'text', text: options.system }],
                traceId: crypto.randomUUID(),
            }));
        }
    }
    if (options.ephemeral) {
        process.stderr.write(`[${new Date().toISOString()} ${_pid}] provider: ${providerName}  (ephemeral)\n\n`);
    }
    else {
        process.stderr.write(`[${new Date().toISOString()} ${_pid}] provider: ${providerName}  session: ${session.id}\n\n`);
    }
    await store.set(session.id, session);
    const cliRun = options.run;
    // ── Readline (shared by single-turn and REPL for tool prompts) ──────────────
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.on('SIGINT', () => { process.stderr.write('\n'); rl.close(); });
    const stdinPrompt = (async (p: string | FormField, defaultValue?: string): Promise<string> => {
        if (typeof p !== 'string') {
            const def = p.default;
            if (p.type === 'select' || p.type === 'confirm') {
                const opts = p.type === 'confirm' ? ['yes', 'no'] : (p.options ?? []);
                const hint = opts.map(o => def !== undefined && o.toLowerCase() === def.toLowerCase() ? o.toUpperCase() : o).join('/');
                const raw = (await rl.question(`${p.label} [${hint}] `)).trim();
                if (!raw)
                    return def ?? '';
                return opts.find(o => o.toLowerCase().startsWith(raw.toLowerCase())) ?? def ?? raw;
            }
            const suffix = def !== undefined ? ` [${def}] ` : ' ';
            return (await rl.question(`${p.label}${suffix}`)).trim() || def || '';
        }
        const suffix = defaultValue !== undefined ? ` [${defaultValue}] ` : ' ';
        const answer = await rl.question(`${p}${suffix}`);
        return answer.trim() || defaultValue || '';
    }) as PromptFn;
    // ── Single-turn ──────────────────────────────────────────────────────────────
    if (options.prompt !== undefined) {
        try {
            await runTurn(session, options.prompt, cliRun, providerName, principal, stdinPrompt);
        }
        finally {
            rl.close();
        }
        return;
    }
    // ── Interactive REPL ─────────────────────────────────────────────────────────
    try {
        for (;;) {
            let line: string;
            try {
                line = await rl.question('you: ');
            }
            catch {
                break; // Ctrl+D / EOF
            }
            if (!line.trim())
                continue;
            process.stderr.write('assistant: ');
            session = await runTurn(session, line, cliRun, providerName, principal, stdinPrompt);
        }
    }
    finally {
        rl.close();
    }
    if (!options.ephemeral) {
        process.stderr.write(`\nTo resume: matbot --provider ${providerName} --session ${session.id}\n`);
    }
}
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION, async setup(services) {
        if (services.isSubAgent())
            return;
        services.registerFrontend({ name: 'frontend-cli' });
        await services.register('CliFrontend', { start: runCli });
    } };
