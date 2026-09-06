import {settingsContributor,validateProviderPins} from '@matatbread/matbot-configuration-contributors';
import {DEFAULT_DREAM_SETTINGS,DREAM_SETTINGS_KEY,validateDreamSettings} from './dream/types.js';
import type {} from '@matatbread/matbot-capabilities-types';
import {uiContribution} from './ui.js';
import {searchRememberedFacts} from './recall.js';
import type {} from '@matatbread/matbot-capabilities-types';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { COGNITION_SKILLS, REMEMBER_CONDITIONS } from './skills.js';
import { defineStore } from '@matatbread/matbot-tool-store';
import { createDreamTimeTool } from './dream/tool.js';
import { createRememberFactTool } from './remember/tool.js';
import { createAskInnerVoiceTool, createCognitionConfigTool, INNER_VOICE_PROVIDER_KEY } from './inner-voice/tool.js';
// These type imports also bring the `SkillManager` / `Triggers` augmentations of MatbotMachine into
// cognition's compilation, since cognition is a consumer of both capabilities (discovered, not owned).
import type { SkillManager } from '@matatbread/matbot-skills';
import type { Triggers } from '@matatbread/matbot-triggers';

/**
 * Seeds cognition's built-in skills and trigger wiring, all create-if-absent so an
 * install that already holds them keeps its own copy. For each {@link COGNITION_SKILLS}
 * entry it imports the skill content and — when the Triggers service is present and
 * the skill declares conditions — imports one trigger invoking
 * `skill_action({ action: 'use' })` for that skill. It then ensures exactly one
 * trigger fires the `remember_fact` tool with the canonical conditions: legacy
 * triggers still loading the retired "Remember this" skill are repointed in place
 * (converting old installs), otherwise the canonical trigger is imported if absent.
 * A no-op when no SkillManager is registered; Triggers is used opportunistically.
 * @param services - The matbot machine; {@link SkillManager} and {@link Triggers} are read off the registry and both are optional.
 * @throws If skill or trigger persistence fails.
 */
async function seedCognition(services: MatbotMachine): Promise<void> {
  const skills: SkillManager | undefined = services.SkillManager;
  if (!skills) return;
  // Triggers are seeded separately, now that they are no longer embedded in the skill. A built-in
  // skill's `triggers` become one Trigger whose invoke fires that skill via `skill_action(use)` (see
  // the `use`-not-`load` note below). Both imports are create-if-absent, so an install that already
  // holds them keeps its own copy.
  const triggers: Triggers | undefined = services.Triggers;
  for (const skill of COGNITION_SKILLS) {
    await skills.importIfAbsent(skill.name, skill.content);
    if (triggers && skill.triggers.length > 0) {
      await triggers.importIfAbsent({
        conditions: skill.triggers.map(t => ({ kind: t.kind, rule: t.trigger })),
        // `use`, not `load`: a fired trigger should make the skill take effect (its content as a
        // directive), not just surface the raw text.
        invoke:     { tool: 'skill_action', params: { action: 'use', name: skill.name } },
      });
    }
  }

  // "Remember this" is compiled into the `remember_fact` direct tool. Ensure exactly one trigger
  // invokes it with the canonical conditions — repointing any legacy trigger that still loads the
  // retired "Remember this" skill (so an install seeded under the old model converts in place rather
  // than ending up with both a skill-load trigger and a remember_fact trigger firing in parallel).
  if (triggers) {
    const legacy = triggers.query({ tool: 'skill_action', params: { action: 'load', name: 'Remember this' } });
    if (legacy.length > 0) {
      for (const t of legacy) await triggers.update(t.id, { invoke: { tool: 'remember_fact' }, conditions: REMEMBER_CONDITIONS });
    } else {
      await triggers.importIfAbsent({ conditions: REMEMBER_CONDITIONS, invoke: { tool: 'remember_fact' } });
    }
  }
}

