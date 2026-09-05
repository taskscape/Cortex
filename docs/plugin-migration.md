# Plugin migration and capability profiles

The C1–C14 migration implements the sequence in [the architecture assessment](../missing_plugins.md). Cortex now composes workspace administration, host files, indexing, runtime administration, configuration, retrieval and diagnostics through plugins. Expert and RAG implementation families use explicit source/factory contracts inside their existing owners.

See [Target architecture and boundaries](architecture.md#target-architecture-and-boundaries) for the responsibility diagram, dependency direction, authorization/lifecycle contracts and state boundaries. This guide records package selection and migration compatibility.

The host still selects the initial workspace/configuration, constructs boot storage and vault defaults, resolves modules/providers, and owns process restart. The runtime owns sessions, invocation, permissions, hooks and contribution lifetimes. Plugins execute in the same trusted process; their contracts are ownership boundaries, not sandboxes.

## Selecting a deployment

Use `CORTEX_CAPABILITY_PROFILE`, or `capabilityProfile` in the selected YAML. The environment takes precedence. An absent selection means `standard`; an unknown value fails startup.

| Profile | Composition | File-service processes |
| --- | --- | --- |
| `standard` | Adds the standard capability set to configured plugins. Uses local file services and federated retrieval. | Broker/index HTTP processes are unnecessary. |
| `compatibility` | Uses the same product capabilities with explicitly selected remote file adapters. | Launch scripts retain file-index on 8877 and file-broker on 8878. |
| `minimal` | Loads only the configured plugin list, plus host workspace bootstrap and the CLI frontend when interactive mode requires it. | No implicit broker/index or Docker startup. Explicitly configured plugins may still need external services. |

The [profile composition function](../local-agent/matbot/apps/cli/src/capability-profiles.ts) is the authoritative default list. Standard composition includes workspace administration when a workspace is active; runtime administration/model consultation; configuration/diagnostics; expert-session support; high-cardinality storage; local file services; retrieval; source registry, connectors, structured data, workflows, evaluation, graph and Workspace RAG. Existing configured providers, frontends, sessions, cognition, skills, workspace artifacts and experts remain selected from configuration. Adding a service does not automatically add its LLM-facing tool or UI in a minimal profile.

```powershell
# Normal local deployment
.\scripts\run.ps1 -CapabilityProfile standard

# Preserve broker/index HTTP consumers
.\scripts\run.ps1 -CapabilityProfile compatibility

# Inspect capabilities selected by the running runtime
.\scripts\health-check.ps1 -CapabilityProfile standard
```

`start-local-agent.ps1`, `run-service.ps1`, `install-cortex-service.ps1`, `setup-local-agent.ps1` and `stop-local-agent.ps1` accept the same selection. Use the same profile when starting and stopping. Standard/compatibility launchers retain supervision of the existing external data stack; `-SkipDocker` remains available. The minimal profile skips that startup. Switching away from compatibility does not kill independently running broker/index services; stop the old deployment with its old profile first if those services are no longer wanted.

In-process file services share Cortex's process, policy files and configured host corpus. The compatibility profile preserves separate process ownership and supports other clients. Neither profile makes the host index workspace-private: search rechecks current path policy before returning host content. Workspace RAG and memory retain their own workspace scope.

Profiles are composed in memory. Startup no longer adds default plugins to every workspace YAML. Existing configuration, store names, sessions, uploads, RAG publications and secrets are not rewritten merely by choosing a profile. A workspace switch continues to restart the runtime; `WorkspaceContext` identifies the configuration actually running.

## Capability ownership

Paths below are relative to `local-agent/matbot/packages/plugins/` unless stated otherwise. A package's `matbotRuntime` declaration determines where it can load.

| Candidate | Owner and public boundary |
| --- | --- |
| C1 | `workspace-manager` (`@matatbread/matbot-workspace-manager-node`) owns registry persistence, CRUD, deletion reservations and switch requests. `workspace-manager-types` defines `WorkspaceManager`, immutable `WorkspaceContext` and deletion participants. `workspace-admin` owns `workspace_admin_action` and workspace UI. |
| C2 | `host-file-access` (`@matatbread/matbot-host-file-access-node`) owns the policy-enforcing service. Reusable implementation is in `local-agent/file-broker/src/service.ts`. The existing `local-agent/matbot/plugins/file-broker` owns `file_broker_action` and selects local or HTTP access once. `file-broker-http` is an optional listener. |
| C3 | `file-index` (`@matatbread/matbot-file-index-node`) owns indexing jobs, cancellation and persisted snapshots. Reusable implementation is in `local-agent/file-index/src/service.ts`. `file-index-admin` exposes `file_index` and a retrieval source; `file-index-client` selects a remote service; `file-index-http` is an optional listener. |
| C4 | Domain plugins own `ui.ts` descriptors and `ui-module.js` DOM implementations. `frontend/web` owns the shared chat shell, navigation, transport and contribution loader. `capabilities-types` defines UI and HTTP contribution shapes. |
| C5 | `expert-panel-session` owns `ExpertSessions`: composer submission, busy reservation, CAS message appends, usage/markers, cancellation and shared invocation of `expert_panel`. HTTP and browser transports adapt that operation. |
| C6 | `runtime-admin` owns `plugin`, `provider` and their UI. It has Node and browser entries. `model-consultation` owns `single_turn`. `plugin-materialization` is Node host infrastructure, not another product tool. Old factory import paths remain compatibility exports. |
| C7 | `frontend-cli` (`@matatbread/matbot-frontend-cli-node`) owns conversation input, rendering, forms and session selection. Initial setup/recovery, argv, stdin config and process exit remain in `apps/cli`. |
| C8 | `configuration-admin` owns `configuration_action`, the Configuration panel and redacted change history. `configuration-contributors` supplies scoped settings helpers. The owning domain validates and persists each change. |
| C9 | `retrieval-federation` owns `RetrievalFederation` and the federated `KnowledgeIndex`. `memory-local`, `memory-mem0` and `persist-ki-bge` offer explicit memory destinations. File-index, skills, cognition and RAG supply retrieval contributions. |
| C10 | `local-agent/matbot/plugins/expert-panel/src/providers.ts` defines expert definition snapshots and file/RAG knowledge factories. The panel still owns reviews, provider selection, orchestration and citations. |
| C11 | `workspace/src/attachments.ts` owns attachment interpretation through `AttachmentResolver`, reusing the existing workspace `FileStore`. The runner still owns ephemeral message injection. |
| C12 | `workspace-rag/src/adapters/` contains explicit embedding, repository, reranking and semantic constructors; `v2/source-filesystem.ts` supplies source acquisition. RAG retains reconciliation, watching, publication, citations and GC. |
| C13 | `vault-env` (`@matatbread/matbot-vault-env-node`) supplies `EnvFileVault` and a plugin entry. The Node host can construct the same implementation before plugins load. Writes are serialized and persisted atomically before updating in-memory secrets. |
| C14 | `runtime-diagnostics` owns `runtime_diagnostics`, `/api/diagnostics` and the Diagnostics panel. Bounded probes come from capability owners; there is no new process supervisor or telemetry store. |

The shared shell no longer implements Sources, SQL, Workflows, Evaluation, Graph, Experts, workspace management/RAG settings, Skills, Memory, Files or runtime administration. Existing CSS/layout tokens and a compatibility bridge for cross-panel calls remain in the shell. New Configuration and Diagnostics panels demonstrate adding a view through a descriptor without domain handlers in the shell.

## Invocation, ownership and removal

`executeToolInvocation` in `core/runner` is shared by model turns and direct frontend invocations. It validates input, evaluates permission rules, dispatches call/result hooks, applies output limits, and carries provider/session/trace/cancellation context. Direct noninteractive requests return `approval_required` when consent is needed. Host-bound invocations fail closed when the host policy is missing; plugins cannot replace or unregister that policy through their scoped service API.

The conversation provider picker uses read-only `/providers` metadata (provider names only) or the browser registry. It remains usable when `runtime-admin` is absent. Provider creation, credential changes and other administration remain in the optional plugin.

The file tool's retained `approved` input now requests fresh runtime consent. It is not approval evidence. A high-risk write reaches the local or remote backend with approval only after the invocation gate supplies consent for that operation/path. Legacy broker HTTP `/write` retains its public payload for trusted external clients, which remain responsible for obtaining approval before setting that field. Root, realpath, verified-handle, backup, body-limit, loopback and optional token checks remain enforced at their existing file/HTTP boundaries. Do not expose a legacy approval-bearing HTTP client directly as an unchecked model tool.

`services.contributions.register(kind, id, value)` stamps the plugin owner and supplies a disposable registration. Types are augmented in `capabilities-types`. Supported families are `webui`, `http`, `configuration`, `retrieval` and `health`. Duplicate identities and HTTP method/path collisions are rejected. HTTP registrations are restricted to `/api/...`; they cannot shadow session/transport endpoints. Route handlers receive request/tool context and must delegate to the shared invoker when exposing a tool operation, as diagnostics does.

Failed setup/unload removes owned contributions, aborts tool and contribution lifetimes, and calls teardown. Removing an older service provider does not unregister a later replacement. Core swappable services retain the host's existing fallback semantics; optional services must be looked up per operation or observed through `mounted.consume()`.

UI discovery returns only installed owners. The loader mounts their markup and modules, creates navigation, and disposes handlers, polls, assets and pending tool requests on removal. Removing an open view returns to chat. Plugin events refresh the list in both HTTP and browser transports. UI modules are trusted application code; browser assembly type-strips and bundles their runtime dependency graph without importing Node implementations through portable entries.

Workspace deletion reserves all participating owners before modifying the installation registry. RAG blocks new jobs for the reserved workspace, drains/closes its owned resources and purges derivatives through its own lifecycle. Staged-directory rollback, pending filesystem cleanup reporting and deletion auditing remain. A reported `pendingCleanupPath` still requires operator follow-up; this migration does not add a durable cleanup-retry daemon.

## Configuration and adapter selection

`configuration_action` supports `list`, `get`, `update`, `history` and `restore`. Start with `list`, then `get` for the selected contributor and pass its `version` as `expectedVersion` on an update/restore. Updates are serialized per contributor and stale versions fail instead of overwriting another edit.

Initial contributors cover skills analysis provider, cognition pins/dream settings, the selected Workspace RAG context, and Node provider model names. The provider contributor intentionally edits model names for existing profiles; credentials remain in the vault and profile creation/removal remains in `provider`. Full bootstrap YAML editing is not implied by this interface. Existing `workspace_rag`, `cognition_config`, skills and provider APIs remain usable.

History records a redacted pre-change intent, then an applied/failed outcome. Restore revalidates under the current schema and retains current secrets. If an update succeeds but final history persistence fails, the result reports `historyPending` with its entry ID; it does not falsely report a rolled-back configuration. YAML, RAG JSON, registry and vault writes use sibling temporary files and rename; scoped settings use store CAS.

| Selection | Behavior |
| --- | --- |
| Legacy `hybrid-knowledge-index` in standard/compatibility | Composed as Mem0 + file source + federation while preserving Mem0 user/workspace IDs. The old implementation remains available for explicit minimal/legacy deployments. |
| No selected memory adapter | Standard/compatibility chooses persistent `memory-local`. It does not silently connect to Mem0. |
| `memory-local`, `memory-mem0` or `persist-ki-bge` | Select one memory write destination. Multiple selections fail; loading another while one is active fails rather than broadcasting writes. BGE contributes to federation when present and remains a direct `KnowledgeIndex` in a legacy minimal host. |
| `CORTEX_EXPERT_KNOWLEDGE=file` (default) or `workspace-rag` | Selects the expert evidence factory. RAG results retain immutable passage IDs and are constrained by expert roots. Missing selected RAG is reported unavailable. |
| `EXPERT_PANEL_CONFIG` | Existing definition-file override. Validated snapshots refresh subsequent panel calls while in-flight calls keep their captured definitions. |
| `CORTEX_RAG_EMBEDDING_BACKEND=auto` (default), `cpu`, `cuda` | `auto` preserves previous accelerator selection; `cpu` explicitly uses token-hash CPU embeddings; `cuda` requires the CUDA service and validated model/dimensions/signature. Explicit CUDA failure does not silently switch embedding semantics. |
| RAG repository factory `postgres` / `memory` | PostgreSQL/pgvector remains the durable backend. Memory is an explicit ephemeral/test choice. Backend replacement is a restart/drain operation. |

Federated searches carry principal, active workspace and cancellation, bound each source to five seconds, cap results, fuse ranks and retain source/citation identity. A source failure produces a partial result with source diagnostics; an available source with no matches is distinct. Memory writes go only to `MemoryWriteSink`. Existing RAG generation, incremental reconciliation, forced reindex, incomplete-discovery retention and managed/external blob GC rules remain under one owner.

File services continue to read `WORKSPACES_CONFIG`, `SECURITY_POLICY_CONFIG`, `FILE_INDEX_STORE` and the existing limits. HTTP adapters retain `FILE_INDEX_BASE_URL`, `FILE_BROKER_BASE_URL`, their port variables and optional `CORTEX_FILE_INDEX_TOKEN` / `CORTEX_FILE_BROKER_TOKEN`. There is no retry through a different adapter after denial or unload. Optional HTTP listener plugins require their local service to be loaded first. A minimal custom composition must order providers before consumers; there is no new dependency solver.

C10 and C12 deliberately use internal typed factories, as allowed by the migration sequence. Parsers, citation assembly, generation publication and GC have not been split into independently swappable plugins because they share correctness and persistence invariants.

## Development and verification

Both dependency graphs participate: the root npm workspaces build the existing file/expert integrations and nested Matbot pnpm workspaces typecheck the runtime and plugins. Build the root before checking consumers of emitted declarations.

```powershell
npm run build
corepack pnpm -C local-agent/matbot -r --no-bail typecheck
corepack pnpm -C local-agent/matbot/apps/web-bundle run assemble
npm run test:all
```

New regression coverage lives in `tests/plugin-migration-invocation.test.mjs`, `tests/plugin-migration-contracts.test.mjs`, `tests/plugin-migration-launch.test.mjs` and `tests/webui/plugin-contributions.spec.mjs`. It covers shared policy/hooks, forged approval rejection, failed setup/unload ownership, configuration CAS/redaction/restore, workspace deletion reservations, partial retrieval, index retention, adapter selection, expert snapshot isolation, isolated standard/minimal startup, capability routes, feature removal/reload and standalone browser startup. Existing file, RAG, expert, workspace, CLI and UI suites remain part of the regression lane.

Windows service installation and live Docker/Postgres/CUDA behavior require their separate deployment/integration checks. The migration tests use temporary workspaces and a local provider fixture; they do not modify the operator's active workspace or prove live external-service availability.

The 2026-09-05 verification passed the root build, all applicable package typechecks, browser assembly and PowerShell parser checks. `npm run test:all` completed with 291 Node, 5 CLI and 152 UI tests passing; six guarded Node cases and 118 project-specific UI cases were skipped. There were no failures. Live Docker/Postgres/CUDA integration and Windows service installation were not run.
