# Cortex Local Agent

Cortex is a Windows-native local assistant built on the Matbot runtime. It combines
local chat, provider selection, workspace isolation, durable memory, controlled file
access, markdown hybrid retriever with exact and lexical reference lanes.

It also provides a tool-based expert panel for orchestrating multi-expertese work.

Matbot remains the underlying runtime and plugin system. Cortex is the product shell
configured in this repository: the WebUI branding, PowerShell launch scripts, workspace
registry, local services, and default plugin set.

PROJECTMEM is intentionally not integrated.

## Conceptual Overview

Cortex is a local-agent workbench. It is meant to feel like one assistant in the
browser, but internally it is a composed runtime:

- a WebUI for conversations, files, providers, experts, workspaces, and settings;
- a Matbot process that loads providers, plugins, tools, stores, sessions, and
  hooks from the active workspace configuration;
- local services that expose safe file indexing, safe file access, and Mem0;
- per-workspace persistent data, so different projects can carry different
  providers, plugins, memories, skills, files, and RAG indexes;
- retrieval layers that can bring back remembered facts, skills, indexed files,
  workspace markdown, and expert-specific files;
- an expert-panel tool that runs selected domain experts independently and can
  synthesize their opinions.

The important idea is that Cortex is not one hard-coded chatbot. It is a runtime
whose behavior is assembled from configuration and plugins. The WebUI is just the
visible control surface over that runtime.

The default installation gives one `Default` workspace. That workspace is the
current repository setup: its `matbot.yaml` defines the OpenAI-compatible
providers, the active plugins, the Cortex WebUI, workspace RAG, memory, skills,
the expert panel, and file-management tools. New workspaces copy this shape and
then diverge independently.

## Documentation

This README covers product and repository orientation. Start with the user guide
for installation and feature walkthroughs, then use the reference documents for
configuration, architecture, and development details.

| Document | Contents |
| --- | --- |
| [Cortex User Guide](userguide.md) | Installation, WebUI tour, conversations, workspaces, files, RAG, memory, skills, experts, sources, SQL, workflows, graph, reviews, plugins, scheduling, safety, and troubleshooting. |
| [Architecture And Core Systems](docs/architecture.md) | How requests move through the system; the plugin, memory, inner-voice, scheduling, workspace, RAG, and expert systems. |
| [Commands](docs/commands.md) | Purpose of every PowerShell script, launcher/service startup paths, `run.ps1` switches, and npm scripts. |
| [Configuration Reference](docs/configuration.md) | Configuration files, secrets/environment, Mem0 Docker, host file access, Matbot runtime, providers, workspaces, workspace RAG, and expert panel config. |
| [Plugins And Tools](docs/plugins-and-tools.md) | Active and bundled plugins, adding plugins at runtime, and governed retrieval, workflow, evaluation, ROI, host-file, expert-panel, and cognition tools. |
| [Memory And Retrieval](docs/memory-and-retrieval.md) | The "remember my name" flow, `remembered_facts`, `KnowledgeIndex`, workspace RAG, `contextual_search`, and `memory-policy.json`. |
| [Expert Panel WebUI User Manual](docs/expert-panel.md) | Using the expert panel from the WebUI, modes, synthesis, citations, and troubleshooting. |
| [WebUI](docs/webui.md) | WebUI capabilities and behavior. |
| [Testing](docs/testing.md) | Node and Playwright test layers and coverage. |
| [Troubleshooting](docs/troubleshooting.md) | Common failures and their fixes. |

A good reading order is this overview, the [Cortex User Guide](userguide.md),
and then [Architecture And Core Systems](docs/architecture.md) or the
[Configuration Reference](docs/configuration.md) when deeper operational or
implementation detail is needed. The reference documents intentionally repeat
some terms so each can be read on its own.

## Repository Map

