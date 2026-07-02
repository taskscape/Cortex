# Cortex Strategic Architecture Implementation Notes

Source document: `roadmap.md`, section "Strategic Architecture".

This document converts each strategic architecture point into an implementation
tasklist. It assumes the current Cortex technology baseline:

- TypeScript/Node.js runtime on the Matbot plugin API.
- Ordered plugins that register tools, services, stores, hooks, providers, and
  frontend surfaces.
- Per-workspace config, secrets, `.data` stores, sessions, skills, memories,
  and RAG configuration.
- Local HTTP services for file indexing and file access.
- Postgres/pgvector for workspace RAG vectors, metadata, chunks, and search.
- Neo4j is already present in the local Docker stack.
- MCP and MCP-over-HTTP plugins exist but are not active by default.
- The `background` plugin exists for recurring prompt jobs, but durable workflow
  semantics are not yet separated from freeform model prompts.
- Hooks already provide useful governance points: `toolcall` can deny or gate a
  tool call, `toolresult` can observe/redact/audit results, and `screen` can add
  source context or markers.
- A principal carrier exists and can attribute operations to a user, agent, or
  system principal. It grants nothing by itself; policy services must enforce
  authorization decisions.

## Evidence Base

These sources inform the implementation options below:

- Model Context Protocol 2025-06-18 defines a standard way for LLM hosts,
  clients, and servers to expose resources, prompts, and tools, while warning
  that hosts must provide consent, access controls, tool confirmation, timeouts,
  output sanitization, and audit logging:
  https://modelcontextprotocol.io/specification/2025-06-18
- MCP tools are model-controlled, schema-described functions. The spec supports
  structured output and says sensitive operations should keep a human in the
  loop:
  https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Microsoft Graph delta query is a proven incremental sync pattern for change
  tracking without full re-reads:
  https://learn.microsoft.com/en-us/graph/delta-query-overview
- Slack's Events API guidance recommends fast acknowledgement and queue-based
  asynchronous processing:
  https://docs.slack.dev/apis/events-api/
- Airbyte has a large open-source connector catalog, useful as an optional ELT
  path for sources where Cortex does not need interactive tool semantics:
  https://docs.airbyte.com/platform/move-data/sources-destinations-connectors
- pgvector supports vector search inside Postgres, including HNSW indexing. This
  matches Cortex's existing Postgres/pgvector workspace RAG direction:
  https://github.com/pgvector/pgvector
- Microsoft GraphRAG and Neo4j GraphRAG documentation support combining vector
  retrieval with graph relationships for multi-hop context:
  https://microsoft.github.io/graphrag/
  https://neo4j.com/docs/neo4j-graphrag-python/current/user_guide_rag.html
- dbt semantic models and Cube show the proven shape of semantic data layers:
  entities, measures, dimensions, joins, access rules, and shared metric
  definitions:
  https://docs.getdbt.com/docs/build/semantic-models
  https://docs.cube.dev/docs/introduction
- SQLGlot provides parser/transpiler/optimizer machinery for validating SQL
  before execution:
  https://sqlglot.com/
- Postgres row-level security is a database-native defense for row-scoped
  access enforcement:
  https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- W3C PROV and OpenLineage provide mature vocabulary for provenance, lineage,
  jobs, runs, datasets, entities, activities, and agents:
  https://www.w3.org/TR/prov-dm/
  https://openlineage.io/docs/spec/object-model/
- OpenTelemetry context propagation is the standard pattern for correlating
  traces, metrics, and logs across process boundaries:
  https://opentelemetry.io/docs/concepts/context-propagation/
- OPA and Zanzibar are proven authorization patterns for policy-as-code and
  relationship-based authorization:
  https://www.openpolicyagent.org/
  https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/
- Temporal's SDK model is a proven option for durable workflows if Cortex
  outgrows an in-process/local runner:
  https://docs.temporal.io/encyclopedia/temporal-sdks
- Ragas provides practical RAG evaluation metrics such as context precision:
  https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/

## Implementation Principles

- Start as plugins, not core rewrites. Add new services through the existing
  Matbot service registry and make them available to tools, hooks, and WebUI.
- Use typed stores first for iteration. Promote hot, relational, or analytical
  data to Postgres tables once schemas stabilize.
- Keep MCP as an integration interface, not the policy boundary. Cortex must own
  connector grants, effective identity, approvals, source metadata, and audit.
- Treat source metadata as product state. Retrieval hits, SQL results, graph
  nodes, dossiers, and workflow runs should all reference source ids and source
  versions.
