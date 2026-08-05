# Baseline Gap Inventory (Pre-Implementation)

> This opening inventory is retained as the baseline that produced the acceptance criteria below.
> It is not the current coverage status. See **Implementation Status (2026-08-05)** for verified
> coverage, shipped-contract corrections, and remaining product gaps.

### 1. **WebUI Feature Areas** (Not in Playwright Tests)

| Area | Description | Test Coverage Gap |
|------|-------------|-------------------|
| **Architecture Tab Navigation** | Keyboard navigation within the Architecture tab | Only basic tab semantics tested, not keyboard interaction |
| **Source Health Panel** | Visual display of source health reports with warnings/critical counts | No WebUI tests for health report visualization |
| **Governed SQL Preview Panel** | SQL query preview before execution | Not covered in Playwright; only backend execution tested |
| **Workflow Version Diffs** | Visual comparison of workflow version changes | Explicitly mentioned as "not implemented yet" in user guide |
| **Expert Review Assignment** | Manual reviewer assignment and status editing | Documented as "future product work" |
| **Source Freshness in Graph** | Display of source freshness directly inside graph detail | Future product work |

### 2. **Skill Editor Advanced Features** (Partially Covered)

**Already Tested**: Basic create/edit/delete
**Not Tested**:
- Trigger control interactions (conditions, events, delays)
- Metadata display after saving
- Editor behavior in offline sessions (error handling)
- Skill persistence across workspace switches

### 3. **Plugin Management Interactions**

**Already Tested**: Basic activation/deactivation
**Not Tested**:
- Plugin description and runtime types display
- Incompatible plugin display behavior
- Add/remove controls for optional plugins
- Workspace-specific plugin configuration effects

### 4. **Expert Panel Advanced Scenarios**

**Already Tested**: Basic expert selection, modes (parallel/review/debate), synthesis
**Not Tested**:
- Individual expert provider fallback behavior
- Expert knowledge root isolation verification
- 1MB file size limit enforcement
- Mode-specific output formatting
- Expert panel with disabled synthesis

### 5. **Workflow Operations Center**

**Already Tested**: Workflow compilation, approval decisions
**Not Tested**:
- **Overview Dashboard**: Visual cards showing compiled workflows, pending approvals, shadow acceptance rate
- **Run Ledger Inspection**: Typed inputs, evidence source IDs, proposed vs executed actions
- **Shadow Lab**: Labeling shadow results (Accept/Reject/Mark mixed)
- **Workflow Limitations**: Visual multi-step execution (documented as not implemented)
- **Background Scheduling**: Workflow execution via scheduled triggers

### 6. **Evaluation & ROI Panel**

**Already Tested**: Backend span capture, replay, regression suites
**Not Tested**:
- **Trace Waterfall Visualization**: Agent, model, tool, retrieval, policy, evaluator spans
- **Sponsor Evidence Display**: Citation coverage, action outcomes, workflow approvals, time saved, ROI
- **Regression Suite Execution**: Versioned suite selection and gate testing
- **Model Pricing JSON**: `CORTEX_MODEL_PRICING_JSON` environment variable behavior

### 7. **Context Graph Features**

**Already Tested**: Backend entity extraction, relationship assertion
**Not Tested**:
- **Graph Visualization**: Entity selection, relationship inspection
- **Multi-hop Retrieval**: Path search across relationships
- **Source Constraint**: Filtering by source ID
- **Refresh Behavior**: Discarding current retrieval results
- **Confidence Display**: Graph relationship confidence scores

### 8. **Durable Expert Reviews** (WebUI)

**Already Tested**: Backend `expert_panel.review`, persistence
**Not Tested**:
- **Review Creation Flow**: WebUI form for question, target type, target ID, workflow ID/run ID, expert selection
- **Review Card Display**: Expert recommendations, confidence, evidence, risks, blockers, mitigations, approval checklist
- **Synthesis Display**: Consensus, disagreements, risk register, synthesis text
- **Target Type Selection**: Workflow, workflow run, alert, investigation, chat

### 9. **Scheduled & Unattended Actions**

**Already Tested**: Background plugin basic scheduling
**Not Tested**:
- **Schedule UI**: No WebUI for managing recurring schedules
- **Schedule Management**: Suspend, resume, cancel via WebUI
- **Scheduled PowerShell/HTTP/Bash execution**: Full workflow from WebUI
- **Service Installation**: `run-service.ps1`, WinSW configuration, service management
- **Cortex Service Management**: Start/Stop/Restart via `services.msc`

### 10. **Memory Browser Standalone**

**Already Tested**: Basic CRUD operations in Playwright harness
**Not Tested**:
- **Standalone Mode**: Running `open_memory_browser` without WebUI
- **Memory Browser Port**: `http://127.0.0.1:19779` functionality
- **Browser-native Backends**: IndexedDB, OPFS, WebCrypto in standalone mode

### 11. **Workspace RAG Advanced Config**

**Already Tested**: Basic markdown ingestion, vector storage
**Not Tested**:
| Feature | Description |
|---------|-------------|
| **Embedding Model Switching** | Between MiniLM and E5 models via `.env` configuration |
| **CUDA Embedding Sidecar** | `workspace-rag-cuda` Docker service with NVIDIA GPU acceleration |
| **Reindex Progress**: Status polling for embedding progress |
| **Batch Size Configuration**: `WORKSPACE_RAG_EMBEDDING_BATCH_SIZE` tuning |
| **Model Contract Verification**: Health endpoint validation of dimensions/profile/prefixes |

### 12. **Cognition Tools Direct HTTP API**

**Already Tested**: Backend `remember_fact`, `dream_time`, `ask_inner_voice`
**Not Tested**:
| Tool | HTTP Endpoint | Coverage Gap |
|------|---------------|--------------|
| **Dream Runs** | `POST /tools/dream_runs_action` | Listing/inspection of memory consolidation runs |
| **Ask Inner Voice** | `POST /tools/ask_inner_voice` | Direct HTTP calls with `$context` envelope |
| **Cognition Config** | `POST /tools/cognition_config` | GET/SET operations for inner voice, dream providers, thresholds |

### 13. **Structured Data Advanced Features**

**Already Tested**: SQL planning, approval, execution, result provenance
**Not Tested**:
- **Semantic Table/Column/Metric Registration**: WebUI for data connection registration
- **Query Run Inspection**: Viewing planned queries, SQL hash, semantic inputs
- **Approval Token Flow**: One-time token generation and validation
- **Data Connection Management**: Adding/removing Postgres connections

### 14. **Connector Fabric Policy**

