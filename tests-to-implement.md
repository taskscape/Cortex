# Automated End-to-End Coverage And Tests To Implement

## Scope

This review compares the user-visible behavior documented in `userguide.md`
with the automated tests currently in the repository.

The following test layers were inspected:

- `tests/webui/matbot-webui.spec.mjs`: 59 Playwright test definitions against
  the real static WebUI and the fake Matbot server in `tests/webui/harness.mjs`.
- `tests/*.test.mjs` and their `*-runtime.mjs` helpers: backend and runtime
  integration tests, generally using real plugin code with temporary stores and
  fake providers.
- `tests/workspace-switch.test.mjs`: a live HTTP-server handoff test for the
  workspace restart boundary.
- `tests/readme-qa/`: answer-quality tests against a running Cortex. These test
  retrieval and answer content from `README.md`; they do not exercise most
  `userguide.md` UI journeys.
- `scripts/*.ps1`: the install, start, health, stop, and service scripts
  described by the guide.

In this document:

- **Browser E2E** means a user journey driven through the WebUI by Playwright.
- **Runtime integration** means production plugin/runtime code is exercised,
  but not through the browser.
- **Not covered E2E** means the documented user journey is not driven from its
  public user entry point through to its observable result.

The main Playwright suite is deterministic and token-free, but its server is a
test double. It does not prove that PowerShell launch scripts, Docker services,
real provider connections, production stores, or a real Matbot restart work
together.

## Implementation Outcome

The recommended backlog now has an automated slice for every scenario ID.
The implementation added 17 Playwright journeys, expanded three runtime suites,
added a background-scheduling runtime suite, added an opt-in Windows lifecycle
test, and added three user-guide contract checks. It also strengthened the
harness with workspace-scoped state, deterministic failures, delayed responses,
abort/queue behavior, and a complete in-memory reset.

The table below records exactly what is automated and which broader variants
remain. **Covered** means the scenario's core risk is asserted. **Representative
coverage** means the highest-risk transition is automated but the scenario's
full input matrix is intentionally left as follow-up. **Safety-gated** means the
test exists but does not run unless its disposable-host opt-ins are set.

