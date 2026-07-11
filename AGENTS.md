# Repository instructions

## Workspace-local settings

- Never stage or commit `local-agent/matbot/cortex-workspaces.json`.
- Never stage or commit anything under `local-agent/matbot/workspaces/`. The directory is machine-local and may contain settings, runtime data, memory, sessions, credentials, indexes, uploads, or generated state.
- In particular, never force-add `matbot.yaml`, `.env*`, `.data*`, or `cortex-rag.json` from a workspace directory.
- Treat existing tracked workspace-setting files as local user state: do not include their modifications in commits unless the user explicitly requests those exact files.
- Remember that `.gitignore` does not protect files that are already tracked. Use explicit paths when staging changes; never use broad staging commands while workspace-local files are present.
- Treat these paths as outside the version-control scope even when a feature changes workspace initialization, migration, or plugin defaults. Implement those changes in tracked templates, runtime code, or documentation instead.
- Before every commit, inspect `git diff --cached --name-only`. If it contains `local-agent/matbot/cortex-workspaces.json` or any path below `local-agent/matbot/workspaces/`, unstage those paths without modifying the working files.
- After staging, also run `git status --short --ignored local-agent/matbot/cortex-workspaces.json local-agent/matbot/workspaces` and confirm that no workspace-local path is staged. Abort the commit if this audit is not clean.