- Keep write actions behind explicit approval gates. Shadow mode and dry-run
  records should exist before approved execution.
- Prefer deterministic code for sync, policy, SQL validation, health checks,
  and workflow transitions. Use models for extraction, summarization, and
  recommendations only where they add value.

## 1. Enterprise Connector Fabric

### Target

Create a connector layer for SaaS systems, databases, BI tools, and local or
network files. MCP should be the preferred external integration protocol where
it fits, but every connector must be wrapped by Cortex policy and audit.

### Implementation Options

| Option | Fit | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| MCP-first connector wrapper | Tool-like SaaS and local integrations | Matches existing `mcp` and `mcp-http` packages; standard tool/resource discovery; good for interactive actions | MCP does not fully solve Cortex-specific identity, source freshness, approval, and audit | Use as default external connector contract, wrapped by Cortex policy |
| Native Cortex connector plugins | Core systems like local files, Postgres, SQL Server, Microsoft 365, Google Workspace | Full control over sync, identity, health, freshness, and source records | More connector code to maintain | Use for first-party/core connectors |
| ELT connector layer such as Airbyte | High-volume sync into local Postgres or warehouse | Broad connector coverage and mature data movement | Less suitable for live action tools or user-level approvals | Optional for read-heavy replication later |
| Prompt-only background jobs | Quick experiments | Uses existing `background` plugin | Weak contracts, weak retries, hard to audit | Prototype only; do not use for governed connectors |

### Recommended Architecture

Add a `connector-fabric` plugin that registers:

- `ConnectorRegistry` service for connector definitions, instances, grants,
  sync cursors, and health.
- `connector_action` tool for listing connectors, testing health, configuring
  sync cadence, and inspecting grants.
- `toolcall` hook that enforces connector policy before a connector-backed tool
  executes.
- `toolresult` hook that audits connector calls, records duration/status, and
  redacts sensitive output fields.

MCP tools should be proxied through this service rather than being exposed
directly to the model. The wrapper should attach connector metadata to every
tool:

```ts
type ConnectorToolBinding = {
  connectorInstanceId: string;
  toolName: string;
  capability: "read" | "write" | "admin";
  sourceTypes: string[];
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  approvalPolicyId?: string;
};
```

### Data Model

Start with typed stores:

- `connector_definitions`
- `connector_instances`
- `connector_grants`
- `connector_sync_cursors`
- `connector_health`
- `connector_audit_events`

Promote `connector_audit_events` to Postgres when volume grows.

```ts
type ConnectorInstance = {
  id: string;
  version: string;
  type: string;
  workspaceId: string;
  displayName: string;
  ownerPrincipalId: string;
  authMode: "none" | "api_key" | "oauth_user" | "oauth_service" | "windows";
  credentialRef?: string;
  scopes: string[];
  readEnabled: boolean;
  writeEnabled: boolean;
  syncCadence?: string;
  lastSyncAt?: string;
  nextSyncAt?: string;
  createdAt: string;
  updatedAt: string;
};

type ConnectorGrant = {
  id: string;
  version: string;
  connectorInstanceId: string;
  principalId: string;
  effectiveUserId?: string;
  scopes: string[];
  allowedTools: string[];
  deniedTools: string[];
  sensitiveFields: string[];
  approvalRules: string[];
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};
```

### Tasklist

- [x] Create `local-agent/matbot/packages/plugins/connector-fabric`.
- [x] Define `ConnectorRegistry` service types and augment `MatbotServices`.
- [x] Implement store-backed CRUD for connector definitions, instances, grants,
  sync cursors, and health.
- [x] Add `connector_action` with actions: `list`, `get`, `test_health`,
  `set_grant`, `set_sync`, `list_tools`, `list_audit`.
- [ ] Wrap MCP tools with connector metadata and register proxy tools using
  stable names such as `connector_<instance>_<tool>`.
- [x] Add policy evaluation in a `toolcall` hook:
  - [x] Resolve current principal.
  - [x] Resolve connector instance and grant.
  - [x] Deny unavailable, expired, disabled, or out-of-scope tools.
  - [x] Require approval for write/admin tools.
  - [ ] Enforce per-tool timeout and rate budget.
- [x] Add audit capture in a `toolresult` hook:
  - [x] connector id, tool name, principal id, input hash, result status,
    duration, source ids, and model provider.
  - [ ] trace id once Matbot tool hook contexts expose it.
  - [x] redaction for sensitive fields before model-visible result.
