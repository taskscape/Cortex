# Matbot Local Agent Scaffold

This repository implements a Windows-native local assistant scaffold based on the supplied specification.

Implemented components:

- `local-agent/file-index`: JSON-backed local file index with keyword search, path metadata, hash tracking, exclusion rules and likely-secret skipping.
- `local-agent/file-broker`: policy-aware file access service for directory listing, text reads and approved writes with diffs and backups.
- `local-agent/matbot/plugins/hybrid-knowledge-index`: Matbot-compatible `KnowledgeIndex` plugin that queries Mem0 and the local file index, then ranks and deduplicates results.
- `local-agent/docker/mem0`: Docker Compose stack for Mem0 API dependencies and the Mem0 API endpoint.
- `local-agent/scripts`: setup, start, stop and health-check PowerShell scripts.

PROJECTMEM is intentionally not integrated.

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

Verify the OpenAI key from `specification.md` without printing it:

```powershell
npm run verify:openai
```

## Endpoints

- File index: `http://localhost:8877`
- File broker: `http://localhost:8878`
- Mem0 API: `http://localhost:8888`

## Safety Defaults

- Workspace roots are configured in `local-agent/config/workspaces.json`.
- Denied path fragments and high-risk extensions are configured in `local-agent/config/security-policy.json`.
- The file index skips unsupported files, oversized files and files that look like they contain secrets.
- The file broker blocks paths outside configured roots, blocks writes to read-only roots, rejects delete operations and requires `approved=true` for high-risk writes.
- Writes create backups under `local-agent/file-broker/backups` before overwriting existing files.
