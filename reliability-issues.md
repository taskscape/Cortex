# Reliability review

Originally reviewed on **2026-09-05**, against commit `e8996a68f6117b966eb85bd89f82c4b00600074a`, using Node.js `v24.18.0` on Windows. Source line numbers and reproduction evidence below describe that original review. Implementation status is recorded separately under each finding; completed findings are skipped on subsequent implementation passes.

The review concentrated on session execution and persistence, provider streaming and retries, filesystem storage, background scheduling, and Workspace RAG V2 ingestion/publication. It is a targeted failure-path review, not an exhaustive audit of every plugin. Findings describe code-level failure scenarios, not incidents observed in a deployed workspace.

**P1 / high** means a realistic failure can lose durable execution history, publish inconsistent data, or crash the host. **P2 / medium** means work can remain stuck, fail to recover, or report misleading success/state.

| ID | Priority | Finding |
| --- | --- | --- |
| REL-01 | P1 | Provider failures discard completed tool rounds from session history |
| REL-02 | P1 | RAG checkpoints leave the active generation mutable during final reconciliation |
| REL-03 | P1 | File contents and metadata are committed separately |
| REL-04 | P1 | Background child-process errors escape the scheduler's error handling |
| REL-05 | P2 | A full summary queue prevents RAG cancellation and shutdown from completing |
| REL-06 | P2 | Provider calls have no application-enforced request or stream deadline |
| REL-07 | P2 | HTTP retry backoff ignores cancellation |
| REL-08 | P2 | OpenAI-compatible stream errors and premature completion can become success |
| REL-09 | P2 | A transient store error permanently disarms a recurring schedule |
| REL-10 | P2 | RAG setup failures leave persisted jobs in a nonterminal state |

## REL-01 — Provider failures discard completed tool rounds from session history

**Status: Implemented (2026-09-05).** Completed tool rounds are saved before another provider call. Failed completions preserve partial prose and a durable incomplete marker; persistence failures emit explicit errors. Buffered calls from failed completions are not executed. Added four regression cases in `tests/core-hardening.test.mjs`; core and tool-use runtime verification passed (39 tests).

**Source:** [runner.ts](local-agent/matbot/packages/core/runner/src/runner.ts), lines 399–442, 593–596, and 629–635.

**Problem and impact.** `runSession()` accumulates assistant messages and tool results in its local `session` value. After an ordinary tool round, it starts the next provider request without saving that updated session. The provider exception handler saves partial output only when `signal.aborted` is true. For an ordinary network/API failure, it yields an error and returns without writing the session.

Consequently, a tool can successfully change a file or perform another external action, and the next provider request can fail, leaving no durable record of that completed tool call or result. Partial assistant text from the failing request also disappears on reload. A subsequent turn sees an incomplete history and may repeat an action that already happened. The function's promise to persist at every exit is not fulfilled by this branch.

**Reproduction and evidence.** A temporary probe seeded a session with one user message, used a provider that requested a successful tool on its first call, then streamed partial text and threw on its second call. The tool's side-effect counter reached `1`; the terminal event was `error`; the persisted session still contained only the original `user` message.

**Recommended fix.** Persist each completed assistant/tool-result round before requesting another completion. Centralize exceptional-exit handling so non-abort provider errors also save accumulated history and partial output before emitting the terminal event. Preserve call/result pairing and record an explicit incomplete/error marker. If persistence itself fails, report that failure explicitly; do not imply that completed work was saved. For tools with irreversible effects, consider durable execution IDs and idempotency in addition to history checkpoints.

**Regression checks.** Run a successful tool followed by a provider failure and assert that its call and result survive reload. Also cover failure after partial text, failure in a later tool round, and failure of the persistence operation itself. Retrying the conversation must retain evidence of the earlier side effect.

## REL-02 — RAG checkpoints leave the active generation mutable during final reconciliation

