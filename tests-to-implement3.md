# Third-Pass User-Guide End-to-End Test Audit

## Scope And Method

This is a fresh comparison of `userguide.md` with the automated tests in the
current working tree after the scenarios in `tests-to-implement.md` and
`tests-to-implement2.md` were implemented.

The audit inspected:

- all 78 Playwright definitions in
  `tests/webui/matbot-webui.spec.mjs`, using the shipped framework-free WebUI
  with `tests/webui/harness.mjs`;
- the Node entry points in `tests/*.test.mjs` and their production-runtime
  helpers;
- the real workspace-switch, memory, RAG, workflow, structured-data,
  evaluation, context-graph, source, connector, file-policy, scheduling, CLI,
  and loopback tests;
- the safety-gated Windows lifecycle tests in `tests/lifecycle.test.mjs`;
- the static guide contracts in `tests/userguide-contract.test.mjs`; and
- the live-provider README question suite, which is useful answer-quality
  evidence but is not a substitute for the user-guide journeys below.

The existing suite now covers every major guide area at least once. Therefore,
this document does not repeat completed happy paths such as creating a
conversation, workspace isolation for common records, file upload, memory CRUD,
SQL plan/approve/execute, workflow approval, graph retrieval, plugin rollback,
or the loopback listener. It concentrates on residual edge cases where a
representative test still leaves a security boundary, concurrency transition,
restart contract, or irreversible operation unproved.

Definitions used below:

- **Browser E2E** drives the public WebUI and asserts visible state plus public
  transport behavior.
- **Runtime integration** exercises production plugin/server code with
  disposable stores, files, ports, providers, and clocks.
- **Disposable-host E2E** may start Docker or mutate user-scoped configuration
  and must remain explicitly gated on a dedicated Windows worker.
- **Matrix fixture** means one parametrized test may cover several equivalent
  surfaces without creating a separate slow browser test for each value.

## Current Coverage After The Second Implementation

| User-guide area | Automated evidence already present | Remaining edge |
| --- | --- | --- |
| Install, secrets, start, health, and stop | Loopback-only production listener; static command contracts; repeatable stop; opt-in launcher and full Docker/secrets lifecycle tests. | The full lifecycle is safety-gated and does not yet complete a fake-provider turn, prove session persistence after a real restart, or diagnose an occupied port. |
| WebUI shell and responsive behavior | Desktop/mobile shell, sidebar, architecture navigation, typography persistence/bounds, keyboard tab wrapping, and one Escape/focus-restoration path. | Focus traps, live status announcements, long-content overflow, reduced motion, touch targets, and keyboard parity for approval flows remain. |
| Conversations and models | New/immediate conversation, streaming, tools, usage, interactive prompts, rename/hide/mark, Stop and ignored late completion, pre-accept failure retry, per-workspace providers, and missing-provider guidance. | Post-accept stream failure, reload during a turn or cancellation, provider-list outage, and reconciliation with a persisted terminal result are not covered. |
| Workspaces | Create, rename, switch, switch rollback, mutation lock, successful late-event rejection, deletion confirmation, broad logical cleanup, and common-resource isolation. | Delayed non-session responses, locked/interrupted physical deletion, junction ownership, active/only workspace deletion, and workspace-ID reuse need coverage. |
| Workspace files and host-file policy | Upload/open/delete, partial batch failure, delete retry, attachment precedence, clearing after accepted send, workspace isolation, broker root policy, index junction rejection, overwrite backup, and diff creation. | Empty/large/binary/duplicate uploads, failed-send attachment retention, hostile names, and an exact high-risk host-write approval journey remain. |
| Workspace RAG | Settings, progress, failure preservation, path normalization, Markdown ingestion, grounding, citations, workspace isolation, and stale/degraded warnings. | Empty/inaccessible folders, rename/delete reconciliation, mid-read failures, overlapping jobs, junction policy, and restart of the real backing store remain. |
| Memory | Capture/recall/restart/isolation, contextual search, CRUD/filtering, administrative fields, CAS conflict, two-tab conflict, dream time, provenance, and deduplication. | Pagination stability, delete conflict/outage, workspace switching with an edit open, and reload between write acceptance and refresh are missing. |
| Skills | Edit/save, metadata, triggers, delete confirmation, workspace isolation, offline editor behavior, and save-failure retry. | Unsaved-change navigation, trigger validation/atomicity, concurrent edits, and delayed responses after a workspace switch are missing. |
| Expert Panel | All/selected experts, Parallel/Review/Debate metadata, synthesis on/off, expert-root isolation, empty selection, unknown expert, and one partial timeout. | Stop fan-out, synthesis-only failure, workspace-specific expert discovery, and switching workspaces during fan-out remain. |
| Sources and health | List/detail/citation/events, slow health, stale/degraded state, partial refresh recovery, runtime versions and access events, plus a denied Graph canary. | A denied source has not been traced through every downstream evidence surface; list/selection/refresh races and recovery from a changing health state remain. |
| Governed SQL | Plan/approve/execute/citation, stage retry, stale-plan rejection, approval invalidation, double-execute defense, and extensive read-only/token/runtime validation. | Expiry/revocation policy, connection loss and timeout, form boundary matrix, hostile cell rendering, and reconnect/replan behavior remain. |
| Workflow Operations Center | Overview/library/ledger/approval/shadow, compilation, start, failure rendering, idempotent decisions, stale selection, partial service recovery, mobile ledger, typed inputs, immutable versions, all gate types, and policy enforcement. | Browser-level sequential multi-gate decisions, version/mode comparison, exact filtering, and duplicate external-action recovery remain. |
| Evaluation and ROI | Trace waterfall, safe replay, suite pass/fail, release-blocking UI, CLI exit/JUnit, backend redaction/scorers/cost, verified outcomes, and finite negative/zero-cost ROI. | Redaction is not asserted in browser/report output; replay reconstruction failure, overlapping selection, and refresh outage are missing. |
| Context Graph | Retrieval/selection/evidence/citations, empty and transient failures, term normalization, overlapping retrieval protection, refresh, runtime extraction/deduplication/versions, and denied-source filtering. | Source constraint fidelity, malformed partial records, Unicode normalization, and Refresh overlapping a retrieval remain. |
| Durable expert reviews | Create/detail/validation/retry, structured fields, workspace isolation, and runtime persistence. | Target-type matrix, mismatched IDs, unknown experts, reload fidelity, detail failure/stale selection, and concurrent duplicate creation remain. |
| Plugins | Activation/deactivation, incompatibility, tool invocation, failed add/remove rollback, core protection, missing-sessions warning, and workspace isolation. | Boot-sensitive copy, real restart persistence, concurrent mutation, and provider/frontend/store removal consequences remain. |
| Scheduled and unattended actions | Duration validation, create/list/suspend/resume/cancel, principal/provider visibility, unsafe wildcard rejection, supplied-store persistence, and workspace isolation. | No scheduled child has yet proved workflow/tool/approval enforcement, durable execution history, missed-run policy, retry policy, or exact-once behavior. |
| Safety and troubleshooting | Loopback listener, common isolation rules, file roots/backups, denied Graph data, SQL/workflow enforcement, provider guidance, static destructive warning, and several panel retry states. | Cross-surface hostile content, cross-surface denied evidence, exact host-write approval, secret non-disclosure, and most operational diagnosis branches remain. |

