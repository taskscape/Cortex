# Cortex Missing-Test Implementation Plan

## Purpose and scope

This plan turns the supplied *Uncovered Functionality in Cortex* list into an
implementable test backlog. It is grounded in the repository state on
2026-07-30, rather than assuming every item is wholly untested. Several
supplied gaps already have a representative regression test; those tests should
be extended, not duplicated.

The objective is to add deterministic automated evidence for configuration
contracts, state transitions, data-loss boundaries, and WebUI journeys. It is
not to run destructive Docker operations against a developer's Mem0 volumes or
to depend on a GPU, provider credentials, or a live user's workspace in the
ordinary test suite.

## Current baseline and disposition

| Scope item | Existing evidence | Work still required |
| --- | --- | --- |
| CUDA embedding switch and RAG indexing | `tests/workspace-rag-e5.test.mjs` exercises purpose-aware E5 requests and persists the embedding signature; `tests/workspace-rag.test.mjs` covers ingestion/reindex rename reconciliation. | Add sidecar-health contract tests, explicit status-transition/duplicate-reindex tests, and a disposable CUDA Compose smoke test. |
| Mem0 password rotation | Documentation only. | Add a separately gated disposable Docker scenario; it must prove both intended data loss and clean recreation. |
| Expert panel | `tests/expert-panel.test.mjs` covers selected experts, isolated retrieval, synthesis, review creation, and unknown experts. Browser tests cover all/selected composer flows and synthesis failure. | Make injected expert configuration and every mode an explicit matrix, including root isolation with conflicting canaries. |
| Plugin management | Browser coverage activates/deactivates compatible plugins; core plugin tool implements `discover_local`, add, remove, and reload. | Test discovery, remove/retry, persisted configuration through a real restart, and boot-sensitive restart signalling. |
| File broker | `tests/file-broker-approval.test.mjs` already proves an unapproved overwrite is rejected, approved overwrite gets backup/diff, and junction escape is rejected. | Expand policy permutations, approval end-to-end, path aliases, and overwrite artifact integrity. |
| Context graph | Runtime and browser tests cover source constraints, malformed edges, denied sources, and ordinary relationships. | Add multi-hop/path tests, confidence boundaries, deterministic assertion derivation, and source-version provenance. |
| Workflow shadow/approval | Runtime/browser tests already cover versions, modes, sequential gates, idempotent decisions, shadow outcome recording, and readiness presentation. | Add the full label aggregate matrix and decision-history/metric persistence checks. |
| Evaluation and ROI | Runtime/browser tests cover traces, safe replay, failed-suite release blocking, cost accounting, and finite ROI cases. | Add release-command gating, pricing-source precedence/failure cases, full ROI arithmetic boundaries, and no-write replay proof at runtime. |
| Scheduling | Runtime tests cover schedule persistence, lifecycle operations, principal inheritance, and one durable occurrence. | Add tool-policy enforcement, failure/retry history, missed-run policy, and an opt-in real-process smoke test. |
| Memory browser | In-page WebUI and plugin API are tested. The standalone service exposes `/api/health` and CRUD/CAS operations. | Add a standalone-service browser/API contract, filtering, and version-aware update matrix. |
| Multi-context Workspace RAG | Default RAG and one settings flow are tested; workspace settings cover paths/progress and stale status. | Add distinct context-name/path persistence, multiple contexts, dynamic edits, and workspace-local config migration/validation. |
| Source registry | Runtime/source panel coverage includes source health transport and partial refresh recovery. | Add health-transition history, clock-driven freshness alerts, access-audit ordering, and version lifecycle assertions. |
| Docker health | Basic startup exists only outside a complete health contract. | Add an opt-in Compose health matrix for Postgres/pgvector, Neo4j, Mem0, and optional CUDA. |
| WebUI branding | The shipped UI has fixed CSS variables and labels; no runtime branding configuration contract was found. | Treat this as a product-contract decision first. Add tests only after a configuration schema and loading path exist. |

## Test architecture and safety rules

### 1. Test lanes

