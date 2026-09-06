# Configuration Reference

> Part of the [Cortex Local Agent documentation](../README.md).

This section is the main reference for configuration files and environment
variables. Prefer editing configuration files over changing code when adding
providers, plugins, workspaces, or RAG folders.

## Configuration Files

| File | Purpose |
| --- | --- |
| `local-agent\matbot\matbot.yaml` | Default workspace Matbot config: providers, plugin order, prompt flags, and optional principal/default provider. |
| `local-agent\matbot\.env` | Active default-workspace secrets loaded by Matbot's `EnvFileVault`. Gitignored. |
| `local-agent\matbot\.env.example` | Committed template for workspace-level Matbot provider/service environment variables. |
| `local-agent\matbot\cortex-workspaces.json` | Cortex workspace registry. Created automatically if missing. |
| `local-agent\matbot\cortex-rag.json` | Default workspace RAG contexts and watched markdown folders. |
| `local-agent\matbot\workspaces\<id>\matbot.yaml` | Per-workspace Matbot config for non-default workspaces. |
| `local-agent\matbot\workspaces\<id>\.env` | Per-workspace secret file copied from the default workspace when the workspace is created. |
| `local-agent\matbot\workspaces\<id>\cortex-rag.json` | Per-workspace RAG configuration. Created when RAG is configured. |
| `local-agent\config\workspaces.json` | Host filesystem roots allowed for file-index and file-broker. |
| `local-agent\config\security-policy.json` | File-broker denied path fragments, high-risk extensions, read limit, and backup root. |
| `local-agent\config\path-mapping.json` | Windows, WSL, and Docker path prefix mappings. |
| `local-agent\config\memory-policy.json` | Human policy for durable memory: what to store, avoid, and promote. |
| `local-agent\config\experts.json` | Expert panel definitions and knowledge roots. |
| `local-agent\docker\mem0\.env` | Docker Compose secrets for Mem0/Postgres/Neo4j. Gitignored. |
| `local-agent\docker\mem0\.env.example` | Committed template for Mem0 environment variables. |
| `package.json` | Root npm scripts and npm workspaces. |

## Secrets And Environment

`setup-secrets.ps1` manages the required local secrets:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI-compatible hosted provider and Mem0/OpenAI verification. |
| `OPENROUTER_API_KEY` | Optional key for an explicitly configured OpenRouter profile. |
| `POSTGRES_PASSWORD` | Postgres password for the Mem0 Docker stack. |
| `NEO4J_PASSWORD` | Neo4j password for the Mem0 Docker stack. |
| `NEO4J_AUTH` | `neo4j/<NEO4J_PASSWORD>` value consumed by Neo4j. |
| `MEM0_API_KEY` | API key used by the Mem0 service. |

The script writes these values to User-scoped environment variables and mirrors
Docker values into `local-agent\docker\mem0\.env`.

