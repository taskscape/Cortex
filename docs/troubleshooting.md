# Troubleshooting

> Part of the [Cortex Local Agent documentation](../README.md).

## Provider Does Not Appear

Provider options come from the active workspace's `matbot.yaml`. If you edited
the default `matbot.yaml` but the UI is running another workspace, switch to the
default workspace or edit that workspace's own config under
`local-agent\matbot\workspaces\<id>\matbot.yaml`.

Restart after config changes:

```powershell
.\scripts\run.ps1
```

Hard-refresh the browser if the old provider list is cached.

## Old WebUI Appears After Running `run.ps1`

`run.ps1` restarts the WebUI by default. If an old process remains, check for a
different port or a browser tab using cached assets. Run:

```powershell
.\scripts\stop-local-agent.ps1
.\scripts\run.ps1
```

Then hard-refresh the browser.

## `workspace_rag plugin unavailable`

The active Matbot process did not load `./packages/plugins/workspace-rag`.
Check the active workspace's `matbot.yaml`, restart Cortex, and verify the plugin
appears in the WebUI plugin list.

## `expert_panel plugin unavailable`

The active Matbot process did not load `./plugins/expert-panel`, or the browser
is connected to an older WebUI process. Restart Cortex and check
`local-agent\logs\matbot.err.log` for plugin load errors.

## Remembered Name Is Not Recalled

Name recall needs all of these to work:

1. `skills`, `triggers`, and `cognition` are loaded.
2. `remember_fact` fires and writes to `remembered_facts`.
3. A later turn calls `contextual_search`, or the provider receives enough
   context to use remembered facts.

Inspect the store directly with `remembered_facts_action` if recall fails.

## RAG Indexed Fewer Files Than Expected

Workspace RAG indexes only files with the `.md` extension under configured paths.
The indexed count reflects successfully scanned/read markdown documents in the
active RAG context. Check:

- `workspace_rag` status;
- configured `paths` in `cortex-rag.json`;
- whether files are below accessible folders;
- file permissions;
- whether the process has restarted after configuration changes;
- `local-agent\logs\matbot.err.log`.

## Mem0 Startup Errors

If Mem0 fails after rotating passwords, recreate Docker volumes because Postgres
and Neo4j keep first-run credentials in their volumes:

```powershell
docker compose -f local-agent\docker\mem0\docker-compose.yml down -v
.\scripts\run.ps1
```
