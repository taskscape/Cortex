# Matbot Local Agent Scaffold

This repository implements a Windows-native local assistant scaffold based on the supplied specification.

Implemented components:

- `local-agent/file-index`: JSON-backed local file index with keyword search, path metadata, hash tracking, exclusion rules and likely-secret skipping.
- `local-agent/file-broker`: policy-aware file access service for directory listing, text reads and approved writes with diffs and backups.
- `local-agent/matbot/plugins/hybrid-knowledge-index`: Matbot-compatible `KnowledgeIndex` plugin that queries Mem0 and the local file index, then ranks and deduplicates results.
- `local-agent/docker/mem0`: Docker Compose stack for Mem0 API dependencies and the Mem0 API endpoint.
- `scripts`: setup, start, stop and health-check PowerShell scripts.

PROJECTMEM is intentionally not integrated.

## Secrets and credentials

The Mem0 stack requires several secrets that are **not** stored in the repository. They
are kept as User-scoped environment variables and mirrored into a gitignored
`local-agent\docker\mem0\.env` file that Docker Compose reads:

| Variable | Purpose | Source |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI access for Mem0 / verification | Supplied by you |
| `POSTGRES_PASSWORD` | Postgres (pgvector) password | Generated |
| `NEO4J_PASSWORD` | Neo4j password | Generated |
| `NEO4J_AUTH` | `neo4j/<NEO4J_PASSWORD>` for the Neo4j container | Generated |
| `MEM0_API_KEY` | Mem0 API auth key | Generated |

Generate the passwords and store everything (one-time, before the first launch):

```powershell
.\scripts\setup-secrets.ps1 -OpenAiKey "<your-openai-key>"
```

This generates strong random passwords, sets all of the variables above at the User
scope, and writes `local-agent\docker\mem0\.env`. Re-run with `-Force` to rotate the
generated passwords. After it runs, **open a new terminal** so the User-scoped variables
are visible to subsequent commands.

Notes:
- `.env` and the real secret values are gitignored and must never be committed.
  `local-agent\docker\mem0\.env.example` is the committed placeholder template.
- `docker-compose.yml` now reads `POSTGRES_PASSWORD`, `NEO4J_PASSWORD`, `NEO4J_AUTH`
  and the Mem0 settings from the environment / `.env`; it fails fast if a required
  secret is missing.
- The Postgres and Neo4j passwords are baked into their data volumes on first run.
  If you rotate them after the stack has already started once, recreate the volumes:
  `docker compose -f local-agent\docker\mem0\docker-compose.yml down -v`.

## Commands

Install/build if needed, start services, check health, and open the Cortex WebUI:

```powershell
.\scripts\run.ps1
```

`run.ps1` restarts the Matbot WebUI process on the selected port by default so plugin,
configuration, and WebUI changes are picked up. Pass `-NoRestartMatbot` only when you
explicitly want to reuse an already-running WebUI process.

Install and build:

```powershell
.\scripts\setup-local-agent.ps1
```

Start local services:

```powershell
.\scripts\start-local-agent.ps1
```

Check service health:

```powershell
.\scripts\health-check.ps1
```

Stop services:

```powershell
.\scripts\stop-local-agent.ps1
```

Run tests:

```powershell
npm test
```

Run WebUI tests:

```powershell
# First time on a machine, install the Playwright Chromium browser:
npx playwright install chromium

npm run test:webui
```

Run the complete local test set:

```powershell
npm run test:all
```

Verify the configured OpenAI key (read from the `OPENAI_API_KEY` environment variable,
or `specification.md` if present) without printing it:

```powershell
npm run verify:openai
```

## Requirements

- **Node.js 20+** (provides `node` / `npm`) — required for the build, the file-index and
  file-broker services, `npm test`, and `npm run verify:openai`.
- **Docker Desktop** with WSL2 — required for the Mem0 stack (Postgres, Neo4j, Mem0 API).
- The Mem0 API image (`mem0/mem0-api-server`) is currently published **only for
  `linux/arm64`**. On `amd64` hosts the `mem0-api` service runs under Docker Desktop's
  QEMU emulation via `platform: linux/arm64` in `docker-compose.yml` (no extra setup;
  emulation ships with Docker Desktop). It also requires `OPENAI_API_KEY`, which is
  supplied through the gitignored `.env` (see *Secrets and credentials*).
