import type {} from '@matatbread/matbot-capabilities-types';
import {uiContribution} from './ui.js';
/**
 * Workflow-governance plugin: governed workflow definitions, approval-gated
 * and shadow-mode runs, evidence resolution, deterministic workflow
 * compilation, and tool-call policy enforcement. Exposes the
 * `WorkflowRegistry`, `WorkflowRunner` and `WorkflowCompiler` services plus
 * the `workflow_action` tool.
 *
 * @packageDocumentation
 */

import { createHash, randomUUID } from 'node:crypto';
import { PLUGIN_API_VERSION, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type {
  MatbotMachine,
  MatbotPluginSpec,
  Principal,
  Store,
  StoreQuery,
  Tool,
  ToolCallContext,
  ToolContext,
  ToolEvent,
  ToolResultContext,
  ObservabilityEvent,
} from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    readonly WorkflowRegistry?: WorkflowRegistry;
    readonly WorkflowRunner?: WorkflowRunner;
    readonly WorkflowCompiler?: WorkflowCompiler;
  }
}

/** Risk classification of a workflow definition. */
export type WorkflowRiskLevel = 'low' | 'medium' | 'high' | 'critical';
/** Execution mode of a run (from passive observation to live execution). */
export type WorkflowRunMode = 'dry_run' | 'shadow' | 'approval_gated' | 'execute';
/** Lifecycle status of a workflow run. */
export type WorkflowRunStatus = 'created' | 'running' | 'waiting_for_approval' | 'succeeded' | 'failed' | 'cancelled' | 'escalated';
/** Decision state of an approval request. */
export type WorkflowApprovalStatus = 'pending' | 'approved' | 'rejected' | 'escalated';
/** Review state of a proposed action within a run. */
export type WorkflowActionStatus = 'proposed' | 'approved' | 'rejected' | 'blocked' | 'executed';
/** Capability a connector-bound action requires. */
export type ConnectorCapability = 'read' | 'write' | 'admin';
/** Human verdict on a shadow-mode recommendation. */
export type ShadowComparisonOutcome = 'accepted' | 'rejected' | 'mixed' | 'unlabeled';
/** Outcome status of a compilation attempt. */
export type WorkflowCompilationStatus = 'drafted' | 'published' | 'dry_run_completed' | 'failed';
/** Fine-grained business-completion state of a run. */
export type WorkflowCompletionState = 'planned' | 'awaiting_approval' | 'approved_pending_execution' | 'executing' | 'action_succeeded' | 'business_outcome_verified' | 'failed' | 'cancelled' | 'escalated';

/**
 * A single validation failure, addressed by JSON path.
 */
export interface ValidationError {
  /** Path to the offending value (e.g. `$.approvalGates[0].id`). */
  path: string;
  /** Human-readable explanation. */
  message: string;
}

/**
 * A gate that must be cleared before (or during) execution.
 */
export interface ApprovalGate {
  /** Stable gate id within the definition. */
  id: string;
  /** What the gate guards. */
  type: 'action' | 'stale_source' | 'low_confidence' | 'cost' | 'risk' | 'expert_review';
  /** Optional human-readable explanation shown to approvers. */
  message?: string;
  /** Threshold used by threshold-based gates (confidence/cost). */
  threshold?: number;
  /** Minimum risk level triggering risk/expert-review gates. */
  requiredRiskLevel?: WorkflowRiskLevel;
}

/**
 * Evidence a run must cite before it can complete.
 */
export interface RequiredEvidence {
  /** Logical name of the evidence requirement. */
  name: string;
  /** Expected source kind. */
  sourceKind?: string;
  /** Freshness SLA applied to the cited source. */
  freshnessSlaSeconds?: number;
  /** Minimum number of citations required. */
  minCitations?: number;
}

/**
 * A stored evaluation test case for a workflow.
 */
export interface WorkflowEvalCase {
  id: string;
  version: string;
  workflowId: string;
  workspaceId: string;
  name: string;
  inputs: Record<string, unknown>;
  expected: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating or updating an eval case. */
export type WorkflowEvalCaseInput = {
  id?: string;
  name: string;
  inputs?: Record<string, unknown>;
  expected?: Record<string, unknown>;
};

/**
 * A stored workflow definition: allowed tools/connectors/sources, evidence
 * requirements, risk level and approval gates.
 */
export interface WorkflowDefinition {
  /** Stable identifier (derived from workspace + name unless overridden). */
  id: string;
  version: string;
  workspaceId: string;
  name: string;
  ownerPrincipalId: string;
  inputSchema: Record<string, unknown>;
  allowedSourceIds: string[];
  allowedConnectorInstanceIds: string[];
  allowedTools: string[];
  requiredEvidence: RequiredEvidence[];
  riskLevel: WorkflowRiskLevel;
  approvalGates: ApprovalGate[];
  dryRunDefault: boolean;
  tests: WorkflowEvalCaseInput[];
  successMetrics: string[];
  createdAt: string;
  updatedAt: string;
  description?: string;
  triggerSchema?: Record<string, unknown>;
}

/** Input for creating/updating a workflow definition (omitted fields preserved). */
export type WorkflowDefinitionInput = {
  id?: string;
  workspaceId: string;
  name: string;
  ownerPrincipalId?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  triggerSchema?: Record<string, unknown>;
  allowedSourceIds?: string[];
  allowedConnectorInstanceIds?: string[];
  allowedTools?: string[];
  requiredEvidence?: RequiredEvidence[];
  riskLevel?: WorkflowRiskLevel;
  approvalGates?: ApprovalGate[];
  dryRunDefault?: boolean;
  tests?: WorkflowEvalCaseInput[];
  successMetrics?: string[];
};

/**
 * A frozen snapshot of a workflow definition at a specific version, addressable by a deterministic version-record id.
 */
export interface WorkflowVersion {
  id: string;
  version: string;
  workflowId: string;
  workflowVersion: string;
  workspaceId: string;
  definition: WorkflowDefinition;
  createdAt: string;
}

/**
 * A resolved evidence citation for a run: the cited source, its text/version, observation time and any health/staleness warning observed at resolution.
 */
export interface EvidenceReference {
  sourceId: string;
  citationText?: string;
  sourceVersionId?: string;
  observedAt?: string;
  healthState?: string;
  stalenessState?: string;
  warning?: string;
}

/**
 * A proposed tool call within a run, carrying its capability, approval state and optional risk/confidence/cost metadata.
 */
export interface ActionProposal {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  capability: ConnectorCapability;
  status: WorkflowActionStatus;
  sourceIds: string[];
  requiresApproval: boolean;
  reason?: string;
  connectorInstanceId?: string;
  riskLevel?: WorkflowRiskLevel;
  confidence?: number;
  costEstimateUsd?: number;
}

/**
 * Input for proposing an action on a run; omitted capability/connector metadata is filled in during proposal normalization.
 */
export type ActionProposalInput = {
  id?: string;
  toolName: string;
  input?: Record<string, unknown>;
  capability?: ConnectorCapability;
  sourceIds?: string[];
  reason?: string;
  connectorInstanceId?: string;
  riskLevel?: WorkflowRiskLevel;
  confidence?: number;
  costEstimateUsd?: number;
};

/**
 * The outcome of one executed (approved) action.
 */
export interface ExecutedAction {
  id: string;
  proposalId: string;
  toolName: string;
  status: 'succeeded' | 'failed';
  executedAt: string;
  resultHash?: string;
  error?: string;
}

/**
 * The full ledger state of a workflow run: mode, status and fine-grained completion state, inputs, resolved evidence, proposed/executed actions, labels and trace context.
 */
export interface WorkflowRun {
  id: string;
  version: string;
  workflowId: string;
  workflowVersion: string;
  workspaceId: string;
  principalId: string;
  mode: WorkflowRunMode;
  status: WorkflowRunStatus;
  completionState: WorkflowCompletionState;
  inputs: Record<string, unknown>;
  evidenceSourceIds: string[];
  evidenceSourceVersions: EvidenceReference[];
  proposedActions: ActionProposal[];
  executedActions: ExecutedAction[];
  labels: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  traceId?: string;
  rootTraceId?: string;
  parentSpanId?: string;
  outcomeId?: string;
}

/**
 * An append-only, per-run sequenced audit event recorded whenever a run changes state.
 */
export interface WorkflowRunEvent {
  id: string;
  version: string;
  runId: string;
  sequence: number;
  eventType: string;
  timestamp: string;
  payload: Record<string, unknown>;
  principalId?: string;
  toolCallId?: string;
  sourceIds?: string[];
}

/**
 * A human approval decision requested for a run or action.
 */
export interface WorkflowApproval {
  id: string;
  version: string;
  runId: string;
  workflowId: string;
  status: WorkflowApprovalStatus;
  requestedAt: string;
  updatedAt: string;
  gateId?: string;
  proposalId?: string;
  principalId?: string;
  decidedAt?: string;
  decidedByPrincipalId?: string;
  reason?: string;
  message?: string;
  dueAt?: string;
  escalatedAt?: string;
  escalationReason?: string;
}

/**
 * The recorded comparison of a shadow-run recommendation against human labels.
 */
export interface WorkflowShadowComparison {
  id: string;
  version: string;
  runId: string;
  workflowId: string;
  workflowVersion: string;
  workspaceId: string;
  principalId: string;
  recommendationHash: string;
  proposedActionIds: string[];
  proposedToolNames: string[];
  sourceIds: string[];
  humanLabels: string[];
  outcome: ShadowComparisonOutcome;
  score: number;
  comparedAt: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

/**
 * Aggregate acceptance statistics over shadow comparisons.
 */
export interface WorkflowShadowSummary {
  total: number;
  accepted: number;
  rejected: number;
  mixed: number;
  unlabeled: number;
  acceptanceRate: number;
  byWorkflow: Array<{
    workflowId: string;
    total: number;
    accepted: number;
    rejected: number;
    mixed: number;
    unlabeled: number;
    acceptanceRate: number;
  }>;
}

/** A message (or tool call) excerpt supplied to the compiler. */
export interface WorkflowCompilerMessage {
  role?: string;
  text?: string;
  content?: unknown;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  sourceIds?: string[];
  timestamp?: string;
}

/**
 * A declaration of one workflow input, used to build the definition's input schema and dry-run sample inputs.
 */
export type WorkflowInputHint = {
  name: string;
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  required?: boolean;
  sample?: unknown;
};

/**
 * A tool call supplied to the compiler as evidence of the actions a workflow should govern.
 */
export type WorkflowCompilerToolCall = {
  toolName: string;
  input?: Record<string, unknown>;
  capability?: ConnectorCapability;
  connectorInstanceId?: string;
  sourceIds?: string[];
  reason?: string;
  confidence?: number;
  costEstimateUsd?: number;
};

/**
 * Everything the compiler needs to draft a workflow: workspace and naming, transcript/message/tool-call evidence, input hints, risk and gate overrides, and the publish/dry-run switches.
 */
export type WorkflowCompileInput = {
  workspaceId: string;
  name?: string;
  purpose?: string;
  transcript?: string;
  messages?: WorkflowCompilerMessage[];
  sourceIds?: string[];
  toolCalls?: WorkflowCompilerToolCall[];
  inputHints?: WorkflowInputHint[];
  riskLevel?: WorkflowRiskLevel;
  approvalGates?: ApprovalGate[];
  successMetrics?: string[];
  publish?: boolean;
  dryRun?: boolean;
  sampleInputs?: Record<string, unknown>;
  labels?: string[];
};

/**
 * A stored compilation attempt: the draft definition, its validation, derived sources/tools/proposals and the status of any publish/dry-run stages.
 */
export interface WorkflowCompilation {
  id: string;
  version: string;
  workspaceId: string;
  status: WorkflowCompilationStatus;
  compilerVersion: string;
  inputHash: string;
  definition: WorkflowDefinitionInput;
  validation: ValidationError[];
  sourceIds: string[];
  toolNames: string[];
  proposedActions: ActionProposalInput[];
  sampleInputs: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  workflowId?: string;
  workflowVersion?: string;
  dryRunId?: string;
  warnings?: string[];
}

/**
 * The result of compiling a workflow from conversation/tool-call evidence.
 */
export interface WorkflowCompileResult {
  compilation: WorkflowCompilation;
  definition: WorkflowDefinitionInput;
  validation: ValidationError[];
  published?: { definition: WorkflowDefinition; version: WorkflowVersion };
  dryRun?: WorkflowRun;
}

/** Input for starting a workflow run. */
export type StartWorkflowInput = {
  workflowId?: string;
  workflowName?: string;
  workflowVersion?: string;
  workspaceId: string;
  mode?: WorkflowRunMode;
  inputs?: Record<string, unknown>;
  evidenceSourceIds?: string[];
  proposedActions?: ActionProposalInput[];
  labels?: string[];
  traceId?: string;
  rootTraceId?: string;
  parentSpanId?: string;
};

/**
 * Verdict of the tool-call policy check for a workflow-scoped call.
 */
export type WorkflowPolicyDecision = {
  allowed: boolean;
  active: boolean;
  reason?: string;
  run?: WorkflowRun;
  capability?: ConnectorCapability;
};

/**
 * The workflow definition registry: stable ids, validation and CRUD over
 * definitions, versions and eval cases.
 */
export interface WorkflowRegistry {
  /**
   * Derives the deterministic id for a definition name.
   */
  stableWorkflowId(workspaceId: string, name: string): string;
  /**
   * Derives the deterministic id for a definition version.
   */
  stableWorkflowVersionId(workflowId: string, workflowVersion: string): string;
  validateDefinition(input: WorkflowDefinitionInput | WorkflowDefinition): ValidationError[];
  upsertDefinition(input: WorkflowDefinitionInput): Promise<{ definition: WorkflowDefinition; version: WorkflowVersion; validation: ValidationError[] }>;
  getDefinition(id: string): Promise<WorkflowDefinition | null>;
  getVersion(id: string): Promise<WorkflowVersion | null>;
  definitionByName(workspaceId: string, name: string): Promise<WorkflowDefinition | null>;
  queryDefinitions(query?: StoreQuery): Promise<WorkflowDefinition[]>;
  queryVersions(query?: StoreQuery): Promise<WorkflowVersion[]>;
  queryEvalCases(query?: StoreQuery): Promise<WorkflowEvalCase[]>;
}

/**
 * The run engine: starts runs (dry-run/shadow/approval-gated), manages
 * approvals and escalation, records executed tool results, labels/compares
 * shadow recommendations, and evaluates per-call tool policy.
 */
export interface WorkflowRunner {
  startRun(input: StartWorkflowInput): Promise<WorkflowRun>;
  approveRun(runId: string, approvalId?: string, reason?: string): Promise<{ run: WorkflowRun; approvals: WorkflowApproval[] }>;
  rejectRun(runId: string, approvalId?: string, reason?: string): Promise<{ run: WorkflowRun; approvals: WorkflowApproval[] }>;
  escalateRun(runId: string, reason: string): Promise<{ run: WorkflowRun; approvals: WorkflowApproval[] }>;
  recordBusinessOutcome(runId: string, outcomeId: string, status: 'verified_completed' | 'estimated_completed' | 'failed' | 'cancelled' | 'escalated'): Promise<WorkflowRun>;
  labelShadowResult(runId: string, labels: string[], note?: string): Promise<WorkflowRun>;
  compareShadowRun(runId: string, labels?: string[], note?: string): Promise<{ run: WorkflowRun; comparison: WorkflowShadowComparison }>;
  shadowComparisons(query?: StoreQuery): Promise<WorkflowShadowComparison[]>;
  shadowSummary(query?: StoreQuery): Promise<WorkflowShadowSummary>;
  recordToolResult(runId: string, toolName: string, result: unknown, isError: boolean, durationMs?: number): Promise<void>;
  inspectRun(runId: string): Promise<{ run: WorkflowRun | null; events: WorkflowRunEvent[]; approvals: WorkflowApproval[] }>;
  listRuns(query?: StoreQuery): Promise<WorkflowRun[]>;
  listApprovals(query?: StoreQuery): Promise<WorkflowApproval[]>;
  evaluateToolPolicy(toolName: string, input: unknown, principal?: Principal): Promise<WorkflowPolicyDecision>;
}

/**
 * The deterministic compiler service: derives a workflow definition from a
 * transcript/tool-call selection, optionally publishing it and running a
 * dry run.
 */
export interface WorkflowCompiler {
  stableCompilationId(input: WorkflowCompileInput): string;
  compile(input: WorkflowCompileInput): Promise<WorkflowCompileResult>;
  getCompilation(id: string): Promise<WorkflowCompilation | null>;
  queryCompilations(query?: StoreQuery): Promise<WorkflowCompilation[]>;
}

/**
 * Minimal source-registry surface the runner consumes when present, for evidence citation, freshness checks and access recording.
 */
interface SourceRegistryLike {
  getSource(id: string): Promise<{
    id: string;
    workspaceId: string;
    sourceKind: string;
    title: string;
    healthState: string;
    stalenessState: string;
    freshnessSlaSeconds?: number;
  } | null>;
  resolveCitation(sourceId: string, versionId?: string): Promise<{
    sourceId: string;
    text: string;
    versionId?: string;
    observedAt?: string;
  }>;
  sourceVersions?(sourceId?: string): Promise<Array<{ id: string; observedAt: string }>>;
  recordAccess(input: {
    sourceId: string;
    action: 'read' | 'retrieve' | 'cite' | 'write' | 'delete' | 'health_check';
    allowed: boolean;
    principalId?: string;
    workflowRunId?: string;
    message?: string;
  }): Promise<unknown>;
}

/**
 * Minimal connector-registry surface the runner consumes when present, to evaluate tool calls against bound connector instances.
 */
interface ConnectorRegistryLike {
  evaluateToolCall(input: {
    toolName: string;
    input: unknown;
    principal?: Principal;
  }): Promise<{
    bound: boolean;
    allowed: boolean;
    capability?: ConnectorCapability;
    reason?: string;
    connectorInstance?: { id: string; workspaceId: string };
  }>;
}

/**
 * Minimal observability sink used to mirror workflow run events as trace events.
 */
interface ObservabilityLike {
  record(event: ObservabilityEvent): void | Promise<void>;
}

/**
 * The canonical JSON Schema describing a workflow definition input.
 */
export const WORKFLOW_DEFINITION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['workspaceId', 'name'],
  properties: {
    workspaceId: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    ownerPrincipalId: { type: 'string' },
    description: { type: 'string' },
    inputSchema: { type: 'object' },
    triggerSchema: { type: 'object' },
    allowedSourceIds: { type: 'array', items: { type: 'string' } },
    allowedConnectorInstanceIds: { type: 'array', items: { type: 'string' } },
    allowedTools: { type: 'array', items: { type: 'string' } },
    requiredEvidence: { type: 'array', items: { type: 'object' } },
    riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    approvalGates: { type: 'array', items: { type: 'object' } },
    dryRunDefault: { type: 'boolean' },
    tests: { type: 'array', items: { type: 'object' } },
    successMetrics: { type: 'array', items: { type: 'string' } },
  },
};

const DEFINITION_STORE = 'workflow_definitions';
const VERSION_STORE = 'workflow_versions';
const RUN_STORE = 'workflow_runs';
const EVENT_STORE = 'workflow_run_events';
const APPROVAL_STORE = 'workflow_approvals';
const EVAL_CASE_STORE = 'workflow_eval_cases';
const SHADOW_COMPARISON_STORE = 'workflow_shadow_comparisons';
const COMPILATION_STORE = 'workflow_compilations';
const RISK_ORDER: WorkflowRiskLevel[] = ['low', 'medium', 'high', 'critical'];
const WORKFLOW_COMPILER_VERSION = 'deterministic-workflow-compiler-v1';

/**
 * Returns the current wall-clock time as an ISO 8601 UTC timestamp.
 * @returns Current time in `YYYY-MM-DDTHH:mm:ss.sssZ` format.
 * @throws Never.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Computes the approval deadline for a request. The SLA defaults to 24 hours and can be overridden by the `CORTEX_APPROVAL_SLA_HOURS` environment variable; non-numeric or non-positive values fall back to the default.
 * @param requestedAt - ISO 8601 timestamp at which the approval was requested.
 * @returns ISO 8601 deadline timestamp, `requestedAt` plus the SLA.
 * @throws RangeError - If `requestedAt` cannot be parsed as a date.
 */
function approvalDueAt(requestedAt: string): string {
  const configured = Number(process.env['CORTEX_APPROVAL_SLA_HOURS'] ?? 24);
  const hours = Number.isFinite(configured) && configured > 0 ? configured : 24;
  return new Date(Date.parse(requestedAt) + hours * 3_600_000).toISOString();
}

/**
 * Derives a deterministic, collision-resistant identifier from the joined parts.
 * @param prefix - Namespace prefix prepended to the hash (e.g. `workflow-definition`).
 * @param parts - Ordered components hashed together; joined with a `NUL` separator so boundary shifts change the hash.
 * @returns Identifier of the form `<prefix>:<hash>`, where `<hash>` is the first 32 hex characters of the SHA-256 digest.
 * @throws Never.
 */
function hashId(prefix: string, parts: readonly string[]): string {
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `${prefix}:${hash}`;
}

/**
 * Hashes an arbitrary value over its canonical JSON encoding (see {@link canonicalJson}).
 * @param value - Value to hash; must be JSON-serializable.
 * @returns Full 64-character hex SHA-256 digest of the canonical JSON.
 * @throws TypeError - If `value` is not JSON-serializable (circular references, BigInt, and similar).
 */
function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Serializes a value to JSON with object keys recursively sorted, so structurally equal values always produce byte-identical strings.
 * @param value - Value to serialize.
 * @returns Deterministic JSON string.
 * @throws TypeError - If `value` contains circular references or other values JSON cannot serialize.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForJson(value));
}

