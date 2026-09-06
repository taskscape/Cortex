import type {
  MatbotMachine, Session, PipelineEvent, MessageContent, FormField, PromptFn, Principal,
} from '@matatbread/matbot-plugin-api';
import { createSession, currentPrincipal, PromptCancelledError } from '@matatbread/matbot-core';

const CSS = `
.mb-app { display:flex; flex-direction:column; height:100vh; font:14px/1.5 Inter, sans-serif; color:#1a1a1a; background:#fafafa; }
.mb-head { display:flex; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid #e2e2e2; background:#fff; }
.mb-head .mb-title { font-weight:600; margin-right:auto; }
.mb-head select, .mb-head button { font:inherit; padding:4px 8px; border:1px solid #cfcfcf; border-radius:6px; background:#fff; }
.mb-head option.mb-archived { color:#9a9a9a; }
.mb-msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; }
.mb-row { display:flex; }
.mb-row.user { justify-content:flex-end; }
.mb-bubble { max-width:72ch; padding:8px 12px; border-radius:12px; white-space:pre-wrap; word-break:break-word; }
.mb-row.user  .mb-bubble { background:#2563eb; color:#fff; }
.mb-row.assistant .mb-bubble { background:#fff; border:1px solid #e2e2e2; }
.mb-bubble.mb-md { white-space:normal; }
.mb-bubble.mb-md > :first-child { margin-top:0; }
.mb-bubble.mb-md > :last-child { margin-bottom:0; }
.mb-bubble.mb-md pre { background:#0f172a; color:#e2e8f0; padding:8px 10px; border-radius:8px; overflow-x:auto; }
.mb-bubble.mb-md code { font-family:Inter, sans-serif; font-size:.92em; }
.mb-bubble.mb-md :not(pre) > code { background:rgba(0,0,0,.06); padding:1px 4px; border-radius:4px; }
.mb-row.user .mb-bubble.mb-md :not(pre) > code { background:rgba(255,255,255,.2); }
.mb-bubble.mb-md a { color:inherit; }
.mb-tool { font-family:Inter, sans-serif; font-size:12px; background:#0f172a; color:#e2e8f0; border-radius:8px; padding:8px 10px; max-width:72ch; white-space:pre-wrap; }
.mb-tool .mb-tool-name { color:#7dd3fc; }
.mb-err { color:#b91c1c; }
.mb-think { color:#888; font-style:italic; font-size:12px; }
.mb-foot { display:flex; gap:8px; padding:10px 12px; border-top:1px solid #e2e2e2; background:#fff; }
.mb-foot textarea { flex:1; resize:none; font:inherit; padding:8px; border:1px solid #cfcfcf; border-radius:8px; min-height:42px; }
.mb-foot button { font:inherit; padding:0 16px; border:none; border-radius:8px; background:#2563eb; color:#fff; cursor:pointer; }
.mb-foot button.mb-stop { background:#b91c1c; }
.mb-foot button:disabled { opacity:.5; cursor:default; }
.mb-prompt { border:1px solid #f59e0b; background:#fffbeb; border-radius:12px; padding:12px; max-width:72ch; display:flex; flex-direction:column; gap:8px; }
.mb-prompt .mb-q { font-weight:600; }
.mb-prompt .mb-opts { display:flex; flex-wrap:wrap; gap:6px; }
.mb-prompt button, .mb-prompt input { font:inherit; padding:6px 10px; border:1px solid #cfcfcf; border-radius:6px; background:#fff; cursor:pointer; }
.mb-prompt input { cursor:text; }
`;

/**
 * Creates a DOM element with an optional class and text content.
 *
 * @typeParam K - Tag name key into `HTMLElementTagNameMap`, so the returned element keeps its
 *                concrete element type (e.g. `HTMLButtonElement` for `'button'`).
 * @param tag - HTML tag name to create.
 * @param cls - Class name to assign; `undefined` leaves `className` untouched.
 * @param text - Text content to set via `textContent`; `undefined` leaves it empty.
 * @returns The newly created, not-yet-attached element.
 * @throws Never.
 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls)  node.className   = cls;
  if (text) node.textContent = text;
  return node;
}

/**
 * Concatenates the text blocks of a message content list into one string.
 *
 * @param content - Message content blocks; non-text blocks (tool calls, markers, …) are skipped.
 * @returns The text blocks joined in order, without separators.
 * @throws Never.
 */