/**
 * Idempotently defines the `dream_runs` store (via {@link defineStore}), which backs
 * the dream_time tool's observability: one structured record per consolidation pass
 * (outcome, primary fact, routing decision, merges, contradictions, timings). A
 * re-seed on restart preserves existing run history.
 * @param services - The matbot machine the store is defined against.
 * @throws If defining the store fails.
 */
async function seedDreamRunsStore(services: MatbotMachine): Promise<void> {
  // The `dream_runs` store backs the `dream_time` tool's observability story: every pass writes a
  // structured record here (outcome, primary fact, routed-to skill, contradictions, timings) so
  // "what did dream-time do, and why" is queryable rather than having to be parsed out of stdout.
  // Idempotent — a re-seed on restart preserves the existing run history.
  await defineStore(services, {
    namespace:   'dream_runs',
    description:
      'Records one row per `dream_time` consolidation pass: which fact was processed, which ' +
      'skill it was routed into (if any), what was merged, any contradictions flagged, and ' +
      'per-call telemetry. Queryable for "how is dream-time behaving over time" reporting.',
    shape:
      `interface DreamRun {
        id:                  string;
        version:             string;
        startedAt:           string;
        endedAt:             string;
        outcome:             'no-facts' | 'no-match' | 'merged' | 'error';
        primaryFact?:        { id: string; preview: string };
        routedTo?:           { skill: string; decision: 'strong'|'weak'|'none'; score: number; reasoning: string };
        mergedFactIds:       string[];
        contradictions:      { skill: string; location: string; note: string }[];
        unassignedRemaining: number;
        judgementCalls:      { role: 'rank'|'merge'; inputSize: number; ms: number }[];
        enriched?:           boolean;
        error?:              string;
      }`,
  });
}

/**
 * Cognitive services. It seeds the Inner voice skill and dream_time tool into the active skills service,
 * registers the remember_fact and dream_time tools, and wires remember_fact's trigger; it is the
 * intended home for further cognitive skills and tools.
 *
 * It does not set skills up itself — it is a *consumer* of the skills capability, not a
 * specialization of it — so it discovers the live {@link SkillManager} off the registry rather than
 * taking a runtime dependency on a specific provider. Any skills provider satisfies it
 * (@matatbread/matbot-skills, …-node, a future backend).
 *
 * Absence of a skills service is handled gracefully rather than fatally: seeding needs the live
 * manager, which a registry consumer can't guarantee is present at its own setup (config/load order
 * is not ours to dictate). So it subscribes to the SkillManager mount via `services.mounted` with
 * `replay: true` — `seedCognition` runs once now if a manager is already present, and again on each
 * (re)mount if a skills provider is loaded later. Seeding is idempotent (`importIfAbsent`), so a
 * remount re-seed is a no-op. This makes seeding order-independent and self-healing with no resident
 * per-turn hook and no reload.
 *
 * The inner-voice provider is likewise not required: the Inner voice skill calls cognition's own
 * `ask_inner_voice` tool, which falls back to the current turn's model when none is pinned via
 * `cognition_config` (a same-lineage self-critique — degraded, but it still fires).
 */
/**
 * The inner-voice paragraph of the installation message, reflecting whether a
 * provider is pinned and, if so, whether it responds to a test prompt (one
 * `singleTurn` call with a 15-second timeout; failures are caught and reported in
 * the text rather than propagated). The probe runs only here (install/reload),
 * never on the hot path.
 * @param services - The machine captured at setup, or undefined before setup has run (yields the short unpinned fallback sentence).
 * @returns A sentence describing the pin state and, when pinned, the probe outcome.
 * @throws If reading the pinned provider from settings fails.
 */