/**
 * Recursively sorts object entries by key (arrays keep their order; primitives pass through) to prepare a value for canonical JSON serialization.
 * @param value - Value to normalize.
 * @returns Structurally identical value with object keys sorted at every level.
 * @throws Never.
 */
function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortForJson(item)]));
  }
  return value;
}

/**
 * Normalizes a free-form name into a snake_case identifier: trims, lowercases, collapses non-alphanumeric runs to `_`, and strips leading/trailing underscores.
 * @param value - Raw name to normalize.
 * @returns Normalized name, or `unnamed` when nothing usable remains.
 * @throws Never.
 */
function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

/**
 * Deduplicates string values while preserving first-occurrence order.
 * @param values - Values to deduplicate; entries are trimmed and empty strings dropped.
 * @returns Trimmed, non-empty values in first-occurrence order.
 * @throws Never.
 */
function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

/**
 * Normalizes human labels into canonical snake_case form via {@link normalizeName}, then deduplicates.
 * @param labels - Raw label strings.
 * @returns Deduplicated normalized labels in first-occurrence order.
 * @throws Never.
 */
function normalizedLabels(labels: readonly string[]): string[] {
  return uniq(labels.map(label => normalizeName(label)));
}

/**
 * Classifies normalized human labels into a shadow-comparison verdict: an accept synonym plus a reject synonym yields `mixed` (score 0.5), accept-only `accepted` (1), reject-only `rejected` (0), and no recognized label `unlabeled` (0).
 * @param labels - Raw label strings; normalized before matching.
 * @returns The outcome and its score in the range [0, 1].
 * @throws Never.
 */
function classifyShadowLabels(labels: readonly string[]): { outcome: ShadowComparisonOutcome; score: number } {
  const normalized = new Set(normalizedLabels(labels));
  if (normalized.size === 0) return { outcome: 'unlabeled', score: 0 };
  const accepted = [
    'accepted',
    'approve',
    'approved',
    'correct',
    'good',
    'useful',
    'true_positive',
    'would_execute',
    'match',
  ].some(label => normalized.has(label));
  const rejected = [
    'rejected',
    'reject',
    'incorrect',
    'bad',
    'not_useful',
    'false_positive',
    'would_not_execute',
    'no_action',
    'mismatch',
  ].some(label => normalized.has(label));
  if (accepted && rejected) return { outcome: 'mixed', score: 0.5 };
  if (accepted) return { outcome: 'accepted', score: 1 };
  if (rejected) return { outcome: 'rejected', score: 0 };
  return { outcome: 'mixed', score: 0.5 };
}

/**
 * Creates a zeroed shadow-acceptance summary with no per-workflow breakdown.
 * @returns Empty {@link WorkflowShadowSummary}.
 * @throws Never.
 */
function emptyShadowSummary(): WorkflowShadowSummary {
  return {
    total: 0,
    accepted: 0,
    rejected: 0,
    mixed: 0,
    unlabeled: 0,
    acceptanceRate: 0,
    byWorkflow: [],
  };
}

/**
 * Extracts plain text from a compiler message: prefers `text`, then string `content`, then joins string or `{ text }` items of array content with newlines.
 * @param message - Message to render.
 * @returns Extracted text, or an empty string when the message carries none.
 * @throws Never.
 */
