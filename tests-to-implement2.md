# Second-Pass User-Guide End-to-End Test Audit

## Scope And Method

This is a fresh comparison of `userguide.md` with the automated tests in the
current working tree. It includes the scenarios added after the first audit in
`tests-to-implement.md`.

The following layers were inspected:

- `tests/webui/matbot-webui.spec.mjs`: 78 Playwright definitions using the
  shipped static WebUI and `tests/webui/harness.mjs`.
- `tests/*.test.mjs` and their runtime helpers: production plugin and storage
  integration tests using disposable stores and fake providers.
- `tests/workspace-switch.test.mjs`: real HTTP runtime handoff and port-release
  tests.
- `tests/lifecycle.test.mjs`: an opt-in Windows launcher smoke test.
- `tests/userguide-contract.test.mjs`: links, anchors, commands, labels,
  limitations, and destructive-warning drift checks.
- `tests/readme-qa/`: live-provider answer-quality tests for `README.md`. These
  are not WebUI journey coverage for most of `userguide.md`.

In this document:

- **Browser E2E** means Playwright drives the public WebUI and asserts visible
  results and outgoing transport calls.
- **Runtime integration** means real production plugin/runtime code is tested,
  but not through the browser.
- **Safety-gated** means a test exists but is skipped in the normal suite until
  explicit disposable-host environment variables are set.

The Playwright harness is deterministic and does not spend provider tokens or
touch production workspace data. It does not prove that the launcher, Docker
services, real providers, real filesystem stores, and the WebUI work together.

## Implementation Outcome

Every scenario ID now has an executable automated slice. This implementation
added 19 Playwright definitions, a real loopback-listener integration test, an
evaluation CLI/JUnit test, expanded background and workspace-RAG runtimes, and a
third-opt-in complete Windows lifecycle test.

**Covered** means the central risk in the scenario is now automated.
**Representative** means a deterministic high-risk transition is covered, but
the full combinatorial matrix remains useful follow-up. **Safety-gated** means
the implementation exists but cannot be executed safely on an ordinary
developer workstation.

