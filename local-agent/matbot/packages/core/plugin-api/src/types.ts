import type { MatbotPlugin } from './plugin.js';
import type { StoreQuery, QueryResult } from './store-query.js';

// ── Primitives ────────────────────────────────────────────────────────────────

/** An ISO-8601 timestamp string. */
export type ISODate = string;
/** An RFC-style MIME type string (e.g. `text/plain`). */
export type MimeType = string;
/** A JSON-Schema object describing a tool's input. */
export type JSONSchema = Record<string, unknown>;

// ── Principal ───────────────────────────────────────────────────────────────

/** Identity of whatever initiated an operation — a turn, a tool call, a store read/write.
 *  Established at each entry point and carried ambiently via the `PrincipalCarrier`
 *  (`currentPrincipal()` / `runAs()`), so any layer can attribute or test the origin without it
 *  being threaded through every signature. It grants nothing — policy is the service's concern. */
export interface Principal {
  id:    string;
  type:  'user' | 'agent' | 'system';
}

// ── Provider ──────────────────────────────────────────────────────────────────

/** Sampling and limit parameters forwarded to the provider; open to provider-specific extensions. */
export interface ModelParameters {
  temperature?:    number;
  maxTokens?:      number;
  topP?:           number;
  stopSequences?:  string[];
  [key: string]:   unknown;
}

/** A named provider profile from matbot.yaml: which adapter module to load, what model and credentials to use. */
export interface ProviderConfig {
  /** The profile's key in the `providers` map. */
  name:         string;
  /** Plugin module specifier (npm name or file URL) that provides the adapter for this provider. */
  module:       string;
  /** The model identifier sent to the provider. */
  model:        string;
  /** Secret values (often `${NAME}` references resolved by the Vault). */
  credentials?:  Record<string, string>;
  /** Provider API base URL; defaults are adapter-specific. */
  endpoint?:    string;
  /** Model sampling/limit parameters. */
  parameters?:  ModelParameters;
  /** Provider name to fall back to when this one fails. */
  fallback?:    string;
}

/** The streaming events a provider adapter yields while producing one completion. */
export type CompletionEvent =
  | { type: 'text-delta';          delta: string }
  | { type: 'tool-call';           id: string; name: string; input: unknown }
  | { type: 'tool-result';         id: string; result: unknown }
  | { type: 'thinking';            delta: string }
  | { type: 'thinking-block';      thinking: string; signature: string }
  | { type: 'redacted-thinking';   data: string }
  | { type: 'reasoning-block';     reasoning: string }
  | { type: 'refusal';             text: string }
  | { type: 'unknown-block';       blockType: string; raw: unknown }
  | { type: 'usage';               inputTokens: number; outputTokens: number; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number }
  | { type: 'done' };

/** A provider adapter plugin: turns matbot messages into provider API calls and streams back events. */
export interface ProviderAdapter {
  /** The adapter's provider name. */
  readonly name: string;
  /**
   * Run a completion and stream its events.
   *
   * @param messages - The full conversation to send.
   * @param config - The named provider profile (endpoint, model, credentials, parameters).
   * @param tools - Tool definitions the model may call.
   * @param signal - Aborting cancels the underlying request.
   * @returns An async iterable of completion events, ending with `done`.
   */
  complete(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal
  ): AsyncIterable<CompletionEvent>;
  /**
   * Probe the provider's reachability.
   *
   * @returns The health status (ok/degraded/down, with reason and latency where known).
   */
  health(): Promise<HealthStatus>;
}

// ── Messages & Session ────────────────────────────────────────────────────────

/** LLM-protocol roles of a message in a session. */
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'marker';

/** One content block of a message: text, media, tool traffic, forms, markers, or opaque passthrough. */
export type MessageContent = (
  | { type: 'text';              text: string }
  | { type: 'thinking';          thinking: string; signature: string }
  | { type: 'redacted-thinking'; data: string }
  | { type: 'reasoning';         reasoning: string }
  | { type: 'image';             data: string; mimeType: MimeType }
  | { type: 'image-url';         url: string; detail?: 'low' | 'high' | 'auto' }
  | { type: 'document';          data: string; mimeType: MimeType; name?: string }
  | { type: 'audio';             data: string; mimeType: MimeType }
  | { type: 'tool-call';         id: string; name: string; input: unknown }
  | { type: 'tool-result';       id: string; result: unknown; isError?: boolean }
  | { type: 'refusal';           text: string }
  | { type: 'file-ref';          fileId: string; name: string; mimeType: MimeType }
  | { type: 'form';              fields: FormField[]; submitLabel?: string }
  | { type: 'form-response';     values: Record<string, string> }
  | { type: 'marker';            creator: string; data: unknown }
  | { type: 'unknown-content';   blockType: string; raw: unknown }
) & {
  /**
   * Authorship provenance, for *presentation only* — orthogonal to the message's `role`, which is
   * the LLM-protocol identity. Absent ⇒ authored per the role (a human for `user`, the model for
   * `assistant`). `'robo'` ⇒ machine-authored by matbot — a `followup` resubmission, or a hook-
   * injected fragment inside a human turn. It is still carried to the model as ordinary
   * role-appropriate content (the model sees a `user` block either way); the flag is OOB metadata
   * that frontends use to present it agent-side (a robot indicator) rather than as the user's words.
   */
  origin?: 'robo';
};