**Already Tested**: Backend connector registry, grants, audit events
**Not Tested**:
- **Connector Grant Management**: WebUI for viewing/modifying connector grants
- **Tool Binding Display**: Visualization of which tools connect to which connectors
- **Capability Handling**: Read/write/admin tool classification display
- **Audit Event Inspection**: WebUI for connector audit logs

### 15. **Source Registry Features**

**Already Tested**: Backend source records, versions, health events
**Not Tested**:
| Feature | Description |
|---------|-------------|
| **Source Events Timeline** | WebUI display of health/access events for sources |
| **Source Ownership** | Display of source ownership information |
| **Stale Source Warnings** | Visual indicators for stale/expired/degraded sources in retrieval results |
| **Source Health Report Export** | Download/source health reports as JSON/CSV |

### 16. **Safety Boundary Features**

**Already Tested**: Basic workspace isolation
**Not Tested**:
- **localhost Binding**: WebUI not exposed remotely (manual verification only)
- **High-Risk Write Approval**: WebUI flow for approving `.env` and similar files
- **File Broker Diff Display**: Unified diff visualization for overwrites
- **Backup Path Display**: Location of backup files for overwrites

### 17. **Troubleshooting Scenarios** (Documented but Not Automated)

| Scenario | Documentation | Test Coverage |
|----------|---------------|---------------|
| **Provider Missing** | Restart Cortex, hard-refresh browser | No automated check |
| **Feature Plugin Unavailable** | Verify plugin in sidebar, restart | No automated check |
| **Old WebUI Display** | Stop/run scripts, verify port 19778 | No automated check |
| **Mem0 Password Rotation** | Docker compose down -v, recreate | Only integration tests cover this |

### 18. **Docker Integration** (Guarded, Not in CI)

**Already Tested**: Docker stack integration (manual `CORTEX_DOCKER_INTEGRATION=1`)
**Not Tested in CI**:
- **Postgres/pgvector**: Full database connectivity tests
- **Neo4j Authentication**: Graph database credential validation
- **Mem0 API Reachability**: API endpoint health checks
- **CUDA Embeddings**: GPU-based embedding model validation
- **E5 Model Download**: Large model cache validation

### 19. **Expert Panel Configuration**

**Already Tested**: Backend expert execution, file knowledge
**Not Tested**:
- **Expert Provider Configuration**: Per-expert provider selection in WebUI
- **System Prompt Editing**: WebUI for editing expert system prompts
- **Knowledge Root Configuration**: Adding/removing expert knowledge directories
- **Expert Tags**: Tag-based expert filtering/search

### 20. **Workflow Compiler Limitations**

**Already Tested**: Basic compilation from transcript
**Not Tested**:
- **Draft-Only Mode**: Compiling without publishing
- **Sample Input Generation**: Auto-generating sample inputs from `{{placeholders}}`
- **Validation Error Display**: WebUI for compiler warnings
- **Source ID Selection**: UI for selecting evidence sources during compilation

---

## Baseline Summary Statistics

| Category | Count |
|----------|-------|
| **Major Untested Feature Areas** | 20 |
| **Partially Covered Features** | 15 |
| **Backend-Only Features** | 12 |
| **WebUI-Only Features** | 8 |
| **Docker/Integration Features** | 5 |

## Priority Recommendations

### High Priority (User-Facing)
1. **Workflow Operations Center** - Complete workflow management workflow
2. **Evaluation & ROI Panel** - Sponsor-facing metrics display
3. **Architecture Tab Navigation** - Keyboard accessibility
4. **Source Health Visualization** - Critical warning display

### Medium Priority (Developer Experience)
5. **Plugin Management UI** - Better visibility into plugin state
6. **Skill Editor Triggers** - Trigger configuration validation
7. **Memory Browser Standalone** - Offline memory access
8. **Expert Panel Provider Fallback** - Provider selection UI

### Lower Priority (Edge Cases)
9. **Docker CUDA Integration** - GPU acceleration validation
10. **Workflow Version Diffs** - Visual comparison
11. **Manual Review Assignment** - Expert review workflow
12. **Source Freshness in Graph** - Graph visualization enhancement

# Cortex Test Gaps and Acceptance Criteria

This chapter defines acceptance criteria for automated tests covering functionality currently missing from Cortex's test suite.

---

## Implementation Status (2026-08-05)

Status is based on tests present in this repository and the focused validation run performed while
updating this document. **Fixed** means every criterion is covered by an executable test as written
or by its documented shipped equivalent; fixed gaps must not be re-attempted. **Partial** means useful
coverage exists but one or more listed criteria describe behavior that is not shipped, use stale
API/UI wording, or still require optional infrastructure. The disposition contract enforces that an
area cannot be marked Fixed while it still has a commented criterion.

