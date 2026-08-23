/**
 * Types for the triggers plugin: data-driven hooks judged by an LLM classifier.
 *
 * @packageDocumentation
 */

/**
 * What a trigger does when one of its conditions matches. A single discriminator: it fixes the
 * surface judged, the hook, AND how the fired tool's output reaches the model — because those are
 * not independent (delivery determines surface). The four are disjoint and exhaustive, two per
 * surface:
 *
 *  `ephemeral`  — judge the USER message (pre-response `screen` hook); run the tool and inject its
 *    output for THIS turn only — never persisted, byte-stable prefix preserved. The one-shot "route
 *    knowledge in for this answer" case (was named `augment`).
 *  `contextual` — judge the USER message (pre-response `screen` hook); run the tool and fold its
 *    output DURABLY onto the user turn (an `origin: 'robo'` block, persisted + visible), so it
 *    updates the conversation rather than informing one answer. Use when a match means "this should
 *    become part of the session", not "correct just this turn". The durable twin of `ephemeral`.
 *  `retract`    — judge the ASSISTANT response (post-commit `followup` hook); the response is treated
 *    as WRONG — pop it into a retraction marker and re-run the user turn with the output injected, so
 *    the bad answer does NOT remain (e.g. "the field is `pgdwell`, not `dwell`": everything built on
 *    the wrong field is void, so regenerate from scratch with the correction).
 *  `followup`   — judge the ASSISTANT response (post-commit `followup` hook); the response STANDS but
 *    warrants a steer or verification — keep it and resubmit the output as a robo turn, so the
 *    response stays in context for the steer to make sense (Inner Voice / Verify Assumptions /
 *    Bicameral — critiques *of* the standing answer, meaningless without it).
 *
 * The author picks the kind because only they know whether a match means "read this for now" /
 * "remember this from now on" / "this is wrong" / "look again".
 */
export type TriggerKind = 'ephemeral' | 'contextual' | 'retract' | 'followup';

/**
 * The conversational surface a `kind` is judged against, and which hook does the judging:
 * `ephemeral`/`contextual` read the user message (pre-response `screen` hook); `retract`/`followup`
 * read the assistant response (post-commit `followup` hook). Derived from `kind` — see
 * {@link surfaceOfKind}.
 */
export type TriggerSurface = 'user' | 'agent';

/**
 * Maps a trigger kind to the surface it judges.
 * @param kind - The trigger kind.
 * @returns `'user'` for ephemeral/contextual kinds, `'agent'` otherwise.
 */
export function surfaceOfKind(kind: TriggerKind): TriggerSurface {
  return kind === 'ephemeral' || kind === 'contextual' ? 'user' : 'agent';
}

/** A trigger condition: a `kind` (what a match does, and the surface it's judged on) plus a `rule`. */
export interface TriggerCondition {
  kind: TriggerKind;
  /** A single LLM-judged rubric, e.g. "MATCH if …; DO NOT MATCH if …", judged against the turn. */
  rule: string;
}

/** One condition the classifier judged matched, for tracing *why* a trigger fired (not just that it
 *  did): `index` addresses it within the owning trigger's `conditions` array, `rule` is the rubric
 *  text at the time of evaluation, and `why` is the classifier's one-line justification (absent if it
 *  didn't supply one). */
export interface FiredCondition {
  index: number;
  kind:  TriggerKind;
  rule:  string;
  why?:  string;
}

/** The tool call a matched trigger makes. `params` is passed verbatim as the tool's input. */
export interface TriggerInvoke {
  tool:    string;
  params?: unknown;
}

/**
 * A stored trigger: a set of LLM-judged conditions (OR) and the tool call made
 * when any of them matches.
 */
export interface Trigger {
  /** Stable identifier. */
  id:         string;
  /** Optimistic-concurrency version token. */
  version:    string;
  /** Conditions judged against the surface — any match fires the trigger. */
  conditions: TriggerCondition[];
  /** The consequence: the tool call to make on a match. */
  invoke:     TriggerInvoke;
  /** Absent ⇒ enabled. A disabled trigger is kept but never evaluated. */
  enabled?:   boolean;
  /** ISO timestamp of creation. */
  createdAt:  string;
  /** ISO timestamp of last update. */
  updatedAt:  string;
}

/** Fields a caller supplies when creating or replacing a trigger; identity/versioning is the store's. */
export interface TriggerSpec {
  conditions: TriggerCondition[];
  invoke:     TriggerInvoke;
  enabled?:   boolean;
}

/**
 * The registry interface other plugins consume (`services.Triggers`) to create triggers without
 * knowing who owns the store or the hooks. CRUD only — evaluation and dispatch are internal to the
 * triggers plugin, which owns the hooks that drive them.
 */
export interface Triggers {
  all(): Trigger[];
  get(id: string): Trigger | undefined;
  /** Triggers whose invocation matches the filter — `tool` (if given) equals `invoke.tool`, `params`
   *  (if given) deep-equals `invoke.params`. The "which trigger(s) fire tool X" lookup. */
  query(filter: { tool?: string; params?: unknown }): Trigger[];
  add(spec: TriggerSpec): Promise<Trigger>;
  update(id: string, patch: Partial<TriggerSpec>): Promise<Trigger | undefined>;
  remove(id: string): Promise<boolean>;
  /** Seed idempotently: no-op (returns the existing trigger) when one with the same `invoke`
   *  (tool + params) is already stored. Identity is the invocation, since triggers carry no name. */
  importIfAbsent(spec: TriggerSpec): Promise<Trigger>;
}
