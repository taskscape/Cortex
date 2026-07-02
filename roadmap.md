# Cortex Business Automation Roadmap

## Purpose

Cortex should evolve from a local AI workbench into a business reasoning and
automation control plane. The target user is an organization that has useful
knowledge scattered across documents, emails, chat, tickets, calendars, BI
systems, databases, spreadsheets, local files, SaaS tools, and operational
logs. The core product promise should be:

> Cortex connects to many sources of business data, builds reliable context
> across them, reasons with evidence, and turns repeated decisions into
> governed automation.

This direction fits Cortex's existing architecture: workspaces, plugins,
durable memory, workspace RAG, contextual search, expert panels, local tools,
background jobs, and controlled host-file access. The next stage is to make
those pieces enterprise-shaped: source-aware, auditable, permissioned,
evaluated, and oriented around business outcomes.

## Market Direction

The industry is moving from general copilots toward task-specific and
workflow-specific agents. The winning systems are not just chatbots with tool
access. They combine:

- connectors to business systems;
- source freshness and permission awareness;
- structured and unstructured data reasoning;
- context engineering instead of prompt-only design;
- graph or semantic layers for multi-hop reasoning;
- process intelligence for understanding how work really flows;
- human approval and audit trails for risky actions;
- measurable ROI through workflow redesign, not isolated demos.

The main risk is building broad "agentic" features that look impressive but do
not survive production use. Cortex should therefore bias toward grounded,
inspectable, narrowly useful workflows before more autonomous execution.

## Product Principles

- Evidence first: important answers must include source references, freshness,
  confidence, and known gaps.
- Human-led automation: Cortex should recommend, simulate, and ask for approval
  before taking consequential actions.
- Context is a product surface: users should see which sources Cortex used,
  ignored, distrusted, or found stale.
- Workflows over prompts: repeated business tasks should become typed,
  testable workflows with inputs, policies, tools, approvals, and outcomes.
- Local-first where possible: preserve Cortex's Windows-native, local-control
  advantage while supporting cloud and SaaS connectors.
- Governance by default: permissions, audit logs, data boundaries, and
  retention rules should be explicit parts of the UX.

## Strategic Architecture

### 1. Enterprise Connector Fabric

Create a connector layer for systems such as Microsoft 365, Google Workspace,
Slack, Teams, Jira, ServiceNow, GitHub, SharePoint, Drive, Salesforce, HubSpot,
Postgres, SQL Server, Snowflake, BigQuery, Power BI, Tableau, ERP exports, and
local/network file shares.

MCP should be the preferred integration standard where it fits, but Cortex
should wrap connectors with its own policy model:

- connector owner;
- granted scopes;
- user identity;
- source freshness;
- sync cadence;
- read/write capability;
- allowed tools;
- sensitive fields;
- approval rules;
- audit logging.

### 2. Source Registry

Every indexed source should have a first-class record. Cortex should know not
only "what text matched" but also whether the source is current, trusted,
complete, permissioned, and business-relevant.

Suggested source metadata:

- source id, connector type, workspace, owner, business domain;
- last sync time, next sync time, last successful read;
- permission status and effective user;
- freshness SLA and staleness state;
- schema or document type;
- sensitivity classification;
- citation policy;
- retention policy;
- health check status;
- known limitations.

### 3. Context Graph

Add a business context graph above vector search. Vector RAG is useful for
semantic recall, but business reasoning often needs relationships:

- people own systems, metrics, decisions, contracts, and tasks;
- processes depend on systems, teams, and approval gates;
- tickets reference customers, incidents, commits, meetings, and documents;
- decisions depend on evidence and create obligations;
- metrics have definitions, owners, dimensions, and thresholds.

The context graph should represent entities, relationships, time validity,
source provenance, and confidence. It can start simple with extracted entities
and links, then grow toward GraphRAG-style retrieval for multi-hop questions.

### 4. Structured Data Reasoning

Cortex needs a safe structured data path alongside document retrieval. This
means semantic models for tables and metrics, not arbitrary SQL generation
against raw schemas.

Capabilities:

- database connectors with read-only default mode;
- table and column catalog;
- metric definitions and business names;
- join rules and allowed dimensions;
- row-level access;
- SQL preview and approval before execution when needed;
- result summarization with citations to query, source, and timestamp;
- anomaly and trend detection over query results.