- The upstream Mem0 image has two gaps that are patched locally, so the first launch
  **builds a small derived image** (`Dockerfile.mem0-api`):
  - it lacks the `psycopg` driver its pgvector store needs — the Dockerfile installs it;
  - its history DB path (`/app/history/history.db`) has no directory — a `mem0-history`
    volume provides and persists it.
  The first `docker compose ... up` therefore builds this image (a few minutes under
  emulation); subsequent launches reuse it.

## Endpoints

- File index: `http://localhost:8877`
- File broker: `http://localhost:8878`
- Mem0 API: `http://localhost:8888`
- Matbot web UI: `http://localhost:19778` (when the front-end is running — see below)

## Matbot front-end (web UI)

The Matbot agent runtime lives in `local-agent/matbot` (a separate pnpm monorepo). It is
wired to this project via the `hybrid-knowledge-index` plugin (Mem0 + the local file
index) and configured with selectable OpenAI-compatible providers.

One-time setup:

```powershell
# pnpm is required (Node already provides corepack/npm):
npm install -g pnpm@9
cd local-agent\matbot
pnpm install
```

Configuration (already created, both gitignored):

- `local-agent/matbot/matbot.yaml` — defines the `openai` provider (`gpt-4o`, key via
  `${OPENAI_API_KEY}`), the local `Local` provider (`qwen3-coder-next-256k` via
  `http://100.122.2.99:11435/v1`), and loads the plugin stack:
  `hybrid-knowledge-index` (Mem0 + file
  index), `workspace-rag` (per-workspace markdown RAG), `skills`, `triggers`,
  `rumsfeld` (`contextual_search`), `cognition` (`remember_fact` memory),
  `workspace` (file management), `expert-panel` (`expert_panel` multi-expert
  orchestration), and `frontend/web`.
- `local-agent/matbot/.env` — the Matbot Vault secrets: `OPENAI_API_KEY` plus the
  `MEM0_BASE_URL` / `FILE_INDEX_BASE_URL` / `FILE_BROKER_BASE_URL` the hybrid plugin uses.
- `local-agent/config/matbot.expert-panel.example.yaml` — a tracked reference config that
  mirrors the local gitignored `local-agent/matbot/matbot.yaml` plugin stack.

### Cortex workspaces

Cortex can run as separate named workspaces. A workspace is selected before the Matbot
runtime boots, so each workspace gets its own configuration, provider/model list, plugin
list, Vault `.env`, sessions, workspace files, memories, remembered facts, knowledge stores,
and any storage-backend data rooted under `.data`.

The workspace registry is persisted at:

```text
local-agent/matbot/cortex-workspaces.json
```

If the file does not exist, startup creates it with a `default` workspace pointing at the
current `local-agent/matbot/matbot.yaml`. That means existing installations become the
default workspace, and new deployments always start with a default workspace.

New workspaces created from the WebUI are stored under:

```text
local-agent/matbot/workspaces/<workspace-id>/
```

Each generated workspace contains:

- `matbot.yaml` — copied from the default config with local plugin/provider paths converted
  to absolute paths so the workspace can load the same local plugins from its own directory.
- `.env` — copied from `local-agent/matbot/.env` if it exists, so the new workspace starts
  with the same secrets but can then be changed independently.
- `.data\` — created lazily by the runtime for that workspace's sessions, files, memories,
  remembered facts, skills, and plugin stores.

The WebUI selector is in the bottom-left sidebar. Use it to switch workspaces, create a new
workspace, or rename the active workspace. Switching writes the new active workspace to
`cortex-workspaces.json`, restarts the local Matbot server against that workspace's config,
and reloads the page. This restart is intentional: providers, plugins, vaults, storage
backends, and session runners are boot-scoped.

The registry format is:

```json
{
  "active": "default",
  "workspaces": [
    {
      "id": "default",
      "name": "Default",
      "configPath": "matbot.yaml",
      "createdAt": "2026-06-28T00:00:00.000Z",
      "updatedAt": "2026-06-28T00:00:00.000Z"
    }
  ]
}
```

`configPath` is resolved relative to `cortex-workspaces.json`. Advanced users can add a
workspace manually by creating a workspace directory, writing a `matbot.yaml`, and adding a
record to the registry. Set `CORTEX_WORKSPACE_ID=<id>` before startup to force a workspace
for that process; set `CORTEX_WORKSPACES_FILE=<path>` to use a different registry file.

Start the backend stack and the local-agent services first (see *Commands*), then launch
the front-end:

```powershell
cd local-agent\matbot
pnpm start          # headless server mode; hosts the web frontend
```

It prints `[frontend-web] http://localhost:19778` — **open that URL in your browser**.
(Override the port with `MATBOT_WEB_PORT`.) For a terminal UI instead, use `pnpm repl`.