| ID | Status | Implemented automation | Remaining variants |
| --- | --- | --- | --- |
| E2E-001 | Covered | Workspace-switch failure is delayed; composer, Send, New, upload, and workspace controls lock; failure restores A and its controls. Existing runtime tests cover successful identity handoff and port release. | A dedicated late-event injection during the successful browser switch would make the cross-runtime assertion more explicit. |
| E2E-002 | Covered | One browser journey proves isolation and restoration for sessions, same-named files, same-named skills, memories, RAG contexts/paths, and activated plugins. The harness scopes and deletes each resource by workspace. | Provider preference/options are still globally browser-persisted and need a product decision before asserting workspace scope. |
| E2E-003 | Covered | A queued prompt is rendered, Stop cancels the slow turn, the queue is removed and never stored, late completion is ignored, and a clean next turn succeeds. | Explicit simulation of an abort-endpoint error remains useful. |
| E2E-004 | Covered | Editing governed-SQL inputs invalidates the approval and rapid Execute is idempotent. Runtime tests reject tampered plans and reused approvals and keep hostile filter values parameterized. | A delayed older plan response can be added as a separate UI race test. |
| E2E-005 | Representative coverage | Runtime governance now records a post-approval external-action failure as a failed completion, one failed action, and an ordered `tool_execution_failed` ledger event. Existing tests cover gate proposals and decisions. | One browser journey resolving every gate type sequentially and then comparing failed/successful external actions. |
| E2E-006 | Representative coverage | RAG Save failure preserves edits, a stale status response from A cannot overwrite B, and the isolation matrix proves per-workspace RAG restoration. | Path normalization/inaccessibility, empty corpus, failed file, and overlapping reindex-job ownership. |
| E2E-007 | Covered | Failed activation is atomic and retry succeeds; core plugins expose no remove control; missing sessions shows the persistence warning; activated plugin state is workspace-isolated. | Failed optional-plugin removal and restart-required copy. |
| E2E-008 | Safety-gated | `tests/lifecycle.test.mjs` runs documented Run, health check, Stop, port release, and idempotent Stop on Windows only with both isolation opt-ins. | Secrets setup, restart persistence, and Docker cleanup must be run on a prepared disposable host. |
| E2E-009 | Representative coverage | Create and rename `503` responses retain the old UI and create no phantom workspace. Existing coverage handles cancellation and confirmed deletion. | Exhaustive local name classes, collisions, and active-workspace deletion fallback. |
| E2E-010 | Representative coverage | A two-file batch proves one success survives one failure, only successful attachments appear, and retry does not duplicate the successful upload. Existing tests cover reserved names and cross-workspace file isolation. | Boundary-size, empty, duplicate, MIME, failed open, and failed delete cases. |
| E2E-011 | Covered | The memory browser displays a CAS conflict, retains the user's edit, reloads the current server record, and successfully retries. | Delete conflict/cancellation, CRUD `503`, and switching while the separate memory window is open. |
| E2E-012 | Representative coverage | With TinyMDE unavailable and its CDN blocked, metadata remains visible, the documented offline error appears, and Save is disabled. | Load/save failure retry and unsaved-change handling during workspace switch. |
| E2E-013 | Representative coverage | Empty explicit expert selection is rejected in the UI and no panel request is sent. Existing tests cover Review, Debate, synthesized and unsynthesized panels. | Per-expert/synthesis failure and aborting multiple outstanding experts. |
| E2E-014 | Representative coverage | A failed source-health refresh retains the usable source list/detail and exposes the partial failure. Existing stale-selection guards and runtime denied-source assertions remain active. | Empty/list failure, changing health, and denied-content browser assertions. |
| E2E-015 | Representative coverage | Runtime cases now reject `CROSS JOIN`, multiple statements, data-modifying CTEs, unknown metric/filter, tampered SQL, and reused approval; harmless comments pass and a zero limit clamps safely. | Disallowed operations, missing connection, expiration, negative/huge limit, and focused form-validation UI cases. |
| E2E-016 | Covered by existing suites | Existing browser/runtime tests cover compilation, immutable versions, typed inputs, three start modes, filters, shadow decisions, and policy enforcement. | Malformed compiler-input matrix and all shadow-label aggregate combinations. |
| E2E-017 | Representative coverage | A failed required scorer and below-threshold pass rate are visibly release-blocking. Existing runtime tests cover redaction, safe replay, verified outcomes, cost, and ROI arithmetic. | UI zero/negative ROI, replay failure, stale selections, and report/download redaction. |
| E2E-018 | Representative coverage | Context Graph now displays a clear empty state and recovers from a transient retrieval failure on retry. Existing runtime tests enforce denied-source filtering. | Multiple terms/source constraint, malformed partial data, and overlapping-request race. |
| E2E-019 | Representative coverage | Required question/target validation sends no request; creation failure preserves the form and retry succeeds. Existing runtime/browser checks cover persisted structured review content. | All target types, unknown experts, detail-load/stale-selection failure, and workspace isolation. |
| E2E-020 | Representative coverage | A real background-plugin runtime test validates durations, creates/lists/suspends/resumes/cancels schedules, rejects unsafe wildcard cancellation, persists state, and isolates same-purpose schedules by workspace. | Workflow invocation, allowed-tool/approval enforcement, missed runs, retry/backoff, and a browser capability-contract assertion. |
| E2E-021 | Representative coverage | Missing sessions produces the documented non-persistence banner. Existing tests cover ordinary conversation creation, reopening-related transcript persistence, tool errors, and transient feature recovery. | Provider disappearance/failure, session-list status distinctions, disconnect, and prompt-preserving retry. |
| E2E-022 | Representative coverage | Desktop and mobile projects verify font clamping at both bounds and keyboard arrow wraparound for architecture tabs; existing mobile tests cover sidebar, panels, and workflow ledger. | Keyboard focus/Escape and the full set of mobile feature journeys/overflow checks. |
| E2E-023 | Covered | Fast Node tests resolve relative links/anchors, compare scripts/port/labels with shipped files, and pin limitations plus destructive warnings. | None for the stated contract. |

## Baseline Coverage By User-Guide Feature

The assessment below records the coverage before this implementation and
explains why the backlog was created. Use the implementation table above for
the current state.