Use four explicit lanes. Each feature should use the lowest-cost lane that
proves its risk, and a higher lane only for an integration boundary.

1. **Fast runtime tests** — Node's built-in runner in `tests/*.test.mjs`, using
   the production TypeScript modules via `apps/cli/register.js`, temporary
   directories, in-memory stores, fake clocks, and fake providers.
2. **WebUI contract tests** — extend `tests/webui/harness.mjs` and
   `tests/webui/matbot-webui.spec.mjs`. The harness must model the relevant
   tool response/state, while Playwright asserts the public controls, request
   payloads, durable visible state, and recovery states.
3. **Disposable service integration** — Node tests start a local fake HTTP
   sidecar or a standalone plugin HTTP server on a dynamically assigned port.
   They never use ports 19778, 19779, or 8890 as fixed test ports.
4. **Opt-in Docker/CUDA lifecycle** — a separate test command and CI job for a
   disposable Docker Compose project. It must be skipped unless Docker is
   available and an explicit `CORTEX_DOCKER_INTEGRATION=1` opt-in is set. CUDA
   tests need the additional `CORTEX_CUDA_INTEGRATION=1` opt-in and skip with a
   clear reason when the NVIDIA runtime/GPU is unavailable.

### 2. Shared fixture work (do this first)

Create `tests/helpers/` helpers rather than repeating timing and cleanup logic:

- `temp-workspace.mjs`: creates a temporary workspace root, config root, and
  files/data roots; returns cleanup registered in `t.after()`.
- `fake-clock.mjs`: supplies deterministic `now`, timer scheduling, and manual
  advancement for freshness, schedule, retry, and approval-expiry tests.
- `http-sidecar.mjs`: starts a programmable local HTTP server with request
  capture, route queues, delayed replies, and abort-aware cleanup. Use it to
  emulate `/health` and `/embed` without downloading models.
- `docker-compose.mjs`: generates a unique Compose project name and temporary
  `.env`; checks Docker availability; runs bounded commands; collects
  `docker compose ps`/logs on failure; and removes **only** that project in
  `finally`. It must refuse a project name not generated by the helper.
- `assertions.mjs`: health-schema, ordered-event, and no-secret assertions.

Do not read or write `local-agent/matbot/workspaces/`,
`local-agent/matbot/cortex-workspaces.json`, or a developer's Mem0 `.env` from
tests. Test configuration must be generated under the temporary fixture root.

### 3. Required test metadata and commands

- Prefix each new executable test title with a stable identifier such as
  `MISSING-01`, then record the identifier in this document and the relevant
  test-audit contract if its manifest is expanded.
- Put real Docker tests in a separately invoked file, for example
  `tests/docker-stack.integration.test.mjs`; do not let `npm test` silently
  erase volumes or pull large images.
- Add scripts such as `test:integration:docker` and
  `test:integration:cuda`; their default behaviour must report a skip, not a
  pass, when their opt-ins are absent.
- Extend `docs/testing.md` with the commands, prerequisites, fixtures, opt-in
  names, expected skips, and cleanup guarantee as each lane lands.

## Implementation backlog

### MISSING-01 — CUDA embedding model configuration and switching

**Primary code:** `local-agent/docker/mem0/docker-compose.yml`,
`local-agent/docker/mem0/workspace-rag-cuda/app.py`, and
`local-agent/matbot/packages/plugins/workspace-rag/src/index.ts`.

1. Extract the health payload validation currently implicit in the RAG CUDA
   probe into a pure exported/internal testable function. Validate required
   model, positive dimensions, profile, normalized output, signature, and
   profile-specific query/document prefixes. Reject malformed JSON, unexpected
   dimensions, empty E5 prefixes, and model/signature drift.
2. Extend `tests/workspace-rag-e5-runtime.mjs` with fake `/health` and `/embed`
   endpoints. Assert MiniLM's 384 dimensions and empty prefixes; assert E5's
   768 dimensions and `query: `/`passage: ` prefixes; assert batch chunking and
   the configured batch size passed to the sidecar.