Notes:
- The `hybrid-knowledge-index` plugin must expose an `exports` entry in its `package.json`
  and target plugin `apiVersion` `0.1` (Matbot's current API major) — both are set.
- The browser bundle (`pnpm web-build` / `pnpm web-server`) is **not** wired to the local
  services: it runs entirely client-side and cannot reach the Node-only hybrid plugin.

### Memory ("remember my name")

The `cognition` plugin's `remember_fact` tool (plus its auto-trigger, enabled by `skills` +
`triggers`) captures durable user facts into a `remembered_facts` store under
`local-agent/matbot/.data/`. Stating a fact ("My name is …", "Memorize my name: …")
persists it across conversations. `gpt-4o` is used because `gpt-4o-mini` produced spurious
"I can't store personal information" refusals. The extraction prompt in
`packages/plugins/cognition/src/remember/tool.ts` was tuned so an explicit "remember/
memorize my …" request stores the *fact*, not the instruction.

Recall and storage are separate:

- `remember_fact` captures durable facts and writes them to `remembered_facts`.
- `contextual_search` retrieves local context during chat. It now searches both the
  active `KnowledgeIndex` and the raw `remembered_facts` store, so facts such as
  "The user's name is Maciej Zagozda" are available immediately instead of waiting
  for background consolidation.
- `dream_time` is the slower consolidation pass. It processes unassigned remembered
  facts and, when it finds a strong matching skill, merges those facts into skill
  markdown so they become part of the long-term skill/knowledge layer.

### Adding plugins at runtime

`plugin add ./packages/plugins/<name>` loads a local plugin (no install needed). Adding an
**npm-named** plugin runs `pnpm add` at the workspace root, which pnpm blocks by default
(`ERR_PNPM_ADDING_TO_ROOT`); `local-agent/matbot/.npmrc` sets
`ignore-workspace-root-check=true` so that works. Prefer the local `./packages/plugins/…`
path (as returned by `plugin discover_local`) for bundled plugins.

## Configured Matbot plugins

The live Matbot stack is defined in `local-agent/matbot/matbot.yaml`. Plugins are loaded
in order; provider profiles are configured separately under `providers`.

Most examples below are direct tool payloads. In the WebUI you can ask the agent to use
the tool naturally, or call the local tool endpoint while Matbot is running:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:19778/tools/<tool-name> `
  -ContentType "application/json" `
  -Body '<json-payload>'
```

### `./packages/plugins/providers/openai-compat`

The OpenAI-compatible provider adapter backs the configured `openai` and `Local` provider
profiles. `openai` points at OpenAI chat completions, uses `gpt-4o`, and reads the key
from `${OPENAI_API_KEY}`. `Local` points at `http://100.122.2.99:11435/v1`, uses
`qwen3-coder-next-256k`, and does not require an API key in the checked-in config.

Use either profile by selecting it in the WebUI provider selector, or through provider tools:

```json
{
  "action": "list"
}
```

Send that payload to:

```text
POST /tools/provider
```

Provider profiles are ordinary named entries under `providers`:

```yaml
providers:
  Local:
    module: ./packages/plugins/providers/openai-compat
    endpoint: http://100.122.2.99:11435/v1
    model: qwen3-coder-next-256k
    parameters:
      apiUrl: http://100.122.2.99:11435/v1
      maxTokens: 32768
      maxContextTokens: 262144
      maxOutputTokens: 32768
      maxCompletionTokens: 262144
      capabilities:
        tools: true
        images: false
        parallel_tool_calls: false
        prompt_cache_key: false
        chat_completions: true
        interleaved_reasoning: false
```

The adapter accepts either a concrete `/chat/completions` endpoint or an API root such
as `/v1`; API roots are normalized to `/chat/completions` at request time. The request
output limit uses `parameters.maxOutputTokens` when present, otherwise `parameters.maxTokens`.
Capability metadata is preserved and used where it affects chat completions behavior:
`tools: false` suppresses tool definitions, and `parallel_tool_calls` is forwarded when
set.