| Path | Purpose |
| --- | --- |
| `scripts\` | PowerShell setup, run, stop, and health-check commands. |
| `local-agent\file-index` | JSON-backed file index with keyword search, metadata, hashing, exclusions, and likely-secret skipping. |
| `local-agent\file-broker` | Policy-aware file access service for listing, reading, and approved writes with diffs and backups. |
| `local-agent\docker\mem0` | Docker Compose stack for Mem0, Postgres/pgvector, Neo4j, and optional CUDA embeddings. |
| `local-agent\config` | Host-side configuration for file roots, security policy, path mapping, memory policy, and expert definitions. |
| `local-agent\knowledge` | Minimal file-backed knowledge samples for the default experts. |
| `local-agent\matbot` | Matbot runtime checkout, Cortex WebUI, providers, plugins, workspace registry, and per-workspace data. |
| `docs` | Detailed reference documentation extracted from this README. |
| `tests` | Node test suite plus Playwright WebUI coverage. |

## Technology

Cortex is predominantly a TypeScript/Node.js system with a Docker-hosted Python
memory service and Windows PowerShell operational tooling. The table below lists
the significant languages, runtimes, and libraries used by each module.

| Module | Languages / runtime | Significant technologies and libraries |
| --- | --- | --- |
| `scripts\` | Windows PowerShell | `.ps1` setup/run/health scripts; [WinSW](https://github.com/winsw/winsw) wraps Matbot as a Windows service; Windows service control (`services.msc`, `Get-Service`). |
| `local-agent\file-index` | TypeScript, Node.js | Built-in `node:http` server (no web framework); `minimatch` for glob exclusions; `node:crypto` hashing; JSON-file persistence. |
| `local-agent\file-broker` | TypeScript, Node.js | Built-in `node:http` server; no runtime dependencies; unified diffs and file backups; JSON policy files. |
| `local-agent\docker\mem0` | YAML, Python (upstream image), Dockerfile | Docker Compose stack; Mem0 API server (patched to add `psycopg`, `langchain-neo4j`, `rank-bm25`); Postgres 16 with `pgvector` for Mem0 and workspace RAG; optional `workspace-rag-cuda` embedding service under the `cuda` profile; Neo4j 5; Mem0 API runs `linux/arm64` under QEMU on amd64. |
| `local-agent\matbot` (runtime) | TypeScript (strict), Node.js >= 24 | pnpm monorepo; agentic runner, plugin loader, hooks, stores; provider communication via raw `fetch` + SSE (no provider SDKs); `Store` compare-and-swap persistence. |
| Matbot WebUI (`packages\plugins\frontend\web`) | TypeScript (server), vanilla JavaScript (client) | Node HTTP + Server-Sent Events server; framework-free `app.js`/`index.html`/CSS; `localStorage` and Web Crypto in the browser. |
| Provider adapter (`packages\plugins\providers\openai-compat`) | TypeScript | OpenAI-compatible chat-completions adapter; streaming and tool calls over `fetch` + SSE; works with OpenAI and any compatible endpoint. |
| `workspace-rag` plugin | TypeScript, Node.js | Markdown chunking and SHA-256 content hashing; Postgres/pgvector storage for vectors, metadata, and chunk text; legacy JSON fallback; CPU hash vectorizer fallback; optional CUDA embeddings through the `workspace-rag-cuda` HTTP service when launch-time CUDA probing succeeds. |
| Retrieval plugins (`hybrid-knowledge-index`, `persist-ki-bge`, `rumsfeld`) | TypeScript | `KnowledgeIndex` implementations querying Mem0 and file-index; optional BGE reranking in `persist-ki-bge`; `contextual_search` tool. |
| `expert-panel` plugin | TypeScript, Node.js | Tool-based multi-expert orchestration over the Matbot single-turn API; per-expert file retrieval and optional synthesis. |
| `evaluation-observability` plugin | TypeScript, Node.js | Store-backed end-to-end spans, redacted trace replay, deterministic and model-scored regression suites, operational metrics, cost accounting, and verified ROI evidence. |
| `tests` | JavaScript (`.mjs`), TypeScript | Node built-in test runner (`node --test`); Playwright for WebUI tests with a fake Matbot harness. |
| Root workspace | JSON, TypeScript | npm workspaces; TypeScript 5.x build (`tsc`); `@playwright/test`; shared `@types/node`. |

Cross-cutting choices worth noting:

- Provider access never uses vendor SDKs; all model traffic is `fetch` plus
  Server-Sent Events parsing.
- Shared Matbot packages avoid Node-only primitives so they run in both Node and
  the browser; Node-specific behavior lives in `-node` packages and the host apps.
- The local HTTP services deliberately use Node's built-in `http` module instead
  of a web framework to keep dependencies minimal.

## Using Cortex

The [Cortex User Guide](userguide.md) is the main task-oriented manual. It owns
the installation requirements, first-run commands, WebUI walkthroughs, feature
instructions, safety guidance, and common troubleshooting steps that previously
lived in this README or were spread across technical reference files.

## Running Tests

Before committing changes, run the complete test suite:

```powershell
npm run test:all
```

This runs:
- Node tests for backend/runtime behavior (`npm test`)
- Matbot CLI tests for ephemeral-store and workspace-storage isolation (`npm run test:cli`)
- Playwright WebUI tests for browser interactions (`npm run test:webui`)

For more details on test layers, variants, and troubleshooting, see
[Testing](docs/testing.md).

### Use workspace files as task inputs and outputs

The `Files` section is a workspace file shelf with explicit per-message
attachments. Uploading a document adds it to the shelf and selects it for the
next message; use the paperclip action to attach or detach an existing file.
This is useful when Cortex needs source material for a task, for example to
summarize a report, analyze a CSV, compare documents, transform data, or create
another artifact from it. Cortex can also write results such as reports, charts,
and exports back to the same area for you to open or download.

Uploaded files remain available to conversations in the active Cortex workspace.
They are isolated from other Cortex workspaces and are not host filesystem files.
Attaching does not place the file's full contents in every prompt. It adds a
scoped reference to the next message so Cortex reads that workspace copy on
demand, even when Workspace RAG contains a same-named host path. State the task,
for example:

> Read `sales.csv`, identify unusual changes, and create `analysis.md`.

The attachment selection clears after a successful send, keeping unrelated
files out of later turns and model context. Workspace files are
also separate from Workspace RAG: use the file shelf for explicit task inputs,
temporary working material, and generated outputs; use Workspace RAG when
Markdown folders should become persistent searchable knowledge. See
[Use Files And Workspace RAG](userguide.md#use-files-and-workspace-rag) for
upload, open, and delete instructions.

### Switch the Workspace RAG embedding model

Workspace RAG can use either the default
`sentence-transformers/all-MiniLM-L6-v2` model or
`intfloat/multilingual-e5-base`. MiniLM produces 384-dimensional vectors and is
smaller and faster. Multilingual E5 produces 768-dimensional vectors and is
intended for multilingual and cross-language retrieval. Cortex automatically
uses E5's `query: ` and `passage: ` prefixes when
`WORKSPACE_RAG_EMBEDDING_PROFILE=auto`.

Changing models invalidates the current workspace's vectors and starts a full
reindex when Matbot starts. Stop Matbot before switching, particularly when a
workspace contains many files. There is currently no action that cancels an
in-progress reindex without stopping Matbot. Do not pass `-v` to Docker Compose
when stopping services because the declared volumes contain Postgres data and
the downloaded model cache.

For large workspaces, Cortex batches chunks across files and stores
high-cardinality source/graph metadata in WAL-mode SQLite. Context-graph
expansion is skipped automatically above 10,000 files while vector and source
indexing continue. Set `CORTEX_RAG_CONTEXT_GRAPH_MAX_SCAN_FILES=-1` only when an
unbounded graph expansion is intentional.

1. Stop Cortex before changing the model:

   ```powershell
   .\scripts\stop-local-agent.ps1
   ```

2. Edit the gitignored `local-agent\docker\mem0\.env` file. To select
   multilingual E5, use:

   ```dotenv
   WORKSPACE_RAG_EMBEDDING_MODEL=intfloat/multilingual-e5-base
   WORKSPACE_RAG_EMBEDDING_MODEL_REVISION=d13f1b27baf31030b7fd040960d60d909913633f
   WORKSPACE_RAG_EMBEDDING_PROFILE=auto
   WORKSPACE_RAG_EMBEDDING_BATCH_SIZE=32
   ```

   To switch back to MiniLM, use:

   ```dotenv
   WORKSPACE_RAG_EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
   WORKSPACE_RAG_EMBEDDING_MODEL_REVISION=46605decb5369335a3847c9f41bb0b896c07dd1a
   WORKSPACE_RAG_EMBEDDING_PROFILE=auto
   WORKSPACE_RAG_EMBEDDING_BATCH_SIZE=32
   ```

   Reduce the batch size if the CUDA worker runs out of GPU memory.

3. Rebuild and recreate the CUDA embedding sidecar:

   ```powershell
   docker compose `
     -f .\local-agent\docker\mem0\docker-compose.yml `
     --profile cuda `
     up -d --build --force-recreate workspace-rag-cuda
   ```

   The first E5 start downloads the model into the persistent
   `workspace-rag-models` Docker volume and can take longer than subsequent
   starts.