Additional runtime environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FILE_INDEX_BASE_URL` | `http://localhost:8877` | URL used by the hybrid KnowledgeIndex plugin. |
| `FILE_BROKER_BASE_URL` | `http://localhost:8878` | URL used by local file tools. |
| `MEM0_BASE_URL` | `http://localhost:8888` | URL used by Mem0 retrieval. |
| `MEM0_USER_ID` | `local-agent` | Base user id used by hybrid Mem0 retrieval. Every workspace uses `<id>:workspace:<workspace-id>` for strict memory isolation. Legacy unscoped records are not queried. |
| `CORTEX_RAG_POSTGRES_URL` | unset | Optional full Postgres connection string for workspace RAG storage. Overrides the individual `CORTEX_RAG_POSTGRES_*` values. |
| `CORTEX_RAG_POSTGRES_HOST` | `localhost` | Postgres host used by workspace RAG. Set by the launch scripts from Docker environment values when possible. |
| `CORTEX_RAG_POSTGRES_PORT` | `5432` | Postgres port used by workspace RAG. |
| `CORTEX_RAG_POSTGRES_DB` | `mem0` | Postgres database used by workspace RAG. |
| `CORTEX_RAG_POSTGRES_USER` | `mem0` | Postgres user used by workspace RAG. |
| `CORTEX_RAG_POSTGRES_PASSWORD` | `POSTGRES_PASSWORD` or Docker `.env` | Postgres password used by workspace RAG. |
| `CORTEX_RAG_V2_MODE` | `primary` | Workspace RAG mode: `primary` or `off`. V2 is the only index; `off` disables ingestion and search without a fallback. |
| `CORTEX_RAG_V2_STORAGE` | `postgres` | V2 repository backend. Production uses `postgres`; `memory` is available only for isolated tests and loses all publications on restart. |
| `CORTEX_RAG_RECONCILE_INTERVAL_MS` | `60000` | Periodic safety-reconciliation interval. Values below 10000 are raised to 10000 ms. Filesystem watcher events normally trigger earlier reconciliation. |
| `CORTEX_RAG_V2_GC_ENABLED` | `true` | Enables automatic orphan sweeps after removal reconciliation and on the independent periodic cleanup timer. Manual `workspace_rag` action `gc` remains available when disabled. |
| `CORTEX_RAG_V2_GC_INTERVAL_MS` | `21600000` | Jittered periodic orphan-sweep cadence (6 hours by default). |
| `CORTEX_RAG_V2_GC_GRACE_MS` | `3600000` | Minimum age before an unreferenced document version can be reclaimed. |
| `CORTEX_RAG_V2_GC_BATCH_SIZE` | `2000` | Maximum document versions deleted in one PostgreSQL GC transaction. |
| `CORTEX_RAG_V2_RETIRED_GENERATION_TTL_MS` | `604800000` | Minimum age before an empty retired publication shell is deleted. |
| `CORTEX_RAG_V2_BLOB_GC_ENABLED` | `false` | Enables capped, grace-protected deletion of globally unreferenced content-addressed objects in `managed` stores. External and manifest-only sources are never deleted. |
| `CORTEX_RAG_V2_POSTGRES_SCHEMA` | `workspace_rag_v2` | Versioned V2 catalog, lexical, vector, job, trace, evidence, and evaluation schema. |
| `CORTEX_RAG_V2_MIGRATION_POSTGRES_URL` | unset | Optional owner connection used only for V2 migrations and grants. When set, `CORTEX_RAG_POSTGRES_URL` must identify a distinct non-owner application role without `BYPASSRLS`. |
| `CORTEX_RAG_V2_REQUIRE_SEPARATE_DB_ROLES` | `0` | Set to `1` in production to reject owner-bypassed V2 startup. |
| `CORTEX_RAG_V2_OBJECT_ROOT` | workspace `.data\workspace-rag-v2` | Content-addressed immutable objects, sparse line indexes, and manifests. |
| `CORTEX_RAG_V2_OBJECT_RETENTION` | `managed` | `managed`, `external_immutable`, or explicitly degraded `manifest_only`. |
| `CORTEX_RAG_V2_EXTERNAL_OBJECT_ROOT` | unset | Range-readable content-addressed root required for `external_immutable`. |
| `CORTEX_RAG_V2_CHECKPOINT_FILES` | `250` | Files ingested between checkpoint publications, so an interrupted scan leaves a queryable publication behind. `0` publishes only when the whole scan completes. |
| `CORTEX_RAG_V2_EAGER_MAX_BYTES` | `20971520` | Largest source receiving eager passage vectors. Lexical coverage remains complete at every tier. |
| `CORTEX_RAG_V2_ASYNC_MAX_BYTES` | `262144000` | Largest source eligible for capped asynchronous passage promotion. Larger sources remain lexical with query-triggered lazy promotion. |
| `CORTEX_RAG_V2_EAGER_PASSAGE_VECTOR_CAP` | `20000` | Per-document cap for eager or planned asynchronous passage vectors. |
| `CORTEX_RAG_V2_PARSER_MEMORY_BYTES` | `33554432` | Per-file streaming parser budget. |
| `CORTEX_RAG_V2_FILE_CONCURRENCY` | adaptive | Files ingested concurrently within a context, bounded to 1-8. Unset, bulk backlogs run 3-wide and automatically drop back to sequential once only a few files remain, keeping small incremental scans strictly ordered; an explicit value overrides and stays fixed for the whole scan. Tiers always keep authority-before-archive order. |
| `CORTEX_RAG_V2_EMBED_PIPELINE_DEPTH` | `2` | Embedding batches kept in flight per file, bounded to 1-8, so GPU encoding overlaps Postgres writes and parsing. |
| `CORTEX_RAG_V2_SUMMARY_PROVIDER` | unset | Configured Matbot provider used for asynchronous semantic section, document, and collection routing summaries. When unset, deterministic extractive routing text remains available and no model summary calls are made. Generated summaries are versioned derivatives and never citation evidence. |
| `CORTEX_RAG_V2_SUMMARY_CONCURRENCY` | `4` | Concurrent semantic-summary requests, bounded to 1-8. |
| `CORTEX_RAG_V2_SUMMARY_QUEUE_LIMIT` | `256` | In-process semantic-summary queue capacity, bounded to 16-4096. Ingestion applies backpressure when full. Completed summaries are content/signature reusable; interrupted unfinished work is regenerated on the next ingestion. |
| `CORTEX_RAG_V2_RERANKER_URL` | unset | Optional multilingual reranker base URL, normally `http://127.0.0.1:8891`. |
| `CORTEX_RAG_V2_RRF_K` | `60` | Reciprocal Rank Fusion rank constant. |
| `CORTEX_RAG_V2_RRF_WEIGHTS` | `{}` | Measured retriever weights as a JSON object; malformed or unsafe weights are ignored. |
| `CORTEX_RAG_V2_VECTOR_INDEX_MODE` | `full` | `full`, `half`, or `binary` HNSW candidate index. Half/binary modes over-fetch candidates and rerank them with the full vector; activate only after recall measurement. |
| `CORTEX_RAG_V2_COLBERT_URL` | unset | Optional local ColBERT-compatible `/search` lane. Returned versions are re-authorized and source ranges rehashed; activate only after representative measurements justify it. |
| `CORTEX_RAG_V2_STORAGE_BYTES_PER_SECOND` | `0` | Independent immutable-object write/read throttle; zero is unlimited. |
| `CORTEX_RAG_V2_EMBEDDING_TEXTS_PER_SECOND` | `0` | Independent embedding backfill throttle; zero is unlimited. |
| `CORTEX_RAG_V2_SOURCE_METADATA_OPS_PER_SECOND` | `0` | Independent source-registry metadata throttle. |
| `CORTEX_RAG_V2_CONTEXT_GRAPH_OPS_PER_SECOND` | `0` | Independent context-graph enrichment throttle. |
| `CORTEX_STRUCTURED_POSTGRES_URL` | unset | Optional Postgres connection string used by the `structured-data` plugin for approved read-only semantic SQL execution. Use a database role with read-only privileges. |
| `CORTEX_MODEL_PRICING_JSON` | unset | Optional JSON object keyed by model id with `inputPerMillionUsd`, `cachedInputPerMillionUsd`, and `outputPerMillionUsd`; used when a provider does not report model cost directly. |
| `CORTEX_APPROVAL_SLA_HOURS` | `24` | Hours before a pending workflow approval is considered overdue in observability and governance metrics. |
| `MATBOT_WEB_PORT` | `19778` | WebUI port. Set by `run.ps1 -WebPort`. |
| `MATBOT_COMMAND` | unset | Optional command consumed by `start-local-agent.ps1` to launch Matbot. |
| `MATBOT_PRINCIPAL` | unset | Boot identity override for Matbot. Accepts an id or JSON `{ "id", "type" }`. |
| `CORTEX_WORKSPACES_FILE` | `cortex-workspaces.json` next to `matbot.yaml` | Override workspace registry location. |
| `CORTEX_WORKSPACE_ID` | active workspace in registry | Select workspace config for a restarted Matbot process. |
| `CORTEX_RESTART_DELAY_MS` | `0` | Delay used by workspace switch restarts. |
| `EXPERT_PANEL_CONFIG` | `local-agent\config\experts.json` | Override expert panel configuration. |
| `WORKSPACES_CONFIG` | `local-agent\config\workspaces.json` | Override file-index/file-broker root policy. |
| `SECURITY_POLICY_CONFIG` | `local-agent\config\security-policy.json` | Override file-broker security policy. |
| `FILE_INDEX_PORT` | `8877` | File-index HTTP port. |
| `FILE_INDEX_STORE` | `local-agent\file-index\data\index.json` | File-index persistent store path. |
| `FILE_INDEX_MAX_FILE_BYTES` | `1000000` | Maximum file size indexed by file-index. |
| `FILE_BROKER_PORT` | `8878` | File-broker HTTP port. |