## Missing Tests To Implement

The scenarios below are ordered by the risk of data disclosure, wrong-workspace
mutation, unauthorized action, duplicate external action, or misleading
evidence. Each scenario describes the additional slice that is still missing;
it should be implemented without deleting the narrower coverage that already
exists.

### P0 — Security Boundaries And Irreversible Operations

#### T3-E2E-001: Sanitize Untrusted Content On Every Rendered Surface

**Guide contract:** Workspace content, files, memories, skills, source evidence,
queries, workflows, graph facts, reviews, and plugin metadata must remain
workspace-scoped data. Displaying that data must not execute it.

**Why this is still missing:** T2-E2E-005 proves only workspace and session
names are inert. Other panels render Markdown, URIs, citations, error strings,
SQL values, aliases, and plugin descriptions through different code paths.

**Layer and fixtures:**

- Add a matrix fixture to `tests/webui/harness.mjs` that places a unique canary
  in a file name, attachment name, memory fact, skill name/content, source
  title/URI/citation, health message, SQL cell, workflow purpose/action/error,
  evaluation span attribute, graph alias/evidence span, review field, expert
  answer, and plugin description.
- Include HTML event handlers and unsafe URLs such as `javascript:`,
  `data:text/html`, protocol-relative URLs, mixed-case schemes, entity-encoded
  schemes, and Markdown image/link payloads.

**Steps:**

1. Define `window.__cortexXssCanary = 0` before loading the fixtures.
2. Open each affected panel, list, detail view, transcript, attachment chip,
   error banner, and Markdown-rendered field.
3. Click every rendered link or control derived from the hostile values where
   doing so is safe; prevent real navigation at the Playwright context level.
4. Reload the page and revisit persisted transcript, memory, skill, workflow,
   and review content.

**Assertions:**

- `window.__cortexXssCanary` remains `0`, no unexpected page or popup opens,
  and no request is issued to a canary origin.
- Text values remain readable as text. Allowed `http`/`https` links receive
  safe target/rel handling; unsafe schemes are removed or rendered inert.
- No hostile value can create a new button, form control, dialog, script,
  style, or ARIA relationship.
- Sanitization is identical before and after persistence/reload.

#### T3-E2E-002: Fence Every Delayed Response By Workspace Generation

**Guide contract:** Switching workspaces changes the complete isolation
boundary. Old sessions, files, memories, skills, sources, runs, and settings
must not appear or mutate the destination workspace.

**Why this is still missing:** T2-E2E-003 rejects a late session-stream event,
but ordinary fetches and mutations have independent response handlers.

**Layer and fixtures:**

- Extend the WebUI harness with explicit, promise-controlled response gates.
  Do not use arbitrary sleeps.
- Parameterize delayed responses for provider discovery, session list/detail,
  file list/open/upload/delete, memory list/save/delete, skill load/save,
  RAG status/save, source list/detail/health, SQL plan, workflow lists/detail,
  evaluation detail, graph retrieval, review detail, and plugin add/remove.

**Steps:**

1. In workspace A, start one delayed read or mutation and record its request
   workspace/generation.
2. Switch successfully to workspace B while the request is held.
3. Release A's response after B has fully rendered.
4. Repeat for a delayed failure as well as a delayed success.
5. For mutations, inspect both harness stores after completion.

**Assertions:**

- No A content, status message, selection, attachment, approval token, or error
  appears in B.
- A mutation is either rejected during switching or completes only in A; it is
  never replayed against B.
- B controls are not re-enabled by A's completion, and B's current selection
  remains stable.
- The browser makes no follow-up request that combines A's object ID with B's
  active workspace.

#### T3-E2E-003: Make Physical Workspace Deletion Recoverable And Ownership-Safe

**Guide contract:** Confirmed deletion removes the named workspace's local
files and is destructive, while other workspaces remain intact.

**Why this is still missing:** The harness proves logical records are removed,
but it does not exercise directory locks, interrupted recursive deletion,
junctions, active-workspace rules, or identifier reuse.

**Layer and fixtures:**

- Add a disposable workspace-manager runtime integration test using temporary
  registry and workspace roots.
- Use a sibling sentinel directory outside the managed root and, on Windows,
  create a junction inside the disposable workspace that points at the
  sentinel.
- Inject a deterministic filesystem failure after at least one owned file has
  been processed.

**Steps:**

1. Create workspaces A and B with same-named files and records.
2. Attempt to delete the only workspace and then the active workspace; assert
   the documented/fail-safe policy.
3. Switch to A and delete inactive B while one B file is locked.
4. Verify the registry and disk state after the injected partial failure.
5. Release the lock and retry deletion.
6. Recreate a workspace using B's former display name and attempt an explicit
   ID-reuse fixture.

**Assertions:**

- The confirmation target and backend target are the same immutable workspace
  ID, not merely the display name.
- A failed deletion is reported as incomplete and never silently removes the
  registry entry while owned data remains, unless a tombstone/recovery state is
  explicitly implemented and visible.