### 5. Workflow And Governance Layer

Automation should be represented as durable workflow definitions, not only chat
history. A workflow should include:

- name and owner;
- typed inputs;
- trigger conditions;
- allowed sources;
- allowed tools;
- required evidence;
- risk level;
- approval gates;
- dry-run behavior;
- tests and evals;
- execution history;
- success metrics.

## Roadmap Horizons

### Near Term

- Add `roadmap.md` and align product direction around business automation.
- Build source registry primitives.
- Improve ingestion for PDF, HTML, Office documents, spreadsheets, CSV, email
  exports, and meeting transcripts.
- Add connector health checks and visible source freshness.
- Add safe SQL/data connector prototype.
- Add audit events for retrieval, tool calls, and generated artifacts.
- Expose scheduled monitors in the WebUI.
- Add workflow run records for background jobs.

### Mid Term

- Build context graph storage and retrieval.
- Add semantic metric models for structured data.
- Add reusable workflow definitions with approvals and tests.
- Add Decision Dossier and Investigation Workspace flows.
- Expand expert panel into business review roles.
- Add Automation Shadow Mode for selected workflows.
- Add dashboards for source health, workflow performance, cost, and risk.

### Long Term

- Add process mining and automation opportunity discovery.
- Add multi-agent workflow orchestration with strict role boundaries.
- Add enterprise identity integration and team workspaces.
- Add marketplace-like solution packs for finance, operations, IT, sales,
  customer support, procurement, legal, and compliance.
- Add continuous evaluation for retrieval quality, citation quality, action
  accuracy, and ROI.

## Product Proposals

## Business Radar

Business Radar is a scheduled monitoring system over business data sources. It
detects anomalies, stale data, SLA breaches, risk signals, and changed
assumptions, then routes evidence-backed alerts to users or workflows.

### Problem

Business data changes faster than people can review it. Important signals are
often spread across dashboards, tickets, emails, spreadsheets, vendor portals,
meeting notes, and operational logs. Teams usually discover issues late because
the relevant evidence lives in several places and no one is responsible for
continuously connecting it.

### Target Users

- Operations managers monitoring process health.
- Finance teams watching margin, spend, cash, forecast, and close risks.
- Customer success teams watching churn, escalations, and SLA breaches.
- IT teams monitoring incidents, access changes, systems, and vendor risk.
- Executives who need exception-based awareness instead of dashboards.

### Core Capabilities

- Scheduled checks over connector sources, local files, workspace RAG, SQL
  queries, ticket systems, calendars, and APIs.
- Freshness monitoring: "this dashboard is green, but the source data has not
  refreshed since Tuesday."
- Threshold-based alerts for known metrics.
- Anomaly detection for unusual values, volumes, delays, or pattern changes.
- Changed-assumption detection: compare new evidence against previous decisions,
  project plans, forecasts, or remembered facts.
- SLA breach detection across ticket queues, support cases, contract terms, and
  operational events.
- Risk signal aggregation across weak signals: repeated customer complaints,
  unresolved incidents, late invoices, missed meetings, negative sentiment, or
  vendor delays.
- Evidence packets that include sources, timestamps, affected entities,
  confidence, and recommended next action.

### Example Monitors

- "Alert if any strategic customer has an open P1 ticket, negative email
  sentiment, and a renewal date within 60 days."
- "Watch invoice aging, cash forecast changes, and payment disputes every
  morning; summarize the top risks."
- "Detect when a project status report still says green but Jira velocity,
  meetings, and open blockers indicate schedule risk."
- "Monitor source freshness for sales dashboards and alert when source tables
  lag more than four hours."
- "Watch policy documents and contract folders for changes that invalidate an
  existing recommendation."

### UX

Business Radar should have a WebUI section with:

- monitor list;
- schedule;
- source coverage;
- latest run;
- current status;
- alert history;
- evidence preview;
- mute/snooze controls;
- owner and escalation path;
- conversion to workflow.

Alerts should not be just chat messages. They should be durable objects with
state: new, acknowledged, investigating, resolved, ignored, or converted to
workflow.

### Technical Notes