**Status: Implemented (2026-09-05).** Checkpoints copy staging membership to an independent publication, with serialized promotion; writers and final reconciliation retain their staging ID. Published generations are never adopted for resumed writes. Updated checkpoint/resume expectations, added finalization-failure tests, extended the guarded PostgreSQL test with a concurrent search during failure, and documented snapshot behavior in README. Manager/GC tests passed (32 tests); live PostgreSQL verification is tracked in the final validation record.

**Source:** [manager.ts](local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts), lines 1148–1172, 1310–1364, and 1504–1506; [postgres-repository.ts](local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts), lines 940–958 and 1087–1104; [config.ts](local-agent/matbot/packages/plugins/workspace-rag/src/v2/config.ts), lines 100–101.

**Problem and impact.** `publishCheckpoint()` makes the ingestion job's generation active. Ingestion then continues using that same generation ID. Later document completions update its membership, and `reconcileGeneration()` deletes missing documents from it before collection rebuilding, embedding, validation, and final publication have succeeded. Those operations are separate repository calls; the final publication transaction cannot roll back a deletion that an earlier call already committed.

This means a failed finalization can leave search using the failed job's already-modified generation. The previous complete publication has been retired, and removals are already visible. Publishing useful partial checkpoints is intentional, but continuing to mutate a published checkpoint defeats the snapshot boundary. The default checkpoint interval is 250 processed files, so this affects normal sufficiently large scans as well as configurations with a lower interval.

**Reproduction and evidence.** With `CORTEX_RAG_V2_CHECKPOINT_FILES=1`, a probe first published `a.md` and `b.md`. It then changed `a.md`, deleted `b.md`, and injected a failure in `rebuildCollections()` after reconciliation. The second job ended in `retryable_failure`, but its generation remained active and contained only `a.md`. The previously successful generation was no longer active. This was executed against the in-memory repository; inspection confirmed that PostgreSQL performs the same membership deletion in a separate call before finalization.

**Recommended fix.** Treat every published checkpoint as immutable. After publishing a checkpoint, fork its membership into a new staging generation and perform subsequent additions, removals, and collection rebuilding there. Promote that staging generation only after validation succeeds. Alternatively, persist resumable progress without publishing the generation being mutated. On failure, retain the last successfully published snapshot, and make job messages distinguish that snapshot from the original pre-run publication.

**Regression checks.** Cover a checkpoint followed by reconciliation and a failure in collection rebuilding, collection embedding, validation, or final promotion. Assert that the active checkpoint's membership remains unchanged. Repeat with PostgreSQL and concurrent searches; also verify cancellation after a checkpoint and restart/resume behavior.

## REL-03 — File contents and metadata are committed separately

**Status: Implemented (2026-09-05).** New writes use immutable version blobs and atomic metadata manifests; logical names remain stable and legacy entries remain readable. Put/delete operations serialize across local store instances, partial writes are handled, corruption is reported, and bounded cleanup retains referenced/fresh versions. Added seven storage regression cases covering write/rename failures, restart, legacy migration, version reads, races, and cleanup. Focused storage/service/runtime verification passed (21 tests).

**Source:** [files/store.ts](local-agent/matbot/packages/plugins/files/src/store.ts), lines 83–105 and 129–147.

**Problem and impact.** For a named file, `put()` first calls `writeData()`, which renames new bytes over the destination, and then writes the metadata directly to `<name>.meta.json`. The metadata write is neither part of the data rename nor itself performed through an atomic replacement. Anonymous entries use the same two-step publication pattern.

A metadata write failure therefore occurs after the new content is already committed. An overwrite can retain the old MIME type, namespace, session association, or `allowed` flag while exposing new bytes. A partial metadata write or interrupted first upload can instead leave unreadable metadata and an invisible/orphaned data file. `getRawMeta()` converts metadata read/parse failures into `null`, hiding the distinction between a missing entry and damaged storage. Concurrent puts can also interleave their data and metadata writes.