- [ ] Implement first native connector adapters:
  - [x] local file-index/file-broker adapter.
  - [x] workspace RAG adapter.
  - [ ] Postgres read-only adapter.
  - [x] MCP adapter.
- [ ] Add incremental sync cursor support.
  - [ ] For Microsoft 365, model delta-token style cursor state.
  - [ ] For event APIs such as Slack, model enqueue-and-ack behavior.
- [ ] Add connector health checks:
  - [ ] auth validity.
  - [ ] last successful read.
  - [ ] rate-limit/backoff state.
  - [ ] source freshness.
  - [ ] schema or permission drift.
- [ ] Add Playwright coverage for connector list, health, and approval prompts.
- [x] Add Node tests for grant enforcement and audit event recording.

MVP note: the implemented MCP adapter binds `mcp_action` and the delegated
`mcp__*` tool-name prefix to connector policy and audit. Generated stable
`connector_<instance>_<tool>` proxy tools remain a future hardening task once
per-server MCP trust metadata exists. The Postgres read-only connector is
represented as a connector definition/instance for policy continuity; executable
read-only SQL support lands in the Structured Data Reasoning MVP.

### Technical Notes

- Use `Vault` for connector credentials. Store only credential references in
  connector records.
- Use `currentPrincipal()` only as attribution input. The policy service decides
  access.
- Add a standard connector error shape so models and UI can distinguish auth
  failure, permission denial, rate limiting, stale data, and source outage.
- Do not allow raw MCP tool descriptions to become trusted policy metadata.
  Treat them as untrusted unless a connector owner has approved the server.
- Keep WebUI bound to localhost until remote auth exists; connector tools make
  local HTTP endpoints more powerful.

## 2. Source Registry

### Target

Every indexed source should have a first-class record with freshness, trust,
permissions, sensitivity, citation policy, health, limitations, and provenance.

### Implementation Options

| Option | Fit | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| Store-backed source registry | MVP and small local installs | Fits current Matbot stores; fast to add; easy to test | Queries across many sources may become slow | Start here |
| Postgres source tables | Large source counts, dashboards, health queries | Relational constraints, indexing, reporting | Requires migrations and operational care | Promote once schemas stabilize |
| OpenLineage/PROV-compatible event export | Audit, data lineage, interoperability | Proven vocabulary for datasets/jobs/runs/entities/activities/agents | Not enough by itself for Cortex UX metadata | Align internal model with these concepts |

### Recommended Architecture

Add a `source-registry` plugin that registers a `SourceRegistry` service and a
`source_action` tool. Existing systems should call the service when ingesting,
retrieving, citing, or auditing:

- `workspace-rag` creates or updates source records for markdown files and
  knowledge entries.
- `file-index` and `file-broker` report local source metadata and access mode.
- Connector adapters create records for SaaS objects, tables, dashboards, and
  files.
- Structured data reasoning creates records for query results and result
  snapshots.
- Workflow runs reference source ids and source versions in evidence
  requirements.

### Data Model

```ts
type SourceRecord = {
  id: string;
  version: string;
  workspaceId: string;
  connectorInstanceId?: string;
  connectorType: string;
  externalId: string;
  uri: string;
  title: string;
  ownerPrincipalId?: string;
  businessDomain?: string;
  sourceKind: "document" | "table" | "metric" | "dashboard" | "message" | "ticket" | "artifact" | "query_result";
  schemaOrDocumentType?: string;
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  permissionState: "unknown" | "allowed" | "denied" | "partial";
  effectiveUserId?: string;
  trustLevel: "unknown" | "low" | "medium" | "high";
  freshnessSlaSeconds?: number;
  lastObservedAt?: string;
  lastSuccessfulReadAt?: string;
  staleAfter?: string;
  stalenessState: "unknown" | "fresh" | "stale" | "expired";
  citationPolicy: "cite_path" | "cite_link" | "cite_query" | "do_not_cite";
  retentionPolicyId?: string;
  healthState: "unknown" | "healthy" | "degraded" | "down";
  knownLimitations: string[];
  createdAt: string;
  updatedAt: string;
};

type SourceVersion = {
  id: string;
  version: string;
  sourceId: string;
  contentHash?: string;
  schemaHash?: string;
  observedAt: string;
  validFrom?: string;
  validTo?: string;
  provenance: {
    activityId: string;
    connectorAuditEventId?: string;
    ingestionRunId?: string;
    modelProvider?: string;
  };
};
```

### Tasklist