/**
 * A marker is opaque, durable annotation carried in the message stream: links, status,
 * cross-references that are meaningful to a frontend but transparent to the LLM. They are
 * persisted unchanged, elided from provider submission, and deliberately preserved by
 * session compaction (removing one can break things — e.g. a pointer back to an ancestor
 * session). Any code with session access may emit one, normally as its own message.
 *
 * `creator` is the emitting plugin's reference; `data` is anything serialisable. For
 * per-creator type safety, augment `MarkerData` and read/write via `Marker<'your-creator'>`:
 *
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface MarkerData { 'split-session': { peerSessionId: string } }
 *   }
 *
 * Unregistered creators fall back to `data: unknown`. The base `MessageContent` member stays
 * loose (`creator: string`) so the union and its exhaustive switches are unaffected.
 */
export interface MarkerData {
  /** Emitted by the hook dispatcher when a hook handler threw: the hook was skipped (treated as a
   *  no-op) and this records it once, so a misconfigured/throwing hook degrades visibly instead of
   *  bricking the turn. `channel` is the hook point, `pluginName` the owning plugin if known. */
  'matbot-hooks': { channel: HookPoint; pluginName?: string; message: string };
}

export type Marker<K extends string = string> = {
  type:    'marker';
  creator: K;
  data:    K extends keyof MarkerData ? MarkerData[K] : unknown;
};

/** One field of a structured prompt rendered by a frontend. */
export interface FormField {
  /** Machine name of the field, returned as part of a form response. */
  name:        string;
  /** Human-readable label shown to the user. */
  label:       string;
  /** The control to render. */
  type:        'text' | 'password' | 'select' | 'confirm';
  /** select-only: the preset options offered. */
  options?:    string[];
  /** select-only: render an "Other…" affordance that lets the user type a free-form answer instead
   *  of picking an option. The typed value is returned verbatim, on the same channel as a pick —
   *  callers never learn whether the answer was a preset or free text. Ignored for other types. */
  allowOther?: boolean;
  default?:    string;
  required?:   boolean;
  /** Presentation hint only (default true): whether the frontend offers a cancel affordance (the
   *  "give up" path — see `PromptFn`). Set false to render a hard-blocking prompt with no out. The
   *  runner and server never consult this; a frontend with no cancel UI simply can't fire one. */
  cancelable?: boolean;
}

/**
 * Canonical values a `type: 'confirm'` prompt resolves to. The rendered label and buttons are a
 * cosmetic, host-specific concern (and may be localised), so consumers MUST branch on these tokens
 * — never on the displayed string. Compare case-insensitively to tolerate host casing differences.
 */
export const CONFIRM_YES = 'yes';
export const CONFIRM_NO  = 'no';

/** One message in a session: role, content blocks, and correlation metadata. */
export interface Message {
  /** Unique message id. */
  id:            string;
  /** LLM-protocol role. */
  role:          MessageRole;
  /** The message's content blocks. */
  content:       MessageContent[];
  /** ISO-8601 creation timestamp. */
  createdAt:     ISODate;
  /** Correlation id of the turn that produced this message. */
  traceId:       string;
  /** Provider key that generated the content, when machine-authored. */
  providerName?: string;
  /** Free-form, frontend-extensible metadata. */
  metadata?:     Record<string, unknown>;
}

/** Lifecycle state of a session. */
export type SessionStatus = 'active' | 'archived' | 'pinned';

/** A conversation: ordered messages, ownership, and branching provenance. */
export interface Session {
  /** Unique session id. */
  id:                    string;
  /** Optimistic-concurrency version for compare-and-swap writes. */
  version:               string;
  /** Id of the principal that owns the session. */
  ownerPrincipalId:      string;
  /** Id of the principal acting within the session, when different from the owner. */
  actorPrincipalId?:     string;
  /** Persona/system-context label applied to the conversation. */
  persona?:              string;
  /** Human-readable title (usually derived from the first turn). */
  title?:                string;
  /** Lifecycle state. */
  status:                SessionStatus;
  /** Context tags attached to the session. */
  contexts:              string[];
  /** The full message history. */
  messages:              Message[];
  /** Parent session id when this session was branched/forked from another. */
  parentSessionId?:      string;
  /** Message in the parent at which the branch occurred. */
  branchPointMessageId?: string;
  /** ISO-8601 creation timestamp. */
  createdAt:             ISODate;
  /** ISO-8601 last-update timestamp. */
  updatedAt:             ISODate;
}

// ── System context ────────────────────────────────────────────────────────────

/**
 * Contributes a fragment of the system prompt for a turn. Return `null` to contribute nothing.
 *
 * @param ctx - The session being run and the turn's abort signal.
 * @returns A text fragment, or `null`.
 */
export type SystemContextContributor = (ctx: {
  session:   Session;
  signal:    AbortSignal;
}) => string | null | Promise<string | null>;

