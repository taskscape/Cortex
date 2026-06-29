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

## How To Read This Document

Start with these first sections if you are trying to understand the system:

1. `Conceptual Overview` explains what Cortex is.
2. `Architecture At A Glance` explains how requests move through the system.
3. `Core Systems` explains plugins, memory, workspaces, RAG, and experts.
4. `Repository Map`, `Requirements`, and `Quick Start` explain how to run it.
5. `Configuration Reference` and later sections document every configurable part.

The detailed reference sections intentionally repeat some terms introduced early.
The goal is that a new reader first learns the mental model, then has exact files,
commands, schemas, and troubleshooting steps close at hand.

## Architecture At A Glance

Cortex is layered rather than monolithic.

| Layer | Responsibility | Main files/services |
| --- | --- | --- |
| Browser UI | Chat, provider picker, expert controls, files, skills, workspace switcher, workspace settings. | `local-agent\matbot\packages\plugins\frontend\web` |
| Matbot runtime | Loads config, providers, plugins, stores, sessions, tools, hooks, and the WebUI server. | `local-agent\matbot`, active `matbot.yaml` |
| Workspace manager | Selects, creates, renames, and switches Cortex workspaces. | `cortex-workspaces.json`, `workspaces\<id>` |
| Provider layer | Converts Matbot messages/tools into model API requests. | `providers.openai-compat` |
| Plugin layer | Adds capabilities such as sessions, skills, triggers, memory, RAG, expert panel, and workspace files. | `plugins:` in `matbot.yaml` |
| Retrieval layer | Pulls context from remembered facts, KnowledgeIndex, Mem0, file-index, workspace RAG, and expert files. | `contextual_search`, `workspace_rag`, `expert_panel` |
| Local services | Host-side indexing, host file access, and Mem0. | ports `8877`, `8878`, `8888` |
| Persistence layer | Stores sessions, files, skills, facts, RAG indexes, and service data. | `.data`, Docker volumes, JSON stores |

Default local endpoints:

| Service | Default URL | Backing code |
| --- | --- | --- |
| File index | `http://localhost:8877` | `local-agent\file-index` |
| File broker | `http://localhost:8878` | `local-agent\file-broker` |
| Mem0 API | `http://localhost:8888` | `local-agent\docker\mem0` |
| Cortex WebUI | `http://localhost:19778` | `local-agent\matbot\packages\plugins\frontend\web` |

Startup flow:

1. `scripts\run.ps1` checks install/build state.
2. It starts file-index, file-broker, and the Mem0 Docker stack unless skipped.
3. It starts or restarts the Matbot WebUI process.
4. Matbot finds `matbot.yaml`, then loads `cortex-workspaces.json`.
5. The active workspace selects the actual `matbot.yaml` and `.env`.
6. Matbot loads providers first, then plugins in configured order.
7. Plugins register tools, services, stores, hooks, and the WebUI HTTP/SSE server.
8. The browser connects to the WebUI and streams turns, tool calls, usage, and
   timing events.

Per-turn flow:

1. The user sends a message in the WebUI.
2. The frontend plugin appends it to the active session.
3. Hooks and triggers may add context or fire side-effect tools.
4. Workspace RAG may inject relevant markdown snippets.
5. The provider adapter sends messages and available tools to the selected model.
6. Tool calls run inside the Matbot tool layer and can query memory, RAG, files,
   experts, or local services.
7. The assistant response streams back to the WebUI with token and elapsed-time
   summaries.

Persistence is deliberately split:

| Data | Scope | Location |
| --- | --- | --- |
| Workspace registry | Whole Cortex installation | `local-agent\matbot\cortex-workspaces.json` |
| Provider/plugin config | One Cortex workspace | that workspace's `matbot.yaml` |
| Provider secrets | One Cortex workspace | that workspace's `.env` |
| Sessions, files, stores, memories, skills | One Cortex workspace | that workspace's `.data` |
| Workspace RAG config | One Cortex workspace | that workspace's `cortex-rag.json` |
| Workspace RAG index | One Cortex workspace | `.data\workspace-rag\index.json` |
| File-index data | Host service | `local-agent\file-index\data\index.json` |
| Mem0/Postgres/Neo4j | Docker stack | Docker volumes |

## Core Systems

### Plugin System

Matbot plugins are the main extension mechanism. A plugin can provide one or more
of these things:

- tools callable by the model or by the WebUI HTTP tool endpoint;
- services registered into the runtime, such as `KnowledgeIndex` or
  `WorkspaceRagManager`;
- stores and generated CRUD tools;
- hooks that observe or modify turn behavior;
- provider adapters;
- frontend surfaces such as the WebUI server.

Plugins are loaded from the active workspace's `plugins:` list. The order matters
because later plugins can depend on services registered by earlier plugins. In
the default config, `hybrid-knowledge-index` registers `KnowledgeIndex` before
`rumsfeld` exposes `contextual_search`, and the frontend loads last so its plugin
catalog reflects the fully initialized runtime.

There are three common plugin categories in this repository:

| Category | Examples | Pattern |
| --- | --- | --- |
| Capability plugins | `sessions`, `skills`, `triggers`, `cognition`, `workspace` | Add tools, stores, hooks, or runtime services. |
| Retrieval/access plugins | `hybrid-knowledge-index`, `file-broker`, `workspace-rag`, `rumsfeld`, `expert-panel` | Provide context, grounded answers, and policy-aware host-file access. |
| Host/UI plugins | `frontend/web`, `providers/openai-compat` | Connect the runtime to users and models. |

Bundled plugins may exist in the tree without being active. They become active
only when listed in the active workspace's `matbot.yaml`. That distinction is
important when debugging errors like `workspace_rag plugin unavailable`: the code
can exist on disk while the running workspace did not load it.

### Memory System

Cortex memory is not a single bucket. It is several layers with different jobs:

| Layer | What it stores | Main tool/service |
| --- | --- | --- |
| Session history | The active conversation and previous conversations. | `sessions` |
| Remembered facts | Explicit durable facts such as names, preferences, and project facts. | `remember_fact`, `remembered_facts_action` |
| Skills | Reusable markdown playbooks and long-term operating knowledge. | `skill_action` |
| KnowledgeIndex | Search interface over skills, Mem0, and file-index results. | `KnowledgeIndex` service |
| Workspace RAG | Markdown files configured for the current workspace. | `workspace_rag` |
| Dream-time runs | Memory consolidation audit records. | `dream_time`, `dream_runs_action` |

The "remember my name" flow is the simplest way to understand this:

1. The user says, "Memorize my name: Maciej Zagozda."
2. The `triggers` plugin classifies that message as memory-worthy.
3. The `cognition` plugin runs `remember_fact` as a silent side effect.
4. `remember_fact` extracts the stable fact and writes it to `remembered_facts`.
5. On a later turn, `contextual_search` can search raw `remembered_facts`
   directly, so the name can be recalled before any slower consolidation happens.
6. `dream_time` is a separate consolidation pass that can later merge remembered
   facts into skills when they strongly match a skill.