| Area | Status | Implemented coverage and relevant comments |
|------|--------|--------------------------------------------|
| 1. Architecture Tab Navigation | **Partial** | `tests/webui/governed-architecture-acceptance.spec.mjs` implements AT-1/2/3 against the shipped WAI-ARIA roving-tab contract (Arrow keys plus Enter/Space) and checks a visible focus indicator. The architecture tablist has six tabs; Plugins is a separate sidebar area. AT-4/5 are not testable as written because the URL hash stores the active conversation/session ID, not architecture routing state. |
| 2. Source Health Panel | **Fixed** | `tests/webui/governed-architecture-acceptance.spec.mjs` implements SHP-1 through SHP-7: healthy/warning/critical counts, distinct warning and critical list treatments, accessible status tooltips/icons, a source health report modal, and source/version/connector/count detail. Existing inline findings and event inspection remain available after the modal closes. |
| 3. Governance SQL Preview | **Partial** | `tests/webui/governed-architecture-acceptance.spec.mjs`, `tests/webui/matbot-webui.spec.mjs`, and `tests/structured-data.test.mjs` cover preview-before-execution, semantic/table/source details, approval gating, approval invalidation, execution status, rows, citations, and governed SQL rejection. Inline DDL/DML/cross-join messages and a query-cost estimate are not shipped in this panel. |
| 4. Workflow Operations Center Overview | **Fixed** | `tests/webui/governed-architecture-acceptance.spec.mjs` implements WOC-1 through WOC-8: four navigable summary metrics, live workflow/run/pending counts, shadow acceptance and trend, critical failed-run treatment, named/timestamped recent runs, and a 30-second refresh while the panel is visible. Existing `tests/webui/matbot-webui.spec.mjs` scenarios retain partial-service recovery coverage. |
| 5. Workflow Run Ledger | **Fixed** | `tests/webui/governed-architecture-acceptance.spec.mjs` implements WRL-1 through WRL-8: complete run identity, collapsible typed inputs, source/version links into Source details, separate proposed/executed action disclosures with approval/input/output/error/duration data, ordered events, and workflow/run/status filtering. Existing WebUI tests retain failed-action output coverage. |
| 6. Workflow Shadow Lab | **Fixed** | `tests/webui/governed-architecture-acceptance.spec.mjs` implements WSL-1 through WSL-8: unlabeled shadow recommendations and evidence, Accept/Reject/Mark mixed records, durable recommendation hashes/source IDs/timestamps, overview-rate recalculation, and immediate removal of labeled runs from the unlabeled list. Labeled comparisons remain durable through `shadow_report`. |
| 7. Skill Trigger Controls | **Partial** | `tests/webui/advanced-editor-plugin-acceptance.spec.mjs` implements trigger-condition add/edit/delete persistence across save and reopen. Existing `tests/webui/matbot-webui.spec.mjs` covers metadata, save failure, and offline editor behavior. The shipped editor uses inline contextual/follow-up condition rows; it does not expose the schedule/file-event modal or cron/action fields described by STE-2/3/5/6. |
| 8. Plugin Management | **Partial** | `tests/webui/advanced-editor-plugin-acceptance.spec.mjs` implements incompatible reason/runtime requirements plus description, runtime type/service badges, and tool metadata. Existing WebUI tests cover compatible add/remove, failed activation/removal rollback, reload persistence, and core-plugin protection. Core plugins intentionally have no Remove control, so PM-5's confirmation dialog is not reachable. |
| 9. Expert Provider Fallback | **Fixed** | `tests/expert-panel-provider-fallback.test.mjs` implements EPF-1 through EPF-7. Provider selection now walks the available expert-pin, turn, and panel-default candidates; unavailable configured providers no longer bypass later candidates. Every opinion and synthesis response includes the selected provider, source, fallback flag, and evaluated chain, and actual fallbacks emit a scoped console audit event. |
| 10. Expert Knowledge Isolation | **Fixed** | `tests/expert-panel-file-knowledge.test.mjs`, `tests/expert-panel-config.test.mjs`, and `tests/expert-panel-config-validation.test.mjs` implement EKI-1 through EKI-7: isolated roots, supported/unsupported extensions, relative path resolution, startup validation, and runtime diagnostics. Oversized files emit a response-visible warning, and a root that becomes inaccessible after startup produces an expert-response warning with no citations. |
| 11. Standalone Memory Browser | **Partial** | `tests/memory-browser-standalone.test.mjs`, `tests/memory-browser-plugin-lifecycle.test.mjs`, `tests/webui/memory-browser-standalone.spec.mjs`, and `tests/webui/matbot-webui.spec.mjs` cover the default port contract, loopback HTTP startup, lifecycle teardown, title/header, workspace isolation, CRUD, filtering, CAS conflicts, and cross-tab refresh/reconciliation. The Node-hosted standalone browser uses the injected workspace store; MBS-2/3's IndexedDB/OPFS/WebCrypto backend switching describes the separate browser-bundle runtime, not this standalone server. |
| 12. Workspace RAG Model Switching | **Partial** | `tests/workspace-rag-e5.test.mjs`, `tests/workspace-rag-e5-runtime.test.mjs`, `tests/workspace-rag-state.test.mjs`, and CUDA health/fallback tests cover embedding signatures, E5/MiniLM dimensions and prefixes, batch identity, reindex state/progress, queued reindex behavior, and CPU fallback. Real Postgres table coexistence and comparative performance remain guarded Docker/GPU integration work. |
| 13. Cognition Direct Tools | **Fixed** | CTA-1/2/3 are covered through direct `$context` calls in `tests/webui/matbot-webui.spec.mjs`. `tests/cognition-tools-direct.test.mjs` implements CTA-4/5/6/7/8: dream-run inspection, all provider pins and tunables, atomic invalid-patch rejection, and blocklist routing exclusion. Correction: generated store tools use `dream_runs_action { action: "query" }`, not the stale `action: "list"` wording in CTA-4. |
| 14. Evaluation and ROI | **Fixed** | `tests/webui/governed-architecture-acceptance.spec.mjs`, `tests/webui/matbot-webui.spec.mjs`, `tests/evaluation-observability.test.mjs`, and `tests/evaluation-pricing.test.mjs` cover span waterfall fields, sponsor evidence metrics, ROI/rate calculations, zero-cost/negative-benefit handling, regression gates, and `CORTEX_MODEL_PRICING_JSON`. |
| 15. Context Graph Retrieval | **Fixed** | `tests/context-graph.test.mjs` and the graph scenarios in `tests/webui/matbot-webui.spec.mjs` cover normalized comma-separated terms, source constraints, entity/relationship/evidence/confidence display, multi-hop provenance, denied-source filtering, malformed edges, stale responses, and refresh/error recovery. |
| 16. Durable Expert Review UI | **Partial** | `tests/webui/matbot-webui.spec.mjs` covers review creation, required-field and target validation, target types, expert de-duplication, backend persistence, cards, structured recommendations/risks/checklists, retry, and workspace isolation. The shipped flow is an inline form with comma-separated expert IDs, not a modal multi-select as stated by DER-2/5. |
| 17. Scheduled and Unattended Actions | **Fixed (Node)** | `tests/background-scheduling.test.mjs` and `tests/scheduled-execution.test.mjs` cover schedule creation/validation, list/suspend/resume/cancel lifecycle, interval execution, persistence, principal inheritance, policy binding, and workspace isolation. No schedule-management WebUI is shipped, and the criteria explicitly allow Node coverage when no UI exists. |
| 18. Source Events Timeline | **Fixed** | `tests/source-registry.test.mjs`, `tests/source-registry-freshness.test.mjs`, and `tests/webui/governed-architecture-acceptance.spec.mjs` implement SRT-1 through SRT-8. The source action returns access, health, and version events; the selected-source timeline orders them newest first and exposes clickable event details including source/version, workspace, user/principal, tool call, provenance, and metadata. Persistence and workspace isolation remain covered by the registry tests. |
| 19. Expert Mode Formatting | **Fixed** | `tests/expert-panel-config.test.mjs`, `tests/expert-panel.test.mjs`, and composer WebUI tests implement EPM-1 through EPM-8. Parallel answers remain independent; review responses always expose Strengths/Risks/Omissions/Practical concerns; debate responses always expose Position/Disagreements/Tradeoffs; synthesis and no-synthesis paths, audit mode metadata, repeatable format schemas, citations, and current-mode UI are covered. Provider prose remains intact, with deterministic placeholders only for omitted required sections. |
| 20. Workflow Draft-Only Compilation | **Fixed** | `tests/workflow-draft-only.test.mjs` and `tests/webui/governed-architecture-acceptance.spec.mjs` implement WCD-1 through WCD-8: persisted draft compilation without definitions/versions, deterministic sample inputs/hash/compiler version, visible validation errors and compiler warnings, and later publication. The shipped publish operation recompiles the persisted input with `publish: true`; the Workflow Library renders the resulting release checks. |
| 21. High-Risk Write Approval | **Partial** | `tests/file-broker-approval.test.mjs`, `tests/local-agent.test.mjs`, and WebUI prompt/error tests cover high-risk path approval, rejection, diff/backup creation, backup-path enforcement, read policy, audit outcome, and traversal/junction safety. A dedicated high-risk modal rendering the unified diff and backup path is not currently shipped. |
| 22. Docker CUDA Integration | **Partial / guarded** | `tests/workspace-rag-cuda-health.test.mjs`, `tests/workspace-rag-cuda-fallback.test.mjs`, and `tests/workspace-rag-cuda-app.test.mjs` cover health contracts, model reuse, E5 preprocessing, CPU fallback, OOM handling, cache mounting, and ingestion integration without requiring a GPU. Real NVIDIA startup, GPU memory measurement, CPU/GPU vector parity/performance, and first-download validation remain optional hardware tests. |
| 23. Workspace Deletion | **Fixed** | `tests/workspace-deletion.test.mjs`, `tests/workspace-deletion-runtime.mjs`, and workspace deletion WebUI scenarios implement WSD-1 through WSD-8. Owned directories are atomically staged before the registry commit, pre-commit failures restore the directory and preserve the registry, every cleanup step is audited, and post-commit purge failures return an explicit cleanup-pending tombstone without exposing a live workspace. Active/other workspaces and external junction targets remain protected. |
| 24. Memory Policy Path Mapping | **Contract only** | `tests/memory-policy-path-mapping.test.mjs` validates the checked-in policy and Windows/WSL/Docker mapping schemas. The repository has no production reader for these assets, so MPD runtime indexing exclusions, size/count limits, retention, and cleanup cannot be truthfully integration-tested until a consumer is implemented. The duplicate baseline IDs have been corrected to MPD-1 through MPD-8. |
| 25. Runtime Plugin Discovery | **Partial** | `tests/plugin-discovery-runtime.test.mjs`, `tests/plugin-runtime-add.test.mjs`, and WebUI plugin tests cover bundled discovery, local-path add, activation/config persistence, metadata, incompatibility, rollback, and invalid paths. NPM installation through pnpm and dependency-graph lifecycle assertions remain unimplemented integration cases. |