Provider API keys can also be supplied in `local-agent\matbot\.env` or a
workspace-specific `.env`. The vault resolves `${NAME}` placeholders from this
file and from process environment variables.

Do not commit real `.env` files or secret values.

## Mem0 And Postgres Docker

`local-agent\docker\mem0\docker-compose.yml` reads
`local-agent\docker\mem0\.env` for Mem0/Postgres/Neo4j secrets. The same
Postgres service also stores workspace RAG vectors, metadata, and chunk text
through pgvector. The expected template is:

```dotenv
MEM0_BASE_URL=http://localhost:8888
MEM0_API_KEY=CHANGE_ME
POSTGRES_DB=mem0
POSTGRES_USER=mem0
POSTGRES_PASSWORD=CHANGE_ME
NEO4J_PASSWORD=CHANGE_ME
NEO4J_AUTH=neo4j/CHANGE_ME
OPENAI_API_KEY=CHANGE_ME

# Optional CUDA embedding service for workspace-rag.
WORKSPACE_RAG_EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
WORKSPACE_RAG_EMBEDDING_MODEL_REVISION=46605decb5369335a3847c9f41bb0b896c07dd1a
WORKSPACE_RAG_EMBEDDING_PROFILE=auto
WORKSPACE_RAG_EMBEDDING_BATCH_SIZE=128
# float16 is the default; set float32 to restore full precision.
WORKSPACE_RAG_EMBEDDING_DTYPE=float16

# Optional multilingual V2 reranker.
WORKSPACE_RAG_RERANKER_MODEL=Alibaba-NLP/gte-multilingual-reranker-base
WORKSPACE_RAG_RERANKER_MODEL_REVISION=8215cf04918ba6f7b6a62bb44238ce2953d8831c
WORKSPACE_RAG_RERANKER_CODE_REVISION=40ced75c3017eb27626c9d4ea981bde21a2662f4
```

Model revisions in this template are immutable repository commits. Change the
model, model revision, and any referenced code revision together; these pins
are part of the V2 derivative signature and prevent a moving branch from
silently changing ranking behavior.

The Postgres and Neo4j passwords are baked into their Docker volumes on first
start. If you rotate them after the stack has already started, recreate the
volumes. This also removes Mem0 and workspace RAG Postgres data because Compose
volume cleanup removes all volumes declared by this stack:

```powershell
docker compose -f local-agent\docker\mem0\docker-compose.yml down -v
```

Then run `setup-secrets.ps1` and start again.

## Host File Access

`local-agent\config\workspaces.json` controls host directories exposed to
file-index and file-broker:

```json
{
  "roots": [
    {
      "path": "C:\\Projects",
      "mode": "read-write",
      "type": "projects"
    },
    {
      "path": "C:\\Users\\Maciej\\Documents",
      "mode": "read-only",
      "type": "documents"
    }
  ],
  "indexExcludedPatterns": [
    "**\\node_modules\\**",
    "**\\.git\\**",
    "**\\dist\\**"
  ]
}
```

`mode` is `read-write` or `read-only`. File-broker writes are allowed only inside
read-write roots and still pass security checks.

`indexExcludedPatterns` filters what the **file index** walks and stores. It is not an
access-control boundary: the shipped patterns are build-artefact filters, so applying them
to file-broker reads would hide ordinary source. What gates broker access is the root list,
each root's `mode`, and `deniedPathFragments` in the security policy. The field was formerly
named `excludedPatterns`; that name is still read, so existing configuration keeps working.

`local-agent\config\security-policy.json` blocks sensitive paths, marks high-risk
extensions, caps reads with `maxReadBytes`, and stores backups under
`local-agent\file-broker\backups`.

`local-agent\config\path-mapping.json` maps path prefixes across Windows, WSL, and
Docker contexts. The current default maps:

```json
{
  "windowsPrefix": "C:\\",
  "wslPrefix": "/mnt/c/",
  "dockerPrefix": "/workspace/c/"
}
```

## Matbot Runtime

`local-agent\matbot\matbot.yaml` is the default workspace runtime config. The
active sections are:

```yaml
providers:
  openai:
    module: ./packages/plugins/providers/openai-compat
    endpoint: https://api.openai.com/v1/chat/completions
    model: gpt-4o
    credentials:
      apiKey: ${OPENAI_API_KEY}
    parameters:
      maxTokens: 4096

plugins:
  - ./packages/plugins/storage/high-cardinality
  - ./packages/plugins/sessions
  - ./plugins/hybrid-knowledge-index
  - ./plugins/file-broker
  - ./packages/plugins/source-registry
  - ./packages/plugins/connector-fabric
  - ./packages/plugins/structured-data
  - ./packages/plugins/workflow-governance
  - ./packages/plugins/evaluation-observability
  - ./packages/plugins/context-graph
  - ./packages/plugins/workspace-rag
  - ./packages/plugins/skills
  - ./packages/plugins/triggers
  - ./packages/plugins/rumsfeld
  - ./packages/plugins/cognition
  - ./packages/plugins/memory-browser
  - ./packages/plugins/workspace
  - ./plugins/expert-panel
  - ./packages/plugins/frontend/web
```

Optional top-level keys supported by the loader:

| Key | Purpose |
| --- | --- |
| `default_provider` | Provider key to use when no provider is selected. |
| `prompt` | Run a single non-interactive prompt and exit. |
| `ephemeral` | If `true`, do not persist the session. |
| `principal` | Boot identity. Either a string id or `{ id, type }`. |
| `providers` | Native Matbot provider profiles. |
| `language_models` | Higher-level provider shorthand for OpenAI-compatible local providers. |
| `plugins` | Ordered startup plugin list. |

Plugin order matters when one plugin provides a service consumed by another. The
`storage/high-cardinality` backend must load before plugins create stores; it
routes source-registry and context-graph namespaces to WAL-mode SQLite while
leaving sessions, skills, and workspace files in their existing filesystem
stores. Existing JSON records are imported once and retained as recovery copies. For
example, `hybrid-knowledge-index` registers `KnowledgeIndex` before `rumsfeld`
uses it, `source-registry` loads before `workspace-rag` so indexed markdown gets
durable source ids, and `connector-fabric` loads before `workspace-rag` so
connector-bound tool calls can be checked and audited from the first turn.
`structured-data` loads after source and connector services so semantic SQL
plans can create source records and run through connector policy.
`workflow-governance` loads after source, connector, and structured-data services
so workflow runs can resolve evidence, inherit connector policy metadata, and
restrict connector-backed tool calls by workflow allow-lists.
`context-graph` loads before `workspace-rag` so markdown ingestion can enqueue
source-backed entity and relationship extraction after source version writes.
`frontend/web` loads last so the WebUI sees the complete tool and plugin catalog.

## Providers

### OpenRouter profiles

OpenRouter is a dedicated Node-hosted provider adapter. Add one or more named
profiles to the active workspace's `matbot.yaml`, select the profile in the
conversation picker, and Cortex sends the exact configured model ID to
`https://openrouter.ai/api/v1/chat/completions`. The adapter supports streamed
text, Cortex local tools, cancellation, token usage, and supported image inputs.
It does not enable OpenRouter in the browser-only bundle, OpenRouter server
tools, embeddings, or automatic model fallback.