| User-guide area | Existing automated coverage | Assessment |
| --- | --- | --- |
| Install, configure secrets, start, health check, and stop | No test invokes `setup-secrets.ps1`, `run.ps1`, `health-check.ps1`, and `stop-local-agent.ps1` as a complete lifecycle. The workspace-switch runtime test does start real HTTP servers, but not through the documented launcher. | **Not covered E2E.** The most operationally important first-run journey is manual. |
| WebUI shell and layout | `loads the shell, providers, conversations, files, plugins, and skills`; `persists provider and font preferences across reloads`; mobile sidebar and architecture tests. | **Partially covered.** Shell load, font increase, preference persistence, and selected mobile paths are covered. Font decrease/bounds, missing-sessions banner, keyboard focus, and most mobile feature journeys are not. |
| Conversations | `creates a conversation, sends a message, renders streaming output, tools, and usage`; `an immediate message after New waits for the new session`; session rename/hide; expert transcript reload. | **Strong happy-path coverage.** Reopening a normal existing conversation, transport failures, late stream events, and queued-turn behavior are missing. |
| Model selection | Provider options are loaded and the selected provider persists over reload. Direct cognition tool tests pass provider context. | **Partially covered.** No browser test proves that changing the model changes the provider used for the next normal chat turn, or that provider choices differ correctly after a workspace switch. |
| Send and stop | Streaming, tool display, usage, elapsed time, interactive prompts, and the stop control are covered. | **Partially covered.** The test checks that Stop leaves busy mode, but does not prove that the request was aborted, late events were ignored, partial output was handled correctly, or queued turns were dropped. |
| Workspace create, rename, delete, and switch | `workspace selector lists, creates, renames, and switches workspaces` covers create, rename, switch, delete cancellation, and confirmed deletion. `workspace-switch.test.mjs` covers runtime identity and releasing a port with a stuck request or event stream. | **Good coverage with important gaps.** Invalid/duplicate names, deleting the active workspace, switch failure, restart progress, and blocking sends during a switch are not covered. |
| Workspace isolation | Browser tests prove memory isolation. Runtime tests cover memory/store isolation and workspace-scoped identities. | **Partially covered.** The guide also promises isolation for sessions, files, skills, providers/plugins, stores, and RAG configuration. Those resources are not tested together through workspace switching. |
| Workspace knowledge settings | `workspace RAG configuration panel saves paths and shows indexing progress` covers dirty state, Close-without-save, in-place Save, progress, current file, completion, and Save becoming disabled again. | **Good happy-path coverage.** Invalid paths, inaccessible paths, save/status failures, duplicate paths, a failed ingestion, and switching workspaces while indexing are missing. |
| Workspace files | Upload/delete, opening a filename containing reserved URL characters, attachment-chip removal, attaching an existing file, clearing attachments after send, and preferring an explicit attachment over a same-named RAG path are covered. File-broker runtime tests cover root policy and overwrite backups. | **Good happy-path coverage.** Multiple-file batches, partial upload failure, duplicate names, failed open/delete, large or empty files, and cross-workspace file isolation are missing. |
| Workspace RAG retrieval | Browser tests cover automatic conversational grounding and combined `contextual_search`. Runtime tests cover Markdown ingestion, persistence, sanitizing NUL bytes, directory and single-file paths, source registration, citations, context selection, and stale/degraded warnings. | **Strong integration coverage.** Browser error states, no-hit behavior, non-Markdown exclusion, deleted/renamed source cleanup, concurrent reindexing, and workspace-switch races remain untested. |
| Memory capture and recall | Browser tests cover capture, cross-conversation recall, workspace isolation, contextual search, and memory-browser CRUD. Runtime tests cover restart persistence, irrelevant-query suppression, inflections, distinctive identifiers, long facts, deduplication, provenance, no-model-call recall, dream time, CAS conflicts, and real-store isolation. | **Strongest-covered area.** The WebUI does not test conflict presentation, delete cancellation, failed CRUD requests, or switching workspaces with the memory browser open. |
| Skills | Browser tests cover opening a skill, content editor setup, metadata, triggers, saving, and delete cancellation/confirmation. | **Partially covered.** The explicitly documented offline-editor error is not tested. Save/load failures, unsaved-change handling, invalid trigger data, and workspace isolation are missing. |
| Expert Panel | Browser tests cover all experts with synthesis, selected experts without synthesis, Review and Debate modes, transcript persistence, and expert selection. Runtime tests cover isolated expert knowledge and unknown expert errors. | **Good happy-path coverage.** Parallel mode is not explicitly exercised; zero selected experts, one expert failing, synthesis failing, stopping a panel run, and workspace-specific expert availability are missing. |
| Sources and source health | Browser tests show source list/detail, citations, stale/unhealthy states, approval context, and sources rendering before a slow health report. Runtime tests cover stable IDs, versions, freshness, citations, access/health events, and health findings. | **Partially covered.** Refresh, empty/error states, denied-source presentation, stale selection responses, and changing health between refreshes are missing. |
| Governed SQL | Browser tests cover plan, row-cap warning, approval, execution, citation, and retry after transient failures at all three stages. Runtime tests reject a write, a missing limit, an unknown dimension, and a wrong approval token. | **Good coverage with security gaps.** The documented unsafe-join rejection is not tested. Approval invalidation after editing inputs, duplicate execution, stale planning responses, parameter escaping, and workspace isolation are missing. |
| Workflow Operations Center | Browser tests cover overview metrics, compilation, library search, approval-gated start, ledger inspection, approval/rejection, rapid double rejection, shadow acceptance, readiness metrics, stale selection protection, partial service failure/recovery, and mobile summary/ledger. Runtime tests cover typed inputs, immutable versions, dry-run/shadow write blocking, multiple gate types, policy enforcement, ordered events, and executed-action recording. | **Strong coverage.** Missing browser paths include invalid compilation/input, dry-run and shadow starts from the library, Reject/Mixed shadow labels, approval of multiple independent gates, action failure after approval, immutable-version behavior after recompilation, and filters in the Run Ledger. |
| Evaluation, observability, and ROI | One browser test covers trace selection, waterfall content, safe replay, a passing regression suite, and sponsor evidence. Runtime integration covers redaction, replay, deterministic/model scorers, cost, workflow outcome linkage, and ROI arithmetic. | **Partially covered.** Failed deployment gates, replay errors, redacted-secret display, unverified outcomes being excluded, zero/negative ROI states, stale selection, and refresh failure are missing in the UI. |
| Context Graph | Browser tests cover retrieval, entity selection, relationship evidence/citations, refresh, and protection from stale list state. Runtime tests cover extraction, deduplication, stale/degraded warnings, denied-source filtering, source versions, access events, and projection operations. | **Partially covered.** Source-constrained retrieval, multiple terms, no results, request failure/retry, denied data remaining absent in the UI, and selection races between two retrieval requests are missing. |
| Durable expert reviews | Browser tests create and inspect a workflow-linked review and show experts, checklist, and risk register. Runtime tests cover review persistence and structured synthesis. | **Partially covered.** Required-field validation, empty/unknown experts, non-workflow target types, creation failure, stale selection, reload persistence, and workspace isolation are missing. |
| Plugin management | Browser tests cover compatible activation/deactivation, incompatible-plugin display, PowerShell activation, and tool invocation. | **Partially covered.** Failed add/remove rollback, core-plugin handling, restart-required messaging, workspace-specific plugin state, and the missing-sessions behavior are not covered. |
| Scheduled and unattended actions | The plugin test activates the background plugin and confirms `background_prompt` appears. | **Not covered E2E.** No test schedules or runs work, limits tools, checks history, handles failure, or proves that the default UI does not falsely expose a general scheduler. |
| Safety boundaries | Runtime tests cover file roots/backups, memory isolation, expert-root isolation, denied graph sources, read-only SQL, approval tokens, connector grants/redaction, and dry-run/shadow write blocking. | **Substantial integration coverage, incomplete end-to-end proof.** Localhost-only binding, all workspace resources, exact approval details, and browser-visible policy failures need coverage. |
| Troubleshooting behavior | SQL/workflow transient failures and partial service recovery are tested. | **Mostly not covered as user journeys.** Provider/plugin absence, stale WebUI, memory-not-recalled diagnosis, RAG path problems, and launcher recovery remain manual. |