This separation matters. Storing a fact and recalling a fact are different
operations. A model can fail to recall a name even when the fact exists if it
does not call the retrieval tool or the relevant memory context is not injected.
That is why direct inspection through `remembered_facts_action` is documented
later in this README.

### Inner Voice

Inner Voice is Cortex's built-in second-opinion pattern for improving an
assistant response. It is part of the `cognition` plugin, but it is not durable
memory and it is not background execution. It is a critique mechanism.

The concept is a two-chamber model:

- `Matbot1` is the normal chat agent: analytical, goal-directed, tool-using,
  and responsible for the final answer.
- `Matbot2` is the constructive critic: it looks for wrong assumptions,
  generic reasoning, missing context, weak framing, and overconfident answers.

The point is not to make one model "think harder." The point is to ask a
different kind of thinker to challenge the first answer. In the best case,
`Matbot2` runs on a different model lineage from the main provider so its
critique is genuinely independent. If no separate provider is configured,
Inner Voice can still fall back to the current turn's provider, but that is a
same-lineage self-critique and is less valuable.

Operationally, the `cognition` plugin seeds an `Inner voice` skill and
registers the `ask_inner_voice` tool. When the skill is used, `Matbot1`
summarizes the user's problem and its draft answer, calls `ask_inner_voice`,
then integrates the critique into one sharper response. The user normally sees
the improved answer, not a transcript of two agents debating.

Inner Voice is best suited to strategic, design, trust, UX, communication, and
other open-ended questions where framing matters. It is a poor fit for narrow
data lookups, SQL/config formatting, or tasks with one straightforward correct
answer. In the trigger system, it acts like an "expert over your shoulder":
it can be loaded when the user asks for deeper thought, challenges an answer,
expresses skepticism, or when an assistant response itself shows signs of an
unresolved anomaly.

### Scheduled And Unattended Actions

Cortex can run scheduled work without an attended browser tab, but the Matbot
Node process must stay alive. The browser is only the control surface. Closing
the browser does not stop an already running Cortex process; stopping the Matbot
process does stop the scheduler.

The built-in scheduling path is the optional `background` plugin. It exposes:

- `background`: starts a prompt in a child Matbot process. With `interval`, it
  creates a recurring schedule.
- `every_action`: lists, suspends, resumes, or cancels recurring schedules.

Recurring schedules are stored in the active workspace and are re-armed when
Cortex starts again. They do not run while the computer is asleep, powered off,
or while the Matbot process is stopped. Missed intervals are not caught up by an
external service; the in-process scheduler resumes after Cortex is running.

Scheduled prompts can use whatever tools are loaded in the same workspace. The
common unattended-action stack is:

| Plugin | What it enables | Notes |
| --- | --- | --- |
| `./packages/plugins/background` | Recurring and detached prompt jobs. | Required for Cortex-managed schedules. |
| `./packages/plugins/http` | Fetch pages, APIs, and remote resources. | Uses plain HTTP fetch; it does not render JavaScript-heavy pages. |
| `./packages/plugins/powershell` | Execute Windows-native PowerShell scripts. | Preferred for Windows command automation. |
| `./packages/plugins/bash` | Execute shell scripts from a scheduled prompt. | Spawns `bash -c`; Windows needs `bash.exe` in PATH, such as Git Bash or WSL. |
| `./packages/plugins/docker-bash` | Execute shell scripts in Docker. | Prefer this for risky or untrusted command automation. |

For native Windows command execution, use the `powershell` tool. The `bash`
plugin is not a PowerShell runner.

To enable Cortex-managed schedules, insert the needed plugins in the active
workspace's `matbot.yaml` before the existing `frontend/web` entry, then restart
Cortex:

```yaml
plugins:
  # existing plugins above...
  - ./packages/plugins/background
  - ./packages/plugins/http
  - ./packages/plugins/powershell
  - ./packages/plugins/bash
  - ./packages/plugins/frontend/web
```

For manual foreground-free use, Cortex can still be started without opening a
browser:

```powershell
.\scripts\run.ps1 -NoBrowser
```

For unattended operation on Windows, install the Cortex service wrapper instead
of supervising `run.ps1` with Task Scheduler. `run.ps1` and
`start-local-agent.ps1` intentionally start Matbot as a hidden child process and
then return; a scheduled task would supervise only the launcher. The service path
uses WinSW and `scripts\run-service.ps1`, which keeps Matbot in the foreground so
the wrapper observes the real long-running process and restarts it if it exits.

```powershell
.\scripts\run.ps1 -NoStart
Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "C:\Projects\Cortex\scripts\install-cortex-service.ps1" -Start'
```

The installer downloads WinSW into `local-agent\service` unless `-WinSWExe` is
provided, writes `CortexLocalAgent.xml`, installs the service, and optionally
starts it. Service logs are written under `local-agent\logs\service`.

By default the service is installed under Windows' default service account. If
Docker Desktop, provider keys, `pnpm`, Git Bash, WSL, or mapped/network drives
are only available under your interactive Windows user, change the service Log On
account in `services.msc` or configure secrets in the workspace `.env` files
instead of relying on user-scoped environment variables.

Operate the service with normal Windows service commands:

```powershell
Get-Service CortexLocalAgent
Start-Service CortexLocalAgent
Stop-Service CortexLocalAgent
Restart-Service CortexLocalAgent
```

Uninstall the service from an elevated PowerShell session:

```powershell
.\scripts\uninstall-cortex-service.ps1
```

You can create and manage schedules through chat, or through the WebUI tool HTTP
endpoint while Cortex is running. Example recurring page retrieval:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:19778/tools/background" `
  -ContentType "application/json" `
  -Body '{
    "name": "hourly-page-check",
    "interval": "1h",
    "provider": "openai",
    "output": "scheduled-page-check.md",
    "prompt": "Fetch https://example.com with the http tool, summarize the page status, and write the result to the requested output."
  }'
```

List recurring schedules:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:19778/tools/every_action" `
  -ContentType "application/json" `
  -Body '{"action":"list"}'
```

