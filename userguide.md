# Cortex User Guide

Cortex is a Windows-native local assistant for conversations, workspace-specific
knowledge, durable memory, controlled file access, multi-expert review, governed
data queries, and business workflow operations. This guide explains how to use
the features exposed by the current Cortex WebUI and the supporting launch
scripts.

For system architecture, configuration schemas, tool payloads, or development
details, use the [reference documentation](docs/architecture.md) instead.

## Contents

- [Install And Start Cortex](#install-and-start-cortex)
- [Understand The WebUI](#understand-the-webui)
- [Use Conversations And Models](#use-conversations-and-models)
- [Use Workspaces](#use-workspaces)
- [Use Files And Workspace RAG](#use-files-and-workspace-rag)
- [Use Memory](#use-memory)
- [Use Skills](#use-skills)
- [Use The Expert Panel](#use-the-expert-panel)
- [Inspect Sources And Source Health](#inspect-sources-and-source-health)
- [Run Governed SQL Queries](#run-governed-sql-queries)
- [Use The Workflow Operations Center](#use-the-workflow-operations-center)
- [Evaluate Deployments And Show ROI](#evaluate-deployments-and-show-roi)
- [Explore The Context Graph](#explore-the-context-graph)
- [Create Durable Expert Reviews](#create-durable-expert-reviews)
- [Manage Plugins](#manage-plugins)
- [Use Scheduled And Unattended Actions](#use-scheduled-and-unattended-actions)
- [Understand Safety Boundaries](#understand-safety-boundaries)
- [Troubleshoot Common Problems](#troubleshoot-common-problems)

## Install And Start Cortex

### Requirements

- Windows PowerShell.
- Node.js 24 or later. The bundled Matbot runtime declares Node.js 24 as its
  minimum supported version.
- `npm`; `pnpm` is also used by the Matbot monorepo. The launch script installs
  `pnpm@9` when needed unless installation is skipped.
- Docker Desktop with WSL2 for Mem0, Postgres/pgvector, Neo4j, and the normal
  workspace RAG storage path.
- Network access to any hosted model provider you configure.
- An OpenAI-compatible provider for real model turns. A local compatible
  endpoint can be used instead of a hosted provider.

### Install with the Windows setup program

Build the setup program from a source checkout with Inno Setup 6:

```powershell
.\installer\Build-Installer.ps1
```

Each commit pushed to `main` also triggers the GitHub Actions installer workflow.
It publishes a GitHub Release tagged `build-<full commit SHA>` with the setup
program and a SHA-256 manifest. A push containing several commits builds each
commit separately. Rerunning a completed workflow reuses its existing release.

Run `installer\Output\Cortex-0.1.0-win-x64-Setup.exe` on Windows 10/11 x64.
Setup checks for Docker Desktop and Node.js 24 or newer before copying Cortex.
If Docker Desktop is missing, Setup downloads Docker's pinned Windows installer,
verifies its published SHA-256, and runs its per-user installation. Docker
Desktop must be able to run Linux containers; Setup starts it and waits for its
engine if necessary. Complete any Docker first-run, WSL, license, or restart
prompts. Rerun Setup if Docker requires a Windows restart. Node.js 24 or newer
must already be installed. Setup asks for an OpenAI API key on the first
install, generates local service secrets, installs Node dependencies, builds
Cortex, starts its services, checks the WebUI, and creates a **Cortex** Start
menu shortcut. That shortcut starts Cortex when needed and opens
`http://localhost:19778/` in the default browser. Initial downloads require
network access and can take several minutes.

Setup preserves existing `matbot.yaml`, workspace registry, workspace data,
provider secrets, and Docker volumes on upgrades. It starts with no authorized
host file roots. Add roots in the installed
`local-agent\config\workspaces.json` only after reviewing their permissions.
If first-run setup fails, read `local-agent\logs\installer-setup.log` under the
chosen install directory, address the error, and run Setup again.

### Configure secrets manually

From the repository root, run the setup command once:

```powershell
.\scripts\setup-secrets.ps1 -OpenAiKey "<your-openai-key>"
```

The command stores user-scoped environment variables and writes the local Mem0
environment file. Open a new PowerShell window afterward so it receives the new
user environment variables.

Do not place real credentials in documentation, chat messages, committed
workspace files, or `matbot.yaml`.

### Start Cortex

```powershell
.\scripts\run.ps1
```

The launcher installs and builds components when required, starts the local
services, checks their health, starts or restarts the WebUI, and normally opens:

```text
http://localhost:19778
```

The first Docker-backed startup can take longer while the local Mem0 image and
databases are prepared.

### Check health or stop Cortex

```powershell
.\scripts\health-check.ps1
.\scripts\stop-local-agent.ps1
```

For optional switches, Windows service installation, individual service
commands, and development commands, see [Commands](docs/commands.md).

## Understand The WebUI

The WebUI has three main areas:

1. The left sidebar contains conversations, workspace files, memory,
   architecture features, plugins, skills, and the workspace selector.
2. The center displays the current conversation or the selected full-page
   feature, such as workspace settings or Workflow Operations Center.
3. The bottom composer contains the model selector, expert controls, prompt
   input, Send button, and Stop button.

Use the small `A` controls beside the Cortex title to decrease or increase text
size. On a narrow screen, use the menu button in the chat header to open the
sidebar.

If the WebUI displays a banner saying that sessions are not loaded, enable the
sessions plugin before relying on conversations to survive a restart.

## Use Conversations And Models

### Start and continue conversations

- Click `+ New conversation` to create a separate conversation.
- Select an existing item under `Conversations` to reopen it.
- Hover over a conversation and use the rename control to change its title.
- Use the hide control to remove a conversation from the visible list. Hiding
  is not the same as deleting all underlying workspace data.

Each conversation belongs to the active Cortex workspace. Switching workspaces
changes which conversations are available.

### Select a model

Choose a provider from the `Model:` selector above the composer. Provider names
come from the active workspace's `matbot.yaml`, so different workspaces can
offer different choices.

Changing the selected model affects later normal chat turns. Individual experts
can have their own configured providers; the selected chat model is used as a
fallback and can be used for expert synthesis.

### Send and stop a turn

Type in `Ask Cortex...` and select Send. Cortex streams the response and shows
tool activity when tools are used. Completed turns include elapsed-time and
token information when the provider supplies it.

While a turn is running, the Stop button replaces Send. Stopping a turn aborts
the active request and drops anything queued behind it.

## Use Workspaces

A Cortex workspace is an isolation boundary for a project, customer, or body of
work. Each workspace has separate provider and plugin configuration, secrets,
sessions, workspace files, memories, skills, stores, and RAG configuration.

### Switch workspaces

1. Select the workspace control at the bottom-left of the sidebar.
2. Choose the destination workspace.
3. Wait while Cortex changes the active registry entry and restarts the Matbot
   process.

Do not send a new message while the workspace status says that Cortex is still
restarting.

### Create a workspace

1. Open the workspace selector.
2. Select `+ New workspace`.
3. Enter a descriptive name.
4. Select the new workspace to activate it.

New workspaces begin from the default workspace configuration and then diverge
independently.

### Rename or delete a workspace

- Select `Rename workspace` to rename the currently selected workspace.
- Use the delete button beside a workspace and confirm the warning to delete
  its local workspace files.

Workspace deletion is destructive. Review the workspace name in the
confirmation dialog before selecting `Yes`.

### Configure workspace knowledge

Select the gear beside the workspace control to open the workspace settings
page. `Context name` labels the active RAG context. Under `Markdown folders`,
enter one absolute directory per line, then select `Save`.

The page reports ingestion progress, the current file, and final status. Select
`Close` to return without saving additional changes.

For storage locations and configuration details, see
[Cortex Workspaces](docs/configuration.md#cortex-workspaces).

## Use Files And Workspace RAG

Cortex exposes two distinct file concepts:

- Workspace files are uploaded into the active Matbot workspace through the
  `Files` section.
- Workspace RAG indexes `.md` files from absolute folders configured in the
  active workspace settings.

### Upload, attach, open, and delete workspace files

1. Select the upload control beside `Files`.
2. Choose one or more files.
3. Confirm the selected files appear as attachment chips above the composer.
4. To attach an existing workspace file, hover over it and select the paperclip.
5. Enter the task and send the message. The attachment selection clears after
   the message is accepted.
6. Select a file row to open it.
7. Hover over a file and use the delete action to remove it.

These files remain scoped to the active workspace. They are not unrestricted
access to the host filesystem. An attachment tells Cortex to read the imported
workspace copy with `workspace_action`; it does not grant access to the file's
original host directory. If Workspace RAG returns a same-named external path,
the explicit attachment takes precedence for that turn.

### Index local Markdown folders

1. Open the workspace gear.
2. Enter the folders containing the Markdown documentation.
3. Save the settings. Saving rejects a configuration whose paths are all
   inaccessible; if at least one path exists, unavailable roots are skipped
   gracefully and reported through the ingestion status.
4. Wait until the status shows an `active_*` publication and no pending watcher
   or queued reconciliation.
5. Ask a question that depends on the indexed documentation.

Relevant snippets are injected automatically into later turns. Workspace RAG
uses the V2 hybrid index only and automatically reconciles folder changes.
It currently indexes Markdown files only; PDF, Office, email, and spreadsheet
ingestion are roadmap work rather than current WebUI behavior.

### Ask grounded questions

Make the desired scope explicit. For example:

```text
Using the indexed architecture documentation, explain how workflow approvals
are enforced. Cite the source file.
```

When no useful source is retrieved, verify the configured folder, file
extension, ingestion status, and active workspace.

For host-file access policy and tool-level examples, see
[Plugins And Tools](docs/plugins-and-tools.md).

## Use Memory

Memory stores stable facts that should remain useful beyond one conversation.
Memories are isolated by workspace.

### Ask Cortex to remember a fact

Use an explicit instruction:

```text
Remember that I prefer PowerShell on Windows.
```

```text
Memorize that this project's production region is West Europe.
```

Good memory candidates include stable preferences, decisions, project facts,
domain terms, implementation notes, and confirmed troubleshooting outcomes.
Do not store secrets, raw document contents, large logs, or temporary command
output as memories.

### Recall a fact

Ask a direct question in the same workspace:

```text
What shell do I prefer on Windows?
```

Recall and storage are separate operations. A fact may be stored correctly but
not used if the later turn does not retrieve relevant context.

### Browse and edit memories

1. Expand `Skills` in the sidebar.
2. Select `Open memory browser` below `Inner voice`.
3. Search remembered facts or filter by processing state.
4. Select a memory to inspect its fact, session/message provenance, creation
   time, version, dream-skill assignment, and ignore-until value.
5. Edit the fact and select `Save`, or select `Delete` to remove it.

To create a memory manually, enter the fact in `Add a remembered fact manually`
and select `Add memory`. The browser uses version-aware updates so it can report
when a record changed before an edit or delete was applied.

### Understand the retrieval layers

| Layer | Use |
| --- | --- |
| Remembered facts | Explicit durable facts and preferences. |
| Skills | Reusable instructions and playbooks. |
| Workspace RAG | Grounding from configured Markdown folders. |
| Contextual search | Searches remembered facts, the knowledge index, and workspace RAG together. |
| Dream time | Slower consolidation that can merge facts into longer-lived skill knowledge. |

For the storage flow and administrative tool calls, see
[Memory And Retrieval](docs/memory-and-retrieval.md).

## Use Skills

Skills are reusable Markdown instructions or playbooks stored in the active
workspace.

### Inspect or edit a skill

1. Expand `Skills` in the sidebar.
2. Select a skill or use its edit action.
3. Use `Content` to edit the Markdown instructions.
4. Use `Triggers` to inspect or change automatic activation conditions.
5. Use `Metadata` to inspect catalogue and derived knowledge information.
6. Select `Save`.

Use the remove action only when the skill is no longer needed. Skill changes
are workspace-specific and can affect later tool selection and retrieval.

If the Markdown editor is unavailable in an offline browser session, Cortex
shows an error instead of saving through a partially loaded editor.

## Use The Expert Panel

The Expert Panel sends one question to several independently configured domain
experts and can synthesize their findings. It is useful for decisions with
competing design, finance, engineering, legal, security, operational, or
customer concerns.

### Run all experts

1. Select `Experts` above the composer.
2. Enable `Use experts`.
3. Leave `All experts` selected.
4. Choose `Parallel`, `Review`, or `Debate`.
5. Leave `Synthesize decision` enabled if you want a combined recommendation.
6. Close the popup, enter the question in the normal composer, and send it.

The transcript records the chosen mode, selection, and synthesis setting so the
turn can be understood after a reload.

### Run selected experts

1. Enable the panel.
2. Clear `All experts`.
3. Select the individual experts.
4. Choose the mode and synthesis setting.
5. Send the question normally.

Cortex does not run the panel when no expert is selected.

### Choose a mode

| Mode | Best use |
| --- | --- |
| Parallel | Gather independent perspectives without forcing agreement. |
| Review | Critique a proposal, plan, workflow, or implementation. |
| Debate | Surface disagreements, tradeoffs, and conditions that would change a recommendation. |

When synthesis is enabled, the result includes consensus, disagreement, risks,
assumptions, and a final recommendation. Each expert searches only its own
configured knowledge roots, which keeps domain evidence separated.

For a detailed panel walkthrough and expert configuration, see the
[Expert Panel User Manual](docs/expert-panel.md).

## Inspect Sources And Source Health

The source panels show the evidence records Cortex uses for retrieval and
automation.

1. Expand `Architecture` in the sidebar.
2. Select `Sources`.
3. Select a source from the list.
4. Review its URI, kind, sensitivity, permission state, trust, health,
   freshness, connector, observation time, and last successful read.
5. Inspect citation text, known limitations, health findings, and source events.

Use the health and freshness information before relying on a source for a
decision or approved workflow. `Stale`, `degraded`, `unhealthy`, or `denied`
states should be investigated rather than silently ignored.

Select `Refresh` to reload the source and health records for the active
workspace.

## Run Governed SQL Queries

The `SQL Preview` panel plans and executes bounded read-only Postgres queries
from approved semantic identifiers.

1. Open `Architecture` and select `SQL Preview`.
2. Enter the metric identifier.
3. Optionally enter a dimension and filter column/value.
4. Set a result limit.
5. Select `Plan`.
6. Review the generated `SELECT` statement, row-cap warning, source tables, and
   validation result.
7. Select `Approve` to obtain approval for that exact planned run.
8. Select `Execute`.
9. Inspect the rows and query-result citation.

Planning does not execute the query. Approval and execution are separate steps,
and the approval token is tied to the planned query run. Cortex rejects writes,
unknown columns, unsafe joins, missing limits, and execution without approval.

Do not approve a query when the metric, filters, source tables, or row cap do
not match the intended business question.

## Use The Workflow Operations Center

Open `Architecture` and select `Workflow Center`. The Center is the control room
for governed business workflows. It uses persisted workflow compilations, typed
run records, approval gates, ordered run events, and shadow comparisons.

### Read the overview

The top cards show:

- number of compiled workflows;
- number of workflow runs;
- pending approvals;
- shadow acceptance rate.

The `Overview` tab highlights failed runs, approvals that need attention,
recent runs, and shadow readiness. Select a recent run to open it in the Run
Ledger.

### Compile a workflow

1. Open the `Library` tab.
2. Enter a clear workflow name.
3. Choose the risk level.
4. Enter the purpose or selected transcript. Use placeholders such as
   `{{invoiceId}}` for typed workflow inputs.
5. Enter comma-separated evidence source IDs when the workflow must use
   registered evidence.
6. Enter an allowed tool name only when the workflow needs that tool.
7. Choose whether to publish an immutable version.
8. Choose whether to run the dry-run smoke test.
9. Select `Compile workflow`.

The compiler derives a definition, input schema, required evidence, allowed
tools, risk, approval gates, smoke test, and success metrics. Review the
resulting library entry before starting another run.

The current form accepts purpose/transcript text; selecting a range directly
from an existing chat and editing a version diff are not implemented yet.

### Inspect the workflow library

Use the library search field to filter by name, purpose, workflow ID,
compilation ID, or status. Select an entry to see:

- compilation status and compiler version;
- published workflow and version;
- risk;
- purpose;
- evidence sources and allowed tools;
- approval gates and success metrics;
- validation errors and compiler warnings.

From a published entry you can start:

| Mode | Behavior |
| --- | --- |
| Dry run | Records validation, evidence, and proposed actions without executing write/admin tools. |
| Shadow | Records the recommendation for later comparison with a human decision; write/admin tools remain blocked. |
| Approval gated | Creates approval requests before protected actions can proceed. |

### Inspect the run ledger

Open `Run Ledger`, then filter by workflow/run ID or status. Select a run to
inspect:

- workflow and immutable version;
- mode and status;
- effective principal;
- typed inputs;
- evidence source IDs and source versions;
- proposed actions;
- executed actions;
- approvals;
- ordered run events.

Proposed and executed actions are displayed separately. An approved proposal is
not proof that an external action succeeded; check the executed action and
later ledger events.

### Decide an approval

1. Open `Approvals`.
2. Select a pending gate.
3. Review the reason, workflow run, evidence, proposed actions, and ledger.
4. Select `Approve` or `Reject`.

The controls are disabled while the decision request is in progress, preventing
rapid duplicate submissions. High-risk workflows may contain separate action,
stale-source, risk, cost, confidence, and expert-review gates.

### Label shadow results

1. Open `Shadow Lab`.
2. Select an unlabeled shadow run.
3. Review the proposed recommendation and evidence.
4. Select `Accept`, `Reject`, or `Mark mixed`.

The comparison is stored against the exact run, workflow version, source IDs,
and recommendation hash. The overview acceptance rate updates after labeling.
Use shadow mode to gather evidence about workflow quality before enabling
approval-gated or unattended behavior.

### Current workflow limitations

The current Center does not provide arbitrary visual multi-step execution,
background scheduling, or editable version diffs.
The existing workflow runtime provides typed definitions, run ledgers,
evidence, proposed actions, approvals, dry-run/shadow semantics, and policy
enforcement; do not describe an unimplemented step executor as active.

## Evaluate Deployments And Show ROI

Open `Architecture` and select `Evaluation & ROI`. This panel turns runtime
behavior into release evidence and sponsor-facing operating evidence.

The summary cards show trace volume, regression pass rate, verified workflow
completion, and net benefit. Use the three detail areas as follows:

1. In `Traces`, select a run to inspect its agent, model, tool, retrieval,
   policy, evaluator, and workflow spans. The waterfall shows nesting, status,
   duration, tokens, and cost. `Replay safely` reconstructs the stored timeline
   and never re-executes writes.
2. In `Regression suites`, select a versioned suite, review its cases and gate,
   then select `Run suite`. Required scorer failures or a pass rate below the
   suite threshold fail the deployment gate.
3. In `Sponsor evidence`, review retrieval/citation coverage, action and policy
   outcomes, workflow approvals and escalations, verified time saved, operating
   cost, benefit, net benefit, ROI, and estimated payback outcomes.

Only outcomes marked `verified_completed` contribute to time-saved and benefit
calculations, and they must link to a workflow baseline and named verifier.
Model prices come from provider-reported cost or `CORTEX_MODEL_PRICING_JSON`.
Use the regression CLI in automation when a failed suite must block a release:

```powershell
npm run eval:cortex -- <suite-id> --candidate <version> --junit <results.xml>
```

## Explore The Context Graph

The Context Graph connects source-backed entities and relationships for
multi-hop retrieval.

1. Open `Architecture` and select `Graph`.
2. Enter one or more comma-separated search terms.
3. Optionally enter a source ID to constrain retrieval.
4. Select `Retrieve`.
5. Select an entity to inspect identifiers, aliases, sensitivity,
   relationships, evidence spans, confidence, and citations.

Graph relationships are derived assertions, not silent authoritative facts.
Use their source and confidence information when interpreting them. Select
`Refresh` to discard the current retrieval result and reload stored entities.

## Create Durable Expert Reviews

The `Reviews` architecture panel stores structured expert review artifacts that
can be connected to workflows, runs, alerts, investigations, or decisions.

1. Open `Architecture` and select `Reviews`.
2. Enter the review question.
3. Choose the target type.
4. Enter the target ID when one exists.
5. For workflow reviews, enter the workflow ID and optional run ID.
6. Enter comma-separated expert IDs.
7. Select `Create Review`.

Select a review card to inspect expert recommendations, confidence, evidence,
risks, blockers, mitigations, approval checklist, consensus, disagreements,
risk register, and synthesis.

The current WebUI can create and inspect review records. Manual reviewer
assignment and status editing remain future product work.

## Manage Plugins

Plugins determine which providers, tools, stores, hooks, and WebUI capabilities
are available in the active workspace.

1. Expand `Plugins` in the sidebar.
2. Expand an active plugin to inspect its description, runtime types, and tools.
3. Hover over a compatible inactive local plugin and use its add control to
   activate it.
4. Use the remove control on an active optional plugin to deactivate it.
5. Restart Cortex when the plugin adds boot-time services, hooks, stores,
   providers, or frontend behavior.

Do not remove core plugins such as sessions, workspace, workflow governance, or
the active frontend without understanding the resulting loss of behavior.
Plugin configuration is workspace-specific.

For available plugins and direct tool examples, see
[Plugins And Tools](docs/plugins-and-tools.md).

## Use Scheduled And Unattended Actions

Cortex contains a background plugin and scheduling primitives, but the default
workspace does not expose a general scheduling screen in the WebUI.

For scheduled work:

1. Enable the `background` plugin in the intended workspace.
2. Enable only the tools the scheduled task needs.
3. Use a scheduled prompt as a thin trigger for typed workflow execution rather
   than embedding complex business logic in an unstructured prompt.
4. Review run history, approvals, tool permissions, and failure handling before
   relying on unattended execution.

For operational and configuration details, see
[Scheduled And Unattended Actions](docs/architecture.md#scheduled-and-unattended-actions).

## Understand Safety Boundaries

- The WebUI is intended for localhost use. Do not expose it remotely until an
  authentication and TLS boundary is configured.
- Workspace files, memories, skills, and RAG settings are isolated by workspace.
- Host file access remains constrained by configured file-broker roots and
  policy.
- File-broker creates backups and diffs for overwrites and requires explicit
  approval for high-risk writes.
- Workspace RAG indexes Markdown only and stores data per workspace.
- Sources carry sensitivity, permission, freshness, health, and citation
  metadata.
- Governed SQL is read-only and requires approval before execution.
- Workflow dry-run and shadow modes do not execute write/admin tools.
- Expert knowledge roots are isolated by expert ID.
- Secrets and machine-local workspace state must not be committed.

When a tool requests approval, review the exact path, query, action, source, and
workflow run—not only the natural-language explanation.

## Troubleshoot Common Problems

### A provider is missing

Providers come from the active workspace's `matbot.yaml`. Confirm the selected
workspace, restart Cortex, and hard-refresh the browser.

### A feature says its plugin is unavailable

Expand `Plugins` and verify that the required plugin is active. Restart Cortex
after boot-sensitive plugin changes.

### The old WebUI is still displayed

```powershell
.\scripts\stop-local-agent.ps1
.\scripts\run.ps1
```

Then hard-refresh the browser and confirm the port is `19778`.

### Memory is not recalled

Open the memory browser and check whether the fact exists. If it exists, storage
worked and the issue is retrieval or model behavior. If it does not, verify that
skills, triggers, and cognition are loaded.

### Workspace RAG indexes fewer files than expected

Confirm that paths are absolute, accessible, and contain `.md` files. Check the
workspace settings publication/job and watcher status, then inspect
`local-agent\logs\matbot.err.log`. An inaccessible configured root is reported
as a retryable discovery failure and the prior complete publication is retained.

### A workflow list or panel looks stale

Select `Refresh`. If the active workspace recently changed, wait for the Matbot
restart and reload the WebUI.

### Mem0 fails after password rotation

Postgres and Neo4j preserve first-run credentials in Docker volumes. If the data
can be discarded, recreate the volumes and restart:

```powershell
docker compose -f local-agent\docker\mem0\docker-compose.yml down -v
.\scripts\run.ps1
```

This deletes the Docker-backed local memory databases. Do not run it when those
volumes contain data you need to preserve.

For additional cases, see [Troubleshooting](docs/troubleshooting.md).

## Reference Documentation

| Document | Use it for |
| --- | --- |
| [Architecture And Core Systems](docs/architecture.md) | Request flow, services, persistence, scheduling, workflows, graphs, and experts. |
| [Configuration Reference](docs/configuration.md) | Providers, secrets, workspaces, RAG, file policy, and expert configuration. |
| [Commands](docs/commands.md) | Launcher, service, health, build, and test commands. |
| [Plugins And Tools](docs/plugins-and-tools.md) | Plugin inventory and direct tool/API payloads. |
| [Memory And Retrieval](docs/memory-and-retrieval.md) | Memory storage, retrieval, consolidation, and policy. |
| [Expert Panel User Manual](docs/expert-panel.md) | Detailed expert-panel usage and customization. |
| [WebUI](docs/webui.md) | Concise list of current WebUI capabilities. |
| [Testing](docs/testing.md) | Automated test layers and coverage. |
| [Troubleshooting](docs/troubleshooting.md) | Operational failure cases and recovery. |