- The external junction target and A's data are untouched.
- Retry converges to a clean deletion without deleting newly created data.
- Active/only-workspace behavior is deterministic and cannot leave Cortex with
  an invalid active registry entry.

#### T3-E2E-004: Bind High-Risk Host Writes To Exact Approval And Resolved Path

**Guide contract:** Host file access is constrained by configured roots.
File-broker creates backups and diffs for overwrites and requires explicit
approval for high-risk writes.

**Why this is still missing:** Existing tests separately prove root policy and
backup/diff creation. They do not prove an approval journey, approval
specificity, path re-resolution, or protection against a target changing
between review and write.

**Layer and fixtures:**

- Run the production file-broker and Matbot client against temporary roots and
  backup storage.
- Include normal, high-risk-extension, denied-fragment, mixed-case,
  trailing-dot/space, UNC/device-style, and junction paths where supported.
- If approval is currently represented only by a boolean, this test should
  expose that weakness and motivate a token bound to resolved path, operation,
  content hash, principal, workspace, and expiry.

**Steps:**

1. Request a high-risk overwrite without approval and capture the review
   payload.
2. Change the path, content, principal, or workspace and try to reuse the
   approval.
3. Replace a reviewed path component with a junction before execution.
4. Execute the exact approved overwrite once, then retry the same approval.
5. Inspect the target, backup, diff, and audit record.

**Assertions:**

- Unapproved, expired, altered, cross-principal, cross-workspace, and replayed
  writes fail without touching any file.
- Authorization uses the final resolved target and cannot escape through a
  junction, UNC alias, device path, case variant, or time-of-check/time-of-use
  replacement.
- The exact approved write happens once, returns an accurate diff, and stores a
  readable backup outside the target tree.
- Logs and browser output do not expose approval secrets.

#### T3-E2E-005: Execute Scheduled Work Exactly Once Through Normal Policy

**Guide contract:** Scheduled prompts should be thin triggers for typed
workflow execution; tool permissions, approvals, history, and failure handling
must be reviewed before unattended use.

**Why this is still missing:** T2-E2E-006 covers schedule management,
identity, supplied-store persistence, and isolation, but never lets a scheduled
child execute.

**Layer and fixtures:**

- Refactor the background plugin to accept a fake clock and injectable child
  launcher or use a small production-faithful launcher seam.
- Capture child environment, effective principal/provider, tool registrations,
  workflow calls, approvals, output files, exit status, and execution history.
- Use a typed workflow fixture with one read action and one protected write.

**Steps:**

1. Create a schedule as principal A in workspace A with only the read tool
   enabled; advance the clock to its due time.
2. Confirm the typed workflow begins and the protected write stops at its
   approval gate.
3. Approve as the wrong principal, then as the authorized principal.
4. Crash/restart the scheduler immediately before due, during child launch,
   and after the external action but before history persistence.
5. Advance over several missed intervals and exercise transient/non-transient
   child failures, suspension during execution, resume, and cancellation.
6. Create an equivalent schedule in workspace B and prove independent history.

**Assertions:**

- The child inherits only A's provider, principal, workspace config, and
  permitted tools; the background plugin does not recursively arm schedulers.
- Protected work cannot execute before the exact approval and cannot be
  approved from B or by an unrelated principal.
- Each logical occurrence has a durable idempotency key and at most one
  external action, including crash windows and duplicate timer delivery.
- Missed-run and retry behavior is explicit and deterministic. If product
  policy is not yet defined, choose and document either skip or a single
  catch-up; never silently launch an unbounded backlog.
- History records scheduled time, actual start/end, status, attempt, workflow
  run, approval, error, and output reference without leaking secrets.

#### T3-E2E-006: Propagate Denied-Source Policy Through Every Evidence Product

**Guide contract:** Sources carry sensitivity and permission metadata, and
denied evidence must not be silently used by retrieval, queries, workflows, or
decisions.

**Why this is still missing:** T2-E2E-013 proves a denied canary is absent from
one Graph browser result. The same source can feed RAG, contextual search,
citations, SQL metadata, workflows, evaluations, and reviews.

**Layer and fixtures:**

- Seed one allowed source and one denied source with unique canaries and linked
  versions.
- Route both sources through source list/detail, Workspace RAG, contextual
  search, expert knowledge, Graph, SQL catalogue/query citation, workflow
  evidence, trace/replay, sponsor evidence, and durable review fixtures.

**Steps:**

1. Retrieve the same concept through each product surface as an unprivileged
   principal.
2. Attempt direct lookup with the denied source ID and version ID.
3. Change permission from allowed to denied between planning and execution.
4. Repeat as an explicitly authorized principal where the product supports
   permissioned access.

**Assertions:**

- The denied canary never appears in content, snippets, counts, aliases,
  citations, warnings that quote content, traces, replay, exports, or errors.
- Direct ID lookup fails without confirming sensitive content or metadata
  beyond a safe denial.
- SQL/workflow approval is invalidated if evidence permission changes before
  execution.
- Authorized access, when supported, records principal, source version,
  permission decision, and access event.

#### T3-E2E-007: Keep Credentials Out Of Browser, Logs, Stores, And Reports

**Guide contract:** Real credentials must not be placed in documentation,
chat, committed workspace files, or `matbot.yaml`; setup and runtime should
treat them as secrets.

**Why this is still missing:** The gated lifecycle checks setup output and
backend evaluation tests redact selected attributes, but there is no
cross-product non-disclosure canary.

**Layer and fixtures:**

- Use synthetic secret canaries matching supported credential shapes; never use
  a real key.
- Inject them through provider configuration errors, tool input/output, source
  content, file indexing, workflow action errors, evaluation attributes, CLI
  failure payloads, and process environment.
- Capture stdout/stderr, Matbot logs, browser responses/DOM, persisted JSON,
  trace/replay data, sponsor reports, JUnit, and generated diffs/backups.

**Steps:**

1. Exercise successful and failing paths for each injection point.
2. Restart production services over disposable stores and reload the WebUI.
3. Search every captured artifact and HTTP response for raw and
   JSON/URL/base64-encoded forms of the canary.

**Assertions:**

- Raw or trivially encoded secret values never appear in user-visible errors,
  logs, traces, replay, reports, JUnit, memory/RAG indexes, or workspace state.