## Missing Tests To Implement

The cases below are ordered by risk. A case may intentionally span multiple
features when the failure occurs at their boundary.

### P0 — Isolation, authorization, and data-integrity risks

#### E2E-001: Workspace switch locks the outgoing workspace and recovers safely

**Target:** `tests/webui/matbot-webui.spec.mjs`, with delayed and failing
workspace-switch responses added to `tests/webui/harness.mjs`.

**Scenario:**

1. Start in workspace A and create a conversation.
2. Delay the switch-to-B response and runtime-ready signal.
3. Select workspace B.
4. While the UI says Cortex is restarting, try Enter, Send, New conversation,
   file upload, and a second workspace selection.
5. Release the switch and verify that workspace B is the runtime that answered.
6. Repeat with the switch endpoint returning `503`.

**Assertions:**

- The composer and other workspace-mutating controls are disabled while the
  switch is unresolved.
- No message, session, upload, or other mutation reaches workspace A after the
  switch begins.
- Late session events from workspace A cannot render into workspace B.
- Success reloads the lists for B exactly once and re-enables the composer.
- Failure keeps A active, reports an actionable error, restores controls, and
  does not show B as selected.
- Retrying after failure succeeds without a full manual reload.

This directly tests the guide's warning not to send while Cortex is restarting,
rather than relying only on the user to obey it.