**Reproduction and evidence.** A probe created `report.txt` containing `old`, with MIME type `text/plain` and `allowed: true`. It then attempted an overwrite with JSON bytes, MIME type `application/json`, and `allowed: false`, while injecting `EIO` for the metadata write. `put()` rejected, but the data file contained the new JSON and `get()` still reported `text/plain` and `allowed: true`.

**Recommended fix.** Publish content and metadata through one commit point. One approach is an immutable blob per version plus a small metadata manifest, atomically replaced only after the blob is complete. Add serialization per logical file name for put/delete operations and clean abandoned blobs safely. Preserve named-file behavior when designing that change. If retaining the existing layout, introduce explicit journaling/recovery; atomically renaming two separate files still does not make the pair transactional. Distinguish storage corruption from absence in diagnostics.

**Regression checks.** Inject failure before and after each write/rename, including metadata truncation. A failed overwrite must preserve a consistent previous version, and restart must recover or clearly identify incomplete writes. Exercise simultaneous puts and put/delete races for the same name.

## REL-04 — Background child-process errors escape the scheduler's error handling

**Status: Implemented (2026-09-05).** Child and stdin errors are observed before configuration is written. A shared completion monitor classifies launch/pipe failures, bounds cancellation and output draining, and prevents late events from changing a settled result. Recurring failures are persisted; Windows launches are hidden. Added real missing-executable, error-event, cancellation/drain, and occurrence-persistence tests. Background verification passed (6 tests).

**Source:** [background/index.ts](local-agent/matbot/packages/plugins/background/src/index.ts), lines 129–165 and 257–267.

**Problem and impact.** `spawnJob()` creates a child and writes its configuration to `child.stdin` without installing an `error` handler on either the child or stdin. The recurring scheduler waits only for the child's `exit` event. Its outer promise catch handles rejected asynchronous work, but does not catch an unhandled EventEmitter `error` emitted later by a child or pipe.

A process-creation failure such as resource exhaustion, or a broken input pipe when the child exits early, can escape as an uncaught error and terminate the host. If another layer catches the process error, the scheduler can still remain stuck waiting for `exit` after a failed spawn. The persisted occurrence can remain `running` instead of reaching `launch_failed` or `failed`. One-off background jobs use the same unguarded spawn helper.

**Reproduction and evidence.** Using the existing `installBackgroundTestHooks()` seam, a probe returned a ChildProcess-shaped EventEmitter. Once the scheduler had attached its `exit` listener, it had zero `error` listeners. Emitting a synthetic spawn error threw out of `emit()`; the probe caught that exception externally to avoid terminating its own process. The stored occurrence was still `running`. Actual OS resource exhaustion was not induced.

**Recommended fix.** Attach child and stdin error handlers immediately after spawning, before writing configuration. Expose a launch/completion promise that settles exactly once on spawn failure, pipe failure, exit, close, or cancellation, with clear classification. Persist terminal occurrence state on all paths. Bound child termination and pipe draining, clean up listeners, and hide background process windows on Windows.

**Regression checks.** Exercise a real missing executable in an isolated test process, synthetic `EAGAIN`, a child that exits before reading stdin, and cancellation during launch. Assert that the parent survives, the completion promise settles, and the occurrence leaves `running`.

## REL-05 — A full summary queue prevents RAG cancellation and shutdown from completing

**Status: Implemented (2026-09-05).** Queue-space waits now observe producer cancellation and remove their waiters. Shutdown stops intake and aborts producers, summary workers, and lazy work before joining them. Summary/embedding calls have a configurable deadline and cannot perform late writes after cancellation. Full-queue cancellation and uncooperative-summary tests passed with the manager/GC suite (34 tests); the timeout setting is documented in README.

**Source:** [manager.ts](local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts), lines 342–349, 552–560, and 595–634.

**Problem and impact.** `enqueueSummary()` waits for space using a promise stored in `summarySpaceWaiters`. It does not receive the ingestion signal and only checks the separate `summaryController` signal. Cancelling ingestion aborts its run controller and then awaits the run promise, so it cannot interrupt an ingestion task blocked while enqueuing a summary.