### Criterion-Level Disposition

Every acceptance ID below is classified exactly once. **Implemented/adapted** means an executable
test covers either the criterion as written or the documented shipped equivalent. **Commented**
means the stated behavior is not currently a product contract, uses stale UI/API wording, or
requires optional infrastructure unavailable to the default suite. This matrix is enforced by
`tests/test-gaps-criteria-contract.test.mjs`.

| Area | Implemented/adapted criteria | Commented criteria and reason |
|------|------------------------------|-------------------------------|
| Architecture tabs | `AT-1`, `AT-2`, `AT-3` | `AT-4`, `AT-5`: the URL hash belongs to conversation routing; architecture state is not URL-persisted. Keyboard navigation uses the shipped roving-tab Arrow-key contract and Plugins remains outside the tablist. |
| Source health | `SHP-1`, `SHP-2`, `SHP-3`, `SHP-4`, `SHP-5`, `SHP-6`, `SHP-7` | None. Counts and severity treatments derive from the source-health report; list items expose accessible tooltips/icons and open a detailed modal while retaining the inline source/event pane. |
| Governed SQL | `GSP-1`, `GSP-2`, `GSP-3`, `GSP-5`, `GSP-6` | `GSP-4`, `GSP-7`: invalid SQL is enforced at the backend boundary rather than an inline editor, and no cost-estimation model is exposed. |
| Workflow overview | `WOC-1`, `WOC-2`, `WOC-3`, `WOC-4`, `WOC-5`, `WOC-6`, `WOC-7`, `WOC-8` | None. Summary cards navigate to Library, Run Ledger, Approvals, and Shadow Lab; recent runs resolve the compiled workflow name; automatic refresh runs every 30 seconds only while the Workflow Operations panel is visible. |
| Run ledger | `WRL-1`, `WRL-2`, `WRL-3`, `WRL-4`, `WRL-5`, `WRL-6`, `WRL-7`, `WRL-8` | None. Typed inputs and individual proposed/executed actions use native disclosures; evidence IDs and versions navigate to the matching Source detail. |
| Shadow Lab | `WSL-1`, `WSL-2`, `WSL-3`, `WSL-4`, `WSL-5`, `WSL-6`, `WSL-7`, `WSL-8` | None. Labeled comparisons remain durable in the report but are removed immediately from the unlabeled Shadow Lab list. |
| Skill triggers | `STE-1`, `STE-4`, `STE-7`, `STE-8` | `STE-2`, `STE-3`, `STE-5`, `STE-6`: the shipped editor uses inline contextual/follow-up condition rows, not a schedule/file-event modal with cron/action fields. |
| Plugins | `PM-1`, `PM-2`, `PM-3`, `PM-4`, `PM-6`, `PM-7`, `PM-8` | `PM-5`: core plugins intentionally expose no Remove control, so no core-removal confirmation can open. |
| Expert provider fallback | `EPF-1`, `EPF-2`, `EPF-3`, `EPF-4`, `EPF-5`, `EPF-6`, `EPF-7` | None. Fallbacks emit scoped console audit events; expert and synthesis results include the selected provider, source, fallback flag, and evaluated provider chain. |
| Expert knowledge roots | `EKI-1`, `EKI-2`, `EKI-3`, `EKI-4`, `EKI-5`, `EKI-6`, `EKI-7` | None. Missing roots are rejected at startup; roots that become inaccessible at runtime and oversized files are reported through the expert response `warnings` field. |
| Standalone memory browser | `MBS-1`, `MBS-4`, `MBS-5`, `MBS-6`, `MBS-7`, `MBS-8` | `MBS-2`, `MBS-3`: IndexedDB/OPFS/WebCrypto are browser-bundle storage concerns; the standalone Node server uses the injected workspace store. |
| Workspace RAG switching | `WRS-1`, `WRS-2`, `WRS-3`, `WRS-6`, `WRS-7` | `WRS-4`, `WRS-5`, `WRS-8`: real Postgres table selection/coexistence remains guarded Docker integration coverage. |
| Cognition direct tools | `CTA-1`, `CTA-2`, `CTA-3`, `CTA-4`, `CTA-5`, `CTA-6`, `CTA-7`, `CTA-8` | None. Dream-run inspection uses the shipped generated-store verb `action: "query"` instead of stale `action: "list"` wording. |
| Evaluation and ROI | `ERO-1`, `ERO-2`, `ERO-3`, `ERO-4`, `ERO-5`, `ERO-6`, `ERO-7`, `ERO-8` | None. |
| Context graph | `CGR-1`, `CGR-2`, `CGR-3`, `CGR-4`, `CGR-5`, `CGR-6`, `CGR-7`, `CGR-8` | None. |
| Durable reviews | `DER-1`, `DER-3`, `DER-6`, `DER-7`, `DER-8` | `DER-2`, `DER-4`, `DER-5`: the shipped UI is an inline form, currently exposes Workflow as its target option, and accepts de-duplicated comma-separated expert IDs rather than a modal multi-select. |
| Scheduled actions | `SUA-1`, `SUA-2`, `SUA-3`, `SUA-4`, `SUA-5`, `SUA-6`, `SUA-7`, `SUA-8` | None; the criteria permit Node coverage when no management UI exists. |
| Source events | `SRT-1`, `SRT-2`, `SRT-3`, `SRT-4`, `SRT-5`, `SRT-6`, `SRT-7`, `SRT-8` | None. Access, health, and version events are shown in a clickable timeline with a dedicated metadata detail card. |
| Expert modes | `EPM-1`, `EPM-2`, `EPM-3`, `EPM-4`, `EPM-5`, `EPM-6`, `EPM-7`, `EPM-8` | None. Review and debate answers have deterministic required-section schemas across runs while preserving provider prose; missing sections receive explicit placeholders rather than invented content. |
| Workflow drafts | `WCD-1`, `WCD-2`, `WCD-3`, `WCD-4`, `WCD-5`, `WCD-6`, `WCD-7`, `WCD-8` | None. The shipped publish operation recompiles the persisted draft input with `publish: true`; the Library displays validation details and compiler warnings. |
| High-risk writes | `HWA-1`, `HWA-4`, `HWA-5`, `HWA-6`, `HWA-7`, `HWA-8` | `HWA-2`, `HWA-3`: approval, diff, and backup data exist at the broker/prompt boundary, but no dedicated high-risk diff modal is shipped. |
| CUDA integration | `DCU-2`, `DCU-5`, `DCU-8` | `DCU-1`, `DCU-3`, `DCU-4`, `DCU-6`, `DCU-7`: real NVIDIA startup, CPU/GPU vector parity, GPU-memory measurement, comparative performance, and a first-run model download require optional hardware integration; the default suite validates image preload/cache contracts. |
| Workspace deletion | `WSD-1`, `WSD-2`, `WSD-3`, `WSD-4`, `WSD-5`, `WSD-6`, `WSD-7`, `WSD-8` | None. The deletion transaction has injected pre-commit rollback and post-commit purge-failure coverage plus an explicit cleanup audit log. |
| Memory policy | `MPD-1`, `MPD-2` | `MPD-3`, `MPD-4`, `MPD-5`, `MPD-6`, `MPD-7`, `MPD-8`: checked-in schemas are tested, but no production reader currently enforces indexing exclusions, patterns, limits, retention, or cleanup. |
| Runtime plugin discovery | `PDR-1`, `PDR-2`, `PDR-4`, `PDR-5`, `PDR-6`, `PDR-8` | `PDR-3`, `PDR-7`: NPM/pnpm installation and dependency-graph lifecycle validation remain unimplemented integration behavior. |