3. Add status-state tests to the production RAG runtime: initial `idle`,
   `indexing` while a promise-gated file scan is held, monotonic
   `processedFiles <= totalFiles`, terminal `idle`, and a terminal error that
   preserves the last useful counters. Use explicit gates, never sleeps.
4. Call `reindex_now` once while idle and once while indexing. Assert the
   documented behavior: the latter queues exactly one subsequent scan rather
   than starting concurrent writers. Add an observable queued/run identifier
   only if the existing status contract cannot distinguish that outcome.
5. Add a `CORTEX_CUDA_INTEGRATION` Compose smoke test that invokes
   `docker compose --profile cuda up -d --build --force-recreate
   workspace-rag-cuda` under a generated project, polls `/health`, and validates
   the same payload contract. Run MiniLM always in this lane; run E5 only under
   a separate model-download opt-in because cold download time is material.
6. Do **not** invent a cancellation test: cancellation is a documented absent
   feature. Add a contract test that the status/action schema does not advertise
   cancellation and keep the user-facing limitation documented.

### MISSING-02 and MISSING-14 — Mem0 password rotation and Docker stack health

**Primary code:** `local-agent/docker/mem0/docker-compose.yml`, Dockerfiles,
and `scripts/run.ps1`/health scripts.

1. Create a disposable Compose integration fixture with a generated project
   name, temporary environment file, random PostgreSQL/Neo4j/Mem0 passwords,
   and isolated named volumes. It must reject running if the compose file cannot
   be overridden to use that generated project.
2. Start the stack and poll, with bounded retries, Postgres/pgvector (`SELECT
   extname FROM pg_extension WHERE extname = 'vector'`), Neo4j authentication
   plus a basic schema query, and Mem0's HTTP health endpoint. Capture
   sanitized diagnostics on failure.
3. Seed only fixture-owned records: one Mem0 memory and one RAG vector/document
   with a known marker. Prove they can be read before rotation.
4. Change all fixture credentials, run the documented `down -v`, bring the
   generated project back up, and prove old credentials fail while new
   credentials work. Assert the old marker is absent: volume removal is
   intentionally destructive.
5. Reindex a fixture Markdown file after recreation and prove its new vector
   is searchable. This tests recovery, not preservation of deleted vectors.
6. Test a negative path where only one connection string is updated: service
   health or client access must fail with actionable diagnostics and no secret
   values in captured output.
7. Put all of this behind `CORTEX_DOCKER_INTEGRATION=1`, use `finally` cleanup,
   and document that it is for a disposable Docker host only. Add a CI job with
   a time limit and retained sanitized Compose logs.

### MISSING-03 and MISSING-12 — RAG reindex control and configuration flexibility

**Primary code:** workspace-rag runtime, the RAG settings code in
`packages/plugins/frontend/web/static/app.js`, and the workspace RAG config
loader.

1. Add runtime matrix tests for zero files, one file, partial read failure,
   model-signature change, and queued `reindex_now`; assert the exact status
   fields and no duplicate chunks after a retry.
2. Add Playwright harness operations that delay and sequence `status` and
   `reindex_now`. Assert progress text/ARIA values, disabled/retry behavior,
   non-regression to an older workspace's status, and the documented
   already-indexing warning.
3. Create isolated config fixtures with two named RAG contexts and nonoverlapping
   Markdown roots. Assert save/load round-trip, context labels, retrieval from
   the selected context only, context deletion, path edits, and automatic
   reindex of only the affected context.
4. Add validation tests for duplicate/blank context names, duplicate normalized
   paths, inaccessible paths, and configuration migration from a single default
   context. No test may use an actual `cortex-rag.json` in a workspace directory.
5. If the current product schema permits only one context, make multi-context a
   prerequisite implementation task with acceptance criteria; tests cannot
   prove an unsupported configuration feature.

### MISSING-04 — Expert configuration and customisation

**Primary code:** `plugins/expert-panel/src/{config,index,file-knowledge}.ts`
and `local-agent/config/experts.json` schema/template.

1. Refactor/extend the test setup to load an injected temporary experts JSON,
   rather than relying on repository knowledge files. Validate schema failures,
   duplicate IDs, missing roots, and safe default behavior.