function messageText(message: WorkflowCompilerMessage): string {
  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map(item => {
      if (typeof item === 'string') return item;
      if (isPlainRecord(item) && typeof item['text'] === 'string') return item['text'];
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

/**
 * Flattens all compilation input text into one blob: purpose, transcript, rendered messages, and one `toolName + canonical input JSON` line per tool call. Used for name/purpose inference and `{{placeholder}}` detection.
 * @param input - Compilation input.
 * @returns Concatenated non-empty segments joined by newlines.
 * @throws Never.
 */
function compileText(input: WorkflowCompileInput): string {
  return [
    input.purpose ?? '',
    input.transcript ?? '',
    ...(input.messages ?? []).map(messageText),
    ...(input.toolCalls ?? []).map(call => `${call.toolName} ${canonicalJson(call.input ?? {})}`),
  ].filter(Boolean).join('\n');
}

/**
 * Extracts the first non-empty sentence-like fragment of a text, stripping markdown punctuation characters and collapsing whitespace.
 * @param text - Raw text.
 * @returns Cleaned first fragment, or an empty string when the text has none.
 * @throws Never.
 */
function sentenceFragment(text: string): string {
  const first = text.split(/\r?\n|[.!?]/).map(item => item.trim()).find(Boolean) ?? '';
  return first.replace(/[`*_#:[\](){}]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Derives a Title Case workflow title from the first words of a text.
 * @param text - Raw text to title-ize.
 * @returns Up to seven Title Cased words joined by spaces, or `Compiled Workflow` when no words remain.
 * @throws Never.
 */
function titleFromText(text: string): string {
  const words = sentenceFragment(text).split(/\s+/).filter(Boolean).slice(0, 7);
  const title = words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  return title || 'Compiled Workflow';
}

/**
 * Resolves the workflow name for a compilation: the explicit `name` when non-blank, otherwise a title derived from the purpose, transcript or compiled text.
 * @param input - Compilation input.
 * @returns Trimmed workflow name.
 * @throws Never.
 */
function inferWorkflowName(input: WorkflowCompileInput): string {
  if (input.name !== undefined && input.name.trim()) return input.name.trim();
  return titleFromText(input.purpose ?? input.transcript ?? compileText(input));
}

/**
 * Resolves the workflow description for a compilation: the explicit `purpose` when non-blank, otherwise the first sentence of the transcript or compiled text prefixed with `Compiled from selected conversation:`.
 * @param input - Compilation input.
 * @returns Purpose text, or `undefined` when nothing usable was supplied.
 * @throws Never.
 */
function inferWorkflowPurpose(input: WorkflowCompileInput): string | undefined {
  if (input.purpose !== undefined && input.purpose.trim()) return input.purpose.trim();
  const fragment = sentenceFragment(input.transcript ?? compileText(input));
  return fragment ? `Compiled from selected conversation: ${fragment}` : undefined;
}

/**
 * Scans text for `{{name}}` placeholders and converts each unique identifier-like name into a required string input hint.
 * @param text - Text to scan (typically {@link compileText} output).
 * @returns One hint per unique placeholder in first-occurrence order, all typed `string` and required.
 * @throws Never.
 */
function inputHintsFromText(text: string): WorkflowInputHint[] {
  const placeholders = [...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map(match => match[1] ?? '');
  return uniq(placeholders).map(name => ({ name, type: 'string' as const, required: true }));
}

/**
 * Sanitizes a raw input name into an identifier: trims, replaces non-alphanumeric runs with `_`, and strips leading/trailing underscores.
 * @param value - Raw input name.
 * @returns Sanitized name, or `input` when nothing usable remains.
 * @throws Never.
 */
function cleanInputName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'input';
}

/**
 * Merges inferred `{{placeholder}}` hints with explicit `inputHints`, keyed by normalized name: later entries win, and unspecified fields (type, description, required, sample) inherit from earlier entries, defaulting to type `string` and `required: true`.
 * @param input - Compilation input.
 * @returns Merged hints in first-seen order.
 * @throws Never.
 */
function normalizeInputHints(input: WorkflowCompileInput): WorkflowInputHint[] {
  const explicit = input.inputHints ?? [];
  const inferred = inputHintsFromText(compileText(input));
  const byName = new Map<string, WorkflowInputHint>();
  for (const hint of [...inferred, ...explicit]) {
    const name = cleanInputName(hint.name);
    const key = normalizeName(name);
    byName.set(key, {
      name,
      type: hint.type ?? byName.get(key)?.type ?? 'string',
      ...(hint.description ?? byName.get(key)?.description !== undefined ? { description: (hint.description ?? byName.get(key)?.description)! } : {}),
      required: hint.required ?? byName.get(key)?.required ?? true,
      ...(hint.sample ?? byName.get(key)?.sample !== undefined ? { sample: (hint.sample ?? byName.get(key)?.sample)! } : {}),
    });
  }
  return [...byName.values()];
}

/**
 * Builds a JSON Schema object from input hints: one property per hint (type defaulting to `string`) and a `required` list of every hint not explicitly optional.
 * @param hints - Hints to translate.
 * @returns JSON Schema with `type: 'object'`; the `required` list is omitted when empty.
 * @throws Never.
 */
function schemaForInputHints(hints: readonly WorkflowInputHint[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const hint of hints) {
    properties[hint.name] = {
      type: hint.type ?? 'string',
      ...(hint.description !== undefined ? { description: hint.description } : {}),
    };
    if (hint.required !== false) required.push(hint.name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Returns a minimal placeholder sample value for a JSON Schema type, used when an input hint supplies no `sample`.
 * @param type - Hint type; `undefined` (or any unrecognized value) is treated as `string`.
 * @returns `1` for number/integer, `true` for boolean, `[]` for array, `{}` for object, and `'sample'` otherwise.
 * @throws Never.
 */
function defaultSampleForType(type: WorkflowInputHint['type']): unknown {
  if (type === 'number') return 1;
  if (type === 'integer') return 1;
  if (type === 'boolean') return true;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return 'sample';
}

/**
 * Builds sample workflow inputs for compiled dry runs: each hint's `sample` or its type default, overlaid by explicit `input.sampleInputs` overrides.
 * @param input - Compilation input providing optional `sampleInputs` overrides.
 * @param hints - Normalized input hints.
 * @returns Sample input object; explicit overrides win over derived samples.
 * @throws Never.
 */
function sampleInputsForCompile(input: WorkflowCompileInput, hints: readonly WorkflowInputHint[]): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const hint of hints) {
    sample[hint.name] = hint.sample ?? defaultSampleForType(hint.type);
  }
  return { ...sample, ...(input.sampleInputs ?? {}) };
}

/**
 * Collects the union of source ids from the input's explicit `sourceIds`, per-message `sourceIds` and per-tool-call `sourceIds`.
 * @param input - Compilation input.
 * @returns Deduplicated source ids in first-occurrence order.
 * @throws Never.
 */
function compileSourceIds(input: WorkflowCompileInput): string[] {
  return uniq([
    ...(input.sourceIds ?? []),
    ...(input.messages ?? []).flatMap(message => message.sourceIds ?? []),
    ...(input.toolCalls ?? []).flatMap(call => call.sourceIds ?? []),
  ]);
}

/**
 * Collects the tool calls a compilation should govern: explicit `toolCalls` first, then tool-bearing messages converted into calls (tool name with optional input and source ids).
 * @param input - Compilation input.
 * @returns Direct calls followed by message-derived calls in message order.
 * @throws Never.
 */
function compileToolCalls(input: WorkflowCompileInput): WorkflowCompilerToolCall[] {
  const direct = input.toolCalls ?? [];
  const messageCalls = (input.messages ?? [])
    .filter(message => message.toolName !== undefined)
    .map(message => ({
      toolName: message.toolName!,
      ...(message.toolInput !== undefined ? { input: message.toolInput } : {}),
      ...(message.sourceIds !== undefined ? { sourceIds: message.sourceIds } : {}),
    }));
  return [...direct, ...messageCalls];
}

/**
 * Converts the collected tool calls into action proposals: capability defaults to {@link inferCapability} and source ids are deduplicated; optional fields (connectorInstanceId, reason, confidence, costEstimateUsd) are carried through only when present.
 * @param input - Compilation input.
 * @returns One proposal per tool call, in call order.
 * @throws Never.
 */
function compiledProposals(input: WorkflowCompileInput): ActionProposalInput[] {
  return compileToolCalls(input).map(call => ({
    toolName: call.toolName,
    input: call.input ?? {},
    capability: call.capability ?? inferCapability(call.input ?? {}),
    sourceIds: uniq(call.sourceIds ?? []),
    ...(call.connectorInstanceId !== undefined ? { connectorInstanceId: call.connectorInstanceId } : {}),
    ...(call.reason !== undefined ? { reason: call.reason } : {}),
    ...(call.confidence !== undefined ? { confidence: call.confidence } : {}),
    ...(call.costEstimateUsd !== undefined ? { costEstimateUsd: call.costEstimateUsd } : {}),
  }));
}

/**
 * Determines the compiled workflow's risk level: explicit `input.riskLevel` wins; otherwise `critical` when any proposal is admin-capable, `high` when any is write-capable, `medium` when source ids are present, and `low` otherwise.
 * @param input - Compilation input.
 * @param proposals - Compiled action proposals.
 * @returns Effective risk level.
 * @throws Never.
 */
function inferCompilerRisk(input: WorkflowCompileInput, proposals: readonly ActionProposalInput[]): WorkflowRiskLevel {
  if (input.riskLevel !== undefined) return input.riskLevel;
  if (proposals.some(proposal => proposal.capability === 'admin')) return 'critical';
  if (proposals.some(proposal => proposal.capability === 'write')) return 'high';
  if (compileSourceIds(input).length > 0) return 'medium';
  return 'low';
}

/**
 * Derives the default approval gates when a compilation input supplies none: an action gate when any proposal is not read-only, a stale-source gate when evidence sources exist, risk and expert-review gates at high risk or above, a low-confidence gate with an 0.8 threshold, and a cost gate when any proposal carries a positive cost estimate.
 * @param riskLevel - Effective risk level (see {@link inferCompilerRisk}).
 * @param proposals - Compiled action proposals.
 * @param sourceIds - Compiled evidence source ids.
 * @returns Gate list in the fixed order described above; possibly empty.
 * @throws Never.
 */
function defaultApprovalGates(riskLevel: WorkflowRiskLevel, proposals: readonly ActionProposalInput[], sourceIds: readonly string[]): ApprovalGate[] {
  const gates: ApprovalGate[] = [];
  if (proposals.some(proposal => proposal.capability !== 'read')) {
    gates.push({ id: 'approve-action', type: 'action' });
  }
  if (sourceIds.length > 0) gates.push({ id: 'approve-stale-source', type: 'stale_source' });
  if (riskAtLeast(riskLevel, 'high')) gates.push({ id: 'approve-risk', type: 'risk', requiredRiskLevel: 'high' });
  if (riskAtLeast(riskLevel, 'high')) gates.push({ id: 'structured-expert-review', type: 'expert_review', requiredRiskLevel: 'high' });
  if (proposals.some(proposal => proposal.confidence !== undefined && proposal.confidence < 0.8)) {
    gates.push({ id: 'approve-low-confidence', type: 'low_confidence', threshold: 0.8 });
  }
  if (proposals.some(proposal => proposal.costEstimateUsd !== undefined && proposal.costEstimateUsd > 0)) {
    gates.push({ id: 'approve-cost', type: 'cost', threshold: 0 });
  }
  return gates;
}

/**
 * Deterministically compiles a full workflow definition from a compilation input: derives name, purpose, input schema (hints plus `{{placeholders}}`), allowed sources/connectors/tools, required evidence, risk level, default approval gates, sample inputs and an embedded dry-run smoke test. Missing tool calls, sources or hints are reported as warnings rather than failures.
 * @param input - Compilation input.
 * @returns The draft definition plus its derived source ids, proposals, sample inputs and warnings.
 * @throws Never.
 */
function compileWorkflowDefinition(input: WorkflowCompileInput): {
  definition: WorkflowDefinitionInput;
  sourceIds: string[];
  proposals: ActionProposalInput[];
  sampleInputs: Record<string, unknown>;
  warnings: string[];
} {
  const text = compileText(input);
  const hints = normalizeInputHints(input);
  const sourceIds = compileSourceIds(input);
  const proposals = compiledProposals(input);
  const riskLevel = inferCompilerRisk(input, proposals);
  const sampleInputs = sampleInputsForCompile(input, hints);
  const toolNames = uniq(proposals.map(proposal => proposal.toolName));
  const connectorIds = uniq(proposals.map(proposal => proposal.connectorInstanceId ?? '').filter(Boolean));
  const purpose = inferWorkflowPurpose(input);
  const warnings: string[] = [];
  if (toolNames.length === 0) warnings.push('No tool calls were supplied; compiled workflow will only validate inputs and evidence.');
  if (sourceIds.length === 0) warnings.push('No source ids were supplied; compiled workflow has no required evidence yet.');
  if (hints.length === 0) warnings.push('No input hints or {{placeholders}} were found; compiled workflow accepts an empty input object.');
  const definition: WorkflowDefinitionInput = {
    workspaceId: input.workspaceId,
    name: inferWorkflowName(input),
    inputSchema: schemaForInputHints(hints),
    allowedSourceIds: sourceIds,
    allowedConnectorInstanceIds: connectorIds,
    allowedTools: toolNames,
    requiredEvidence: sourceIds.length > 0 ? [{ name: 'compiled-evidence', minCitations: sourceIds.length }] : [],
    riskLevel,
    approvalGates: input.approvalGates ?? defaultApprovalGates(riskLevel, proposals, sourceIds),
    dryRunDefault: true,
    tests: [{
      name: 'compiled dry-run smoke test',
      inputs: sampleInputs,
      expected: {
        mode: 'dry_run',
        proposedActionCount: proposals.length,
        requiredEvidenceCount: sourceIds.length,
      },
    }],
    successMetrics: uniq(input.successMetrics ?? ['dry_run_success_rate', 'approval_acceptance_rate']),
    ...(purpose !== undefined ? { description: purpose } : {}),
    ...(input.labels !== undefined && input.labels.length > 0 ? { triggerSchema: { type: 'object', properties: { labels: { type: 'array' } } } } : {}),
  };
  if (text.trim().length === 0 && input.name === undefined) warnings.push('Compilation input did not include transcript text; used a generic workflow name.');
  return { definition, sourceIds, proposals, sampleInputs, warnings };
}

/**
 * Resolves the acting principal id from the ambient security scope (see {@link tryCurrentPrincipal}).
 * @returns The current principal's id, or `system` when no principal scope is active.
 * @throws Never.
 */
function principalId(): string {
  return tryCurrentPrincipal()?.id ?? 'system';
}

/**
 * Runs a store query and returns the matching items.
 * @typeParam T - Store record type; must carry `id` and `version` fields.
 * @param store - Store to query.
 * @param query - Filter/sort to apply; an empty query (matching everything) is used when omitted.
 * @returns Promise of the query result's `items`, in the store/query-determined order.
 * @throws Never.
 */
function queryAll<T extends { id: string; version: string }>(store: Store<T>, query?: StoreQuery): Promise<T[]> {
  return store.query(query ?? {}).then(result => result.items);
}

/**
 * Compares risk levels by their ordering (low < medium < high < critical).
 * @param value - Level to test.
 * @param required - Minimum level to meet or exceed.
 * @returns `true` when `value` is at least as severe as `required`.
 * @throws Never.
 */
function riskAtLeast(value: WorkflowRiskLevel, required: WorkflowRiskLevel): boolean {
  return RISK_ORDER.indexOf(value) >= RISK_ORDER.indexOf(required);
}

/**
 * Type guard for plain (non-null, non-array) object values.
 * @param value - Value to test.
 * @returns `true` when `value` is a non-null, non-array object.
 * @throws Never.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Distinguishes `undefined` from a present value so optional record fields can be conditionally spread without violating `exactOptionalPropertyTypes`.
 * @typeParam T - Value type.
 * @param value - Value to wrap.
 * @returns `{ include: false }` for `undefined`; otherwise `{ include: true, value }`.
 * @throws Never.
 */
function optional<T>(value: T | undefined): { include: false } | { include: true; value: T } {
  return value === undefined ? { include: false } : { include: true, value };
}

/**
 * Returns a shallow copy of `base` with `key` set to `value`, or `base` unchanged when `value` is `undefined` — the conditional-spread helper for optional fields.
 * @typeParam T - Base record type.
 * @typeParam K - Key name.
 * @typeParam V - Value type.
 * @param base - Record to copy.
 * @param key - Optional field name.
 * @param value - Field value; `undefined` leaves the field out of the copy entirely.
 * @returns Copy of `base` with the optional field applied when present.
 * @throws Never.
 */
function withOptional<T extends Record<string, unknown>, K extends string, V>(
  base: T,
  key: K,
  value: V | undefined,
): T & Partial<Record<K, V>> {
  const opt = optional(value);
  return (opt.include ? { ...base, [key]: opt.value } : base) as T & Partial<Record<K, V>>;
}

/**
 * Recursively validates a value against a subset of JSON Schema: `type`, `minLength`, `enum`, `required`, nested `properties` and array `items`. Unsupported keywords are ignored.
 * @param schema - JSON Schema fragment to validate against.
 * @param value - Value to validate.
 * @param path - JSON path prefix used in error reports; defaults to `$`.
 * @returns One {@link ValidationError} per violation in traversal order; empty when the value is valid.
 * @throws Never.
 */
function validateSchemaValue(schema: Record<string, unknown>, value: unknown, path = '$'): ValidationError[] {
  const errors: ValidationError[] = [];
  const expectedType = schema['type'];
  if (typeof expectedType === 'string') {
    const typeOk =
      (expectedType === 'object' && isPlainRecord(value))
      || (expectedType === 'array' && Array.isArray(value))
      || (expectedType === 'string' && typeof value === 'string')
      || (expectedType === 'number' && typeof value === 'number' && Number.isFinite(value))
      || (expectedType === 'integer' && Number.isInteger(value))
      || (expectedType === 'boolean' && typeof value === 'boolean');
    if (!typeOk) {
      errors.push({ path, message: `Expected ${expectedType}.` });
      return errors;
    }
  }

  if (typeof schema['minLength'] === 'number' && typeof value === 'string' && value.length < schema['minLength']) {
    errors.push({ path, message: `Expected at least ${schema['minLength']} character(s).` });
  }

  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) {
    errors.push({ path, message: `Expected one of: ${schema['enum'].join(', ')}.` });
  }

  if (isPlainRecord(value) && isPlainRecord(schema['properties'])) {
    const required = Array.isArray(schema['required']) ? schema['required'].filter((item): item is string => typeof item === 'string') : [];
    for (const key of required) {
      if (!(key in value)) errors.push({ path: `${path}.${key}`, message: 'Required field is missing.' });
    }
    for (const [key, childSchema] of Object.entries(schema['properties'])) {
      if (key in value && isPlainRecord(childSchema)) {
        errors.push(...validateSchemaValue(childSchema, value[key], `${path}.${key}`));
      }
    }
  }

  if (Array.isArray(value) && isPlainRecord(schema['items'])) {
    value.forEach((item, index) => {
      errors.push(...validateSchemaValue(schema['items'] as Record<string, unknown>, item, `${path}[${index}]`));
    });
  }

  return errors;
}

/**
 * Validates a workflow definition against {@link WORKFLOW_DEFINITION_SCHEMA} plus structural rules JSON Schema cannot express: `inputSchema`/`triggerSchema` must be object-typed JSON Schemas, every approval gate needs an id and a supported type, and every required-evidence entry needs a name.
 * @param input - Definition input (or persisted definition) to validate.
 * @returns Validation errors in check order; empty when the definition is valid.
 * @throws Never.
 */
function validateDefinitionShape(input: WorkflowDefinitionInput | WorkflowDefinition): ValidationError[] {
  const errors = validateSchemaValue(WORKFLOW_DEFINITION_SCHEMA, input);
  if (input.inputSchema !== undefined && !isPlainRecord(input.inputSchema)) {
    errors.push({ path: '$.inputSchema', message: 'inputSchema must be a JSON Schema object.' });
  }
  if (input.inputSchema !== undefined && input.inputSchema['type'] !== undefined && input.inputSchema['type'] !== 'object') {
    errors.push({ path: '$.inputSchema.type', message: 'Workflow inputSchema must describe an object.' });
  }
  if (input.triggerSchema !== undefined && !isPlainRecord(input.triggerSchema)) {
    errors.push({ path: '$.triggerSchema', message: 'triggerSchema must be a JSON Schema object.' });
  }
  for (const [index, gate] of (input.approvalGates ?? []).entries()) {
    if (!gate.id) errors.push({ path: `$.approvalGates[${index}].id`, message: 'Approval gate id is required.' });
    if (!['action', 'stale_source', 'low_confidence', 'cost', 'risk', 'expert_review'].includes(gate.type)) {
      errors.push({ path: `$.approvalGates[${index}].type`, message: 'Unsupported approval gate type.' });
    }
  }
  for (const [index, evidence] of (input.requiredEvidence ?? []).entries()) {
    if (!evidence.name) errors.push({ path: `$.requiredEvidence[${index}].name`, message: 'Required evidence name is required.' });
  }
  return errors;
}

/**
 * Merges a definition input with an existing persisted definition: omitted fields fall back to the existing values (then to defaults), the id is preserved or derived deterministically via {@link hashId}, a fresh `version` is assigned, and list-valued fields are deduplicated. Does not persist anything.
 * @param input - Incoming definition fields; `undefined` fields inherit from `existing`.
 * @param existing - Previously stored definition to merge onto, or `null` when creating.
 * @returns A complete definition with `updatedAt` set to now and a new `version`.
 * @throws Never.
 */
function normalizeDefinition(input: WorkflowDefinitionInput, existing: WorkflowDefinition | null): WorkflowDefinition {
  const timestamp = nowIso();
  const name = input.name.trim();
  const id = input.id ?? existing?.id ?? hashId('workflow-definition', [input.workspaceId, normalizeName(name)]);
  const definition: WorkflowDefinition = {
    id,
    version: randomUUID(),
    workspaceId: input.workspaceId,
    name,
    ownerPrincipalId: input.ownerPrincipalId ?? existing?.ownerPrincipalId ?? principalId(),
    inputSchema: input.inputSchema ?? existing?.inputSchema ?? { type: 'object' },
    allowedSourceIds: uniq(input.allowedSourceIds ?? existing?.allowedSourceIds ?? []),
    allowedConnectorInstanceIds: uniq(input.allowedConnectorInstanceIds ?? existing?.allowedConnectorInstanceIds ?? []),
    allowedTools: uniq(input.allowedTools ?? existing?.allowedTools ?? []),
    requiredEvidence: input.requiredEvidence ?? existing?.requiredEvidence ?? [],
    riskLevel: input.riskLevel ?? existing?.riskLevel ?? 'low',
    approvalGates: input.approvalGates ?? existing?.approvalGates ?? [],
    dryRunDefault: input.dryRunDefault ?? existing?.dryRunDefault ?? true,
    tests: input.tests ?? existing?.tests ?? [],
    successMetrics: uniq(input.successMetrics ?? existing?.successMetrics ?? []),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    ...(input.description ?? existing?.description !== undefined ? { description: (input.description ?? existing?.description)! } : {}),
    ...(input.triggerSchema ?? existing?.triggerSchema !== undefined ? { triggerSchema: (input.triggerSchema ?? existing?.triggerSchema)! } : {}),
  };
  return definition;
}

/**
 * {@link WorkflowRegistry} implementation backed by three stores: workflow definitions, frozen definition versions and eval cases. Every upsert assigns the definition a fresh version and freezes it as a new version record; eval cases mirror the definition's embedded tests.
 */
class StoreBackedWorkflowRegistry implements WorkflowRegistry {
  private readonly definitions: Store<WorkflowDefinition>;
  private readonly versions: Store<WorkflowVersion>;
  private readonly evalCases: Store<WorkflowEvalCase>;

  /**
   * Creates a registry over the given stores.
   * @param definitions - Store holding workflow definitions.
   * @param versions - Store holding frozen definition version records.
   * @param evalCases - Store holding stored eval cases.
   * @throws Never.
   */
  constructor(definitions: Store<WorkflowDefinition>, versions: Store<WorkflowVersion>, evalCases: Store<WorkflowEvalCase>) {
    this.definitions = definitions;
    this.versions = versions;
    this.evalCases = evalCases;
  }

  /**
   * Derives the deterministic definition id for a workspace/name pair (see {@link hashId}).
   * @param workspaceId - Owning workspace id.
   * @param name - Definition name; normalized before hashing.
   * @returns Deterministic id of the form `workflow-definition:<hash>`.
   * @throws Never.
   */
  stableWorkflowId(workspaceId: string, name: string): string {
    return hashId('workflow-definition', [workspaceId, normalizeName(name)]);
  }

  /**
   * Derives the deterministic version-record id for a workflow id and definition version.
   * @param workflowId - Definition id.
   * @param workflowVersion - Definition version string.
   * @returns Deterministic id of the form `workflow-version:<hash>`.
   * @throws Never.
   */
  stableWorkflowVersionId(workflowId: string, workflowVersion: string): string {
    return hashId('workflow-version', [workflowId, workflowVersion]);
  }

  /**
   * Validates a definition input or persisted definition against the structural rules of {@link validateDefinitionShape}.
   * @param input - Definition to validate.
   * @returns Validation errors; empty when the definition is valid.
   * @throws Never.
   */
  validateDefinition(input: WorkflowDefinitionInput | WorkflowDefinition): ValidationError[] {
    return validateDefinitionShape(input);
  }

  /**
   * Creates or updates a definition and freezes it as a new version. The merged candidate is validated first; when invalid, nothing is persisted and a preview version (not stored) is returned alongside the errors. When valid, the definition, its version record and one eval case per embedded test are written, each with a freshly generated version.
   * @param input - Definition fields; omitted fields are inherited from the stored definition.
   * @returns The persisted (or rejected candidate) definition, its version, and the validation errors.
   * @throws Never.
   */
  async upsertDefinition(input: WorkflowDefinitionInput): Promise<{ definition: WorkflowDefinition; version: WorkflowVersion; validation: ValidationError[] }> {
    const candidateId = input.id ?? this.stableWorkflowId(input.workspaceId, input.name);
    const existing = await this.definitions.get(candidateId);
    const definition = normalizeDefinition(input, existing);
    const validation = this.validateDefinition(definition);
    if (validation.length > 0) return { definition, version: this.previewVersion(definition), validation };
    await this.definitions.set(definition.id, definition);
    const version = this.previewVersion(definition);
    await this.versions.set(version.id, version);
    for (const test of definition.tests) {
      const evalCase: WorkflowEvalCase = {
        id: test.id ?? hashId('workflow-eval-case', [definition.id, test.name]),
        version: randomUUID(),
        workflowId: definition.id,
        workspaceId: definition.workspaceId,
        name: test.name,
        inputs: test.inputs ?? {},
        expected: test.expected ?? {},
        createdAt: definition.createdAt,
        updatedAt: definition.updatedAt,
      };
      await this.evalCases.set(evalCase.id, evalCase);
    }
    return { definition, version, validation };
  }

  /**
   * Fetches the current definition by id.
   * @param id - Definition id.
   * @returns The definition, or `null` when unknown.
   * @throws Never.
   */
  getDefinition(id: string): Promise<WorkflowDefinition | null> {
    return this.definitions.get(id);
  }

  /**
   * Fetches a frozen version record by id.
   * @param id - Version-record id (see {@link stableWorkflowVersionId}).
   * @returns The version record, or `null` when unknown.
   * @throws Never.
   */
  getVersion(id: string): Promise<WorkflowVersion | null> {
    return this.versions.get(id);
  }

  /**
   * Resolves a definition by workspace and exact (trimmed) name, falling back to the deterministic stable id when the query yields no match.
   * @param workspaceId - Owning workspace id.
   * @param name - Definition name.
   * @returns The definition, or `null` when unknown.
   * @throws Never.
   */
  async definitionByName(workspaceId: string, name: string): Promise<WorkflowDefinition | null> {
    const definitions = await this.queryDefinitions({
      where: {
        op: 'and',
        clauses: [
          { op: 'eq', field: 'workspaceId', value: workspaceId },
          { op: 'eq', field: 'name', value: name.trim() },
        ],
      },
    });
    return definitions[0] ?? this.definitions.get(this.stableWorkflowId(workspaceId, name));
  }

  /**
   * Queries stored definitions.
   * @param query - Optional filter/sort; matches everything when omitted.
   * @returns Matching definitions in the store/query-determined order.
   * @throws Never.
   */
  queryDefinitions(query?: StoreQuery): Promise<WorkflowDefinition[]> {
    return queryAll(this.definitions, query);
  }

  /**
   * Queries stored version records.
   * @param query - Optional filter/sort; matches everything when omitted.
   * @returns Matching version records in the store/query-determined order.
   * @throws Never.
   */
  queryVersions(query?: StoreQuery): Promise<WorkflowVersion[]> {
    return queryAll(this.versions, query);
  }

  /**
   * Queries stored eval cases.
   * @param query - Optional filter/sort; matches everything when omitted.
   * @returns Matching eval cases in the store/query-determined order.
   * @throws Never.
   */
  queryEvalCases(query?: StoreQuery): Promise<WorkflowEvalCase[]> {
    return queryAll(this.evalCases, query);
  }

  /**
   * Builds the version record for a definition without persisting it; the record's own `version` is freshly randomized on every call.
   * @param definition - Definition to version.
   * @returns An unpersisted {@link WorkflowVersion}.
   * @throws Never.
   */
  private previewVersion(definition: WorkflowDefinition): WorkflowVersion {
    return {
      id: this.stableWorkflowVersionId(definition.id, definition.version),
      version: randomUUID(),
      workflowId: definition.id,
      workflowVersion: definition.version,
      workspaceId: definition.workspaceId,
      definition,
      createdAt: definition.updatedAt,
    };
  }
}

/**
 * {@link WorkflowRunner} implementation persisting runs, run events, approvals and shadow comparisons to stores. Every mutation assigns the run a fresh version before writing, and run events are sequenced per run and mirrored to the optional observability sink. The source and connector registries are optional: without a source registry evidence degrades to bare source-id references, and without a connector registry capability falls back to input-shape inference.
 */
class StoreBackedWorkflowRunner implements WorkflowRunner {
  private readonly registry: WorkflowRegistry;
  private readonly runs: Store<WorkflowRun>;
  private readonly events: Store<WorkflowRunEvent>;
  private readonly approvals: Store<WorkflowApproval>;
  private readonly shadowComparisonsStore: Store<WorkflowShadowComparison>;
  private readonly sourceRegistry: SourceRegistryLike | undefined;
  private readonly connectorRegistry: ConnectorRegistryLike | undefined;
  private readonly observability: () => ObservabilityLike | undefined;

  /**
   * Wires the runner to its stores and optional registry services.
   * @param registry - Registry used to resolve definitions and versions.
   * @param runs - Store for workflow runs.
   * @param events - Store for run events.
   * @param approvals - Store for approval requests.
   * @param shadowComparisons - Store for shadow comparisons.
   * @param sourceRegistry - Optional source registry for evidence resolution and access recording; omitted means bare source-id references.
   * @param connectorRegistry - Optional connector registry for capability/connector resolution; omitted means inference from tool-call input.
   * @param observability - Lookup returning the observability sink to mirror run events to, re-evaluated per event; may yield `undefined`.
   * @throws Never.
   */
  constructor(
    registry: WorkflowRegistry,
    runs: Store<WorkflowRun>,
    events: Store<WorkflowRunEvent>,
    approvals: Store<WorkflowApproval>,
    shadowComparisons: Store<WorkflowShadowComparison>,
    sourceRegistry: SourceRegistryLike | undefined,
    connectorRegistry: ConnectorRegistryLike | undefined,
    observability: () => ObservabilityLike | undefined,
  ) {
    this.registry = registry;
    this.runs = runs;
    this.events = events;
    this.approvals = approvals;
    this.shadowComparisonsStore = shadowComparisons;
    this.sourceRegistry = sourceRegistry;
    this.connectorRegistry = connectorRegistry;
    this.observability = observability;
  }

  /**
   * Starts a workflow run: resolves the definition, persists the created run, validates inputs against the definition's input schema (failing the run on error), resolves evidence, normalizes proposals, then either completes immediately (dry-run/shadow), requests approvals per the definition's gates (approval-gated/execute), or marks the run ready for execution when no gate triggers. The run mode defaults to the definition's `dryRunDefault` (`dry_run` or `approval_gated`).
   * @param input - Workflow, workspace, mode, inputs, evidence sources, proposals, labels and trace ids; `workflowId` and `workflowName` are alternative resolution paths.
   * @returns The run in its post-start state (`succeeded`, `waiting_for_approval`, `running` or `failed`).
   * @throws Error - When the definition cannot be resolved, belongs to another workspace, or the requested version is unknown.
   */
  async startRun(input: StartWorkflowInput): Promise<WorkflowRun> {
    const definition = await this.resolveDefinition(input);
    const mode = input.mode ?? (definition.dryRunDefault ? 'dry_run' : 'approval_gated');
    const timestamp = nowIso();
    let run: WorkflowRun = {
      id: randomUUID(),
      version: randomUUID(),
      workflowId: definition.id,
      workflowVersion: definition.version,
      workspaceId: definition.workspaceId,
      principalId: principalId(),
      mode,
      status: 'created',
      completionState: 'planned',
      inputs: input.inputs ?? {},
      evidenceSourceIds: uniq(input.evidenceSourceIds ?? []),
      evidenceSourceVersions: [],
      proposedActions: [],
      executedActions: [],
      labels: uniq(input.labels ?? []),
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.rootTraceId !== undefined ? { rootTraceId: input.rootTraceId } : {}),
      ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
    };
    await this.runs.set(run.id, run);
    await this.appendEvent(run, 'run_created', { mode, workflowId: definition.id, workflowVersion: definition.version });

    const inputErrors = validateSchemaValue(definition.inputSchema, run.inputs);
    if (inputErrors.length > 0) {
      run = await this.updateRun({ ...run, status: 'failed', completionState: 'failed', error: 'Workflow inputs failed schema validation.', finishedAt: nowIso(), updatedAt: nowIso() });
      await this.appendEvent(run, 'input_validation_failed', { errors: inputErrors });
      return run;
    }
    await this.appendEvent(run, 'inputs_validated', { inputHash: hashPayload(run.inputs) });

    const evidence = await this.resolveEvidence(definition, run);
    run = await this.updateRun({ ...run, evidenceSourceVersions: evidence.references, updatedAt: nowIso() });
    await this.appendEvent(run, 'evidence_resolved', {
      sourceIds: run.evidenceSourceIds,
      references: evidence.references,
      warnings: evidence.warnings,
    }, run.evidenceSourceIds);

    const proposedActions = await this.normalizeProposals(definition, run, input.proposedActions ?? [], mode);
    run = await this.updateRun({
      ...run,
      status: 'running',
      completionState: 'planned',
      startedAt: nowIso(),
      proposedActions,
      updatedAt: nowIso(),
    });
    await this.appendEvent(run, 'actions_proposed', { proposedActions });

    if (mode === 'dry_run') {
      run = await this.updateRun({ ...run, status: 'succeeded', completionState: 'planned', finishedAt: nowIso(), updatedAt: nowIso() });
      await this.appendEvent(run, 'dry_run_completed', { proposedActionCount: proposedActions.length });
      return run;
    }
    if (mode === 'shadow') {
      run = await this.updateRun({ ...run, status: 'succeeded', completionState: 'planned', finishedAt: nowIso(), updatedAt: nowIso() });
      await this.appendEvent(run, 'shadow_recommendation_recorded', { proposedActionCount: proposedActions.length, labels: run.labels });
      return run;
    }
    const approvalRequests = await this.createApprovalRequests(definition, run, evidence.warnings);
    if (approvalRequests.length > 0 || (mode === 'approval_gated' && proposedActions.some(action => action.requiresApproval))) {
      run = await this.updateRun({ ...run, status: 'waiting_for_approval', completionState: 'awaiting_approval', updatedAt: nowIso() });
      await this.appendEvent(run, 'approval_requested', { approvals: approvalRequests });
      return run;
    }
    const hasExecutableActions = proposedActions.some(action => action.status !== 'blocked' && action.status !== 'rejected');
    run = await this.updateRun({
      ...run,
      status: hasExecutableActions ? 'running' : 'succeeded',
      completionState: hasExecutableActions ? 'approved_pending_execution' : 'action_succeeded',
      ...(hasExecutableActions ? {} : { finishedAt: nowIso() }),
      updatedAt: nowIso(),
    });
    await this.appendEvent(run, hasExecutableActions ? 'actions_ready' : 'run_succeeded', { reason: 'No approval gates were triggered.' });
    return run;
  }

  /**
   * Approves one pending approval (by id) or, when `approvalId` is omitted, all pending approvals of the run; the deciding principal is taken from the ambient security scope. Matching proposals become `approved`. The run returns to `waiting_for_approval` while other approvals remain, moves to `running`/`approved_pending_execution` otherwise, and finishes `succeeded` when nothing remains to execute. Emits `approval_approved` and, when complete, `approvals_completed` or `run_succeeded`.
   * @param runId - Run whose approvals are decided.
   * @param approvalId - Specific pending approval to approve; `undefined` approves every pending approval.
   * @param reason - Optional decision reason recorded on the approvals.
   * @returns The updated run and the approvals decided by this call.
   * @throws Error - When the run does not exist or no matching pending approval is found.
   */
  async approveRun(runId: string, approvalId?: string, reason?: string): Promise<{ run: WorkflowRun; approvals: WorkflowApproval[] }> {
    const run = await this.requireRun(runId);
    const pending = await this.pendingApprovals(runId, approvalId);
    if (pending.length === 0) throw new Error(`No pending workflow approval found for run "${runId}".`);
    const timestamp = nowIso();
    const decided: WorkflowApproval[] = [];
    for (const approval of pending) {
      const updated = withOptional({
        ...approval,
        version: randomUUID(),
        status: 'approved' as const,
        updatedAt: timestamp,
        decidedAt: timestamp,
        decidedByPrincipalId: principalId(),
      }, 'reason', reason ?? approval.reason);
      await this.approvals.set(updated.id, updated);
      decided.push(updated);
    }
    const approvedProposalIds = new Set(decided.map(item => item.proposalId).filter((value): value is string => typeof value === 'string'));
    const approveAllPending = approvalId === undefined;
    const proposedActions = run.proposedActions.map(action =>
      approveAllPending || approvedProposalIds.has(action.id)
        ? { ...action, status: 'approved' as const, requiresApproval: false }
        : action);
    const remaining = (await this.pendingApprovals(runId)).filter(item => !decided.some(done => done.id === item.id));
    const hasApprovedActions = proposedActions.some(action => action.status === 'approved');
    const nextStatus: WorkflowRunStatus = remaining.length > 0 ? 'waiting_for_approval' : hasApprovedActions ? 'running' : 'succeeded';
    const completionState: WorkflowCompletionState = remaining.length > 0 ? 'awaiting_approval' : hasApprovedActions ? 'approved_pending_execution' : 'action_succeeded';
    const updatedRun = await this.updateRun({
      ...run,
      version: randomUUID(),
      status: nextStatus,
      completionState,
      proposedActions,
      ...(nextStatus === 'succeeded' ? { finishedAt: timestamp } : {}),
      updatedAt: timestamp,
    });
    await this.appendEvent(updatedRun, 'approval_approved', { approvalIds: decided.map(item => item.id), reason: reason ?? null });
    if (remaining.length === 0) await this.appendEvent(updatedRun, hasApprovedActions ? 'approvals_completed' : 'run_succeeded', { reason: 'All pending approvals were approved.' });
    return { run: updatedRun, approvals: decided };
  }

  /**
   * Rejects one pending approval (by id) or all pending approvals when `approvalId` is omitted; the deciding principal is taken from the ambient security scope. Matching proposals become `rejected` and the run is finished as `cancelled` regardless of any remaining approvals. Emits an `approval_rejected` event.
   * @param runId - Run whose approvals are decided.
   * @param approvalId - Specific pending approval to reject; `undefined` rejects every pending approval.
   * @param reason - Optional decision reason recorded on the approvals.
   * @returns The cancelled run and the approvals rejected by this call.
   * @throws Error - When the run does not exist or no matching pending approval is found.
   */
  async rejectRun(runId: string, approvalId?: string, reason?: string): Promise<{ run: WorkflowRun; approvals: WorkflowApproval[] }> {
    const run = await this.requireRun(runId);
    const pending = await this.pendingApprovals(runId, approvalId);
    if (pending.length === 0) throw new Error(`No pending workflow approval found for run "${runId}".`);
    const timestamp = nowIso();
    const rejected: WorkflowApproval[] = [];
    for (const approval of pending) {
      const updated = withOptional({
        ...approval,
        version: randomUUID(),
        status: 'rejected' as const,
        updatedAt: timestamp,
        decidedAt: timestamp,
        decidedByPrincipalId: principalId(),
      }, 'reason', reason ?? approval.reason);
      await this.approvals.set(updated.id, updated);
      rejected.push(updated);
    }
    const rejectedProposalIds = new Set(rejected.map(item => item.proposalId).filter((value): value is string => typeof value === 'string'));
    const rejectAllPending = approvalId === undefined;
    const proposedActions = run.proposedActions.map(action =>
      rejectAllPending || rejectedProposalIds.has(action.id)
        ? { ...action, status: 'rejected' as const }
        : action);
    const updatedRun = await this.updateRun({
      ...run,
      status: 'cancelled',
      completionState: 'cancelled',
      proposedActions,
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
    await this.appendEvent(updatedRun, 'approval_rejected', { approvalIds: rejected.map(item => item.id), reason: reason ?? null });
    return { run: updatedRun, approvals: rejected };
  }

  /**
   * Escalates a run: every pending approval becomes `escalated` and the run finishes with status and completion state `escalated`. Emits a `run_escalated` event.
   * @param runId - Run to escalate.
   * @param reason - Human-readable escalation reason recorded on the approvals and the event.
   * @returns The escalated run and the approvals escalated by this call (empty when none were pending).
   * @throws Error - When the run does not exist.
   */
  async escalateRun(runId: string, reason: string): Promise<{ run: WorkflowRun; approvals: WorkflowApproval[] }> {
    const run = await this.requireRun(runId);
    const timestamp = nowIso();
    const pending = await this.pendingApprovals(runId);
    const escalated: WorkflowApproval[] = [];
    for (const approval of pending) {
      const updated: WorkflowApproval = {
        ...approval,
        version: randomUUID(),
        status: 'escalated',
        updatedAt: timestamp,
        escalatedAt: timestamp,
        escalationReason: reason,
      };
      await this.approvals.set(updated.id, updated);
      escalated.push(updated);
    }
    const updatedRun = await this.updateRun({
      ...run,
      version: randomUUID(),
      status: 'escalated',
      completionState: 'escalated',
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
    await this.appendEvent(updatedRun, 'run_escalated', { reason, approvalIds: escalated.map(item => item.id) });
    return { run: updatedRun, approvals: escalated };
  }

  /**
   * Records the business outcome of a run and finishes it: `verified_completed` maps to completion state `business_outcome_verified` (status `succeeded`), `estimated_completed` to `action_succeeded` (status `succeeded`), and `failed`/`cancelled`/`escalated` map directly to the same-named states. Emits a `business_outcome_recorded` event.
   * @param runId - Run to finish.
   * @param outcomeId - External outcome identifier recorded on the run.
   * @param status - Business-level completion verdict.
   * @returns The finished run.
   * @throws Error - When the run does not exist.
   */
  async recordBusinessOutcome(runId: string, outcomeId: string, status: 'verified_completed' | 'estimated_completed' | 'failed' | 'cancelled' | 'escalated'): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);
    const timestamp = nowIso();
    const nextStatus: WorkflowRunStatus = status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : status === 'escalated' ? 'escalated' : 'succeeded';
    const completionState: WorkflowCompletionState = status === 'verified_completed' ? 'business_outcome_verified' : status === 'estimated_completed' ? 'action_succeeded' : status;
    const updatedRun = await this.updateRun({
      ...run,
      version: randomUUID(),
      status: nextStatus,
      completionState,
      outcomeId,
      finishedAt: timestamp,
      updatedAt: timestamp,
    });
    await this.appendEvent(updatedRun, 'business_outcome_recorded', { outcomeId, status });
    return updatedRun;
  }

  /**
   * Adds human labels to a shadow-mode run (deduplicated with existing ones), appends a `shadow_result_labeled` event and upserts the run's shadow comparison.
   * @param runId - Shadow-mode run to label.
   * @param labels - Raw label strings; normalized before storage.
   * @param note - Optional reviewer note stored on the comparison; an existing note is kept when omitted.
   * @returns The updated run.
   * @throws Error - When the run does not exist or is not a shadow-mode run.
   */
  async labelShadowResult(runId: string, labels: string[], note?: string): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);
    if (run.mode !== 'shadow') throw new Error(`Workflow run "${runId}" is not a shadow-mode run.`);
    const updatedRun = await this.updateRun({
      ...run,
      labels: uniq([...run.labels, ...labels]),
      updatedAt: nowIso(),
    });
    await this.appendEvent(updatedRun, 'shadow_result_labeled', { labels, ...(note !== undefined ? { note } : {}) });
    await this.upsertShadowComparison(updatedRun, note);
    return updatedRun;
  }

  /**
   * Labels (when new labels are supplied) and classifies a shadow-mode run, upserting its per-run shadow comparison and appending `shadow_result_labeled`/`shadow_result_compared` events. Repeating an identical decision (no new labels, an existing comparison, no note) is idempotent and returns the stored comparison without emitting new events.
   * @param runId - Shadow-mode run to compare.
   * @param labels - Additional human labels; defaults to none (re-classifies the existing labels).
   * @param note - Optional reviewer note; replaces an existing note only when supplied.
   * @returns The (possibly label-updated) run and the upserted comparison.
   * @throws Error - When the run does not exist or is not a shadow-mode run.
   */
  async compareShadowRun(runId: string, labels: string[] = [], note?: string): Promise<{ run: WorkflowRun; comparison: WorkflowShadowComparison }> {
    const run = await this.requireRun(runId);
    if (run.mode !== 'shadow') throw new Error(`Workflow run "${runId}" is not a shadow-mode run.`);
    let updatedRun = run;
    const normalized = normalizedLabels(labels);
    const labelsChanged = normalized.some(label => !run.labels.includes(label));
    const comparisonId = hashId('workflow-shadow-comparison', [run.id]);
    const existingComparison = await this.shadowComparisonsStore.get(comparisonId);
    if (!labelsChanged && existingComparison !== null && note === undefined) {
      // Repeating the same decision is idempotent: preserve the immutable
      // comparison/event history rather than emitting a second decision event.
      return { run, comparison: existingComparison };
    }
    if (labelsChanged) {
      updatedRun = await this.updateRun({
        ...run,
        labels: uniq([...run.labels, ...normalized]),
        updatedAt: nowIso(),
      });
      await this.appendEvent(updatedRun, 'shadow_result_labeled', { labels: normalized, ...(note !== undefined ? { note } : {}) });
    }
    const comparison = await this.upsertShadowComparison(updatedRun, note);
    await this.appendEvent(updatedRun, 'shadow_result_compared', {
      comparisonId: comparison.id,
      outcome: comparison.outcome,
      score: comparison.score,
      recommendationHash: comparison.recommendationHash,
    }, comparison.sourceIds);
    return { run: updatedRun, comparison };
  }

  /**
   * Queries stored shadow comparisons.
   * @param query - Optional filter/sort; matches everything when omitted.
   * @returns Matching comparisons in the store/query-determined order.
   * @throws Never.
   */
  shadowComparisons(query?: StoreQuery): Promise<WorkflowShadowComparison[]> {
    return queryAll(this.shadowComparisonsStore, query);
  }

  /**
   * Aggregates shadow comparisons into acceptance statistics: outcome counts and acceptance rate overall, plus a per-workflow breakdown sorted by descending comparison count, then workflow id.
   * @param query - Optional filter selecting the comparisons to aggregate; matches everything when omitted.
   * @returns The aggregate summary; all zeros when no comparisons match.
   * @throws Never.
   */
  async shadowSummary(query?: StoreQuery): Promise<WorkflowShadowSummary> {
    const comparisons = await this.shadowComparisons(query);
    if (comparisons.length === 0) return emptyShadowSummary();
    const summary = emptyShadowSummary();
    const byWorkflow = new Map<string, WorkflowShadowSummary['byWorkflow'][number]>();
    /**
     * Bins one comparison outcome into the given outcome counters.
     * @param outcome - Outcome to count.
     * @param target - Outcome counters to increment.
     * @throws Never.
     */
    const count = (outcome: ShadowComparisonOutcome, target: Pick<WorkflowShadowSummary, 'accepted' | 'rejected' | 'mixed' | 'unlabeled'>): void => {
      if (outcome === 'accepted') target.accepted++;
      else if (outcome === 'rejected') target.rejected++;
      else if (outcome === 'mixed') target.mixed++;
      else target.unlabeled++;
    };
    for (const comparison of comparisons) {
      summary.total++;
      count(comparison.outcome, summary);
      let workflow = byWorkflow.get(comparison.workflowId);
      if (workflow === undefined) {
        workflow = {
          workflowId: comparison.workflowId,
          total: 0,
          accepted: 0,
          rejected: 0,
          mixed: 0,
          unlabeled: 0,
          acceptanceRate: 0,
        };
        byWorkflow.set(comparison.workflowId, workflow);
      }
      workflow.total++;
      count(comparison.outcome, workflow);
    }
    summary.acceptanceRate = summary.total === 0 ? 0 : summary.accepted / summary.total;
    summary.byWorkflow = [...byWorkflow.values()]
      .map(item => ({
        ...item,
        acceptanceRate: item.total === 0 ? 0 : item.accepted / item.total,
      }))
      .sort((left, right) => right.total - left.total || left.workflowId.localeCompare(right.workflowId));
    return summary;
  }

  /**
   * Records the execution of an approved proposal's tool call: appends an executed-action entry (hashing the result; on failure, truncating its serialization to 1000 characters as the error text), marks the proposal `executed` and advances the run — a failed execution fails the run, and the last successful execution finishes it as `succeeded`/`action_succeeded`. Silent no-op when the run is unknown or no approved proposal matches the tool name. Emits `tool_executed`/`tool_execution_failed` and possibly `run_succeeded` events.
   * @param runId - Run whose proposal was executed.
   * @param toolName - Name of the executed tool; matched against approved proposals.
   * @param result - Raw tool result (success payload or error), hashed into the ledger.
   * @param isError - Whether the tool call failed.
   * @param durationMs - Optional execution duration in milliseconds, recorded on the event.
   * @returns Promise resolving once the run ledger and events are written.
   * @throws Never.
   */
  async recordToolResult(runId: string, toolName: string, result: unknown, isError: boolean, durationMs?: number): Promise<void> {
    const run = await this.runs.get(runId);
    if (run === null) return;
    const proposal = run.proposedActions.find(action => action.toolName === toolName && action.status === 'approved');
    if (proposal === undefined) return;
    const executed: ExecutedAction = {
      id: randomUUID(),
      proposalId: proposal.id,
      toolName,
      status: isError ? 'failed' : 'succeeded',
      executedAt: nowIso(),
      resultHash: hashPayload(result),
      ...(isError ? { error: canonicalJson(result).slice(0, 1000) } : {}),
    };
    const proposedActions = run.proposedActions.map(action => action.id === proposal.id ? { ...action, status: 'executed' as const } : action);
    const allExecutableFinished = proposedActions.every(action => action.status === 'executed' || action.status === 'blocked' || action.status === 'rejected');
    const nextStatus: WorkflowRunStatus = isError ? 'failed' : allExecutableFinished ? 'succeeded' : 'running';
    const completionState: WorkflowCompletionState = isError ? 'failed' : allExecutableFinished ? 'action_succeeded' : 'executing';
    const updatedRun = await this.updateRun({
      ...run,
      status: nextStatus,
      completionState,
      executedActions: [...run.executedActions, executed],
      proposedActions,
      ...((isError || allExecutableFinished) ? { finishedAt: executed.executedAt } : {}),
      updatedAt: executed.executedAt,
    });
    await this.appendEvent(updatedRun, isError ? 'tool_execution_failed' : 'tool_executed', {
      toolName,
      proposalId: proposal.id,
      resultHash: executed.resultHash,
      ...(durationMs !== undefined ? { durationMs } : {}),
    }, proposal.sourceIds);
    if (!isError && allExecutableFinished) await this.appendEvent(updatedRun, 'run_succeeded', { reason: 'All approved actions executed successfully.' });
  }

  /**
   * Loads a run together with its full event history (in sequence order) and approval records.
   * @param runId - Run to inspect.
   * @returns The run (`null` when unknown), its events ordered by sequence, and its approvals in store order.
   * @throws Never.
   */
  async inspectRun(runId: string): Promise<{ run: WorkflowRun | null; events: WorkflowRunEvent[]; approvals: WorkflowApproval[] }> {
    const run = await this.runs.get(runId);
    return {
      run,
      events: await this.eventsForRun(runId),
      approvals: await this.approvalsForRun(runId),
    };
  }

  /**
   * Queries stored runs.
   * @param query - Optional filter/sort; matches everything when omitted.
   * @returns Matching runs in the store/query-determined order.
   * @throws Never.
   */
  listRuns(query?: StoreQuery): Promise<WorkflowRun[]> {
    return queryAll(this.runs, query);
  }

  /**
   * Queries stored approval requests.
   * @param query - Optional filter/sort; matches everything when omitted.
   * @returns Matching approvals in the store/query-determined order.
   * @throws Never.
   */
  listApprovals(query?: StoreQuery): Promise<WorkflowApproval[]> {
    return queryAll(this.approvals, query);
  }

  /**
   * Decides whether a tool call is allowed under the workflow governing its input (via a `workflowRunId`). Denials (active but not allowed) cover unknown runs or definitions, a calling principal other than the run's submitter (unless the run is owned by `system`), tools or connectors outside the definition allow-lists, non-read calls in dry-run/shadow modes, and non-read calls without an approved or executed proposal. Calls without a workflow run id are allowed and reported as inactive.
   * @param toolName - Name of the tool being called.
   * @param input - Tool-call input, scanned for the workflow run id and connector instance id.
   * @param principal - Calling principal; `undefined` skips the submitter check.
   * @returns The policy decision, including the resolved capability and the governing run when active.
   * @throws Never.
   */
  async evaluateToolPolicy(toolName: string, input: unknown, principal?: Principal): Promise<WorkflowPolicyDecision> {
    const workflowRunId = extractWorkflowRunId(input);
    if (workflowRunId === undefined) return { allowed: true, active: false };
    const run = await this.runs.get(workflowRunId);
    if (run === null) return { allowed: false, active: true, reason: `Unknown workflow run "${workflowRunId}".` };
    const definition = await this.registry.getDefinition(run.workflowId);
    if (definition === null) return { allowed: false, active: true, run, reason: `Unknown workflow definition "${run.workflowId}".` };
    if (principal !== undefined && principal.id !== run.principalId && run.principalId !== 'system') {
      return { allowed: false, active: true, run, reason: `Workflow run "${run.id}" belongs to principal "${run.principalId}", not "${principal.id}".` };
    }
    const connectorDecision = this.connectorRegistry === undefined
      ? null
      : await this.connectorRegistry.evaluateToolCall({
        toolName,
        input,
        ...(principal !== undefined ? { principal } : {}),
      });
    const capability = connectorDecision?.capability ?? inferCapability(input);
    if (!definition.allowedTools.includes('*') && !definition.allowedTools.includes(toolName)) {
      return { allowed: false, active: true, run, capability, reason: `Workflow "${definition.name}" does not allow tool "${toolName}".` };
    }
    const connectorId = connectorDecision?.connectorInstance?.id ?? extractConnectorInstanceId(input);
    if (connectorId !== undefined && definition.allowedConnectorInstanceIds.length > 0 && !definition.allowedConnectorInstanceIds.includes(connectorId)) {
      return { allowed: false, active: true, run, capability, reason: `Workflow "${definition.name}" does not allow connector "${connectorId}".` };
    }
    if ((run.mode === 'dry_run' || run.mode === 'shadow') && capability !== 'read') {
      return { allowed: false, active: true, run, capability, reason: `Workflow run "${run.id}" is ${run.mode}; write/admin tool calls are not executable.` };
    }
    if (capability !== 'read') {
      const approved = run.proposedActions.some(action =>
        action.toolName === toolName && (action.status === 'approved' || action.status === 'executed'));
      if (!approved) {
        return { allowed: false, active: true, run, capability, reason: `Workflow run "${run.id}" has no approved proposal for write/admin tool "${toolName}".` };
      }
    }
    return { allowed: true, active: true, run, capability };
  }

  /**
   * Builds and persists the shadow comparison for a shadow-mode run: classifies the run's normalized labels, hashes the recommendation (workflow, inputs, proposals) into a stable per-run comparison id, and preserves the original creation timestamp and note across updates.
   * @param run - Shadow-mode run (must be mode `shadow`).
   * @param note - Optional reviewer note; an existing note is kept when omitted.
   * @returns The persisted comparison.
   * @throws Error - When the run is not a shadow-mode run.
   */
  private async upsertShadowComparison(run: WorkflowRun, note?: string): Promise<WorkflowShadowComparison> {
    if (run.mode !== 'shadow') throw new Error(`Workflow run "${run.id}" is not a shadow-mode run.`);
    const id = hashId('workflow-shadow-comparison', [run.id]);
    const existing = await this.shadowComparisonsStore.get(id);
    const timestamp = nowIso();
    const labels = normalizedLabels(run.labels);
    const classification = classifyShadowLabels(labels);
    const recommendation = run.proposedActions.map(action => ({
      id: action.id,
      toolName: action.toolName,
      capability: action.capability,
      inputHash: hashPayload(action.input),
      sourceIds: action.sourceIds,
      status: action.status,
      connectorInstanceId: action.connectorInstanceId,
      riskLevel: action.riskLevel,
      confidence: action.confidence,
      costEstimateUsd: action.costEstimateUsd,
    }));
    const comparison: WorkflowShadowComparison = {
      id,
      version: randomUUID(),
      runId: run.id,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      workspaceId: run.workspaceId,
      principalId: run.principalId,
      recommendationHash: hashPayload({
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        inputsHash: hashPayload(run.inputs),
        evidenceSourceIds: run.evidenceSourceIds,
        proposedActions: recommendation,
      }),
      proposedActionIds: run.proposedActions.map(action => action.id),
      proposedToolNames: uniq(run.proposedActions.map(action => action.toolName)),
      sourceIds: uniq([...run.evidenceSourceIds, ...run.proposedActions.flatMap(action => action.sourceIds)]),
      humanLabels: labels,
      outcome: classification.outcome,
      score: classification.score,
      comparedAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(note ?? existing?.note !== undefined ? { note: (note ?? existing?.note)! } : {}),
    };
    await this.shadowComparisonsStore.set(id, comparison);
    return comparison;
  }

  /**
   * Resolves the definition a run should execute: by `workflowId` when given, otherwise by `workflowName` within the workspace; a requested `workflowVersion` swaps in that frozen version's definition. The resolved definition must belong to the requested workspace.
   * @param input - Start-run input carrying the resolution keys and target workspace.
   * @returns The resolved definition (possibly a historical version's snapshot).
   * @throws Error - When no definition resolves, the workspace mismatches, or the requested version is unknown.
   */
  private async resolveDefinition(input: StartWorkflowInput): Promise<WorkflowDefinition> {
    const definition = input.workflowId !== undefined
      ? await this.registry.getDefinition(input.workflowId)
      : input.workflowName !== undefined
        ? await this.registry.definitionByName(input.workspaceId, input.workflowName)
        : null;
    if (definition === null) throw new Error('workflow_action start requires a known workflowId or workflowName.');
    if (definition.workspaceId !== input.workspaceId) throw new Error(`Workflow "${definition.id}" does not belong to workspace "${input.workspaceId}".`);
    if (input.workflowVersion !== undefined && input.workflowVersion !== definition.version) {
      const versionId = this.registry.stableWorkflowVersionId(definition.id, input.workflowVersion);
      const version = await this.registry.getVersion(versionId);
      if (version === null) throw new Error(`Unknown workflow version "${input.workflowVersion}" for workflow "${definition.id}".`);
      return version.definition;
    }
    return definition;
  }

  /**
   * Resolves the run's evidence sources into citation references, warning (never failing) on unmet `minCitations`, out-of-allow-list or cross-workspace sources, unhealthy/stale sources and unresolvable citations. With a source registry, citations are resolved, the newest observed version is preferred and a `read` access is recorded (registry call failures are swallowed); without one, bare source-id references are returned.
   * @param definition - Definition supplying the evidence requirements and source allow-list.
   * @param run - Run whose `evidenceSourceIds` are resolved.
   * @returns One reference per evidence source in input order, plus the accumulated warnings.
   * @throws Never.
   */
  private async resolveEvidence(definition: WorkflowDefinition, run: WorkflowRun): Promise<{ references: EvidenceReference[]; warnings: string[] }> {
    const warnings: string[] = [];
    const references: EvidenceReference[] = [];
    const evidenceIds = uniq(run.evidenceSourceIds);
    const missing = definition.requiredEvidence.filter(required => (required.minCitations ?? 1) > evidenceIds.length);
    for (const required of missing) warnings.push(`Required evidence "${required.name}" does not meet minCitations.`);
    for (const sourceId of evidenceIds) {
      if (definition.allowedSourceIds.length > 0 && !definition.allowedSourceIds.includes(sourceId)) {
        warnings.push(`Evidence source "${sourceId}" is outside the workflow allow-list.`);
      }
      if (this.sourceRegistry === undefined) {
        references.push({ sourceId });
        continue;
      }
      const source = await this.sourceRegistry.getSource(sourceId);
      if (source === null) {
        warnings.push(`Evidence source "${sourceId}" was not found.`);
        references.push({ sourceId, warning: 'not_found' });
        continue;
      }
      if (source.workspaceId !== run.workspaceId) warnings.push(`Evidence source "${sourceId}" belongs to workspace "${source.workspaceId}".`);
      const latestVersion = await this.latestSourceVersion(sourceId);
      const citation = await this.sourceRegistry.resolveCitation(sourceId, latestVersion?.id).catch(() => undefined);
      await this.sourceRegistry.recordAccess({
        sourceId,
        action: 'read',
        allowed: true,
        principalId: run.principalId,
        workflowRunId: run.id,
        message: `Workflow run ${run.id} used source as evidence.`,
      }).catch(() => undefined);
      const healthWarning = source.healthState !== 'healthy' && source.healthState !== 'unknown'
        ? `Evidence source "${sourceId}" health is ${source.healthState}.`
        : undefined;
      const staleWarning = source.stalenessState === 'stale' || source.stalenessState === 'expired'
        ? `Evidence source "${sourceId}" is ${source.stalenessState}.`
        : undefined;
      if (healthWarning !== undefined) warnings.push(healthWarning);
      if (staleWarning !== undefined) warnings.push(staleWarning);
      const warning = healthWarning ?? staleWarning;
      const sourceVersionId = citation?.versionId ?? latestVersion?.id;
      const observedAt = citation?.observedAt ?? latestVersion?.observedAt;
      references.push({
        sourceId,
        ...(citation?.text !== undefined ? { citationText: citation.text } : {}),
        ...(sourceVersionId !== undefined ? { sourceVersionId } : {}),
        ...(observedAt !== undefined ? { observedAt } : {}),
        healthState: source.healthState,
        stalenessState: source.stalenessState,
        ...(warning !== undefined ? { warning } : {}),
      });
    }
    return { references, warnings };
  }

  /**
   * Finds the most recently observed version of a source via the source registry's optional `sourceVersions` capability.
   * @param sourceId - Source to inspect.
   * @returns The newest version by `observedAt`, or `undefined` when the registry lacks the capability or the lookup fails.
   * @throws Never.
   */
  private async latestSourceVersion(sourceId: string): Promise<{ id: string; observedAt: string } | undefined> {
    if (this.sourceRegistry?.sourceVersions === undefined) return undefined;
    const versions = await this.sourceRegistry.sourceVersions(sourceId).catch(() => []);
    return versions.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
  }

  /**
   * Converts raw action proposals into run-scoped proposals: injects `workflowRunId` into each input, resolves capability and connector instance via the connector registry (falling back to {@link inferCapability}) under the run's principal, blocks proposals whose tool or connector is outside the definition allow-lists, and marks every unblocked non-read proposal as requiring approval.
   * @param definition - Definition supplying the tool/connector allow-lists.
   * @param run - Run the proposals belong to; its id and principal are stamped onto each proposal.
   * @param proposals - Raw proposals from the start-run input.
   * @param mode - Run mode; accepted for call-site symmetry but not used by the normalization itself.
   * @returns Normalized proposals in input order.
   * @throws Never.
   */
  private async normalizeProposals(
    definition: WorkflowDefinition,
    run: WorkflowRun,
    proposals: readonly ActionProposalInput[],
    mode: WorkflowRunMode,
  ): Promise<ActionProposal[]> {
    const normalized: ActionProposal[] = [];
    for (const proposal of proposals) {
      const connectorDecision = this.connectorRegistry === undefined
        ? null
        : await this.connectorRegistry.evaluateToolCall({
          toolName: proposal.toolName,
          input: proposal.input ?? {},
          principal: { id: run.principalId, type: 'user' },
        }).catch(() => null);
      const capability = proposal.capability ?? connectorDecision?.capability ?? inferCapability(proposal.input ?? {});
      const connectorInstanceId = proposal.connectorInstanceId ?? connectorDecision?.connectorInstance?.id;
      const sourceIds = uniq(proposal.sourceIds ?? []);
      const allowedTool = definition.allowedTools.includes('*') || definition.allowedTools.includes(proposal.toolName);
      const allowedConnector = connectorInstanceId === undefined
        || definition.allowedConnectorInstanceIds.length === 0
        || definition.allowedConnectorInstanceIds.includes(connectorInstanceId);
      const blocked = !allowedTool || !allowedConnector;
      normalized.push({
        id: proposal.id ?? randomUUID(),
        toolName: proposal.toolName,
        input: { ...(proposal.input ?? {}), workflowRunId: run.id },
        capability,
        status: blocked ? 'blocked' : 'proposed',
        sourceIds,
        requiresApproval: !blocked && capability !== 'read',
        ...(proposal.reason !== undefined ? { reason: proposal.reason } : {}),
        ...(connectorInstanceId !== undefined ? { connectorInstanceId } : {}),
        ...(proposal.riskLevel !== undefined ? { riskLevel: proposal.riskLevel } : {}),
        ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
        ...(proposal.costEstimateUsd !== undefined ? { costEstimateUsd: proposal.costEstimateUsd } : {}),
      });
    }
    return normalized;
  }

  /**
   * Creates pending approval requests for a run according to the definition's gates: per-proposal action gates (any non-blocked action when an action gate exists or the action itself requires approval), low-confidence and cost gates when a proposal falls below or exceeds the gate thresholds, plus run-level risk and expert-review gates (both keyed on the gate's required risk level) and a stale-source gate (when evidence warnings exist). Each request is persisted with a due date from {@link approvalDueAt}.
   * @param definition - Definition supplying the approval gates.
   * @param run - Run whose proposals and principal the requests reference.
   * @param evidenceWarnings - Evidence resolution warnings that trigger stale-source gates.
   * @returns The persisted requests in creation order.
   * @throws Never.
   */
  private async createApprovalRequests(definition: WorkflowDefinition, run: WorkflowRun, evidenceWarnings: string[]): Promise<WorkflowApproval[]> {
    const requests: WorkflowApproval[] = [];
    const timestamp = nowIso();
    /**
     * Builds and persists one pending approval, filling in the run-derived identity fields and the computed due date.
     * @param input - Approval payload without the run-derived fields.
     * @returns Promise resolving once the approval is stored.
     * @throws Never.
     */
    const addRequest = async (input: Omit<WorkflowApproval, 'id' | 'version' | 'runId' | 'workflowId' | 'status' | 'requestedAt' | 'updatedAt'>): Promise<void> => {
      const approval = withOptional(withOptional(withOptional({
        id: randomUUID(),
        version: randomUUID(),
        runId: run.id,
        workflowId: run.workflowId,
        status: 'pending' as const,
        requestedAt: timestamp,
        updatedAt: timestamp,
        dueAt: approvalDueAt(timestamp),
      }, 'gateId', input.gateId), 'proposalId', input.proposalId), 'principalId', input.principalId);
      const withMessage = withOptional(approval, 'message', input.message);
      await this.approvals.set(withMessage.id, withMessage);
      requests.push(withMessage);
    };

    const gates = definition.approvalGates;
    for (const action of run.proposedActions) {
      if (action.status === 'blocked') continue;
      const actionGate = gates.find(gate => gate.type === 'action');
      if (action.requiresApproval || actionGate !== undefined) {
        await addRequest({
          gateId: actionGate?.id ?? 'default-action-approval',
          proposalId: action.id,
          principalId: run.principalId,
          message: actionGate?.message ?? `Approve proposed ${action.capability} tool call "${action.toolName}".`,
        });
      }
      const lowConfidenceGate = gates.find(gate => gate.type === 'low_confidence' && action.confidence !== undefined && action.confidence < (gate.threshold ?? 0.8));
      if (lowConfidenceGate !== undefined) {
        await addRequest({
          gateId: lowConfidenceGate.id,
          proposalId: action.id,
          principalId: run.principalId,
          message: lowConfidenceGate.message ?? `Proposal confidence ${action.confidence} is below threshold.`,
        });
      }
      const costGate = gates.find(gate => gate.type === 'cost' && action.costEstimateUsd !== undefined && action.costEstimateUsd > (gate.threshold ?? 0));
      if (costGate !== undefined) {
        await addRequest({
          gateId: costGate.id,
          proposalId: action.id,
          principalId: run.principalId,
          message: costGate.message ?? `Proposal cost estimate ${action.costEstimateUsd} exceeds budget.`,
        });
      }
    }

    const riskGate = gates.find(gate => gate.type === 'risk' && riskAtLeast(definition.riskLevel, gate.requiredRiskLevel ?? 'high'));
    if (riskGate !== undefined) {
      await addRequest({
        gateId: riskGate.id,
        principalId: run.principalId,
        message: riskGate.message ?? `Workflow risk level ${definition.riskLevel} requires approval.`,
      });
    }
    const expertReviewGate = gates.find(gate => gate.type === 'expert_review' && riskAtLeast(definition.riskLevel, gate.requiredRiskLevel ?? 'high'));
    if (expertReviewGate !== undefined) {
      await addRequest({
        gateId: expertReviewGate.id,
        principalId: run.principalId,
        message: expertReviewGate.message ?? `Workflow risk level ${definition.riskLevel} requires a structured expert review linked to run ${run.id}.`,
      });
    }
    const staleGate = gates.find(gate => gate.type === 'stale_source');
    if (staleGate !== undefined && evidenceWarnings.length > 0) {
      await addRequest({
        gateId: staleGate.id,
        principalId: run.principalId,
        message: staleGate.message ?? `Workflow evidence has freshness or health warnings: ${evidenceWarnings.join('; ')}`,
      });
    }
    return requests;
  }

  /**
   * Persists a run snapshot, assigning it a fresh version so concurrent writers are detectable.
   * @param run - Run state to persist (already merged by the caller).
   * @returns The persisted run with its new version.
   * @throws Never.
   */
  private async updateRun(run: WorkflowRun): Promise<WorkflowRun> {
    const updated = { ...run, version: randomUUID() };
    await this.runs.set(updated.id, updated);
    return updated;
  }

  /**
   * Loads a run or fails.
   * @param runId - Run id.
   * @returns The stored run.
   * @throws Error - When the run does not exist.
   */
  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.runs.get(runId);
    if (run === null) throw new Error(`Unknown workflow run "${runId}".`);
    return run;
  }

  /**
   * Appends a run event with the next per-run sequence number and mirrors it to the observability sink (`start` phase for `run_created`, `end` for terminal event types, `error` status for failures). Sink failures are logged and swallowed — event persistence always completes first.
   * @param run - Run the event belongs to; its trace ids and principal are copied onto the event.
   * @param eventType - Machine-readable event type.
   * @param payload - Structured event payload.
   * @param sourceIds - Optional evidence source ids associated with the event.
   * @returns The persisted event.
   * @throws Never.
   */
  private async appendEvent(run: WorkflowRun, eventType: string, payload: Record<string, unknown>, sourceIds?: string[]): Promise<WorkflowRunEvent> {
    const existing = await this.eventsForRun(run.id);
    const event: WorkflowRunEvent = {
      id: randomUUID(),
      version: randomUUID(),
      runId: run.id,
      sequence: existing.length + 1,
      eventType,
      timestamp: nowIso(),
      principalId: run.principalId,
      payload,
      ...(sourceIds !== undefined ? { sourceIds } : {}),
    };
    await this.events.set(event.id, event);
    const observability = this.observability();
    if (observability !== undefined) {
      const terminal = new Set(['input_validation_failed', 'dry_run_completed', 'shadow_recommendation_recorded', 'run_succeeded', 'approval_rejected', 'run_escalated', 'business_outcome_recorded']);
      const failed = eventType === 'input_validation_failed' || eventType === 'tool_execution_failed';
      try {
        await observability.record({
          traceId: run.traceId ?? run.id,
          rootTraceId: run.rootTraceId ?? run.traceId ?? run.id,
          spanId: `workflow-run:${run.id}`,
          ...(run.parentSpanId !== undefined ? { parentSpanId: run.parentSpanId } : {}),
          workflowRunId: run.id,
          timestamp: event.timestamp,
          phase: eventType === 'run_created' ? 'start' : terminal.has(eventType) ? 'end' : 'event',
          kind: 'workflow',
          name: `workflow.${eventType}`,
          status: failed ? 'error' : terminal.has(eventType) ? 'ok' : 'unset',
          attributes: { ...payload, eventType, sequence: event.sequence, workspaceId: run.workspaceId, workflowId: run.workflowId, mode: run.mode, completionState: run.completionState, sourceIds: sourceIds ?? [] },
        });
      } catch (error) {
        console.warn(`[workflow-governance] observability sink failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return event;
  }

  /**
   * Loads all events of a run sorted by sequence number.
   * @param runId - Run id.
   * @returns The run's events in ascending sequence order.
   * @throws Never.
   */
  private async eventsForRun(runId: string): Promise<WorkflowRunEvent[]> {
    const events = await queryAll(this.events, { where: { op: 'eq', field: 'runId', value: runId } });
    return events.sort((left, right) => left.sequence - right.sequence);
  }

  /**
   * Loads all approval records of a run.
   * @param runId - Run id.
   * @returns The run's approvals in store order.
   * @throws Never.
   */
  private async approvalsForRun(runId: string): Promise<WorkflowApproval[]> {
    return queryAll(this.approvals, { where: { op: 'eq', field: 'runId', value: runId } });
  }

  /**
   * Loads a run's still-pending approvals, optionally narrowed to one id.
   * @param runId - Run id.
   * @param approvalId - Restricts the result to this approval when given.
   * @returns Pending approvals in store order (a single item when narrowed).
   * @throws Never.
   */
  private async pendingApprovals(runId: string, approvalId?: string): Promise<WorkflowApproval[]> {
    const approvals = await this.approvalsForRun(runId);
    return approvals.filter(approval => approval.status === 'pending' && (approvalId === undefined || approval.id === approvalId));
  }
}

/**
 * {@link WorkflowCompiler} implementation persisting compilations to a store. Compilation ids are content-derived (see {@link stableCompilationId}), so repeated identical inputs update the same record rather than creating duplicates.
 */
class StoreBackedWorkflowCompiler implements WorkflowCompiler {
  private readonly registry: WorkflowRegistry;
  private readonly runner: WorkflowRunner;
  private readonly compilations: Store<WorkflowCompilation>;

  /**
   * Wires the compiler to its registry, runner and compilation store.
   * @param registry - Registry validating and publishing compiled definitions.
   * @param runner - Runner executing compiled dry runs.
   * @param compilations - Store for compilation records.
   * @throws Never.
   */
  constructor(registry: WorkflowRegistry, runner: WorkflowRunner, compilations: Store<WorkflowCompilation>) {
    this.registry = registry;
    this.runner = runner;
    this.compilations = compilations;
  }

  /**
   * Derives the deterministic compilation id for an input: workspace, normalized workflow name and a hash over the purpose, transcript, messages, sources, tool calls, input hints and sample inputs. Identical inputs therefore share one compilation record.
   * @param input - Compilation input.
   * @returns Deterministic id of the form `workflow-compilation:<hash>`.
   * @throws Never.
   */
  stableCompilationId(input: WorkflowCompileInput): string {
    return hashId('workflow-compilation', [
      input.workspaceId,
      normalizeName(inferWorkflowName(input)),
      hashPayload({
        purpose: input.purpose,
        transcript: input.transcript,
        messages: input.messages ?? [],
        sourceIds: compileSourceIds(input),
        toolCalls: compileToolCalls(input),
        inputHints: input.inputHints ?? [],
        sampleInputs: input.sampleInputs ?? {},
      }),
    ]);
  }

  /**
   * Compiles (and optionally publishes and dry-runs) a workflow definition. The draft is always compiled and persisted as an up-to-date record; with `publish: true` and a valid draft the definition is upserted into the registry; with `dryRun: true` and a successful publish, a dry run of the compiled sample inputs is started (its failures are captured as warnings, never thrown). The recorded status tracks the furthest stage reached: `drafted`, `published`, `dry_run_completed` or `failed`.
   * @param input - Compilation input including the publish/dry-run switches.
   * @returns The compilation record plus the draft definition, validation errors, and the published definition/version and dry run when applicable.
   * @throws Never.
   */
  async compile(input: WorkflowCompileInput): Promise<WorkflowCompileResult> {
    const existing = await this.compilations.get(this.stableCompilationId(input));
    const timestamp = nowIso();
    const compiled = compileWorkflowDefinition(input);
    let validation = this.registry.validateDefinition(compiled.definition);
    let status: WorkflowCompilationStatus = 'drafted';
    let published: { definition: WorkflowDefinition; version: WorkflowVersion; validation: ValidationError[] } | undefined;
    let dryRun: WorkflowRun | undefined;
    const warnings = [...compiled.warnings];

    if (input.publish === true && validation.length === 0) {
      published = await this.registry.upsertDefinition(compiled.definition);
      validation = published.validation;
      status = validation.length === 0 ? 'published' : 'failed';
    } else if (input.publish !== true && input.dryRun === true) {
      warnings.push('dryRun was requested without publish=true; no run was created.');
    }

    if (input.dryRun === true && published !== undefined && validation.length === 0) {
      try {
        dryRun = await this.runner.startRun({
          workspaceId: input.workspaceId,
          workflowId: published.definition.id,
          mode: 'dry_run',
          inputs: compiled.sampleInputs,
          evidenceSourceIds: compiled.sourceIds,
          proposedActions: compiled.proposals,
          labels: input.labels ?? [],
        });
        status = dryRun.status === 'succeeded' ? 'dry_run_completed' : 'failed';
        if (dryRun.error !== undefined) warnings.push(dryRun.error);
      } catch (error) {
        status = 'failed';
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }

    const compilation: WorkflowCompilation = {
      id: this.stableCompilationId(input),
      version: randomUUID(),
      workspaceId: input.workspaceId,
      status,
      compilerVersion: WORKFLOW_COMPILER_VERSION,
      inputHash: hashPayload({
        purpose: input.purpose,
        transcript: input.transcript,
        messages: input.messages ?? [],
        sourceIds: compiled.sourceIds,
        toolCalls: compileToolCalls(input),
        inputHints: input.inputHints ?? [],
        sampleInputs: compiled.sampleInputs,
      }),
      definition: compiled.definition,
      validation,
      sourceIds: compiled.sourceIds,
      toolNames: uniq(compiled.proposals.map(proposal => proposal.toolName)),
      proposedActions: compiled.proposals,
      sampleInputs: compiled.sampleInputs,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(published !== undefined ? { workflowId: published.definition.id, workflowVersion: published.definition.version } : {}),
      ...(dryRun !== undefined ? { dryRunId: dryRun.id } : {}),
      ...(warnings.length > 0 ? { warnings: uniq(warnings) } : {}),
    };
    await this.compilations.set(compilation.id, compilation);
    return {
      compilation,
      definition: compiled.definition,
      validation,
      ...(published !== undefined ? { published } : {}),
      ...(dryRun !== undefined ? { dryRun } : {}),
    };
  }

  /**
   * Fetches a compilation record by id.
   * @param id - Compilation id (see {@link stableCompilationId}).
   * @returns The compilation, or `null` when unknown.
   * @throws Never.
   */
  getCompilation(id: string): Promise<WorkflowCompilation | null> {
    return this.compilations.get(id);
  }

  /**
   * Queries stored compilation records.
   * @param query - Optional filter/sort; matches everything when omitted.
   * @returns Matching compilations in the store/query-determined order.
   * @throws Never.
   */
  queryCompilations(query?: StoreQuery): Promise<WorkflowCompilation[]> {
    return queryAll(this.compilations, query);
  }
}

/**
 * Infers a connector capability from a tool-call input: `write` when the stringified `action` field matches a mutating verb (write, update, delete, create, set_, configure, approve, reject, execute, reindex, upsert, register), otherwise `read`. Non-record inputs are always `read`.
 * @param input - Tool-call input, of any shape.
 * @returns Inferred capability.
 * @throws Never.
 */
function inferCapability(input: unknown): ConnectorCapability {
  if (!isPlainRecord(input)) return 'read';
  const action = String(input['action'] ?? '').toLowerCase();
  if (/(write|update|delete|create|set_|configure|approve|reject|execute|reindex|upsert|register)/.test(action)) return 'write';
  return 'read';
}

/**
 * Extracts the workflow run id governing a tool call, from either a top-level `workflowRunId` field or a nested `workflow.runId` record.
 * @param input - Tool-call input, of any shape.
 * @returns The run id, or `undefined` when the input is not workflow-scoped.
 * @throws Never.
 */
function extractWorkflowRunId(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return undefined;
  if (typeof input['workflowRunId'] === 'string') return input['workflowRunId'];
  if (isPlainRecord(input['workflow']) && typeof input['workflow']['runId'] === 'string') return input['workflow']['runId'];
  return undefined;
}

/**
 * Extracts a connector instance id from the top-level `connectorInstanceId` field of a tool-call input.
 * @param input - Tool-call input, of any shape.
 * @returns The connector instance id, or `undefined` when absent.
 * @throws Never.
 */
function extractConnectorInstanceId(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return undefined;
  if (typeof input['connectorInstanceId'] === 'string') return input['connectorInstanceId'];
  return undefined;
}

/**
 * Arguments of the `workflow_action` tool: the action discriminator plus the flattened fields of the compile, start-run and decision operations it dispatches to.
 */
interface WorkflowActionInput {
  action: string;
  compile?: WorkflowCompileInput;
  compilationId?: string;
  definition?: WorkflowDefinitionInput;
  workflowId?: string;
  workflowName?: string;
  workflowVersion?: string;
  workspaceId?: string;
  name?: string;
  purpose?: string;
  transcript?: string;
  messages?: WorkflowCompilerMessage[];
  sourceIds?: string[];
  toolCalls?: WorkflowCompilerToolCall[];
  inputHints?: WorkflowInputHint[];
  riskLevel?: WorkflowRiskLevel;
  approvalGates?: ApprovalGate[];
  successMetrics?: string[];
  publish?: boolean;
  dryRun?: boolean;
  sampleInputs?: Record<string, unknown>;
  mode?: WorkflowRunMode;
  inputs?: Record<string, unknown>;
  evidenceSourceIds?: string[];
  proposedActions?: ActionProposalInput[];
  labels?: string[];
  label?: string;
  note?: string;
  runId?: string;
  approvalId?: string;
  reason?: string;
  query?: StoreQuery;
}

/**
 * Builds the `workflow_action` tool exposing the registry, runner and compiler services to the LLM. The tool's execute generator dispatches on the required `action` field (compile, draft, validate, start, approve, reject, escalate, shadow labeling/reporting, inspect and list operations), yielding `result` events on success and `error` events for missing parameters, unknown actions and failures thrown by the underlying services — the generator itself never throws.
 * @param registry - Registry used by the draft/validate operations.
 * @param runner - Runner used by the run lifecycle operations.
 * @param compiler - Compiler used by the compile/compilation-query operations.
 * @returns The `workflow_action` tool definition.
 * @throws Never.
 */
function createWorkflowActionTool(registry: WorkflowRegistry, runner: WorkflowRunner, compiler: WorkflowCompiler): Tool {
  return {
    name: 'workflow_action',
    description:
      'Compile, draft, and validate governed workflow definitions, create dry-run/shadow/approval-gated workflow runs, inspect the run ledger, and approve or reject pending workflow actions.\n\n' +
      'Actions: compile, get_compilation, compilations, draft, validate, dry_run, start, approve, reject, escalate, label_shadow_result, compare_shadow_result, shadow_report, inspect_run, list_runs, list_approvals.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['compile', 'get_compilation', 'compilations', 'draft', 'validate', 'dry_run', 'start', 'approve', 'reject', 'escalate', 'label_shadow_result', 'compare_shadow_result', 'shadow_report', 'inspect_run', 'list_runs', 'list_approvals'] },
        compile: { type: 'object' },
        compilationId: { type: 'string' },
        definition: { type: 'object' },
        workflowId: { type: 'string' },
        workflowName: { type: 'string' },
        workflowVersion: { type: 'string' },
        workspaceId: { type: 'string' },
        name: { type: 'string' },
        purpose: { type: 'string' },
        transcript: { type: 'string' },
        messages: { type: 'array', items: { type: 'object' } },
        sourceIds: { type: 'array', items: { type: 'string' } },
        toolCalls: { type: 'array', items: { type: 'object' } },
        inputHints: { type: 'array', items: { type: 'object' } },
        riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        approvalGates: { type: 'array', items: { type: 'object' } },
        successMetrics: { type: 'array', items: { type: 'string' } },
        publish: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        sampleInputs: { type: 'object' },
        mode: { type: 'string', enum: ['dry_run', 'shadow', 'approval_gated', 'execute'] },
        inputs: { type: 'object' },
        evidenceSourceIds: { type: 'array', items: { type: 'string' } },
        proposedActions: { type: 'array', items: { type: 'object' } },
        labels: { type: 'array', items: { type: 'string' } },
        label: { type: 'string' },
        note: { type: 'string' },
        runId: { type: 'string' },
        approvalId: { type: 'string' },
        reason: { type: 'string' },
        query: { type: 'object' },
      },
    },
    executor: {
      async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const parsed = input && typeof input === 'object' ? input as WorkflowActionInput : { action: '' };
        try {
          switch (parsed.action) {
            case 'compile':
              yield { type: 'result', value: await compiler.compile(workflowCompileInputFromAction(parsed)) };
              return;
            case 'get_compilation':
              if (parsed.compilationId === undefined) { yield { type: 'error', message: 'workflow_action get_compilation requires "compilationId".' }; return; }
              yield { type: 'result', value: { compilation: await compiler.getCompilation(parsed.compilationId) } };
              return;
            case 'compilations':
              yield { type: 'result', value: { compilations: await compiler.queryCompilations(parsed.query) } };
              return;
            case 'draft':
              if (parsed.definition === undefined) { yield { type: 'error', message: 'workflow_action draft requires "definition".' }; return; }
              yield { type: 'result', value: await registry.upsertDefinition(parsed.definition) };
              return;
            case 'validate':
              if (parsed.definition !== undefined) {
                yield { type: 'result', value: { valid: registry.validateDefinition(parsed.definition).length === 0, errors: registry.validateDefinition(parsed.definition) } };
                return;
              }
              if (parsed.workflowId === undefined || parsed.inputs === undefined) {
                yield { type: 'error', message: 'workflow_action validate requires "definition" or "workflowId" and "inputs".' };
                return;
              }
              {
                const definition = await registry.getDefinition(parsed.workflowId);
                if (definition === null) { yield { type: 'error', message: `Unknown workflow "${parsed.workflowId}".` }; return; }
                const errors = validateSchemaValue(definition.inputSchema, parsed.inputs);
                yield { type: 'result', value: { valid: errors.length === 0, errors } };
              }
              return;
            case 'dry_run':
              yield { type: 'result', value: await runner.startRun({ ...startInput(parsed, 'dry_run'), ...toolTraceInput(ctx) }) };
              return;
            case 'start':
              yield { type: 'result', value: await runner.startRun({ ...startInput(parsed, parsed.mode), ...toolTraceInput(ctx) }) };
              return;
            case 'approve':
              if (parsed.runId === undefined) { yield { type: 'error', message: 'workflow_action approve requires "runId".' }; return; }
              yield { type: 'result', value: await runner.approveRun(parsed.runId, parsed.approvalId, parsed.reason) };
              return;
            case 'reject':
              if (parsed.runId === undefined) { yield { type: 'error', message: 'workflow_action reject requires "runId".' }; return; }
              yield { type: 'result', value: await runner.rejectRun(parsed.runId, parsed.approvalId, parsed.reason) };
              return;
            case 'escalate':
              if (parsed.runId === undefined || parsed.reason === undefined) { yield { type: 'error', message: 'workflow_action escalate requires "runId" and "reason".' }; return; }
              yield { type: 'result', value: await runner.escalateRun(parsed.runId, parsed.reason) };
              return;
            case 'label_shadow_result':
              if (parsed.runId === undefined) { yield { type: 'error', message: 'workflow_action label_shadow_result requires "runId".' }; return; }
              {
                const run = await runner.labelShadowResult(parsed.runId, uniq([...(parsed.labels ?? []), ...(parsed.label !== undefined ? [parsed.label] : [])]), parsed.note);
                const comparisons = await runner.shadowComparisons({ where: { op: 'eq', field: 'runId', value: run.id } });
                yield { type: 'result', value: { run, comparison: comparisons[0] ?? null } };
              }
              return;
            case 'compare_shadow_result':
              if (parsed.runId === undefined) { yield { type: 'error', message: 'workflow_action compare_shadow_result requires "runId".' }; return; }
              yield { type: 'result', value: await runner.compareShadowRun(parsed.runId, uniq([...(parsed.labels ?? []), ...(parsed.label !== undefined ? [parsed.label] : [])]), parsed.note) };
              return;
            case 'shadow_report':
              yield { type: 'result', value: { summary: await runner.shadowSummary(parsed.query), comparisons: await runner.shadowComparisons(parsed.query) } };
              return;
            case 'inspect_run':
              if (parsed.runId === undefined) { yield { type: 'error', message: 'workflow_action inspect_run requires "runId".' }; return; }
              yield { type: 'result', value: await runner.inspectRun(parsed.runId) };
              return;
            case 'list_runs':
              yield { type: 'result', value: { runs: await runner.listRuns(parsed.query) } };
              return;
            case 'list_approvals':
              yield { type: 'result', value: { approvals: await runner.listApprovals(parsed.query) } };
              return;
            default:
              yield { type: 'error', message: `Unknown workflow_action "${String(parsed.action)}".` };
          }
        } catch (error) {
          yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
        }
      },
    },
  };
}

/**
 * Builds a {@link WorkflowCompileInput} from `workflow_action` arguments: the nested `compile` object wins when present; otherwise the flat top-level compile fields are assembled.
 * @param parsed - Parsed tool-call arguments.
 * @returns The compilation input.
 * @throws Error - When neither `compile` nor `workspaceId` was supplied.
 */
function workflowCompileInputFromAction(parsed: WorkflowActionInput): WorkflowCompileInput {
  if (parsed.compile !== undefined) return parsed.compile;
  if (parsed.workspaceId === undefined) throw new Error('workflow_action compile requires "workspaceId" or nested "compile.workspaceId".');
  return {
    workspaceId: parsed.workspaceId,
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.purpose !== undefined ? { purpose: parsed.purpose } : {}),
    ...(parsed.transcript !== undefined ? { transcript: parsed.transcript } : {}),
    ...(parsed.messages !== undefined ? { messages: parsed.messages } : {}),
    ...(parsed.sourceIds !== undefined ? { sourceIds: parsed.sourceIds } : {}),
    ...(parsed.toolCalls !== undefined ? { toolCalls: parsed.toolCalls } : {}),
    ...(parsed.inputHints !== undefined ? { inputHints: parsed.inputHints } : {}),
    ...(parsed.riskLevel !== undefined ? { riskLevel: parsed.riskLevel } : {}),
    ...(parsed.approvalGates !== undefined ? { approvalGates: parsed.approvalGates } : {}),
    ...(parsed.successMetrics !== undefined ? { successMetrics: parsed.successMetrics } : {}),
    ...(parsed.publish !== undefined ? { publish: parsed.publish } : {}),
    ...(parsed.dryRun !== undefined ? { dryRun: parsed.dryRun } : {}),
    ...(parsed.sampleInputs !== undefined ? { sampleInputs: parsed.sampleInputs } : {}),
    ...(parsed.labels !== undefined ? { labels: parsed.labels } : {}),
  };
}

/**
 * Copies the tool call's tracing identifiers (traceId, rootTraceId, parentSpanId) into a partial start-run input so workflow runs correlate with the calling turn.
 * @param ctx - Tool-call context carrying the trace identifiers.
 * @returns Trace fields, each present only when defined.
 * @throws Never.
 */
function toolTraceInput(ctx: ToolContext): Pick<StartWorkflowInput, 'traceId' | 'rootTraceId' | 'parentSpanId'> {
  return {
    ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
    ...(ctx.rootTraceId !== undefined ? { rootTraceId: ctx.rootTraceId } : {}),
    ...(ctx.parentSpanId !== undefined ? { parentSpanId: ctx.parentSpanId } : {}),
  };
}

/**
 * Builds a {@link StartWorkflowInput} from `workflow_action` arguments, applying the given run mode and defaulting inputs, evidence sources, proposals and labels to empty collections.
 * @param parsed - Parsed tool-call arguments.
 * @param mode - Run mode to force; `undefined` keeps the parsed `mode` (or the definition default) untouched.
 * @returns The start-run input.
 * @throws Error - When `workspaceId` was not supplied.
 */
function startInput(parsed: WorkflowActionInput, mode?: WorkflowRunMode): StartWorkflowInput {
  if (parsed.workspaceId === undefined) throw new Error('workflow_action start requires "workspaceId".');
  return {
    workspaceId: parsed.workspaceId,
    ...(parsed.workflowId !== undefined ? { workflowId: parsed.workflowId } : {}),
    ...(parsed.workflowName !== undefined ? { workflowName: parsed.workflowName } : {}),
    ...(parsed.workflowVersion !== undefined ? { workflowVersion: parsed.workflowVersion } : {}),
    ...(mode !== undefined ? { mode } : {}),
    inputs: parsed.inputs ?? {},
    evidenceSourceIds: parsed.evidenceSourceIds ?? [],
    proposedActions: parsed.proposedActions ?? [],
    labels: parsed.labels ?? [],
  };
}

/**
 * Evaluates the tool-call policy for a workflow-scoped tool call and produces a hook rejection when the call is denied. Calls outside any workflow run (no `workflowRunId` in the input) are always allowed.
 * @param runner - Runner providing the policy evaluation.
 * @param ctx - Tool-call hook context for the pending call.
 * @returns `{ rejectTool }` with the denial reason when policy blocks the call, or `undefined` when the call may proceed.
 * @throws Never.
 */
async function rejectIfWorkflowDenied(runner: WorkflowRunner, ctx: ToolCallContext): Promise<{ rejectTool: { message: string } } | undefined> {
  const decision = await runner.evaluateToolPolicy(ctx.toolCall.name, ctx.toolCall.input, tryCurrentPrincipal() ?? undefined);
  if (!decision.active || decision.allowed) return undefined;
  return { rejectTool: { message: decision.reason ?? `Workflow policy denied tool "${ctx.toolCall.name}".` } };
}

/**
 * Hook helper that records an executed tool result against the workflow run governing the tool call. No-op when the call is not workflow-scoped, the run is unknown, or no approved proposal matches the tool name.
 * @param runner - Runner receiving the recorded result.
 * @param ctx - Tool-result hook context (result payload, error flag, duration).
 * @returns Promise resolving once the run ledger (when touched) is updated.
 * @throws Never.
 */
async function recordWorkflowToolResult(runner: WorkflowRunner, ctx: ToolResultContext): Promise<void> {
  const workflowRunId = extractWorkflowRunId(ctx.toolCall.input);
  if (workflowRunId === undefined) return;
  await runner.recordToolResult(workflowRunId, ctx.toolCall.name, ctx.result, ctx.isError, ctx.durationMs);
}

/**
 * Registers the plugin's toolcall and toolresult hooks: a `toolcall` hook (priority 15) rejecting workflow-denied calls via {@link rejectIfWorkflowDenied}, and a `toolresult` hook (priority 25) recording executed workflow actions via {@link recordWorkflowToolResult}.
 * @param runner - Runner providing policy evaluation and result recording.
 * @param services - Runtime machine whose hook registry receives the handlers.
 * @throws Never.
 */
function registerWorkflowHooks(runner: WorkflowRunner, services: MatbotMachine): void {
  services.hooks.register({
    on: 'toolcall',
    priority: 15,
    async handler(ctx) {
      return rejectIfWorkflowDenied(runner, ctx);
    },
  });

  services.hooks.register({
    on: 'toolresult',
    priority: 25,
    async handler(ctx) {
      await recordWorkflowToolResult(runner, ctx);
    },
  });
}

/**
 * Builds the store-backed {@link WorkflowRegistry}.
 * @param services - Runtime machine providing stores.
 * @returns The registry instance.
 * @throws Never.
 */
export function createWorkflowRegistry(services: MatbotMachine): WorkflowRegistry {
  return new StoreBackedWorkflowRegistry(
    services.createStore<WorkflowDefinition>(DEFINITION_STORE),
    services.createStore<WorkflowVersion>(VERSION_STORE),
    services.createStore<WorkflowEvalCase>(EVAL_CASE_STORE),
  );
}

/**
 * Builds the store-backed {@link WorkflowRunner}, wired to optional
 * SourceRegistry, ConnectorRegistry and Observability services when present.
 * @param services - Runtime machine providing stores.
 * @param registry - Registry resolving definitions and versions.
 * @returns The runner instance.
 * @throws Never.
 */
export function createWorkflowRunner(services: MatbotMachine, registry: WorkflowRegistry): WorkflowRunner {
  const sourceRegistry = services.get('SourceRegistry' as never) as SourceRegistryLike | undefined;
  const connectorRegistry = services.get('ConnectorRegistry' as never) as ConnectorRegistryLike | undefined;
  return new StoreBackedWorkflowRunner(
    registry,
    services.createStore<WorkflowRun>(RUN_STORE),
    services.createStore<WorkflowRunEvent>(EVENT_STORE),
    services.createStore<WorkflowApproval>(APPROVAL_STORE),
    services.createStore<WorkflowShadowComparison>(SHADOW_COMPARISON_STORE),
    sourceRegistry,
    connectorRegistry,
    () => services.get('Observability') as ObservabilityLike | undefined,
  );
}

/**
 * Builds the store-backed {@link WorkflowCompiler}, persisting compilations to the shared compilation store.
 * @param services - Runtime machine providing stores.
 * @param registry - Registry validating and publishing compiled definitions.
 * @param runner - Runner executing compiled dry runs.
 * @returns The compiler instance.
 * @throws Never.
 */
export function createWorkflowCompiler(services: MatbotMachine, registry: WorkflowRegistry, runner: WorkflowRunner): WorkflowCompiler {
  return new StoreBackedWorkflowCompiler(
    registry,
    runner,
    services.createStore<WorkflowCompilation>(COMPILATION_STORE),
  );
}

/**
 * Default plugin specification registering the three workflow services, the
 * `workflow_action` tool and the toolcall/toolresult policy hooks.
 *
 * @returns The plugin specification.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Registers WorkflowRegistry, WorkflowRunner, WorkflowCompiler, workflow_action, and workflow-scoped connector policy hooks.',
  },
  /**
   * Registers the web UI contribution, the three workflow services, the
   * `workflow_action` tool and the toolcall/toolresult policy hooks.
   * @param services - Runtime machine to register into.
   * @returns Promise resolving once all registrations complete.
   * @throws Never.
   */
  async setup(services: MatbotMachine) {
    services.contributions?.register('webui','workflows',uiContribution);
    const registry = createWorkflowRegistry(services);
    const runner = createWorkflowRunner(services, registry);
    const compiler = createWorkflowCompiler(services, registry, runner);
    await services.register('WorkflowRegistry', registry);
    await services.register('WorkflowRunner', runner);
    await services.register('WorkflowCompiler', compiler);
    services.tools.register(createWorkflowActionTool(registry, runner, compiler));
    registerWorkflowHooks(runner, services);
  },
};

export default plugin;