Use a `${OPENROUTER_API_KEY}` reference, never a literal key. The value belongs
in that workspace's `.env`, process environment, or configured vault. Profile
names and model IDs are non-secret; configuration reads, browser storage, logs,
and prompt history do not receive the resolved key.

```yaml
providers:
  OpenRouter Chat:
    module: ./packages/plugins/providers/openrouter
    model: openai/gpt-4o
    credentials:
      apiKey: ${OPENROUTER_API_KEY}
    parameters:
      maxTokens: 4096
      capabilities:
        tools: true
        # Set images: true only after choosing a model known to accept images.
      openrouter:
        provider:
          require_parameters: true
          allow_fallbacks: true
```

`module` is relative to the active `matbot.yaml`; use the complete example at
`local-agent\config\matbot.openrouter.example.yaml` as a path-adjusted template.
One credential reference may be used by several profiles with different exact
model IDs. A profile change applies at the next provider call; a turn retains its
resolved profile throughout its tool loop. Existing OpenAI-compatible, Anthropic,
and local profiles remain independent.

`parameters.openrouter.provider` accepts `require_parameters`,
`allow_fallbacks`, `order`, `only`, `ignore`, `data_collection`, and `zdr`.
`parameters.openrouter.reasoning` accepts `enabled`, `effort` (`low`, `medium`,
or `high`), `max_tokens`, and `exclude`; `effort` and `max_tokens` are mutually
exclusive. Unknown OpenRouter options and unsafe/unrelated endpoints fail before
an authenticated request. The official API host is enforced; use the generic
OpenAI-compatible profile when an operator intentionally needs a proxy.

The runtime administration flow also supports `provider` `add` with
`preset: "openrouter"`; it supplies the dedicated module, official endpoint,
strict routing defaults, and an out-of-band password prompt for a new key. The
`openrouter` administration tool lists the public catalog and separately checks
configuration, key, model, or a deliberately small credit-consuming inference.
The `openrouter-profiles` configuration contributor writes only references and
non-secret settings with a version check, so refresh and retry after a conflict
rather than overwriting a concurrent profile change.

Manual model IDs are always usable without catalog discovery. An explicit key
check is separate from model inference: it can establish key readiness but does
not prove a model/capability will complete. The opt-in, quota-consuming smoke
test takes its profile, exact model, and key reference from one explicitly named
workspace configuration; it skips with a warning before a request when any of
those is unavailable. Set `CORTEX_OPENROUTER_INTEGRATION=1`,
`CORTEX_OPENROUTER_CONFIG` to that workspace's `matbot.yaml`, and optionally
`CORTEX_OPENROUTER_PROFILE`, then run:

```powershell
$env:CORTEX_OPENROUTER_INTEGRATION = '1'
$env:CORTEX_OPENROUTER_CONFIG = (Resolve-Path .\local-agent\matbot\workspaces\private\matbot.yaml).Path
$env:CORTEX_OPENROUTER_PROFILE = 'OpenRouter Chat'
npm run test:integration:openrouter
```

The test does not search for a developer workspace or load its `.env` unless
the configuration path is explicitly supplied.
If an explicitly saved provider profile is removed, the WebUI requires an
explicit new selection rather than falling back to another provider.

Native provider schema:

```yaml
providers:
  Local:
    module: ./packages/plugins/providers/openai-compat
    endpoint: http://100.122.2.99:11435/v1
    model: qwen3-coder-next-256k
    credentials:
      apiKey: ${LOCAL_API_KEY}
    parameters:
      apiUrl: http://100.122.2.99:11435/v1
      maxTokens: 32768
      maxContextTokens: 262144
      maxOutputTokens: 32768
      maxCompletionTokens: 262144
      temperature: 0.2
      tokenLimitParam: max_tokens
      capabilities:
        tools: true
        images: false
        parallel_tool_calls: false
        prompt_cache_key: false
        chat_completions: true
        interleaved_reasoning: false
```

Important fields:

| Field | Meaning |
| --- | --- |
| `module` | Provider plugin module. OpenAI-compatible providers use `./packages/plugins/providers/openai-compat`. |
| `endpoint` | Base URL or full `/chat/completions` URL. The adapter appends `/chat/completions` when needed. |
| `model` | Model name sent to the provider. |
| `credentials.apiKey` | API key or `${ENV_VAR}` placeholder. Empty is allowed for local servers that ignore auth. |
| `credentials.organization` | Optional OpenAI organization header. |
| `parameters.maxTokens` | General output token limit fallback. |
| `parameters.maxContextTokens` | Metadata for context window size. |
| `parameters.maxOutputTokens` | Preferred output token limit. |
| `parameters.maxCompletionTokens` | Metadata for providers that distinguish completion limit. |
| `parameters.temperature` | Sent as `temperature` when present. |
| `parameters.tokenLimitParam` | Force `max_tokens` or `max_completion_tokens`. Without this, gpt-5/o-series/4o models use `max_completion_tokens`; most other models use `max_tokens`. |
| `parameters.promptCache` | Enables Anthropic-style cache control in converted messages/tools when `true`. |
| `parameters.capabilities.tools` | Set `false` to suppress tool definitions for providers that cannot accept tools. |
| `parameters.capabilities.parallel_tool_calls` | When boolean, sent as `parallel_tool_calls`. |