2. Create two experts with deliberately conflicting marker files. Assert each
   prompt/citation contains only its configured root marker and never the other
   root's marker; include a path traversal/junction fixture where supported.
3. Drive `parallel`, `review`, and `debate` through the real plugin with a fake
   deterministic provider. Assert selected-vs-all resolution, deterministic
   expert ordering, mode-specific prompt context, number of provider calls, and
   synthesis input contains the complete opinion set exactly once.
4. Add failure matrix: unknown/duplicate selection, one expert failure,
   synthesis-only failure, no synthesis, and malformed provider result. Preserve
   successful opinions and citations when an optional step fails.
5. Add a WebUI test that custom configuration is represented accurately in the
   selector and that all/selected/mode controls produce the expected tool
   payload. Do not expose system prompts or filesystem paths.

### MISSING-05 — Plugin management UI flows

**Primary code:** `packages/core/tool-plugin/src/tools/plugin.ts`, CLI loader,
and WebUI plugins panel/harness.

1. Add runtime tests for `discover_local`: returned entries are loadable,
   deduplicated, stable by package/specifier, compatible with the host runtime,
   and exclude invalid fixture modules. Assert no filesystem location outside
   the plugin roots is offered.
2. Cover add/reload/remove transactionally with temporary `matbot.yaml` and
   test plugin fixtures. Assert a failed add changes neither live registry nor
   persisted config; a failed remove rolls back; and retry converges.
3. Extend Playwright to discover, add, deactivate/remove, and rediscover a
   plugin, asserting disabled/busy/error states and exact tool requests. Cover
   an incompatible plugin and retain the existing core-plugin non-removable
   assertion.
4. Define `restartRequired` as a typed response field for boot-sensitive
   plugins if it is not already exposed. Test a hot-loadable plugin takes effect
   immediately and a boot-sensitive plugin displays restart-required copy and
   does not claim activation before restart.
5. Add an opt-in real CLI restart test: modify only a temporary config, start a
   child Matbot process, add/remove, restart it, and assert persisted plugin
   state. Do not test this against the active Cortex process.

### MISSING-06 — File-broker security policies

**Primary code:** `local-agent/file-broker/src/{server,file-writer,backup}.ts`
and temporary policy/config fixtures.

1. Extend the existing runtime fixture with policy tables for allowed roots,
   denied path fragments, high-risk extensions, new file versus overwrite, and
   case-normalized Windows paths. Assert explicit status/error classification.
2. Expand alias defenses: junction, symlink where privileges permit, relative
   traversal, and UNC/device paths. Platform/privilege-inapplicable cases must
   report a skip reason rather than turning into false passes.
3. Assert an unapproved request changes neither target nor backup directory;
   an approved overwrite creates one backup and unified diff with pre-write
   content; repeated approved writes create correctly attributable artifacts.
4. Exercise the actual broker HTTP endpoint from the plugin/client or WebUI
   transport with an approval workflow. Assert the review is bound to the exact
   path and proposed content. If approval is only a boolean today, record the
   product gap: single-use, path/content-hash/principal/workspace/expiry-bound
   tokens are needed before replay/tamper tests can be meaningful.

### MISSING-07 — Context graph multi-hop retrieval

**Primary code:** `packages/plugins/context-graph/src/index.ts` and graph panel.

1. Seed a source-versioned chain A→B→C→D using production graph methods. Test
   `neighbors` at depths 1–3 and `pathSearch` with multiple paths, max depth,
   max paths, workspace isolation, and deterministic ordering.
2. Assert relationship IDs are stable for equal assertions, confidence is
   clamped/rejected at invalid bounds as designed, self-edges/missing entities
   are excluded, and evidence/provenance includes source and source-version.
3. Ingest controlled source text twice and assert deterministic extraction
   derives the expected entities/assertions without duplicate relationships;
   a changed source version must create auditable new provenance.
4. Extend the browser harness to return two-hop evidence and validate the panel
   renders the complete path, confidence, and source citation but no denied or
   malformed edges.

