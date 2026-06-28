# Matbot Local Agent Scaffold

This repository implements a Windows-native local assistant scaffold based on the supplied specification.

Implemented components:

- `local-agent/file-index`: JSON-backed local file index with keyword search, path metadata, hash tracking, exclusion rules and likely-secret skipping.
- `local-agent/file-broker`: policy-aware file access service for directory listing, text reads and approved writes with diffs and backups.
- `local-agent/matbot/plugins/hybrid-knowledge-index`: Matbot-compatible `KnowledgeIndex` plugin that queries Mem0 and the local file index, then ranks and deduplicates results.
- `local-agent/docker/mem0`: Docker Compose stack for Mem0 API dependencies and the Mem0 API endpoint.
- `local-agent/scripts`: setup, start, stop and health-check PowerShell scripts.

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
.\local-agent\scripts\setup-secrets.ps1 -OpenAiKey "<your-openai-key>"
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

Install and build:

```powershell
.\local-agent\scripts\setup-local-agent.ps1
```

Start local services:

```powershell
.\local-agent\scripts\start-local-agent.ps1
```

Check service health:

```powershell
.\local-agent\scripts\health-check.ps1
```

Stop services:

```powershell
.\local-agent\scripts\stop-local-agent.ps1
```

Run tests:

```powershell
npm test
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
index) and configured to talk to OpenAI.

One-time setup:

```powershell
# pnpm is required (Node already provides corepack/npm):
npm install -g pnpm@9
cd local-agent\matbot
pnpm install
```

Configuration (already created, both gitignored):

- `local-agent/matbot/matbot.yaml` — defines the `openai` provider (`gpt-4o-mini`, key via
  `${OPENAI_API_KEY}`) and loads two plugins: `frontend/web` and
  `plugins/hybrid-knowledge-index`.
- `local-agent/matbot/.env` — the Matbot Vault secrets: `OPENAI_API_KEY` plus the
  `MEM0_BASE_URL` / `FILE_INDEX_BASE_URL` / `FILE_BROKER_BASE_URL` the hybrid plugin uses.

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

## Safety Defaults

- Workspace roots are configured in `local-agent/config/workspaces.json`.
- Denied path fragments and high-risk extensions are configured in `local-agent/config/security-policy.json`.
- The file index skips unsupported files, oversized files and files that look like they contain secrets.
- The file broker blocks paths outside configured roots, blocks writes to read-only roots, rejects delete operations and requires `approved=true` for high-risk writes.
- Writes create backups under `local-agent/file-broker/backups` before overwriting existing files.
