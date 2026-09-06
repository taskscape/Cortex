/**
 * LLM-backed implementation of {@link Ranker}.
 *
 * One `singleTurn` call per fact. Each call shows the LLM ONE fact and the FULL candidate roster
 * (name + summary + entities + tags) and asks for an integer score 0–100 per skill, plus a one-
 * line reasoning for any non-zero score. The pipeline divides by 100 to get a [0,1] float and
 * applies its own thresholds — this ranker has no concept of "strong" vs "weak", that vocabulary
 * lives in the pipeline.
 *
 * Calls run in parallel across facts via `Promise.all`. A single fact's call failing — bad JSON,
 * model timeout, anything — yields zero scores for that fact (so the pipeline routes it `none`)
 * and is logged to stderr with the fact id. One bad apple doesn't poison the pass.
 *
 * The prompt is deliberately narrow. It does NOT carry the prose-spec's routing heuristics table
 * (User Profile / Implementation Notes / etc.) — those were pipeline knowledge masquerading as
 * judgement. The current pipeline implements the table indirectly through the blocklist and the
 * skill metadata; if we ever want to bias toward specific category names, that goes in
 * pipeline-side scoring adjustments, not in this prompt.
 */

import type { MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { Ranker } from './ranker.js';
import type { RememberedFact, Score, SkillCandidate } from './types.js';

const RANKER_SYSTEM =
  'You are a ranking judge. You will be shown ONE remembered fact and a list of candidate skills. ' +
  'For each candidate, decide how well the fact belongs in that skill — i.e. how naturally a ' +
  'reader looking up the skill would expect to find this fact recorded there.\n' +
  '\n' +
  'Return ONLY a JSON object on the last line of your reply, in this shape:\n' +
  '  {\n' +
  '    "scores": [\n' +
  '      { "skill": "<exact skill name>", "score": <integer 0-100>, "why": "<one short sentence, or empty>" }\n' +
  '    ]\n' +
  '  }\n' +
  '\n' +
  'Rules:\n' +
  '  • One entry per candidate skill in the input list. Use the exact skill names provided.\n' +
  '  • Score is an INTEGER from 0 to 100. 0 = no fit at all; 100 = an obvious, perfect fit.\n' +
  '  • Be conservative on the high end. Most scores should be low. Reserve 80+ for genuine fits.\n' +
  '  • Skills can score independently — a fact may fit two skills well, or fit nothing well.\n' +
  '  • Provide a one-line "why" for any score >= 30. For lower scores "why" may be an empty string.\n' +
  '\n' +
  'Do not include any prose outside the JSON object. Do not wrap it in code fences.';

/**
 * The expected shape of the ranker model's JSON reply: one score row per candidate skill, each
 * with the exact skill name, an integer 0-100, and a one-line rationale.
 */
interface RankerCallResponse {
  scores: { skill: string; score: number; why: string }[];
}

/** Trim each fact to a sensible size before showing it to the model. Facts are short by nature, but
 *  defend against pathological pastes. */
const FACT_MAX_CHARS = 2000;

/**
 * Trim a fact to a sensible size before showing it to the model. Facts are short by nature, but
 * this defends against pathological pastes.
 * @param text The raw fact text.
 * @returns `text` unchanged when it is at most {@link FACT_MAX_CHARS} characters; otherwise the
 *          first and last halves of the budget joined by `...` (middle elision keeps both the
 *          opening and the conclusion of the fact visible).
 * @throws Never.
 */
function clipFact(text: string): string {
  if (text.length <= FACT_MAX_CHARS) return text;
  const half = Math.floor((FACT_MAX_CHARS - 3) / 2);
  return text.slice(0, half) + '...' + text.slice(-half);
}

/**
 * Render the candidate roster as a stable, line-oriented block. Order matches input order.
 * @param candidates The skill metadata views to render.
 * @returns One `- name / summary / entities / tags` entry per candidate; the `entities` and
 *          `tags` lines are omitted for candidates that have none.
 * @throws Never.
 */
function renderCandidates(candidates: readonly SkillCandidate[]): string {
  return candidates
    .map(c => {
      const ents = c.entities.length > 0 ? `\n  entities: ${c.entities.join(', ')}` : '';
      const tags = c.tags.length     > 0 ? `\n  tags: ${c.tags.join(', ')}`         : '';
      return `- ${c.name}\n  summary: ${c.summary}${ents}${tags}`;
    })
    .join('\n');
}

/**
 * Extract the first balanced {…} block from a model reply. Tolerates trailing prose or code-fence
 * noise the prompt told it not to add. The match is greedy, so the substring spans from the first
 * `{` to the last `}` in the reply.
 * @param text The full model reply text.
 * @returns The brace-delimited substring, or `undefined` if the reply contains no braces.
 * @throws Never.
 */
function extractJsonObject(text: string): string | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : undefined;
}