The loader also accepts this higher-level local provider format:

```yaml
language_models:
  openai_compatible:
    Local:
      api_url: http://100.122.2.99:11435/v1
      available_models:
        - name: qwen3-coder-next-256k
          max_tokens: 262144
          max_output_tokens: 32768
          max_completion_tokens: 262144
          capabilities:
            tools: true
            images: false
            parallel_tool_calls: false
            prompt_cache_key: false
            chat_completions: true
            interleaved_reasoning: false
```

For each model, the loader creates an OpenAI-compatible provider profile. If a
group contains one model, the provider name is the group name (`Local`). If a
group contains multiple models, provider names become
`<group>-<model-name>`. Native `providers:` entries are loaded after
`language_models:`, so a native provider with the same name overrides the
generated one.

After changing providers, restart the WebUI:

```powershell
.\scripts\run.ps1
```

Then hard-refresh the browser if the provider selector still shows stale data.

## Cortex Workspaces

Cortex workspaces isolate configuration and backend data. The default workspace
uses `local-agent\matbot\matbot.yaml`. Additional workspaces are created under
`local-agent\matbot\workspaces\<workspace-id>`.

Each workspace has:

- its own `matbot.yaml`;
- its own `.env`;
- its own `.data` directory;
- separate sessions, files, tool stores, memories, skills, and RAG index;
- its own `cortex-rag.json` when RAG is configured.

The workspace registry is `local-agent\matbot\cortex-workspaces.json`:

```json
{
  "active": "default",
  "workspaces": [
    {
      "id": "default",
      "name": "Default",
      "configPath": "matbot.yaml",
      "createdAt": "2026-06-28T17:18:02.608Z",
      "updatedAt": "2026-06-28T17:18:02.608Z"
    }
  ]
}
```

If the registry is missing, Matbot creates it with a `default` workspace on
startup.

The bottom-left WebUI workspace selector can:

- switch active workspace;
- create a workspace;
- rename a workspace;
- open workspace settings.

Creating a workspace copies the default `matbot.yaml`, rewrites relative plugin
and provider module paths to absolute paths, and copies the default `.env` when
it exists. Switching workspaces writes `active` in the registry and restarts the
Matbot process with `CORTEX_WORKSPACE_ID`.

## Workspace RAG Configuration

The `workspace-rag` plugin provides workspace-scoped markdown retrieval for every
conversation. It is installed by default in `matbot.yaml`, and the CLI ensures
`storage/high-cardinality`, `source-registry`, `connector-fabric`, `structured-data`,
`workflow-governance`, `context-graph`, and `workspace-rag` are present in every
workspace config when Matbot starts.

RAG configuration lives next to the active workspace config:

```json
{
  "activeContextId": "default",
  "contexts": [
    {
      "id": "default",
      "name": "Default",
      "paths": [
        "C:\\Projects\\Siemens\\docs"
      ]
    }
  ]
}
```

Concepts:

| Element | Meaning |
| --- | --- |
| Context | A named set of local Markdown roots inside one Cortex workspace. |
| Active context | The context injected into conversations and edited by the WebUI settings page. |
| Paths | Absolute local folders or individual `.md` files. Only Markdown files are indexed. |
| Hybrid catalog | V2 Postgres/pgvector tables in the `workspace_rag_v2` schema by default. The catalog stores atomic publications, immutable document/section/passage metadata, lexical text, jobs, traces, and evidence. |
| Derivative tables | Dimension-specific tables such as `unit_embeddings_384` and `unit_embeddings_768` retain exact-input-keyed embeddings side by side. |

The ingestion manager:

- reconciles the active workspace first, then inactive configured workspaces serially;
- watches configured folders and standalone Markdown files, debounces filesystem events, and carries changed paths into V2 so same-size edits with preserved timestamps are rehashed;
- performs periodic discovery as a safety net and coalesces overlapping watcher, timer, configuration, and manual requests;
- streams Markdown into immutable document, section, and passage records within the configured parser budget;
- skips unchanged fingerprints during incremental reconciliation, while `reindex_now` deliberately rebuilds every discovered file;
- treats path as document identity: a rename creates a new document/source identity and retires the old path;
- publishes additions, changes, renames, and removals in one validated generation;
- never reconciles deletions after incomplete root or nested-directory discovery, and defers deletion reconciliation when any discovered file failed;
- keys reusable embeddings by the exact level-specific model input, embedding signature, and level;
- marks removed source-registry entries down after publication and restores reappearing paths to healthy during registration;
- rate-limits source-registry and context-graph enrichment while vector ingestion continues.

The WebUI exposes the active context through the workspace settings page:

1. Click the workspace gear in the bottom-left area.
2. Edit `Context name`.
3. Enter one absolute markdown folder path per line.
4. Click `Save` to persist changes in place, or `Close` to discard changes and return to chat. `Save` is active only when the current form differs from the persisted settings.