For local-provider registries that describe several models, `matbot.yaml` can also use
the higher-level format below. On load, each listed model is normalized into a selectable
provider profile. If a group has one model, the provider name is the group name (`Local`);
if it has multiple models, provider names are generated as `<group>-<model-name>`.

```yaml
language_models:
  openai_compatible:
    Local:
      api_url: http://100.122.2.99:11435/v1
      available_models:
        -
          name: qwen3-coder-next-256k
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

Use the native `providers` form when you want direct Matbot control over provider names,
fallbacks, credentials, or per-profile parameters. Use `language_models.openai_compatible`
when copying configuration from another local model registry.

### `./packages/plugins/sessions`

Adds persistent conversation session management. The WebUI uses this for the conversation
list, opening prior conversations, renaming, and hiding sessions.

Examples:

```json
{
  "action": "list"
}
```

```json
{
  "action": "rename",
  "sessionId": "session-id",
  "title": "Architecture review"
}
```

Send those payloads to:

```text
POST /tools/session_action
```

### `./plugins/hybrid-knowledge-index`

Provides Matbot's `KnowledgeIndex` service by querying both Mem0 and the local file index,
then normalizing, ranking, and deduplicating results. It does not expose a direct user tool;
other plugins use it behind the scenes.

`KnowledgeIndex` is the runtime retrieval interface used by Matbot plugins. Producers add
`KnowledgeEntry` documents to it and consumers search it with one or more terms. A
`KnowledgeEntry` contains searchable metadata (`entities`, `tags`, `summary`) plus the
full `content` returned to the model when it needs context. In this repository the active
implementation is hybrid:

- Mem0 stores semantic memories and skill-derived entries.
- The file index searches indexed local text files and returns matching snippets.
- The hybrid plugin queries both sources, merges the result lists, ranks by confidence,
  and deduplicates equivalent entries.

The important boundary: `KnowledgeIndex` is not the same thing as the raw
`remembered_facts` store. Skills are mirrored into `KnowledgeIndex`, Mem0 memories are
searched through it, and file snippets are searched through it. Raw remembered facts are
stored separately by cognition, then are either read directly by `contextual_search` or
later merged into skills by `dream_time`.

Main consumers:

- `rumsfeld`, via `contextual_search`.
- `skills`, for skill metadata/search.
- The model's contextual retrieval flow when it sees an unknown local concept.

Operational dependencies:

- File index: `http://localhost:8877`
- Mem0 API: `http://localhost:8888`
- Environment URLs in `local-agent/matbot/.env`

### `./packages/plugins/workspace-rag`

Adds workspace-scoped markdown RAG for every conversation. The plugin is installed in
`local-agent/matbot/matbot.yaml`, so the default workspace has it and newly created Cortex
workspaces inherit it when their `matbot.yaml` is copied.

What it does:

- Stores each workspace's RAG configuration in `cortex-rag.json` next to that workspace's
  `matbot.yaml`.
- Supports multiple named RAG contexts per workspace. One context is active at a time for
  chat retrieval, while the ingestion manager scans configured markdown folders.
- Monitors the folders listed in each context for `.md` files.
- Chunks markdown, hashes file content, builds a local vector index, and persists it under
  that workspace's `.data\workspace-rag\index.json`.
- Removes deleted markdown files from the index and re-indexes changed files when the
  markdown hash changes.
- Scans every workspace listed in `cortex-workspaces.json`, so ingestion can continue for
  workspaces other than the one currently selected in the UI.
- Injects top matching chunks as ephemeral workspace context before each model turn.
- Exposes `WorkspaceRagManager` so tools such as `contextual_search` can retrieve from the
  workspace RAG index without replacing the existing hybrid `KnowledgeIndex`.

The WebUI exposes RAG configuration in the bottom-left workspace area:

- The workspace selector switches between Cortex workspaces.
- The gear button opens a full-page workspace settings editor for the active RAG context:
  - `Context name` is the human-readable name shown in retrieved context.
  - `Markdown folders` is one absolute local folder path per line. Only `.md` files are indexed.
- `Save` persists the settings and returns to the chat window.
- `Cancel` discards unsaved changes and returns to the chat window.
- When saved markdown folders differ from the previous settings, ingestion is restarted for
  the current workspace immediately. Background ingestion then keeps scanning configured
  folders every minute for changed, added, or deleted markdown files.