Suspend, resume, or cancel a schedule:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:19778/tools/every_action" -ContentType "application/json" -Body '{"action":"suspend","id":"<schedule-id>"}'
Invoke-RestMethod -Method Post -Uri "http://localhost:19778/tools/every_action" -ContentType "application/json" -Body '{"action":"resume","id":"<schedule-id>"}'
Invoke-RestMethod -Method Post -Uri "http://localhost:19778/tools/every_action" -ContentType "application/json" -Body '{"action":"cancel","id":"<schedule-id>"}'
```

For deterministic automation, Windows Task Scheduler can still call Cortex tools
directly instead of supervising the Cortex process or asking a model to decide
what to do. For example, a scheduled PowerShell script can call `POST
/tools/http` or `POST /tools/powershell` as long as the Cortex service is already
running. Direct tool calls are non-interactive; they cannot answer prompts that
expect a live UI user.

Security rules for unattended actions:

- Keep the WebUI bound to localhost unless an authentication layer is added.
- Do not expose port `19778` to a LAN or the internet with command tools loaded.
- Run Cortex under a least-privilege Windows account.
- Prefer `docker-bash` for command execution that does not need host access.
- Restrict allowed file roots through `local-agent\config\workspaces.json` and
  `local-agent\config\security-policy.json`.
- Treat `POST /tools/<name>` as powerful local automation, especially when
  `powershell`, `bash`, `docker-bash`, file access, or provider-backed tools are
  enabled.

### Workspace System

A Cortex workspace is a boot-scoped runtime context. It controls:

- provider and model list;
- plugin list;
- workspace-local secrets;
- sessions and files;
- remembered facts and tool stores;
- skills and knowledge;
- workspace RAG folders and index.

Switching workspaces restarts the Matbot process intentionally. Providers,
plugins, vaults, stores, hooks, and session runners are initialized at boot, so a
true workspace switch needs a fresh runtime.

The default workspace points at `local-agent\matbot\matbot.yaml`. New workspaces
live under `local-agent\matbot\workspaces\<workspace-id>` and receive their own
copy of `matbot.yaml`, `.env`, and `.data`.

### RAG And Retrieval Patterns

Cortex uses several retrieval patterns at once because they solve different
problems:

| Pattern | Scope | Best for | Implementation |
| --- | --- | --- | --- |
| Host file index | Configured host roots | Broad project file search and metadata. | `file-index`, `hybrid-knowledge-index` |
| File broker | Configured host roots | Safe host file reads/writes with policy and backups. | `file-broker` service, `file_broker_action` tool |
| Workspace RAG | One Cortex workspace | Grounding every conversation in selected markdown folders. | `workspace-rag` |
| Remembered facts | One Cortex workspace | Explicit durable memory such as names and preferences. | `cognition` stores |
| Skills as knowledge | One Cortex workspace | Reusable operating procedures and assistant behavior. | `skills`, `KnowledgeIndex` |
| Expert knowledge roots | One expert definition | Isolated domain expertise. | `expert-panel` |
| Mem0 | Shared Mem0 service, queried by user id | External memory service integration. | `hybrid-knowledge-index` |

The high-level rule is:

- use `workspace_rag` for markdown folders selected for the current workspace;
- use `contextual_search` when the model needs a blended recall layer;
- use `expert_panel` when the user wants different domain perspectives;
- use `contextual_search`/file-index to discover host-file matches, then
  `file_broker_action` to list, read, or write exact host paths;
- use `workspace_action` only for Matbot workspace uploads and generated
  artifacts, not host filesystem files.

### Expert System

The expert panel is a tool-based panel of specialists. Each expert has its own
definition, provider choice, system prompt, and knowledge roots. When asked, the
tool retrieves relevant expert-specific files, runs each expert independently,
and optionally performs a synthesis pass.

This gives three useful behaviors:

- experts can disagree because they are prompted from different perspectives;
- citations stay scoped to each expert's configured files;
- the orchestrator can collate consensus, disagreement, risks, assumptions, and
  a recommendation.

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
| `tests` | Node test suite plus Playwright WebUI coverage. |

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

## Commands

### PowerShell

Run commands from `C:\Projects\Cortex`.

| Command | Purpose |
| --- | --- |
| `.\scripts\setup-secrets.ps1 -OpenAiKey "<key>"` | Generate local passwords and write Mem0/OpenAI environment configuration. |
| `.\scripts\setup-local-agent.ps1` | Install dependencies and build the local agent workspaces. |
| `.\scripts\start-local-agent.ps1` | Start file-index, file-broker, Mem0 Docker services, and optionally Matbot. |
| `.\scripts\health-check.ps1` | Check health of file-index, file-broker, and Mem0. |
| `.\scripts\stop-local-agent.ps1` | Stop local service processes and the Docker stack. |
| `.\scripts\run.ps1` | Aggregate setup, start, health-check, and browser launch. |
| `.\scripts\install-cortex-service.ps1 -Start` | Install the WinSW-backed Windows service and start it. Run elevated. |
| `.\scripts\uninstall-cortex-service.ps1` | Stop and remove the Cortex Windows service. Run elevated. |
| `.\scripts\run-service.ps1` | Foreground runner used by the Windows service wrapper. Usually not run directly. |

Useful `run.ps1` switches:

| Switch | Effect |
| --- | --- |
| `-ForceInstall` | Force dependency checks and installation. |
| `-SkipInstall` | Do not install dependencies. Requires dependencies to already exist. |
| `-SkipBuild` | Do not run builds. |
| `-SkipDocker` | Do not start the Mem0 Docker stack. |
| `-SkipHealth` | Do not run health checks. |
| `-NoBrowser` | Start services but do not open a browser. Use this for unattended/local-service operation. |
| `-NoStart` | Check install/build state without starting services. |
| `-NoRestartMatbot` | Reuse an already-running WebUI process instead of restarting it. |
| `-WebPort 19779` | Start the WebUI on a different port. |
| `-HealthTimeoutSec 180` | Wait longer for services to become healthy. |

`run.ps1` restarts the WebUI process by default so changes to plugins,
configuration, providers, and UI assets are picked up. Use `-NoRestartMatbot`
only when you deliberately want to keep the existing WebUI process.

### npm

| Command | Purpose |
| --- | --- |
| `npm run build` | Build all npm workspaces declared in the root `package.json`. |
| `npm test` | Run the Node test suite in `tests\*.test.mjs`. |
| `npm run test:webui` | Run Playwright WebUI tests. |
| `npm run test:all` | Run Node tests and Playwright tests. |
| `npm run verify:openai` | Verify the current OpenAI API key with the configured test script. |

First Playwright setup on a machine:

```powershell
npx playwright install chromium
```

## Configuration Reference

This section is the main reference for configuration files and environment
variables. Prefer editing configuration files over changing code when adding
providers, plugins, workspaces, or RAG folders.

### Configuration Files

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

### Secrets And Environment

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
| `MEM0_USER_ID` | `local-agent` | User id used by hybrid Mem0 retrieval. |
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

### Mem0 Docker

`local-agent\docker\mem0\docker-compose.yml` reads
`local-agent\docker\mem0\.env`. The expected template is:

```dotenv
MEM0_BASE_URL=http://localhost:8888
MEM0_API_KEY=CHANGE_ME
POSTGRES_DB=mem0
POSTGRES_USER=mem0
POSTGRES_PASSWORD=CHANGE_ME
NEO4J_PASSWORD=CHANGE_ME
NEO4J_AUTH=neo4j/CHANGE_ME
OPENAI_API_KEY=CHANGE_ME
```

The Postgres and Neo4j passwords are baked into their Docker volumes on first
start. If you rotate them after the stack has already started, recreate the
volumes:

```powershell
docker compose -f local-agent\docker\mem0\docker-compose.yml down -v
```

Then run `setup-secrets.ps1` and start again.

### Host File Access

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
  "excludedPatterns": [
    "**\\node_modules\\**",
    "**\\.git\\**",
    "**\\dist\\**"
  ]
}
```

