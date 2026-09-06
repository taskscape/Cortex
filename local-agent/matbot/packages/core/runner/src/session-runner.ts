import type {
  Session, Message, MessageContent, Principal, PromptFn, PipelineEvent,
  Store, ToolRegistry, SystemContextRegistry, Vault, FileStore, Tool,
  ProviderAdapter, ProviderConfig, SessionRunner, SessionView, OpenOpts, SubmitOpenOpts,
  ObservabilitySink,
} from './types.js';
import type { MatbotPlugin } from './plugin.js';
import type { HookRegistry } from './hooks.js';
import { appendMessage, createMessage } from './session.js';
import { contextSwitch } from '@matatbread/matbot-plugin-api';
import { runSession } from './runner.js';

/** Dependencies a host supplies to build the session runner: persistence, provider resolution, registries. */
export interface SessionRunnerDeps {
  permissions?:()=>import('./runner.js').RunSessionOpts['permissions'];
  /** The session store (system of record). */
  store:           Store<Session>;
  /**
   * Resolve a named provider profile to its adapter and config.
   *
   * @param name - Provider key from the submission.
   * @returns The adapter plus config, or `null` when unknown.
   */
  resolveProvider: (name: string) => Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null>;
  /** Live tool registry consulted per call. */
  tools?:          ToolRegistry;
  /** Pipeline hook registry (screen/contribute/toolcall/toolresult/followup). */
  hooks?:          HookRegistry;
  /** System-prompt contributor registry, built once per turn. */
  systemContext?:  SystemContextRegistry;
  /** Vault forwarded into tool contexts. */
  vault?:          Vault;
  /** File store forwarded into tool contexts. */
  files?:          FileStore;
  /** Default working directory forwarded into tool contexts. */
  workdir?:        string;
  /** Config file path forwarded into tool contexts. */
  configPath?:     string;
  /** Hot-load a plugin (delegated into tool contexts). */
  loadPlugin:      (specifier: string, prompt?: PromptFn) => Promise<MatbotPlugin>;
  /** Hot-unload a plugin (delegated into tool contexts). */
  unloadPlugin:    (specifier: string) => Promise<boolean>;
  /** Late-bound so a plugin loaded after runner construction can install the sink. */
  observability?:  () => ObservabilitySink | undefined;
}

/**
 * One pending submission in a session's FIFO queue: the user content to run, its trace lineage,
 * provider and principal, and pump controls (concat merging, resubmit depth, retract-redo).
 */
interface QueuedItem {
  traceId:     string;
  // The originating human turn's traceId, carried down a resubmission chain (a human submit is its
  // own root). Lets a per-turn frontend (e.g. telegram) adopt the followups *its* turn spawned and
  // ignore unrelated turns — lineage the bare per-turn traceId can't express.
  rootTraceId: string;
  content:     MessageContent[];
  // Frontend-supplied context for this submission only. It follows screen-hook context at provider
  // time and is never included in the persisted user message or queued/replay UI events.
  ephemeral?:   MessageContent[];
  provider:    string;
  principal:   Principal;
  concatQueue: boolean;
  // 0 for an external submission; a `react` resubmission carries its parent's depth + 1. The reactor
  // budgets against it, and pump hard-caps it (MAX_RESUBMIT_DEPTH) so a misbehaving reactor can't loop.
  resubmitDepth: number;
  // Present ⇒ this item RE-RUNS an already-committed user turn (an agent-phase retract-redo) rather
  // than introducing a new user message: the pump skips the persist-at-turn-start append (the user
  // message already exists) and hands `ephemeral` (the trigger tool's output) to runSession, which
  // tail-folds it for this run only. `content` is empty for such an item — there is no new bubble.
  redo?: { ephemeral: MessageContent[] };
  prompt?:     PromptFn;
}

const MAX_RESUBMIT_DEPTH = 8;

// Marker creator for a retract-and-rerun: its `data.retracted` carries the popped (superseded) turn
// messages so a frontend can render them struck-through and a post-mortem can audit them. Core-owned
// because the pop is a pump operation, not a plugin's.
const RETRACTION_CREATOR = 'matbot-retraction';