### MISSING-08 — Workflow shadow mode and approval gating

**Primary code:** workflow-governance runtime and workflow operations panel.

1. Parameterize shadow labels `accept`, `reject`, and `mixed` across several
   runs. Assert one immutable decision/event per labeled run, timestamp and
   principal provenance, and idempotent repeat decision semantics.
2. Assert the aggregate acceptance rate counts labels correctly, excludes
   unlabeled/ineligible runs, has a defined zero-denominator presentation, and
   survives runtime recreation.
3. Create dry-run, shadow, and approval-gated executions of one workflow
   version. Assert their ledgers, external-action simulation behavior, pending
   approvals, decision history, and terminal outcomes differ exactly as the
   mode contract states.
4. Add browser coverage for label changes, history detail, aggregate refresh,
   and stale/duplicate decision protection using delayed harness responses.

### MISSING-09 — Evaluation, release gating, and ROI reporting

**Primary code:** evaluation-observability plugin, `scripts/evaluate.mjs`, and
the Evaluation & ROI panel.

1. Test a regression-suite runner with all-pass, one required-scorer failure,
   below-threshold pass rate, and malformed trace. Assert release-blocking exit
   status/result is machine-readable and a nonblocking informational suite
   cannot accidentally block release.
2. Add table-driven ROI tests: zero cost, zero benefit, negative benefit,
   missing/invalid units, time saved conversion, gross benefit, model cost,
   net benefit, and finite/non-misleading ROI representation.
3. Inject `CORTEX_MODEL_PRICING_JSON` with valid, missing-model, malformed,
   negative, and precedence-over-default values. Assert pricing provenance is
   recorded and errors do not silently yield misleading cost/ROI.
4. Seed a trace containing a write span; replay with a recorder that throws on
   real execution. Assert reconstruction reads persisted/redacted evidence only,
   emits no write call, and returns an actionable missing-span failure.
5. Extend WebUI checks for release-blocking status, pricing/ROI provenance, and
   replay failure/no-write copy. Include secret canaries in displayed/logged
   evidence and assert redaction.

### MISSING-10 — Scheduled and unattended actions

**Primary code:** `packages/plugins/background/src/index.ts`, scheduled
execution runtime helpers, and plugin lifecycle.

1. Use the shared fake clock/launcher to prove activation restores persisted
   schedules, next-run computation, recurring execution, suspend/resume/cancel,
   and one durable run-history record per occurrence.
2. Add schedule records with allowed and denied tool policies. Assert child
   calls inherit workspace/principal/provider and cannot invoke a denied or
   approval-protected tool without the same governance path as an interactive
   call.
3. Define and test missed-run, crash, timeout, retry/backoff, and terminal
   failure semantics. Every occurrence needs stable ID, attempt number, start/
   finish time, error summary, and output reference without storing secrets.
4. Test workspace isolation for same-purpose schedules and runtime recreation;
   add a separately gated real-child-process smoke test only after the injected
   launcher contract is stable.
5. Add a browser capability test that correctly explains whether scheduling is
   available in the active workspace and where history/errors can be observed.

### MISSING-11 — Memory Browser standalone service

**Primary code:** `packages/plugins/memory-browser/src/index.ts` and its static
assets.

1. Start the plugin's standalone HTTP server against a temporary store and an
   ephemeral port. Assert `/api/health`, list/search filters, create, get,
   update, delete, and structured error responses.
2. Test filtering by text/state/metadata, pagination or limits if supported,
   URL decoding, and no cross-workspace results.
3. Test version-aware CAS: stale update/delete returns `409` with the current
   record, a retry using the returned version succeeds, and concurrent tabs do
   not overwrite each other.
4. Add Playwright coverage against that standalone base URL for initial load,
   search/filter, manual create/edit, conflict/retry, empty/error states, and
   keyboard-accessible controls. This is distinct from the in-page launcher.

### MISSING-13 — Source registry health and freshness

**Primary code:** `packages/plugins/source-registry/src/index.ts` and Sources
architecture panel.