| ID | Status | Implemented evidence | Remaining breadth |
| --- | --- | --- | --- |
| T2-E2E-001 | Covered | Production frontend binds to `127.0.0.1`; runtime test proves loopback health and rejects a non-loopback address; guide contract prevents `0.0.0.0` drift. | Authentication/TLS remains required before any future remote-listen mode. |
| T2-E2E-002 | Covered | Provider options and preferences are workspace-scoped; normal A/B turns persist the exact visible provider and invalid A choices never enter B. | Temporary provider-discovery `503` is represented by the missing-provider recovery test rather than a separate options-list retry. |
| T2-E2E-003 | Representative | A successful browser switch reloads B, then an injected late A stream event cannot render or expose A's session in B. | Held tool, file, usage, and list responses can be added to the same generation fixture. |
| T2-E2E-004 | Representative | Deleting B clears its harness sessions, files, skills, memories, RAG, plugins, providers, and reviews while the same-named A file survives. | Physical directory locks, interrupted deletion, symlink ownership, and ID reuse need a disposable workspace-manager runtime. |
| T2-E2E-005 | Representative | Malicious workspace and session names render as inert text and execute no event handler. | Parameterize every display surface and unsafe Markdown URL scheme. |
| T2-E2E-006 | Representative | Background schedules retain provider/principal identity, survive plugin teardown/setup, support lifecycle operations, reject wildcard delete, and remain workspace-isolated. | The plugin still needs a fake-clock child execution harness for workflow/tool/approval, missed-run, retry, and duplicate-fire semantics. |
| T2-E2E-007 | Representative | A pre-accept `503` restores the prompt, stores no message, and a retry stores exactly one user turn. | Post-accept provider failure, SSE disconnect, offline/reload, and partial terminal state. |
| T2-E2E-008 | Representative | Delete `503` keeps the file row and retry succeeds; earlier coverage handles partial batches and workspace isolation. | Zero/limit/binary/collision/MIME and rejected-send attachment cases. |
| T2-E2E-009 | Representative | Production RAG normalization deduplicates paths after resolution before ingestion. | Inaccessible/empty paths, rename/delete reconciliation, read failure, symlink policy, and overlapping jobs. |
| T2-E2E-010 | Covered for fields | Memory browser round-trips and clears `dreamSkill`/`ignoreUntil`; existing tests cover CRUD, state filter, CAS conflict, and retry. | Pagination gaps, delete conflict/`503`, and workspace switch while open. |
| T2-E2E-011 | Representative | Skill save `503` leaves the editor open with exact content and retry writes once. | Trigger partial failure, discard decisions, concurrent versioning, and workspace switch. |
| T2-E2E-012 | Representative | A simulated expert timeout retains successful expert answers and explicitly excludes the failed expert from synthesis. | Cancellation fan-out, synthesis-only failure, workspace switch, and all timeout orders. |
| T2-E2E-013 | Representative | A denied-source canary requested through Graph never appears in results while allowed data remains usable. | Reuse one canary across source, RAG, SQL, workflow, evaluation, and review surfaces. |
| T2-E2E-014 | Covered | Two overlapping SQL plans prove the late old plan cannot overwrite the newer metric; graph-independent approval invalidation and runtime token protections remain active. | Expiry/revocation, missing connection, database timeout, and limit/operator matrix. |
| T2-E2E-015 | Representative | Browser Run Ledger renders failed status, failed executed action, exact external error, and `tool_execution_failed`; runtime tests retain multi-gate policy evidence. | Sequential browser decisions for every gate and v1/v2 mode/filter/shadow matrix. |
| T2-E2E-016 | Covered | UI renders negative net benefit and null ROI without `NaN`/`Infinity`; CLI returns pass/fail exit codes and writes escaped JUnit. | Replay reconstruction failure, UI/report redaction, and stale evaluation selections. |
| T2-E2E-017 | Covered | Graph terms deduplicate, overlapping requests keep the newest result, and the older response cannot revive stale state. | Source constraints, malformed partial relationships, Unicode cases, and Refresh overlap. |
| T2-E2E-018 | Representative | Durable review lists are workspace-filtered; same target IDs in B cannot expose A's review. | All target types, mismatched IDs, reload fidelity, detail failure, and concurrent create. |
| T2-E2E-019 | Covered for rollback | Optional-plugin removal `503` leaves the plugin/tools active and retry removes once. | Boot-sensitive restart copy and real-runtime persistence for provider/store/frontend plugins. |
| T2-E2E-020 | Safety-gated | Third opt-in test snapshots/restores User-scope secrets and Mem0 `.env`, runs secrets setup without output leakage, starts full Docker-backed Cortex, and checks health. | Must run on dedicated Windows CI; a fake-provider WebUI turn and persistence assertion remain to add there. |
| T2-E2E-021 | Representative | Desktop and mobile keyboard tests verify destructive-dialog focus, Escape cancellation, and focus restoration. | Full keyboard/mobile journey set, focus traps, live announcements, touch targets, and overflow. |
| T2-E2E-022 | Representative | Two tabs edit one memory; stale Save reports a version conflict and cannot overwrite the first writer. | Sessions, skills, approvals, plugins, workspace switching, and reload-during-operation. |
| T2-E2E-023 | Representative | Empty provider configuration produces an actionable error and retains the unsent prompt. | Stale frontend, memory diagnosis, RAG logs, Mem0 authentication, and port-conflict guidance. |

## Coverage Baseline Before This Implementation

The matrix below records the state that motivated the second-pass scenarios.
Use the implementation table above for the current result.