- [ ] Create `local-agent/matbot/packages/plugins/source-registry`.
- [ ] Define `SourceRegistry` service with methods:
  - [ ] `upsertSource`.
  - [ ] `upsertVersion`.
  - [ ] `recordHealth`.
  - [ ] `recordAccess`.
  - [ ] `resolveCitation`.
  - [ ] `querySources`.
- [ ] Add stores: `sources`, `source_versions`, `source_health_events`,
  `source_access_events`, `source_limitations`.
- [ ] Add `source_action` tool with actions: `list`, `get`, `health`,
  `stale`, `citation`, `events`.
- [ ] Define stable source ids:
  - [ ] `workspaceId + connectorType + connectorInstanceId + externalId`.
  - [ ] Use hashes for local paths but keep the normalized path as metadata.
- [ ] Modify `workspace-rag` ingestion to call `SourceRegistry`:
  - [ ] one `SourceRecord` per markdown file.
  - [ ] one `SourceVersion` per content hash.
  - [ ] health event when file read fails or path disappears.
  - [ ] citation policy as path citation by default.
- [ ] Modify `WorkspaceRagKnowledgeIndex` results to include source ids in
  `KnowledgeEntry.source`.
- [ ] Add source warning markers in `workspace-rag` screen hook when retrieved
  context is stale or source health is degraded.
- [ ] Add source registry entries for generated artifacts:
  - [ ] dossiers.
  - [ ] workflow definitions.
  - [ ] investigation timelines.
  - [ ] source health reports.
- [ ] Add UI source panels:
  - [ ] source freshness.
  - [ ] owner.
  - [ ] sensitivity.
  - [ ] citation link/path.
  - [ ] known limitations.
- [ ] Add tests:
  - [ ] source id stability.
  - [ ] stale-source detection.
  - [ ] citation resolution.
  - [ ] workspace RAG integration.

### Technical Notes

- Model source provenance with the W3C PROV shape: entities are sources and
  artifacts, activities are ingestion/retrieval/query/workflow runs, and agents
  are users, connectors, models, or workflow runners.
- Model data lineage with OpenLineage-compatible concepts where helpful: jobs,
  runs, inputs, outputs, datasets, and extensible facets.
- Add OpenTelemetry-style trace ids to audit and source events so tool calls,
  workflow steps, and source reads can be correlated later.
- Do not block retrieval only because a source has unknown freshness during
  early rollout. Warn first, then make strict freshness policies opt-in per
  workflow or source class.

## 3. Context Graph

### Target

Add a business context graph above vector search so Cortex can reason over
entities, relationships, time validity, provenance, and confidence.

### Implementation Options

| Option | Fit | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| Neo4j graph storage | Multi-hop graph queries, entity maps, GraphRAG | Already in Docker stack; graph-native traversal; mature ecosystem | Adds driver/schema work and backup considerations | Use for graph projection and traversal |
| Postgres edge tables | Simple MVP and SQL reporting | Low operational overhead; same database as RAG | Graph traversal is less natural | Use as canonical assertion log if needed |
| Store-backed graph docs | Very small MVP | Fast to build | Hard to query and dedupe | Only for early prototypes |
| Microsoft GraphRAG-style batch pipeline | Narrative corpora and global summaries | Proven approach for private corpora | More expensive ingestion; not ideal for live source updates | Use later for large document collections |

### Recommended Architecture

Build a `context-graph` plugin with two layers:

1. Canonical assertions: append-only relationship assertions with source ids,
   source versions, confidence, extraction method, and validity windows.
2. Query projection: Neo4j nodes/relationships for graph traversal and
   GraphRAG-style retrieval.

Do not make extracted graph facts silently authoritative. Every entity and edge
must carry provenance and confidence.

### Data Model

```ts
type ContextEntity = {
  id: string;
  version: string;
  workspaceId: string;
  type: "person" | "team" | "customer" | "vendor" | "system" | "process" | "metric" | "ticket" | "decision" | "document" | "contract" | "task";
  canonicalName: string;
  aliases: string[];
  identifiers: Record<string, string>;
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  createdAt: string;
  updatedAt: string;
};

type ContextRelationshipAssertion = {
  id: string;
  version: string;
  workspaceId: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  validFrom?: string;
  validTo?: string;
  confidence: number;
  extractionMethod: "deterministic" | "connector_metadata" | "model_extracted" | "user_confirmed";
  sourceId: string;
  sourceVersionId?: string;
  evidenceSpan?: { start?: number; end?: number; text?: string };
  createdAt: string;
  updatedAt: string;
};
```

