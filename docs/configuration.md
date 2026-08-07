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
| `CORTEX_RAG_POSTGRES_SCHEMA` | `workspace_rag` | Postgres schema used for workspace RAG tables. |
| `CORTEX_RAG_STORAGE` | `auto` | Workspace RAG storage mode: `auto` prefers Postgres/pgvector and falls back to JSON; `postgres-pgvector` forces Postgres; `json` forces legacy JSON. |
| `CORTEX_RAG_CONTEXT_GRAPH_MAX_SCAN_FILES` | `10000` | Maximum workspace scan size that receives per-file context-graph extraction. Larger scans still get vectors and source metadata but skip graph expansion. Use `-1` only when intentionally enabling graph extraction for an unbounded scan. |
| `CORTEX_RAG_V2_MODE` | `primary` | Hybrid retrieval mode: `primary`, `shadow`, or `off`. `primary` uses an active V2 publication and falls back to V1 only when V2 is unavailable or fails. A completed V2 search that explicitly abstains does not fall through to the legacy index. |
| `CORTEX_RAG_V1_BACKGROUND_SCAN` | `1` | Set to `0` during a V2-only rebuild to prevent the legacy flat index from being repopulated. Explicit `reindex_now` remains available. |
| `CORTEX_RAG_V2_POSTGRES_SCHEMA` | `workspace_rag_v2` | Versioned V2 catalog, lexical, vector, job, trace, evidence, and evaluation schema. |
| `CORTEX_RAG_V2_MIGRATION_POSTGRES_URL` | unset | Optional owner connection used only for V2 migrations and grants. When set, `CORTEX_RAG_POSTGRES_URL` must identify a distinct non-owner application role without `BYPASSRLS`. |
| `CORTEX_RAG_V2_REQUIRE_SEPARATE_DB_ROLES` | `0` | Set to `1` in production to reject owner-bypassed V2 startup. |
| `CORTEX_RAG_V2_OBJECT_ROOT` | workspace `.data\workspace-rag-v2` | Content-addressed immutable objects, sparse line indexes, and manifests. |
| `CORTEX_RAG_V2_OBJECT_RETENTION` | `managed` | `managed`, `external_immutable`, or explicitly degraded `manifest_only`. |
| `CORTEX_RAG_V2_EXTERNAL_OBJECT_ROOT` | unset | Range-readable content-addressed root required for `external_immutable`. |
| `CORTEX_RAG_V2_EAGER_MAX_BYTES` | `20971520` | Largest source receiving eager passage vectors. Lexical coverage remains complete at every tier. |
| `CORTEX_RAG_V2_ASYNC_MAX_BYTES` | `262144000` | Largest source eligible for capped asynchronous passage promotion. Larger sources remain lexical with query-triggered lazy promotion. |
| `CORTEX_RAG_V2_EAGER_PASSAGE_VECTOR_CAP` | `20000` | Per-document cap for eager or planned asynchronous passage vectors. |
| `CORTEX_RAG_V2_PARSER_MEMORY_BYTES` | `33554432` | Per-file streaming parser budget. |
| `CORTEX_RAG_V2_SUMMARY_PROVIDER` | unset | Configured Matbot provider used for asynchronous semantic section, document, and collection routing summaries. When unset, deterministic extractive routing text remains available and no model summary calls are made. Generated summaries are versioned derivatives and never citation evidence. |
| `CORTEX_RAG_V2_SUMMARY_CONCURRENCY` | `2` | Concurrent semantic-summary requests, bounded to 1-8. |
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
WORKSPACE_RAG_EMBEDDING_BATCH_SIZE=32

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
| Context | A named set of local markdown folders inside one Cortex workspace. |
| Active context | The context injected into conversations and edited by the WebUI settings page. |
| Paths | Absolute local folders. Only files with the `.md` extension are indexed. |
| Vector and metadata DB | Postgres/pgvector tables in the `workspace_rag` schema by default. Dimension-specific tables such as `documents_384` and `chunks_384` hold document hashes, chunk text, metadata, and vectors. |
| JSON fallback | Legacy local index at `.data\workspace-rag\index.json`, used only when `CORTEX_RAG_STORAGE=json` or Postgres/pgvector is unavailable in `auto` mode. |

The ingestion manager:

- scans the active workspace first, then scans inactive workspaces from `cortex-workspaces.json` serially in the background;
- indexes markdown files under configured paths;
- chunks markdown, hashes document content, and stores chunk text, metadata, and vectors in Postgres/pgvector;
- batches chunks across up to 32 files per embedding request and advances progress only after that batch completes;
- skips source and graph writes for unchanged files;
- writes source records and versions through a bounded enrichment queue while vector ingestion continues;
- invokes `ContextGraph.ingestSource` when the context graph plugin is loaded and the scan does not exceed `CORTEX_RAG_CONTEXT_GRAPH_MAX_SCAN_FILES`;
- re-indexes changed files when the markdown hash changes;
- removes deleted markdown files from the index;
- writes changed documents incrementally, so ingestion does not serialize one giant JSON file at the end;
- rotates `ingestion.log` at 25 MiB, retaining one `.1` archive;
- continues in the background while the WebUI is open;
- rescans configured folders every minute after the initial pass, coalescing overlapping timer scans instead of running them concurrently;
- restarts ingestion for the current workspace immediately when saved paths change.

The WebUI exposes the active context through the workspace settings page:

1. Click the workspace gear in the bottom-left area.
2. Edit `Context name`.
3. Enter one absolute markdown folder path per line.
4. Click `Save` to persist changes in place, or `Close` to discard changes and return to chat. `Save` is active only when the current form differs from the persisted settings.

The status line displays state, percentage, CPU/CUDA status, storage backend, a
human message, and the currently processed file name when indexing is active.
Open the workspace gear in the WebUI to see this line; it reads `CUDA` only when
the current ingestion backend is actually using the CUDA embedding service. If
the machine exposes NVIDIA hardware but the CUDA embedding service is
unavailable, it reads `CPU (NVIDIA detected)`. The storage label reads
`Postgres/pgvector` for the scalable backend or `JSON` for the fallback backend.

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

`reindex_now` reindexes the current workspace. Background scans may still index
inactive workspaces later, but they are serialized so a large inactive workspace
cannot run concurrently with the active workspace scan.

Status responses include:

| Field | Meaning |
| --- | --- |
| `state` | `pending`, `idle`, `indexing`, or an error state. |
| `percent` | Ingestion progress percentage. |
| `processedFiles` / `totalFiles` | Current scan progress. |
| `currentFile` | Current markdown file being processed while `state` is `indexing`; omitted once indexing is idle, pending, or errored. |
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
| `storageBackend` | `postgres-pgvector` for Postgres vectors, metadata, and chunk text, or `json` for the legacy fallback. |
| `storageMessage` | Human-readable storage selection/fallback reason. |
| `postgresHost` | Postgres host when Postgres/pgvector is active. |
| `postgresPort` | Postgres port when Postgres/pgvector is active. |
| `postgresDatabase` | Postgres database when Postgres/pgvector is active. |
| `postgresSchema` | Postgres schema when Postgres/pgvector is active. |
| `postgresTables` | Dimension-specific document and chunk table names when Postgres/pgvector is active. |
| `legacyJsonPath` | Per-workspace JSON index path when JSON fallback is active. |
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
WORKSPACE_RAG_EMBEDDING_BATCH_SIZE=32
```

The service stores downloaded Hugging Face artifacts in the
`workspace-rag-models` Docker volume so container recreation does not download
the model again. Changing the model, revision, profile, prefixes, normalization,
or token limit changes the embedding signature. Cortex then treats existing
vectors as stale and rebuilds them during the next workspace scan. Postgres
tables remain dimension-specific, so this model uses `documents_768` and
`chunks_768`; earlier 384-dimensional tables are retained until deliberately
cleaned up.

To force CPU ingestion even on CUDA-capable hardware:

```powershell
$env:CORTEX_RAG_DISABLE_CUDA = "1"
.\scripts\run.ps1
```

To skip the CUDA service from the launcher without changing the environment:

```powershell
.\scripts\run.ps1 -SkipCudaIngestion
```

To force the scalable Postgres/pgvector storage backend and fail fast if
Postgres is not reachable:

```powershell
$env:CORTEX_RAG_STORAGE = "postgres-pgvector"
.\scripts\run.ps1
```

To force the legacy JSON backend for a self-contained diagnostic run:

```powershell
$env:CORTEX_RAG_STORAGE = "json"
.\scripts\run.ps1
```

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