/** Registry of {@link SystemContextContributor}s, managed per-plugin by the loader. */
export interface SystemContextRegistry {
  /**
   * Register a system-context contributor.
   *
   * @param contributor - The contributor to call on each turn.
   * @param pluginName - Owning plugin, used to bulk-remove on unload.
   */
  register(contributor: SystemContextContributor, pluginName?: string): void;
  /**
   * Remove every contributor registered by the named plugin.
   *
   * @param pluginName - The plugin whose contributors to drop.
   */
  removeByPlugin(pluginName: string): void;
  /** Calls all contributors and joins non-null, non-empty results with double newlines. */
  build(ctx: { session: Session; signal: AbortSignal }): Promise<string | null>;
}

// ── Pipeline hooks ────────────────────────────────────────────────────────────

/** Configuration for running one turn: provider, persona, session, and trace correlation. */
export interface RunConfig {
  /** Provider key to route the turn through. */
  provider:   string;
  /** Persona label applied to the turn. */
  persona?:   string;
  /** Session to run against; a new one is created when absent. */
  sessionId?: string;
  /** Correlation id for this submission; generated when absent. */
  traceId?:   string;
  /** Root human-submission trace for resubmission chains. Defaults to traceId. */
  rootTraceId?: string;
}

/** The kind of operation an observability span covers. */
export type ObservabilitySpanKind =
  | 'agent'
  | 'llm'
  | 'tool'
  | 'retriever'
  | 'reranker'
  | 'guardrail'
  | 'workflow'
  | 'evaluator'
  | 'chain';

/** Where in a span's lifetime the event sits. */
export type ObservabilityEventPhase = 'start' | 'event' | 'end';
/** Outcome recorded on span-end events. */
export type ObservabilityStatus = 'unset' | 'ok' | 'error';

/** Vendor-neutral event that an optional service can persist and export as OTLP. */
export interface ObservabilityEvent {
  traceId:        string;
  rootTraceId:    string;
  spanId:         string;
  parentSpanId?:  string;
  sessionId?:     string;
  workflowRunId?: string;
  timestamp:      string;
  phase:          ObservabilityEventPhase;
  kind:           ObservabilitySpanKind;
  name:           string;
  status?:        ObservabilityStatus;
  durationMs?:    number;
  attributes?:    Record<string, unknown>;
}

/** Receives observability events for persistence/export (e.g. as OTLP). */
export interface ObservabilitySink {
  /**
   * Record one observability event.
   *
   * @param event - The event to persist.
   */
  record(event: ObservabilityEvent): void | Promise<void>;
}

/**
 * Hooks are sorted by the *job* they do, not by lifecycle position — the channel name is the
 * contract. Each channel has a fixed home, cadence, and effect-ceiling (a hook may always do
 * less: returning nothing makes it a pure observer). The discriminated union on `on` is what
 * keeps the effects honest — `contribute` hands you a read-only session, `toolcall`/`react` can't
 * return one at all, so a write that goes nowhere won't type-check.
 *
 *   screen      runner, once per turn before the first provider call. The only channel that may
 *               durably mutate history. Returns any of: a replacement `session` (persisted),
 *               turn-scoped `ephemeral` context (appended onto the tail of this turn's outgoing
 *               messages — the freshest input the model reads — never persisted, and placed at the
 *               tail rather than a system prefix so a "do X now" directive keeps its salience and
 *               doesn't bust the cached prefix), `durable` context (the persisted, visible twin of
 *               `ephemeral`: folded onto this turn's user message as `origin: 'robo'` blocks and
 *               carried live as a `robo-user` event, so it survives into the next turn's history),
 *               or `abort`. Mix freely. This is where the durable-vs-ephemeral choice for incoming
 *               user input lives.
 *   contribute  runner, before *every* provider call. Ephemeral by construction (it re-fires, so a
 *               durable mutation would accumulate). Returns a transformed copy of `outgoing` — the
 *               message array about to be sent — and never touches the stored session. Mind prompt
 *               caching: vary the *tail* (newest turn) freely, but a transform that rewrites the
 *               cached prefix (system / early history) busts the cache on every call.
 *   toolcall    runner, before each tool execution. Read-only. Returns `rejectTool` (skip this call,
 *               feed an error result back so the model self-corrects, without breaking the
 *               tool_use/tool_result pairing) and/or `abort`.
 *   toolresult  runner, after each tool execution, before the result is recorded/yielded. Folds the
 *               result through each hook: return `{ result }` to replace it (hard redaction, truncation),
 *               or nothing to observe (auditing — the context carries args, result, isError and
 *               `durationMs`). It owns the LLM-facing + persisted result and the `tool:end` event;
 *               note it does NOT see the live `tool:stdout/stderr` chunks, which stream before the
 *               result exists.
 *   followup    pump, once after a turn commits (post-persist). May `resubmit` a robo follow-up turn
 *               (head-enqueued, so it runs next as its own real turn; `resubmitDepth` is the chain
 *               length for the hook's own budget — the runner also hard-caps it), `retractAndRerun`
 *               (pop the committed turn into a marker and re-run the originating user turn with
 *               ephemeral context — supersede rather than follow), and/or append durable `markers`
 *               to the committed session (LLM-invisible annotations — the second durable-write point
 *               after `screen`, safe because it too fires once per turn).
 */
export type HookPoint = 'screen' | 'contribute' | 'toolcall' | 'toolresult' | 'followup';