/** Per-session mutable runner state: the pending queue, turn activity, subscribers, and replay. */
interface SessionState {
  // The queue is deliberately a plain array, drained FIFO. concatQueue is per-submission: a non-concat
  // submission is its own turn — faithful, and correct when one submission's tools/state are a
  // precondition for the next (e.g. "add plugin X" then "use X": tools are rebuilt per turn, so X is
  // only visible to a *later* turn). A run of consecutive concat submissions merges into one turn —
  // cheaper, and the common "let me add more context now" case — without collapsing the queued/robo
  // submissions interleaved among them (see the batch-building loop in pump). Concat and queued mix freely.
  queue:       QueuedItem[];
  running:     boolean;
  ac:          AbortController | undefined;
  subscribers: Set<Sink>;
  // Events of the *current* turn, replayed to a subscriber that joins mid-turn. Cleared at each
  // turn boundary — committed history comes from the store, not from here.
  replay:      PipelineEvent[];
}

/** One live event subscriber: a push channel with an explicit close and its async event stream. */
interface Sink {
  push(ev: PipelineEvent): void;
  close(): void;
  iterable: AsyncIterable<PipelineEvent>;
}

/**
 * A single-consumer push channel surfaced as an AsyncIterable. `dispose` runs when the consumer
 * stops (break/return) or the channel closes, so an abandoned subscriber unregisters itself.
 *
 * @param dispose - Unregisters the subscriber; invoked when the consumer stops iterating and on
 *                  close.
 * @returns A sink with `push` (hand to a waiting consumer or buffer), `close` (end the stream),
 *           and `iterable` (FIFO event iteration; early return disposes).
 * @throws Never.
 */
