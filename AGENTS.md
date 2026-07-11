# Repository instructions

## Workspace-local settings

- Never stage or commit `local-agent/matbot/cortex-workspaces.json`.
- Never stage or commit files under `local-agent/matbot/workspaces/` that contain workspace-local settings, runtime data, memory, sessions, credentials, indexes, or generated state.
- In particular, exclude `matbot.yaml`, `.env*`, `.data*`, and `cortex-rag.json` from every workspace directory.
- Treat existing tracked workspace-setting files as local user state: do not include their modifications in commits unless the user explicitly requests those exact files.
- Use explicit paths when staging changes; do not use broad staging commands while workspace-local files are present.