#### E2E-002: Complete cross-workspace isolation matrix

**Target:** a new serial Playwright spec,
`tests/webui/workspace-isolation.spec.mjs`, using the existing harness workspace
APIs.

**Scenario:**

1. In workspace A, create a conversation, upload a file, create/edit a skill,
   add a memory, configure a unique RAG path/context, select provider `Local`,
   and activate the background plugin.
2. Switch to a newly created workspace B.
3. Inspect conversations, files, memories, skills, RAG settings, provider
   selection/options, and active plugins.
4. Create same-named records in B with distinguishable contents.
5. Switch back to A, then back to B.

**Assertions:**

- No A record or configuration appears in B and vice versa.
- Same-named files/skills/memories do not overwrite each other.
- Each workspace restores its own selected provider, RAG context, active plugin
  set, and conversations.
- Direct tool calls scoped to B cannot retrieve A IDs.
- Deleting B does not alter A.

The test must use only disposable harness data. It must not read or modify
`local-agent/matbot/cortex-workspaces.json` or
`local-agent/matbot/workspaces/`.

#### E2E-003: Stop aborts the request, ignores late events, and drops queued work

**Target:** `tests/webui/matbot-webui.spec.mjs`; extend the harness slow-response
fixture so it records aborts and can deliberately emit a late event.

**Scenario:**

1. Start a slow streaming turn.
2. Queue or programmatically submit a second prompt while the first is active.
3. Stop the turn after partial thinking/tool/text output.
4. Have the harness attempt to emit a final token and tool result after abort.
5. Send a new normal prompt.

**Assertions:**

- The server sees the first request's abort signal.
- The queued second prompt is never sent and is not stored in the session.
- Late events do not append text, tool results, or usage to the stopped turn.
- The partial/stopped turn has a clear terminal state after reload.
- The next prompt runs once and is not contaminated by the aborted stream.
- Send/Stop controls and composer state return to normal even if abort itself
  returns an error.

#### E2E-004: SQL approval is bound to the exact plan

**Target:** `tests/webui/matbot-webui.spec.mjs` plus request counters in the
harness; add a backend assertion to `tests/structured-data-runtime.mjs`.

**Scenario:**

1. Plan and approve a query.
2. Change the metric, dimension, filter value, or limit before execution.
3. Attempt execution with the old approval through both the UI and a direct
   tool call.
4. Re-plan and re-approve, then rapidly click Execute twice.

**Assertions:**

- Any plan-affecting edit clears the old preview/approval state and disables
  Execute.
- The old approval token cannot execute the changed plan.
- A stale planning response cannot overwrite a newer plan.
- Rapid double execution produces one execution request and one result source.
- Filter values containing quotes or SQL-looking text remain parameters and
  never enter SQL text.
- The run ledger retains separate planned, approved, succeeded/failed states.

#### E2E-005: Workflow approvals gate execution, not just proposals

**Target:** `tests/webui/matbot-webui.spec.mjs` and new harness controls for tool
success/failure.

**Scenario:**

1. Compile a high-risk workflow that creates action, stale-source, risk, cost,
   confidence, and expert-review gates.
2. Start an approval-gated run with one proposed write.
3. Approve only one gate and inspect the run.
4. Resolve the remaining gates one by one.
5. Let the external action fail after all approvals.
6. Repeat with a successful action.

**Assertions:**

- The run cannot execute while any required gate is pending or rejected.
- Each decision updates only the selected approval; double clicks send one
  decision request.
- Approval changes a proposal to approved but does not put it in Executed
  Actions.
- A failed external action is recorded as attempted/failed and the run is not
  shown as successfully completed.
- A successful action appears once in Executed Actions with a later ordered
  ledger event.
- Evidence source IDs and immutable source versions remain attached throughout.

#### E2E-006: Workspace RAG rejects bad configuration and survives job races

**Target:** `tests/webui/matbot-webui.spec.mjs` and richer configurable RAG
responses in the harness.

**Scenario:**

1. Enter a relative path, inaccessible path, duplicate path with different
   casing/trailing slash, and a path containing no Markdown.
2. Save a valid path, then force ingestion to fail midway.
3. Retry and trigger two reindex requests close together.
4. Switch workspaces while indexing, then return.

**Assertions:**

- Relative/inaccessible paths produce a specific error and do not replace the
  last saved configuration.