| User-guide feature | Current automated evidence | Current assessment |
| --- | --- | --- |
| Install, start, health, and stop | `tests/lifecycle.test.mjs` invokes `run.ps1`, checks the WebUI and health script, stops Cortex, checks port release, and repeats Stop. | **Safety-gated partial coverage.** It skips Docker and setup/build work, does not run `setup-secrets.ps1`, and is skipped by default. |
| WebUI shell, typography, and responsive layout | Shell load, provider list, sidebar sections, font persistence and bounds, architecture-tab keyboard wrapping, mobile sidebar, architecture panels, Evaluation/ROI, and workflow ledger are covered. | **Good structural coverage.** Focus management, dialog trapping, Escape behavior, status announcements, overflow, and most mobile feature journeys remain untested. |
| Conversations | New conversation, immediate send after New, streaming text/thinking/tools, usage, interactive prompts, rename, hide, mark, and transcript persistence for expert turns are covered. | **Good happy-path coverage.** Normal reopen, provider failure, stream disconnect, reload during a turn, and exactly-once retry remain incomplete. |
| Model selection | Provider options load, the selected value persists over reload, and direct cognition calls receive provider context. | **Partial coverage.** No browser test proves that the selected provider is used by the next normal turn or that provider choices change correctly with the active workspace. |
| Send and Stop | Busy-state control replacement, abort, queued-turn removal, ignored late completion, clean subsequent turn, and session-storage integrity are covered. | **Strong coverage.** Abort-endpoint failure and browser reload during cancellation remain. |
| Workspace create, rename, switch, and delete | Create, rename, delete cancellation/confirmation, normal switch, switch failure, mutation locking, runtime identity handoff, and port release are covered. | **Good coverage.** Successful delayed-switch races, validation boundaries, active/only-workspace deletion, cleanup of every resource, and partial filesystem deletion failures remain. |
| Workspace isolation | One browser matrix covers sessions, files, skills, memories, RAG settings, and activated plugins. Runtime tests cover memory/store identities. | **Strong for tested resources.** Provider choices/secrets and physical deletion cleanup are not proved. |
| Workspace knowledge settings | Dirty-state Save, Close without saving, progress/current file, completion, save failure, retained edits, stale cross-workspace status rejection, and per-workspace RAG restoration are covered. | **Good UI coverage.** Path normalization, inaccessible paths, no-Markdown folders, overlapping jobs, and source cleanup are missing. |
| Workspace files and attachments | Upload, open reserved-character filename, delete, explicit attachment, chip removal, clearing after accepted send, same-name RAG precedence, partial batch failure, retry, and workspace isolation are covered. File-broker root and backup policy have runtime tests. | **Good common-path coverage.** Size boundaries, binary/empty files, duplicate collision policy, failed open/delete, failed-send attachment retention, and unsafe display content remain. |
| Workspace RAG ingestion and retrieval | Browser tests cover configuration, automatic grounding, contextual search, failure preservation, and workspace isolation. Runtime tests cover Markdown ingestion, single-file paths, persistence, NUL sanitization, citations, contexts, and stale/degraded warnings. | **Strong integration coverage.** Rename/delete reconciliation, symlinks, non-Markdown exclusion reporting, job races, empty corpus, and real Postgres-backed restart are missing. |
| Memory | Browser capture/recall/isolation, contextual search, memory-browser CRUD, and visible Save conflict/retry are covered. Runtime tests cover restart persistence, relevance, deduplication, provenance, dream time, CAS, and workspace stores. | **Strong coverage.** Delete conflict, CRUD outages, state filters, `dreamSkill`, `ignoreUntil`, pagination, and a workspace switch while the browser is open remain. |
| Skills | Open/edit/save, metadata, triggers, delete confirmation, offline TinyMDE degradation, and workspace isolation are covered. | **Partial error coverage.** Load/save/trigger failure, invalid trigger rows, unsaved changes, concurrent edits, and workspace-switch behavior are missing. |
| Expert Panel | All experts with synthesis, selected experts without synthesis, Review and Debate behavior, transcript metadata, expert isolation at runtime, unknown experts, and zero-selection blocking are covered. | **Good happy-path coverage.** Explicit Parallel assertions, partial expert failure, synthesis failure, timeouts, cancellation fan-out, and workspace-specific expert lists are missing. |
| Sources and health | List/detail fields, citations, limitations, events, stale/unhealthy display, slow health response, partial refresh failure, stable IDs, versions, access events, and health findings are covered. | **Partial negative coverage.** Denied-source non-disclosure in the browser, list failure, changing health, empty state, and overlapping selection/refresh races are missing. |
| Governed SQL | Browser plan/approve/execute/citation, stage-specific retry, approval invalidation after edits, and double-execute protection are covered. Runtime tests reject writes, unsafe joins, multiple statements, data-modifying CTEs, unknown fields, bad/reused tokens, and tampered SQL. | **Strong core coverage.** Stale plan responses, token expiry, missing connection, boundary limits, form validation, and hostile parameter display remain. |
| Workflow Operations Center | Browser overview/library/run ledger/approval/shadow flows, idempotent decisions, stale selection, partial service failure, and mobile ledger are covered. Runtime tests cover typed inputs, immutable versions, all gate types, policy blocking, ordered events, successful actions, and failed post-approval actions. | **Strong runtime and happy-path UI coverage.** Full multi-gate browser behavior, all start modes from the library, version transitions, action failure presentation, and exact filters remain. |
| Evaluation, observability, and ROI | Trace waterfall, safe replay, passing and release-blocking failed suites, sponsor evidence, runtime redaction, scorers, cost, verified outcomes, and ROI arithmetic are covered. | **Partial browser coverage.** Replay failure, UI redaction, zero/negative ROI, stale selection, refresh failure, and CLI exit/JUnit contracts remain. |
| Context Graph | Browser retrieval, selection, evidence, citations, refresh, stale-list protection, empty results, and transient retry are covered. Runtime tests cover extraction, deduplication, stale/degraded warnings, denied-source filtering, versions, and projection events. | **Partial query coverage.** Multiple terms, source constraints, denied-data absence in the UI, malformed partial responses, and overlapping retrieval races are missing. |
| Durable expert reviews | Browser create/detail, recommendations, evidence, risks, checklist, validation, failed creation retention, and retry are covered. Runtime tests cover structured persistence. | **Partial coverage.** All target types, unknown experts, reload fidelity, detail failure, stale selection, workspace isolation, and concurrent creation are missing. |
| Plugins | Browser activation/deactivation, incompatible plugins, PowerShell activation/invocation, failed activation rollback/retry, core removal protection, missing sessions warning, and workspace-isolated activation are covered. | **Good activation coverage.** Failed removal, restart-required behavior, concurrent mutation, provider/frontend boot changes, and persistence after a real restart are missing. |
| Scheduled and unattended actions | A runtime test validates schedule duration, create/list/suspend/resume/cancel, unsafe wildcard rejection, persistence in the supplied store, and workspace isolation. | **Management-only coverage.** No scheduled prompt actually runs a typed workflow, enforces tools/approvals, records history, retries, handles missed runs, or survives a real runtime restart. |
| Safety boundaries | Runtime tests cover file roots/backups, memory and expert isolation, denied graph sources, SQL approval/read-only checks, connector grants/redaction, and dry-run/shadow write blocking. | **Substantial integration coverage with a critical WebUI binding gap.** The guide says localhost-only, but the production frontend currently listens on `0.0.0.0`; no test enforces the documented boundary. |
| Troubleshooting | Missing sessions, SQL stage failures, graph retry, source partial failure, workflow service recovery, offline skill editor, and RAG save errors are automated. | **Partial journey coverage.** Missing providers, stale frontend assets, Mem0 failure diagnosis, RAG log guidance, and launcher recovery are mostly manual. |
| Documentation drift | Relative links/anchors, commands, port, important labels, explicit limitations, and destructive warnings are checked. | **Strong static contract coverage.** It intentionally does not prove runtime behavior. |