/** Context handed to a `screen` hook (once per turn, before the first provider call). */
export interface ScreenContext {
  session: Session;
  config:  RunConfig;
  signal:  AbortSignal;
  /** The turn's interactive prompt, when a frontend supplied one (a live user behind this turn).
   *  A hook that drives an interactive tool (e.g. a trigger invoking `ask_user`) forwards this into
   *  the tool's context; absent (cron/background/no frontend) the tool gets a rejecting prompt. */
  prompt?: PromptFn;
  /** Unregister the hook currently running. For one-shot hooks that should fire at most once. */
  removeHook(): void;
}
/** What a `screen` hook may return: any mix of session replacement, context, markers, or abort. */
export interface ScreenResult {
  session?:   Session;
  /** Turn-scoped context appended onto the tail of this turn's outgoing messages (the freshest
   *  input the model reads), never persisted. At the tail, not a system prefix, so a directive
   *  keeps its salience and the cached system/history prefix stays stable across turns. */
  ephemeral?: MessageContent[];
  /**
   * The persisted, visible twin of `ephemeral`: context that should outlive this turn rather than
   * inform it once. The runner folds these blocks onto this turn's user message (so they ride into
   * the stored history and every subsequent provider call) AND carries them live as a `robo-user`
   * event, so a live draw and a reload render the same thing. They are LLM-visible (unlike
   * `markers`) and machine-authored, so a caller marks them `origin: 'robo'` for presentation.
   * Use when a fired hook produces context that genuinely updates the conversation, not a one-shot
   * corrective for the turn about to run.
   */
  durable?:   MessageContent[];
  /**
   * Durable `marker` blocks to append to this turn's session (LLM-invisible). The dispatcher both
   * appends them to the persisted session AND carries them live on the turn's event stream, so a
   * live draw and a reload render the same thing. Use instead of hand-appending to `session` when
   * you just want to annotate (e.g. a fired trigger's silent tool recording what it did).
   */
  markers?:   MessageContent[];
  abort?:     string;
}

/** Read-only context handed to a `contribute` hook before every provider call. */
export interface ContributeContext {
  readonly outgoing: readonly Message[];
  readonly session:  Session;
  config:  RunConfig;
  signal:  AbortSignal;
  /** Unregister the hook currently running. For one-shot hooks that should fire at most once. */
  removeHook(): void;
}

/** Read-only context handed to a `toolcall` hook before each tool execution. */
export interface ToolCallContext {
  readonly session:  Session;
  readonly toolCall: { id: string; name: string; input: unknown };
  readonly tool:     Tool;
  config:  RunConfig;
  signal:  AbortSignal;
  /** Unregister the hook currently running. For one-shot hooks that should fire at most once. */
  removeHook(): void;
}
/** A `toolcall` hook's verdict: reject the call, abort the turn, or nothing (allow). */
export interface ToolCallResult {
  /** Skip the tool execution and feed this error message back to the model. */
  rejectTool?: { message: string };
  /** Abort the whole turn with this reason. */
  abort?:      string;
}

/** Read-only context handed to a `toolresult` hook after each tool execution. */
export interface ToolResultContext {
  readonly session:    Session;
  readonly toolCall:   { id: string; name: string; input: unknown };
  readonly tool:       Tool;
  readonly result:     unknown;
  readonly isError:    boolean;
  readonly durationMs: number;
  config:  RunConfig;
  signal:  AbortSignal;
  /** Unregister the hook currently running. For one-shot hooks that should fire at most once. */
  removeHook(): void;
}
// The toolresult hook returns `{ result }` to replace the tool's result, or nothing to leave it
// (and just observe) — a trivial single-field return, inlined in the Hook union like `contribute`'s.

/** Context handed to a `followup` hook once per committed turn. */
export interface FollowupContext {
  readonly session:       Session;
  readonly resubmitDepth: number;
  config:  RunConfig;
  signal:  AbortSignal;
  /** The turn's interactive prompt, when a frontend supplied one (a live user behind this turn).
   *  A hook that drives an interactive tool (e.g. a trigger invoking `ask_user` as a proactive
   *  follow-up question) forwards this into the tool's context; absent (cron/background/no frontend)
   *  the tool gets a rejecting prompt. Note this prompt fires *post-commit*, out of band from the
   *  turn's `done`, and blocks the pump until the human answers. */
  prompt?: PromptFn;
  /** Unregister the hook currently running. For one-shot hooks that should fire at most once. */
  removeHook(): void;
}
/** What a `followup` hook may return: resubmit, retract-and-rerun, append markers, or nothing. */
export interface FollowupResult {
  resubmit?: { content: MessageContent[] };
  /**
   * Retract-and-rerun: supersede the just-committed turn instead of following it. The pump pops the
   * committed turn back to (and excluding) the last user message, stashes the popped content in a
   * durable retraction marker (LLM-elided like every marker, so a frontend can render it
   * struck-through and a post-mortem can audit it), then re-runs that same user turn with `context`
   * injected EPHEMERALLY (tail-folded, never persisted) — agent-phase injection time-shifted onto a
   * committed turn. This is the inverse of `resubmit`, which leaves the response in place and appends
   * a new robo turn after it. Self-terminating by design: a well-formed trigger fires on a *curable*
   * defect that the injected context dissolves on the redo, so it won't re-fire; `resubmitDepth` (a
   * redo carries parent+1) caps an ill-formed one. `resubmit` and `retractAndRerun` are independent
   * capabilities — a single turn returning both is not expected, but both head-enqueue if it does.
   */
  retractAndRerun?: { context: MessageContent[] };
  /**
   * Durable `marker` blocks to append to the just-committed session (LLM-invisible; for tracing /
   * cross-references). The second durable-write capability after `screen` — safe here for the same
   * reason: `followup` fires once per turn, so an append can't accumulate the way a per-call channel
   * would. The pump persists them AND emits them live (post-commit, like a `queued` event) so a live
   * draw matches a reload. Use for recording what a post-commit reaction (e.g. a fired trigger's
   * silent tool) actually did.
   */
  markers?: MessageContent[];
}