- Normalized duplicates are indexed once.
- An empty Markdown corpus ends in a clear zero-files state, not a false
  success with stale previous results.
- Failure shows the failing path/file and keeps Save/Retry usable.
- Progress never moves backward because an older poll response arrived late.
- Only the active job can set final status/current file.
- Switching workspaces cannot display A's progress or results in B.

#### E2E-007: Plugin mutations fail atomically and core availability is visible

**Target:** `tests/webui/matbot-webui.spec.mjs`, with harness fixtures for a
missing sessions plugin and failed plugin mutations.

**Scenario:**

1. Load a workspace without the sessions plugin.
2. Verify the documented sessions-not-loaded banner and create a temporary
   conversation.
3. Force activation of an optional plugin to fail, then retry successfully.
4. Force deactivation to fail.
5. Inspect a core plugin and a boot-sensitive plugin.

**Assertions:**

- The sessions banner is visible, accessible, and accurately warns that
  conversations will not survive reload.
- Failed add/remove leaves the plugin in its prior state and does not show a
  success transcript.
- Retry performs exactly one mutation and updates tools once.
- Core plugins are either protected from removal or require an explicit,
  strongly worded confirmation consistent with actual behavior.
- Boot-sensitive changes show that a restart is required.
- Plugin state stays workspace-specific after switching.

#### E2E-008: Windows lifecycle smoke test for documented commands

**Target:** a new opt-in serial test such as
`tests/lifecycle/cortex-lifecycle.test.mjs`, enabled only when
`CORTEX_LIFECYCLE_E2E=1`.

**Setup requirements:**

- Run only on Windows CI or a prepared Windows test host.
- Use a disposable workspace root, dedicated ports, a fake/local provider, and
  a test-specific Docker Compose project name.
- Snapshot relevant user environment variables and local files before the test;
  restore them in `finally`.
- Never use production Docker volumes or the developer's workspace registry.

**Scenario and assertions:**

1. Run the secrets setup with test credentials and verify values are stored in
   the intended test scope without appearing in stdout.
2. Run `scripts/run.ps1` and wait for the documented health endpoint.
3. Open the WebUI and complete one fake-provider turn.
4. Run `scripts/health-check.ps1` and require a successful, service-specific
   report.
5. Run `scripts/stop-local-agent.ps1`; verify ports are released and repeated
   stop is idempotent.
6. Start again and verify persisted non-secret test data is readable.
7. On every failure, execute cleanup and emit actionable service logs.

This suite should be opt-in because it is slower and depends on Windows/Docker,
but it is the only way to validate the guide's first-run promise.

### P1 — Error handling and state-transition gaps

#### E2E-009: Workspace name validation and destructive edge cases

**Target:** `tests/webui/matbot-webui.spec.mjs`.

Cover empty/whitespace names, case-insensitive duplicates, leading/trailing
spaces, Unicode, path separators, reserved Windows names, very long names,
rename collision, cancellation, and API failure. Verify that invalid requests
are not sent, server errors preserve the old name, focus returns to the invalid
field/dialog, and no phantom workspace row appears.

Also test deletion of the active workspace. The dialog must name the exact
workspace, cancellation must preserve it, confirmation must select a valid
fallback workspace before enabling mutations, and late data from the deleted
runtime must not reappear.

#### E2E-010: File batch operations are atomic and recoverable

**Target:** `tests/webui/matbot-webui.spec.mjs`.

Upload multiple files where one succeeds and one fails; include an empty file,
a large file near the configured limit, duplicate names, Unicode, nested-looking
names, and a MIME type that does not match the extension. Assert that every
file gets its own result, attachment chips represent only successful uploads,
retry does not duplicate successful files, and failures do not clear unrelated
attachments.

Force open and delete to return `404`/`503`. The row must remain on delete
failure, errors must be visible, a failed open must not create a blank popup,
and retry must succeed. Repeat across two workspaces to prove file isolation.

#### E2E-011: Memory browser displays optimistic-concurrency conflicts

**Target:** `tests/webui/matbot-webui.spec.mjs`; expose the harness record
version and a way to update it externally.

Open the same memory in the browser, update it through a direct tool call, then
attempt Save and Delete using the stale version. Assert that the UI reports the
conflict, shows the server's current fact/version, preserves the user's edit for
copy/retry, and does not claim success or close unexpectedly. Reload the current
record and verify a subsequent valid edit succeeds.