The status line displays the active V2 publication/job, CPU/CUDA status,
repository backend, watcher state, and the currently processed path when active.
Open the workspace gear in the WebUI to see this line; it reads `CUDA` only when
the current ingestion backend is actually using the CUDA embedding service. If
the machine exposes NVIDIA hardware but the CUDA embedding service is
unavailable, it reads `CPU (NVIDIA detected)`. The production repository label
reads `Postgres/pgvector`.

The same operations are available through the `workspace_rag` tool:

```json
{ "action": "status" }
```

```json
{ "action": "get_config" }
```

```json
{
  "action": "configure",
  "contextId": "default",
  "contextName": "Engineering Notes",
  "paths": [
    "C:\\Projects\\Cortex\\docs",
    "D:\\Knowledge\\Engineering"
  ]
}
```

```json
{
  "action": "create_context",
  "contextName": "Finance Notes",
  "paths": ["D:\\Knowledge\\Finance"]
}
```

```json
{
  "action": "select_context",
  "contextId": "finance-notes"
}
```

```json
{
  "action": "search",
  "query": "provider selection architecture",
  "limit": 5
}
```

```json
{ "action": "reindex_now" }
```

`reindex_now` forces the complete current V2 context through hashing and the
derivative pipeline. Use `{ "action": "reconcile_now" }` for an immediate
incremental fingerprint reconciliation. Both commands join/coalesce concurrent
work and return the unified terminal status. Background reconciliation of other
workspaces remains serialized.

Use `{ "action": "gc" }` to run the orphan sweep for the active context, or
include `"contextId"` to target another context in the current workspace. The
sweep keeps every document version reachable from an active or staging
publication, refuses deletion while ingestion is non-terminal, applies the
configured grace period, and reports its counts under `lastGc` in status.
Removing an entire context also purges its non-audit database state; retrieval,
regex, and evaluation audit records retain their normal TTL-managed lifecycle.

### Interrupted scans

A scan builds a staging generation and publishes it atomically when it finishes,
so a process that is killed mid-scan must not lose the files it already indexed.
Two mechanisms keep that work:

- **Checkpoint publications.** Every `CORTEX_RAG_V2_CHECKPOINT_FILES` ingested
  files the staging generation is published. A generation carries the previous
  publication's documents forward, so promoting it mid-scan only ever adds to
  what search can see; removals still wait for discovery to complete. A restart
  therefore inherits a queryable index rather than an empty one.
- **Generation adoption.** When the newest job for a context did not complete
  discovery and its generation still matches the active embedding signature, the
  next run adopts that generation instead of starting a new one, and treats the
  documents already in it as indexed. A document joins a generation only once it
  is fully ingested, so a file that was mid-flight when the process died is
  re-ingested rather than trusted.

Each run also prunes staging generations abandoned by earlier interrupted runs.
Embeddings are content-addressed and outlive any generation, so re-ingesting a
file whose content has not changed reuses its vectors instead of recomputing
them.

Status responses include:

| Field | Meaning |
| --- | --- |
| `mode` / `available` / `backend` | V2 mode, initialization availability, and `postgres-pgvector` (or test-only `memory`) repository. |
| `activeGenerationId` / `activeState` | Atomically published generation and its `active_lexical`, `active_hybrid_partial`, or `active_hybrid_complete` state. |
| `job` | Current or latest job, including trigger, state, current path, added/changed/unchanged/removed counts, discovery completeness, deferred-deletion flag, progress, and failure message. `totalFiles` is counted before the scan starts, so `processedFiles/totalFiles` is a true fraction rather than a running tally. `resumedFiles` reports files inherited from an interrupted run, and `publishedCheckpoints` how many checkpoint publications this job has made. |
| `indexedDocuments` | Documents held in the database for the generation being built, or for the active publication when no job is running — the cumulative total across this and earlier scanning sessions. |
| `lastSuccessfulReconcileAt` | Completion time of the latest successfully published reconciliation in this process. |
| `watcher` | Watcher state, root count, pending/debounced change flag, queued-reconcile flag, last event time, and last watcher/reconciliation error. |
| `summaries` | Routing-summary queue state and optional summarizer signature. |
| `nvidiaAvailable` | Whether `nvidia-smi` is visible on the host. |
| `cudaAvailable` | Whether the configured embedding service reported CUDA support at launch. |
| `accelerated` | Whether the current ingestion backend is GPU-accelerated. |
| `accelerator` | `nvidia` or `cpu`. |
| `embeddingBackend` | `cuda-http` when CUDA embeddings are active, otherwise `hash-cpu`. |
| `embeddingModel` | Active embedding model or CPU vectorizer name. |
| `embeddingDimensions` | Vector dimensions used by the current backend. |
| `embeddingProfile` | Preprocessing profile used to distinguish query and document embeddings. |
| `embeddingSignature` | Stable fingerprint of the model revision, preprocessing profile, prefixes, normalization, and token limit. |
| `embeddingMaxTokens` | Maximum input-token length reported by the active embedding model, when available. |
| `cudaServiceUrl` | CUDA embedding service URL when configured/probed. |
| `accelerationMessage` | Human-readable launch-time CUDA/CPU decision. |
| `message` | Human-readable status message. |