- Redaction preserves enough field context to diagnose the failure.
- Non-secret values that merely contain words such as `token` or `key` are not
  over-redacted.
- Setup and cleanup restore the pre-test environment even when an assertion
  fails.

### P1 — Concurrency, Recovery, And Evidence Integrity

#### T3-E2E-008: Recover Provider Discovery Without Losing A Valid Selection

**Guide contract:** Provider choices come from the active workspace and changing
the selection affects later normal turns.

**Missing slice:** Per-workspace routing and the empty-provider case are covered,
but temporary provider-list failure and a list changing during use are not.

**Test:** Delay or fail provider discovery on initial load, refresh, and
workspace switch. Keep the last known valid selection visible but clearly mark
it unavailable until confirmed; do not silently route a turn through a provider
from another workspace. Then recover with a reordered list, a removed selected
provider, and a new provider. Assert deterministic fallback, workspace-scoped
preference persistence, an actionable status, and that the next stored normal
turn contains exactly the provider visibly selected when Send was accepted.

#### T3-E2E-009: Reconcile Accepted Turns After Stream Disconnect And Reload

**Guide contract:** Accepted turns stream tool activity and terminal usage;
Stop aborts the request and drops queued work.

**Missing slice:** Pre-accept retry and late completion after Stop are covered.
Post-accept network loss can still produce duplicate user messages, duplicate
tools, or a permanently busy composer.

**Test:** Add a server-side turn ID/idempotency key and fixtures for disconnect
after acceptance, after partial text, during a tool, after terminal persistence
but before terminal SSE, and during cancellation. Reload or open a second tab,
then reconcile against persisted session state. Assert one user message, at
most one external tool action, ordered/non-duplicated transcript content,
correct terminal or interrupted state, no fabricated usage, restored composer
controls, and a retry that creates a new turn only when the first turn is
confirmed non-terminal.

#### T3-E2E-010: Cover File Boundaries, Collision Policy, And Attachment Recovery

**Guide contract:** Uploaded workspace copies can be attached, opened, and
deleted; attachments clear only after the message is accepted.

**Missing slice:** Common text files, partial batches, delete recovery, and
same-name RAG precedence are covered.

**Test matrix:** Upload zero-byte, one-byte, exact-limit, limit-plus-one,
Unicode/reserved-character, very long name, no-extension, binary, misleading
MIME, and duplicate-name files. The product must define a collision policy
(reject, version, or explicit replace); the test should prohibit silent
overwrite regardless of the choice. Attach multiple files, then simulate
pre-accept failure, post-accept failure, one file disappearing before Send, and
workspace switching with chips present. Assert per-file outcomes, bounded
error text, inert filenames, correct bytes/MIME on open, no host-path access,
attachment retention until acceptance, clearing exactly once after acceptance,
and no chip or file leakage into the next workspace.

#### T3-E2E-011: Reconcile RAG Renames, Deletes, Failures, And Overlapping Jobs

**Guide contract:** Workspace RAG indexes accessible Markdown from configured
absolute folders and reports ingestion progress and final status.

**Missing slice:** Normal ingestion and normalized path deduplication are
covered, but stale chunks can survive file/folder removal or an older job can
overwrite a newer configuration.

**Test:** Use a disposable corpus containing Markdown, uppercase/lowercase
extensions, non-Markdown files, an empty directory, unreadable file, deleted
file, renamed file, duplicate content, and a junction leaving the configured
root. Gate two ingestion jobs: save config A, then config B, and finish A last.
Restart the RAG service over the same backing store. Assert the newest job owns
status and active context; removed/renamed chunks reconcile without ghosts;
non-Markdown and escaped paths are not indexed; partial read failures are
reported without treating a partial corpus as fully healthy; citations use the
current canonical path/version; and B persists after restart.

#### T3-E2E-012: Complete Memory Pagination, Delete CAS, And Workspace Handoff

**Guide contract:** The browser can search/filter, inspect provenance and
administrative fields, edit with version awareness, and delete workspace-scoped
facts.

**Missing slice:** Existing coverage uses small lists and proves update CAS, not
stable pagination or delete recovery.

**Test:** Seed more facts than one page with equal timestamps and stable IDs.
Page forward/back while filtering processing state and search text; insert and
delete records between pages. Open an edit, switch workspaces, and release a
delayed save. Exercise delete with a stale version, transient `503`, and a
response lost after successful deletion. Assert no duplicates/gaps for a
stable snapshot or an explicitly documented cursor contract, correct total and
selection, no stale edit applied after switching, visible current-record data
on conflict, idempotent delete retry, and no resurrection after reload.

#### T3-E2E-013: Make Skill Content And Trigger Changes Atomic

**Guide contract:** Skill Markdown, triggers, and metadata are
workspace-specific and changes affect later activation.

**Missing slice:** Save failure preserves content, but trigger partial failure,
unsaved navigation, concurrent editing, and workspace switching are unproved.

**Test:** Change content and several trigger rows, including empty, duplicate,
malformed, oversized, and unsupported trigger kinds. Attempt Close, selecting
another skill, deleting, opening another panel, browser navigation, and
workspace switch with unsaved edits. In two tabs, save different content and
trigger versions. Inject a failure after content write but before trigger
write. Assert an explicit Save/Discard/Cancel decision, focus restoration,
version conflict without overwrite, all-or-nothing content+trigger persistence
or a visible recoverable transaction state, no triggers activated from a
failed save, and no delayed A response rendered or written in B.

#### T3-E2E-014: Cancel Expert Fan-Out And Survive Synthesis-Only Failure

**Guide contract:** Experts run independently, optional synthesis combines
their results, and knowledge roots remain isolated.

**Missing slice:** One expert timeout is covered, but Stop, workspace change,
and synthesis failure may leave child work running or discard useful answers.

**Test:** Gate experts so they finish in different orders. Stop after one
success, during all requests, and during synthesis; switch workspaces while
requests are active. Separately let all experts succeed and fail only
synthesis. Assert abort signals reach every unfinished expert and the
synthesizer; no late A answer enters B; completed opinions remain clearly
marked as partial without fabricated consensus; synthesis failure retains
independent evidence and offers a bounded retry that does not rerun experts;
and workspace-specific expert/provider lists are reloaded before the next
panel run.