### Tasklist

- [ ] Create `local-agent/matbot/packages/plugins/context-graph`.
- [ ] Add `ContextGraph` service:
  - [ ] `upsertEntity`.
  - [ ] `assertRelationship`.
  - [ ] `searchEntities`.
  - [ ] `neighbors`.
  - [ ] `pathSearch`.
  - [ ] `retrieveGraphContext`.
- [ ] Add canonical stores or Postgres tables for entities and relationship
  assertions.
- [ ] Add Neo4j projection writer:
  - [ ] workspace-scoped labels/properties.
  - [ ] source id/source version on every relationship.
  - [ ] confidence and validity properties.
  - [ ] idempotent merge operations.
- [ ] Add extraction jobs:
  - [ ] deterministic extraction for headings, emails, issue ids, URLs, dates,
    file paths, table names, and known entity dictionaries.
  - [ ] connector metadata extraction from SaaS records.
  - [ ] optional model extraction for richer relationship candidates.
  - [ ] user confirmation path for high-value or low-confidence relationships.
- [ ] Integrate with `workspace-rag` ingestion:
  - [ ] enqueue extraction after document version changes.
  - [ ] avoid extraction in the hot chat path.
  - [ ] store extraction run ids and source version ids.
- [ ] Add retrieval path:
  - [ ] vector search finds candidate sources/entities.
  - [ ] graph traversal expands within policy and budget.
  - [ ] result renderer returns source-backed relationship facts.
- [ ] Add ACL filtering:
  - [ ] graph query must filter by workspace, effective principal, and source
    permissions before results reach the model.
  - [ ] relationships from inaccessible sources must not leak.
- [ ] Add UI affordances:
  - [ ] entity panel.
  - [ ] relationship evidence.
  - [ ] confidence and source freshness.
  - [ ] entity merge/split correction.
- [ ] Add tests:
  - [ ] entity id normalization.
  - [ ] relationship dedupe.
  - [ ] source permission filtering.
  - [ ] graph retrieval with stale/degraded source warnings.

### Technical Notes

- Prefer deterministic extraction first. Use model extraction only for
  relationship candidates that cannot be derived reliably from source metadata.
- Store time validity separately from ingestion time. "Customer owns contract"
  may be true only over a validity interval; ingestion time only says when Cortex
  observed the claim.
- Use graph traversal budgets: max depth, max nodes, max relationships, and max
  sources. GraphRAG can become expensive without hard limits.
- Keep graph facts explainable. Every edge returned to the model should be
  renderable as "relationship, confidence, source, observed at, limitation".

## 4. Structured Data Reasoning

### Target

Create a safe structured data path for tables, metrics, joins, SQL preview,
approval, result citation, and trend/anomaly analysis. The goal is not arbitrary
SQL generation against raw schemas; it is governed metric and table reasoning.

### Implementation Options

| Option | Fit | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| Direct read-only SQL connector | Early database prototype | Simple; matches existing `pg` dependency in workspace RAG | Unsafe without semantic layer and validation | Use only behind preview, validation, and row caps |
| Cortex semantic model | Business metrics and joins | Product-specific governance; model-provider neutral | New modeling work | Build MVP |
| Import dbt/Cube models | Teams already using semantic layers | Proven shape for metrics/entities/dimensions/joins/access rules | Requires mapping external metadata | Add import path after MVP |
| DuckDB for local CSV/spreadsheets | Local file analytics | Strong local-first fit | Adds dependency and separate SQL dialect | Consider after Postgres MVP |

### Recommended Architecture

Add a `structured-data` plugin with:

- `DataCatalog` service for connections, tables, columns, metrics, dimensions,
  joins, and access constraints.
- `SqlPlanner` service that generates a query plan from approved semantic
  objects, not raw arbitrary schemas.
- `structured_data_action` tool for catalog inspection, query preview, approved
  execution, and result citation.

Use Postgres as the first connector because the stack already includes Postgres
and the project already uses the `pg` package. Add SQL Server, Snowflake,
BigQuery, and local CSV/spreadsheet paths later.

### Data Model