/** The discriminated union of pipeline hooks; `on` selects channel, context, and allowed effects. */
export type Hook =
  | { on: 'screen';     priority?: number; pluginName?: string; handler(ctx: ScreenContext):     ScreenResult | void | Promise<ScreenResult | void> }
  | { on: 'contribute'; priority?: number; pluginName?: string; handler(ctx: ContributeContext): Message[]    | void | Promise<Message[]    | void> }
  | { on: 'toolcall';   priority?: number; pluginName?: string; handler(ctx: ToolCallContext):   ToolCallResult | void | Promise<ToolCallResult | void> }
  | { on: 'toolresult'; priority?: number; pluginName?: string; handler(ctx: ToolResultContext): { result: unknown } | void | Promise<{ result: unknown } | void> }
  | { on: 'followup';   priority?: number; pluginName?: string; handler(ctx: FollowupContext):   FollowupResult | void | Promise<FollowupResult | void> };

// ── Storage ───────────────────────────────────────────────────────────────────
// The query grammar (Filter AST, StoreQuery, QueryResult, StoreQueryError) lives in ./store-query.

/** Outcome of a compare-and-swap write: the new doc on success, or the current doc on version conflict. */
export type CASResult<T> =
  | { ok: true;  doc: T }
  | { ok: false; current: T | null };

/**
 * The universal document-store interface. All writes that may race use compare-and-swap
 * (`cas`) — never write without a version check when concurrent updates are possible.
 */
export interface Store<T extends { id: string; version: string }> {
  /**
   * Fetch one document by id.
   *
   * @param id - Document id.
   * @returns The document, or `null` when absent.
   */
  get(id: string): Promise<T | null>;
  /**
   * Unconditionally write a document (no version check).
   *
   * @param id - Document id.
   * @param value - The document to store.
   * @returns Resolves when persisted.
   */
  set(id: string, value: T): Promise<void>;
  /**
   * Compare-and-swap write.
   *
   * @param id - Document id.
   * @param expected - The version the caller last read.
   * @param next - The new document content.
   * @returns `{ ok: true, doc }` on success, or `{ ok: false, current }` on mismatch.
   */
  cas(id: string, expected: string, next: T): Promise<CASResult<T>>;
  /**
   * Delete a document, optionally guarded by an expected version.
   *
   * @param id - Document id.
   * @param expectedVersion - When supplied, delete only if the stored version matches.
   * @returns Whether a document was deleted.
   */
  delete(id: string, expectedVersion?: string): Promise<boolean>;
  /**
   * Run a query over the namespace.
   *
   * @param q - Filter/sort/page specification.
   * @returns One page of matching documents.
   * @throws {StoreQueryError} If the query fails validation.
   */
  query(q: StoreQuery): Promise<QueryResult<T>>;
}

// ── Knowledge index ───────────────────────────────────────────────────────────

/** One indexed knowledge document. */
export interface KnowledgeEntry {
  id:           string;
  version:      string;
  entities:     string[];
  tags:         string[];
  summary:      string;
  content:      string;
  contentHash?: string;
  source:       { type: string; uuid: string };
  confidence?:  number;
  createdAt:    string;
  updatedAt:    string;
}

/** A searchable knowledge index — a core, swappable service. */
export interface KnowledgeIndex {
  /**
   * Index (or replace) a knowledge entry.
   *
   * @param entry - The entry to store.
   * @returns Resolves when the entry is searchable.
   */
  index(entry: KnowledgeEntry): Promise<void>;
  /**
   * Search the index for entries matching the terms.
   *
   * @param terms - Terms to match; `context` may guide ranking.
   * @param signal - Aborting cancels the search.
   * @returns Matching entries, best first.
   */
  search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]>;
  /** Enumerate all indexed entries. When present, register('KnowledgeIndex', …) drains these into the incoming backend. */
  entries?(): Iterable<KnowledgeEntry>;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/** Streaming events a tool emits while executing (output chunks, progress, results, markers, errors). */
export type ToolEvent =
  | { type: 'stdout';   chunk: string }
  | { type: 'stderr';   chunk: string }
  | { type: 'progress'; pct: number; message?: string }
  | { type: 'result';   value: unknown }
  | { type: 'file';     handle: FileHandle }
  // A durable, LLM-invisible annotation the tool emits as it runs (a link, a status, a trace of a
  // side-effect). Persisted as a `marker`-role message; elided from provider submission like any
  // marker. Independent of `result` — a tool may emit markers and no result (a silent side-effect,
  // e.g. a trigger-fired tool), a result and no markers, or both.
  | { type: 'marker';   creator: string; data: unknown }
  | { type: 'error';    message: string; code?: number; stdout?: string; stderr?: string };