`mode` is `read-write` or `read-only`. File-broker writes are allowed only inside
read-write roots and still pass security checks.

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

### Matbot Runtime

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
  - ./packages/plugins/sessions
  - ./plugins/hybrid-knowledge-index
  - ./plugins/file-broker
  - ./packages/plugins/workspace-rag
  - ./packages/plugins/skills
  - ./packages/plugins/triggers
  - ./packages/plugins/rumsfeld
  - ./packages/plugins/cognition
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

Plugin order matters when one plugin provides a service consumed by another. For
example, `hybrid-knowledge-index` registers `KnowledgeIndex` before `rumsfeld`
uses it, and `frontend/web` loads last so the WebUI sees the complete tool and
plugin catalog.

### Providers

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

### Cortex Workspaces

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

### Workspace RAG Configuration

The `workspace-rag` plugin provides workspace-scoped markdown retrieval for every
conversation. It is installed by default in `matbot.yaml`, and the CLI ensures it
is present in every workspace config when Matbot starts.

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
| Vector DB | Local JSON index at `.data\workspace-rag\index.json` inside each workspace. |

The ingestion manager:

- scans all workspaces in `cortex-workspaces.json`, not only the currently selected workspace;
- indexes markdown files under configured paths;
- chunks markdown, hashes document content, and stores a local vector-like index;
- re-indexes changed files when the markdown hash changes;
- removes deleted markdown files from the index;
- continues in the background while the WebUI is open;
- rescans configured folders every minute after the initial pass;
- restarts ingestion for the current workspace immediately when saved paths change.

The WebUI exposes the active context through the workspace settings page:

1. Click the workspace gear in the bottom-left area.
2. Edit `Context name`.
3. Enter one absolute markdown folder path per line.
4. Click `Save` to persist and return to chat, or `Cancel` to discard changes.

The status line displays state, percentage, CPU/NVIDIA status, a human message,
and the currently processed file name when indexing is active.

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

Status responses include:

| Field | Meaning |
| --- | --- |
| `state` | `pending`, `idle`, `indexing`, or an error state. |
| `percent` | Ingestion progress percentage. |
| `processedFiles` / `totalFiles` | Current scan progress. |
| `currentFile` | Current markdown file being processed while `state` is `indexing`; omitted once indexing is idle, pending, or errored. |
| `nvidiaAvailable` | Whether `nvidia-smi` is visible on the host. |
| `accelerated` | Whether the current ingestion backend is GPU-accelerated. |
| `accelerator` | `nvidia` or `cpu`. |
| `message` | Human-readable status message. |

The current built-in vectorizer is CPU-based. It detects NVIDIA availability for
reporting, but `accelerated` remains `false` and `accelerator` reports `cpu`
until a GPU embedding backend is added.

### Expert Panel Configuration

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

## Plugins And Tools

The active default plugin list is in `local-agent\matbot\matbot.yaml`.

| Plugin | Role | Main user-facing tools/services |
| --- | --- | --- |
| `./packages/plugins/providers/openai-compat` | OpenAI-compatible provider adapter. | Provider profiles in the UI selector. |
| `./packages/plugins/sessions` | Persistent sessions and conversation metadata. | Conversation list, rename/hide/pin-style session actions. |
| `./plugins/hybrid-knowledge-index` | Registers Matbot `KnowledgeIndex` backed by Mem0 and file-index. | Service consumed by retrieval tools. |
| `./plugins/file-broker` | Client for the local file-broker HTTP service. | `file_broker_action`. |
| `./packages/plugins/workspace-rag` | Workspace-scoped markdown RAG. | `workspace_rag`, automatic per-turn RAG context. |
| `./packages/plugins/skills` | Persistent markdown skills/playbooks. | `skill_action`, skill editor UI. |
| `./packages/plugins/triggers` | Data-driven automatic tool triggers. | Trigger management and automatic `remember_fact` firing. |
| `./packages/plugins/rumsfeld` | Context lookup tool. | `contextual_search`. |
| `./packages/plugins/cognition` | Durable memory, inner voice, dream-time stores/tools. | `remember_fact`, `remembered_facts_action`, `dream_time`, `dream_runs_action`, `ask_inner_voice`, `cognition_config`. |
| `./packages/plugins/workspace` | Matbot workspace file abstraction. | `workspace_action`, WebUI file upload/delete/list. |
| `./plugins/expert-panel` | Multi-perspective expert orchestration. | `expert_panel`. |
| `./packages/plugins/frontend/web` | Cortex WebUI HTTP/SSE server. | Browser UI and HTTP tool endpoints. |

Bundled plugins that exist in `local-agent\matbot\packages\plugins` but are not
loaded by the default `matbot.yaml`:

| Plugin | Purpose |
| --- | --- |
| `ask-user` | Interactive user prompts with text, password, select, and confirm controls. |
| `background` | Detached and recurring prompts. Useful for scheduled jobs such as hourly `dream_time`. |
| `bash` | Run bash scripts in the session workspace. |
| `browser` | Browser-native IndexedDB, OPFS, and WebCrypto backends for browser-only Matbot runs. |
| `docker-bash` | Replace bash with a persistent Docker container. |
| `edit-session` | Cut, fork, and compact sessions. |
| `files` | Node filesystem-backed file store served by the frontend. |
| `hook-logger` | Diagnostic hook logging for plugin pipeline debugging. |
| `http` | HTTP request tool for web APIs and remote resources. |
| `json-validation` | Validates tool-call input against each tool's JSON Schema. |
| `mcp` | Local stdio MCP client plus remote MCP delegation. |
| `mcp-http` | Cross-runtime remote MCP HTTP/SSE client. |
| `persist-ki-bge` | Store-backed `KnowledgeIndex` with entity/heading search and optional BGE reranking. |
| `powershell` | Run Windows PowerShell scripts in the session workspace. |
| `skills-node` | Node-only skills plugin with local filesystem markdown import/watch. |
| `tool-store` | Defines named stores and generated CRUD tools. Used indirectly by cognition. |
| `web-principal-user` | Sets frontend request principal from the host OS user. |
| `whoami` | Reports the current security principal. |

To activate one, add its specifier to the active workspace's `plugins:` list and
restart Cortex. For scheduled unattended actions, add the scheduler plus the
tools the scheduled prompts are allowed to use:

```yaml
plugins:
  - ./packages/plugins/background
  - ./packages/plugins/http
  - ./packages/plugins/powershell
  - ./packages/plugins/bash
```

### Adding Plugins At Runtime

Matbot can discover and add plugins while the WebUI is running. Prefer local
specifiers for bundled plugins:

```text
plugin discover_local
plugin add ./packages/plugins/background
plugin add ./packages/plugins/powershell
```

Using a local `./packages/plugins/<name>` specifier does not need a package
install; the runtime loads the plugin from the current Matbot checkout.

Adding an npm-named plugin is different. Matbot runs `pnpm add` for npm
specifiers, and pnpm normally blocks adding dependencies to the workspace root
with `ERR_PNPM_ADDING_TO_ROOT`. This repository's
`local-agent\matbot\.npmrc` sets `ignore-workspace-root-check=true` so npm-named
plugin installation can work from the Matbot workspace root. Even so, local
specifier paths are safer for bundled plugins because they avoid unnecessary
package-manager changes.

