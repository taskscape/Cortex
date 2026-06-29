# Cortex Local Agent

Cortex is a Windows-native local assistant built on the Matbot runtime. It combines
local chat, provider selection, workspace isolation, durable memory, controlled file
access, markdown RAG, and a tool-based expert panel.

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

This README covers orientation and getting started. Detailed reference material
lives under [`docs/`](docs):

| Document | Contents |
| --- | --- |
| [Architecture And Core Systems](docs/architecture.md) | How requests move through the system; the plugin, memory, inner-voice, scheduling, workspace, RAG, and expert systems. |
| [Commands](docs/commands.md) | PowerShell scripts, `run.ps1` switches, and npm scripts. |
| [Configuration Reference](docs/configuration.md) | Configuration files, secrets/environment, Mem0 Docker, host file access, Matbot runtime, providers, workspaces, workspace RAG, and expert panel config. |
| [Plugins And Tools](docs/plugins-and-tools.md) | Active and bundled plugins, adding plugins at runtime, and the `powershell`, `file_broker_action`, `workspace_action`, `skill_action`, `contextual_search`, `expert_panel`, and cognition tools. |
| [Memory And Retrieval](docs/memory-and-retrieval.md) | The "remember my name" flow, `remembered_facts`, `KnowledgeIndex`, workspace RAG, `contextual_search`, and `memory-policy.json`. |
| [Expert Panel WebUI User Manual](docs/expert-panel.md) | Using the expert panel from the WebUI, modes, synthesis, citations, and troubleshooting. |
| [WebUI](docs/webui.md) | WebUI capabilities and behavior. |
| [Testing](docs/testing.md) | Node and Playwright test layers and coverage. |
| [Troubleshooting](docs/troubleshooting.md) | Common failures and their fixes. |

A good reading order for a new reader: this overview, then
[Architecture And Core Systems](docs/architecture.md), the `Repository Map`,
`Requirements`, and `Quick Start` below, and finally the
[Configuration Reference](docs/configuration.md) and later documents as needed.
The reference documents intentionally repeat some terms introduced here so each
can be read on its own.

## Repository Map

| Path | Purpose |
| --- | --- |
| `scripts\` | PowerShell setup, run, stop, and health-check commands. |
| `local-agent\file-index` | JSON-backed file index with keyword search, metadata, hashing, exclusions, and likely-secret skipping. |
| `local-agent\file-broker` | Policy-aware file access service for listing, reading, and approved writes with diffs and backups. |
| `local-agent\docker\mem0` | Docker Compose stack for Mem0, Postgres/pgvector, and Neo4j. |
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
| `local-agent\docker\mem0` | YAML, Python (upstream image), Dockerfile | Docker Compose stack; Mem0 API server (patched to add `psycopg`, `langchain-neo4j`, `rank-bm25`); Postgres 16 with `pgvector`; Neo4j 5; runs `linux/arm64` under QEMU on amd64. |
| `local-agent\matbot` (runtime) | TypeScript (strict), Node.js >= 24 | pnpm monorepo; agentic runner, plugin loader, hooks, stores; provider communication via raw `fetch` + SSE (no provider SDKs); `Store` compare-and-swap persistence. |
| Matbot WebUI (`packages\plugins\frontend\web`) | TypeScript (server), vanilla JavaScript (client) | Node HTTP + Server-Sent Events server; framework-free `app.js`/`index.html`/CSS; `localStorage` and Web Crypto in the browser. |
| Provider adapter (`packages\plugins\providers\openai-compat`) | TypeScript | OpenAI-compatible chat-completions adapter; streaming and tool calls over `fetch` + SSE; works with OpenAI and any compatible endpoint. |
| `workspace-rag` plugin | TypeScript, Node.js | CPU vectorizer using a hashing trick (384-dim vectors, cosine similarity) via `node:crypto`; markdown chunking and SHA-256 content hashing; local JSON vector index. No external embedding library. |
| Retrieval plugins (`hybrid-knowledge-index`, `persist-ki-bge`, `rumsfeld`) | TypeScript | `KnowledgeIndex` implementations querying Mem0 and file-index; optional BGE reranking in `persist-ki-bge`; `contextual_search` tool. |
| `expert-panel` plugin | TypeScript, Node.js | Tool-based multi-expert orchestration over the Matbot single-turn API; per-expert file retrieval and optional synthesis. |
| `tests` | JavaScript (`.mjs`), TypeScript | Node built-in test runner (`node --test`); Playwright for WebUI tests with a fake Matbot harness. |
| Root workspace | JSON, TypeScript | npm workspaces; TypeScript 5.x build (`tsc`); `@playwright/test`; shared `@types/node`. |

Cross-cutting choices worth noting:

- Provider access never uses vendor SDKs; all model traffic is `fetch` plus
  Server-Sent Events parsing.
- Shared Matbot packages avoid Node-only primitives so they run in both Node and
  the browser; Node-specific behavior lives in `-node` packages and the host apps.
- The local HTTP services deliberately use Node's built-in `http` module instead
  of a web framework to keep dependencies minimal.

## Requirements

- Node.js 20 or newer provides `node` and `npm`; it is required for builds,
  tests, file-index, file-broker, and Matbot.
- `pnpm` is required by the Matbot monorepo. `run.ps1` installs `pnpm@9` when it
  is missing unless `-SkipInstall` is used.
- Docker Desktop with WSL2 is required for the Mem0 stack: Postgres, Neo4j, and
  the Mem0 API.
- The Mem0 API image used here is currently run as `linux/arm64` in Docker
  Compose. On `amd64` Windows hosts, Docker Desktop runs it through QEMU
  emulation.
- The local Mem0 API image is patched with `Dockerfile.mem0-api` because the
  upstream image lacks the `psycopg` driver needed by pgvector and needs a
  persistent history directory. The first compose startup may take a few minutes
  while this derived image is built; later starts reuse it.
- An OpenAI-compatible model provider is required for real model turns. The
  default hosted provider uses `OPENAI_API_KEY`; the configured `Local` provider
  points at `http://100.122.2.99:11435/v1`.

## Quick Start

Prerequisites:

- Windows PowerShell.
- Node.js 20 or newer.
- Docker Desktop if you want Mem0 memory services.
- Network access to any configured hosted provider.

Configure secrets once:

```powershell
.\scripts\setup-secrets.ps1 -OpenAiKey "<your-openai-key>"
```

This generates strong local passwords, stores them as User-scoped environment
variables, and writes `local-agent\docker\mem0\.env`. Open a new terminal after
running it so the new User-scoped environment variables are visible.

Launch everything:

```powershell
.\scripts\run.ps1
```

The command installs and builds when needed, starts local services, checks health,
starts or restarts the WebUI process, and opens the browser at:

```text
http://localhost:19778
```

Stop local services:

```powershell
.\scripts\stop-local-agent.ps1
```

For the full command reference, see [Commands](docs/commands.md).

## Safety Defaults

- Secrets are gitignored and should stay out of commits.
- File-broker only writes inside configured read-write roots.
- File-broker creates backups and diffs for overwrites.
- Security policy blocks sensitive path fragments and marks high-risk extensions.
- File-index skips likely secrets and excludes common generated directories.
- Workspace RAG indexes markdown only and stores per-workspace data locally.
- Expert knowledge roots are isolated by expert id.
- Playwright tests use a fake Matbot harness and do not spend model tokens.