The built-in CPU fallback uses a 384-dimensional token hash vectorizer. CUDA
support is provided by the `workspace-rag-cuda` Docker service, exposed on
`http://localhost:8890` by default. The launch scripts start that service with
Docker Compose profile `cuda` only when `nvidia-smi -L` succeeds and Docker
reports the `nvidia` runtime. The plugin then probes `/health`; it enables CUDA
only if that endpoint reports `cudaAvailable: true`. Otherwise ingestion stays
on CPU and reports the reason through `accelerationMessage`.

The CUDA service uses purpose-aware embedding requests. Search text is encoded
as `query` input, while indexed file and knowledge chunks are encoded as
`document` input. The `auto` embedding profile selects `e5-asymmetric-v1` for
E5-family models, which prepends `query: ` and `passage: ` respectively. Other
models retain the plain, unprefixed profile unless explicitly configured.

For example, to use the 768-dimensional multilingual E5 base model:

```dotenv
WORKSPACE_RAG_EMBEDDING_MODEL=intfloat/multilingual-e5-base
WORKSPACE_RAG_EMBEDDING_MODEL_REVISION=d13f1b27baf31030b7fd040960d60d909913633f
WORKSPACE_RAG_EMBEDDING_PROFILE=auto
WORKSPACE_RAG_EMBEDDING_BATCH_SIZE=128
WORKSPACE_RAG_EMBEDDING_DTYPE=float16
```

The service stores downloaded Hugging Face artifacts in the
`workspace-rag-models` Docker volume so container recreation does not download
the model again. Embeddings run in `float16` by default (roughly doubling
throughput and halving GPU memory on tensor-core GPUs, with TF32 matmuls
enabled alongside). Changing the model, revision, profile, prefixes,
normalization, token limit, or `WORKSPACE_RAG_EMBEDDING_DTYPE` (`float16`,
`bfloat16`, or `float32`) changes the
embedding signature. Cortex then treats existing vectors as stale and rebuilds
them during the next workspace scan of every workspace the sidecar serves.
Postgres
derivative tables remain dimension-specific, so this model uses
`unit_embeddings_768`; an earlier `unit_embeddings_384` table is retained until
deliberately cleaned up.

To force CPU ingestion even on CUDA-capable hardware:

```powershell
$env:CORTEX_RAG_DISABLE_CUDA = "1"
.\scripts\run.ps1
```

To skip the CUDA service from the launcher without changing the environment:

```powershell
.\scripts\run.ps1 -SkipCudaIngestion
```

Postgres/pgvector is the production backend and startup reports Workspace RAG as
unavailable if it cannot initialize. Configure its connection explicitly when
the Docker defaults do not apply:

```powershell
$env:CORTEX_RAG_POSTGRES_URL = "postgresql://cortex_rag_app:CHANGE_ME@localhost:5432/mem0"
.\scripts\run.ps1
```

The volatile memory repository is intended only for isolated automated tests:

```powershell
$env:CORTEX_RAG_V2_STORAGE = "memory"
.\scripts\run.ps1
```

### Publication performance on large corpora

Checkpoint and final publications validate a generation by joining
`publication_documents` to `sections` and `passages` on document membership.
Startup migrations create btree indexes on
`sections (document_version_id)` and `passages (document_version_id)` for
exactly these joins; without them, every publication degrades to full-table
scans once a corpus reaches hundreds of thousands of documents. Re-publishing
the same generation also skips document rows already in the target
publication state, so repeated checkpoints stay cheap. On very large corpora,
raise `CORTEX_RAG_V2_CHECKPOINT_FILES` so checkpoints occur less often.

## Expert Panel Configuration

Expert configuration lives in `local-agent\config\experts.json`:

```json
{
  "defaultProvider": "openai",
  "experts": [
    {
      "id": "design",
      "title": "Design Expert",
      "description": "Product design, UX, visual systems, interaction quality, and user-facing tradeoffs.",
      "provider": "openai",
      "roots": ["../knowledge/design"],
      "tags": ["design", "ux", "product"],
      "systemPrompt": "You are the Design Expert..."
    }
  ]
}
```

Fields:

| Field | Meaning |
| --- | --- |
| `defaultProvider` | Provider used when an expert does not specify one. |
| `id` | Stable expert id used by tools and tests. |
| `title` | Human-facing expert name in the UI. |
| `description` | Short UI/tool description. |
| `provider` | Provider key from the active `matbot.yaml`. |
| `roots` | File knowledge roots for the expert. Relative paths resolve from `local-agent\config\experts.json`. |
| `tags` | Metadata returned in expert definitions. |
| `systemPrompt` | Expert-specific instruction prompt. |

The default experts are `design`, `finance`, and `engineering`. Minimal probe
knowledge files live under `local-agent\knowledge\<expert-id>`.