4. Wait for the sidecar and verify its model contract:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:8890/health |
     Select-Object model, profile, dimensions, maxTokens, normalized,
       queryPrefix, documentPrefix
   ```

   E5 should report model `intfloat/multilingual-e5-base`, profile
   `e5-asymmetric-v1`, 768 dimensions, normalized output, and the `query: ` /
   `passage: ` prefixes. MiniLM should report
   `sentence-transformers/all-MiniLM-L6-v2`, profile `plain-v1`, 384
   dimensions, normalized output, and empty prefixes.

5. Start Cortex and Matbot:

   ```powershell
   .\scripts\run.ps1 -NoBrowser
   ```

   Matbot probes the sidecar at startup. The changed model, dimensions, or
   preprocessing signature causes Workspace RAG to re-embed existing documents
   automatically. Postgres keeps dimension-specific tables: E5 uses
   `documents_768` and `chunks_768`, while MiniLM uses `documents_384` and
   `chunks_384`. Switching models does not delete the other model's tables.

6. Check reindex progress and confirm that Matbot adopted the expected model:

   ```powershell
   Invoke-RestMethod `
     -Method Post `
     -Uri http://127.0.0.1:19778/tools/workspace_rag `
     -ContentType "application/json" `
     -Body '{"action":"status"}' |
     Select-Object state, processedFiles, totalFiles, embeddingBackend,
       embeddingModel, embeddingDimensions, embeddingProfile,
       embeddingMaxTokens, storageBackend, postgresTables
   ```

   Wait for `state` to become `idle` before treating the new index as complete.
   Do not call `reindex_now` while the status is already `indexing`, because
   that queues another scan. If startup did not schedule a scan, request one
   explicitly:

   ```powershell
   Invoke-RestMethod `
     -Method Post `
     -Uri http://127.0.0.1:19778/tools/workspace_rag `
     -ContentType "application/json" `
     -Body '{"action":"reindex_now"}'
   ```

