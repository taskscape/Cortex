import type { Store, KnowledgeIndex, KnowledgeEntry, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { createBroadcaster } from '@matatbread/matbot-plugin-api';
import type { SkillDoc, SkillEvent } from './types.js';

/** Derived catalogue metadata for a skill: entities and tags for matching plus a search summary. */
type SkillAnalysis  = { entities: string[]; tags: string[]; summary: string };
/** The cached-analysis shape stored on a {@link SkillDoc}, keyed by a content hash. */
type SkillKnowledge = NonNullable<SkillDoc['knowledge']>;

/**
 * SHA-256 digest of a UTF-8 string, hex-encoded.
 *
 * @param text - Text to hash.
 * @returns Lowercase hex digest (64 characters).
 * @throws Error - If the SubtleCrypto digest operation fails.
 */
async function sha256Hex(text: string): Promise<string> {
  // SubtleCrypto is a web-platform primitive (allowed in shared packages). In a non-secure browser
  // context (plain-HTTP local hosting) `crypto.subtle` is withheld; the web-bundle loader installs a
  // SHA-256 `digest` shim before any module runs, so this stays clean and works in both runtimes.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Cheap, deterministic analysis from the skill's name and tags — the fallback when no analysis
 *  provider is configured (or the LLM call fails). Cheap enough that it is never worth caching.
 *
 *  @param doc - Skill to analyse.
 *  @returns Entities derived from the name, the doc's own tags, and the first 500 characters of
 *    content as the summary.
 *  @throws Never.
 */
function heuristicAnalysis(doc: SkillDoc): SkillAnalysis {
  const nameLower  = doc.name.toLowerCase();
  const nameTokens = nameLower.split(/[\s\-_]+/).filter(t => t.length > 1);
  return {
    entities: [...new Set([doc.name, nameLower, ...nameTokens])],
    tags:     doc.tags ?? [],
    summary:  doc.content.slice(0, 500),
  };
}

const ANALYSIS_SYSTEM =
`You are a knowledge extraction specialist. Given a skill's content, produce three things:

1. **summary**: A concise summary of what the skill covers, MAXIMUM 300 CHARACTERS. This will be searched against, so include key topics and terms someone might use to find this skill. Be tight — every word must earn its place.

2. **entities**: An array of important proper nouns, key terms, and concepts mentioned in the content — people, places, technologies, domain concepts. These are used for matching, so prioritize entities that are central to what the skill is about. Aim for 5-25 entities. Single words or short multi-word phrases. Include aliases where relevant.

3. **tags**: An array of broad category tags that describe the domain or topic area. Think of these as high-level classifiers. Aim for 5-12 tags. Examples: "home", "travel", "technology", "personal", "project", "reference", "automation", "France", "family", "architecture".

Return your answer as valid JSON only — no markdown fences, no explanations. The JSON should have keys "summary" (string), "entities" (array of strings), "tags" (array of strings).`;

const ANALYSIS_TIMEOUT_MS = 6000_000;

/**
 * Analyses a skill's content with an LLM (`singleTurn` on the given provider), expecting JSON with
 * "summary", "entities" and "tags". Degrades to `undefined` — never throws — when the provider is
 * unconfigured, the reply is unparseable or empty, or the call fails or is aborted.
 *
 * @param doc - Skill whose `content` is the analysis prompt.
 * @param services - Runtime machine used for the provider lookup and the `singleTurn` call.
 * @param provider - Provider name; must already be configured.
 * @param signal - Optional abort signal; an aborted call returns `undefined` without warning.
 * @returns The parsed analysis (non-string array entries filtered out), or `undefined` when no
 *   usable analysis was produced.
 * @throws Never.
 */
async function analyseSkill(
  doc:      SkillDoc,
  services: MatbotMachine,
  provider: string,
  signal?:  AbortSignal,
): Promise<SkillAnalysis | undefined> {
  if (!services.providers.has(provider)) return undefined;
  try {
    const res = await services.singleTurn({
      provider,
      system: ANALYSIS_SYSTEM,
      prompt: doc.content,
      ...(signal !== undefined ? { signal } : {}),
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) {
      console.warn(`[skills] analysis for ${doc.name} unparseable:`, res.text);
      return undefined;
    }
    const parsed = JSON.parse(m[0]) as Partial<SkillAnalysis>;
    const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const entities = strings(parsed.entities);
    const tags     = strings(parsed.tags);
    const summary  = typeof parsed.summary === 'string' ? parsed.summary : '';
    if (entities.length === 0 && summary === '') return undefined;
    return { entities, tags, summary };
  } catch (e) {
    if (signal?.aborted) return undefined;   // superseded/timed out — reindex owns the message
    console.warn(`[skills] analysis for ${doc.name} failed:`, e);
    return undefined;
  }
}

/**
 * Assembles the knowledge-index entry mirroring a skill doc and its analysis.
 *
 * @param doc - Source skill; id, version, content and timestamps are copied onto the entry.
 * @param a - Analysis supplying entities, tags and summary.
 * @param contentHash - SHA-256 of `doc.content`, stored for cache invalidation.
 * @returns The entry, keyed by the skill's id with `source: { type: 'skill' }`.
 * @throws Never.
 */
function buildEntry(doc: SkillDoc, a: SkillAnalysis, contentHash: string): KnowledgeEntry {
  return {
    id:        doc.id,
    version:   doc.version,
    entities:  a.entities,
    tags:      a.tags,
    summary:   a.summary,
    content:   doc.content,
    contentHash,
    source:    { type: 'skill', uuid: doc.id },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Build the {@link KnowledgeEntry} for a skill, generating its entities/tags/summary with an LLM
 * (`singleTurn` on `provider`) so the skill is well-described for semantic search. The analysis has
 * a real cost, so it is keyed on a SHA-256 of the content: an unchanged skill reuses the cache on
 * `doc.knowledge` and makes no LLM call. A freshly generated analysis is returned in `cache` for the
 * caller to persist back onto the doc; a heuristic fallback (no provider, or a failed/empty call) is
 *   returned without a `cache`, so it is re-derived next time rather than masking a later real analysis.
 *
 * @param doc - Skill to build the entry for.
 * @param services - Runtime machine used for the analysis LLM call.
 * @param provider - Provider name for the analysis.
 * @param signal - Optional abort signal forwarded to the analysis.
 * @returns The knowledge entry, plus `cache` holding the freshly generated analysis when one was
 *   produced (absent on cache hits and heuristic fallbacks).
 * @throws Error - If the content hashing fails (propagated from the digest).
 */
export async function skillToKnowledgeEntry(
  doc:      SkillDoc,
  services: MatbotMachine,
  provider: string,
  signal?:  AbortSignal,
): Promise<{ entry: KnowledgeEntry; cache?: SkillKnowledge }> {
  const contentHash = await sha256Hex(doc.content);

  if (doc.knowledge?.contentHash === contentHash) {
    return { entry: buildEntry(doc, doc.knowledge, contentHash) };
  }

  const analysed = await analyseSkill(doc, services, provider, signal);
  if (analysed === undefined) {
    return { entry: buildEntry(doc, heuristicAnalysis(doc), contentHash) };
  }
  const cache: SkillKnowledge = { contentHash, ...analysed };
  return { entry: buildEntry(doc, cache, contentHash), cache };
}

/**
 * Compact skill descriptor used for listings (no content).
 */
export interface SkillSummary {
  /** Skill id. */
  id:           string;
  /** Unique skill name. */
  name:         string;
  /** Tool the skill is bound to, if any. */
  toolBinding?: string;
}

/**
 * Owns the live skill set: an in-memory index keyed by lower-cased name, backed by a
 * {@link Store} for persistence and mirrored into the active {@link KnowledgeIndex}. All
 * CRUD goes through here so the cross-runtime base plugin and the node specialization
 * (which feeds it filesystem `.md` imports) share one source of truth. Constructed only
 * with web-platform primitives — no Node APIs — so it runs in the browser too.
 *
 * Skills own content and catalogue advertisement only. The firing of a skill on a condition is the
 * triggers subsystem's concern (@matatbread/matbot-triggers): a trigger invokes `skill_action(use)`
 * like any other tool, so skills carry no trigger data of their own.
 */
export class SkillManager {
  private readonly skills = new Map<string, SkillDoc>();
  // In-flight analysis per skill id, so a detached reindex can be cancelled: superseded by a newer
  // write, the skill being deleted, or teardown. Keeps it from outliving the skill or the process.
  private readonly inflight = new Map<string, AbortController>();
  private readonly store:    Store<SkillDoc>;
  private readonly services: MatbotMachine;
  private readonly events    = createBroadcaster<SkillEvent>();
  // Aborts on teardown (clear()), ending the mounted-swap subscription set up in setupSkills.
  private readonly lifecycle = new AbortController();

  /**
   * Read live so a runtime register('KnowledgeIndex', …) swap is honoured (the member is a
   * capture-safe forwarding proxy, but resolving it per call keeps that guarantee explicit).
   *
   * @returns The currently active knowledge index.
   * @throws Never.
   */
  private get knowledge(): KnowledgeIndex { return this.services.KnowledgeIndex; }

  /**
   * Constructs an empty manager over the given store; call {@link load} (or run
   * {@link setupSkills}) to populate it from persistence.
   *
   * @param store - Persistent store backing the skill set.
   * @param services - Runtime machine providing settings, providers and knowledge.
   * @throws Never.
   */
  constructor(store: Store<SkillDoc>, services: MatbotMachine) {
    this.store    = store;
    this.services = services;
  }

  /** Ends with the manager (teardown). Hand to `services.mounted.consume` so a StorageBackend swap
   *  re-reads the new backend's skills, and the loop stops when the plugin unloads.
   *
   *  @returns The lifecycle abort signal, aborted by {@link clear}.
   *  @throws Never.
   */
  get signal(): AbortSignal { return this.lifecycle.signal; }

  /**
   * The provider used to derive a skill's catalogue summary / knowledge analysis. The user pins one
   * via the `analysisProvider` setting (skills_config); absent (or stale), it falls back to the first
   * configured provider — there is always at least one — so analysis works with zero config. Resolved
   * per reindex, not cached, so a skills_config change takes effect on the next analysis without reload.
   * (analyseSkill degrades to a heuristic if this resolves to nothing, e.g. no providers at all.)
   *
   * @returns The pinned provider name, else the first configured provider, else `''`.
   * @throws Error - If the settings read rejects.
   */
  async resolveAnalysisProvider(): Promise<string> {
    const pinned = await this.services.settings().get<string>('analysisProvider');
    if (pinned !== undefined && this.services.providers.has(pinned)) return pinned;
    return [...this.services.providers.keys()][0] ?? '';
  }

  /** (Re)load persisted skills into memory and index each one. Re-runnable: the initial boot load and
   *  every later StorageBackend swap funnel through here. Reading `this.store` (a swap-following proxy)
   *  always hits the live backend, so a swap re-reads the new backend's skills. Clears first — old
   *  in-memory skills and their in-flight analyses belong to the displaced backend.
   *
   *  @returns A promise that resolves once the store query has run and every doc was committed
   *    (each commit fires a detached reindex).
   *  @throws Error - If the backing store rejects the query.
   */
  async load(): Promise<void> {
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
    this.skills.clear();
    const { items } = await this.store.query({});
    for (const doc of items) this.commit(doc, true);
  }

  /** Snapshot of every in-memory skill document.
   *
   *  @returns The docs in insertion order (load order, then later saves; a deleted-then-recreated
   *    skill moves to the end).
   *  @throws Never.
   */
  all(): SkillDoc[] {
    return [...this.skills.values()];
  }

  /** Compact descriptors of every skill, for listings.
   *
   *  @returns One {@link SkillSummary} per skill, in {@link all} order; `toolBinding` omitted when
   *    unset.
   *  @throws Never.
   */
  list(): SkillSummary[] {
    return this.all().map(s => ({
      id:   s.id,
      name: s.name,
      ...(s.toolBinding !== undefined ? { toolBinding: s.toolBinding } : {}),
    }));
  }

  /**
   * Looks a skill up by name, case-insensitively.
   * @param name - Skill name (any casing).
   * @returns The skill document, or undefined when absent.
   * @throws Never.
   */
  get(name: string): SkillDoc | undefined {
    return this.skills.get(name.toLowerCase());
  }

  /** Observe skill content CRUD (save/delete), including saves made by the LLM mid-turn via
   *  `skill_action` — the source a UI needs to refresh a skills list live.
   *
   *  @param signal - Optional abort signal unsubscribing the consumer.
   *  @returns An async iterable of {@link SkillEvent}s in emission order.
   *  @throws Never.
   */
  watch(signal?: AbortSignal): AsyncIterable<SkillEvent> {
    return this.events.subscribe(signal);
  }

  /** Create a new skill or update an existing one's content by name.
   *
   *  `catalogue` (the system-prompt advertisement flag) is optional: omitted ⇒ left unchanged (the
   *  common content-only save), present ⇒ set. It rides on `save` so the editor persists content,
   *  triggers, and the flag in one action.
   *
   *  @param name - Skill name, matched case-insensitively; an unknown name creates the skill.
   *  @param content - New Markdown body.
   *  @param catalogue - Advertisement flag; omit to leave the current value unchanged.
   *  @returns The saved document (fresh id/version on create, bumped version on update).
   *  @throws Error - If the store write or a CAS-retry read rejects.
   */
  async save(name: string, content: string, catalogue?: boolean): Promise<SkillDoc> {
    const now = new Date().toISOString();
    const key = name.toLowerCase();
    const doc = this.skills.get(key);

    if (doc === undefined) {
      const newDoc: SkillDoc = {
        id:        crypto.randomUUID(),
        version:   Date.now().toString(),
        name,
        content,
        ...(catalogue !== undefined ? { catalogue } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await this.store.set(newDoc.id, newDoc);
      this.commit(newDoc, true);
      this.events.emit({ type: 'saved', name: newDoc.name });
      return newDoc;
    }

    const saved = await this.casMutate(doc, cur => this.bump({ ...cur, content, ...(catalogue !== undefined ? { catalogue } : {}) }), true);
    this.events.emit({ type: 'saved', name: saved.name });
    return saved;
  }

  /** Delete a skill by name. Returns the removed doc, or `undefined`.
   *
   *  Aborts any in-flight analysis for the skill first — no point analysing a skill being removed.
   *
   *  @param name - Skill name, matched case-insensitively.
   *  @returns The removed document, or `undefined` when no skill of that name exists.
   *  @throws Error - If the store delete rejects.
   */
  async delete(name: string): Promise<SkillDoc | undefined> {
    const key = name.toLowerCase();
    const doc = this.skills.get(key);
    if (doc === undefined) return undefined;
    this.inflight.get(doc.id)?.abort();   // no point analysing a skill we're removing
    this.inflight.delete(doc.id);
    await this.store.delete(doc.id, doc.version);
    this.skills.delete(key);
    this.events.emit({ type: 'deleted', name: doc.name });
    return doc;
  }

  /**
   * Import-only create: once a skill exists, the store owns it and the import is a no-op.
   * Used by the node filesystem watcher to seed `.md` files without clobbering edits, and by
   * plugins that ship built-in skills (e.g. cognition) — hence the optional `catalogSummary`.
   * Returns `true` if a new skill was imported.
   *
   * @param name - Skill name to create, matched case-insensitively.
   * @param content - Markdown body for the new skill.
   * @param catalogSummary - Optional hand-written catalogue blurb stored on the doc.
   * @returns `true` when a new skill was imported; `false` when one already existed.
   * @throws Error - If the store write rejects.
   */
  async importIfAbsent(
    name:           string,
    content:        string,
    catalogSummary?: string,
  ): Promise<boolean> {
    const key = name.toLowerCase();
    if (this.skills.has(key)) return false;
    const now = new Date().toISOString();
    const doc: SkillDoc = {
      id:        crypto.randomUUID(),
      version:   Date.now().toString(),
      name,
      content,
      ...(catalogSummary !== undefined ? { catalogSummary } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(doc.id, doc);
    this.commit(doc, true);
    this.events.emit({ type: 'saved', name: doc.name });
    return true;
  }

  /**
   * Drops all in-memory state and aborts in-flight analyses and subscriptions.
   * Ends the manager's lifecycle (teardown only).
   *
   * @returns Nothing; the manager is left empty and its lifecycle signal aborted.
   * @throws Never.
   */
  clear(): void {
    this.lifecycle.abort();                                // end the mounted-swap subscription
    for (const ac of this.inflight.values()) ac.abort();   // cancel detached analyses on teardown
    this.inflight.clear();
    this.skills.clear();
  }

  /** Copies a doc with a fresh version token and `updatedAt` timestamp.
   *
   *  @param doc - Doc to bump; not mutated.
   *  @returns Shallow copy with `version` set to the current epoch milliseconds and `updatedAt`
   *    set to now.
   *  @throws Never.
   */
  private bump(doc: SkillDoc): SkillDoc {
    return { ...doc, version: Date.now().toString(), updatedAt: new Date().toISOString() };
  }

  /** Inserts/updates the in-memory index, optionally firing a detached reindex.
   *
   *  @param doc - Doc to commit; indexed under its lower-cased name.
   *  @param reindex - When true, fires (and forgets) a knowledge reindex for the doc.
   *  @returns Nothing.
   *  @throws Never.
   */
  private commit(doc: SkillDoc, reindex: boolean): void {
    this.skills.set(doc.name.toLowerCase(), doc);
    if (reindex) void this.reindex(doc);
  }

  /**
   * Detached: analysis may make an LLM call, so it must not block the write that triggered it. A
   * freshly generated analysis is cached back onto the doc (a plain store write, NOT another commit,
   * so it doesn't re-trigger reindex) so subsequent restarts re-index from cache for free.
   *
   * Supersedes any in-flight analysis for the same skill; every failure is warned and swallowed.
   *
   * @param doc - Skill to re-index from.
   * @returns A promise that resolves when the pass finishes (or is superseded/aborted); never rejects.
   * @throws Never.
   */
  private async reindex(doc: SkillDoc): Promise<void> {
    this.inflight.get(doc.id)?.abort();   // supersede any in-flight analysis for this skill
    const ac = new AbortController();
    this.inflight.set(doc.id, ac);
    // Analysis should be quick; cap it so a hung provider can't pin the entry forever.
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(ANALYSIS_TIMEOUT_MS)]);
    try {
      const { entry, cache } = await skillToKnowledgeEntry(doc, this.services, await this.resolveAnalysisProvider(), signal);
      if (ac.signal.aborted) return;      // superseded/deleted mid-analysis — a newer pass (or none) wins
      // Timeout (not supersession): the entry fell back to the heuristic. Index it so the skill is
      // still findable, but it stays uncached so a later pass can retry the analysis. (Future: mark
      // timed-out skills for off-line analysis instead.)
      if (signal.aborted) console.warn(`[skills] analysis timed out (${ANALYSIS_TIMEOUT_MS}ms) for ${doc.name}; indexed from heuristic`);
      if (cache !== undefined) await this.cacheKnowledge(doc.id, cache);
      await this.knowledge.index(entry);
    } catch (e) {
      console.warn(`[skills] reindex failed for ${doc.name}:`, e);
    } finally {
      if (this.inflight.get(doc.id) === ac) this.inflight.delete(doc.id);
    }
  }

  /**
   * Persists a freshly generated analysis back onto the stored skill doc via compare-and-swap,
   * retrying indefinitely against concurrent writers. Deleted or already-current docs return
   * immediately; on success the in-memory index is refreshed with the new doc.
   *
   * @param id - Skill id whose doc gains the cached analysis.
   * @param knowledge - Analysis (with the content hash it was derived from) to cache.
   * @returns A promise that resolves when the cache write lands or the doc is found deleted/current.
   * @throws Error - If the store reads/writes reject.
   */
  private async cacheKnowledge(id: string, knowledge: SkillKnowledge): Promise<void> {
    for (;;) {
      const cur = await this.store.get(id);
      if (cur === null) return;                                   // deleted meanwhile
      if (cur.knowledge?.contentHash === knowledge.contentHash) return; // already current
      const next: SkillDoc = { ...cur, version: Date.now().toString(), knowledge };
      const r = await this.store.cas(id, cur.version, next);
      if (r.ok) { this.skills.set(next.name.toLowerCase(), next); return; }
    }
  }

  /**
   * Applies a mutation to a skill doc through compare-and-swap, retrying against concurrent
   * writers: on CAS failure the stored doc is re-read and the mutation re-applied to it; if the
   * doc vanished, the mutated copy is written back wholesale. The result is committed in memory
   * (optionally reindexed) and returned.
   *
   * @param doc - Doc snapshot to mutate from.
   * @param mutate - Function producing the next doc from the current one.
   * @param reindex - Whether the committed result should trigger a knowledge reindex.
   * @returns The committed doc.
   * @throws Error - If the store reads/writes reject.
   */
  private async casMutate(doc: SkillDoc, mutate: (cur: SkillDoc) => SkillDoc, reindex: boolean): Promise<SkillDoc> {
    let cur = doc;
    for (;;) {
      const next = mutate(cur);
      const r = await this.store.cas(cur.id, cur.version, next);
      if (r.ok) { this.commit(next, reindex); return next; }
      const fresh = await this.store.get(cur.id);
      if (fresh === null) {
        await this.store.set(next.id, next);
        this.commit(next, reindex);
        return next;
      }
      cur = fresh;
    }
  }
}
