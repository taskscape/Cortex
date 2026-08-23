/**
 * A stored skill document: named Markdown content with optional tags, tool
 * binding and catalogue advertisement metadata.
 */
export interface SkillDoc {
  /** Stable identifier. */
  id:           string;
  /** Optimistic-concurrency version token. */
  version:      string;
  /** Unique human-readable skill name. */
  name:         string;
  /** Skill body (Markdown). */
  content:      string;
  /** Optional free-form tags. */
  tags?:        string[];
  /** Optional tool the skill is bound to. */
  toolBinding?: string;
  /**
   * Whether this skill is advertised in the always-on skills catalogue in the system prompt (so the
   * model knows it exists and can reach for it). This is skill *advertisement*, not a condition — the
   * firing of skills on conditions is the triggers subsystem's concern, not skills'. The advertised
   * text is `catalogSummary` if set, else the generated `knowledge.summary` (see the contributor).
   */
  catalogue?: boolean;
  /**
   * Optional hand-written one-line catalogue blurb. When `catalogue` is set this overrides the
   * generated `knowledge.summary` as the advertised text. Currently has no editing UI — the generated
   * summary fills the blank — but the field is here so authoring it later needs no schema change.
   */
  catalogSummary?: string;
  /** ISO timestamp of creation. */
  createdAt:    string;
  /** ISO timestamp of last update. */
  updatedAt:    string;
  /**
   * Cached LLM analysis of `content`, valid only while `contentHash` matches the current content.
   * Generating it costs a `singleTurn` call, so it is persisted here and regenerated only when the
   * content changes — `init()` re-indexing on every restart then costs nothing. Derived metadata,
   * not authored: never set by a writer, only by the reindex path.
   */
  knowledge?: {
    contentHash: string;
    entities:    string[];
    tags:        string[];
    summary:     string;
  };
}

/** Emitted by {@link SkillManager.watch} on content CRUD — drives live UI refresh (e.g. the web
 *  frontend's skills sidebar) when a skill is saved or deleted, including by the LLM mid-turn. */
export interface SkillEvent {
  type: 'saved' | 'deleted';
  name: string;
}
