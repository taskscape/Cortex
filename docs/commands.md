# Commands

> Part of the [Cortex Local Agent documentation](../README.md).

## PowerShell

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

## npm

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