/**
 * Ask the user a question and resolve with their answer. The host supplies the
 * implementation — readline in the CLI, an SSE round-trip in the web frontend. This is
 * matbot's single mechanism for eliciting user input at runtime; it is injected both into
 * tool execution (`ToolContext.prompt`) and into plugin loading (collision resolution in setup).
 *
 * Two call forms:
 *   - `(question, defaultValue?)` — free text; resolves to the typed string (or the default).
 *   - `(field: FormField)` — a single structured field (`select`/`confirm`/`password`/`text`),
 *     letting rich frontends render real controls (buttons, masked input). Frontends that can't
 *     render it fall back to `field.label` as plain text. Resolves to the chosen/typed value.
 *
 * Cancellation is the "we can't proceed — give up" path (distinct from a graceful "decline", which
 * is simply one of the offered `options`). The host rejects the promise with `PromptCancelledError`
 * and abandons the current turn, returning to idle; a caller's surrounding try/catch turns the
 * rejection into a tool error that closes the tool call cleanly.
 *     This reuses `FormField` rather than a parallel type; it is a one-shot request/response and
 *     deliberately does NOT engage the session-bound `form`/`form-response` flow.
 */
export interface PromptFn {
  (question: string, defaultValue?: string): Promise<string>;
  (field: FormField): Promise<string>;
}

export interface ToolContext {
  callId:      string;
  session:     Session;
  signal:      AbortSignal;
  vault:       Vault;
  /** The provider key driving the current turn (`RunConfig.provider`). A tool that spawns further
   *  work should default to this so the child inherits the same model rather than the config default. */
  provider?:   string;
  /** Correlation context for durable workflow, retrieval, policy, and audit records. */
  traceId?:     string;
  rootTraceId?: string;
  parentSpanId?: string;
  workdir?:    string;
  configPath?: string;
  files?:      FileStore;
  /** Prompt the user for input. The host provides a readline or form implementation. */
  prompt:      PromptFn;
  /** Hot-load a plugin by specifier without restarting the process. Returns the loaded plugin. */
  loadPlugin(specifier: string): Promise<MatbotPlugin>;
  /**
   * Hot-unload a plugin by specifier, removing its tools, hooks, and system context contributions.
   * Resolves `true` if a plugin was actually resident and unloaded, `false` if there was nothing
   * to unload. A failed `teardown()` (e.g. timeout) still throws — the plugin was resident in that case.
   */
  unloadPlugin(specifier: string): Promise<boolean>;
}

/** A tool's execution half: streams events as it runs. */
export interface ToolExecutor {
  /**
   * Execute the tool.
   *
   * @param input - The parsed tool-call input (validated against the tool's `inputSchema`).
   * @param ctx - Execution context (session, signal, vault, prompt, plugin loading).
   * @returns An async iterable of {@link ToolEvent}s; a terminal `result` or `error` event closes the call.
   */
  execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent>;
}

/** A tool the model can call: name/description/schema for the LLM plus an executor. */
export interface Tool {
  /** Unique tool name. */
  name:         string;
  /** Description shown to the LLM; for multi-action tools this teaches the per-action contract. */
  description:  string;
  /** JSON schema of the `input` argument (`required: ['action']` at loosest for multi-action tools). */
  inputSchema:  JSONSchema;
  /** The execution implementation. */
  executor:     ToolExecutor;
  /** Plugin that registered the tool. */
  pluginName?:  string;
}

// ── Files ─────────────────────────────────────────────────────────────────────

/** Metadata for one stored file. */
export interface FileMetaData {
  id:          string;
  version:     string;
  name:        string;
  mimeType:    MimeType;
  size:        number;
  createdAt:   ISODate;
  sessionId?:  string;
  messageId?:  string;
  namespace?:  string;
  /** Whether this file may be served at a public URL. Default-deny: absent ⇒ not servable. The
   *  flag rides in the file's own persisted metadata (no separate allow-list), so the same read that
   *  resolves a request also gates it. Producers opt in per put (the workspace tool sets it true). */
  allowed?:    boolean;
}

/** A stored file plus a handle to stream its bytes. */
export interface FileHandle extends FileMetaData {
  /**
   * Stream the file's contents.
   *
   * @param signal - Optional abort signal that terminates the stream.
   * @returns Chunks of the file's bytes.
   */
  stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

/** A change notification for one file: its metadata plus which members changed. */
export type FileEvent = FileMetaData & { changed: Array<keyof FileMetaData> };

/** Criteria narrowing a `FileStore.list` query. */
export interface FileFilter {
  sessionId?:     string;
  mimeType?:      string;
  namespace?:     string;
  createdAfter?:  ISODate;
  createdBefore?: ISODate;
}

export interface FileStore {
  /** Store a file. When `name` is provided, upserts by (name + namespace); otherwise always creates a new entry. */
  put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean }
  ): Promise<FileHandle>;
  get(id: string): Promise<FileHandle | null>;
  /**
   * Fetch a file by (name + namespace).
   *
   * @param name - The file's upsert name.
   * @param namespace - Optional namespace scope.
   * @returns The handle, or `null` when absent.
   */
  getByName(name: string, namespace?: string): Promise<FileHandle | null>;
  /**
   * Delete a stored file.
   *
   * @param id - The file id.
   * @returns Resolves when deleted.
   */
  delete(id: string): Promise<void>;
  /**
   * List files matching a filter.
   *
   * @param filter - Optional narrowing criteria.
   * @returns Matching file handles.
   */
  list(filter?: FileFilter): AsyncIterable<FileHandle>;
  /**
   * Store an ephemeral scratch copy of named content.
   *
   * @param name - A name for the temporary file.
   * @param mimeType - Content MIME type.
   * @param data - Byte chunks to store.
   * @returns The created file handle.
   */
  putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle>;
  /** Observe file changes. Implementations that cannot watch their backing store omit this. */
  watch(signal?: AbortSignal): AsyncIterable<FileEvent>;
}