Shutdown has the same dependency in the wrong order: `close()` first aborts and waits for ingestion runs, and only afterwards aborts summary processing. If the summary queue is full and the active summarizer is stalled, ingestion cannot finish, and shutdown never reaches the cancellation that would release the summarizer. A slow summarizer causes an excessive cancellation delay even when it eventually responds.

**Reproduction and evidence.** A probe configured one summary worker and a queue limit of 16, ingested a document with 30 sections, and held the first summarizer call behind a controllable promise. After a producer started waiting for space, it requested both cancellation and shutdown. After 100 ms, neither had settled, the queue still held 16 entries, and the summarizer's signal was not aborted. Releasing the test summarizer allowed both operations to finish. The bounded observation demonstrates the dependency; the code supplies no independent wakeup if the summarizer never settles.

**Recommended fix.** Make queue-space acquisition abortable with the producer's ingestion signal, removing its waiter when cancelled. During shutdown, stop new intake and abort ingestion and summary work before awaiting either group. Explicitly wake/reject all queue waiters, and give external summary operations a deadline. Ensure one cancelled ingestion job does not need to cancel unrelated jobs' summary work.

**Regression checks.** Fill the queue with an abort-aware summarizer held indefinitely, then assert that `cancel()` and `close()` settle within a short bound without manually releasing that summarizer. Check that cancelled waiters are removed and no background task accesses the repository after it closes.

## REL-06 — Provider calls have no application-enforced request or stream deadline

**Status: Implemented (2026-09-05).** Both adapters now own configurable header/retry, stream-idle, and overall completion deadlines through stream consumption. Header-attempt timers are cleared after headers; user cancellation remains linked to the body. SSE reads observe cancellation, and timers are cleared on all exits. Actual-adapter tests cover stalled headers/body, heartbeats, total limits, healthy long streams, cancellation, and invalid settings. Focused provider/core verification passed (39 tests); defaults and settings are documented in README.

**Source:** [OpenAI-compatible adapter](local-agent/matbot/packages/plugins/providers/openai-compat/src/adapter.ts), lines 163–190; [Anthropic adapter](local-agent/matbot/packages/plugins/providers/anthropic/src/adapter.ts), lines 77–85 and 121–123; [http-retry.ts](local-agent/matbot/packages/core/providers/_base/src/http-retry.ts), lines 62–79; [session-runner.ts](local-agent/matbot/packages/core/runner/src/session-runner.ts), lines 209 and 256–263.

**Problem and impact.** `fetchWithRetry()` supports a `timeoutMs` option, but both production adapters omit it. Without that option it forwards the caller's signal unchanged. The session runner supplies a plain AbortController with no deadline. There is also no application deadline around SSE consumption.

As a result, an endpoint that accepts a connection but stops making useful progress can keep a session busy until manual cancellation or a lower-level transport failure. A stream that sends only heartbeat comments can remain alive without ever producing a completion. Subsequent submissions to that session stay queued, and unattended/background work has no user available to press Stop. The existing timeout tests call the helper with explicit options, so they do not verify the production adapter path.

**Reproduction and evidence.** Both actual adapters were pointed at a local HTTP server that continuously sent SSE heartbeat comments without completion data. They remained pending during the bounded observation and settled after the probe manually aborted them. Instrumenting `fetch` confirmed that each received exactly the caller's signal, without a composed deadline signal. The absence of an application deadline is established by source inspection; the probe did not wait for transport-specific timeouts.

**Recommended fix.** Define and wire configurable connection/header, stream-idle, and overall completion deadlines at the provider boundary. Compose them with user cancellation and keep the appropriate timer active through response-body consumption. Distinguish heartbeat traffic from useful progress when enforcing the overall limit. Preserve already streamed content on timeout using REL-01's persistence fix. Do not simply enable the current per-attempt timeout without reviewing its lifetime: its signal also governs the returned response body and can otherwise cut off a healthy long response at an attempt's shorter budget.