- Additional contexts can be created or selected through the `workspace_rag` tool API.

`cortex-rag.json` uses this format:

```json
{
  "activeContextId": "engineering",
  "contexts": [
    {
      "id": "engineering",
      "name": "Engineering Notes",
      "paths": [
        "C:\\Projects\\Cortex\\docs",
        "D:\\Knowledge\\Engineering"
      ]
    },
    {
      "id": "finance",
      "name": "Finance Notes",
      "paths": [
        "D:\\Knowledge\\Finance"
      ]
    }
  ]
}
```

Older files with a single `contextName` and `paths` array still load as the `default`
context and are rewritten in the multi-context format after the next configuration save.

The same operations are available through the `workspace_rag` tool:

```json
{
  "action": "status"
}
```

```json
{
  "action": "create_context",
  "contextName": "Engineering Notes"
}
```

```json
{
  "action": "select_context",
  "contextId": "engineering-notes"
}
```

```json
{
  "action": "configure",
  "contextId": "engineering-notes",
  "contextName": "Engineering Notes",
  "paths": [
    "C:\\Projects\\Cortex\\docs",
    "D:\\Knowledge\\Engineering"
  ]
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
{
  "action": "reindex_now"
}
```

The status response includes `state`, `percent`, `processedFiles`, `totalFiles`,
`nvidiaAvailable`, `accelerated`, and `accelerator`. `nvidiaAvailable` reports whether
`nvidia-smi` is visible on the host. The current built-in vectorizer is CPU-based, so
`accelerated` remains `false` and `accelerator` reports `cpu` unless a future GPU embedding
backend is installed.

### `./packages/plugins/skills`

Adds named markdown playbooks that the assistant can load, apply, edit, and catalogue.
Skills are persisted under Matbot's data directory and can be surfaced by metadata search.
The WebUI skill editor uses this plugin.

Examples:

```json
{
  "action": "list"
}
```

```json
{
  "action": "load",
  "name": "Panel Etiquette"
}
```

```json
{
  "action": "save",
  "name": "Release Checklist",
  "content": "# Release Checklist\nVerify tests, config, logs, and rollback notes.",
  "catalogue": true
}
```

Send those payloads to:

```text
POST /tools/skill_action
```

Skills also expose provider configuration for skill metadata analysis:

```json
{
  "action": "get"
}
```

Send that payload to:

```text
POST /tools/skills_config
```

### `./packages/plugins/triggers`

Adds data-driven hooks that invoke tools when an LLM classifier decides a condition
matches. This project uses triggers with cognition so explicit "remember this" style
messages can call `remember_fact` automatically.

Examples:

```json
{
  "action": "list"
}
```

```json
{
  "action": "add",
  "tool": "skill_action",
  "params": {
    "action": "use",
    "name": "Release Checklist"
  },
  "conditions": [
    {
      "kind": "ephemeral",
      "rule": "MATCH if the user asks for release readiness advice. DO NOT MATCH ordinary implementation questions."
    }
  ]
}
```

Send those payloads to:

```text
POST /tools/trigger_action
```

Trigger classifier configuration:

```json
{
  "action": "get"
}
```

Send that payload to:

```text
POST /tools/triggers_config
```

### `./packages/plugins/rumsfeld`

Adds `contextual_search`, a tool the model can use when the user references an unknown
local concept, project term, preference, personal detail, or entity.

`contextual_search` is the model-facing recall tool. The model should call it before
guessing when the user asks about something local or user-specific: project names,
workspace files, personal preferences, remembered profile details, or domain terms that
are not general internet knowledge.

The tool searches three layers:

- `remembered_facts`, directly. This is the raw durable memory store written by
  `remember_fact`. Direct search makes newly captured facts immediately recallable.
- `KnowledgeIndex`, through the active hybrid plugin. In this repository that means
  Mem0, indexed local files, and skill metadata/content.
- `WorkspaceRagManager`, when the `workspace-rag` plugin is active. This searches the
  selected workspace's active markdown RAG context and appends matching local file chunks.

When remembered facts match, the tool returns `name: "remembered_facts"` and a content
block beginning with `Remembered facts:`. If the `KnowledgeIndex` also has a good result,
that result is appended below the remembered facts; workspace RAG results are appended when
available. When no remembered fact matches, the tool falls back to workspace RAG and then
the best `KnowledgeIndex` result. If no layer has context, it returns an error saying no
skill/context is available.