async function innerVoiceStatus(services: MatbotMachine | undefined): Promise<string> {
  if (!services) return 'It uses the current turn\'s model unless you pin a different one with the cognition_config tool.';
  const pinned    = await services.settings().get<string>(INNER_VOICE_PROVIDER_KEY);
  const available = [...services.providers.keys()];
  if (pinned === undefined) {
    return 'No inner-voice provider is pinned, so it uses the current turn\'s model — functional, but the ' +
      'value of a second voice is a *different* training lineage. Pin one with the cognition_config tool ' +
      `(action "set"). Available providers: ${available.join(', ') || '(none)'}.`;
  }
  let ok = false, error = '';
  try {
    await services.singleTurn({ provider: pinned, prompt: 'Reply with "ok".', signal: AbortSignal.timeout(15000) });
    ok = true;
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  return `The inner voice is pinned to "${pinned}" (cognition_config), which ` +
    (ok ? 'responded to a test prompt.' : `did NOT respond: ${error}. It falls back to the turn's own model until fixed.`);
}

/**
 * Builds the cognition plugin spec: registers the inner-voice and remember
 * tools, seeds the built-in skills, arms the dream-time scheduler, and exposes
 * a health-check installation message.
 * @returns A fresh plugin specification (call once per plugin instance).
 * @throws Never - All substantive work happens in the returned spec's `setup`, not in this factory.
 */
export function createCognitionPlugin(): MatbotPluginSpec {
  let captured: MatbotMachine | undefined;   // captured in setup() so installationMessage() can probe
  const lifecycle = new AbortController();    // ends the SkillManager mount subscription on teardown

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Cognitive services: seeds the Inner voice skill and dream_time tool, the remember_fact tool (with its trigger), and the dream_time tool. Home for further cognitive skills and tools.',
    },

    /**
     * Builds the install-time health report: what cognition seeds, the inner-voice
     * provider status (via {@link innerVoiceStatus}, including a live probe of any
     * pinned provider), how remember_fact and its trigger behave silently, and how
     * dream_time consolidates facts into skills. Runs only at install/reload.
     * @returns The multi-paragraph installation message.
     * @throws If reading the inner-voice pin from settings fails.
     */
    async installationMessage() {
      return `Cognition is active. It seeds the Inner voice skill and dream_time tool into the skills
service — if no skills service is configured yet, they are seeded automatically once one is — and
registers the remember_fact and dream_time tools.

The **Inner voice skill** consults a second model via the \`ask_inner_voice\` tool. ${await innerVoiceStatus(captured)}

The **\`remember_fact\` tool** captures user-provided facts, personal details, and preferences worth
remembering across conversations. It is fired by a trigger (the conditions of the former "Remember this"
skill) and runs as a silent side-effect: it reads the latest user message and its provenance from
context, makes one LLM call to extract and normalise the fact(s), and writes each to the
remembered_facts store — no extra conversation turns. The model is not woken. (Needs the triggers
plugin for its trigger; the trigger's conditions are judged by the triggers classifier — pin which
provider via the triggers_config tool, else it uses the turn's own provider.)

The **\`dream_time\` tool** runs one pass of background memory consolidation. It is a deterministic
TypeScript pipeline: it picks the oldest unassigned fact from the remembered_facts store, scores it against
every existing skill via two narrow LLM judgement calls (rank and merge — each pinned independently via
cognition_config, else falling back to the active turn's provider), and — if a skill clears the configured
threshold — splices the fact in and marks it processed (a \`dreamSkill\` field). A fact that scores too low
("none") gets one extra look enriched with conversation context before being retired; a fact that scores
only weakly is deferred rather than retired, since a future pass against a changed skill set may answer
differently; a merge that fails outright quarantines the fact rather than retrying indefinitely. Each pass
writes a structured \`DreamRun\` record to the \`dream_runs\` store. Intended to be invoked via the
\`background\` tool on a schedule, never inline. One pass at a time is enforced by a process-local mutex.

It also seeds a remembered_facts store and its \`remembered_facts_action\` tool, written to by remember_fact.
The store is idempotent: a re-seed on restart keeps the existing data.
`;
    },

    /**
     * Registers the web-UI, configuration-contributor, and retrieval contributions;
     * defines the remembered_facts and dream_runs stores (both idempotent on restart);
     * registers the four cognition tools unconditionally (they resolve their
     * dependencies per call); and subscribes — with replay — to the SkillManager
     * mount so seeding runs now if a skills provider is present and again on each
     * remount, until teardown aborts the lifecycle signal.
     * @param services - The machine this plugin instance is attached to; captured for the installation message.
     * @throws If defining either store fails.
     */
    async setup(services) {
    services.contributions?.register('webui','memory',uiContribution);
    const pins=['innerVoiceProvider','dreamRankerProvider','dreamMergerProvider'];
    services.contributions?.register('configuration','cognition',settingsContributor(services.settings(),{title:'Cognition',keys:[...pins,DREAM_SETTINGS_KEY],schema:{type:'object',properties:{innerVoiceProvider:{type:['string','null']},dreamRankerProvider:{type:['string','null']},dreamMergerProvider:{type:['string','null']},[DREAM_SETTINGS_KEY]:{type:'object'}}},validate(value){validateProviderPins(value,pins,services.providers);const dream=value[DREAM_SETTINGS_KEY];if(dream!==undefined&&(!dream||typeof dream!=='object'||Array.isArray(dream)))throw new Error('Dream settings must be an object');validateDreamSettings({...DEFAULT_DREAM_SETTINGS,...(dream as object??{})});}}));
      captured = services;
      services.contributions?.register('retrieval','remembered_facts',{title:'Remembered facts',scope:'workspace',async search(query){query.signal.throwIfAborted();const matches=await searchRememberedFacts(services,[{term:query.query}]);query.signal.throwIfAborted();return matches.slice(0,query.limit).map(({fact})=>({id:fact.id,sourceId:'remembered_facts',workspaceId:query.workspaceId,content:'Remembered facts:\n- '+fact.fact,citation:{sessionId:fact.sessionId,messageId:fact.messageId}}));}});
      // Seed the remembered_facts store and its `remembered_facts_action` tool (written to by the
      // remember_fact tool). Idempotent — a re-seed on restart keeps the existing store's data.
      await defineStore(services, {
        namespace:   'remembered_facts',
        description:
          'Stores user-provided facts, personal details, preferences, and other information the ' +
          'user wants remembered across conversations. Each fact is captured with provenance ' +
          'showing which session and message it came from.',
        shape:
          `interface RememberedFact {
            fact: string;
            sessionId: string;
            messageId: string;
            createdAt: string;
            dreamSkill?: string;
            ignoreUntil?: string;
          }`,
      });

      // Seed the dream_runs store (used by the dream_time tool) alongside remembered_facts.
      // Both stores are seeded unconditionally — they don't require a SkillManager to exist.
      await seedDreamRunsStore(services);

      // Register the dream_time tool. It doesn't need SkillManager at REGISTRATION time (it looks
      // it up per-call), so we register it unconditionally too — the tool surfaces in catalogues
      // immediately, and if a SkillManager isn't present at invocation it errors cleanly.
      services.tools.register(createDreamTimeTool(services));

      // remember_fact: the compiled "Remember this" tool. Like dream_time, it resolves what it needs
      // per-call, so register unconditionally; its trigger is wired in seedCognition.
      services.tools.register(createRememberFactTool(services));

      // ask_inner_voice (the Inner voice skill's critic call) and cognition_config (which provider it
      // uses). Both resolve per-call, so register unconditionally — the Inner voice skill calls
      // ask_inner_voice rather than the generic single_turn, so cognition owns its own provider alias.
      services.tools.register(createAskInnerVoiceTool(services));
      services.tools.register(createCognitionConfigTool(services));

      // Seed once the SkillManager is present — now if a skills provider is already loaded (replay),
      // else on the first mount when one is. Re-seed on each remount is a no-op (importIfAbsent). The
      // Triggers service is seeded opportunistically in the same pass when present. Order-independent
      // and self-healing, with no resident hook.
      services.mounted.consume(
        { key: 'SkillManager', replay: true, signal: lifecycle.signal },
        m => seedCognition(m),
      );
    },

    /**
     * Aborts the lifecycle signal, ending the SkillManager mount subscription armed
     * in `setup` so no seeding fires after teardown.
     * @throws Never.
     */
    async teardown() {
      lifecycle.abort();
    },
  };
}

/** The singleton cognition plugin instance. */
export const plugin: MatbotPluginSpec = createCognitionPlugin();