**Regression checks.** Test the actual adapters against a server that never sends headers, one that stops after headers, and one that sends endless heartbeats. Also test a slow but healthy completion, user cancellation, and retry behavior within the configured total budget.

## REL-07 — HTTP retry backoff ignores cancellation

**Status: Implemented (2026-09-05).** Both retry paths use abortable waits, check cancellation before another attempt, and remove listeners on normal timer completion. Added status/network backoff cancellation, pre-cancellation, and listener-cleanup tests. Provider/core verification passed (38 tests).

**Source:** [http-retry.ts](local-agent/matbot/packages/core/providers/_base/src/http-retry.ts), lines 27–31 and 87–101.

**Problem and impact.** The `delay()` helper accepts a signal, but neither retry path passes it: network-error backoff calls `delay(...)` without `init.signal`, and transient-status backoff calls `delay(waitMs)` without it. User cancellation during either sleep therefore has no effect until the timer expires and the loop reaches another fetch attempt.

The status path accepts a `Retry-After` delay of up to 60 seconds. Pressing Stop during that delay can leave the session busy and block queued work for nearly a minute. This also delays orderly shutdown for callers waiting on the request.

**Reproduction and evidence.** A local server returned HTTP 429 with `Retry-After: 1`. The probe aborted shortly after the response. The promise rejected approximately **984 ms after cancellation**, rather than waking promptly; only one HTTP request reached the server.

**Recommended fix.** Pass the caller signal to every backoff wait, check for a pre-aborted signal before scheduling, and remove abort listeners when timers finish. Check cancellation and budget exhaustion before beginning the next attempt. Prefer a shared abortable-delay helper with explicit rejection semantics so cancellation cannot accidentally become a retry.

**Regression checks.** Cancel during both status and network-error backoff and assert prompt settlement with no subsequent request. Include a pre-aborted signal and a large `Retry-After`, and verify that repeated successful delays do not accumulate abort listeners.

## REL-08 — OpenAI-compatible stream errors and premature completion can become success

**Status: Implemented (2026-09-05).** Explicit OpenAI-compatible error/malformed frames and missing/unsupported finish reasons now fail. Tool calls are buffered through trailing error/usage frames, DONE closes SSE consumption, and exactly one successful terminal event is emitted. Anthropic requires message_stop; the runner requires a terminal done event. Added stream-error/EOF/tool-buffer/usage and runner-contract tests. Provider/core/tool verification passed (67 tests); user-visible behavior is documented in README.

**Source:** [OpenAI-compatible adapter](local-agent/matbot/packages/plugins/providers/openai-compat/src/adapter.ts), lines 190–210 and 242–270; [runner.ts](local-agent/matbot/packages/core/runner/src/runner.ts), lines 344–404.

**Problem and impact.** The adapter skips frames without `choices[0]` after handling optional usage. It has no branch for a top-level streamed `error` object. When the body ends, it unconditionally emits `done`, even when no recognized finish reason was received. Its fallback also flushes accumulated tool calls from such an incomplete stream.

An HTTP 200 SSE response carrying an upstream error can therefore become an empty successful completion. A response body that ends cleanly after partial content can become a successful partial answer. These are protocol failures that do not necessarily cause `fetch` or the stream reader to throw. The runner also treats exhaustion of the provider iterator as success without requiring a verified terminal marker, so it does not catch this distinction. Incomplete-but-parseable tool arguments can be passed on for execution.

**Reproduction and evidence.** The actual adapter was exercised with two synthetic HTTP 200 response bodies. A content delta followed by EOF, with no finish reason, produced `text-delta, done`. A body containing only `{"error":{"message":"upstream overloaded","type":"server_error"}}` produced `done` and an empty-completion warning, rather than throwing an error.