1. With the fake clock, record `healthy`, `degraded`, and `down` events for one
   source. Assert ordered history, current state, health-report counts,
   severity, and state-specific finding messages.
2. Create sources with fresh, stale, and unknown `lastSuccessfulReadAt`/SLA
   values. Advance the clock through the threshold and assert freshness
   transitions and alerts without waiting in real time.
3. Exercise read/retrieve/cite/write/delete/health-check events. Assert the
   audit records principal, timestamp, source and version IDs, decision, and
   ordering, while sensitive fields are redacted.
4. Upsert multiple content/schema versions, test citation resolution to each
   version, and assert the latest-version policy does not erase historical
   provenance. Add browser checks for report/history/freshness detail and
   recovery from a failed refresh.

### MISSING-15 — WebUI branding and label customisation

This item is blocked by a product decision, not merely a missing test. The
current frontend hard-codes its title/labels and CSS variables; the repository
does not expose a branding schema or endpoint.

1. First define a tracked, validated branding configuration (for example title,
   product label, logo URL or local asset, and a restricted color token set),
   precedence rules, fallback values, workspace-versus-install scope, and safe
   asset policy. Do not place this in a workspace-local state file.
2. Implement a server-delivered public configuration payload and apply it before
   the UI first renders. Restrict colors to validated CSS tokens and render
   labels/assets as inert text/allowlisted URLs.
3. Add unit/schema tests for defaults, partial overrides, invalid colors/URLs,
   and safe fallback. Add WebUI tests asserting custom title/labels/token values
   appear consistently in shell, navigation, dialogs, and document title, and
   that no default label leaks in the configured surfaces.
4. Test reload/workspace switching semantics according to the chosen scope and
   test accessibility: readable contrast, stable accessible names, and no
   branding asset remote-request leak unless explicitly allowlisted.

## Implementation outcome — 2026-07-30

The first implementation pass added executable coverage for every `MISSING-*`
area, but the identifier-level mapping is **not** equivalent to completion of
every numbered acceptance criterion above. A stricter re-audit corrected RAG
context validation/migration and identified the remaining feature/test gaps
below. This section is deliberately factual: do not use it to mark the backlog
complete until the open criteria are implemented and tested.

| Plan area | Executable evidence |
| --- | --- |
| MISSING-01 CUDA/RAG state | `tests/workspace-rag-cuda-health.test.mjs`, `tests/workspace-rag-e5-runtime.test.mjs`, `tests/workspace-rag-state.test.mjs`, guarded CUDA Compose test |
| MISSING-02 / MISSING-14 Docker rotation/health | `tests/docker-stack.integration.mjs` under `CORTEX_DOCKER_INTEGRATION=1` |
| MISSING-03 / MISSING-12 reindex/context configuration | `tests/workspace-rag.test.mjs`, `tests/workspace-rag-state.test.mjs`, WebUI RAG settings test |
| MISSING-04 expert configuration | `tests/expert-panel-config*.test.mjs` and the existing expert-panel suite |
| MISSING-05 plugins | `tests/plugin-discovery-runtime.test.mjs` and WebUI discovery flow |
| MISSING-06 file broker | `tests/file-broker-approval.test.mjs` / runtime HTTP fixture |
| MISSING-07 graph | `tests/context-graph.test.mjs` / runtime graph chain fixture |
| MISSING-08 workflows | `tests/workflow-governance.test.mjs` and shadow-lab WebUI flow |
| MISSING-09 evaluation/ROI | evaluation runtime, CLI, pricing, and WebUI flows |
| MISSING-10 scheduling | `tests/scheduled-execution.test.mjs` and `tests/background-scheduling.test.mjs` |
| MISSING-11 memory browser | `tests/memory-browser-standalone.test.mjs` and standalone-base-URL Playwright flow |
| MISSING-13 source registry | source-registry runtime, fake-clock freshness, and Sources WebUI flow |
| MISSING-15 branding | `tests/webui-branding.test.mjs` and branding WebUI flow |

### Strict re-audit — outstanding acceptance criteria