// ── Frontend ──────────────────────────────────────────────────────────────────

/**
 * Passed to `services.registerFrontend()` by a plugin declaring itself a frontend. A frontend
 * owns its own I/O (an HTTP server, a bot connection, a REPL); matbot only needs to know it
 * exists. This object is the growth point for frontend-level capability advertisement
 * (accepted/produced MIME types, size limits, …) as media support lands.
 */
export interface FrontendInfo {
  name: string;
}

// ── Vault ─────────────────────────────────────────────────────────────────────

/**
 * The primitives a vault backend must implement. Resolution, redaction, and the three
 * low-level store operations the smart `createSecret` policy composes. A backend implements
 * `Vault` (which is `VaultSpec` plus that policy); plugins are handed a `Vault`.
 */
export interface VaultSpec {
  /** Resolve ${NAME} placeholders by looking up the named value; throws MissingSecretError for any miss. */
  resolve(ref: string): Promise<string>;
  scrub(text: string): string;
  /** Store `value` under exactly `name`, overwriting. The literal write; no reference/dedup logic. */
  writeSecret(name: string, value: string): Promise<void>;
  /** Whether a secret is stored under this exact name. */
  hasKey(name: string): boolean;
  /**
   * The name a value is already stored under, if any. Optional: backends that can't (or won't)
   * reverse-index omit it, and `createSecret`'s dedup step is skipped.
   */
  findByValue?(value: string): string | undefined;
}

export interface Vault extends VaultSpec {
  /**
   * Store a secret coming (often) from a user via the LLM, where we cannot tell a real value
   * from a key name they typed by mistake. Returns the key name callers MUST reference — not
   * necessarily the `name` requested:
   *   - `value` is already a known key name → returns `value` (it was a reference, not a secret)
   *   - `value` already stored under another name → returns that name (dedup)
   *   - otherwise → writes under `name` and returns `name`
   */
  createSecret(name: string, value: string): Promise<string>;
}

// ── Health ────────────────────────────────────────────────────────────────────

/** Provider reachability: ok, degraded (with reason), or down. */
export type HealthStatus =
  | { status: 'ok';       latencyMs?: number }
  | { status: 'degraded'; reason: string; latencyMs?: number }
  | { status: 'down';     reason: string };

// ── Registries ────────────────────────────────────────────────────────────────

/** An event on the tool registry watch stream. */
export type ToolRegistryEvent =
  | { type: 'registered'; name: string; pluginName?: string }
  | { type: 'removed';    name: string };

/** Registry of callable tools, managed per-plugin by the loader. */
export interface ToolRegistry {
  /**
   * Register a tool.
   *
   * @param tool - The tool to make available to the model.
   */
  register(tool: Tool): void;
  /**
   * Remove a tool by name.
   *
   * @param name - The tool's unique name.
   */
  remove(name: string): void;
  /**
   * Look up a tool by name.
   *
   * @param name - The tool's unique name.
   * @returns The tool, or `null` when not registered.
   */
  resolve(name: string): Tool | null;
  /**
   * List all registered tools.
   *
   * @returns A read-only snapshot of the registered tools.
   */
  list(): readonly Tool[];
  /**
   * Remove every tool registered by the named plugin (called on plugin unload).
   *
   * @param pluginName - The plugin whose tools to drop.
   */
  removeByPlugin(pluginName: string): void;
  /** Observe tool CRUD as it happens. Read-only — observers cannot veto a registration. One event
   *  per tool (removeByPlugin emits a `removed` per matched tool). The stream ends when `signal` aborts. */
  watch(signal?: AbortSignal): AsyncIterable<ToolRegistryEvent>;
}

/** An event on the plugin registry watch stream (loaded/unloaded). */
export type PluginRegistryEvent =
  | { type: 'loaded';   name: string }
  | { type: 'unloaded'; name: string };

// ── Pipeline events ─────────────────────────────────────────────────────────────

/**
 * The streaming output of a single turn. Every event carries the `traceId` of the turn that
 * produced it — that is the correlation key a frontend uses to route events to the right
 * message/bubble (see `SessionRunner`). A turn ends with exactly one terminal event:
 * `done` (completed), `aborted` (interrupted mid-flight), or `error`. `cancelled` is emitted
 * for a queued submission that was dropped before it ever ran (e.g. by `SessionRunner.abort`),
 * so it carries no session — there is nothing to persist.
 */