**Recommended fix.** Track a valid provider terminal state and handle explicit error frames before processing choices. Classify EOF without an accepted terminal state as an incomplete completion. Keep compatibility exceptions explicit for endpoints with documented alternate framing. Do not execute buffered calls from an unconfirmed completion; retain the partial response and error for diagnosis. Ensure that one successful completion produces one terminal outcome while still collecting any trailing usage frame. Review the runner's provider contract so iterator exhaustion alone cannot silently certify success.

**Regression checks.** Cover an error frame before content, an error after partial content, EOF without a finish reason, and a tool call with parseable arguments but no terminal confirmation. Keep successful finish-plus-usage streams passing and verify that terminal events are not duplicated.

## REL-09 — A transient store error permanently disarms a recurring schedule

**Status: Implemented (2026-09-05).** Schedule storage operations are supervised with bounded backoff, cancellation, stable occurrence IDs, and serialized state mutations. Completion-write retries do not relaunch work, resume rearms stopped records, due times survive restart, and uncertain interrupted occurrences are recorded without immediate replay. Scheduler liveness/errors are exposed; teardown joins captured activation loops. Added recovery, acknowledgement-loss, suspension, rearming, and interrupted-occurrence tests. Background verification passed (13 tests); recovery behavior is documented in README.

**Source:** [background/index.ts](local-agent/matbot/packages/plugins/background/src/index.ts), lines 228–295 and 405–422.

**Problem and impact.** A store `get()` or `set()` rejection escapes the scheduler loop to its outer catch. That catch logs the error and deletes the schedule from `activeLoops` and `sleepControllers`, but leaves its persisted record active. No retry or supervisor rearms the loop.

The user can see an active schedule that no longer executes. `every_action resume` returns success after updating the record and calling `wakeSchedule()`, but there is no sleeping loop left to wake. A transient storage problem has therefore become a permanent outage until runtime/plugin restart or schedule recreation. Depending on the failure point, the last occurrence may also remain labelled `running`.

**Reproduction and evidence.** A probe made the first scheduled `get()` fail once, then restored normal reads. The crash was logged. Calling `resume` returned a successful result, and the record remained `active: true`, but the launcher was never called. The test used the existing startup-delay override so a healthy rearmed loop would execute promptly.

**Recommended fix.** Recover transient store failures inside a supervised loop using bounded backoff and cancellation, without launching duplicate occurrences. Surface a durable degraded/error state when recovery cannot proceed. Make resume idempotently ensure that an active schedule has an armed loop, and distinguish persisted activation from actual scheduler liveness in status. Resume should also recompute an appropriate due time rather than blindly repeating an uncertain occurrence.

**Regression checks.** Inject one-time failures while reading the schedule, marking an occurrence running, and recording its completion. Verify automatic recovery and explicit resume recovery, preservation of suspend/cancel state, and at-most-one local launcher per schedule. For failure after launch, verify that recovery does not immediately duplicate a still-running occurrence.

## REL-10 — RAG setup failures leave persisted jobs in a nonterminal state

**Status: Implemented (2026-09-05).** The entire ingestion lifecycle shares one terminal-state error boundary, including initialization and setup. Failed or unacknowledged job creation receives a best-effort terminal update; repository outages preserve failure details in memory for status and wait callers. Replacement ingestion marks an orphaned prior job interrupted before resuming staging. Added seven setup-failure cases, cancellation during setup, and an outage/recovery case. Combined RAG manager, GC, and background reliability verification passed (54 tests).

**Source:** [manager.ts](local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts), lines 451–472, 1176–1240, and 1392–1403; [workspace-rag/index.ts](local-agent/matbot/packages/plugins/workspace-rag/src/index.ts), lines 635–648.

**Problem and impact.** `runIngestion()` performs initialization, job creation, fingerprint loading, root selection, counting, `beginGeneration()`, and abandoned-generation pruning before entering the try/catch that assigns terminal failure/cancellation states. A failure during that setup escapes directly to `startIngestion()`'s catch, which only logs it. Its `finally` removes the in-memory run.