#### T3-E2E-015: Expire SQL Approval And Recover From Database Failure

**Guide contract:** SQL is bounded, read-only, separately approved, and the
approval token belongs to the exact planned run.

**Missing slice:** Invalid/reused/tampered tokens and stale plans are covered,
but no time-based expiry/revocation, connection outage, or full form boundary
matrix exists.

**Test:** Use an injectable clock and fake Postgres transport. Plan/approve,
then execute just before and after expiry; revoke approval; change catalogue or
source permission; drop the connection before and during execution; return a
timeout and malformed row containing hostile text. Parameterize empty/Unicode/
unknown identifiers, filter operators, zero/negative/max/max-plus-one limits,
large values, nulls, and multi-byte text. Assert expired/revoked/stale approval
cannot execute, no automatic reapproval, retry requires a new plan when
semantics changed, connection errors retain safe plan context but no token,
cancel reaches the driver, partial rows are not presented as complete, and all
cells render inertly with correct null/numeric types.

#### T3-E2E-016: Prove Workflow Versions, Multi-Gates, And External Idempotency In The Browser

**Guide contract:** Published versions are immutable; modes differ; high-risk
workflows may have several independent gates; approved proposals are not proof
of successful external action.

**Missing slice:** Runtime tests cover these rules individually and the browser
shows one failed post-approval action, but the full user decision sequence is
not connected in one journey.

**Test:** Compile and publish v1, publish changed v2, and start dry-run, shadow,
and approval-gated runs from each. For one high-risk run, decide action,
stale-source, risk, cost, confidence, and expert-review gates in a controlled
order, including rejection and duplicated browser submissions. Lose the
response after one external action and reload. Assert each run remains pinned
to its immutable version; filters find exact workflow/run/status values;
dry-run and shadow never execute write/admin tools; approval state and ledger
events advance monotonically; rejection prevents later execution; and a
durable action idempotency key prevents a second external write after reload or
retry while still showing the actual first result.

#### T3-E2E-017: Redact Evaluation UI And Recover Replay/Selection Failures

**Guide contract:** Safe replay reconstructs stored history without executing
writes; sponsor evidence counts only verified outcomes and must present honest
cost/benefit evidence.

**Missing slice:** Backend redaction and UI happy paths are covered separately.

**Test:** Seed trace names, attributes, evaluator explanations, workflow
payloads, suite cases, sponsor fields, and replay errors with secret/hostile
canaries. Gate two trace/detail/suite requests and complete the older one last.
Make replay reconstruction fail because spans are missing/cyclic, and fail a
Refresh after usable data is visible. Assert no canary in DOM/export/clipboard,
old responses do not replace the current selection, replay failure executes no
tool and explains incomplete evidence, existing cards remain usable after
refresh failure, unverified outcomes contribute zero benefit, and null,
negative, very large, and rounding-boundary ROI/payback values remain finite
and internally consistent.

#### T3-E2E-018: Validate Graph Source Constraints And Malformed Partial Records

**Guide contract:** Graph retrieval accepts multiple terms and an optional
source constraint; relationships are derived assertions with evidence and
confidence, not authoritative facts.

**Missing slice:** Term deduplication and overlapping retrieval are covered,
but not source fidelity or malformed records.

**Test:** Query Unicode/case/whitespace-equivalent terms with and without a
source constraint. Return a mixture of valid entities and relationships plus
missing endpoints, duplicate aliases, self-edges, out-of-range/NaN confidence,
unknown source versions, malformed evidence spans, and denied edges. Start
Retrieve, then Refresh before it finishes. Assert the request contains the
canonical distinct terms and exact source ID; results never escape that source;
valid partial data remains inspectable while malformed/denied records are
excluded with a safe warning; confidence is bounded and labelled as derived;
selection never points at an absent endpoint; and a late Retrieve cannot undo
the newer Refresh state.

#### T3-E2E-019: Complete Review Target Validation And Concurrent Creation

**Guide contract:** Durable reviews can target workflows, runs, alerts,
investigations, or decisions and preserve structured recommendations, evidence,
risks, checklist, consensus, and disagreement.

**Missing slice:** One target path and workspace isolation are covered.

**Test:** Parameterize every target type with required/forbidden combinations
of target ID, workflow ID, and run ID. Include unknown experts, mismatched
workflow/run IDs, missing targets, duplicate expert IDs, and long/hostile
questions. Create the same logical review concurrently in two tabs, lose one
response after acceptance, reload, switch selections while detail is delayed,
and fail detail refresh. Assert validation is target-specific, references
belong to the active workspace, duplicate submission is idempotent or visibly
creates distinct intentional records, reload preserves all structured fields
and evidence versions, a late detail cannot replace the selected review, and a
detail failure keeps the list and retry usable.

#### T3-E2E-020: Verify Boot-Sensitive Plugin Changes Across A Real Restart

**Guide contract:** Plugin configuration is workspace-specific and plugins that
add boot-time services, hooks, stores, providers, or frontend behavior require
a restart.

**Missing slice:** Harness add/remove and rollback are covered, but the harness
does not boot a new Matbot process from persisted configuration.

**Test:** In disposable workspace configs, add/remove one tool-only plugin and
one plugin from each available boot-sensitive class (provider, store/hook, and
frontend/service where safe). Issue concurrent add/remove from two tabs, inject
config-write failure, then restart the real runtime twice. Assert the UI
distinguishes immediately effective from restart-required changes; config
writes are atomic and deduplicated; tools/providers are neither advertised too
early nor left stale after restart; failed writes leave the old process and
config consistent; another workspace is unchanged; core dependencies cannot be
removed indirectly; and two restarts converge to the same loaded set.

### P2 — Disposable Lifecycle, Accessibility, And Diagnosis

#### T3-E2E-021: Finish The Disposable Windows Lifecycle With A Real Turn

**Guide contract:** Secrets setup, launcher, Docker-backed services, WebUI,
health check, persistent conversations, and stop should work together.

**Missing slice:** T2-E2E-020 reaches full health but intentionally stops before
a provider-backed turn and persistence assertion.