- Builds on the existing background plugin and scheduler concept.
- Requires source registry and audit records.
- Requires connector-specific freshness checks.
- Should store monitor definitions as typed workflow-like records.
- Should support dry-run mode before enabling notifications.
- Should include cost controls for expensive model-backed checks.

### Success Metrics

- Time from signal to detection.
- Number of stale-source issues found.
- Number of alerts acknowledged or converted to action.
- False positive and false negative rates.
- Business impact: SLA breaches prevented, risks escalated earlier, manual
  dashboard checks eliminated.

## Decision Dossier

Decision Dossier is a one-click way to create an evidence-backed business
recommendation with options, tradeoffs, confidence, required approvals, and a
source trail.

### Problem

Business recommendations are often scattered across chat threads, slides,
spreadsheets, emails, documents, dashboards, and meetings. The final decision
may be plausible, but the reasoning is hard to audit: what evidence was used,
what was ignored, who needs to approve, and what assumptions would change the
answer?

### Target Users

- Managers preparing a recommendation for leadership.
- Analysts turning research into an action proposal.
- Finance and operations teams making tradeoff decisions.
- Product and engineering leads deciding between implementation paths.
- Legal, compliance, or security reviewers who need traceability.

### Core Capabilities

- Gather evidence from selected sources and prior conversations.
- Produce a structured recommendation with:
  - decision question;
  - executive summary;
  - options considered;
  - recommended option;
  - evidence table;
  - assumptions;
  - risks;
  - financial or operational impact;
  - confidence;
  - open questions;
  - required approvals;
  - next actions.
- Show citations and source freshness for every material claim.
- Include dissenting expert-panel views.
- Generate an approval-ready artifact in Markdown, PDF, Word, or slide format.
- Track decision status: draft, under review, approved, rejected, superseded.
- Watch for assumption changes after approval.

### Example Dossiers

- "Should we renew this vendor contract or run an RFP?"
- "Should we hire two analysts or automate the reconciliation workflow?"
- "Which customer escalation should receive engineering capacity this week?"
- "Should we migrate this process from spreadsheets to a database-backed app?"
- "Should Cortex enable this automation to execute automatically?"

### UX

The user should be able to click "Create Dossier" from:

- a chat;
- an investigation workspace;
- a Business Radar alert;
- an expert panel result;
- a workflow shadow-mode recommendation.

The dossier should open as an editable artifact with side panels for sources,
approvals, assumptions, and expert reviews.

### Technical Notes

- Requires a citation model that can tie statements to source ids and timestamps.
- Should use expert panel review for high-risk decisions.
- Should support templates per business function.
- Should include a machine-readable decision record so future monitors can
  detect when assumptions change.

### Success Metrics

- Time to produce a review-ready recommendation.
- Percentage of claims with citations.
- Number of decisions with explicit owners and approval state.
- Reduction in repeated evidence-gathering work.
- Number of changed assumptions detected after decision approval.

## Investigation Workspace

Investigation Workspace is a temporary case folder that gathers related emails,
tickets, documents, metrics, meetings, alerts, notes, and actions into a single
timeline.

### Problem

When something goes wrong, the evidence is fragmented. A customer escalation may
involve CRM notes, support tickets, Slack or Teams messages, emails, deployment
logs, meeting transcripts, contract terms, dashboards, and spreadsheets. People
lose time searching, copying links, reconstructing timelines, and asking who did
what.

### Target Users

- Customer support and success teams.
- Incident managers.
- Operations and supply chain teams.
- Finance teams investigating discrepancies.
- Compliance or audit teams.
- Executives reviewing high-impact events.

### Core Capabilities

- Create a case from a prompt, alert, ticket, email, file, or meeting.
- Search across sources for related entities, dates, people, systems, customers,
  contracts, incidents, and metrics.
- Build an automatically updated timeline.
- Cluster evidence by issue, source, owner, and confidence.
- Highlight contradictions and missing evidence.
- Identify likely root causes and affected parties.
- Assign actions and track status.
- Export the investigation as a dossier or postmortem.
- Archive the case while preserving source references and audit trail.

### Example Investigations