Plugin changes are boot-sensitive. If a plugin registers tools, services,
stores, providers, or frontend behavior, restart Cortex after adding it:

```powershell
.\scripts\run.ps1
```

### `powershell`

Runs Windows-native PowerShell scripts from Matbot. Use this instead of `bash`
for service control, Windows filesystem tasks, registry checks, PowerShell module
commands, and scheduled Windows automation.

Install it by adding the plugin to the active workspace's `matbot.yaml`, before
`frontend/web`, then restart Cortex:

```yaml
plugins:
  - ./packages/plugins/powershell
```

Or add it while the WebUI is running:

```text
plugin add ./packages/plugins/powershell
```

The tool name is `powershell`. Its input matches the `bash` tool shape:

```ts
type PowerShellInput = {
  script: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
};
```

The implementation writes `script` to a temporary `.ps1` file and deliberately
launches Windows PowerShell as:

```text
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <temp.ps1>
```

Microsoft documents `-NonInteractive` as causing interactive prompts to fail
instead of hanging, and `-ExecutionPolicy` as setting the execution policy only
for that PowerShell session. See the
[PowerShell.exe command-line documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe).

Direct WebUI tool call example:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:19778/tools/powershell" `
  -ContentType "application/json" `
  -Body '{
    "script": "Get-Service CortexLocalAgent | Select-Object -Property Name,Status | ConvertTo-Json",
    "cwd": "C:\\Projects\\Cortex",
    "timeout": 10000
  }'
```

Example with environment variables:

```json
{
  "script": "Write-Output \"Value: $env:CORTEX_TEST_VALUE\"",
  "env": { "CORTEX_TEST_VALUE": "ok" },
  "timeout": 5000
}
```

Operational notes:

- `cwd` defaults to the Matbot session workspace and is created if missing.
- `env` values are merged over the Cortex process environment for the child
  PowerShell process only.
- `timeout` kills the child process after the requested number of milliseconds.
- Stdout and stderr stream while the command runs; the final result includes
  accumulated `stdout`, `stderr`, and `exitCode`.
- A non-zero PowerShell exit code returns a tool error with accumulated output.
- Interactive prompts are unsuitable for unattended runs because
  `-NonInteractive` makes them fail rather than wait forever.

### `file_broker_action`

Calls the local file-broker HTTP service from Matbot. Use it for exact host
filesystem paths that are inside the configured roots from
`local-agent\config\workspaces.json`. It is the model-facing access path for
file-broker; the HTTP service still enforces root policy, high-risk write
approval, read limits, backups, and diffs.

Common actions:

```json
{ "action": "health" }
```

```json
{ "action": "list", "path": "C:\\Projects\\Cortex" }
```

```json
{ "action": "read", "path": "C:\\Projects\\Cortex\\readme.md" }
```

```json
{
  "action": "write",
  "path": "C:\\Projects\\Cortex\\notes\\summary.md",
  "content": "# Summary\n\nHello.",
  "approved": false
}
```

Set `approved: true` only after explicit user approval for high-risk writes
such as `.env` files. The write response includes a unified diff and, for
overwrites, a backup path under the configured backup root.

### `workspace_action`

Manages files in Matbot's workspace namespace. This is not unrestricted host
filesystem access.

Examples:

```json
{ "action": "list", "recursive": true }
```

```json
{
  "action": "write",
  "path": "notes/summary.md",
  "content": "# Summary\n\nHello.",
  "encoding": "utf8"
}
```

```json
{
  "action": "read",
  "path": "notes/summary.md"
}
```

```json
{
  "action": "delete",
  "path": "notes/summary.md"
}
```

### `skill_action`

Manages named markdown skills. Skills are persisted and mirrored into the active
`KnowledgeIndex` when that service is available.

Common actions:

```json
{ "action": "list" }
```

```json
{ "action": "load", "name": "Inner voice" }
```

```json
{
  "action": "save",
  "name": "Panel Etiquette",
  "content": "# Panel Etiquette\n\nUse concise expert disagreement."
}
```

### `contextual_search`

`contextual_search` is the model-facing lookup tool for local context. It queries:

- raw `remembered_facts`;
- active `KnowledgeIndex`;
- workspace RAG results, when available.

Example:

```json
{
  "query": "What do we know about Maciej's preferred shell?",
  "limit": 5
}
```

When remembered facts match, the tool returns a result named
`remembered_facts` and includes a `Remembered facts:` content block. When RAG
matches, it includes workspace RAG results with file citations.

### `expert_panel` Tool

Runs selected experts against one question, optionally synthesizing a final
decision.

```json
{
  "question": "Should we add Google Drive persistence for the Node host?",
  "experts": ["design", "finance", "engineering"],
  "mode": "review",
  "maxCitationsPerExpert": 5,
  "synthesize": true
}
```

Modes:

| Mode | Use |
| --- | --- |
| `parallel` | Each expert answers independently. |
| `review` | Experts critique a proposal or decision. |
| `debate` | Experts emphasize disagreement and tradeoffs. |

The WebUI integrates this with the main composer. Use the `Experts` control next
to the send button to select experts, choose mode, and enable or disable
synthesis. The user question is typed in the main chat entry box.

### Cognition Tools

Direct HTTP calls to tools that depend on the current conversation can pass a
tool-context envelope:

```json
{
  "$context": {
    "sessionId": "current-session-id",
    "provider": "openai"
  },
  "input": {}
}
```

`sessionId` gives the tool a real session history, and `provider` gives tools
such as `remember_fact`, `dream_time`, and unpinned `ask_inner_voice` the model
that would normally come from the active turn. Tools that do not need session or
provider context can still be called with their ordinary bare JSON body.
When a direct tool call emits markers but no ordinary result, the HTTP endpoint
returns `{ "ok": true, "markers": [...] }`.

Capture durable facts from the latest user message:

```json
{
  "$context": {
    "sessionId": "current-session-id",
    "provider": "openai"
  },
  "input": {}
}
```

Send to:

```text
POST http://localhost:19778/tools/remember_fact
```

Inspect remembered facts:

```json
{
  "action": "query",
  "query": {
    "limit": 50,
    "sort": [{ "field": "createdAt", "dir": "desc" }]
  }
}
```

Send to:

```text
POST http://localhost:19778/tools/remembered_facts_action
```

Run one memory consolidation pass:

```json
{
  "$context": {
    "provider": "openai"
  },
  "input": {}
}
```

Send to:

```text
POST http://localhost:19778/tools/dream_time
```

Ask the Inner Voice critic to review a draft response:

```json
{
  "$context": {
    "provider": "openai"
  },
  "input": {
    "prompt": "Summarize the user problem, relevant constraints, and the draft response to critique.",
    "system": "You are the second chamber of a bicameral assistant. Be direct, specific, and constructive."
  }
}
```

Send to:

```text
POST http://localhost:19778/tools/ask_inner_voice
```

The tool returns the critic text and token usage. The provider is selected by
`cognition_config.innerVoiceProvider`; when it is `null`, the tool falls back to
the current turn's provider.

Configure cognition:

```json
{ "action": "get" }
```

```json
{
  "action": "set",
  "innerVoiceProvider": "Local",
  "dreamRankerProvider": "openai",
  "dreamMergerProvider": "openai",
  "strongThreshold": 0.75,
  "weakThreshold": 0.5,
  "maxClusterSize": 5,
  "blocklist": ["Inner voice"],
  "weakDeferralMs": 129600000
}
```

Send to:

```text
POST http://localhost:19778/tools/cognition_config
```

`cognition_config` settings are:

| Setting | Purpose |
| --- | --- |
| `innerVoiceProvider` | Provider used by `ask_inner_voice`; `null` unpins. |
| `dreamRankerProvider` | Provider used to score fact/skill matches in `dream_time`; `null` unpins. |
| `dreamMergerProvider` | Provider used to merge facts into skill text in `dream_time`; `null` unpins. |
| `strongThreshold` | Score needed to merge a fact into a skill. Default `0.75`. |
| `weakThreshold` | Score needed to defer a weak match. Default `0.5`. Must be <= `strongThreshold`. |
| `maxClusterSize` | Maximum facts merged in one pass. Default `5`. |
| `blocklist` | Skill names excluded from dream-time routing. Default `["Inner voice"]`. |
| `weakDeferralMs` | Milliseconds before weakly matched facts are reconsidered. Default 36 hours. |

The repository contains `startDreamTimeScheduler`, which waits 60 seconds after
startup and then runs `dream_time` every hour. In the current active plugin
configuration, the persistent store and manual `dream_time` tool are active, but
the default `matbot.yaml` does not load the `background` plugin and cognition
does not call `startDreamTimeScheduler` during setup. To run consolidation on an
actual persistent hourly schedule, either add a background schedule that invokes
`dream_time`, or wire `startDreamTimeScheduler(services)` into the cognition
plugin lifecycle and stop it during teardown.

## Memory And Retrieval

Cortex has several related but distinct retrieval layers.

### Memory ("remember my name")

The `cognition` plugin's `remember_fact` tool captures durable user facts into
the `remembered_facts` store. The automatic trigger for this lives in the
combination of `skills`, `triggers`, and `cognition`: the trigger notices
messages that look memory-worthy, then invokes `remember_fact` as a silent side
effect. The model does not need to reply with a tool result for the fact to be
stored.

Example user messages that should become durable facts:

```text
Memorize my name: Maciej Zagozda
Remember that I prefer PowerShell on Windows
My Siemens docs are in C:\Projects\Siemens\docs
```

For the name example, the intended path is:

1. The user asks Cortex to memorize the name.
2. `triggers` classifies the message as matching the memory trigger.
3. `remember_fact` extracts the actual fact: `The user's name is Maciej Zagozda.`
4. The fact is written to `remembered_facts` with session/message provenance.
5. A later conversation can retrieve it through `contextual_search`.

Recall and storage are separate. A fact can be correctly stored but not appear
in an answer if the model does not call retrieval or if the needed memory context
is not injected. This is why `contextual_search` now searches raw
`remembered_facts` directly instead of waiting for `dream_time`.

`dream_time` is slower consolidation, not immediate recall. It processes
unassigned remembered facts and, when a fact strongly matches a skill, merges it
into skill markdown so it becomes part of the long-term skills/knowledge layer.

The default provider was changed to `gpt-4o` because weaker models previously
produced spurious refusals such as "I can't store personal information" even
when the user explicitly asked Cortex to remember a harmless name. The extraction
prompt in `packages/plugins/cognition/src/remember/tool.ts` is tuned so explicit
"remember" or "memorize" requests store the fact, not the instruction.

If name recall fails, inspect the store directly with
`remembered_facts_action`. If the fact exists there, the storage side worked and
the issue is retrieval/injection/model behavior. If it does not exist, check
that `skills`, `triggers`, and `cognition` are loaded in the active workspace.

### `remembered_facts`

`remembered_facts` is the raw durable memory store written by `remember_fact`.
It is best for facts explicitly worth remembering, such as names, stable
preferences, decisions, project facts, and reusable troubleshooting outcomes.

Document shape:

```ts
interface RememberedFact {
  id: string;
  version: string;
  fact: string;
  sessionId: string;
  messageId: string;
  createdAt: string;
  dreamSkill?: string;
  ignoreUntil?: string;
}
```

Explore remembered facts from PowerShell:

```powershell
$body = @{
  action = "query"
  query = @{
    limit = 50
    sort = @(@{ field = "createdAt"; dir = "desc" })
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:19778/tools/remembered_facts_action `
  -ContentType "application/json" `
  -Body $body |
  ConvertTo-Json -Depth 8
```

Search by substring:

```json
{
  "action": "query",
  "query": {
    "where": {
      "op": "stringContains",
      "field": "fact",
      "value": "Maciej"
    },
    "limit": 10
  }
}
```

Read one fact:

```json
{
  "action": "get",
  "id": "remembered-fact-id"
}
```

Create or replace manually:

```json
{
  "action": "set",
  "data": {
    "fact": "The user's preferred shell on Windows is PowerShell.",
    "sessionId": "manual",
    "messageId": "manual",
    "createdAt": "2026-06-28T00:00:00.000Z"
  }
}
```

Correct safely with compare-and-swap:

```json
{
  "action": "cas",
  "id": "remembered-fact-id",
  "expected": "version-from-get",
  "data": {
    "fact": "The user's name is Maciej Zagozda.",
    "sessionId": "original-session-id",
    "messageId": "original-message-id",
    "createdAt": "2026-06-28T06:12:37.262Z"
  }
}
```

Delete:

```json
{
  "action": "delete",
  "id": "remembered-fact-id",
  "expected": "version-from-get"
}
```

Omit `expected` only when you intentionally want an unconditional delete.

### `KnowledgeIndex`

`KnowledgeIndex` is the runtime retrieval service interface used by plugins.
In this repository, `hybrid-knowledge-index` registers an implementation that
queries Mem0 and file-index, ranks results, and deduplicates them.

Skills also mirror saved skill content into the active `KnowledgeIndex`.
`KnowledgeIndex` is not the same as `remembered_facts`: facts are stored raw in
`remembered_facts`; skills and indexed entries are searched through
`KnowledgeIndex`; `contextual_search` bridges both.

### Workspace RAG Retrieval

Workspace RAG is scoped to the active Cortex workspace and its active RAG
context. It is file-backed markdown retrieval with per-workspace persistence.
It injects relevant snippets automatically before each model turn and can also
be queried by `workspace_rag` and `contextual_search`.

### `contextual_search` Retrieval

Use `contextual_search` when the model needs local context before answering. It
searches remembered facts, the active `KnowledgeIndex`, and workspace RAG. This
is why a remembered name can be found before `dream_time` has merged that fact
into a skill.