function textOf(content: MessageContent[]): string {
  return content.filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
                .map(c => c.text).join('');
}

/**
 * A whole matbot chat UI in the DOM. Owns no I/O of its own beyond the runner: it submits turns
 * through `services.run` and renders the `PipelineEvent` stream, exactly as a remote frontend would
 * over SSE — only here the runner is in the same realm, so there is no wire.
 */
export class ChatUI {
  private readonly services: MatbotMachine;
  private readonly root: HTMLElement;
  private msgs!:     HTMLElement;
  private input!:    HTMLTextAreaElement;
  private sendBtn!:  HTMLButtonElement;
  private stopBtn!:  HTMLButtonElement;
  private provider!: HTMLSelectElement;
  private sessionSel!: HTMLSelectElement;

  private sessionId = '';
  private busy      = false;
  private currentAbort: AbortController | undefined;
  private liveAssistant: HTMLElement | undefined;
  private liveText = '';
  private liveTools = new Map<string, HTMLElement>();
  private session: Session | undefined;
  // Markdown renderer, loaded from a CDN only when served over http(s). On file:// it stays
  // undefined and messages render as plain text — keeping the bundle self-contained and offline.
  private renderMd: ((src: string) => string) | undefined;

  /**
   * Creates the UI without touching the DOM; call {@link ChatUI.mount} to build and attach it.
   *
   * @param services - The matbot machine (sessions store, runner, providers).
   * @param root - DOM element the UI mounts into.
   * @throws Never.
   */
  constructor(services: MatbotMachine, root: HTMLElement) {
    this.services = services;
    this.root = root;
  }