Example:

```json
{
  "terms": [
    {
      "term": "Matbot expert panel",
      "context": "The user asked why the Matbot expert panel is unavailable."
    }
  ]
}
```

Send that payload to:

```text
POST /tools/contextual_search
```

In normal chat, you usually do not call this manually. Ask a question that includes a
project-specific unknown term, and the model should use it when it needs local context.

Direct example for personal memory recall:

```json
{
  "terms": [
    {
      "term": "name",
      "context": "What is my name?"
    }
  ]
}
```

Typical response when the name has been remembered:

```json
{
  "name": "remembered_facts",
  "content": "Remembered facts:\n- The user's name is Maciej Zagozda"
}
```

### `./packages/plugins/cognition`

Adds memory and reflective cognition tools. In this project it is used mainly for durable
remembered facts, "Inner voice" critique, and background dream-time consolidation.

Examples:

Capture facts from the current user message:

```json
{}
```

Send that payload to:

```text
POST /tools/remember_fact
```

Query remembered facts:

```json
{
  "action": "query",
  "query": {
    "limit": 10
  }
}
```

Send that payload to:

```text
POST /tools/remembered_facts_action
```

`remembered_facts_action` is a generated CRUD tool over the persistent
`remembered_facts` store. Use it to inspect, correct, remove, or manually seed durable
facts. Documents have this shape:

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

Fields:

- `fact` is the normalized durable statement, usually phrased in third person.
- `sessionId`, `messageId`, and `createdAt` record where the fact came from.
- `dreamSkill` is set by `dream_time` after a fact has been terminally processed.
  A real skill name means it was merged into that skill; internal sentinel values mean
  it was declined or quarantined.
- `ignoreUntil` is used by `dream_time` to defer weakly matched facts without retiring
  them.
- `version` is managed by the store. Use the version you last read as `expected` for
  safe `cas` or `delete` operations.

Explore all remembered facts from PowerShell:

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

Search remembered facts by substring:

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

Read one fact by id:

```json
{
  "action": "get",
  "id": "remembered-fact-id"
}
```

Create or replace a fact manually:

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

Correct a fact safely with compare-and-swap. First `get` the document and copy its
`version`, then send:

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

Delete an incorrect fact:

```json
{
  "action": "delete",
  "id": "remembered-fact-id",
  "expected": "version-from-get"
}
```

Omit `expected` only when you intentionally want an unconditional delete.

Consult the Inner voice:

```json
{
  "prompt": "Critique this draft answer for missing risks and unclear assumptions.",
  "system": "Be concise and specific."
}
```

Send that payload to:

```text
POST /tools/ask_inner_voice
```

Run one background consolidation pass:

```json
{}
```

Send that payload to:

```text
POST /tools/dream_time
```

Inspect cognition settings:

```json
{
  "action": "get"
}
```

Send that payload to:

```text
POST /tools/cognition_config
```

### `./packages/plugins/workspace`

Adds file management inside Matbot's workspace namespace. This is the plugin behind
reading, writing, listing, deleting, and serving workspace artifacts through the WebUI.
It is intentionally a workspace abstraction, not unrestricted host filesystem access.

Examples:

```json
{
  "action": "list"
}
```

```json
{
  "action": "write",
  "path": "notes/panel-test.md",
  "content": "# Panel Test\nThis file was written through workspace_action."
}
```

```json
{
  "action": "read",
  "path": "notes/panel-test.md"
}
```

```json
{
  "action": "delete",
  "path": "notes/panel-test.md"
}
```

Send those payloads to:

```text
POST /tools/workspace_action
```

### `./plugins/expert-panel`

Adds the local multi-expert panel. It loads expert definitions from
`local-agent/config/experts.json`, retrieves each expert's scoped knowledge files, asks
each expert independently, and optionally runs a synthesis pass.

Examples:

List configured experts:

```json
{
  "action": "list"
}
```

Ask all experts and synthesize:

```json
{
  "action": "ask",
  "question": "Should we keep the expert panel as a tool-based orchestration feature?",
  "mode": "review",
  "synthesize": true,
  "maxCitationsPerExpert": 5
}
```

Ask selected experts without synthesis:

```json
{
  "action": "ask",
  "question": "What are the delivery risks of this change?",
  "experts": ["engineering", "finance"],
  "mode": "debate",
  "synthesize": false
}
```

Send those payloads to:

```text
POST /tools/expert_panel
```

The WebUI exposes this directly in the `Experts` sidebar section.

### `./packages/plugins/frontend/web`

Serves the browser WebUI on `http://localhost:19778` using HTTP plus SSE event streams.
It also registers `url_for_resource`, which lets the assistant create shareable local URLs
for public workspace files.

Example:

```json
{
  "namespace": "workspace",
  "name": "notes/panel-test.md"
}
```

Send that payload to:

```text
POST /tools/url_for_resource
```

If the named workspace file exists and is viewable, the result contains a local URL such
as:

```text
http://localhost:19778/workspace/notes/panel-test.md
```

## Expert panel

The repository includes a tool-based expert panel for running one conversation against
selected domain experts, comparing their opinions, and letting an orchestrating model
collate the result.

### What was implemented

- `local-agent/matbot/plugins/expert-panel` — a Node-only Matbot plugin that registers the
  `expert_panel` tool.
- `local-agent/config/experts.json` — config-driven expert definitions. The default experts
  are `design`, `finance`, and `engineering`.
- `local-agent/config/matbot.expert-panel.example.yaml` — tracked reference config showing
  the Matbot plugin order required to enable the expert panel.
- `local-agent/knowledge/<expert-id>/` — file-backed knowledge roots for each expert.
  Put `.md`, `.txt`, `.json`, `.csv`, `.tsv`, `.yaml`, or `.yml` files here to ground that
  expert's answers.
- `local-agent/matbot/plugins/hybrid-knowledge-index` now maps Mem0 and file-index results
  into Matbot's real `KnowledgeEntry` shape (`id`, `version`, `entities`, `tags`,
  `summary`, `source`, timestamps, etc.) instead of returning the older simplified shape.

### How it works

The orchestration style is intentionally tool-based:

1. The main Matbot agent calls `expert_panel`.
2. `expert_panel` selects the requested experts, or all experts if none are specified.
3. Each expert retrieves matching text snippets from its configured knowledge roots.
4. Each expert gets an independent `services.singleTurn(...)` call with:
   - that expert's system prompt;
   - the user question;
   - retrieved, expert-scoped source text;
   - instructions to state evidence, assumptions, risks, and confidence.
5. If `synthesize` is true, the plugin runs one final orchestrator `singleTurn(...)` call
   to collate consensus, disagreements, assumptions, and a final recommendation.

This keeps experts isolated by knowledge source while still running inside one Matbot
process. It avoids spinning up separate chatbot processes for each expert.

### Using the expert panel

In the web UI, open the `Experts` sidebar section. Enter a question, keep `All experts`
enabled or select individual experts, choose the panel mode, and leave `Synthesize decision`
enabled when you want the orchestrator to collate a final recommendation. Press `Ask` to run
the panel directly from the UI.

You can still ask for the panel explicitly in the main chat, for example:

```text
Use the expert panel to review whether we should build Google Drive persistence for
the Node host. Ask design, finance, and engineering, then synthesize the decision.
```

The underlying tool input is:

```json
{
  "question": "Should we build Google Drive persistence for the Node host?",
  "experts": ["design", "finance", "engineering"],
  "mode": "review",
  "maxCitationsPerExpert": 5,
  "synthesize": true
}
```

Supported modes:

- `parallel` — each expert answers independently.
- `review` — experts critique a proposal or decision.
- `debate` — experts emphasize tradeoffs and disagreement.

### Adding or changing experts

Edit `local-agent/config/experts.json`:

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

Then create the knowledge folder:

```powershell
mkdir local-agent\knowledge\security
```

Add text files to that folder and restart Matbot:

```powershell
cd local-agent\matbot
pnpm start
```

The plugin resolves roots relative to `local-agent/config/experts.json`. You can also point
an expert at an absolute path if the material lives elsewhere.

### Implementation notes

- Expert retrieval is file-backed in this implementation. It ranks text files by simple term
  occurrence in the filename and file content, then passes the top matches to the expert.
- The expert panel is deliberately separate from the global `KnowledgeIndex`. That prevents
  design, finance, and engineering from collapsing into one shared retrieval pool.
