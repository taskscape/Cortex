/**
 * The `dream_time` tool: one pass of background memory consolidation, exposed to the model.
 *
 * Zero-input tool. Everything it needs is already in `MatbotMachine` (the skill manager, the
 * stores, the provider list) and `ToolContext` (the active provider, the abort signal). Returns a
 * single result event carrying the fully-assembled {@link DreamRun} record; the same record is
 * also persisted to the `dream_runs` store, so observability survives the conversation that
 * triggered it.
 *
 * The deterministic spine lives in `./runOnce.ts`. This file is the thin tool-shaped wrapper:
 *
 *   • A process-local mutex serialises runs. Two `dream_time` calls in flight at once is a
 *     hazard (they would race on `SkillManager.save` and on per-fact CAS writes), and there is no
 *     legitimate reason to run them in parallel — one consolidation pass at a time is the design.
 *
 *   • The ranker and merger each resolve their own provider independently — `dreamRankerProvider`
 *     / `dreamMergerProvider` (cognition_config) if pinned, else `ctx.provider` (the model driving
 *     the calling turn). Unpinned, a user on a cheap model gets cheap dream-time and a user on a
 *     thinky model gets thinky dream-time — no config needed to get started. Pinning matters most
 *     for the merger: it sees a whole skill's prose plus the fact, so a small-context provider can
 *     truncate and fail on a large skill even when the same provider ranks fine (ranking only ever
 *     sees short summaries, never full skill prose).
 *
 *   • The DreamRun is persisted BEFORE being returned. If the persist fails, the caller still
 *     sees the result; if the caller is aborted before reading the result, the run is still
 *     recorded. Belt and braces, because the cost of a missing run record is "we can't reason
 *     about why dream-time did what it did", which is exactly what this whole exercise was for.
 */

import type { MatbotMachine, Tool, ToolExecutor, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import type { DreamRun } from './types.js';
import { runDreamTimePass } from './service.js';

export function createDreamTimeTool(services: MatbotMachine): Tool {
  const executor: ToolExecutor = {
    async *execute(_input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      if (ctx.provider === undefined) {
        yield {
          type:    'error',
          message: 'dream_time needs a provider in ToolContext (the model driving the current turn). ' +
                   'None was present. This usually means the tool was invoked outside a normal turn.',
        };
        return;
      }
      if (!services.providers.has(ctx.provider)) {
        yield {
          type:    'error',
          message: `dream_time was invoked with provider "${ctx.provider}", but no such provider is ` +
                   `configured. Configured providers: ${[...services.providers.keys()].join(', ') || '(none)'}.`,
        };
        return;
      }

      let run: DreamRun;
      try {
        run = await runDreamTimePass(services, ctx.provider, ctx.signal);
      } catch (e) {
        // runOnce catches its own pipeline errors into the run record. A throw here is something
        // unexpected — a setup-shaped failure (missing SkillManager, malformed settings,
        // metadata-gap assertion) or the mutex chain itself misbehaving. Surface it as a tool
        // error so the caller sees it; nothing was written to the dream_runs store.
        yield { type: 'error', message: `dream_time failed before producing a run record: ${(e as Error).message ?? String(e)}` };
        return;
      }

      yield { type: 'result', value: run };
    },
  };

  return {
    name: 'dream_time',
    description:
      'Run one pass of background memory consolidation. Picks the oldest unassigned fact from ' +
      'the remembered_facts store, scores it against every existing skill (minus a small ' +
      'blocklist), and — if the top skill clears the configured "strong" threshold — splices the ' +
      'fact in, flagging any contradictions inline. Will also batch-merge other unassigned facts ' +
      'whose top skill is the same one, up to a configured cluster cap.\n\n' +
      'Facts that score too low to route anywhere ("none") get one extra look enriched with the ' +
      'surrounding conversation before being retired permanently — a bare fact can under-score in ' +
      'isolation but route cleanly once disambiguated. Facts that route only weakly (a sound fact, ' +
      'just no confident skill home yet) are deferred rather than retired — they become eligible ' +
      'again after a cooldown, since the skill landscape may change later. A merge that fails ' +
      'outright (unparseable response, truncation) quarantines the culprit fact so it stops ' +
      'blocking the queue; that needs a config fix (e.g. a provider swap, see below), not an ' +
      'automatic retry.\n\n' +
      'Takes no parameters. Intended to be invoked via the `background` tool on a schedule, not ' +
      'inline during a conversation. The ranker and merger each resolve their own provider — ' +
      '`dreamRankerProvider` / `dreamMergerProvider` via the cognition_config tool if pinned, else ' +
      "the active provider (the model driving the calling turn).\n\n" +
      'Returns a structured DreamRun record describing what the pass did (the same record is ' +
      'also persisted to the `dream_runs` store, queryable via `dream_runs_action` if exposed).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    executor,
  };
}