### `memory-policy.json`

`local-agent\config\memory-policy.json` documents what Cortex should treat as
durable memory:

- durable kinds: `preference`, `decision`, `project-fact`,
  `troubleshooting-outcome`, `domain-term`, `implementation-note`;
- do not store: raw file content, secrets, temporary command output, large logs,
  duplicate index content;
- promotion requires: explicit user request, stable fact, reusable decision, or
  confirmed recurring solution.

It is a policy file for humans and future automation. The active memory tools
still enforce their own schemas and prompts.

## Expert Panel WebUI User Manual

The Expert Panel lets one user question be answered from several configured
perspectives, such as design, finance, and engineering. It is useful when a
decision has tradeoffs and a single assistant answer would flatten the problem.

The panel is integrated into the normal chat composer. You do not type into a
separate expert form. You choose the expert settings, type the question in the
main chat box, and send it normally.

### Where To Find It

Open the WebUI at `http://localhost:19778`. At the bottom composer, the top row
contains:

- `Model:` selector: chooses the normal chat model/provider.
- `Experts` selector: opens the expert-panel settings popup.

When the expert panel is enabled, the selector changes from `Experts` to
`Experts on`. This is the quick visual cue that the next message will run
through the panel instead of normal chat.

### Expert Popup Controls

Click `Experts` to open the popup. The popup contains these controls:

| Control | What it does |
| --- | --- |
| `Use experts` | Turns expert-panel mode on for the next submitted chat question. If unchecked, the chat behaves normally. |
| `All experts` | Runs every configured expert. In the default setup this means Design, Finance, and Engineering. |
| Individual expert checkboxes | Lets you run only selected experts. These appear under `Selection` when experts are available. |
| `Mode` | Controls how each expert should frame the answer: `Parallel`, `Review`, or `Debate`. |
| `Synthesize decision` | When checked, runs a final orchestration pass that collates expert opinions into a recommendation. |
| Status line | Shows whether experts are unavailable, running, complete, or failed. |

The popup closes when you click outside it. Your selected settings remain in the
composer until changed or until the page is refreshed.

### Running The Whole Panel

Use this when you want all available perspectives.

1. Click `Experts`.
2. Check `Use experts`.
3. Leave `All experts` checked.
4. Choose a `Mode`.
5. Leave `Synthesize decision` checked if you want a final recommendation.
6. Type your question in the main chat box.
7. Click the send button.

The user message shown in the transcript includes a short summary such as:

```text
Expert panel (review)
Experts: all
Synthesize decision: yes

Should we ship this feature?
```

That summary is intentional. It records which panel settings were used for that
turn. The summary is stored as the user message for the expert-panel turn, so it
survives reloads and remains available as context for later normal chat turns.

### Running Selected Experts

Use this when only some perspectives are relevant.

1. Click `Experts`.
2. Check `Use experts`.
3. Uncheck `All experts`.
4. Check the individual experts you want, for example `Design Expert` and
   `Engineering Expert`.
5. Choose a `Mode`.
6. Choose whether to synthesize.
7. Type the question in the main chat box and send.

If `All experts` is unchecked and no individual expert is selected, Cortex shows
an error in the expert popup and does not run the panel.

### Choosing A Mode

| Mode | Best for | Behavior |
| --- | --- | --- |
| `Parallel` | Broad perspective gathering. | Each expert answers independently from its own viewpoint. |
| `Review` | Critiquing a proposal, implementation, or plan. | Experts look for strengths, risks, omissions, and practical concerns. |
| `Debate` | Surfacing disagreement and tradeoffs. | Experts emphasize where their priorities conflict and what would change their recommendation. |

The `Mode` dropdown uses the same compact selector design as the model selector.

### Synthesis

`Synthesize decision` controls whether Cortex asks an orchestrating agent to
collate the expert outputs.

When synthesis is enabled, the final answer includes:

- each expert's opinion;
- citations for files retrieved for each expert;
- a synthesis section with consensus, disagreement, risks, assumptions, and a
  final recommendation.

When synthesis is disabled, Cortex returns only the selected expert opinions.
This is useful when you want to compare raw perspectives yourself.

### Reading The Result

The answer is rendered in the normal chat transcript. A typical expert-panel
answer has:

- one heading per expert, such as `Design Expert`, `Finance Expert`, or
  `Engineering Expert`;
- each expert's grounded answer;
- citations listing expert-specific source files when relevant;
- an optional `Synthesis` section.

The status line in the popup changes to `Complete.` after a successful run.
The panel answer is stored as a normal assistant message in the active session.
Reloading the WebUI re-renders the same expert-panel turn from session history.

### Model Selector And Expert Providers

The `Model:` selector still controls normal chat. Expert panel execution has two
provider layers:

- Individual experts use the provider configured for that expert in
  `local-agent\config\experts.json`. If an expert has no provider, Cortex falls
  back to the current turn provider or the expert panel default provider.
- The synthesis pass uses the current turn provider when available, falling back
  to the expert panel default provider.

This means changing the WebUI `Model:` selector can affect synthesis and fallback
behavior, but it does not directly rewrite each expert's configured provider.

### Knowledge And Citations

Each expert has its own knowledge roots. In the default setup:

- Design knowledge lives under `local-agent\knowledge\design`.
- Finance knowledge lives under `local-agent\knowledge\finance`.
- Engineering knowledge lives under `local-agent\knowledge\engineering`.

When the panel runs, each expert searches only its own configured files. That
keeps perspectives separated. For example, the Design Expert does not retrieve
from the Finance Expert's knowledge root unless both experts are explicitly
configured to share a root.

Supported expert knowledge file extensions are `.md`, `.mdx`, `.txt`, `.json`,
`.csv`, `.tsv`, `.yaml`, and `.yml`. Files larger than 1 MB are skipped.

### Common User Problems

`expert_panel plugin unavailable.`

The active workspace did not load `./plugins/expert-panel`, or the browser is
connected to an old WebUI process. Restart Cortex:

```powershell
.\scripts\run.ps1
```

Then hard-refresh the browser and open the `Experts` selector again.

`No experts configured.`

The plugin loaded, but `local-agent\config\experts.json` is missing, invalid, or
contains no experts.

The panel runs but citations are empty.

The selected expert's knowledge roots did not contain matching text for the
question, the files are unsupported, or the files are larger than the 1 MB expert
retrieval limit. The expert can still answer from its system prompt, but it will
have less grounding.

The wrong experts were used.

Check whether `All experts` is still selected. If it is checked, individual
checkboxes are treated as all selected. Uncheck `All experts` before selecting a
subset.

### Implementation Workflow

Internally, the expert panel is deliberately tool-based. It does not spin up
separate chatbot processes.

Flow:

1. The WebUI submits a forced expert-panel turn to
   `POST /sessions/:id/expert-panel`.
2. The web frontend persists the panel settings summary as a normal user
   message in the active session and emits it through the session event stream.
3. The server calls the `expert_panel` tool with the question, selected panel
   options, current provider, and real session context.