If the job was already persisted, its stored state can remain `discovered` even though there is no running ingestion. `waitForIngestion()` resolves because the outer catch consumed the error. The reconciliation coordinator recognizes only explicit failure states when setting `lastError`, so this path can clear the error indicator instead of reporting failure. Operators see stale progress and cannot reliably distinguish failed work from active discovery. This finding concerns incorrect terminal state and reporting; a later periodic reconciliation may still start a new run.

**Reproduction and evidence.** A probe made `beginGeneration()` throw after `createJob()` succeeded. After `waitForIngestion()` resolved, the in-memory and persisted job states were both `discovered`, the message was `Discovering 1 Markdown file.`, and the manager had zero active runs.

**Recommended fix.** Place the entire ingestion lifecycle under one error boundary, including setup. Track whether the job exists and attempt to persist a suitable terminal state whenever it does. Retain an observable in-memory failure if the repository itself is unavailable, and make wait/status APIs communicate failure consistently instead of treating a logged-and-swallowed exception as successful completion. During startup recovery, reconcile orphaned nonterminal jobs with actual running work.

**Regression checks.** Inject failures in fingerprint loading, root selection, generation creation, and staging cleanup, plus cancellation during setup. Assert a terminal failure/cancelled state, zero active work, and visible error details. Include a repository outage that also prevents the terminal-state write, followed by recovery.

## Implementation validation and limits

All **10 findings are implemented**. Each finding was reread before implementation, marked complete after its focused checks, and skipped on subsequent passes. The original problems, source line references, and reproduction evidence above remain as the historical review record.

Added **61 named test cases/subtests**, including two new reliability test files, and updated the existing checkpoint/resume and PostgreSQL fixtures. The expanded catalog is documented in [docs/testing.md](docs/testing.md). README now explains file version storage, provider deadlines and interrupted completions, scheduler recovery, independent RAG checkpoints, summary cancellation, and setup failure status.

Final verification on **2026-09-05**:

| Check | Result |
| --- | --- |
| `npm run test:all` — Node | **352 passed, 0 failed, 6 guarded skips** (358 discovered cases/subtests). |
| `npm run test:all` — Matbot CLI | **5 passed, 0 failed**. |
| `npm run test:all` — Playwright WebUI | **152 passed, 0 failed, 118 project-specific skips**. |
| PostgreSQL/pgvector integration | **3 passed, 0 failed, 0 skipped**, using a disposable pgvector PostgreSQL 16 container and isolated schemas/roles. Includes a concurrent search after staging deletions and before an injected final rebuild failure. The container was removed after verification. |
| Additional background verification after final pipe-termination hardening | **14 passed, 0 failed** across background reliability, scheduling, and scheduled execution. |
| `corepack pnpm -C local-agent/matbot run typecheck` | Passed across the workspace; the final background follow-up also passed its package typecheck. |
| `corepack pnpm -C local-agent/matbot run check:docs` | Passed. |
| `git diff --check` | Passed; only existing line-ending conversion notices were emitted. |

The initially configured PostgreSQL endpoint was unavailable. Integration verification was therefore completed against the disposable database; the RLS test fixture now preserves a connection URL's host, port, database, and options when creating its application-role connection. The checkpoint probe also fails promptly if setup terminates before reaching its expected checkpoint.

No live model-provider calls or production-workspace mutations were used. The live README QA, full Docker/CUDA application stack, GPU integration, and large 2-GiB parser opt-in were not run. File consistency is covered with injected write failures, interrupted streams, restart reads, and concurrent local mutations; power-loss durability and multi-host coordination are outside these checks. Scheduler retry protection is local to one scheduler instance and does not claim exactly-once external side effects across host crashes.

The initial documentation review had separately passed 60 focused existing tests and three temporary fault-injection probes. Those observations established the historical findings; the implementation results above are the current validation record.