## Missing Tests To Implement

The scenarios below exclude cases now adequately covered. They are ordered by
the risk of data exposure, wrong-workspace mutation, unauthorized action, or
misleading business evidence.

### P0 — Security, Isolation, And Irreversible-Action Contracts

#### T2-E2E-001: Enforce The Documented Loopback-Only WebUI Boundary

**Target:** a new production-server integration test, separate from the fake
Playwright harness.

**Why it is missing:** `userguide.md` says the WebUI is intended for localhost
use. The production frontend currently calls `server.listen(port, "0.0.0.0")`,
which is not a loopback-only bind. The test should encode the documented safety
contract and is expected to expose this discrepancy until the server is fixed.

**Setup and steps:**

1. Start the real frontend server on a disposable port with fake services and a
   temporary config.
2. Confirm `127.0.0.1:<port>` and `localhost:<port>` serve the WebUI.
3. Discover a non-loopback IPv4 address for the test host.
4. Attempt the same HTTP request, event stream, and state-changing endpoint
   through that address.
5. Inspect the actual listening address through Node server metadata or an OS
   socket query.

**Assertions:**

- The listening address is loopback, not `0.0.0.0`, `::`, or a LAN interface.
- HTTP, SSE, and mutation endpoints are unreachable through non-loopback
  interfaces.
- Startup logs advertise the same address the server actually uses.
- The test fails loudly if a later configuration broadens exposure without an
  explicit authentication/TLS test mode.

#### T2-E2E-002: Prove Provider Configuration And Normal-Turn Routing Per Workspace

**Target:** `tests/webui/matbot-webui.spec.mjs` with per-workspace provider
fixtures and submitted-turn recording in `tests/webui/harness.mjs`.

**Setup and steps:**

1. Give workspace A providers `openai` and `Local-A`; give B only `Local-B`.
2. In A, select `Local-A`, send a normal turn, and record the provider on the
   submitted request and stored assistant message.
3. Switch to B and verify A-only choices disappear before Send is enabled.
4. Send in B without manually changing an invalid persisted selection.
5. Switch repeatedly and simulate the selected provider disappearing after a
   config reload.
6. Make provider discovery return `503`, then recover.

**Assertions:**

- The next normal turn uses the visible selected provider exactly once.
- A provider unavailable in B is never submitted in B.
- The UI chooses an explicit valid fallback or blocks Send with an actionable
  configuration error; it must not silently use A's provider.