- "Why did Customer A's renewal risk increase this week?"
- "Why did month-end close slip by three days?"
- "What caused the SLA breach for ticket queue X?"
- "Which changes preceded the revenue dashboard anomaly?"
- "What changed between the approved process and the actual process?"

### UX

An Investigation Workspace should feel like a case board:

- case summary;
- timeline;
- evidence inbox;
- entity map;
- open questions;
- contradictions;
- tasks;
- notes;
- related conversations;
- export controls.

Users should be able to pin evidence, mark irrelevant evidence, merge duplicate
events, and ask Cortex to search for missing context.

### Technical Notes

- Builds directly on workspaces but should be lighter than full Cortex
  workspaces.
- Needs scoped source permissions and temporary retention policies.
- Needs entity extraction and cross-source deduplication.
- Should store timeline events with provenance and confidence.
- Should integrate with Decision Dossier and Business Radar.

### Success Metrics

- Time to assemble the first useful timeline.
- Number of sources connected per investigation.
- Time to root-cause hypothesis.
- Number of unresolved open questions.
- Reduction in manual evidence collection.

## Automation Shadow Mode

Automation Shadow Mode lets Cortex propose and simulate actions without
executing them, then compare its recommendation to what humans actually did.

### Problem

Organizations are cautious about autonomous agents because mistakes can be
expensive. But teams still need a way to learn whether Cortex would make useful
recommendations before allowing it to act. Shadow mode creates a controlled
path from assistant to trusted automation.

### Target Users

- Automation owners.
- Operations teams.
- Finance and shared services teams.
- IT and security teams.
- Compliance reviewers.
- Managers evaluating ROI before deployment.

### Core Capabilities

- Observe a workflow or recurring decision.
- Generate proposed actions in parallel with human work.
- Simulate tool calls and business effects without writing to external systems.
- Record expected outcome, confidence, evidence, and risk.
- Compare Cortex's proposed action against the human action.
- Score correctness, usefulness, timing, risk, and missed context.
- Identify where approvals or guardrails are needed.
- Promote a successful shadow workflow to approval-gated execution.

### Example Shadow Workflows

- Invoice dispute routing.
- Support ticket prioritization.
- Renewal risk escalation.
- Incident severity classification.
- Procurement exception handling.
- Meeting follow-up creation.
- Data quality issue triage.

### UX

Shadow Mode should show:

- observed workflow;
- Cortex recommendation;
- human action;
- difference;
- outcome;
- score;
- missed evidence;
- recommended workflow changes;
- readiness for automation.

The user should be able to label a recommendation as correct, unsafe,
incomplete, late, or useful-but-needs-approval.

### Technical Notes

- Requires a run ledger that can represent proposed actions separately from
  executed actions.
- Requires read-only connectors and simulated write tools.
- Requires outcome capture, either manual or connector-based.
- Should integrate with workflow tests and evals.
- Should be the default path before enabling high-impact autonomous actions.

### Success Metrics

- Recommendation agreement rate with human decisions.
- Time saved in reviewed cases.
- Unsafe recommendation rate.
- Number of workflows promoted from shadow to approval-gated execution.
- Measured ROI before and after automation.

## Workflow Compiler

Workflow Compiler turns a successful chat or investigation into a reusable
automation with typed inputs, tools, guardrails, approval gates, and tests.

### Problem

Users often solve the same problem repeatedly in chat: gather sources, ask for
analysis, call tools, format output, send follow-up, and check results. Without
a compiler, each successful interaction remains trapped in conversation history.
Business automation requires converting repeated patterns into durable,
inspectable workflows.

### Target Users

- Power users who repeatedly perform the same analysis.
- Operations teams turning procedures into automations.
- Admins managing Cortex workflow libraries.
- Business analysts who know the process but do not want to write code.
- Developers who want a generated starting point with clear contracts.

### Core Capabilities

- Detect repeated tool-use patterns in chat history.
- Let the user select a conversation range and click "Compile Workflow."
- Infer:
  - workflow name;
  - purpose;
  - typed inputs;
  - required sources;
  - tool sequence;
  - decision points;
  - output artifact;
  - approval gates;
  - failure handling;
  - test cases.
- Generate a draft workflow definition.
- Run in dry-run mode with sample inputs.
- Add unit-like tests for tool inputs, expected evidence, and output shape.
- Version workflows and track changes.
- Publish workflows to a workspace library.