**Test:** On a dedicated Windows worker, supply a local fake OpenAI-compatible
provider and isolated Docker project/ports/roots. Run secrets setup in a fresh
shell, start Cortex from an unbuilt checkout, create a workspace and normal
conversation through Playwright, upload/attach a file, store/recall a memory,
stop, start again, and reopen the conversation. Also run the launcher while
the WebUI port is occupied and repeat `run.ps1`/`stop-local-agent.ps1`.
Assert health covers each required service, the fake provider receives the
visible provider and attachment context, session/memory/workspace data survive
restart, no real user state or credentials are touched, port-conflict output
identifies the problem without killing an unrelated process, repeated start/
stop is idempotent, and final cleanup restores the host snapshot.

#### T3-E2E-022: Give Keyboard And Mobile Users Full Safety-Critical Parity

**Guide contract:** The narrow-screen sidebar and WebUI controls expose the
same conversations, workspace, files, approvals, and architecture features.

**Missing slice:** Mobile navigation and one destructive-dialog Escape path are
covered, not completion of the critical journeys.

**Test:** On desktop keyboard-only and the mobile project, create/switch a
workspace, upload/attach/remove a file, open/edit memory and skill content,
plan/approve SQL, decide workflow approval, label shadow output, inspect source
evidence, and confirm/cancel deletion. Include long localized names, zoom/text
scaling, a software-keyboard-sized viewport, reduced motion, and high-contrast
media settings. Assert logical tab order, visible focus, dialog focus trap and
return, Escape behavior, labelled controls, live announcements for busy/
progress/error/success, no focus behind the mobile drawer, minimum touch target
size, no clipped decision evidence or horizontal page overflow, and that every
irreversible action remains distinguishable from cancellation.

#### T3-E2E-023: Make Troubleshooting States Diagnostically Distinct

**Guide contract:** The troubleshooting section gives different recovery steps
for missing providers/plugins, stale frontend, memory storage versus retrieval,
RAG path/corpus/read failures, stale panels, Mem0 credential mismatch, and
launcher problems.

**Missing slice:** The browser currently proves actionable missing-provider
text and several generic retry states, but not that different root causes lead
to the correct non-destructive next action.

**Test matrix:** Trigger provider-list outage versus empty configuration;
required plugin absent versus boot-sensitive restart pending; frontend build
version mismatch; memory absent versus stored-but-not-retrieved; RAG relative,
inaccessible, empty, non-Markdown-only, and partial-read states; stale workflow
data after a workspace restart; Mem0 unreachable versus authentication failure;
and an occupied WebUI port. Assert each message identifies the failed layer,
names only applicable actions from the guide, preserves usable data/forms,
links or points to the correct panel/log/port, never recommends destructive
volume deletion for a transient outage, and always places the data-loss warning
adjacent to any `down -v` recovery instruction. No test may automatically run
the destructive command.

## Cross-Cutting Fixture Work

Implementing the scenarios efficiently requires a few reusable seams rather
than one-off sleeps or route mocks:

1. Add a harness request-gate registry keyed by operation and workspace. Tests
   should explicitly release old/new responses to prove ordering.
2. Add a workspace-generation value to every browser async operation and
   mutation, then expose request history through test-only harness endpoints.
3. Add deterministic fixtures for hostile text/URLs, denied-source canaries,
   secret canaries, response-loss-after-commit, and idempotency keys.
4. Add injectable clocks and launchers to background scheduling and approval
   expiry code. The default production path must continue to use real time and
   the real child launcher.
5. Use temporary real filesystem roots for workspace deletion, RAG, and
   file-broker tests. Junction/device/UNC cases must be platform-gated with an
   explicit skip reason when Windows privileges or features are unavailable.
6. Give workflow actions, scheduled occurrences, chat turns, review creation,
   file mutation, and other retryable writes durable idempotency identifiers
   that can be asserted after response loss.
7. Keep disposable-host lifecycle tests behind all existing isolation gates;
   snapshot and restore environment/configuration in `finally` even when setup
   or assertions fail.

## Suggested Implementation Order

1. Implement the shared workspace-generation and deterministic response-gate
   fixtures, then add T3-E2E-002. This prevents later panel-specific race tests
   from duplicating infrastructure.
2. Add the hostile-content, denied-source, and secret canary matrices
   (T3-E2E-001, T3-E2E-006, and T3-E2E-007) before expanding feature-specific
   browser tests.
3. Implement the irreversible-operation runtimes:
   T3-E2E-003, T3-E2E-004, and T3-E2E-005.
4. Add response-loss/idempotency support and cover conversations, workflows,
   reviews, and files.
5. Complete the RAG, memory, skill, expert, SQL, evaluation, graph, and plugin
   recovery matrices with explicit gates rather than timing sleeps.
6. Run T3-E2E-021 only in disposable Windows CI after its fake provider,
   Docker project names, ports, user environment, and cleanup have been
   isolated.
7. Finish with keyboard/mobile parity and the non-destructive troubleshooting
   matrix.

## Completion Criteria

The user-guide contract should be considered deeply covered when:

- untrusted, denied, or secret content cannot leak through any rendered,
  persisted, replayed, logged, or exported evidence surface;
- every async response and mutation is fenced to the workspace generation that
  initiated it;
- destructive deletion and host writes are bound to the exact reviewed target,
  recover safely after interruption, and cannot escape through Windows path
  aliases or junctions;
- scheduled occurrences and protected workflow actions are durable,
  policy-bound, and externally idempotent across crash windows;
- accepted chat turns reconcile after disconnect/reload without duplicate
  messages or tools;
- RAG, memory, skill, provider, expert, SQL, workflow, evaluation, graph,
  review, and plugin state remains correct under overlapping operations,
  restart, and response loss;
- the full first-run lifecycle completes a fake-provider turn and proves
  persistence on a disposable Windows host; and
- keyboard and mobile users receive the same evidence, focus behavior,
  announcements, and guarded decisions as desktop pointer users.

## Implementation Outcome — 2026-07-30

All 23 recommended scenario IDs now have automated coverage. The implementation
deliberately distinguishes complete coverage from a representative risk slice:
several recommendations describe large fault-injection matrices that should
continue to be expanded rather than being treated as exhausted by one passing
case.