- Provider options and errors refresh at the workspace boundary.
- A temporary provider-list failure does not erase a valid prompt or duplicate
  the later retry.

#### T2-E2E-003: Successful Workspace Switch Rejects Outgoing Late Events

**Target:** Playwright plus a two-runtime or generation-aware harness fixture.

**Setup and steps:**

1. Start a streaming turn in A and hold a final token, tool result, usage event,
   session-list response, and file-change event.
2. Begin switching to B and delay B's ready response.
3. Attempt Enter, Send, New, upload, plugin mutation, and another switch while
   the transition is pending.
4. Mark B ready, then release every held A event and response.
5. Send a turn in B, switch back to A, and inspect both sessions.

**Assertions:**

- No mutation is accepted after the switch generation changes.
- No held A event renders in B or changes B's files, sessions, usage, or tools.
- B's lists load once from B after readiness, not once from A and again from B.
- A's partial turn remains attached only to A when reopened.
- A second switch request cannot interleave with the first.

The existing switch-failure test covers recovery but does not inject late
outgoing events into a successful handoff.

#### T2-E2E-004: Destructive Workspace Deletion Removes Only The Named Workspace

**Target:** a browser test paired with a disposable production
workspace-manager integration test.

**Setup and steps:**

1. Create A and B with same-named sessions, files, skills, memories, RAG
   contexts, plugin state, and store records.
2. Switch to A, request deletion of B, and verify the exact name in the dialog.
3. Force delete-readiness failure, filesystem-lock failure, and interrupted
   deletion; retry each case.
4. Complete deletion, recreate a workspace with B's old display name, and query
   old B resource IDs directly.
5. Attempt to delete the active workspace and the only remaining workspace.

**Assertions:**

- Cancellation and every failure leave B available and do not partially remove
  its registry entry while its directory remains ambiguous.
- Successful deletion removes B's owned directory and all B records.
- Old B IDs return not-found and never resolve to the recreated workspace.
- A's byte-for-byte test fixtures remain unchanged.
- Active/only-workspace deletion is blocked before destructive work starts.
- Symlinks or a config path outside the owned workspace root are never followed
  or recursively deleted.

#### T2-E2E-005: Treat All Displayed Workspace Data As Untrusted Text

**Target:** a reusable Playwright security spec covering the shared rendering
surfaces.

**Test data:** workspace names, filenames, session titles, skill names, source
titles/URIs, SQL values, tool arguments/results, expert output, graph aliases,
review questions, workflow names, and error messages containing:

- `<img src=x onerror=...>`;
- `<script>...</script>`;
- closing tags and quote characters;
- bidi-control characters;
- very long unbroken text;
- Markdown links using `javascript:` or unsafe data URLs.

**Assertions:**

- No injected script/event handler executes and no unexpected network request
  is made.
- Text appears as text unless the specific surface intentionally uses a
  sanitizing Markdown renderer.
- Unsafe link schemes are removed or non-clickable.
- Destructive confirmations still identify the exact logical record despite
  bidi or truncation.
- Long content wraps or scrolls inside its panel without creating page-wide
  horizontal overflow.

#### T2-E2E-006: Scheduled Execution Enforces Workflow, Tool, And Approval Policy

**Target:** expand `tests/background-scheduling-runtime.mjs` and add a small
browser capability-contract test.

**Setup and steps:**

1. Activate `background` only in workspace A.
2. Schedule a thin prompt that invokes a published typed workflow with one
   allowed read and one protected write.
3. Advance a fake clock through on-time, missed, and duplicate-fire conditions.
4. Exercise approval pending, approval granted, rejection, tool failure,
   process restart, suspend/resume, and cancellation while running.
5. Attempt an unapproved tool, a cross-workspace workflow ID, and a write in
   dry-run/shadow mode.

**Assertions:**

- The scheduled execution carries the correct workspace and effective
  principal.
- Only workflow-allowed tools run; denied attempts are audited.
- Protected writes remain pending until the exact approval is granted.
- Dry-run and shadow executions never write.
- History records scheduled time, actual time, outcome, attempts, workflow run,
  approvals, tool decisions, and errors.
- A duplicate timer fire or restart recovery does not execute the same due
  occurrence twice.
- Retry/backoff is bounded; cancellation prevents later retries.
- The default WebUI still exposes no fictional general scheduling screen.

### P1 — State Races, Failure Recovery, And Evidence Integrity