### Example Compilations

- "Every Friday, summarize open customer escalations and recommend top five
  interventions."
- "When a vendor invoice is disputed, gather contract terms, PO, email thread,
  and payment history, then draft a resolution recommendation."
- "When a dashboard metric spikes, investigate source freshness, related
  tickets, deployments, and recent meetings."
- "After each steering meeting, create decisions, owners, risks, and follow-up
  actions."

### UX

The compiler should behave like a review wizard:

1. Select conversation or case evidence.
2. Identify repeated steps.
3. Confirm inputs and sources.
4. Confirm allowed tools and write permissions.
5. Add approvals and risk level.
6. Generate tests.
7. Run dry-run.
8. Save or publish.

Generated workflows should be editable as structured forms and as code-like
definitions for advanced users.

### Technical Notes

- Start with a JSON or YAML workflow schema.
- Reuse existing plugin and tool abstractions.
- Store workflow definitions per Cortex workspace.
- Add a workflow runner separate from freeform chat.
- Integrate with background schedules.
- Add evented run records and audit logs.

### Success Metrics

- Number of workflows compiled from chat.
- Dry-run success rate.
- Workflow reuse frequency.
- Reduction in repeated manual prompts.
- Number of workflows with tests and approval gates.

## Enterprise Expert Panel

Enterprise Expert Panel expands the current expert panel into a business review
system with finance, legal, security, operations, data quality, and
customer-impact reviewers.

### Problem

Business decisions need multiple perspectives. A recommendation that is good for
speed may be bad for compliance. A cost-saving automation may harm customers.
An operational fix may create security risk. Cortex already has an expert-panel
pattern; it should become a governed review layer for business decisions and
automation.

### Target Users

- Managers preparing recommendations.
- Workflow owners evaluating automation.
- Risk, legal, security, and finance reviewers.
- Product and operations leaders.
- Executive teams reviewing major decisions.

### Expert Roles

- Finance: cost, ROI, budget impact, forecast impact, cash timing.
- Legal: contractual obligations, retention, liability, regulatory exposure.
- Security: access control, data exposure, tool risk, secret handling.
- Operations: process fit, handoffs, bottlenecks, failure modes.
- Data Quality: source freshness, schema drift, metric definitions, missing
  data, contradiction checks.
- Customer Impact: customer experience, SLA risk, churn risk, communication.
- Compliance: auditability, policy adherence, approval requirements.
- Engineering/IT: feasibility, system dependencies, implementation risk.
- Change Management: adoption, training, ownership, rollout plan.

### Core Capabilities

- Run experts against a Decision Dossier, workflow, alert, or investigation.
- Let each expert cite evidence from its allowed sources.
- Separate consensus, disagreement, blockers, and recommended mitigations.
- Support review modes:
  - quick review;
  - full approval review;
  - red-team review;
  - pre-automation review;
  - post-incident review.
- Maintain expert-specific knowledge roots and policies.
- Produce approval checklists and risk registers.

### UX

The expert panel should be available wherever a decision is being made:

- chat composer;
- dossier editor;
- workflow compiler;
- automation shadow mode;
- investigation workspace.

Users should see expert cards with recommendation, confidence, key evidence,
risks, and approval status. Disagreements should be first-class, not buried in
a summary.

### Technical Notes

- Builds on the existing `expert_panel` plugin.
- Needs expert definitions for business functions.
- Needs per-expert source restrictions and citation policies.
- Should support structured expert outputs, not only prose.
- Should store expert reviews as durable artifacts linked to decisions and
  workflows.

### Success Metrics

- Number of dossiers/workflows reviewed by experts.
- Risk issues found before execution.
- Reduction in late-stage approval rework.
- Expert disagreement resolution time.
- Audit usefulness of expert review records.

## Source Health Monitor

Source Health Monitor continuously checks connector permissions, freshness,
schema drift, broken links, empty tables, and conflicting records.

### Problem

AI reasoning fails quietly when source data is stale, incomplete, inaccessible,
or semantically changed. Users may blame the model, but the actual problem is
often a broken connector, expired token, renamed column, empty export, moved
document, changed dashboard definition, or inconsistent records across systems.

### Target Users