| Scenario | Implemented automated evidence | Coverage status and remaining breadth |
| --- | --- | --- |
| T3-E2E-001 | `tests/webui/matbot-webui.spec.mjs` injects hostile Markdown, mixed-case JavaScript and protocol-relative URLs, a remote image, hostile file name, and hostile Graph labels. It asserts inert DOM output, no remote canary request, removed event handlers/unsafe links/images, safe HTTPS link handling, no created Graph element, and a zero execution canary. The WebUI now sanitizes `marked` output and uses text nodes for the tested non-Markdown surfaces. | **Representative.** File, transcript Markdown, and Graph paths are covered. The full memory/skill/source/SQL/workflow/evaluation/review/plugin matrix and persistence reload variants remain useful additions. |
| T3-E2E-002 | A promise-gated file-list response is initiated in workspace A, workspace B is rendered, and A's late result is released. The test proves the old canary cannot replace B's file list. Production code now increments a workspace generation and fences provider, file, plugin, and skill responses while invalidating other outstanding request counters and attachments on switch. | **Representative.** A deterministic delayed-response proof exists and the common browser seams are protected. Each mutation and every architecture panel should still receive its own delayed success/failure matrix. |
| T3-E2E-003 | `tests/workspace-deletion-runtime.mjs` imports the production `FileWorkspaceManager` with temporary registry/config roots. It rejects active deletion, deletes only the exact inactive ID, preserves an external junction sentinel, and permits clean display-name/ID reuse after deletion. | **Representative.** Ownership, active-workspace, junction, and reuse boundaries are covered. Locked files, injected partial recursive failure, tombstone recovery, and only-workspace policy need further platform-specific fixtures. |
| T3-E2E-004 | `tests/file-broker-approval-runtime.mjs` starts the real broker against disposable policy/config roots. It proves an unapproved high-risk `.ps1` overwrite returns `409` without mutation, the approved exact overwrite creates a backup and diff, and a junction escape returns `403`. `evaluateRealAccess` now re-resolves the target before broker operations. | **Representative and exposes a product limit.** The current broker approval remains a boolean rather than a single-use token bound to path, content hash, principal, workspace, and expiry. Token alteration/replay, UNC/device aliases, TOCTOU replacement, and audit-secret assertions remain to implement with that stronger product contract. |
| T3-E2E-005 | `tests/scheduled-execution-runtime.mjs` uses the production background plugin with an injectable launcher/startup delay. It records one due occurrence, inherited provider/principal, a thin workflow prompt, terminal status/exit code, stable occurrence ID/run count, persistence, suspend, and cancel behavior. | **Representative.** The scheduling seam and durable occurrence history are covered. Real workflow/tool execution, approval enforcement, crash windows, missed-run policy, retry attempts, output references, and cross-workspace histories remain. |
| T3-E2E-006 | The browser injects a denied-source canary and visits Sources, Graph, Evaluation, Reviews, and Workflows, asserting the canary is absent from every rendered product surface while allowed Graph evidence remains usable. | **Representative.** This proves a cross-panel browser absence contract, not the full backend propagation matrix through RAG, contextual search, expert retrieval, SQL, replay, or exports, nor permission changes between plan and execution. |
| T3-E2E-007 | `tests/evaluation-cli.test.mjs` injects a synthetic credential into evaluation errors/output and proves it is absent from stdout, stderr, and JUnit while a redaction marker remains. Evaluation-observability and `scripts/evaluate.mjs` now redact sensitive field names and common secret value patterns recursively. | **Representative.** Evaluation report/log output is covered. File-broker logs, scheduler history, transcripts, backups, exports, browser storage, process listings, and remaining secret formats still need a repository-wide canary matrix. |
| T3-E2E-008 | A WebUI route fixture fails provider discovery once and then recovers with a changed list. The test proves a valid current selection survives the transient failure, actionable unavailable state is shown, and recovery chooses the deterministic available provider. | **Covered for the specified browser recovery path.** Initial-load failure and transient refresh are implemented; multi-workspace and rapid successive discovery changes can be expanded. |
| T3-E2E-009 | The harness can hold an accepted slow turn and complete it idempotently through a test endpoint. The browser reloads after acceptance, observes the busy state, completes the stored turn, reloads again, and proves exactly one user and one assistant message with restored controls. | **Representative.** Acceptance/reload/terminal reconciliation is covered. Disconnect during tool execution, partial text, lost cancellation response, duplicate external-action defense, and second-tab reconciliation remain. |
| T3-E2E-010 | The browser uploads zero-byte and binary files, verifies exact Base64 bytes, refuses a duplicate-name replacement through an explicit collision dialog, and proves a selected attachment and prompt survive a pre-accept send failure. Production upload now requires confirmation before replacement. | **Representative.** Empty/binary/collision/failed-send paths are covered. Exact size boundaries, MIME deception, reserved/very long names, disappeared files, multi-attachment partial failure, post-accept loss, and workspace handoff remain. |
| T3-E2E-011 | The real Workspace RAG runtime indexes a disposable corpus, excludes non-Markdown content, renames a Markdown file, runs `reindex_now`, and proves the old chunk disappears while the new canonical path is searchable. | **Representative.** Rename reconciliation and non-Markdown exclusion are covered. Empty/inaccessible folders, deletion, partial reads, overlapping jobs, junctions, duplicate content, case variants, and real backing-store restart remain. |
| T3-E2E-012 | The browser seeds 55 equal-purpose memories, exercises the 50-record page boundary/load-more count, injects one stale delete result, proves the selected fact is retained with an explanatory status, retries, and reaches 54 records. | **Representative.** Pagination and delete-CAS recovery are covered. Stable cursor behavior under concurrent inserts/deletes, filters, transient `503`, lost successful response, workspace handoff, and reload idempotency remain. |
| T3-E2E-013 | The browser edits skill Markdown through the actual editor API, rejects the first close confirmation and proves content remains, then explicitly accepts discard. Production close/cancel handlers now cannot mistake a DOM event for the internal force-close flag. | **Representative.** Unsaved content discard is covered. Trigger validation and atomic content+trigger persistence, selection/panel/navigation/workspace prompts, two-tab version conflicts, and delayed response fencing remain. |
| T3-E2E-014 | The expert fixture lets all experts finish while synthesis alone fails. The transcript retains all three independent opinions and clearly reports that synthesis is unavailable without discarding evidence. | **Representative.** Synthesis-only failure is covered. Abort fan-out, synthesis retry without rerunning experts, workspace changes during fan-out, completion-order handling, and workspace-specific discovery remain. |
| T3-E2E-015 | The real structured-data plugin has an injectable expiry policy through `CORTEX_SQL_APPROVAL_TTL_MS`. The runtime test approves, advances beyond expiry, proves execution is rejected, the run returns to `planned`, and approval token/timestamps are removed; existing assertions retain same-principal/read-only boundaries. | **Representative.** Time expiry and principal binding are covered. Explicit revocation, source permission changes, fake-Postgres disconnect/timeout/cancel, form limit matrix, partial rows, and hostile cell rendering remain. |
| T3-E2E-016 | The browser compiles and publishes two immutable workflow versions; starts dry-run, shadow, and approval-gated modes; approves one gate and rejects the next; then verifies version, mode, no simulated actions, monotonic waiting/failure state, and ledger fidelity. | **Representative.** Version/mode distinction and sequential multi-gate decisions are covered. All gate types, exact filtering, duplicate decisions, lost external-action response, and durable external idempotency remain. |
| T3-E2E-017 | The browser forces safe replay reconstruction to return a missing-span failure and asserts the UI reports that no writes executed. Evaluation secret redaction and existing finite ROI assertions provide adjacent backend/output coverage. | **Representative.** Replay failure/no-write and report redaction are covered. Browser canary output, stale trace/suite selection, refresh degradation, exports/clipboard, and the broader ROI boundary matrix remain. |
| T3-E2E-018 | The Graph browser sends trimmed Unicode terms and an exact source constraint, receives a valid edge plus a self-edge with out-of-range confidence, and proves only the valid relationship/evidence renders. Production filtering now removes self-edges, missing endpoints, and non-finite/out-of-range confidence. | **Representative.** Source request fidelity and important malformed-edge cases are covered. Unicode equivalence policy, unknown versions, malformed evidence, denied edges, warnings, and Retrieve-versus-Refresh overlap remain. |
| T3-E2E-019 | The review browser blocks a missing target before transport, supplies required workflow identity, deduplicates repeated expert IDs, and proves the normalized request creates a review. | **Representative.** Required target and expert deduplication are covered. Every target type, forbidden/mismatched IDs, unknown experts, hostile/long questions, concurrent creation/idempotency, reload fidelity, and stale detail recovery remain. |
| T3-E2E-020 | The WebUI adds the optional background plugin, reloads the frontend, proves it remains loaded, removes it, reloads again, and proves it returns to the discoverable inactive set. | **Representative.** Harness configuration survives frontend reload. A newly booted real Matbot process, provider/store/hook/frontend classes, concurrent config mutation, atomic-write failure, dependency removal, and multi-workspace restart convergence remain. |
| T3-E2E-021 | `tests/lifecycle.test.mjs` contains a separately gated Windows test that runs `run.ps1`, creates and submits a session through the configured fake provider, requires the requested lifecycle response canary, stops/restarts Cortex, and proves exactly one user message plus the canary-bearing assistant response remain. It requires the existing isolation gates plus `CORTEX_LIFECYCLE_PROVIDER_E2E=1` and `CORTEX_LIFECYCLE_TEST_PROVIDER`. | **Implemented, safety-gated, not executed in this workstation verification.** File upload, memory recall, Docker host snapshot, occupied-port diagnosis, and repeated lifecycle permutations should be added to the disposable-host job. |
| T3-E2E-022 | Desktop and mobile Playwright projects open the destructive workspace dialog and prove dialog semantics, initial focus, forward/reverse focus trapping, Escape cancellation with focus return, plus polite live status attributes. | **Representative.** The critical dialog works on both projects. The full keyboard/mobile product journey, long localization, zoom, software keyboard, reduced motion/high contrast, touch sizes, and overflow assertions remain. |
| T3-E2E-023 | A browser matrix distinguishes provider discovery outage, missing workspace-file plugin, and RAG failure. It asserts layer-specific/actionable text and rejects destructive recovery advice in all three states. | **Representative.** Three high-value diagnosis branches are covered. Empty provider config, restart-pending plugins, frontend mismatch, memory retrieval/storage differences, detailed RAG corpus/path states, Mem0 failures, stale workflow state, occupied port, and adjacent `down -v` warnings remain. |