#### T2-E2E-007: Normal Conversation Failure And Exactly-Once Retry

**Target:** Playwright session/stream fault fixtures.

Cover provider rejection before acceptance, failure after the user message is
stored, SSE disconnect after partial text, tool error followed by model
recovery, browser offline/online, and reload during a turn.

Assert that the UI distinguishes "not accepted" from "accepted but failed",
retains a retryable prompt only when appropriate, never stores duplicate user
messages, preserves partial output with an explicit terminal state, restores
Send/Stop correctly, and reopens the same conversation consistently after
reload.

#### T2-E2E-008: File Boundary, Collision, And Recovery Matrix

**Target:** focused parameterized Playwright cases plus production workspace
tool tests.

Cover zero-byte files, the exact size limit and one byte over, binary bytes,
Unicode/reserved names, nested-looking names, duplicate names in one batch,
re-upload over an existing name, misleading MIME types, failed open, failed
delete, and a send rejected before attachment acceptance.

Assert per-file results, documented collision semantics, no path traversal,
only successful uploads becoming chips, chips remaining after an unaccepted
send, chips clearing once after acceptance, failed delete retaining its row,
failed open creating no blank popup, and retry not duplicating successful
uploads.

#### T2-E2E-009: RAG Path Normalization, Job Ownership, And Source Reconciliation

**Target:** Playwright plus `tests/workspace-rag-runtime.mjs`.

Cover relative and inaccessible paths, the same path with case/slash/dot
variations, symlink cycles, an empty directory, non-Markdown files, a Markdown
file renamed or deleted between scans, a read failure midway, and two
overlapping reindex requests.

Assert that invalid configuration does not replace the last good snapshot;
normalized duplicates scan once; symlinks cannot escape configured policy; an
empty corpus reports zero rather than stale success; deleted/renamed source
records and chunks reconcile correctly; only the newest job may publish final
status; and a workspace switch cannot display or persist another workspace's
job.

#### T2-E2E-010: Complete Memory-Browser Administrative And Concurrency Contract

**Target:** memory-browser Playwright tests and the production server fixture.

Cover state filtering and pagination, editing `dreamSkill` and `ignoreUntil`,
clearing those fields, delete cancellation, stale-version delete, Add/GET/PATCH/
DELETE `503`, two browser tabs editing one record, and switching workspaces
while a record is open.

Assert provenance and version remain visible; ISO times round-trip without
timezone drift; conflicts show the server value while preserving the local
edit; stale delete never removes the newer record; retry issues one mutation;
pagination has no duplicates/gaps; and the old record/detail clears before the
new workspace query starts.

#### T2-E2E-011: Skill Unsaved-Change, Trigger, And Concurrent-Edit Recovery

**Target:** Playwright with controllable skill and trigger endpoints.

Cover skill-load failure, content-save failure, trigger-save failure after
content succeeds, empty/duplicate/invalid trigger conditions, Cancel, close
button, Escape, backdrop click, workspace switch, and an external concurrent
edit.

Assert that unsaved content and triggers cannot be silently discarded or saved
into another workspace; the user receives an explicit discard/stay decision;
partial saves are reported accurately and converge on retry; invalid rows never
reach the API; metadata remains readable during editor failure; and a version
conflict does not overwrite the external edit.

#### T2-E2E-012: Expert Partial Failure, Timeout, And Cancellation Fan-Out

**Target:** per-expert delay/failure controls in the WebUI harness plus runtime
abort assertions.

Run Parallel, Review, and Debate explicitly. Make one expert succeed, one fail,
and one time out; separately fail synthesis after all experts succeed. Stop a
panel while multiple experts are active and switch workspaces during another
run.

Assert successful expert evidence remains visible; failed/timed-out experts are
named; synthesis states which inputs were excluded or why it failed; every
outstanding request receives cancellation; no late expert output crosses the
workspace boundary; and transcript metadata preserves mode, selected experts,
provider choices, synthesis setting, and partial/error states after reload.

#### T2-E2E-013: Denied Sources Never Leak Through Any Browser Surface

**Target:** a cross-panel Playwright authorization test.

Seed a denied source with a unique canary in its title, citation text, version,
events, graph entities, RAG chunks, SQL metadata, workflow evidence, trace
attributes, and review evidence.

Assert the canary is absent from source detail, search, citations, Context
Graph, SQL preview/results, workflow panels, evaluation traces/reports, and
reviews. The source may appear only as a minimal denied placeholder if that is
the intended product contract. Also delay A's detail/events, select B, change
health between refreshes, and verify stale A responses cannot overwrite B.