export type PipelineEvent =
  | { type: 'text-delta';     delta: string;          traceId: string }
  | { type: 'thinking';       delta: string;          traceId: string }
  | { type: 'tool:start';     callId: string; name: string; input: unknown; traceId: string }
  | { type: 'tool:stdout';    callId: string; chunk: string;  traceId: string }
  | { type: 'tool:stderr';    callId: string; chunk: string;  traceId: string }
  | { type: 'tool:end';       callId: string; result: unknown; isError: boolean; traceId: string }
  | { type: 'file';           handle: FileHandle;     traceId: string }
  | { type: 'usage';          inputTokens: number; outputTokens: number; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number; traceId: string }
  | { type: 'done';           session: Session;       traceId: string }
  | { type: 'aborted';        reason: string; session: Session; traceId: string }
  | { type: 'cancelled';      sessionId: string;      traceId: string }
  // Session-level (not turn-level, hence no traceId): the runner has fully drained its queue and is
  // now idle. Emitted once per busy period, *after* `running` flips false, so a consumer can map it
  // to an authoritative busy→idle transition without racing the internal state flip.
  | { type: 'idle';           sessionId: string }
  // A queued (not-yet-running) submission, carried on the stream so a frontend renders it as part
  // of the live "delta" (everything after the last committed message), never from stored state.
  // `queued` is the number of submissions ahead of it (0 ⇒ about to run). Emitted live on enqueue
  // and replayed (in queue order) to anyone subscribing mid-flight.
  | { type: 'queued';         content: MessageContent[]; queued: number; concatQueue: boolean; traceId: string; rootTraceId: string }
  // Machine-authored content folded onto the running turn's user message (a `screen` hook's
  // `durable` result — e.g. a fired `contextual` trigger), carried live so a frontend draws it
  // immediately. The blocks are already persisted in that user message (origin: 'robo'); this is
  // purely the live-delivery channel, so a live draw matches the reload (which splits the user
  // turn's robo blocks into their own agent-side bubble).
  | { type: 'robo-user';      content: MessageContent[]; traceId: string }
  // Marker blocks appended to the session this turn (e.g. the dispatcher's record of a hook that
  // threw), carried live so a frontend renders them without waiting for a session reload. The blocks
  // are already persisted in the session; this event is purely the live-delivery channel.
  | { type: 'marker';         content: MessageContent[]; traceId: string }
  | { type: 'error';          error: string;          traceId: string }
  | { type: 'system-context'; text: string;           traceId: string };

// ── Session runner ──────────────────────────────────────────────────────────────

/**
 * A view onto a session returned by `SessionRunner.open`. `session` is the authoritative
 * server-side state — committed messages plus an overlay of any queued-but-not-yet-run
 * submissions (each carrying `metadata.pending: true`). `events` is a lazy, per-session live
 * tap: accessing it subscribes to the turn event stream from now (replaying the in-flight
 * turn, if any); never touching it costs nothing.
 */
export interface SessionView {
  session:        Session;
  /** Submissions waiting behind the current turn (does not count the running turn). */
  queued:         number;
  /** Correlation id of the submission this call enqueued — present only when content was supplied. */
  traceId?:       string;
  readonly events: AsyncIterable<PipelineEvent>;
}

/** Observe a session without submitting anything. */
export interface OpenOpts {
  sessionId: string;
  signal:    AbortSignal;
  /** Optional caller-supplied correlation id; one is generated when absent. */
  traceId?:  string;
}

/** Observe a session AND enqueue a submission. The compiler enforces provider/principal here;
 *  a remote frontend deserializing a request body must still validate the wire input itself. */
export interface SubmitOpenOpts extends OpenOpts {
  content:      MessageContent[];
  provider:     string;
  principal:    Principal;
  /** Turn-scoped context supplied by the submitting frontend. It is appended after screen-hook
   *  context for this turn only and is never persisted. Use it for fresh interaction metadata such
   *  as explicit workspace-file attachments that must remain more salient than retrieval context. */
  ephemeral?:   MessageContent[];
  /** When true, this submission may be merged with others drained in the same batch. Default false
   *  (queue mode: one turn per submission). */
  concatQueue?: boolean;
  /** Interactive prompt implementation for this submission's turn. The frontend owns delivery —
   *  it must target the frontend's per-session client connections, not a single request. */
  prompt?:      PromptFn;
}

/**
 * Serialises turns per session. A submission never executes concurrently with another for the
 * same session; the in-memory queue (lost on process restart, by design) absorbs anything that
 * arrives mid-turn. The server is the source of truth: a frontend renders whatever `open()`
 * returns and treats the live `events` stream purely as an optimisation.
 */
export interface SessionRunner {
  open(opts: OpenOpts | SubmitOpenOpts): Promise<SessionView>;
  /** Abort the running turn (if any) and drop all queued submissions, emitting `cancelled` for each. */
  abort(sessionId: string): void;
  /** Abandon the running turn (if any) WITHOUT touching the queue — `pump` advances to the next
   *  queued submission, or idles. The "give up on this turn" path (a prompt cancel); contrast
   *  `abort`, which also clears the queue. A no-op if nothing is running. */
  cancelTurn(sessionId: string): void;
  /** Snapshot of a session's live state: whether a turn is running and how many submissions wait
   *  behind it. `busy` is `running || queued > 0`. */
  status(sessionId: string): { busy: boolean; running: boolean; queued: number };
}