### Production Changes Exercised By The Tests

- WebUI workspace-generation fencing, attachment clearing, provider recovery,
  Markdown sanitization, explicit file collision confirmation, unsaved-skill
  confirmation, Graph relationship validation, review validation/deduplication,
  dialog focus trapping, and live status announcements.
- Real-path re-evaluation in the host file policy and broker, including
  junction protection and Node-compatible configuration-cache construction.
- Durable scheduled occurrence state and an injectable background launcher.
- SQL approval expiry and same-principal enforcement.
- Recursive value-based secret redaction in evaluation runtime and CLI output.
- Import-safe CLI workspace-manager access for disposable deletion tests.
- Deterministic harness seams for accepted-turn completion and synthesis-only
  expert failure.

### Verification Results

The implementation was verified from `C:\Projects\Cortex` on 2026-07-30:

- `npm test`: **70 passed, 3 skipped**. The skips are the intentionally gated
  Windows lifecycle scenarios, including T3-E2E-021.
- `npm run test:cli`: **5 passed**.
- `npm run test:webui`: **101 passed, 87 skipped**. The skipped cases are
  intentional project/safety scope skips; all 16 desktop T3 browser cases
  passed and T3-E2E-022 also passed in `mobile-chromium`.
- `corepack pnpm -C local-agent/matbot -r run typecheck`: all 52 participating
  projects passed.
- `npx tsc -p local-agent/paths/tsconfig.json --noEmit` and
  `npx tsc -p local-agent/file-broker/tsconfig.json --noEmit`: passed.
- `npm run build`: all root workspace builds passed.
- `tests/test-audit-contract.test.mjs`: verifies that each audit declares the
  complete ordered 001–023 series and that all **69 scenario IDs** occur in
  executable test titles. This keeps the audit documents and runnable suites
  traceable as either side evolves.