#### T2-E2E-014: SQL Stale Plans, Expiry, Boundaries, And Form Validation

**Target:** Playwright plus structured-data runtime cases.

Cover an older Plan response arriving after a newer one, zero/negative/maximum/
over-maximum limits, unknown/disallowed filter operators, missing connection,
expired approval, revoked approval, database timeout, and filter values with
quotes, comments, Unicode, and SQL-looking text.

Assert the UI shows only the newest plan; invalid forms retain values and cannot
be approved; parameters never appear interpolated in SQL; expiry/revocation
requires a new approval; execution stays idempotent across timeout/retry; and
planned, approved, attempted, succeeded, and failed audit states remain
distinguishable.

#### T2-E2E-015: Workflow Version, Multi-Gate, And External-Action Browser Proof

**Target:** extend the Workflow Center browser fixtures rather than relying
only on runtime assertions.

Publish version 1, start a run, publish version 2, and inspect the original run.
Start Dry run, Shadow, and Approval gated from the library. Resolve action,
stale-source, risk, cost, confidence, and expert-review gates independently;
then compare failed and successful external actions. Exercise run/library
filters and Accept/Reject/Mixed shadow labels.

Assert immutable version/source hashes never change; one gate decision affects
only that gate; execution waits for every required approval; approved proposals
remain separate from executed actions; failed actions make the run visibly
failed; successful actions appear once after an ordered ledger event; and
filter/acceptance metrics derive from the exact matching runs.

#### T2-E2E-016: Evaluation Redaction, Replay Failure, ROI Boundaries, And CLI Gate

**Target:** Playwright, `tests/evaluation-observability-runtime.mjs`, and a new
CLI contract test.

Seed secrets in span inputs/results/errors, a replay reconstruction failure,
unverified and malformed outcomes, zero cost, zero benefit, negative net
benefit, and stale trace/suite requests. Run the regression CLI with passing and
failing suites and a disposable JUnit path.

Assert secrets are redacted in lists, details, replay, and generated reports;
replay never performs writes even when reconstruction fails; only valid
`verified_completed` outcomes with baseline and verifier contribute; zero and
negative ROI/payback show finite honest states without `NaN`/`Infinity` or
positive styling; stale responses cannot replace the selected record; and the
CLI uses meaningful exit codes and valid JUnit for release gates.

#### T2-E2E-017: Context-Graph Query Normalization And Overlapping Retrievals

**Target:** Playwright graph fixtures.

Search multiple comma-separated terms containing whitespace, duplicates, and
Unicode, with and without a source constraint. Return partial entities without
relationships, malformed relationship references, denied-source facts, and two
overlapping responses released newest-first.

Assert normalized terms and source ID are sent once; constrained results never
include another source; malformed facts fail safely without losing the usable
subset; confidence/citations stay attached to the correct relationship;
denied-source canaries never render; older retrieval cannot overwrite newer
state; and Refresh clears retrieval-only state without reviving stale
selection.

#### T2-E2E-018: Durable Reviews Across Target Types, Reloads, And Workspaces

**Target:** parameterized review Playwright tests.

Create workflow, run, alert, investigation, and decision reviews. Cover missing
target IDs, mismatched workflow/run IDs, empty and unknown experts, detail
failure, two concurrent creates, stale card selection, reload, and same-named
targets in two workspaces.

Assert invalid forms send no request; creation retry produces one review;
selected-card state survives detail failure; late A detail cannot overwrite B;
all structured fields persist after reload; and neither list nor direct ID
lookup leaks a review across workspaces.

#### T2-E2E-019: Plugin Removal Rollback And Boot-Sensitive Restart Contract

**Target:** Playwright plus a disposable real-runtime plugin reload test.

Force optional-plugin removal to fail, then retry. Double-click add/remove,
switch workspaces during mutation, and activate plugins that contribute a tool
only versus providers, hooks, stores, or frontend behavior.

Assert failure leaves the plugin and tools in their previous state; one user
action produces one mutation; workspace switch cannot apply completion to the
wrong workspace; core plugins remain protected; boot-sensitive changes clearly
require restart; tool-only behavior follows the actual hot-load contract; and
state persists after a real restart without affecting another workspace.

### P2 — Operational Confidence, Accessibility, And Recovery Guidance

#### T2-E2E-020: Complete Disposable Windows First-Run Lifecycle

**Target:** expand `tests/lifecycle.test.mjs` on dedicated Windows CI.