Also cover delete cancellation and a CRUD `503`, then switch workspaces while
the browser is open and verify that stale records are cleared before the new
workspace is queried.

#### E2E-012: Skill editor offline and failure behavior

**Target:** `tests/webui/matbot-webui.spec.mjs`.

Run without defining `window.TinyMDE` and block the editor CDN. Opening a skill
must show the documented offline-editor error, keep metadata/triggers readable,
and prevent saving partial content. Then cover load failure and save failure:
the overlay stays open, the user's content/triggers remain intact, the error is
announced, and retry saves once. Add a workspace switch while unsaved changes
exist and verify an explicit discard decision rather than silent cross-workspace
save.

#### E2E-013: Expert Panel validates selection and isolates failures

**Target:** `tests/webui/matbot-webui.spec.mjs` with per-expert failure/delay
controls in the harness.

Cover all three modes explicitly. With `Use experts` enabled and `All experts`
cleared, send with zero experts and assert that no panel request is made and an
actionable validation message is shown. Next, make one selected expert fail
while others succeed; successful answers must remain visible, the failed expert
must be identified, and synthesis must either clearly exclude it or report why
it cannot proceed. Stop a slow panel run and verify all outstanding expert
requests are aborted. After reload, transcript metadata must preserve mode,
selection, synthesis choice, and partial/error state.

#### E2E-014: Source refresh, permissions, and selection races

**Target:** `tests/webui/matbot-webui.spec.mjs`.

Seed healthy, stale, degraded, unhealthy, and denied sources. Verify every
documented detail field, citation, limitation, and source event is attached to
the selected source. Denied content must not leak in details, citations, graph
facts, or search results.

Delay source A's detail/events response, select B, and release A; B must remain
selected. Change a source from healthy to stale, select Refresh, and verify the
new health and observation times. Cover empty lists, health-only failure,
source-list failure, and successful retry without discarding still-usable
partial data.

#### E2E-015: Complete governed-SQL negative contract

**Target:** `tests/structured-data-runtime.mjs` plus focused WebUI validation
tests.

Add backend cases for `CROSS JOIN`, multiple statements, comments hiding write
keywords, CTEs containing writes, zero/negative/huge limits, unknown metric,
unknown filter column, disallowed filter operation, missing connection, expired
or reused approval token, and execution after the stored plan is tampered with.

At the UI layer, invalid metric/dimension/filter/limit input must prevent
approval, display the backend validation reason, retain user input for
correction, and recover after re-planning.

#### E2E-016: Workflow compilation, versioning, filters, and all start modes

**Target:** `tests/webui/matbot-webui.spec.mjs`.

Cover missing name/purpose, malformed placeholders, unknown source/tool,
unpublished compilation, compiler warnings, smoke-test failure, and server
failure. The UI must keep inputs and surface validation paths.

Publish version 1, start a run, publish version 2, and assert that the first run
and its approvals still show version 1. Start Dry run, Shadow, and
Approval-gated modes from the library controls and verify mode-specific
execution rules. Exercise library and run-ledger filters with no matches and
clear-filter recovery. Label separate shadow runs Accept, Reject, and Mixed and
verify counts/rates are calculated from the exact run/version hashes.

#### E2E-017: Evaluation failure gates and trustworthy ROI

**Target:** `tests/webui/matbot-webui.spec.mjs` plus additions to
`tests/evaluation-observability-runtime.mjs`.

Seed a failed required scorer, a pass rate below threshold, a replay failure, an
unverified outcome, a verified outcome without a named verifier/baseline, zero
cost, negative net benefit, and a trace containing secret-like tool inputs.

Assert that a failed suite is visibly release-blocking; replay never executes a
write even when reconstruction fails; secrets are redacted in list, detail, and
download/report data; only valid `verified_completed` outcomes contribute to
time saved and benefit; and zero/negative ROI/payback states do not display
`Infinity`, `NaN`, or misleading positive styling. Add stale trace/suite
selection and refresh-failure protection.

#### E2E-018: Context Graph empty, constrained, denied, and failed retrieval

**Target:** `tests/webui/matbot-webui.spec.mjs`.

Search multiple comma-separated terms with and without a source ID. Assert that
the request is normalized, source constraints are honored, confidence and
citations match each relationship, and denied-source entities/facts never
render. Cover no matches, partial entities without relationships, malformed
response data, transient failure/retry, and two overlapping retrievals where
the older response arrives last. Refresh must clear retrieval-only state and
restore the stored list without reviving a stale selection.

#### E2E-019: Durable review validation, persistence, and failure recovery