- Cortex admins.
- Data owners.
- Business analysts.
- Operations teams relying on automated monitors.
- Security and compliance teams.

### Core Capabilities

- Connector permission checks.
- Token and credential expiry warnings.
- Sync failure detection.
- Source freshness SLA checks.
- Schema drift detection for tables and APIs.
- Empty table or suspicious volume checks.
- Broken document links and missing file checks.
- Duplicate or conflicting record checks across systems.
- Sensitive data exposure warnings.
- Health score per source, connector, workspace, and workflow.
- Alert workflows that notify owners or disable unsafe automations.

### Example Checks

- "The Salesforce connector can no longer read opportunity stage."
- "The finance export is 0 bytes but normally contains 50,000 rows."
- "The column `gross_margin` was renamed or removed."
- "The support dashboard refreshed, but the underlying ticket API did not."
- "Two systems disagree on the renewal date for Customer A."
- "A workflow depends on a document that has been deleted or moved."

### UX

Source health should be visible from:

- a global admin dashboard;
- each connector page;
- Business Radar monitor details;
- Decision Dossier source panel;
- workflow readiness checks.

When a source is unhealthy, Cortex should mark affected answers and workflows
with a warning instead of silently proceeding.

### Technical Notes

- Depends on source registry.
- Needs connector-specific health adapters.
- Should store health events and current state.
- Should integrate with Business Radar alerts.
- Should block or require approval for workflows using unhealthy critical
  sources.
- Should expose a simple API so plugins can report health.

### Success Metrics

- Number of source failures detected before user impact.
- Mean time to repair source issues.
- Percentage of workflows with all critical sources healthy.
- Reduction in incorrect answers caused by stale or broken sources.
- Source freshness SLA compliance.

## Cross-Cutting Capabilities

### Audit And Provenance

Every important Cortex output should be traceable:

- user request;
- source ids;
- retrieval snippets;
- tool calls;
- model/provider;
- timestamps;
- generated artifact;
- approvals;
- final action;
- observed outcome.

### Permissions And Identity

Cortex should avoid a single all-powerful service identity. It needs to model
the effective user or service account behind each connector call and show the
permission boundary in answers and workflows.

### Evals

Evaluation should cover:

- retrieval relevance;
- citation correctness;
- source freshness handling;
- SQL correctness;
- workflow run success;
- action safety;
- expert review usefulness;
- cost and latency.

### Cost Controls

Business automation can become expensive if every monitor performs broad
retrieval and long-context reasoning. Add:

- source prefilters;
- smaller model routing;
- cached retrieval;
- defer-loaded tools;
- per-monitor budgets;
- per-workflow cost estimates;
- alerts for runaway jobs.

### Artifact Generation

Cortex should create durable business artifacts:

- dossiers;
- investigation timelines;
- risk registers;
- workflow definitions;
- approval records;
- source health reports;
- postmortems;
- executive briefs.

## Suggested Implementation Sequence

1. Source Registry: define source metadata, health state, and provenance ids.
2. Source Health Monitor: start with local files, workspace RAG, and one SQL
   connector.
3. Business Radar MVP: scheduled source checks with durable alert objects.
4. Decision Dossier MVP: generate Markdown dossiers from selected sources and
   chat history.
5. Workflow Run Ledger: record proposed, simulated, approved, executed, and
   failed actions.
6. Automation Shadow Mode MVP: compare Cortex recommendations with human labels.
7. Workflow Compiler MVP: convert a selected chat into a typed workflow draft.
8. Enterprise Expert Panel: add business expert definitions and structured
   review outputs.
9. Investigation Workspace: case folder, timeline, evidence pinning, export.
10. Context Graph: entity and relationship extraction across sources, then
    GraphRAG-style retrieval.

## Positioning

Cortex should be positioned as a governed business reasoning layer for people
who need to make and automate decisions across fragmented data. Its advantage is
not just model access. Its advantage should be:

- local control;
- rich connector context;
- evidence-backed reasoning;
- business process awareness;
- safe automation;
- durable memory and artifacts;
- extensible plugins and expert roles.

The strategic goal is to make Cortex the place where an organization can ask,
"What is happening, why is it happening, what should we do, who must approve it,
and can this become a reliable automation?"
