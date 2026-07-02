# Plugins And Tools

> Part of the [Cortex Local Agent documentation](../README.md).

The active default plugin list is in `local-agent\matbot\matbot.yaml`.

| Plugin | Role | Main user-facing tools/services |
| --- | --- | --- |
| `./packages/plugins/providers/openai-compat` | OpenAI-compatible provider adapter. | Provider profiles in the UI selector. |
| `./packages/plugins/sessions` | Persistent sessions and conversation metadata. | Conversation list, rename/hide/pin-style session actions. |
| `./plugins/hybrid-knowledge-index` | Registers Matbot `KnowledgeIndex` backed by Mem0 and file-index. | Service consumed by retrieval tools. |
| `./plugins/file-broker` | Client for the local file-broker HTTP service. | `file_broker_action`. |
| `./packages/plugins/source-registry` | Source provenance, freshness, health, citation policy, source events, and health reports. | `SourceRegistry`, `source_action`, `source_health_action`. |
| `./packages/plugins/connector-fabric` | Connector records, grants, health, tool bindings, and audit events for connector-backed tools. | `ConnectorRegistry`, `connector_action`, connector policy/audit hooks. |
| `./packages/plugins/structured-data` | Governed structured data catalog, semantic SQL planning, read-only Postgres execution, and query result provenance. | `DataCatalog`, `SqlPlanner`, `structured_data_action`. |
| `./packages/plugins/workflow-governance` | Governed workflow definitions, event-sourced run ledger, approval gates, shadow labels/comparisons, and workflow-scoped connector policy. | `WorkflowRegistry`, `WorkflowRunner`, `workflow_action`, workflow policy/audit hooks. |
| `./packages/plugins/workspace-rag` | Workspace-scoped markdown RAG. | `workspace_rag`, automatic per-turn RAG context. |
| `./packages/plugins/skills` | Persistent markdown skills/playbooks. | `skill_action`, skill editor UI. |
| `./packages/plugins/triggers` | Data-driven automatic tool triggers. | Trigger management and automatic `remember_fact` firing. |
| `./packages/plugins/rumsfeld` | Context lookup tool. | `contextual_search`. |
| `./packages/plugins/cognition` | Durable memory, inner voice, dream-time stores/tools. | `remember_fact`, `remembered_facts_action`, `dream_time`, `dream_runs_action`, `ask_inner_voice`, `cognition_config`. |
| `./packages/plugins/memory-browser` | Standalone local browser for remembered facts. | `open_memory_browser`, browser UI on `http://127.0.0.1:19779`. |
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

## Adding Plugins At Runtime

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

## `powershell`

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

## `file_broker_action`

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

## `workspace_action`

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

## `skill_action`

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

## `contextual_search`

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

## `expert_panel` Tool

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

## Cognition Tools

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