function createSink(dispose: () => void): Sink {
  const buffer: PipelineEvent[] = [];
  let waiting: ((r: IteratorResult<PipelineEvent>) => void) | null = null;
  let closed = false;

  /**
   * Mark the channel closed and complete a waiting consumer with `done`; later pushes are
   * dropped. Idempotent.
   *
   * @returns Nothing.
   * @throws Never.
   */
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (waiting) { const w = waiting; waiting = null; w({ value: undefined as never, done: true }); }
  };

  return {
    push(ev) {
      if (closed) return;
      if (waiting) { const w = waiting; waiting = null; w({ value: ev, done: false }); }
      else buffer.push(ev);
    },
    close: finish,
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<PipelineEvent> {
        return {
          next() {
            const head = buffer.shift();
            if (head !== undefined) return Promise.resolve({ value: head, done: false });
            if (closed)            return Promise.resolve({ value: undefined as never, done: true });
            return new Promise(res => { waiting = res; });
          },
          return() {
            finish();
            dispose();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    },
  };
}

/**
 * Build the per-session turn serialiser: submissions queue FIFO, each turn runs under the
 * submitter's principal via a context switch, and `followup` hooks fire post-commit.
 *
 * @param deps - Persistence, provider resolution, and registry wiring.
 * @returns A {@link SessionRunner} with open/abort/cancelTurn/status.
 */
export function createSessionRunner(deps: SessionRunnerDeps): SessionRunner {
  const states = new Map<string, SessionState>();

  /**
   * Return the session's state, creating (and registering) an empty one on first touch.
   *
   * @param id - Session id.
   * @returns The existing or newly created state.
   * @throws Never.
   */
  const stateFor = (id: string): SessionState => {
    let s = states.get(id);
    if (s === undefined) {
      s = { queue: [], running: false, ac: undefined, subscribers: new Set(), replay: [] };
      states.set(id, s);
    }
    return s;
  };

  /**
   * Drop the session's state when it is fully idle — no running turn, empty queue, no
   * subscribers — so finished sessions do not leak map entries.
   *
   * @param id - Session id whose state is considered for removal.
   * @param s - The state to test.
   * @returns Nothing.
   * @throws Never.
   */
  const maybeCleanup = (id: string, s: SessionState): void => {
    if (!s.running && s.queue.length === 0 && s.subscribers.size === 0) states.delete(id);
  };

  /**
   * Turn events go to the replay buffer (so a mid-flight subscriber sees the in-progress turn) and
   * all live subscribers.
   *
   * @param s - The session whose replay and subscribers receive the event.
   * @param ev - The pipeline event to record and broadcast.
   * @returns Nothing.
   * @throws Never.
   */
  const emit = (s: SessionState, ev: PipelineEvent): void => {
    s.replay.push(ev);
    for (const sink of s.subscribers) sink.push(ev);
  };

  /**
   * Subscribers-only (no replay buffer): used for the `queued` events that describe the pending
   * queue. Pending is NOT kept in `replay` (which is per-turn) — it's reconstructed from `s.queue`
   * when a subscriber joins, so it survives turn boundaries correctly.
   *
   * @param s - The session whose subscribers receive the event.
   * @param ev - The pipeline event to broadcast.
   * @returns Nothing.
   * @throws Never.
   */
  const notify = (s: SessionState, ev: PipelineEvent): void => {
    for (const sink of s.subscribers) sink.push(ev);
  };

  /**
   * How many submissions sit ahead of the item at queue index `i` (the running turn counts as one).
   *
   * @param s - The session whose queue is measured.
   * @param i - Index of the item within `s.queue`.
   * @returns The number of submissions ahead of it, including any running turn.
   * @throws Never.
   */
  const aheadOf = (s: SessionState, i: number): number => (s.running ? 1 : 0) + i;

  /**
   * Drain the session's queue, one turn per iteration — or one merged turn per maximal run of
   * consecutive concat submissions. For each turn: persist-at-turn-start the merged user message
   * (deriving a title on the session's first turn; skipped for a redo, which re-runs an existing
   * committed user turn), resolve the provider, and run {@link runSession} under the submitter's
   * principal via {@link contextSwitch} so the whole turn is the transactional unit (a deferred
   * StorageBackend swap lands at this scope's quiescent edge, never mid-CAS). After a
   * non-aborted commit, `followup` hooks may append durable markers, head-enqueue robo
   * resubmissions (depth capped at {@link MAX_RESUBMIT_DEPTH}), or retract-and-rerun the
   * just-committed turn. Events stream to subscribers and the replay buffer; turn and
   * persistence failures are emitted as `error` events.
   *
   * Runs detached (`void pump`): it is the turn's async root, so the principal scope lives here.
   *
   * @param id - Session id to pump.
   * @param s - The session's mutable state (queue, running flag, abort controller, subscribers).
   * @returns Resolves when the queue is drained.
   * @throws Never - Failures are caught and emitted as `error` events.
   */
  const pump = async (id: string, s: SessionState): Promise<void> => {
    if (s.running) return;
    s.running = true;
    try {
      while (s.queue.length > 0) {
        // Per-submission concat: the head always runs; if the head is a concat submission it absorbs
        // the following submissions while they too are concat, stopping at the first non-concat (a turn
        // boundary). Net effect: maximal runs of consecutive concat submissions merge into one turn,
        // while every queued/robo submission stays its own ordered turn — concat and queued mix freely.
        const head  = s.queue.shift()!;
        const batch = [head];
        if (head.concatQueue) {
          while (s.queue.length > 0 && s.queue[0]!.concatQueue) batch.push(s.queue.shift()!);
        }
        const content = batch.flatMap(i => i.content);
        const tailEphemeral = batch.flatMap(i => i.ephemeral ?? []);
        s.replay = [];
        // Seed replay with the running turn's user message as a single merged `queued`, mirroring the
        // message persisted just below. notify() (in open()) reaches only subscribers that are live at
        // enqueue time; a GET /events/sessions/:id that connects after this synchronous preamble — the
        // common case when the submit POST wins the race against the events stream — would otherwise
        // find an empty queue and a cleared replay, and never render the user bubble. One merged event
        // (not one per batch item) matches both stored history on reload and the live fold, so a late
        // subscriber reconstructs exactly one bubble. A redo carries no new user message (and no
        // content), so it seeds nothing — its retraction marker already went out at enqueue time.
        if (head.redo === undefined) {
          s.replay.push({ type: 'queued', content, queued: 0, concatQueue: false, traceId: head.traceId, rootTraceId: head.rootTraceId });
        }

        const ac = new AbortController();
        try {
          let session = await deps.store.get(id);
          if (session === null) {
            emit(s, { type: 'error', error: `Session "${id}" not found`, traceId: head.traceId });
            continue;
          }

          // A redo re-runs the existing committed user turn — no title derivation, no new user message.
          if (head.redo === undefined) {
            if (!session.title && !session.messages.some(m => m.role === 'user')) {
              const text = content
                .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
                .map(c => c.text).join(' ').trim();
              if (text) {
                const words = text.split(/\s+/).slice(0, 8).join(' ');
                session = { ...session, title: words.length > 60 ? `${words.slice(0, 60)}…` : words };
              }
            }

            // Persist-at-turn-start: the user message only hits the store when its turn begins, never
            // while queued. That is what stops a mid-turn submit from clobbering session state. A robo
            // resubmission's blocks already carry `origin: 'robo'` (stamped where it was enqueued).
            session = appendMessage(session, createMessage({ role: 'user', content, traceId: head.traceId, providerName: head.provider }));
            await deps.store.set(session.id, session);
          }

          const resolved = await deps.resolveProvider(head.provider);
          if (resolved === null) {
            emit(s, { type: 'error', error: `Unknown provider "${head.provider}"`, traceId: head.traceId });
            continue;
          }

          s.ac = ac;
          const toolMap = deps.tools !== undefined
            ? new Map<string, Tool>(deps.tools.list().map(t => [t.name, t]))
            : undefined;

          // Establish the submitter's principal for the whole turn here, not inside runSession:
          // pump runs detached (`void pump`), so this scope — not the request that enqueued — is the
          // turn's async root. Everything downstream (hooks, tools, and any Store/FileStore/Vault
          // access they trigger) reads it via currentPrincipal(). The consumption MUST happen inside
          // the callback: an async iterator returned out of the scope would lose it before it pulls.
          // contextSwitch (not bare runAs): a turn is the transactional unit, so a StorageBackend swap
          // deferred during it lands at this scope's quiescent edge — never mid-CAS.
          await contextSwitch(head.principal, async () => {
            const observability = deps.observability?.();
            for await (const ev of runSession({
              session,
              config:         { provider: head.provider, traceId: head.traceId, rootTraceId: head.rootTraceId, sessionId: id },
              provider:       resolved.adapter,
              providerConfig: resolved.config,
              store:          deps.store,
              signal:         ac.signal,
              loadPlugin:     deps.loadPlugin,
              unloadPlugin:   deps.unloadPlugin,
              ...(toolMap            !== undefined ? { tools:         toolMap            } : {}),
              ...(deps.tools         !== undefined ? { toolRegistry:  deps.tools         } : {}),
              ...(deps.hooks         !== undefined ? { hooks:         deps.hooks         } : {}),
              ...(deps.systemContext !== undefined ? { systemContext: deps.systemContext } : {}),
              ...(deps.workdir       !== undefined ? { workdir:       deps.workdir       } : {}),
              ...(deps.files         !== undefined ? { files:         deps.files         } : {}),
              ...(deps.configPath    !== undefined ? { configPath:    deps.configPath    } : {}),
              ...(deps.vault         !== undefined ? { vault:         deps.vault         } : {}),
              ...(head.prompt        !== undefined ? { prompt:        head.prompt        } : {}),
              ...(head.redo          !== undefined ? { injectedEphemeral: head.redo.ephemeral } : {}),
              ...(tailEphemeral.length > 0 ? { tailEphemeral } : {}),
              ...(observability !== undefined ? { observability } : {}),
              ...(deps.permissions?.()!==undefined?{permissions:deps.permissions()!}:{}),
            })) {
              emit(s, ev);
            }
          });

          // followup — post-commit, in the queue owner. A hook reads the just-committed turn and may
          // head-enqueue a robo follow-up (its own real turn, running next). Skipped on abort; runs
          // under the submitter's principal because a reactor may itself call complete() (a classifier).
          const hooks = deps.hooks;
          if (!ac.signal.aborted && hooks) {
            const committed = await deps.store.get(id);
            if (committed && head.resubmitDepth < MAX_RESUBMIT_DEPTH) {
              let followup: { resubmits: MessageContent[][]; markers: MessageContent[]; retract?: { context: MessageContent[] } } = { resubmits: [], markers: [] };
              await contextSwitch(head.principal, async () => {
                followup = await hooks.runFollowup({
                  session:       committed,
                  resubmitDepth: head.resubmitDepth,
                  config:        { provider: head.provider, traceId: head.traceId },
                  signal:        ac.signal,
                  ...(head.prompt !== undefined ? { prompt: head.prompt } : {}),
                });
              });
              const resubmits = followup.resubmits;

              // Durable markers a followup hook returned (e.g. a fired trigger's silent tool tracing
              // what it did). Append-only to the just-committed session; the pump is the sole writer
              // post-commit, so an unconditional set is safe. Emitted live too (post-`done`, like a
              // `queued` event) so a live draw matches a reload — the engine surfaces everything it
              // persists; a frontend filters if it wants to. Skipped when retracting: the pop rewrites
              // the message tail, so these markers are folded into that single write instead (below)
              // to keep ordering sane (a separate append here would be sliced into the popped region).
              if (followup.markers.length > 0 && !followup.retract) {
                await deps.store.set(id, {
                  ...committed,
                  messages: [...committed.messages, {
                    id:        crypto.randomUUID(),
                    role:      'marker',
                    createdAt: new Date().toISOString(),
                    traceId:   head.traceId,
                    content:   followup.markers,
                  }],
                });
                notify(s, { type: 'marker', content: followup.markers, traceId: head.traceId });
              }
              // unshift in reverse so the hooks' order is preserved at the head of the queue. Stamp
              // every block `origin: 'robo'` here — once — so it rides into both the live `queued`
              // event and the persisted user message the pump builds from this item.
              for (const raw of resubmits.reverse()) {
                const rt = crypto.randomUUID();
                const content = raw.map(c => (c.type === 'text' ? { ...c, origin: 'robo' as const } : c));
                s.queue.unshift({
                  traceId:       rt,
                  rootTraceId:   head.rootTraceId,
                  content,
                  provider:      head.provider,
                  principal:     head.principal,
                  concatQueue:   false,
                  resubmitDepth: head.resubmitDepth + 1,
                });
                notify(s, { type: 'queued', content, queued: 0, concatQueue: false, traceId: rt, rootTraceId: head.rootTraceId });
              }

              // retract-and-rerun: pop the just-committed turn back to (and excluding) the last user
              // message, stash the popped messages in a durable retraction marker (LLM-elided like any
              // marker — so the model never re-reads its superseded answer — but carried in `data` for
              // a strike-through render and audit), then re-enqueue a redo of that same user turn at the
              // head, delivering the trigger tool's output as ephemeral context. Unshifted last so it
              // sits at the very head (runs next) even if a resubmit was also queued above.
              if (followup.retract) {
                const lastUserIdx = committed.messages.findLastIndex(m => m.role === 'user');
                const popped = lastUserIdx >= 0 ? committed.messages.slice(lastUserIdx + 1) : [];
                const kept   = lastUserIdx >= 0 ? committed.messages.slice(0, lastUserIdx + 1) : committed.messages;
                const retractionMsg: Message = {
                  id:        crypto.randomUUID(),
                  role:      'marker',
                  createdAt: new Date().toISOString(),
                  traceId:   head.traceId,
                  // `retracted` is what was popped (the superseded answer); `injected` is the ephemeral
                  // context fed to the redo — neither is otherwise persisted, so the pair fully traces
                  // the swap for a post-mortem (and a frontend can render the strike-through + the cause).
                  content:   [{ type: 'marker', creator: RETRACTION_CREATOR, data: { retracted: popped, injected: followup.retract.context, traceId: head.traceId } }],
                };
                // Any followup markers ride along as a trailing marker message (not folded into the
                // retraction marker) so each creator's trace stays its own block.
                const trailing: Message[] = followup.markers.length > 0
                  ? [{ id: crypto.randomUUID(), role: 'marker', createdAt: new Date().toISOString(), traceId: head.traceId, content: followup.markers }]
                  : [];
                await deps.store.set(id, { ...committed, messages: [...kept, retractionMsg, ...trailing] });
                notify(s, { type: 'marker', content: retractionMsg.content, traceId: head.traceId });
                if (trailing.length > 0) notify(s, { type: 'marker', content: followup.markers, traceId: head.traceId });

                const rt = crypto.randomUUID();
                s.queue.unshift({
                  traceId:       rt,
                  rootTraceId:   head.rootTraceId,
                  content:       [],
                  provider:      head.provider,
                  principal:     head.principal,
                  concatQueue:   false,
                  resubmitDepth: head.resubmitDepth + 1,
                  redo:          { ephemeral: followup.retract.context },
                  ...(head.prompt !== undefined ? { prompt: head.prompt } : {}),
                });
              }
            }
          }
        } catch (e) {
          emit(s, { type: 'error', error: String(e), traceId: head.traceId });
        } finally {
          s.ac = undefined;
        }
      }
    } finally {
      s.running = false;
      s.replay  = [];
      // Deterministic busy→idle signal: running is now false, so any subscriber draining the stream
      // (a frontend's status tracker) reads an authoritative idle the moment it sees this — no racing
      // the microtask on which `running` flipped. Not in `replay` (transient lifecycle, not history).
      notify(s, { type: 'idle', sessionId: id });
      maybeCleanup(id, s);
    }
  };

  return {
    /**
     * Submit content and/or attach to a session's live event stream. With content: validates the
     * submission, enqueues it, announces it as a `queued` event, and kicks the pump. Always:
     * loads the committed history and returns a view whose `events` iterable delivers the
     * in-progress turn's replay followed by the pending queue (the delta region). Pure reads do
     * not materialize a state entry.
     *
     * @param opts - Session id plus, for a submission, content/provider/principal (with optional
     *               ephemeral context, concat flag, prompt, and trace id); `signal` closes the
     *               event stream when aborted.
     * @returns The committed session, the pending count, the submission trace id (when
     *           submitting), and the lazily-created event stream.
     * @throws Error - When a submission lacks provider or principal, or the session does not
     *           exist in the store.
     */
    async open(opts: OpenOpts | SubmitOpenOpts): Promise<SessionView> {
      // For a pure read (no content, events never tapped) we must not materialise a state entry —
      // otherwise every session_action `get` would leak one. State is created only when there is
      // something to queue or someone to subscribe.
      let s = states.get(opts.sessionId);

      let traceId: string | undefined;
      if ('content' in opts) {
        // Belt-and-braces: the union enforces this for TS callers, but a frontend deserialising a
        // request body can still hand us a malformed object — fail loudly at the boundary.
        if (opts.provider === undefined || opts.principal === undefined) {
          throw new Error('open(): submitting content requires both provider and principal');
        }
        s = stateFor(opts.sessionId);
        traceId = opts.traceId ?? crypto.randomUUID();
        const concatQueue = opts.concatQueue ?? false;
        s.queue.push({
          traceId,
          rootTraceId:   traceId,
          content:       opts.content,
          ...(opts.ephemeral !== undefined ? { ephemeral: opts.ephemeral } : {}),
          provider:      opts.provider,
          principal:     opts.principal,
          concatQueue,
          resubmitDepth: 0,
          ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
        });
        // Announce the submission on the stream as part of the live delta, before its turn's events.
        // If it runs immediately `queued` is 0 (no wait); otherwise it's how many are ahead. concatQueue
        // tells a frontend whether this submission will merge into the running batch (so it can fold the
        // bubble) or run as its own turn.
        notify(s, { type: 'queued', content: opts.content, queued: aheadOf(s, s.queue.length - 1), concatQueue, traceId, rootTraceId: traceId });
        void pump(opts.sessionId, s);
      }

      // Stored state is pure committed history (ends at the running turn's user message). The pending
      // queue and the in-progress response are the "delta", delivered over `events` — never overlaid
      // here — so `stored ++ delta` concatenates in a single, refresh-stable order.
      const base = await deps.store.get(opts.sessionId);
      if (base === null) throw new Error(`Session "${opts.sessionId}" not found`);

      let cached: AsyncIterable<PipelineEvent> | undefined;
      const view: SessionView = {
        session: base,
        queued: s !== undefined ? s.queue.length : 0,
        ...(traceId !== undefined ? { traceId } : {}),
        /**
         * The session's live delta: replay of the in-progress turn, then a `queued` event per
         * pending submission. Created once per view; closes and unregisters when `opts.signal`
         * aborts or the consumer stops iterating.
         *
         * @returns A single-consumer async iterable of pipeline events.
         */
        get events(): AsyncIterable<PipelineEvent> {
          if (cached === undefined) {
            const st = stateFor(opts.sessionId);
            /**
             * Unregister this subscriber and release the session's state if now idle.
             *
             * @returns Nothing.
             * @throws Never.
             */
            const remove = (): void => { st.subscribers.delete(sink); maybeCleanup(opts.sessionId, st); };
            const sink = createSink(remove);
            st.subscribers.add(sink);
            // Replay the in-progress turn, then the pending queue — the delta region, in order.
            for (const ev of st.replay) sink.push(ev);
            st.queue.forEach((item, i) =>
              sink.push({ type: 'queued', content: item.content, queued: aheadOf(st, i), concatQueue: item.concatQueue, traceId: item.traceId, rootTraceId: item.rootTraceId }));
            if (opts.signal.aborted) { sink.close(); remove(); }
            else opts.signal.addEventListener('abort', () => { sink.close(); remove(); }, { once: true });
            cached = sink.iterable;
          }
          return cached;
        },
      };
      return view;
    },

    /**
     * Cancel everything for a session: each queued submission is drained from the queue and
     * announced with a `cancelled` event, and the running turn (if any) is aborted with reason
     * `user-abort` — its completed work is still persisted and paired.
     *
     * @param sessionId - Session whose queued and running work to cancel.
     * @returns Nothing; a no-op for unknown sessions.
     * @throws Never.
     */
    abort(sessionId: string): void {
      const s = states.get(sessionId);
      if (s === undefined) return;
      for (const item of s.queue.splice(0)) {
        emit(s, { type: 'cancelled', sessionId, traceId: item.traceId });
      }
      s.ac?.abort('user-abort');
    },

    /**
     * Abandon only the running turn, aborting it with reason `user-cancel`. Queued submissions
     * are deliberately untouched: they are separate operations the user lined up and survive
     * into the next pump iteration.
     *
     * @param sessionId - Session whose running turn to cancel.
     * @returns Nothing; a no-op for unknown sessions.
     * @throws Never.
     */
    cancelTurn(sessionId: string): void {
      const s = states.get(sessionId);
      if (s === undefined) return;
      // Deliberately no queue splice: cancel abandons only the running turn; queued submissions are
      // separate operations the user lined up and survive into the next `pump` iteration.
      s.ac?.abort('user-cancel');
    },

    /**
     * Snapshot the session's activity.
     *
     * @param sessionId - Session to inspect.
     * @returns `running` (a turn is executing), `queued` (pending submissions), and `busy`
     *           (either of the former); all false/0 for unknown sessions.
     * @throws Never.
     */
    status(sessionId: string): { busy: boolean; running: boolean; queued: number } {
      const s = states.get(sessionId);
      const running = s?.running ?? false;
      const queued  = s?.queue.length ?? 0;
      return { busy: running || queued > 0, running, queued };
    },
  };
}