```ts
type DataConnection = {
  id: string;
  version: string;
  workspaceId: string;
  connectorInstanceId: string;
  dialect: "postgres" | "sqlserver" | "snowflake" | "bigquery" | "duckdb";
  readOnly: boolean;
  credentialRef: string;
  defaultSchema?: string;
  rowLimitDefault: number;
  timeoutMsDefault: number;
  createdAt: string;
  updatedAt: string;
};

type MetricDefinition = {
  id: string;
  version: string;
  workspaceId: string;
  name: string;
  businessName: string;
  description?: string;
  baseTableId: string;
  expression: string;
  aggregation: "sum" | "avg" | "count" | "count_distinct" | "min" | "max" | "ratio" | "custom";
  allowedDimensions: string[];
  allowedFilters: string[];
  ownerPrincipalId?: string;
  sourceId?: string;
  createdAt: string;
  updatedAt: string;
};

type QueryRun = {
  id: string;
  version: string;
  workspaceId: string;
  dataConnectionId: string;
  principalId: string;
  status: "planned" | "approved" | "running" | "succeeded" | "failed" | "cancelled";
  sql: string;
  sqlHash: string;
  semanticInputs: string[];
  rowCount?: number;
  executedAt?: string;
  resultSourceId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
```

### Tasklist

- [ ] Create `local-agent/matbot/packages/plugins/structured-data`.
- [ ] Add `DataCatalog` and `SqlPlanner` services.
- [ ] Implement Postgres read-only connector:
  - [ ] catalog schemas, tables, columns, primary keys, foreign keys.
  - [ ] store table and column metadata as source records.
  - [ ] enforce read-only connection role.
  - [ ] set statement timeout and row caps.
- [ ] Define semantic model JSON/YAML:
  - [ ] tables.
  - [ ] entities.
  - [ ] dimensions.
  - [ ] measures.
  - [ ] metrics.
  - [ ] join rules.
  - [ ] allowed filters.
  - [ ] row-level constraints.
- [ ] Add SQL validation:
  - [ ] parse generated SQL before preview.
  - [ ] reject non-SELECT statements.
  - [ ] reject unapproved tables, joins, columns, functions, and cross joins.
  - [ ] require explicit limit unless aggregate-only.
  - [ ] attach query timeout.
- [ ] Add preview and approval flow:
  - [ ] `plan_query` returns semantic inputs and SQL.
  - [ ] UI shows SQL, source freshness, row cap, cost warning, and approval.
  - [ ] `execute_query` requires approval token for risky queries.
- [ ] Add query result source records:
  - [ ] create `query_result` source record.
  - [ ] store SQL hash, data connection, timestamp, row count, and metric ids.
  - [ ] cite the query run and source tables in summaries.
- [ ] Add anomaly/trend analysis over result snapshots:
  - [ ] deterministic statistics first.
  - [ ] model-generated explanation second, grounded in query results.
- [ ] Add tests:
  - [ ] parser rejects writes.
  - [ ] unknown table/column rejection.
  - [ ] row cap enforcement.
  - [ ] citation contains query timestamp and source ids.
  - [ ] Playwright preview/approval path.

### Technical Notes

- Use database-native row-level security where available. For Postgres,
  row-level security policies can provide defense in depth, but Cortex still
  needs application-level policy for tool exposure, query preview, and audit.
- SQLGlot is useful for validation and dialect-aware parsing. Because Cortex is
  TypeScript-first, introduce it either through a small local Python service or
  choose a TypeScript parser for the MVP and leave SQLGlot as a later hardening
  option.
- Do not let the model issue arbitrary SQL. The model can propose intent;
  deterministic planner code should produce SQL from semantic inputs.
- Query summaries should cite the data connection, tables/metrics, SQL hash,
  execution timestamp, row count, and source freshness state.

## 5. Workflow And Governance Layer

### Target

Represent automation as durable workflow definitions and workflow runs with
typed inputs, triggers, sources, tools, evidence requirements, risk, approvals,
dry-run behavior, tests, execution history, and success metrics.

### Implementation Options

| Option | Fit | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| Extend `background` plugin | Simple scheduled prompts | Already exists | Prompt-oriented, weak step ledger, weak approvals | Use only as scheduler adapter |
| Cortex local workflow runner | Local-first governed workflows | Fits product architecture; direct access to stores, tools, approvals, WebUI | New runner code | Build MVP |
| Temporal | Long-running distributed workflows | Proven durable execution and worker model | More infrastructure; larger conceptual shift | Consider after local runner proves workflow schema |
| BPMN engine | Process-heavy enterprises | Standard process modeling | Heavy for current local workbench | Not first choice |

### Recommended Architecture

Add a `workflow-governance` plugin that registers:

- `WorkflowRegistry` service for definitions, versions, tests, and policies.
- `WorkflowRunner` service for typed run execution.
- `workflow_action` tool for draft, validate, dry-run, run, approve, label,
  list, and inspect.