---

## 1. Architecture Tab Navigation (Keyboard Accessibility)

**Priority**: High
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| AT-1 | Tab navigation moves focus sequentially through: Sources, SQL, Workflow Center, Context Graph, Reviews, Evaluation & ROI, Plugins | Playwright `keyboard.press('Tab')` assertions |
| AT-2 | Focus indicator is visible on each tab when focused | Visual diff or `getComputedStyle().outline` check |
| AT-3 | Enter/Space key selects the focused tab | `keyboard.press('Enter')` or `keyboard.press('Space')` |
| AT-4 | Tab selection updates URL hash to `#sources`, `#sql`, `#workflow`, `#graph`, `#reviews`, `#evaluation` | `page.url()` verification |
| AT-5 | Navigation persists across page reloads | `page.reload()` then verify active tab |

---

## 2. Source Health Panel Visualization

**Priority**: High
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| SHP-1 | Source health panel displays source count cards (healthy, warnings, critical) | Visual verification |
| SHP-2 | Warning sources are highlighted with yellow/orange indicator | Color check on source items |
| SHP-3 | Critical sources are highlighted with red indicator | Color check on source items |
| SHP-4 | Hovering a source shows health status tooltip (stale/expired/degraded/down) | Playwright `hover()` then `isVisible()` tooltip |
| SHP-5 | Clicking a source opens detailed health report modal | Modal visibility verification |
| SHP-6 | Health report includes: source ID, version ID, connector health snapshot, warning count, critical count | DOM text content check |
| SHP-7 | Stale/expired/degraded sources show warning icon in list view | Icon element existence check |

---

## 3. Governance SQL Preview Panel

**Priority**: High
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| GSP-1 | SQL preview displays before execution for semantic queries | Visual verification after planning |
| GSP-2 | Preview shows: SQL statement, semantic inputs, parameters, table references | DOM text content check |
| GSP-3 | Execution button is disabled until approval token is provided | `isDisabled()` check |
| GSP-4 | Validation errors display inline for invalid SQL (DDL/DML/cross joins) | Error message visibility check |
| GSP-5 | Approved queries show execution status with duration and row count | Status text verification |
| GSP-6 | SQL preview supports scroll for long queries | Scrollbar existence check |
| GSP-7 | Query cost estimation displays for complex queries | Cost indicator presence check |

---

## 4. Workflow Operations Center - Overview Dashboard

**Priority**: High
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| WOC-1 | Overview dashboard shows 4 summary cards: compiled workflows, runs, pending approvals, shadow acceptance rate | 4 card elements existence check |
| WOC-2 | Compiled workflows count updates when new workflows are compiled | Pre/post count verification |
| WOC-3 | Pending approvals card shows number of approval gates pending | Count verification |
| WOC-4 | Shadow acceptance rate displays as percentage with recent trend | Percentage format check |
| WOC-5 | Failed runs highlight in red on recent runs list | Color verification |
| WOC-6 | Clicking a card navigates to corresponding sub-panel (Library, Run Ledger, Approvals, Shadow Lab) | URL hash or panel visibility check |
| WOC-7 | Recent runs show workflow name, run ID, status, timestamp | DOM text content check |
| WOC-8 | Overview refreshes automatically every 30 seconds | Time-based verification |