### Roll out hierarchical Workspace RAG V2

V2 implements progressive document → section → passage retrieval beside the
existing index. Hybrid retrieval is initialized in `primary` mode by default,
but startup never turns that mode into an automatic million-file reindex. Until
an active V2 generation is published, searches continue through the V1 fallback.

1. Keep the default `CORTEX_RAG_V2_MODE=primary`, or set it to `shadow` while
   evaluating a new publication without changing answers. Configure the V2
   Postgres/object-store variables in the active workspace `.env`. For
   production, use a non-owner application database role, a separate
   `CORTEX_RAG_V2_MIGRATION_POSTGRES_URL`, and
   `CORTEX_RAG_V2_REQUIRE_SEPARATE_DB_ROLES=1`.
2. Start Cortex, then run a read-only resumable census:

   ```json
   { "action": "corpus_census", "deep": true }
   ```

   An interrupted result supplies `checkpoint`; pass it back as `resumeAfter`.
   Use the measured percentiles and storage forecast to set the 20 MB/250 MB
   prototype tier thresholds appropriately for the corpus.
3. Start one explicit side-by-side generation:

   ```json
   { "action": "ingestion_start" }
   ```

   Use `ingestion_status`, `ingestion_pause`, `ingestion_resume`,
   `ingestion_cancel`, and `ingestion_wait` to control it. Starting again while
   a job is active returns that job instead of queuing a duplicate scan.
   Cancellation preserves the active generation, and publication is one atomic
   transaction after validation.
4. Exercise V2 explicitly with `v2_search` and run `evaluation_run`. Shadow mode
   records comparable traces without changing V1 answers. Keep or restore
   `CORTEX_RAG_V2_MODE=primary` only after the authorization, citation, memory,
   relevance, latency, and degradation gates pass.
   Repeat `evaluation_run` with `evaluationVariant` set to
   `flat_dense_baseline`, `lexical_only`, `dense_only`, `hybrid_rrf`,
   `hybrid_translated`, `hybrid_reranked`, `hierarchical`, and
   `hierarchical_lazy`; each run persists its variant and metrics.
5. To enable the optional multilingual cross-encoder, start
   `docker compose --profile reranker up -d --build workspace-rag-reranker` and
   set `CORTEX_RAG_V2_RERANKER_URL=http://127.0.0.1:8891`. Retrieval falls back
   to fused lexical/dense results if this service times out or is unavailable.
   The Compose default pins the reranker model to an immutable Hugging Face
   revision and pins its referenced repository code separately; when changing
   models, set matching immutable `WORKSPACE_RAG_RERANKER_MODEL_REVISION` and
   `WORKSPACE_RAG_RERANKER_CODE_REVISION` values.

Rollback changes `CORTEX_RAG_V2_MODE` to `shadow` or `off`; V1 Postgres tables
and the JSON fallback remain untouched. V2 generations and immutable source
versions are retained for diagnosis and a later atomic re-publication.
See [Hybrid Retrieval Architecture](docs/hybrid-retrieval-architecture.md) for
the data contracts, adoption gates, and completed implementation evidence.

For additional storage, CUDA, and troubleshooting options, see
[Workspace RAG configuration](docs/configuration.md#workspace-rag).

Use [Commands](docs/commands.md) for the complete operational command reference
and [Configuration Reference](docs/configuration.md) for provider, secret,
workspace, RAG, file-access, and expert configuration.
