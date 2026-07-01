// In-process provider for the matbot web UI (browser bundle side).
//
// The browser counterpart of http-transport.js + server.ts: it sets `window.matbotTransport` to an
// implementation that drives `services.run` / `services.tools` directly (no HTTP, no wire), then
// mounts the *same* index.html scaffold + app.js that Node serves. app.js is byte-identical in both
// modes; only the transport behind `window.matbotTransport` differs.
//
// Resolved by the assembler via the `browser` export condition (frontend/web/package.json), so this
// file — not server.ts — is what enters the browser graph. Never served raw by Node.
//
// The in-process transport is server.ts re-expressed without HTTP: per-session subscribe, the busy
// tracker, prompt parking, and the buffered tool-call ctx, all ported faithfully.

import { appendMessage, createMessage, createSession, currentPrincipal, PromptCancelledError, watchPlugins } from '@matatbread/matbot-core';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

// ── In-process transport ──────────────────────────────────────────────────────

function makeInProcessTransport(services) {
  const run = services.run;

  // sid → the parked prompt's settlers (mirror server.ts pendingPrompts). resolve applies the
  // default fallback; cancel rejects with PromptCancelledError (the "give up" path).
  const pendingPrompts = new Map();
  // sid → set of live sessionEvents() injectors, so a turn's promptFn can push a synthetic `prompt`
  // event into whatever stream the UI is currently draining (mirror server.ts sendToSession).
  const hubs = new Map();
  function hub(sid) {
    let h = hubs.get(sid);
    if (h === undefined) { h = new Set(); hubs.set(sid, h); }
    return h;
  }

  // Authoritative busy from the runner (running || queued > 0), deduped + broadcast to statusEvents
  // subscribers (mirror server.ts updateBusy / statusListeners / busyState).
  const statusListeners = new Set();
  const busyState = new Map();
  const busyTrackers = new Set();
  const expertPanelBusySessions = new Set();
  function updateBusy(sid) {
    const busy = run.status(sid).busy;
    if ((busyState.get(sid) ?? false) === busy) return;
    if (busy) busyState.set(sid, true); else busyState.delete(sid);
    for (const l of statusListeners) l({ sessionId: sid, busy });
  }

  // The single interactive prompt implementation for direct tool calls has no answer channel, so it
  // can't prompt — take the offered default or fail loudly (mirror server.ts nonInteractivePrompt).
  const nonInteractivePrompt = (p, def) => {
    const fallback = typeof p === 'string' ? def : p.default;
    return fallback !== undefined
      ? Promise.resolve(fallback)
      : Promise.reject(new Error(`Non-interactive context (use submit for interactive prompts): "${typeof p === 'string' ? p : p.label}"`));
  };

  function makeToolCtx(ac, invocation = {}) {
    const now = new Date().toISOString();
    const stubSession = {
      id: crypto.randomUUID(), version: crypto.randomUUID(),
      ownerPrincipalId: currentPrincipal().id,
      status: 'active', contexts: [], messages: [],
      createdAt: now, updatedAt: now,
    };
    return {
      callId:       crypto.randomUUID(),
      session:      invocation.session ?? stubSession,
      signal:       ac.signal,
      vault:        services.vault,
      loadPlugin:   services.loadPlugin.bind(services),
      unloadPlugin: services.unloadPlugin.bind(services),
      prompt:       nonInteractivePrompt,
      ...(invocation.provider !== undefined ? { provider: invocation.provider } : {}),
      ...(services.workdir    !== undefined ? { workdir:    services.workdir    } : {}),
      ...(services.files      !== undefined ? { files:      services.files      } : {}),
      ...(services.configPath !== undefined ? { configPath: services.configPath } : {}),
    };
  }

  function normaliseExpertPanelBody(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'Request body must be an object.' };
    const question = typeof value.question === 'string' ? value.question.trim() : '';
    if (!question) return { ok: false, error: '"question" is required.' };
    const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
    if (!provider) return { ok: false, error: '"provider" is required.' };
    const mode = value.mode === 'review' || value.mode === 'debate' || value.mode === 'parallel' ? value.mode : 'parallel';
    let experts;
    if (Object.prototype.hasOwnProperty.call(value, 'experts')) {
      if (!Array.isArray(value.experts)) return { ok: false, error: '"experts" must be an array of expert ids.' };
      experts = value.experts.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean);
    }
    return {
      ok: true,
      body: {
        question,
        provider,
        mode,
        ...(experts !== undefined ? { experts } : {}),
        ...(typeof value.synthesize === 'boolean' ? { synthesize: value.synthesize } : {}),
        ...(typeof value.maxCitationsPerExpert === 'number' ? { maxCitationsPerExpert: value.maxCitationsPerExpert } : {}),
        ...(typeof value.traceId === 'string' && value.traceId.trim() ? { traceId: value.traceId.trim() } : {}),
      },
    };
  }

  function expertUserSummary(question, selected, mode, synthesize) {
    return [
      `Expert panel (${mode})`,
      `Experts: ${selected && selected.length ? selected.join(', ') : 'all'}`,
      `Synthesize decision: ${synthesize ? 'yes' : 'no'}`,
      '',
      question,
    ].join('\n');
  }

  function textValue(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function formatExpertPanelResult(result) {
    const record = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    const lines = ['## Expert panel', `Mode: ${textValue(record.mode, 'parallel')}`];
    const opinions = Array.isArray(record.experts) ? record.experts : [];
    for (const rawOpinion of opinions) {
      const opinion = rawOpinion && typeof rawOpinion === 'object' && !Array.isArray(rawOpinion) ? rawOpinion : {};
      lines.push('', `### ${textValue(opinion.title, textValue(opinion.expertId, 'Expert'))}`, textValue(opinion.answer, '(No answer returned.)'));
      const citations = Array.isArray(opinion.citations) ? opinion.citations : [];
      if (citations.length) {
        lines.push('', 'Citations:');
        for (const rawCitation of citations) {
          const citation = rawCitation && typeof rawCitation === 'object' && !Array.isArray(rawCitation) ? rawCitation : {};
          const title = textValue(citation.title, textValue(citation.id, textValue(citation.path, 'source')));
          const path = typeof citation.path === 'string' && citation.path ? ` - ${citation.path}` : '';
          lines.push(`- ${title}${path}`);
        }
      }
    }
    if (typeof record.synthesis === 'string' && record.synthesis) lines.push('', '### Synthesis', record.synthesis);
    if (!opinions.length && !record.synthesis) lines.push('', 'No expert response was returned.');
    return lines.join('\n');
  }

  function expertPanelUsage(result) {
    const record = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    const opinions = Array.isArray(record.experts) ? record.experts : [];
    let inputTokens = 0;
    let outputTokens = 0;
    for (const rawOpinion of opinions) {
      const opinion = rawOpinion && typeof rawOpinion === 'object' && !Array.isArray(rawOpinion) ? rawOpinion : {};
      const usage = opinion.usage && typeof opinion.usage === 'object' && !Array.isArray(opinion.usage) ? opinion.usage : {};
      if (typeof usage.inputTokens === 'number') inputTokens += usage.inputTokens;
      if (typeof usage.outputTokens === 'number') outputTokens += usage.outputTokens;
    }
    return inputTokens || outputTokens ? { inputTokens, outputTokens } : null;
  }

  function titleFromQuestion(question) {
    const words = question.trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
    if (!words) return undefined;
    return words.length > 60 ? `${words.slice(0, 60)}...` : words;
  }

  async function appendSessionMessages(sessionId, messages, shapeSession) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await services.sessions.get(sessionId);
      if (!current) return null;
      const shaped = shapeSession ? shapeSession(current) : current;
      const next = messages.reduce((session, message) => appendMessage(session, message), shaped);
      const saved = await services.sessions.cas(sessionId, current.version, next);
      if (saved.ok) return saved.doc;
    }
    const current = await services.sessions.get(sessionId);
    if (!current) return null;
    const shaped = shapeSession ? shapeSession(current) : current;
    const next = messages.reduce((session, message) => appendMessage(session, message), shaped);
    await services.sessions.set(sessionId, next);
    return next;
  }

  // Two failure modes the UI depends on (see the plan's contract):
  //  - tool not installed → throw with "404"/"not found" so app.js offers the install banner.
  //  - any other failure  → throw without those substrings so app.js reports it instead.
  async function callTool(name, input) {
    const tool = services.tools.resolve(name);
    if (!tool) throw new Error(`Tool "${name}" not found (404)`);
    const ac = new AbortController();
    const ctx = makeToolCtx(ac);
    for await (const ev of tool.executor.execute(input, ctx)) {
      if (ev.type === 'result') return ev.value;
      if (ev.type === 'error')  throw new Error(ev.message);
    }
    throw new Error('Tool returned no result');
  }

  async function createSessionFn() {
    const session = createSession({ ownerPrincipal: currentPrincipal() });
    await services.sessions.set(session.id, session);
    return { id: session.id };
  }

  async function sessionBusy(id) {
    return run.status(id).busy;
  }

  function makePromptFn(sid, traceId) {
    return (p, defaultValue) => new Promise((resolve, reject) => {
      const def = typeof p === 'string' ? defaultValue : p.default;
      pendingPrompts.set(sid, {
        resolve: answer => { pendingPrompts.delete(sid); resolve(answer || def || ''); },
        cancel:  ()     => { pendingPrompts.delete(sid); reject(new PromptCancelledError()); },
      });
      const ev = {
        type: 'prompt',
        traceId,
        question: typeof p === 'string' ? p : p.label,
        ...(def !== undefined ? { defaultValue: def } : {}),
        ...(typeof p === 'string' ? {} : { field: p }),
      };
      for (const inject of hub(sid)) inject(ev);
    });
  }

  // Fire-and-forget enqueue: the turn's output reaches the UI over the separate sessionEvents()
  // subscription, not here (mirror the server's submit handler). The first submit of a busy period
  // owns a tracker that drains its own view to idle, so statusEvents() emits the off transition even
  // when no sessionEvents consumer is attached.
  async function submit(sid, body) {
    const contentArr = typeof body.content === 'string'
      ? [{ type: 'text', text: body.content }]
      : [body.content];
    const traceId = crypto.randomUUID();

    const isTracker = !busyTrackers.has(sid);
    if (isTracker) busyTrackers.add(sid);
    const trackAc = new AbortController();
    try {
      const view = await run.open({
        sessionId:   sid,
        signal:      isTracker ? trackAc.signal : new AbortController().signal,
        content:     contentArr,
        provider:    body.provider,
        principal:   currentPrincipal(),
        prompt:      makePromptFn(sid, traceId),
        traceId,
        concatQueue: body.concatQueue ?? false,
      });
      updateBusy(sid);

      if (isTracker) {
        (async () => {
          try {
            for await (const ev of view.events) {
              updateBusy(sid);
              if (ev.type === 'idle' && !run.status(sid).busy) break;
            }
          } catch { /* stream torn down */ }
          finally { busyTrackers.delete(sid); trackAc.abort(); }
        })();
      }
      return { queued: view.queued, traceId: view.traceId };
    } catch (e) {
      if (isTracker) busyTrackers.delete(sid);
      throw e;
    }
  }

  async function submitExpertPanel(sid, rawBody) {
    const normalised = normaliseExpertPanelBody(rawBody);
    if (!normalised.ok) throw new Error(normalised.error);
    const body = normalised.body;
    const session = await services.sessions.get(sid);
    if (!session) throw new Error('Session not found');
    if (run.status(sid).busy || expertPanelBusySessions.has(sid)) throw new Error('Session is busy.');

    const tool = services.tools.resolve('expert_panel');
    if (!tool) throw new Error('Tool "expert_panel" not found (404)');

    const traceId = body.traceId ?? crypto.randomUUID();
    const synthesize = body.synthesize !== false;
    const selectedExperts = body.experts && body.experts.length ? body.experts : undefined;
    const input = {
      action: 'ask',
      question: body.question,
      mode: body.mode ?? 'parallel',
      synthesize,
      maxCitationsPerExpert: body.maxCitationsPerExpert ?? 5,
      ...(selectedExperts !== undefined ? { experts: selectedExperts } : {}),
    };
    const userContent = [{
      type: 'text',
      text: expertUserSummary(body.question, selectedExperts, input.mode, synthesize),
    }];
    const userMessage = createMessage({
      role: 'user',
      content: userContent,
      traceId,
      providerName: body.provider,
      metadata: { expertPanel: { mode: input.mode, synthesize, experts: selectedExperts ?? 'all' } },
    });

    expertPanelBusySessions.add(sid);
    const ac = new AbortController();
    try {
      let committed = await appendSessionMessages(sid, [userMessage], current => {
        if (current.title || current.messages.some(message => message.role === 'user')) return current;
        const title = titleFromQuestion(body.question);
        return title ? { ...current, title } : current;
      });
      if (!committed) throw new Error('Session not found');

      for (const inject of hub(sid)) inject({
        type: 'queued',
        content: userContent,
        queued: 0,
        concatQueue: false,
        traceId,
        rootTraceId: traceId,
      });

      let result;
      let errorMessage;
      const markers = [];
      let stdout = '';
      let stderr = '';

      try {
        for await (const ev of tool.executor.execute(input, makeToolCtx(ac, { session: committed, provider: body.provider }))) {
          if (ev.type === 'result') result = ev.value;
          else if (ev.type === 'stdout') stdout += ev.chunk;
          else if (ev.type === 'stderr') stderr += ev.chunk;
          else if (ev.type === 'marker') markers.push({ type: 'marker', creator: ev.creator, data: ev.data });
          else if (ev.type === 'error') errorMessage = ev.message;
        }
      } catch (e) {
        errorMessage = e instanceof Error ? e.message : String(e);
      }

      const assistantText = errorMessage
        ? `Expert panel failed: ${errorMessage}`
        : formatExpertPanelResult(result);
      const assistantMessage = createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: assistantText }],
        traceId,
        providerName: body.provider,
        metadata: { expertPanel: { result, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) } },
      });
      const messagesToAppend = [];
      if (markers.length) messagesToAppend.push(createMessage({ role: 'marker', content: markers, traceId }));
      messagesToAppend.push(assistantMessage);
      committed = await appendSessionMessages(sid, messagesToAppend);
      if (!committed) throw new Error('Session not found');

      if (markers.length) {
        for (const inject of hub(sid)) inject({ type: 'marker', content: markers, traceId });
      }
      for (const inject of hub(sid)) inject({ type: 'text-delta', delta: assistantText, traceId });
      const usage = expertPanelUsage(result);
      if (usage) {
        for (const inject of hub(sid)) inject({ type: 'usage', ...usage, traceId });
      }
      for (const inject of hub(sid)) inject({ type: 'done', session: committed, traceId });

      return {
        traceId,
        session: committed,
        ...(result !== undefined ? { result } : {}),
        ...(errorMessage !== undefined ? { isError: true, error: errorMessage } : { isError: false }),
      };
    } finally {
      expertPanelBusySessions.delete(sid);
      ac.abort();
    }
  }

  // One persistent per-session stream carrying ALL turn output, exactly like GET /events/sessions/:id:
  // the runner's events merged with the synthetic `prompt` events promptFn injects. `idle` is runner
  // bookkeeping (drives busy) and is not forwarded — app.js has no case for it.
  async function* sessionEvents(sid, signal) {
    const queue = [];
    let wake = null;
    let done = false;
    const pump = () => { if (wake) { const w = wake; wake = null; w(); } };
    const inject = ev => { queue.push(ev); pump(); };
    hub(sid).add(inject);

    let view;
    try {
      view = await run.open({ sessionId: sid, signal });
    } catch {
      hub(sid).delete(inject);
      return;
    }

    const feed = (async () => {
      try {
        for await (const ev of view.events) {
          if (ev.type === 'idle') { updateBusy(sid); continue; }
          queue.push(ev); pump();
          updateBusy(sid);
        }
      } catch { /* torn down */ }
      finally { done = true; pump(); }
    })();

    if (signal) signal.addEventListener('abort', () => { done = true; pump(); });

    try {
      while (!done || queue.length) {
        while (queue.length) yield queue.shift();
        if (done) break;
        await new Promise(r => { wake = r; });
      }
    } finally {
      const h = hubs.get(sid);
      if (h) { h.delete(inject); if (h.size === 0) hubs.delete(sid); }
      void feed;
    }
  }

  async function answerPrompt(sid, body) {
    const entry = pendingPrompts.get(sid);
    if (!entry) return;
    if (body.cancel) {
      // Give up: reject the prompt (the tool closes its call with an error result) and abandon the
      // turn without disturbing the queue (mirror server.ts).
      entry.cancel();
      run.cancelTurn(sid);
    } else {
      entry.resolve(body.answer ?? '');
    }
  }

  async function abort(sid) {
    // Release any pending prompt first so a turn parked on ctx.prompt() observes the abort rather
    // than hangs, then drop the queue + abort the running turn (mirror server.ts).
    const r = pendingPrompts.get(sid);
    if (r) { pendingPrompts.delete(sid); r.resolve(''); }
    run.abort(sid);
    updateBusy(sid);
  }

  async function* statusEvents(signal) {
    const queue = [];
    let wake = null;
    let closed = false;
    const pump = () => { if (wake) { const w = wake; wake = null; w(); } };
    const l = ev => { queue.push(ev); pump(); };
    statusListeners.add(l);
    // Send current busy state so the client is up-to-date immediately (mirror server.ts).
    for (const sid of [...busyState.keys()]) {
      if (run.status(sid).busy) queue.push({ sessionId: sid, busy: true });
      else updateBusy(sid);
    }
    if (signal) signal.addEventListener('abort', () => { closed = true; pump(); });
    try {
      while (!closed) {
        while (queue.length) yield queue.shift();
        if (closed) break;
        await new Promise(r => { wake = r; });
      }
    } finally { statusListeners.delete(l); }
  }

  async function* fileEvents(signal) {
    if (!services.files || !services.files.watch) return;
    for await (const event of services.files.watch(signal)) yield event;
  }

  async function* toolEvents(signal) {
    for await (const event of services.tools.watch(signal)) yield event;
  }

  async function* skillEvents(signal) {
    if (!services.SkillManager) return;
    for await (const event of services.SkillManager.watch(signal)) yield event;
  }

  async function* pluginEvents(signal) {
    for await (const event of watchPlugins(signal)) yield event;
  }

  // No HTTP file route in-process, so materialise the bytes into a blob: URL (mirror the dom
  // frontend's url_for_resource). Default-deny: only files marked `allowed` get a URL.
  async function openFile(namespace, name) {
    const handle = await services.files?.getByName(name, namespace);
    if (!handle || !handle.allowed) return;
    const chunks = [];
    let total = 0;
    for await (const chunk of handle.stream()) { chunks.push(chunk); total += chunk.byteLength; }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    window.open(URL.createObjectURL(new Blob([bytes], { type: handle.mimeType })), '_blank');
  }

  async function listWorkspaces() {
    return { active: 'default', workspaces: [{ id: 'default', name: 'Default', configPath: 'matbot.yaml', active: true }] };
  }
  async function createWorkspace(name) {
    throw new Error('Workspace creation is only available in the Node-hosted Cortex UI.');
  }
  async function renameWorkspace(id, name) {
    if (id === 'default') return { id, name, configPath: 'matbot.yaml', active: true };
    throw new Error(`Unknown workspace "${id}".`);
  }
  async function deleteWorkspace(id) {
    if (id === 'default') throw new Error('Cannot delete the active workspace.');
    throw new Error(`Unknown workspace "${id}".`);
  }
  async function checkWorkspaceDelete(id) {
    if (id === 'default') throw new Error('Cannot delete the active workspace.');
    throw new Error(`Unknown workspace "${id}".`);
  }
  async function switchWorkspace(id) {
    if (id === 'default') return { active: 'default', restarting: false };
    throw new Error(`Unknown workspace "${id}".`);
  }

  return {
    hostRuntime: 'browser',
    callTool, createSession: createSessionFn, sessionBusy, submit, submitExpertPanel,
    sessionEvents, answerPrompt, abort, statusEvents, fileEvents, toolEvents, pluginEvents, skillEvents, openFile,
    listWorkspaces, createWorkspace, renameWorkspace, checkWorkspaceDelete, deleteWorkspace, switchWorkspace,
  };
}