4. The plugin selects requested experts or all configured experts.
5. Each expert retrieves text snippets from its own configured roots.
6. Each expert receives an independent `services.singleTurn(...)` call with its
   system prompt, question, and expert-scoped citations.
7. If `synthesize` is `true`, a final orchestrator call collates consensus,
   disagreement, assumptions, risks, and recommendation.
8. The formatted panel result is persisted as a normal assistant message and
   rendered from the same session transcript used by ordinary chat.

This keeps design, finance, and engineering knowledge isolated while still
running inside one Matbot process.

### Adding Or Changing Experts

Add an expert by editing `local-agent\config\experts.json`:

```json
{
  "id": "security",
  "title": "Security Expert",
  "description": "Threat modeling, privacy, auth, and operational security.",
  "provider": "openai",
  "roots": ["../knowledge/security"],
  "tags": ["security", "privacy"],
  "systemPrompt": "You are the Security Expert..."
}
```

Then add text files:

```powershell
mkdir local-agent\knowledge\security
```

Restart Cortex:

```powershell
.\scripts\run.ps1
```

The new expert appears in the WebUI after restart. Open the `Experts` selector
and verify it appears under `Selection`.

## WebUI

The WebUI is served by the frontend web plugin at `http://localhost:19778`.

Current UI capabilities include:

- conversation list and session controls;
- provider selector;
- main chat composer with send/stop behavior;
- token and elapsed-time summaries per turn;
- workspace file upload/list/delete;
- plugin catalog display;
- skill editor;
- workspace selector in the bottom-left corner;
- workspace creation, rename, and switch;
- full-page workspace settings editor for RAG context name and markdown folders;
- RAG ingestion progress, including current file;
- expert panel controls integrated into the main composer;
- mobile sidebar behavior.

The WebUI uses the same Matbot tool APIs as the model. When the UI says a plugin
is unavailable, the active Matbot process usually does not have that plugin
loaded. Restart with:

```powershell
.\scripts\run.ps1
```

Then hard-refresh the browser.

## Testing

The repository has two test layers:

- Node tests in `tests\*.test.mjs` for backend/runtime behavior.
- Playwright WebUI tests in `tests\webui\matbot-webui.spec.mjs` for browser
  interactions against the real static WebUI and a fake Matbot server.

Run the complete suite before treating a change as verified:

```powershell
npm run test:all
```

Run only the Node tests:

```powershell
npm test
```

Run the complete Playwright WebUI suite:

```powershell
npm run test:webui
```

First Playwright setup on a machine:

```powershell
npx playwright install chromium
```

Useful Playwright variants:

```powershell
# Desktop WebUI project only
npm run test:webui -- --project chromium

# Mobile WebUI project only
npm run test:webui -- --project mobile-chromium

# Run tests whose title matches a feature area
npm run test:webui -- --grep "workspace RAG"

# Debug a Playwright run locally
npm run test:webui -- --project chromium --headed --debug
```

The Playwright config starts `tests\webui\harness.mjs` on
`http://127.0.0.1:19787` and serves the same static frontend files used by the
Node WebUI. The harness implements fake Matbot transport endpoints for sessions,
tools, workspaces, files, plugins, skills, remembered facts, experts, and
workspace RAG. It validates WebUI behavior without calling real providers,
spending model tokens, writing production memory stores, or touching live RAG
databases.

Traces are retained on failure. Inspect a failing trace with:

```powershell
npx playwright show-trace <path-to-trace.zip>
```

Current Playwright coverage includes:

- shell load, providers, conversations, files, plugins, and skills;
- compatible plugin activation/deactivation and incompatible plugin display;
- workspace selector create/rename/switch;
- workspace RAG settings save and ingestion progress display;
- remembered facts persisting across conversations;
- `contextual_search` retrieval from remembered facts plus workspace RAG context;
- workspace RAG retrieval during conversation;
- expert panel all-expert and selected-expert composer flows;
- streaming output, tools, usage, and elapsed-time summary;
- interactive prompt controls;
- workspace file upload/delete;
- skill editor metadata and trigger controls;
- session rename/hide/mark controls;
- send/stop busy behavior;
- mobile sidebar behavior.

Node tests cover:

- file-index storage and search;
- file-broker policy and write backups;
- hybrid KnowledgeIndex ranking/deduplication;
- expert-panel plugin behavior and isolated retrieval;
- workspace-rag runtime ingestion flow.

## Troubleshooting

### Provider Does Not Appear

Provider options come from the active workspace's `matbot.yaml`. If you edited
the default `matbot.yaml` but the UI is running another workspace, switch to the
default workspace or edit that workspace's own config under
`local-agent\matbot\workspaces\<id>\matbot.yaml`.

Restart after config changes:

```powershell
.\scripts\run.ps1
```

Hard-refresh the browser if the old provider list is cached.

### Old WebUI Appears After Running `run.ps1`

`run.ps1` restarts the WebUI by default. If an old process remains, check for a
different port or a browser tab using cached assets. Run:

```powershell
.\scripts\stop-local-agent.ps1
.\scripts\run.ps1
```

Then hard-refresh the browser.

### `workspace_rag plugin unavailable`

The active Matbot process did not load `./packages/plugins/workspace-rag`.
Check the active workspace's `matbot.yaml`, restart Cortex, and verify the plugin
appears in the WebUI plugin list.

### `expert_panel plugin unavailable`

The active Matbot process did not load `./plugins/expert-panel`, or the browser
is connected to an older WebUI process. Restart Cortex and check
`local-agent\logs\matbot.err.log` for plugin load errors.

### Remembered Name Is Not Recalled

Name recall needs all of these to work:

1. `skills`, `triggers`, and `cognition` are loaded.
2. `remember_fact` fires and writes to `remembered_facts`.
3. A later turn calls `contextual_search`, or the provider receives enough
   context to use remembered facts.

Inspect the store directly with `remembered_facts_action` if recall fails.

### RAG Indexed Fewer Files Than Expected

Workspace RAG indexes only files with the `.md` extension under configured paths.
The indexed count reflects successfully scanned/read markdown documents in the
active RAG context. Check:

- `workspace_rag` status;
- configured `paths` in `cortex-rag.json`;
- whether files are below accessible folders;
- file permissions;
- whether the process has restarted after configuration changes;
- `local-agent\logs\matbot.err.log`.

### Mem0 Startup Errors

If Mem0 fails after rotating passwords, recreate Docker volumes because Postgres
and Neo4j keep first-run credentials in their volumes:

```powershell
docker compose -f local-agent\docker\mem0\docker-compose.yml down -v
.\scripts\run.ps1
```

## Safety Defaults

- Secrets are gitignored and should stay out of commits.
- File-broker only writes inside configured read-write roots.
- File-broker creates backups and diffs for overwrites.
- Security policy blocks sensitive path fragments and marks high-risk extensions.
- File-index skips likely secrets and excludes common generated directories.
- Workspace RAG indexes markdown only and stores per-workspace data locally.
- Expert knowledge roots are isolated by expert id.
- Playwright tests use a fake Matbot harness and do not spend model tokens.