Use a disposable checkout/config root, ports, Docker Compose project, volumes,
and fake OpenAI-compatible provider. Snapshot user environment state and
restore it in `finally`.

Run `setup-secrets.ps1` with test-only credentials; open a child PowerShell to
verify the documented new-shell behavior; run the launcher without Skip flags;
wait for every service; complete one WebUI turn and one memory/RAG operation;
run health; stop twice; restart; verify non-secret persistence; then clean up.

Assert secrets never appear in stdout, logs, generated YAML, reports, or git
status; service failures name the failing component; ports and Docker resources
are released; persisted test data survives the intended restart; cleanup runs
after every failure; and no developer workspace registry or production volume
is read or modified.

#### T2-E2E-021: Keyboard, Focus, Announcement, And Mobile Core Journeys

**Target:** both Playwright projects, with an accessibility snapshot or
axe-based check where practical.

Exercise keyboard-only Send/Stop, workspace selection, file attachment, memory
edit/conflict, skill editor, expert selection, SQL approval, workflow decision,
graph retrieval, review creation, and every destructive confirmation.

On mobile, repeat representative workspace, file, memory, skill, expert, SQL,
workflow, and graph journeys with long content.

Assert visible focus, logical tab order, focus trap and restoration, Escape and
backdrop behavior, accessible names/selected/expanded/disabled states,
`aria-live` announcements for progress/errors, no keyboard trap, minimum
usable touch targets, and no page-wide horizontal overflow at font-size bounds.

#### T2-E2E-022: Multi-Tab And Browser-Reload Consistency

**Target:** one Playwright context with two pages plus explicit reload cases.

Open the same workspace in two tabs. Concurrently rename/hide a session, edit a
memory, edit a skill, decide an approval, label a shadow run, and toggle a
plugin. Reload during a normal turn, RAG save/index, workflow decision, and
workspace switch.

Assert version-aware operations conflict instead of last-write-wins corruption;
idempotent decisions remain single; each tab converges after refresh/events;
reload never repeats an accepted mutation; in-progress operations resume or
show a truthful terminal/unknown state; and neither tab retains a stale active
workspace after a completed switch.

#### T2-E2E-023: Troubleshooting Messages Point To Real Recovery Actions

**Target:** Playwright failure fixtures plus fast documentation/command
contracts.

Trigger no providers, missing plugin, stale frontend version, memory stored but
not retrieved, memory not stored, inaccessible RAG path, no Markdown files,
failed RAG read, stale workflow panel, Mem0 authentication failure, and a
launcher port conflict.

Assert each state is distinguishable and points to the applicable action from
the guide: workspace/config check, plugin activation/restart, hard refresh and
port, memory-browser inspection, skills/triggers/cognition inspection, absolute
path/`.md`/log check, Refresh after restart, credential/volume diagnosis, or
port owner. Destructive `docker compose ... down -v` guidance must always keep
its data-loss warning adjacent and must never be executed automatically by the
test or UI.

## Suggested Implementation Order

1. Add T2-E2E-001 first. It tests a documented security boundary and is likely
   to fail against the current `0.0.0.0` bind.
2. Add per-workspace provider fixtures and runtime-generation tagging, then
   implement T2-E2E-002 and T2-E2E-003.
3. Add disposable workspace-manager and scheduler clocks for T2-E2E-004 and
   T2-E2E-006.
4. Add the cross-panel untrusted-text and denied-source canaries before
   expanding feature-specific error matrices.
5. Implement P1 tests alongside the relevant harness fixtures, keeping each
   delayed-response test deterministic with explicit release promises rather
   than time-based races.
6. Run the full lifecycle only on a dedicated Windows host with isolated ports,
   Docker resources, credentials, and cleanup.
7. Finish with multi-tab, mobile, accessibility, and troubleshooting contracts.

## Completion Criteria

The remaining guide contract should be considered substantially covered when:

- the WebUI is proven unreachable from non-loopback interfaces;
- a normal chat turn is proven to use a provider valid for the active workspace;
- successful workspace switching and deletion cannot leak or mutate old data;
- every protected action has browser-visible authorization, failure, and
  idempotency evidence;
- scheduled work executes through typed workflow and tool policy with durable
  history;
- user-controlled content cannot execute script through any display surface;
- every long-running operation has deterministic stale-response, cancellation,
  reload, and retry coverage;
- the full documented first-run lifecycle passes on disposable Windows CI; and
- keyboard/mobile users can complete the same core safety-critical decisions as
  desktop pointer users.