// ── Mount: inject the baked scaffold + app.js ───────────────────────────────────

function reviveScript(src) {
  const s = document.createElement('script');
  for (const a of src.attributes) s.setAttribute(a.name, a.value);
  s.textContent = src.textContent;
  return s;
}

// Append a (revived) script and resolve when it's ready. External scripts resolve on load/error (so
// an offline file:// CDN miss degrades rather than hangs); inline scripts execute synchronously.
function runScript(src) {
  return new Promise(resolve => {
    const s = reviveScript(src);
    if (s.src) { s.onload = () => resolve(); s.onerror = () => resolve(); document.head.appendChild(s); }
    else { document.head.appendChild(s); resolve(); }
  });
}

async function mountUI() {
  const assets = (globalThis.__MB__ && globalThis.__MB__.assets) || {};
  if (!assets.scaffold || !assets.appJs) {
    console.error('[frontend-web] no baked UI assets (scaffold/appJs) — was the bundle assembled with the assets config?');
    return;
  }
  const doc = new DOMParser().parseFromString(assets.scaffold, 'text/html');

  // 1. Head styles/links (synchronous), keeping the scaffold's look.
  for (const node of doc.head.querySelectorAll('style, link')) document.head.appendChild(node.cloneNode(true));

  // 2. Body markup. Drop the Node-only <script src> tags (they'd 404 in the bundle, and innerHTML
  //    scripts don't execute anyway); app.js is injected as a live script below.
  for (const s of doc.body.querySelectorAll('script[src="/app.js"], script[src="/http-transport.js"]')) s.remove();
  document.getElementById('mb-loading')?.remove();
  document.body.innerHTML = doc.body.innerHTML;

  // 3. Head scripts: marked / tiny-mde from a CDN (http(s) only; offline file:// degrades), plus the
  //    inline font-size restore. Awaited so the libs are ready before app.js' init() runs.
  for (const s of doc.head.querySelectorAll('script')) await runScript(s);

  // 4. app.js last — DOM, transport global, and libs all in place. It runs top-level and init()s.
  const appScript = document.createElement('script');
  appScript.textContent = assets.appJs;
  document.body.appendChild(appScript);
}

export const plugin = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: { description: 'Browser web frontend (in-process): the served UI, mounted without a server.' },
  async setup(services) {
    services.registerFrontend({ name: 'frontend-web' });
    window.matbotTransport = makeInProcessTransport(services);
    await mountUI();
  },
};