**Target:** `tests/webui/matbot-webui.spec.mjs`.

Create reviews for workflow, run, alert, investigation, and decision targets.
Cover missing question, missing required target ID, empty experts, unknown
expert, and mismatched workflow/run IDs. Invalid forms must not call the tool.

Delay review A, select B, and ensure A cannot overwrite B. Force creation and
detail-load failures, preserving the form/selected card for retry. Reload after
a successful review and verify recommendations, evidence, confidence, risks,
blockers, mitigations, checklist, consensus, disagreements, risk register, and
synthesis persist. Repeat in a second workspace to prove isolation.

#### E2E-020: Scheduled/background execution obeys tool policy

**Target:** a new runtime integration test for the background plugin and a
small Playwright contract test.

The browser test should first prove that the default workspace has no general
scheduling screen, matching the guide, while activation exposes only the
capabilities that actually exist.

The runtime test should schedule a thin prompt that invokes a typed workflow,
then verify workspace identity, allowed-tool enforcement, approval gating,
history recording, restart persistence, cancellation, missed-run behavior, and
failure/backoff. A task requesting an unapproved tool or write must be blocked
and audited without executing it. Two workspaces with the same schedule ID must
remain isolated.

### P2 — Resilience, accessibility, and documentation drift

#### E2E-021: Provider/session absence and normal conversation recovery

**Target:** `tests/webui/matbot-webui.spec.mjs`.

Test no providers, selected provider disappearing after reload, provider request
failure, session-list `404` versus `503`, normal conversation reopen, hidden
session persistence, stream disconnect, tool error, and provider error. The UI
must distinguish configuration problems from temporary transport failures,
retain the user's prompt when it was not accepted, and allow retry without
duplicating user messages.

#### E2E-022: Responsive and keyboard-accessible core journeys

**Target:** Playwright tests using both configured projects.

Exercise font decrease/increase bounds, persistence at both bounds, architecture
tab arrow-key wraparound, focus restoration after overlays/dialogs, Escape
behavior with unsaved changes, and keyboard-only Send/Stop.

On mobile, cover workspace switching, file attachment, memory browser, skill
editor, expert selection, approval decisions, and long SQL/workflow/graph
content without horizontal page overflow. Assert accessible names, selected
states, disabled states, and status/error announcements for the controls used in
these journeys.

#### E2E-023: User-guide contract and link checker

**Target:** a fast Node test such as `tests/userguide-contract.test.mjs`.

Parse `userguide.md` and verify:

- every relative link and heading anchor resolves;
- documented scripts and referenced files exist;
- documented ports and command names match their source defaults;
- important WebUI labels (`New conversation`, `Model:`, `Experts`, `Save`,
  `Close`, architecture panel names, approval labels) exist in the shipped
  frontend;
- explicit limitations remain present, including Markdown-only RAG, no general
  scheduler screen, no editable workflow version diff, and no manual review
  status editing;
- destructive commands remain adjacent to their warnings.

This is not a substitute for behavioral E2E tests. It prevents the guide from
silently drifting away from the implementation and gives feature changes a
clear prompt to update either documentation or tests.

## Suggested Implementation Sequence

1. Extend the existing harness with deterministic failure, delay, request-count,
   abort, and workspace-scoped fixtures.
2. Implement E2E-001 through E2E-007 in the existing Playwright suite, splitting
   workspace isolation into a serial spec if cleanup becomes difficult.
3. Add the opt-in Windows lifecycle test, E2E-008, on a disposable CI host.
4. Add P1 cases alongside the feature they protect; keep each test focused on
   one state transition or failure class.
5. Add the user-guide contract test and accessibility/mobile journeys after the
   behavioral gaps are protected.

For every new Playwright test, retain the current global assertion that no
uncaught browser errors occurred. Prefer stable `data-*` identifiers for
workflow runs, approvals, sources, reviews, traces, and workspace resources so
that delayed-response tests can identify the exact record rather than select by
display text.

## Completion Criteria

The backlog should be considered substantially covered when:

- every user-guide feature has at least one browser E2E or an explicitly
  justified runtime/lifecycle test;
- every destructive or approval-gated feature has a negative authorization
  case and an idempotency case;
- all workspace-scoped resource types are proven isolated;
- every long-running UI operation has failure, retry, stale-response, and
  cancellation/switch coverage;
- the documented launcher lifecycle passes on a clean Windows test host; and
- the guide contract test prevents commands, labels, links, and declared
  limitations from drifting.
