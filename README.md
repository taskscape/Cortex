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

Use [Commands](docs/commands.md) for the complete operational command reference
and [Configuration Reference](docs/configuration.md) for provider, secret,
workspace, RAG, file-access, and expert configuration.