---

## 5. Workflow Operations Center - Run Ledger Inspection

**Priority**: High
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| WRL-1 | Run ledger shows: workflow name, version, run ID, mode, status, effective principal | Column headers existence check |
| WRL-2 | Typed inputs display in a collapsible/expandable section | Expand/collapse interaction check |
| WRL-3 | Evidence source IDs and versions display with links to source details | Link existence and href check |
| WRL-4 | Proposed actions and executed actions are displayed in separate sections | Section separation verification |
| WRL-5 | Clicking a proposed action shows details (tool name, inputs, approval status) | Detail panel visibility |
| WRL-6 | Clicking an executed action shows execution result (output, error, duration) | Execution result verification |
| WRL-7 | Ordered run events display with timestamps and event types | Event list with timestamp check |
| WRL-8 | Filter by workflow ID, run ID, or status works correctly | Filter input interaction + results verification |

---

## 6. Workflow Operations Center - Shadow Lab Labeling

**Priority**: High
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| WSL-1 | Shadow Lab shows unlabeled shadow runs with recommendation and evidence | List of shadow runs verification |
| WSL-2 | Each shadow run displays: workflow ID, input hash, proposed actions, evidence source IDs | DOM content check |
| WSL-3 | "Accept" button creates comparison record with outcome="accepted" | Record existence verification |
| WSL-4 | "Reject" button creates comparison record with outcome="rejected" | Record existence verification |
| WSL-5 | "Mark mixed" button creates comparison record with outcome="mixed" | Record existence verification |
| WSL-6 | Comparison record includes: run ID, recommendation hash, source IDs, label timestamp | Database record verification |
| WSL-7 | Labeling updates the overview acceptance rate | Rate recalculation verification |
| WSL-8 | Labeled runs are removed from unlabeled list | List length decrease check |

---

## 7. Skill Editor Trigger Controls

**Priority**: Medium
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| STE-1 | Triggers tab shows list of active triggers with type, condition, and action | List item verification |
| STE-2 | Clicking "Add trigger" opens trigger configuration modal | Modal visibility check |
| STE-3 | Modal allows selecting trigger type (on message, on schedule, on file event) | Radio button/selector interaction |
| STE-4 | Condition input accepts regex pattern for message triggers | Pattern input verification |
| STE-5 | Schedule input accepts cron expression for scheduled triggers | Cron expression input check |
| STE-6 | Action input specifies skill/tool to invoke | Action input verification |
| STE-7 | Trigger save persists to workspace state | Workspace state file check |
| STE-8 | Trigger deletion removes trigger from list | List length decrease check |

---

## 8. Plugin Management - Incompatible Plugin Display

**Priority**: Medium
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| PM-1 | Inactive plugins display "Add" control when compatible | "Add" button existence check |
| PM-2 | Incompatible plugins display "Incompatible" indicator with reason | "Incompatible" text and tooltip |
| PM-3 | Incompatible plugin tooltip shows: required Matbot version, current version | Tooltip content check |
| PM-4 | Active plugins show "Remove" control for optional plugins | "Remove" button existence check |
| PM-5 | Core plugin removal shows confirmation dialog | Dialog visibility check |
| PM-6 | Plugin configuration displays: description, runtime types, tools | Configuration panel content |
| PM-7 | Add plugin installs and activates plugin without breaking workspace | Workspace restart verification |
| PM-8 | Remove plugin deactivates plugin and reloads workspace | Plugin list verification |

---

## 9. Expert Panel - Provider Fallback Verification

**Priority**: Medium
**Test Type**: Node test + Playwright

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| EPF-1 | When expert has configured provider, expert uses that provider | Provider selection verification |
| EPF-2 | When expert provider is null, expert falls back to current turn provider | Provider selection verification |
| EPF-3 | When both expert and turn provider are null, expert uses expert panel default provider | Provider selection verification |
| EPF-4 | Provider fallback is logged in console output | Console log verification |
| EPF-5 | Synthesis pass uses current turn provider when available | Provider selection verification |
| EPF-6 | Synthesis fall back to expert panel default provider when turn provider unavailable | Provider selection verification |
| EPF-7 | Fallback chain is documented in expert panel response metadata | Response metadata check |

---

## 10. Expert Panel - Knowledge Root Isolation

**Priority**: Medium
**Test Type**: Node test + Playwright

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| EKI-1 | Each expert retrieves only from their configured knowledge roots | Source ID verification in citations |
| EKI-2 | Experts do not retrieve from other experts' knowledge roots | Cross-contamination check |
| EKI-3 | Knowledge root file extensions (.md, .mdx, .txt, .json, .csv, .tsv, .yaml, .yml) are supported | File extension test |
| EKI-4 | Files larger than 1MB are skipped with warning | File size check + warning in logs |
| EKI-5 | Unsupported file extensions return empty or error | Extension validation check |
| EKI-6 | Missing knowledge root shows warning in expert panel response | Warning text check |
| EKI-7 | Knowledge root path is resolved relative to workspace root | Path resolution verification |

---

## 11. Memory Browser Standalone Mode

**Priority**: Medium
**Test Type**: Playwright standalone (port 19779)

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| MBS-1 | Memory browser starts on `http://127.0.0.1:19779` when `open_memory_browser` is called | HTTP 200 response verification |
| MBS-2 | Memory browser uses IndexedDB, OPFS, and WebCrypto when available | Feature detection check |
| MBS-3 | Memory browser falls back to filesystem store when browser features unavailable | Storage fallback verification |
| MBS-4 | Memory browser displays same content as in-page memory browser | Content comparison check |
| MBS-5 | Memory browser supports create, read, update, delete operations | CRUD operations test |
| MBS-6 | Memory browser refreshes in real-time when facts are added/removed | Real-time sync verification |
| MBS-7 | Memory browser shows workspace context in title or header | Workspace identifier check |
| MBS-8 | Memory browser closes when Matbot process stops | Process termination check |

---

## 12. Workspace RAG - Embedding Model Switching