- **MISSING-01:** MiniLM/E5 dimensions, profile prefixes, sidecar batch size,
  malformed health fields, queue/error state, and absent cancellation are now
  asserted. The guarded Compose test remains unexecuted until a disposable GPU
  host is available.
- **MISSING-02/MISSING-14:** add the post-recreation Markdown reindex/search,
  one-connection-string-negative path, and the requested time-bounded CI job.
- **MISSING-03/MISSING-12:** the runtime now validates blank/duplicate names,
  inaccessible paths, and legacy config migration; still add partial-read,
  model-drift/no-duplicate-chunk, delayed-WebUI warning/ARIA, and
  affected-context-only reindex assertions.
- **MISSING-04 through MISSING-09:** existing tests cover representative
  runtime/UI flows, but the plan's complete failure, alias, multiple-path,
  zero-denominator/recreation, and pricing-provenance matrices still need
  explicit assertions where listed.
- **MISSING-10:** retry/backoff, missed-run, timeout/crash occurrence history,
  tool-policy parity, injected clock/launcher scheduling, real-child-process
  smoke, and scheduling capability UI are not product contracts today; they
  require implementation before meaningful tests can be added.
- **MISSING-11:** API/CAS and standalone load/create/edit/conflict-retry/filter/
  delete are covered. Empty/error and keyboard-accessibility browser scenarios
  remain.
- **MISSING-13:** source freshness has a fake-clock unit test; the runtime now
  verifies ordered read/retrieve/cite/write/delete/health-check audit events,
  principal/version provenance, and secret redaction. Add fake-clock
  health-report assertions and browser history/freshness detail.
- **MISSING-15:** branding defaults/fallback and shell title/color are covered.
  Logo/allowlisted URL policy, configured labels in all surfaces, reload/switch,
  contrast/accessibility, and remote-request leakage still need a defined
  product contract and tests.

The WebUI now has an install-scoped, validated branding payload served from
`/branding`. It accepts product/title text and safe CSS color tokens through
`CORTEX_WEBUI_BRANDING_JSON`; invalid data falls back to Cortex defaults and is
rendered as text, not HTML.

Docker/Mem0 and CUDA automation is available through guarded scripts:

```powershell
$env:CORTEX_DOCKER_INTEGRATION = "1"; npm run test:integration:docker
$env:CORTEX_CUDA_INTEGRATION = "1"; npm run test:integration:cuda
```

They are intentionally skipped in the ordinary suite and were not run on this
workstation. The Docker fixture permits cleanup only for its generated
`cortex-test-*` Compose project.

## Delivery sequence

1. Land the shared temporary-root, fake-clock, sidecar, and Docker safety
   helpers with their own tests. Add the new opt-in scripts and docs before any
   destructive scenario.
2. Implement fast deterministic expansions: RAG health/status, expert config,
   file-broker policies, graph traversal, workflow metrics, evaluation pricing,
   scheduling history, memory service API, and source freshness.
3. Extend the Playwright harness and browser journeys for RAG, experts, plugin
   lifecycle, workflow/evaluation panels, memory browser, and source health.
4. Add real-process and Docker tests once the deterministic contracts pass.
   Keep CUDA/E5 download work in the highest-cost opt-in lane.
5. Resolve branding as a product feature, then implement and test it as one
   coherent change rather than writing tests for an absent interface.

## Completion criteria

The supplied scope is covered when every row has an executable test ID and
recorded test layer; normal `npm test`, `npm run test:cli`, and
`npm run test:webui` remain deterministic and token-free; opt-in integration
tests are safe to run repeatedly on a disposable host; status/history/ROI
assertions use controlled clocks and explicit response gates; and test output
does not expose passwords, API keys, local workspace data, or user files.

Run the following after each implementation slice:

```powershell
npm test
npm run test:cli
npm run test:webui
corepack pnpm -C local-agent/matbot -r run typecheck
git diff --check
```

Run Docker/CUDA commands only through the new guarded scripts on a disposable
host. Before committing any test work, explicitly stage intended files and
confirm that `local-agent/matbot/cortex-workspaces.json` and every path under
`local-agent/matbot/workspaces/` are absent from `git diff --cached --name-only`.