- The current design is ready for a later RAG/database backend: replace `FileExpertKnowledge`
  in `plugins/expert-panel/src/file-knowledge.ts` with a tenant-filtered vector search that
  accepts `expertId`.
- The orchestrator does not hide disagreement. The synthesis prompt asks for consensus,
  disagreements, risks/assumptions, and a final recommendation.

### Expert panel test data and tests

Each default expert has a minimal `panel-probe.md` file under its knowledge folder. These
files contain unique probe terms (`PanelProbeDesign`, `PanelProbeFinance`,
`PanelProbeEngineering`) so automated tests can prove retrieval stays expert-scoped.

The expert panel is covered by `tests/expert-panel.test.mjs`. The test uses a fake Matbot
`singleTurn` implementation, so it verifies plugin registration, expert selection,
per-expert file retrieval, prompt construction, citation output, synthesis invocation, and
unknown-expert errors without spending model tokens. It also verifies the token-free
`expert_panel` list action used by the WebUI to discover configured experts.

The WebUI controls are covered by `tests/webui/matbot-webui.spec.mjs`. The harness fakes
`expert_panel`, so the tests verify expert discovery, whole-panel selection, individual
expert selection, mode selection, citation rendering, and synthesis toggling without model
tokens.

## WebUI Playwright tests

The Matbot WebUI is covered by Playwright tests under `tests/webui/`.

The suite uses a deterministic local harness (`tests/webui/harness.mjs`) instead of the live
OpenAI-backed Matbot process. The harness serves the real WebUI assets from
`local-agent/matbot/packages/plugins/frontend/web/static` and implements fake versions of the
HTTP/SSE endpoints the UI consumes. This keeps the tests fast, deterministic, and token-free while
still exercising the actual browser JavaScript and DOM.

Covered WebUI features:

- Initial shell render: provider selector, conversation list, file list, plugin list, and skill list.
- Workspace selector: workspace list, create, rename, switch, and reload after a selected
  workspace becomes active, with required default plugins still visible after the switch.
- Workspace RAG controls: context name, markdown folder paths, save, reindex, indexing
  progress percentage, and CPU/NVIDIA status display.
- Memory workflow: create a remembered fact, verify it persists through
  `remembered_facts_action`, start a new conversation, and use that memory in an answer.
- Automatic workspace RAG retrieval: a sample markdown-backed context is surfaced during a
  conversation and the assistant answer uses the retrieved local content.
- Expert panel sidebar controls: configured expert discovery, all-expert runs, selected-expert
  runs, mode selection, citation output, and synthesis on/off.
- Desktop conversation flow: new conversation, message submit, SSE queued event, thinking block,
  tool call rendering, tool result rendering, streamed assistant text, and token stats.
- Interactive prompt flow over the session event stream.
- Workspace file upload, live file refresh, and delete action.
- Plugin panel rendering, loaded plugin tool rows, local plugin discovery, and incompatible-runtime
  plugin display (for example browser-only Google Drive storage on the Node host).
- Skill list and skill editor: metadata tab, trigger tab, adding a trigger row, and save flow.
- Session sidebar actions: rename and hide.
- Stop/abort control while a turn is busy.
- Mobile layout: burger button opens the sidebar drawer.

Commands:

```powershell
# Installs the Playwright browser binary. Needed once per machine/user profile.
npx playwright install chromium

# Runs only the WebUI browser tests.
npm run test:webui

# Runs node:test unit/integration tests and then the WebUI Playwright tests.
npm run test:all
```

Playwright traces are retained on failure in `test-results/`. Inspect a trace with:

```powershell
npx playwright show-trace <path-to-trace.zip>
```

The Node test suite also includes `tests/workspace-rag.test.mjs`, which launches the
workspace RAG plugin under Matbot's TypeScript loader, creates a temporary workspace,
ingests a sample markdown file, verifies the persisted vector index, searches it, and
checks that the screen hook injects retrieved context into a turn.

## Safety Defaults

- Workspace roots are configured in `local-agent/config/workspaces.json`.
- Denied path fragments and high-risk extensions are configured in `local-agent/config/security-policy.json`.
- The file index skips unsupported files, oversized files and files that look like they contain secrets.
- The file broker blocks paths outside configured roots, blocks writes to read-only roots, rejects delete operations and requires `approved=true` for high-risk writes.
- Writes create backups under `local-agent/file-broker/backups` before overwriting existing files.