**Priority**: Medium
**Test Type**: Integration test (Docker)

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| WRS-1 | Switching from MiniLM to E5 invalidates current vectors and starts reindex | Vector count check + reindex status |
| WRS-2 | E5 model reports 768 dimensions, profile `e5-asymmetric-v1`, `query: ` and `passage: ` prefixes | Health endpoint check |
| WRS-3 | MiniLM model reports 384 dimensions, profile `plain-v1`, empty prefixes | Health endpoint check |
| WRS-4 | E5 uses `documents_768` and `chunks_768` tables in Postgres | Database table check |
| WRS-5 | MiniLM uses `documents_384` and `chunks_384` tables in Postgres | Database table check |
| WRS-6 | Batch size configuration (`WORKSPACE_RAG_EMBEDDING_BATCH_SIZE`) affects embedding performance | Batch size in logs verification |
| WRS-7 | Reindex completes when all files are processed | Status `idle` verification |
| WRS-8 | Switching models does not delete other model's tables | Table persistence check |

---

## 13. Cognition Tools Direct HTTP API

**Priority**: Medium
**Test Type**: Node HTTP test

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| CTA-1 | `remember_fact` with `$context` envelope processes fact with session history | Fact storage verification |
| CTA-2 | `dream_time` with `$context` envelope runs consolidation with provider | Dream run record verification |
| CTA-3 | `ask_inner_voice` with `$context` envelope uses session provider for critique | Critique response verification |
| CTA-4 | `dream_runs_action` with `action: "query"` returns past consolidation runs | Query verification |
| CTA-5 | `cognition_config GET` returns current inner voice, dream ranker/merger providers | Configuration object check |
| CTA-6 | `cognition_config SET` updates providers and thresholds | Configuration file check |
| CTA-7 | `cognition_config` supports: `innerVoiceProvider`, `dreamRankerProvider`, `dreamMergerProvider`, thresholds | All settings verification |
| CTA-8 | `cognition_config` blocklist excludes skills from dream-time routing | Blocklist verification |

---

## 14. Evaluation & ROI Panel - Sponsor Evidence Display

**Priority**: High
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| ERO-1 | Sponsor evidence panel shows: citation coverage, action outcomes, workflow approvals, time saved, operating cost, benefit, net benefit, ROI | 4-8 metric cards verification |
| ERO-2 | Citation coverage displays: sources retrieved, citations in answers, coverage percentage | Percentage calculation check |
| ERO-3 | Action outcomes show: actions proposed, actions executed, success rate | Count and rate verification |
| ERO-4 | Workflow approvals show: approvals granted, approvals rejected, approval rate | Rate calculation check |
| ERO-5 | Time saved displays: estimated hours saved, verified time saved, payback period | Time value verification |
| ERO-6 | Operating cost displays: model cost, retrieval cost, tool cost, total cost | Cost breakdown verification |
| ERO-7 | Benefit displays: time saved benefit, quality improvement benefit, total benefit | Benefit calculation check |
| ERO-8 | ROI calculates: (net benefit / total cost) * 100 | ROI formula verification |

---

## 15. Context Graph - Multi-hop Retrieval

**Priority**: Medium
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| CGR-1 | Graph search accepts comma-separated search terms | Search input verification |
| CGR-2 | Graph search optionally accepts source ID filter | Filter parameter check |
| CGR-3 | Search results display entities with identifiers, aliases, sensitivity | Entity card verification |
| CGR-4 | Entity selection shows: relationships, evidence spans, confidence, citations | Detail panel verification |
| CGR-5 | Relationships display: from entity, to entity, relationship type, confidence | Relationship card verification |
| CGR-6 | Multi-hop traversal expands neighbors within configured depth budget | Depth check verification |
| CGR-7 | Graph retrieval filters relationships from denied sources | Denied source filter check |
| CGR-8 | "Refresh" button discards current retrieval and reloads stored entities | State reset verification |

---

## 16. Durable Expert Reviews - WebUI Creation Flow

**Priority**: High
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| DER-1 | Reviews panel shows "Create Review" button | Button existence check |
| DER-2 | Clicking "Create Review" opens review creation modal | Modal visibility check |
| DER-3 | Modal requires: review question, target type, target ID (optional), workflow ID (optional), run ID (optional), expert selection | Form validation check |
| DER-4 | Target type selector includes: workflow, workflow run, alert, investigation, chat | Option existence check |
| DER-5 | Expert selection allows multiple experts | Multi-select verification |
| DER-6 | "Create Review" button submits review to backend | Backend record verification |
| DER-7 | Created review appears as card in Reviews panel | Card existence check |
| DER-8 | Review card shows: question, target type, experts, status | Card content verification |

---

## 17. Scheduled & Unattended Actions - Schedule Management

**Priority**: Medium
**Test Type**: Playwright WebUI (if UI exists) + Node test

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| SUA-1 | Background plugin loads without errors when added to matbot.yaml | Matbot startup check |
| SUA-2 | Recurring schedule accepts: name, interval, provider, output, prompt | Schedule creation API check |
| SUA-3 | `every_action` with `action: "list"` returns active schedules | Schedule list verification |
| SUA-4 | `every_action` with `action: "suspend"` pauses schedule execution | Schedule state check |
| SUA-5 | `every_action` with `action: "resume"` resumes schedule execution | Schedule state check |
| SUA-6 | `every_action` with `action: "cancel"` terminates schedule | Schedule deletion check |
| SUA-7 | Scheduled tasks execute at configured intervals | Time-based execution verification |
| SUA-8 | Scheduled tasks respect tool permissions and approval gates | Permission check verification |

---

## 18. Source Registry - Source Events Timeline

**Priority**: Medium
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| SRT-1 | Source events timeline displays: health events, access events, version events | Event list verification |
| SRT-2 | Each event shows: timestamp, event type, source ID, workspace ID | Event card content check |
| SRT-3 | Health events show: read success, read failure, source disappeared | Event type verification |
| SRT-4 | Access events show: retrieval, citation, expert retrieval | Event type verification |
| SRT-5 | Events are ordered by timestamp (newest first) | Timestamp ordering check |
| SRT-6 | Clicking an event shows detailed metadata (source version, user, tool) | Detail panel check |
| SRT-7 | Source events persist across page reloads | Reload verification |
| SRT-8 | Source events are isolated per workspace | Cross-workspace isolation check |

---

## 19. Expert Panel - Mode-Specific Output Formatting

**Priority**: Medium
**Test Type**: Node test + Playwright

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| EPM-1 | Parallel mode produces independent answers from each expert | Answer independence check |
| EPM-2 | Review mode produces answers with strengths, risks, omissions, practical concerns | Theme analysis verification |
| EPM-3 | Debate mode produces answers emphasizing disagreement and tradeoffs | Conflict detection verification |
| EPM-4 | When synthesis enabled, result includes: consensus, disagreement, risks, assumptions, recommendation | Synthesis section check |
| EPM-5 | When synthesis disabled, result includes only expert answers without synthesis | No synthesis section check |
| EPM-6 | Mode selection is recorded in user message for audit trail | Message history check |
| EPM-7 | Mode-specific output is consistent across multiple runs | Reproducibility check |
| EPM-8 | Mode selection UI shows current mode clearly | UI state verification |