- `workflow_policy` hook that blocks tool calls outside the active workflow's
  allowed tool/source/risk envelope.
- `workflow_audit` event writer for every transition.

The workflow runner must be separate from freeform chat. A chat can compile a
workflow draft, but a workflow run is a typed state machine with explicit events.

### Data Model

```ts
type WorkflowDefinition = {
  id: string;
  version: string;
  workspaceId: string;
  name: string;
  ownerPrincipalId: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  triggerSchema?: Record<string, unknown>;
  allowedSourceIds: string[];
  allowedConnectorInstanceIds: string[];
  allowedTools: string[];
  requiredEvidence: Array<{
    name: string;
    sourceKind?: string;
    freshnessSlaSeconds?: number;
    minCitations?: number;
  }>;
  riskLevel: "low" | "medium" | "high" | "critical";
  approvalGates: ApprovalGate[];
  dryRunDefault: boolean;
  tests: WorkflowEvalCase[];
  successMetrics: string[];
  createdAt: string;
  updatedAt: string;
};

type WorkflowRun = {
  id: string;
  version: string;
  workflowId: string;
  workflowVersion: string;
  workspaceId: string;
  principalId: string;
  mode: "dry_run" | "shadow" | "approval_gated" | "execute";
  status: "created" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";
  inputs: Record<string, unknown>;
  evidenceSourceIds: string[];
  proposedActions: ActionProposal[];
  executedActions: ExecutedAction[];
  labels: string[];
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type WorkflowRunEvent = {
  id: string;
  version: string;
  runId: string;
  sequence: number;
  eventType: string;
  timestamp: string;
  principalId?: string;
  toolCallId?: string;
  sourceIds?: string[];
  payload: Record<string, unknown>;
};
```

### Tasklist

- [ ] Create `local-agent/matbot/packages/plugins/workflow-governance`.
- [ ] Define workflow schema:
  - [ ] JSON Schema for definitions.
  - [ ] TypeScript types.
  - [ ] validation errors suitable for UI.
- [ ] Add stores:
  - [ ] `workflow_definitions`.
  - [ ] `workflow_versions`.
  - [ ] `workflow_runs`.
  - [ ] `workflow_run_events`.
  - [ ] `workflow_approvals`.
  - [ ] `workflow_eval_cases`.
- [ ] Implement `workflow_action`:
  - [ ] `draft`.
  - [ ] `validate`.
  - [ ] `dry_run`.
  - [ ] `start`.
  - [ ] `approve`.
  - [ ] `reject`.
  - [ ] `label_shadow_result`.
  - [ ] `inspect_run`.
  - [ ] `list_runs`.
- [ ] Implement workflow runner:
  - [ ] load definition/version.
  - [ ] validate typed inputs.
  - [ ] resolve allowed sources and freshness.
  - [ ] execute steps deterministically where possible.
  - [ ] call model only for bounded reasoning steps.
  - [ ] record every state transition as an event.
- [ ] Add approval gates:
  - [ ] approve proposed action before write/admin tool.
  - [ ] approve if source is stale or unhealthy.
  - [ ] approve if confidence below threshold.
  - [ ] approve if cost estimate exceeds budget.
- [ ] Add dry-run and shadow semantics:
  - [ ] dry-run records proposed actions but never calls write tools.
  - [ ] shadow mode records Cortex recommendation and later human label.
  - [ ] action proposals and executed actions are separate objects.
- [ ] Integrate with connector fabric:
  - [ ] workflow policy restricts connector tools.
  - [ ] connector audit events link to workflow run ids.
- [ ] Integrate with source registry:
  - [ ] required evidence resolves source ids and source versions.
  - [ ] workflow output cites evidence.
- [ ] Integrate with expert panel:
  - [ ] high-risk workflows can require structured expert reviews.
  - [ ] reviews are durable artifacts linked to the run.
- [ ] Add WebUI surfaces:
  - [ ] workflow library.
  - [ ] run ledger.
  - [ ] approval queue.
  - [ ] shadow-mode comparison.
  - [ ] eval/test results.
- [ ] Add test coverage:
  - [ ] schema validation.
  - [ ] approval gate enforcement.
  - [ ] blocked tool outside allowed list.
  - [ ] dry-run cannot execute write tools.
  - [ ] run event ordering.
  - [ ] Playwright approval queue.

### Technical Notes

- Represent workflow execution as event-sourced state, even if the initial store
  is simple. The run record is the current projection; `workflow_run_events` is
  the audit trail.
