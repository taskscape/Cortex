# Architecture And Core Systems

> Part of the [Cortex Local Agent documentation](../README.md).

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
| Source/provenance layer | Tracks durable source ids, source versions, freshness, health, citation policy, and source access events. | `source-registry`, `source_action`, `SourceRegistry` |
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
2. It starts file-index, file-broker, and the Mem0/Postgres/Neo4j Docker stack unless skipped.
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
| Source registry records, versions, health events, and access events | One Cortex workspace through Matbot stores | `sources`, `source_versions`, `source_health_events`, `source_access_events` |
| Workspace RAG config | One Cortex workspace | that workspace's `cortex-rag.json` |
| Workspace RAG vectors/metadata/chunks | Cortex local Docker stack | Postgres/pgvector schema and tables |
| Workspace RAG JSON fallback | One Cortex workspace | `.data\workspace-rag\index.json` |
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
| Retrieval/access plugins | `hybrid-knowledge-index`, `file-broker`, `source-registry`, `connector-fabric`, `workspace-rag`, `rumsfeld`, `expert-panel` | Provide context, grounded answers, source provenance, connector policy/audit, and policy-aware host-file access. |
| Host/UI plugins | `frontend/web`, `providers/openai-compat` | Connect the runtime to users and models. |

Bundled plugins may exist in the tree without being active. They become active
only when listed in the active workspace's `matbot.yaml`. That distinction is
important when debugging errors like `workspace_rag plugin unavailable`: the code
can exist on disk while the running workspace did not load it.

### Strategic Architecture Progress

The implementation roadmap in `strategic_architecture.md` is being delivered as
ordered, committable slices. Completed build-sequence items:

| Item | Status | Implemented behavior |
| --- | --- | --- |
| Source Registry MVP | Complete | `source-registry` registers `SourceRegistry` and `source_action`; sources have stable ids, versions, freshness state, health state, citation policy, health events, and access events; workspace RAG writes source records for indexed markdown and derived knowledge entries; workspace RAG retrieval hits include source ids, health/freshness state, and citation text. |
| Connector Fabric MVP | Complete | `connector-fabric` registers `ConnectorRegistry` and `connector_action`; it seeds local connector definitions/instances for source registry, workspace RAG, file broker, MCP, and Postgres read-only; action-aware tool bindings classify read/write/admin calls; `toolcall` hooks enforce connector grants before bound tools run; `toolresult` hooks write connector audit events and redact configured sensitive fields. |

Remaining strategic architecture items still build on this foundation: source
health monitor primitives beyond workspace RAG, structured data reasoning,
workflow run ledger, automation shadow mode, context graph, workflow compiler,
and enterprise expert-panel review records.

### Source Registry

The source registry is Cortex's first strategic architecture primitive. It gives
retrieval and future automation a stable source identity layer instead of relying
only on matched text or file paths.

The `source-registry` plugin registers:

- `SourceRegistry`: a service for writing and querying source records, source
  versions, health events, access events, and citation metadata.
- `source_action`: a model/UI-facing inspection tool with `list`, `get`,
  `health`, `stale`, `citation`, and `events` actions.

Workspace RAG is the first producer. During markdown ingestion it creates:

- one source record per markdown file, keyed by workspace, connector type, and
  normalized context path;
- one source version per content hash;
- health events for successful reads, read failures, and sources that disappear
  from configured markdown paths.

Workspace RAG retrieval then enriches hits with source id, source health,
freshness, and citation text. The per-turn screen hook includes that metadata in
the injected RAG context and in durable marker data, so a later audit can connect
an answer back to the exact source registry record.

### Connector Fabric

The connector fabric is Cortex's policy and audit layer around tools that read
or write governed systems. The MVP is store-backed and local-first: it records
connector definitions, connector instances, grants, tool bindings, sync cursors,
health events, and audit events.

The `connector-fabric` plugin registers:

- `ConnectorRegistry`: a service for connector metadata, grants, health, sync
  cursors, policy evaluation, and audit event writes.
- `connector_action`: an inspection/admin tool with `list`, `get`,
  `list_tools`, `grants`, `set_grant`, `set_sync`, `health`, `test_health`, and
  `list_audit` actions.
- `toolcall` and `toolresult` hooks. The `toolcall` hook rejects connector-bound
  tool calls when no active grant allows the effective principal, tool, action,
  capability, and approval policy. The `toolresult` hook records allowed/error
  audit events, extracts returned source ids, hashes input/result payloads, and
  redacts configured sensitive result fields before they are persisted or shown
  to the model.

The seeded local bindings cover the current Cortex data tools:

| Connector instance | Bound tools | Capability handling |
| --- | --- | --- |
| Local Source Registry | `source_action` | Read-only source provenance inspection. |
| Local Workspace RAG | `workspace_rag` | `status`, `get_config`, and `search` are read; configuration actions are write; `reindex_now` is admin. |
| Local File Broker | `file_broker_action` | `health`, `list`, and `read` are read; `write` is write and redacts returned `content`. |
| Local MCP Fabric | `mcp_action`, `mcp__*` | MCP server list is read; add/remove and delegated MCP tools are admin until per-server metadata exists. |
| Local Postgres Read-Only | connector record only | Reserved for the structured-data reasoning SQL tool; executable query support lands in that later build slice. |

The CLI inserts `connector-fabric` into each Cortex workspace before
`workspace-rag`, preserving existing local behavior through wildcard bootstrap
grants while still allowing explicit per-principal deny grants for tests,
operators, and future UI policy controls.

### Memory System

Cortex memory is not a single bucket. It is several layers with different jobs:

| Layer | What it stores | Main tool/service |
| --- | --- | --- |
| Session history | The active conversation and previous conversations. | `sessions` |
| Remembered facts | Explicit durable facts such as names, preferences, and project facts. | `remember_fact`, `remembered_facts_action` |
| Skills | Reusable markdown playbooks and long-term operating knowledge. | `skill_action` |
| KnowledgeIndex | Search interface over skills, Mem0, and file-index results. | `KnowledgeIndex` service |
| Workspace RAG | Markdown files configured for the current workspace. | `workspace_rag` |
| Source registry | Source identity, freshness, health, citations, and retrieval provenance. | `SourceRegistry`, `source_action` |
| Connector fabric | Connector identity, grants, health, sync cursors, and tool-call audit. | `ConnectorRegistry`, `connector_action` |
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
That is why direct inspection through `remembered_facts_action` is documented in
[Memory and Retrieval](memory-and-retrieval.md).

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
- workspace RAG folders and Postgres/pgvector index data.

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
| Source registry | One Cortex workspace | Stable source ids, versions, freshness, health, citations, and retrieval provenance. | `source-registry` |
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