---

## 20. Workflow Compiler - Draft-Only Mode

**Priority**: Medium
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| WCD-1 | Compiler accepts "draft-only" flag to create draft without publishing | API parameter check |
| WCD-2 | Draft-only compilation creates `workflow_compilations` record | Record existence check |
| WCD-3 | Draft-only compilation does NOT create `workflow_definitions` or `workflow_versions` | No definition record check |
| WCD-4 | Draft compilation shows validation errors and compiler warnings | Error display check |
| WCD-5 | Draft can be converted to published version with "publish" action | Version creation check |
| WCD-6 | Draft sample inputs are auto-generated from `{{placeholders}}` | Sample input generation check |
| WCD-7 | Compiler version is stored in compilation record | Version field check |
| WCD-8 | Compilation input hash is deterministic for same inputs | Hash consistency check |

---

## 21. High-Risk Write Approval Flow

**Priority**: High
**Test Type**: Playwright WebUI

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| HWA-1 | High-risk file paths (e.g., `.env`, `config.json`, `credentials.*`) require approval | File path pattern check |
| HWA-2 | High-risk write request shows approval modal with path, content diff, and warnings | Modal visibility check |
| HWA-3 | Approval modal displays unified diff of proposed changes | Diff visualization check |
| HWA-4 | Unapproved high-risk write is rejected with error | Error response verification |
| HWA-5 | Approved high-risk write executes and creates backup | Backup file creation check |
| HWA-6 | Backup file stored in configured backup root with timestamp | Backup path verification |
| HWA-7 | File broker policy enforces read limits for high-risk files | Read limit check |
| HWA-8 | High-risk write audit event is recorded with principal, path, and outcome | Audit log verification |

---

## 22. Docker CUDA Integration - Embedding Performance

**Priority**: Low
**Test Type**: Integration test (optional, `CORTEX_CUDA_INTEGRATION=1`)

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| DCU-1 | CUDA sidecar starts when `CORTEX_CUDA_INTEGRATION=1` and NVIDIA runtime available | Container health check |
| DCU-2 | CUDA sidecar reports correct model (MiniLM or E5) and dimensions | Health endpoint check |
| DCU-3 | CUDA embeddings produce same vectors as CPU embeddings within tolerance | Vector similarity check |
| DCU-4 | CUDA batch size configuration affects GPU memory usage | Memory usage verification |
| DCU-5 | CUDA sidecar gracefully falls back to CPU when GPU unavailable | Fallback behavior check |
| DCU-6 | CUDA embeddings show faster performance than CPU (measured) | Performance comparison |
| DCU-7 | E5 model download completes successfully on first run | Model cache verification |
| DCU-8 | CUDA embeddings integrate with workspace RAG ingestion pipeline | Ingestion pipeline check |

---

## 23. Workspace Deletion - Data Cleanup

**Priority**: Medium
**Test Type**: Node test

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| WSD-1 | Workspace deletion removes: matbot.yaml, .env, .data directories | Directory deletion check |
| WSD-2 | Workspace deletion removes workspace-specific sessions | Session directory check |
| WSD-3 | Workspace deletion removes workspace-specific files | File directory check |
| WSD-4 | Workspace deletion does NOT remove: workspace registry, other workspaces | Other workspace integrity check |
| WSD-5 | Workspace deletion clears workspace from workspace list UI | UI list verification |
| WSD-6 | Workspace deletion handles errors gracefully (partial cleanup) | Error handling check |
| WSD-7 | Workspace deletion logs cleanup operations | Log verification |
| WSD-8 | Workspace deletion is atomic (all-or-nothing) | State consistency check |

---

## 24. Memory Policy - Path Mapping

**Priority**: Medium
**Test Type**: Node test

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| MPD-1 | Memory policy file (`memory-policy.json`) is loaded on startup | Policy file check |
| MPD-2 | Path mappings support: relative paths, absolute paths, environment variables | Path expansion check |
| MPD-3 | Workspace-local paths are excluded from memory indexing | Exclusion check |
| MPD-4 | Memory policy supports: allowlist, denylist, glob patterns | Pattern matching check |
| MPD-5 | Memory policy enforces max memory size (MB) | Size limit check |
| MPD-6 | Memory policy enforces max fact size (KB) | Fact size check |
| MPD-7 | Memory policy enforces max facts per workspace | Fact count check |
| MPD-8 | Memory policy supports: retention period, cleanup schedule | Retention check |

---

## 25. Plugin Discovery - Runtime Addition

**Priority**: Medium
**Test Type**: Node test

### Acceptance Criteria

| ID | Criteria | Test Method |
|----|----------|-------------|
| PDR-1 | `plugin discover_local` discovers bundled plugins in `packages/plugins` | Plugin list check |
| PDR-2 | `plugin add <local-path>` loads plugin without pnpm changes | Plugin activation check |
| PDR-3 | `plugin add <npm-name>` installs package with pnpm | Package installation check |
| PDR-4 | Plugin addition triggers plugin lifecycle hooks | Hook execution check |
| PDR-5 | Plugin addition updates plugin catalog | Catalog update check |
| PDR-6 | Plugin addition displays plugin metadata (description, tools, types) | Metadata display check |
| PDR-7 | Plugin addition respects plugin dependencies | Dependency check |
| PDR-8 | Plugin addition handles errors gracefully (invalid plugin, missing dependencies) | Error handling check |

---

## Testing Infrastructure Notes

### Test Execution Flags

- **Playwright WebUI tests**: Run with `npm run test:webui`
- **Node tests**: Run with `npm test` or `node --test`
- **Docker integration tests**: Run with `CORTEX_DOCKER_INTEGRATION=1 npm run test:integration:docker`
- **CUDA integration tests**: Run with `CORTEX_DOCKER_INTEGRATION=1 CORTEX_CUDA_INTEGRATION=1 npm run test:integration:cuda`

### Test Data Isolation

- Each test must use a temporary workspace directory
- Test data must be cleaned up after test completion
- Test memory databases must be cleared between tests
- Test file indices must be reset between tests

### Mocking Requirements

- Provider calls should be mocked with fake responses
- Docker containers should be stubbed for unit tests
- File system operations should be mocked
- Network calls should be intercepted

### Coverage Metrics

- Target: 80%+ line coverage for backend
- Target: 70%+ coverage for WebUI critical paths
- Integration tests should cover: Docker, CUDA, file operations