/**
 * Validates and parses a model reply into a {@link RankerCallResponse}. Requires a `scores` array
 * whose rows each carry a string `skill` and a finite numeric `score`; a missing or non-string
 * `why` is coerced to `''`. Any structural deviation rejects the whole reply rather than being
 * partially accepted.
 * @param raw The full model reply text.
 * @returns The parsed response, or `undefined` if no JSON block is present or it fails
 *          structural validation.
 * @throws Never.
 */
function parseRankerResponse(raw: string): RankerCallResponse | undefined {
  const block = extractJsonObject(raw);
  if (block === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(block); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as { scores?: unknown };
  if (!Array.isArray(obj.scores)) return undefined;
  const out: RankerCallResponse['scores'] = [];
  for (const row of obj.scores) {
    if (typeof row !== 'object' || row === null) return undefined;
    const r = row as { skill?: unknown; score?: unknown; why?: unknown };
    if (typeof r.skill !== 'string')                                return undefined;
    if (typeof r.score !== 'number' || !Number.isFinite(r.score))   return undefined;
    const why = typeof r.why === 'string' ? r.why : '';
    out.push({ skill: r.skill, score: r.score, why });
  }
  return { scores: out };
}

/**
 * Constructs an LLM-backed ranker bound to a configured provider name.
 * @param services The matbot machine (used for `singleTurn`).
 * @param provider Provider key the ranking prompts are sent to. Must already exist in
 *                 matbot.yaml; if it does not, calls error out at use time (the standard pattern).
 * @returns A {@link Ranker} that scores each fact against all candidates in
 *          parallel and degrades to zero scores (never throws) on per-fact failure.
 */
export function createLlmRanker(services: MatbotMachine, provider: string): Ranker {
  return {
    /**
     * Scores every fact against every candidate in parallel (one `singleTurn` call per fact).
     * Per-fact failures — transport error, abort, unparseable reply — degrade to all-zero scores
     * for that fact and are logged, never thrown. Model-reported scores are rounded, clamped to
     * [0, 1], and scaled down by 100; entries naming unknown skills are dropped.
     * @param facts The facts to score.
     * @param candidates The candidate skill metadata views.
     * @param signal Cancellation signal forwarded to every provider call.
     * @returns A flat array grouped per fact in input order, candidates in input order within
     *          each fact's group, so every (fact, candidate) pair has an explicit Score; empty
     *          when either input is empty.
     */
    async rank(
      facts:      readonly RememberedFact[],
      candidates: readonly SkillCandidate[],
      signal:     AbortSignal,
    ): Promise<readonly Score[]> {
      if (facts.length === 0 || candidates.length === 0) return [];
      const candidateNames = new Set(candidates.map(c => c.name));
      const candidateBlock = renderCandidates(candidates);

      const perFact = await Promise.all(facts.map(async (fact): Promise<Score[]> => {
        const prompt =
          `Fact (id ${fact.id}):\n${clipFact(fact.fact)}\n\n` +
          `Candidate skills (${candidates.length}):\n${candidateBlock}\n\n` +
          `Score every candidate.`;
        let raw: string;
        try {
          const res = await services.singleTurn({
            provider, signal, system: RANKER_SYSTEM, prompt,
          });
          raw = res.text;
        } catch (e) {
          console.warn(`[dream/llmRanker] singleTurn failed for fact ${fact.id}:`, (e as Error).message ?? e);
          return zeros(fact.id, candidates);
        }

        const parsed = parseRankerResponse(raw);
        if (parsed === undefined) {
          console.warn(`[dream/llmRanker] unparseable response for fact ${fact.id}:`, raw.slice(0, 200));
          return zeros(fact.id, candidates);
        }

        // Build a name→Score map from the response, then materialise one Score per CANDIDATE in
        // input order. Missing entries become explicit 0s (the pipeline expects every pair to
        // have a Score, even if 0). Unknown skill names from the model are dropped silently.
        const byName = new Map<string, { score: number; why: string }>();
        for (const row of parsed.scores) {
          if (!candidateNames.has(row.skill)) continue;
          const clamped = Math.max(0, Math.min(100, Math.round(row.score)));
          byName.set(row.skill, { score: clamped / 100, why: row.why });
        }
        return candidates.map(c => {
          const hit = byName.get(c.name);
          return {
            factId:    fact.id,
            skill:     c.name,
            score:     hit?.score ?? 0,
            reasoning: hit?.why   ?? '',
          };
        });
      }));

      return perFact.flat();
    },
  };
}

/**
 * Score-zero every candidate for a fact whose call failed; keeps the pipeline's grid complete.
 * @param factId Id of the fact whose scoring failed.
 * @param candidates Candidate roster to emit zero rows for.
 * @returns One zero {@link Score} per candidate, in candidate input order, with empty reasoning.
 * @throws Never.
 */
function zeros(factId: string, candidates: readonly SkillCandidate[]): Score[] {
  return candidates.map(c => ({ factId, skill: c.name, score: 0, reasoning: '' }));
}