- Use the existing `background` plugin only to trigger a workflow run on a
  schedule. The scheduled prompt should become a thin call to
  `workflow_action.start`, not the workflow logic itself.
- For local-first MVP, a single-process runner is acceptable if every transition
  is persisted before and after external calls. If users need crash-proof,
  multi-worker execution, map the workflow schema to Temporal activities later.
- Evaluation should be part of the workflow definition. Start with deterministic
  assertions over output shape, cited source count, stale-source handling, and
  blocked unsafe actions. Add RAG-specific metrics such as context precision
  when retrieval quality becomes a release gate.
- Policy implementation can begin with TypeScript code. If policies become
  customer-authored or complex, evaluate OPA/Rego or Cedar-style policy syntax.
  For relationship-heavy enterprise permissions, evaluate a Zanzibar-inspired
  service such as SpiceDB later.

## Suggested Build Sequence

Current implementation status: Source Registry MVP and Connector Fabric MVP are
complete as the first committable slices. The next build-sequence item is Source
Health Monitor primitives.

1. Source Registry MVP.
   - Build the source model first because connectors, graph, SQL, dossiers,
     health, and workflows all depend on stable source ids.
2. Connector Fabric MVP. Complete.
   - Wrap existing local file, workspace RAG, MCP, and Postgres read-only paths.
   - Add grant enforcement and audit hooks.
3. Source Health Monitor primitives.
   - Add source health states, stale warnings, and connector health checks.
4. Structured Data Reasoning MVP.
   - Postgres read-only connector, catalog, semantic metric definitions, SQL
     preview, approval, execution, and citations.
5. Workflow Run Ledger.
   - Definition schema, run state, run events, dry-run/proposed actions, approval
     gates, and tool policy hook.
6. Automation Shadow Mode MVP.
   - Use the workflow ledger to compare recommendations with human labels.
7. Context Graph MVP.
   - Entity and relationship extraction from source records and workspace RAG,
     Neo4j projection, graph retrieval with source permission filtering.
8. Workflow Compiler MVP.
   - Compile selected chat/investigation evidence into workflow definitions and
     tests.
9. Enterprise Expert Panel upgrade.
   - Structured expert outputs linked to dossiers, workflows, and approvals.

## Cross-Cutting Implementation Notes

### Storage

- Use Matbot typed stores for MVP records to match existing plugin patterns.
- Use Postgres for:
  - high-volume audit events;
  - source health dashboards;
  - workflow run events at scale;
  - structured data catalog and query runs;
  - context graph canonical assertions if store queries become limiting.
- Keep pgvector for vector search. Do not introduce another vector database
  until Postgres/pgvector is proven insufficient.

### Audit And Provenance

Add a small shared `audit-log` service or make it part of `source-registry`.
Minimum event fields:

```ts
type CortexAuditEvent = {
  id: string;
  version: string;
  timestamp: string;
  traceId?: string;
  workspaceId: string;
  principalId?: string;
  eventType: string;
  sourceIds?: string[];
  connectorInstanceId?: string;
  workflowRunId?: string;
  toolCallId?: string;
  providerName?: string;
  payloadHash?: string;
  redactedPayload?: Record<string, unknown>;
};
```

### Permissions

- Avoid a single all-powerful service identity for user-facing operations.
- Store effective user/service account per connector call.
- Enforce policy before retrieval and before graph expansion, not only before
  final answer generation.
- Add warning states before hard blocking, then make strict enforcement opt-in
  for high-risk workflows and sensitive sources.

### Testing

- Node tests:
  - typed stores and state transitions;
  - policy decisions;
  - source id and citation stability;
  - SQL validation;
  - graph dedupe and permissions;
  - workflow event ordering.
- Playwright tests:
  - source panels and stale warnings;
  - connector health display;
  - SQL preview and approval;
  - workflow approval queue;
  - shadow-mode labeling.
- No tests should require live provider tokens by default. Use fake Matbot
  harness patterns already present in the WebUI test suite.

### Definition Of Done For Each Strategic Architecture Point

- It has typed records with versions and stable ids.
- It records source ids and source versions for material evidence.
- It enforces effective principal and connector grants.
- It records audit events for reads, retrievals, tool calls, approvals, writes,
  generated artifacts, and workflow outcomes.
- It has stale-source and unhealthy-source behavior.
- It has Node tests for backend behavior and Playwright tests for user-visible
  workflows.
- It can run locally with the existing Cortex launch path.