  /**
   * Builds the UI, wires event handlers, and loads the most recent session
   * (or creates one).
   * @returns Resolves once the UI is mounted and a session is selected.
   * @throws Error - When no session exists yet and no sessions store is available to create one
   *                 (via {@link ChatUI.newSession}).
   */
  async mount(): Promise<void> {
    document.getElementById('mb-loading')?.remove();
    const style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const app  = el('div', 'mb-app');
    const head = el('div', 'mb-head');
    head.appendChild(el('span', 'mb-title', 'matbot · web'));

    this.provider = el('select');
    this.populateProviders();
    this.prevProvider = this.provider.value;
    this.provider.addEventListener('change', () => void this.onProviderChange());
    head.appendChild(this.provider);

    this.sessionSel = el('select');
    this.sessionSel.addEventListener('change', () => void this.selectSession(this.sessionSel.value));
    head.appendChild(this.sessionSel);

    const newBtn = el('button', undefined, '+ New');
    newBtn.addEventListener('click', () => void this.newSession());
    head.appendChild(newBtn);

    this.msgs = el('div', 'mb-msgs');

    const foot = el('div', 'mb-foot');
    this.input = el('textarea');
    this.input.placeholder = 'Message matbot…  (Shift+Enter to send, Enter for newline)';
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); void this.send(); }
    });
    this.sendBtn = el('button', 'mb-send', 'Send');
    this.sendBtn.addEventListener('click', () => void this.send());
    this.stopBtn = el('button', 'mb-stop', 'Stop');
    this.stopBtn.hidden = true;
    this.stopBtn.addEventListener('click', () => this.services.run?.abort(this.sessionId));
    foot.append(this.input, this.sendBtn, this.stopBtn);

    app.append(head, this.msgs, foot);
    this.root.appendChild(app);

    void this.loadMarkdown();

    await this.refreshSessionList();
    const first = this.sessionSel.options[0]?.value;
    if (first) await this.selectSession(first);
    else       await this.newSession();
  }

  /**
   * Returns the ambient principal in force for the current async extent.
   *
   * Used to attribute sessions and turns created by this UI to the browser's boot identity.
   *
   * @returns The current {@link Principal}.
   * @throws Error - When called outside any principal scope (the UI is normally mounted inside one).
   */
  private principal(): Principal {
    return currentPrincipal();
  }

  // Markdown is a served-mode nicety, not a bundle dependency: only when running over http(s) do we
  // pull `marked` from a CDN. On file:// (the self-contained, offline case) we never touch the
  // network and messages stay plain text. The specifier is built at runtime so the bundler/loader
  // doesn't try to resolve it. Note: rendered markdown is injected as HTML — acceptable for a
  // single-user local demonstrator; a hardened deployment would sanitise it.
  /**
   * Lazily loads the `marked` markdown renderer from a CDN, over http(s) only.
   *
   * Fire-and-forget from {@link ChatUI.mount}: on `file://` it returns immediately so the bundle
   * stays self-contained and offline, and on network failure it silently keeps plain-text rendering.
   * On success the current session history is re-rendered as markdown (unless a turn is streaming).
   * Loaded markup is injected as HTML without sanitising — acceptable for a single-user local
   * demonstrator, not a hardened deployment.
   *
   * @returns Resolves once the attempt finishes (successfully or not).
   * @throws Never - All failures are caught internally.
   */
  private async loadMarkdown(): Promise<void> {
    const proto = globalThis.location?.protocol;
    if (proto !== 'http:' && proto !== 'https:') return;
    try {
      const url = 'https://esm.sh/marked@14';
      const mod = await import(/* @vite-ignore */ url) as { marked?: unknown };
      const fn  = mod.marked;
      if (typeof fn === 'function') {
        this.renderMd = (src: string) => String((fn as (s: string) => unknown)(src));
        if (!this.busy) this.renderSession(this.session);   // re-render history now that markdown is available
      }
    } catch { /* offline or blocked — stay plain text */ }
  }

  // ── providers ──────────────────────────────────────────────────────────────
  private prevProvider = '';

  /**
   * Rebuilds the provider `<select>` from the machine's configured providers.
   *
   * Always appends the synthetic `__add__` option that triggers the provider-setup bridge (see
   * {@link ChatUI.onProviderChange}).
   *
   * @param select - Provider name to preselect after rebuilding; `undefined` keeps the default
   *                 (first) selection.
   * @returns Nothing.
   * @throws Never.
   */
  private populateProviders(select?: string): void {
    this.provider.replaceChildren();
    for (const name of this.services.providers.keys()) {
      const o = el('option'); o.value = name; o.textContent = name; this.provider.appendChild(o);
    }
    const add = el('option', undefined, '＋ Add provider…'); add.value = '__add__';
    this.provider.appendChild(add);
    if (select) this.provider.value = select;
  }

  // The bootstrap exposes provider setup via a global bridge (it owns the providers map and the
  // wizard). Selecting "Add provider…" runs it, then we refresh and select the newcomer.
  /**
   * Handles a provider `<select>` change: records the choice or runs the add-provider bridge.
   *
   * Selecting the synthetic `__add__` entry snaps the select back to the previous provider and
   * delegates to the bootstrap's `__mbProviders.add()` wizard; on success the list is rebuilt with
   * the newcomer selected. A missing bridge or a cancelled wizard is a no-op.
   *
   * @returns Resolves once the change (if any) has been applied.
   * @throws Never - Wizard failures are caught and ignored.
   */
  private async onProviderChange(): Promise<void> {
    if (this.provider.value !== '__add__') { this.prevProvider = this.provider.value; return; }
    this.provider.value = this.prevProvider;
    const api = (globalThis as unknown as { __mbProviders?: { add(): Promise<string> } }).__mbProviders;
    if (api?.add === undefined) return;
    try {
      const name = await api.add();
      this.populateProviders(name);
      this.prevProvider = name;
    } catch { /* cancelled */ }
  }

  /**
   * Rebuilds the session `<select>` from the sessions store.
   *
   * Queries the 50 most recently updated sessions; unarchived ones list first (most recent first)
   * and archived ones sink into a labelled `Archived` `<optgroup>`. Does nothing when no sessions
   * store is available.
   *
   * @returns Resolves once the select has been rebuilt.
   * @throws Error - If the underlying store query fails (propagated to the caller).
   */
  private async refreshSessionList(): Promise<void> {
    const store = this.services.sessions;
    if (store === undefined) return;
    const { items } = await store.query({ sort: [{ field: 'updatedAt', dir: 'desc' }], limit: 50 });
    this.sessionSel.replaceChildren();

    /**
     * Builds a select option for a session, labelling untitled ones with an id prefix.
     *
     * @param doc - Session document to render.
     * @returns The option element (not yet attached).
     * @throws Never.
     */
    const makeOption = (doc: Session): HTMLOptionElement => {
      const o = el('option');
      o.value = doc.id;
      o.textContent = doc.title?.trim() || `(untitled ${doc.id.slice(0, 8)})`;
      return o;
    };

    // Unarchived (active/pinned) first, most-recent first.
    for (const doc of items) if (doc.status !== 'archived') this.sessionSel.appendChild(makeOption(doc));

    // Archived sink to the bottom under a labelled group. Native <select> popups ignore `color` on
    // <option> (esp. on macOS), so the grey class alone is invisible there; the <optgroup> label is
    // always rendered by the OS, which is what actually separates and de-emphasises them.
    const archived = items.filter(doc => doc.status === 'archived');
    if (archived.length > 0) {
      const group = el('optgroup');
      group.label = 'Archived';
      for (const doc of archived) {
        const o = makeOption(doc);
        o.classList.add('mb-archived');
        group.appendChild(o);
      }
      this.sessionSel.appendChild(group);
    }
  }

  /**
   * Creates a session owned by the current principal, persists it, and selects it.
   *
   * @returns Resolves once the session is persisted, the list refreshed, and the session selected.
   * @throws Error - When no sessions store is available, or when persisting fails.
   */
  private async newSession(): Promise<void> {
    const store = this.services.sessions;
    if (store === undefined) throw new Error('No sessions store available.');
    const session = createSession({ ownerPrincipal: this.principal() });
    await store.set(session.id, session);
    await this.refreshSessionList();
    await this.selectSession(session.id);
  }

  /**
   * Switches the active session and renders its messages.
   *
   * A missing or deleted session renders as an empty transcript rather than failing.
   *
   * @param id - Session id to select; also written back into the session `<select>`.
   * @returns Resolves once the session (if any) has been fetched and rendered.
   * @throws Error - If the store read fails.
   */
  private async selectSession(id: string): Promise<void> {
    this.sessionId = id;
    this.sessionSel.value = id;
    const session = await this.services.sessions?.get(id);
    this.renderSession(session ?? undefined);
  }

  /**
   * Replaces the transcript with the stored messages of a session.
   *
   * Skips marker and system messages; text blocks become bubbles (`user` role vs anything else as
   * `assistant`), tool calls and results become tool blocks. Resets the live-streaming state and
   * scrolls to the bottom. `undefined` clears the transcript.
   *
   * @param session - Session to render, or `undefined` for an empty transcript.
   * @returns Nothing.
   * @throws Never.
   */
  private renderSession(session: Session | undefined): void {
    this.session = session;
    this.msgs.replaceChildren();
    this.liveAssistant = undefined;
    this.liveText = '';
    this.liveTools.clear();
    if (session === undefined) return;
    for (const m of session.messages) {
      if (m.role === 'marker' || m.role === 'system') continue;
      for (const block of m.content) {
        if (block.type === 'text' && block.text.trim()) {
          this.bubble(m.role === 'user' ? 'user' : 'assistant', block.text);
        } else if (block.type === 'tool-call') {
          this.toolBlock(block.id, block.name, block.input);
        } else if (block.type === 'tool-result') {
          this.toolResult(block.id, block.result, block.isError ?? false);
        }
      }
    }
    this.scroll();
  }

  // ── rendering primitives ──────────────────────────────────────────────────
  /**
   * Appends an empty chat bubble row for a role.
   *
   * @param role - Side to align the bubble on: `user` right, `assistant` left.
   * @returns The bubble element (inside its row), ready to be filled via {@link ChatUI.setContent}.
   * @throws Never.
   */
  private addBubble(role: 'user' | 'assistant'): HTMLElement {
    const row = el('div', `mb-row ${role}`);
    const b   = el('div', 'mb-bubble');
    row.appendChild(b);
    this.msgs.appendChild(row);
    return b;
  }

  // Markdown when available (innerHTML + .mb-md), else plain text (textContent, kept readable by the
  // bubble's white-space:pre-wrap). The streaming assistant bubble stays plain until finalised.
  /**
   * Fills a bubble with text, as markdown when the renderer is available.
   *
   * Uses `innerHTML` with the markdown renderer when loaded (adding the `mb-md` class), falling back
   * to plain `textContent` if rendering throws or the renderer was never loaded — the bubble's
   * `white-space: pre-wrap` keeps plain text readable.
   *
   * @param el - Bubble element to fill.
   * @param text - Raw text (or markdown source) to display.
   * @returns Nothing.
   * @throws Never.
   */
  private setContent(el: HTMLElement, text: string): void {
    if (this.renderMd !== undefined) {
      try { el.innerHTML = this.renderMd(text); el.classList.add('mb-md'); return; }
      catch { /* fall back to plain */ }
    }
    el.classList.remove('mb-md');
    el.textContent = text;
  }

  /**
   * Appends a chat bubble already filled with text.
   *
   * @param role - Side to align the bubble on: `user` right, `assistant` left.
   * @param text - Text (or markdown source) to display.
   * @returns The filled bubble element.
   * @throws Never.
   */
  private bubble(role: 'user' | 'assistant', text: string): HTMLElement {
    const b = this.addBubble(role);
    this.setContent(b, text);
    return b;
  }

  /**
   * Appends a tool-call block and registers it for later result appends.
   *
   * The block shows the tool name and a truncated JSON preview of the input; the element is kept in
   * {@link ChatUI.liveTools} keyed by call id so {@link ChatUI.toolResult} can append the outcome.
   *
   * @param callId - Runner's tool-call id used to correlate the later result.
   * @param name - Tool name to display.
   * @param input - Tool input; rendered via {@link safeJson}.
   * @returns Nothing.
   * @throws Never.
   */
  private toolBlock(callId: string, name: string, input: unknown): void {
    const box = el('div', 'mb-tool');
    const head = el('span', 'mb-tool-name', `⚙ ${name}`);
    box.append(head, document.createTextNode(` ${safeJson(input)}\n`));
    this.msgs.appendChild(box);
    this.liveTools.set(callId, box);
  }

  /**
   * Appends a tool result to its call's block, or as a standalone block if the call is unknown.
   *
   * @param callId - Tool-call id the result belongs to.
   * @param result - Tool result value; rendered via {@link safeJson}.
   * @param isError - `true` prefixes the result with an `[error]` marker.
   * @returns Nothing.
   * @throws Never.
   */
  private toolResult(callId: string, result: unknown, isError: boolean): void {
    const box = this.liveTools.get(callId);
    const text = `→ ${isError ? '[error] ' : ''}${safeJson(result)}`;
    if (box) box.appendChild(document.createTextNode(text + '\n'));
    else { const b = el('div', 'mb-tool', text); this.msgs.appendChild(b); }
  }

  /**
   * Scrolls the transcript to the bottom.
   *
   * @returns Nothing.
   * @throws Never.
   */
  private scroll(): void { this.msgs.scrollTop = this.msgs.scrollHeight; }

  /**
   * Toggles the UI between idle and turn-in-progress states.
   *
   * Disables the composer and send button while busy and shows the stop button instead.
   *
   * @param busy - `true` marks a turn as in progress.
   * @returns Nothing.
   * @throws Never.
   */
  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.input.disabled   = busy;
    this.stopBtn.hidden   = !busy;
  }

  // ── submit + event loop ────────────────────────────────────────────────────
  /**
   * Submits the composer text as a turn and renders the resulting event stream.
   *
   * No-op when already busy or the text is empty. Clears the composer, bubbles the user message,
   * then opens a runner view and renders every event belonging to this turn's trace until a terminal
   * event (`done`, `aborted`, `error`, or `cancelled`). Errors — including a missing runner — are
   * surfaced as an assistant error bubble, never thrown. The `finally` block finalises the live
   * bubble, clears the busy state, and refreshes the session list.
   *
   * @returns Resolves once the turn has ended and the UI is back to idle.
   * @throws Never - All failures are rendered as error bubbles.
   */
  private async send(): Promise<void> {
    if (this.busy) return;
    const text = this.input.value.trim();
    if (!text) return;
    const run = this.services.run;
    if (run === undefined) { this.bubble('assistant', '[no session runner available]'); return; }

    this.input.value = '';
    this.bubble('user', text);
    this.scroll();
    this.setBusy(true);
    this.liveAssistant = undefined;
    this.liveText = '';

    const ac = new AbortController();
    this.currentAbort = ac;
    try {
      const view = await run.open({
        sessionId: this.sessionId,
        signal:    ac.signal,
        content:   [{ type: 'text', text }],
        provider:  this.provider.value,
        principal: this.principal(),
        prompt:    this.promptFn,
      });
      for await (const ev of view.events) {
        if (!('traceId' in ev)) continue;          // session-level events (e.g. 'idle') — not this turn
        if (ev.traceId !== view.traceId) continue;
        this.render(ev);
        if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error' || ev.type === 'cancelled') break;
      }
    } catch (e) {
      this.bubble('assistant', `[error] ${String(e)}`).classList.add('mb-err');
    } finally {
      this.finalizeLive();
      this.currentAbort = undefined;
      this.setBusy(false);
      await this.refreshSessionList();
      this.sessionSel.value = this.sessionId;
    }
  }

  // Re-render the streamed assistant text as markdown once the turn (or tool break) ends.
  /**
   * Re-renders the streamed assistant text as markdown and clears the live-streaming state.
   *
   * The streaming assistant bubble stays plain text while streaming; this finalises it (when there
   * is accumulated text) once the turn or a tool break ends.
   *
   * @returns Nothing.
   * @throws Never.
   */
  private finalizeLive(): void {
    if (this.liveAssistant !== undefined && this.liveText) this.setContent(this.liveAssistant, this.liveText);
    this.liveAssistant = undefined;
    this.liveText = '';
  }

  /**
   * Renders a single pipeline event into the transcript.
   *
   * Text deltas accumulate into a live plain-text assistant bubble; tool events append to the
   * matching tool block; terminal events (`error`, `aborted`) render an error bubble. Thinking
   * events and unknown event types are ignored. Always scrolls to the bottom.
   *
   * @param ev - Event from the runner's stream (already filtered to this turn's trace).
   * @returns Nothing.
   * @throws Never.
   */
  private render(ev: PipelineEvent): void {
    switch (ev.type) {
      case 'text-delta':
        if (this.liveAssistant === undefined) { this.liveAssistant = this.addBubble('assistant'); this.liveText = ''; }
        this.liveText += ev.delta;
        this.liveAssistant.textContent = this.liveText;   // plain while streaming; markdown on finalise
        break;
      case 'thinking': break;
      case 'tool:start':
        this.finalizeLive();
        this.toolBlock(ev.callId, ev.name, ev.input);
        break;
      case 'tool:stdout':
      case 'tool:stderr': {
        const box = this.liveTools.get(ev.callId);
        if (box) box.appendChild(document.createTextNode(ev.chunk));
        break;
      }
      case 'tool:end':
        this.toolResult(ev.callId, ev.result, ev.isError);
        break;
      case 'error':
        this.bubble('assistant', `[error] ${ev.error}`).classList.add('mb-err');
        break;
      case 'aborted':
        this.bubble('assistant', `[aborted: ${ev.reason}]`).classList.add('mb-err');
        break;
      default: break;
    }
    this.scroll();
  }

  // ── interactive prompt (ask_user, plugin confirm, store-key) ────────────────
  /**
   * Prompt handler adapting the runner's {@link PromptFn} contract to the DOM prompt dialog.
   *
   * Normalises a bare question string into a text {@link FormField} (applying the default when
   * given) and delegates to {@link ChatUI.renderPrompt}; fields pass through unchanged.
   */
  private readonly promptFn: PromptFn = ((arg: string | FormField, def?: string): Promise<string> => {
    const field: FormField = typeof arg === 'string'
      ? { name: 'q', label: arg, type: 'text', ...(def !== undefined ? { default: def } : {}) }
      : arg;
    return this.renderPrompt(field);
  }) as PromptFn;

  /**
   * Renders an interactive prompt box and waits for the user's answer.
   *
   * Supports `confirm` (Yes/No buttons), `select` (option buttons with an optional free-text
   * "Other"), and text/password input, plus a Cancel button unless the field is marked
   * non-cancelable. Answering removes the box and resolves; cancelling removes it and rejects.
   *
   * @param field - Field describing the question, input type, options, and default.
   * @returns Resolves with the chosen or entered answer (an empty string counts as answered).
   * @throws {@link PromptCancelledError} - When the user cancels the prompt.
   */
  private renderPrompt(field: FormField): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const box = el('div', 'mb-prompt');
      box.appendChild(el('div', 'mb-q', field.label));
      const cancelable = field.cancelable !== false;

      const done = (value: string): void => { box.remove(); resolve(value); };
      const cancel = (): void => { box.remove(); reject(new PromptCancelledError()); };

      if (field.type === 'confirm') {
        const opts = el('div', 'mb-opts');
        const yes = el('button', undefined, 'Yes'); yes.addEventListener('click', () => done('yes'));
        const no  = el('button', undefined, 'No');  no.addEventListener('click', () => done('no'));
        opts.append(yes, no);
        box.appendChild(opts);
      } else if (field.type === 'select') {
        const opts = el('div', 'mb-opts');
        for (const option of field.options ?? []) {
          const b = el('button', undefined, option);
          b.addEventListener('click', () => done(option));
          opts.appendChild(b);
        }
        box.appendChild(opts);
        if (field.allowOther) box.appendChild(this.freeText(done, 'Other…'));
      } else {
        box.appendChild(this.freeText(done, field.type === 'password' ? '••••••' : '', field.type === 'password', field.default));
      }

      if (cancelable) {
        const c = el('button', undefined, 'Cancel');
        c.addEventListener('click', cancel);
        box.appendChild(c);
      }
      this.msgs.appendChild(box);
      this.scroll();
    });
  }

  /**
   * Builds a free-text input row (input plus OK button) for a prompt; Enter also submits.
   *
   * @param done - Callback invoked with the entered value on submission.
   * @param placeholder - Input placeholder text.
   * @param password - `true` renders a masked password input.
   * @param def - Initial value; `undefined` starts empty.
   * @returns The wrapper element containing input and submit button (not yet attached).
   * @throws Never.
   */
  private freeText(done: (v: string) => void, placeholder: string, password = false, def?: string): HTMLElement {
    const wrap  = el('div', 'mb-opts');
    const input = el('input');
    input.type = password ? 'password' : 'text';
    input.placeholder = placeholder;
    if (def !== undefined) input.value = def;
    const submit = el('button', undefined, 'OK');
    const go = (): void => done(input.value);
    submit.addEventListener('click', go);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    wrap.append(input, submit);
    return wrap;
  }
}

/**
 * Renders a value as JSON for display, truncating long output.
 *
 * Bare strings are shown without quotes; values that fail to serialise fall back to `String(v)`.
 *
 * @param v - Value to render.
 * @returns The JSON text, capped at 600 characters with a trailing ellipsis.
 * @throws Never.
 */
function safeJson(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 600 ? s.slice(0, 600) + '…' : s;
  } catch { return String(v); }
}
