import type {} from '@matatbread/matbot-capabilities-types';
import {uiContribution} from './ui.js';
import { createHash, randomUUID } from 'node:crypto';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type {
  MatbotMachine,
  MatbotPluginSpec,
  ObservabilityEvent,
  ObservabilitySink,
  ObservabilitySpanKind,
  ObservabilityStatus,
  Store,
  StoreQuery,
  Tool,
  ToolContext,
  ToolEvent,
} from '@matatbread/matbot-plugin-api';

/** Aggregated trace record: rollup of spans/events with token and cost totals. */
export interface CortexTrace {
  id: string;
  version: string;
  traceId: string;
  rootTraceId: string;
  workspaceId: string;
  status: ObservabilityStatus;
  startedAt: string;
  updatedAt: string;
  spanCount: number;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  workflowRunIds: string[];
  sessionId?: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
}

/** A single span within a trace (llm, tool, retriever, guardrail, ...). */
export interface CortexSpan {
  id: string;
  version: string;
  traceId: string;
  rootTraceId: string;
  spanId: string;
  kind: ObservabilitySpanKind;
  name: string;
  status: ObservabilityStatus;
  startedAt: string;
  updatedAt: string;
  attributes: Record<string, unknown>;
  parentSpanId?: string;
  sessionId?: string;
  workflowRunId?: string;
  endedAt?: string;
  durationMs?: number;
}

/** A persisted observability event with store identity. */
export interface CortexTraceEvent extends ObservabilityEvent {
  id: string;
  version: string;
  attributes?: Record<string, unknown>;
}

//** The scorer implementations evaluation suites can apply. */
export type ScorerType =
  | 'equals'
  | 'contains'
  | 'json_schema'
  | 'workflow_status'
  | 'citation_count'
  | 'tool_sequence'
  | 'latency_budget'
  | 'cost_budget'
  | 'policy_decision'
  | 'retrieval_precision_at_k'
  | 'retrieval_recall_at_k'
  | 'model_rubric';

/** One configured scorer inside an evaluation suite. */
export interface ScorerDefinition {
  id: string;
  version: string;
  workspaceId: string;
  name: string;
  type: ScorerType;
  threshold: number;
  weight: number;
  required: boolean;
  createdAt: string;
  updatedAt: string;
  path?: string;
  expected?: unknown;
  rubric?: string;
  provider?: string;
  modelVersion?: string;
  config?: Record<string, unknown>;
}

/** Fields accepted when defining a scorer; omitted fields take defaults. */
export type ScorerDefinitionInput = Omit<ScorerDefinition, 'id' | 'version' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'threshold' | 'weight' | 'required'> & {
  id?: string;
  threshold?: number;
  weight?: number;
  required?: boolean;
};

/** A single test case in a suite: input, expectation, and which scorers judge it. */
export interface EvaluationCase {
  id: string;
  version: string;
  suiteId: string;
  workspaceId: string;
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  scorerIds: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** Fields accepted when defining a case inside `EvaluationSuiteInput`. */
export interface EvaluationCaseInput {
  id?: string;
  name: string;
  input?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  scorerIds?: string[];
  tags?: string[];
}

/** A named regression suite of cases plus scorers and a pass threshold. */
export interface EvaluationSuite {
  id: string;
  version: string;
  workspaceId: string;
  name: string;
  description?: string;
  caseIds: string[];
  scorerIds: string[];
  passThreshold: number;
  createdAt: string;
  updatedAt: string;
}

/** Fields accepted by `upsertSuite`. */
export interface EvaluationSuiteInput {
  id?: string;
  workspaceId: string;
  name: string;
  description?: string;
  cases?: EvaluationCaseInput[];
  scorers?: ScorerDefinitionInput[];
  passThreshold?: number;
}

/** Record of one execution of an evaluation suite against a candidate. */
export interface EvaluationRun {
  id: string;
  version: string;
  suiteId: string;
  suiteVersion: string;
  workspaceId: string;
  candidate: string;
  status: 'running' | 'completed' | 'failed';
  passed: boolean;
  score: number;
  passRate: number;
  caseCount: number;
  startedAt: string;
  updatedAt: string;
  traceId: string;
  finishedAt?: string;
  error?: string;
}

/** One scorer's verdict for one case in an evaluation run. */
export interface ScoreResult {
  id: string;
  version: string;
  evaluationRunId: string;
  suiteId: string;
  caseId: string;
  scorerId: string;
  scorerVersion: string;
  scorerType: ScorerType;
  passed: boolean;
  score: number;
  weight: number;
  rationale: string;
  createdAt: string;
  actual?: unknown;
  expected?: unknown;
  evaluatorTraceId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Manual-effort and cost baseline used to compute ROI for a workflow. */
export interface RoiBaseline {
  id: string;
  version: string;
  workspaceId: string;
  workflowId: string;
  name: string;
  manualActiveMinutes: number;
  loadedHourlyRateUsd: number;
  effectiveFrom: string;
  createdAt: string;
  updatedAt: string;
  fixedCostUsd?: number;
  notes?: string;
}

/** A recorded business outcome of one workflow run, judged against a baseline. */
export interface OutcomeEvent {
  id: string;
  version: string;
  workspaceId: string;
  workflowId: string;
  workflowRunId: string;
  baselineId: string;
  status: 'verified_completed' | 'estimated_completed' | 'failed' | 'cancelled' | 'escalated';
  humanActiveMinutes: number;
  reviewMinutes: number;
  reworkMinutes: number;
  additionalValueUsd: number;
  occurredAt: string;
  recordedAt: string;
  verifiedByPrincipalId?: string;
  traceId?: string;
  note?: string;
}

/** Workspace-level operational metrics aggregated across traces, outcomes, and evaluation runs. */
export interface ObservabilityMetrics {
  traces: { total: number; completed: number; errors: number };
  tokens: { input: number; output: number };
  costUsd: number;
  latencyMs: { average: number; p50: number; p95: number; p99: number };
  spans: Record<string, number>;
  retrieval: { operations: number; averageLatencyMs: number; scoredResults: number; averageScore: number };
  citations: { resolved: number; tracesWithCitations: number; coverageRate: number };
  actions: { attempted: number; succeeded: number; failed: number; successRate: number };
  policy: { decisions: number; denied: number; denyRate: number };
  workflows: { outcomes: number; verifiedCompleted: number; failed: number; escalated: number; completionRate: number; escalationRate: number; approvalsRequested: number; approvalsApproved: number; approvalsRejected: number; approvalRate: number; averageApprovalWaitMs: number };
  evaluations: { runs: number; passed: number; passRate: number };
}

/** Computed return-on-investment report for a workspace. */
export interface RoiReport {
  workspaceId: string;
  verifiedOutcomes: number;
  timeSavedHours: number;
  laborBenefitUsd: number;
  additionalValueUsd: number;
  operatingCostUsd: number;
  fixedCostUsd: number;
  totalBenefitUsd: number;
  netBenefitUsd: number;
  roi: number | null;
  paybackOutcomes: number | null;
  byWorkflow: Array<{
    workflowId: string;
    verifiedOutcomes: number;
    timeSavedHours: number;
    benefitUsd: number;
  }>;
}

/**
 * Minimal shape of the optional `WorkflowRunner` service: used to dry-run workflow-based evaluation
 * cases and to mirror recorded business outcomes onto runs. Looked up per call, so its absence
 * simply disables both paths.
 */
interface WorkflowRunnerLike {
  startRun(input: {
    workflowId?: string;
    workflowVersion?: string;
    workflowName?: string;
    workspaceId: string;
    mode: 'dry_run';
    inputs?: Record<string, unknown>;
    evidenceSourceIds?: string[];
    proposedActions?: Array<Record<string, unknown>>;
    labels?: string[];
  }): Promise<unknown>;
  recordBusinessOutcome?(runId: string, outcomeId: string, status: 'verified_completed' | 'estimated_completed' | 'failed' | 'cancelled' | 'escalated'): Promise<unknown>;
}

/** Store-backed observability sink extended with traces inspection,
 *  side-effect-free replay, regression suites, metrics, and ROI reporting. */
export interface EvaluationObservability extends ObservabilitySink {

  /** Lists stored trace aggregates.
   * @param query Optional filter/sort/paging.
   * @returns Matching {@link CortexTrace} records. */
  listTraces(query?: StoreQuery): Promise<CortexTrace[]>;
  /** Loads everything recorded about one trace.
   * @param traceId Trace to inspect.
   * @returns The trace aggregate, its time-ordered spans/events, and evaluator scores. */
  inspectTrace(traceId: string): Promise<{ trace: CortexTrace | null; spans: CortexSpan[]; events: CortexTraceEvent[]; scores: ScoreResult[] }>;
  /** Replays a trace as playback only — no writes are executed.
   * @param traceId Trace to replay.
   * @returns The trace and its event timeline, explicitly marked playback/no-writes. */
  replayTrace(traceId: string): Promise<{ mode: 'playback'; writesExecuted: false; trace: CortexTrace | null; timeline: CortexTraceEvent[] }>;
  /** Creates or updates a suite along with its embedded cases and scorers.
   * @param input Suite definition; ids derive from workspace/name when omitted.
   * @returns The stored suite plus the cases and scorers written this call. */
  upsertSuite(input: EvaluationSuiteInput): Promise<{ suite: EvaluationSuite; cases: EvaluationCase[]; scorers: ScorerDefinition[] }>;
  /** Lists stored evaluation suites.
   * @param query Optional filter/sort/paging.
   * @returns Matching suites. */
  listSuites(query?: StoreQuery): Promise<EvaluationSuite[]>;
  /** Executes every case in a suite, scoring each with its assigned scorers.
   *  Cases resolve their target from a trace id, a workflow dry-run, or inline input;
   *  `model_rubric` scorers call the given (or fallback) provider via `singleTurn`.
   * @param suiteId Suite to run.
   * @param candidate Candidate label recorded on the run.
   * @param provider Optional provider for model-rubric scoring.
   * @returns The completed run and all score results.
   * @throws If the suite is unknown, or if case resolution fails (the failed run is persisted before rethrowing). */
  runSuite(suiteId: string, candidate?: string, provider?: string): Promise<{ run: EvaluationRun; results: ScoreResult[] }>;
  /** Lists recorded evaluation runs.
   * @param query Optional filter/sort/paging.
   * @returns Matching runs. */
  listEvaluationRuns(query?: StoreQuery): Promise<EvaluationRun[]>;
  /** Aggregates operational metrics across traces, spans, events, outcomes, and runs.
   * @param workspaceId Optional workspace filter; omit for all workspaces.
   * @returns The computed metrics snapshot. */
  metrics(workspaceId?: string): Promise<ObservabilityMetrics>;
  /** Creates or updates a manual-effort/cost ROI baseline for a workflow.
   * @param input Baseline fields; negative numbers are clamped to zero.
   * @returns The stored baseline. */
  upsertBaseline(input: Omit<RoiBaseline, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<RoiBaseline>;
  /** Records a business outcome for a workflow run and notifies the WorkflowRunner if present.
   * @param input Outcome fields.
   * @returns The persisted outcome.
   * @throws If the baseline is unknown or belongs to another workspace/workflow,
   *          or a verified outcome lacks `verifiedByPrincipalId`. */
  recordOutcome(input: Omit<OutcomeEvent, 'id' | 'version' | 'recordedAt'> & { id?: string }): Promise<OutcomeEvent>;
  /** Computes the ROI report for a workspace from verified outcomes, baselines,
   *  and trace operating costs.
   * @param workspaceId Workspace to report on.
   * @returns Time saved, benefits, costs, net benefit, ROI ratio, and payback estimate. */
  roi(workspaceId: string): Promise<RoiReport>;
}

const TRACE_STORE = 'observability_traces';
const SPAN_STORE = 'observability_spans';
const EVENT_STORE = 'observability_events';
const SUITE_STORE = 'evaluation_suites';
const CASE_STORE = 'evaluation_cases';
const SCORER_STORE = 'evaluation_scorers';
const EVAL_RUN_STORE = 'evaluation_runs';
const SCORE_STORE = 'evaluation_scores';
const BASELINE_STORE = 'roi_baselines';
const OUTCOME_STORE = 'outcome_events';

/**
 * Current time as an ISO-8601 UTC timestamp.
 *
 * @returns The timestamp string.
 * @throws Never.
 */
function nowIso(): string { return new Date().toISOString(); }

/**
 * Checks for a plain object (non-null, non-array).
 *
 * @param value - The value to test.
 * @returns True when `value` is a record.
 * @throws Never.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Coerces a value to a finite number.
 *
 * @param value - The value to read.
 * @param fallback - Returned when `value` is not a finite number (default 0).
 * @returns `value` when it is a finite number, otherwise `fallback`.
 * @throws Never.
 */
function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Deduplicates strings, preserving first-occurrence order.
 *
 * @param values - The strings to deduplicate.
 * @returns A new array without repeats.
 * @throws Never.
 */
function uniq(values: readonly string[]): string[] { return [...new Set(values)]; }

/**
 * Deterministic JSON-style serialization: object keys are sorted at every level, so two values with
 * equal content produce equal strings regardless of key order. Used for structural equality
 * (e.g. the `equals` and `tool_sequence` scorers) and to derive stable ids.
 *
 * @param value - The value to serialize; assumed JSON-serializable.
 * @returns The canonical string (`'null'` for undefined).
 * @throws Never.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * Derives a stable id from content: a namespaced 24-hex-char SHA-256 prefix of the canonical form
 * (see {@link canonical}) of `values`. Same inputs yield the same id, which is what makes upserts
 * of suites, cases, scorers, and baselines idempotent without caller-supplied ids.
 *
 * @param namespace - Prefix marking the id's kind (e.g. `'evaluation-suite'`).
 * @param values - The identity fields, canonically serialized before hashing.
 * @returns The id as `namespace:<hash>`.
 * @throws Never.
 */
function hashId(namespace: string, values: unknown[]): string {
  return `${namespace}:${createHash('sha256').update(canonical(values)).digest('hex').slice(0, 24)}`;
}

/**
 * Deep redaction/truncation applied to attributes before they are persisted: keys matching
 * secret-ish names (`secret`, `token`, `password`, `authorization`, `credential`, `api key`,
 * `cookie`) are replaced wholesale, and string values have API keys, bearer tokens, and URL
 * credentials masked. Caps depth at 7, strings at 4 000 characters, arrays at 100 entries, and
 * objects at 200 properties.
 *
 * @param value - The value to sanitize.
 * @param key - The key `value` sits under (top-level callers pass `''`); checked against the
 *   secret-name pattern.
 * @param depth - Current recursion depth (callers start at 0).
 * @returns The sanitized copy; scalars other than strings pass through untouched.
 * @throws Never.
 */
function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (/secret|token|password|authorization|credential|api.?key|cookie/i.test(key)) return '[REDACTED]';
  if (depth > 7) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') {
    const redacted = value
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/gi, 'Bearer [REDACTED]')
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s]+@/gi, '$1[REDACTED]@');
    return redacted.length > 4_000 ? `${redacted.slice(0, 4_000)}…[TRUNCATED]` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, key, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).slice(0, 200).map(([childKey, child]) => [childKey, sanitize(child, childKey, depth + 1)]));
  return value;
}

/**
 * {@link sanitize} applied to a whole attributes record (undefined becomes `{}`).
 *
 * @param value - The attributes to sanitize.
 * @returns A sanitized copy, safe to persist.
 * @throws Never.
 */
function sanitizedAttributes(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return (sanitize(value ?? {}) as Record<string, unknown>);
}

/**
 * Drains a store query to completion, following cursor pagination until the store reports no next
 * page. The initial `query` supplies filter/sort; once a cursor appears only the cursor is sent, so
 * the store's own ordering carries across pages.
 *
 * @typeParam T - The stored record type; must carry `id` and `version`.
 * @param store - The store to read.
 * @param query - Initial filter/sort/paging (defaults to everything).
 * @returns All matching items, in the store's query order.
 * @throws If any page fetch rejects.
 */
async function queryAll<T extends { id: string; version: string }>(store: Store<T>, query: StoreQuery = {}): Promise<T[]> {
  const items: T[] = [];
  let next: StoreQuery = query;
  for (;;) {
    const page = await store.query(next);
    items.push(...page.items);
    if (page.cursor === undefined) return items;
    next = { cursor: page.cursor };
  }
}

/**
 * Dot-path lookup into nested records/arrays.
 *
 * @param value - The object to read from.
 * @param path - Dotted key path (e.g. `'trace.durationMs'`); undefined or empty returns `value`
 *   itself.
 * @returns The value at the path, or undefined when any segment is missing or the traversal hits a
 *   non-record.
 * @throws Never.
 */
function field(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current = value;
  for (const part of path.split('.').filter(Boolean)) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Nearest-rank percentile of a sample.
 *
 * @param values - The sample; copied and sorted internally, so need not be pre-sorted.
 * @param fraction - The percentile as a fraction (0.5 → p50, 0.95 → p95, 0.99 → p99).
 * @returns The order-statistic value; 0 for an empty sample.
 * @throws Never.
 */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

/**
 * Filters a value down to its string elements.
 *
 * @param value - Expected to be an array; anything else yields no strings.
 * @returns The array's string elements, in order; `[]` for non-arrays.
 * @throws Never.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Recursively collects distinct citation source ids: a record counts as a citation when it carries a
 * string `sourceId` plus any of `citation`, `citationText`, or `versionId`. Used by the
 * `citation_count` scorer and the citation metrics.
 *
 * @param value - The structure to walk (span attributes, tool output, ...).
 * @param found - Accumulator set, mutated in place (callers usually omit it).
 * @returns The set of distinct source ids found (the same object passed as `found`).
 * @throws Never.
 */
function collectCitations(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(item => collectCitations(item, found));
  else if (isRecord(value)) {
    const sourceId = value['sourceId'];
    if (typeof sourceId === 'string' && ('citation' in value || 'citationText' in value || 'versionId' in value)) found.add(sourceId);
    Object.values(value).forEach(item => collectCitations(item, found));
  }
  return found;
}

/**
 * Extracts the workflow-run ids an event belongs to: the event's own `workflowRunId`, a
 * `workflowRunId` attribute, and — for `workflow_action` events — run ids inside the result payload
 * (`result.id` / `result.run.id`). Deduplicated, first-occurrence order.
 *
 * @param event - The observability event to inspect.
 * @returns The distinct workflow-run ids (possibly empty).
 * @throws Never.
 */
function workflowIdsFromEvent(event: ObservabilityEvent): string[] {
  const ids: string[] = [];
  if (event.workflowRunId !== undefined) ids.push(event.workflowRunId);
  const attrs = event.attributes ?? {};
  if (typeof attrs['workflowRunId'] === 'string') ids.push(attrs['workflowRunId']);
  const result = attrs['result'];
  if (event.name === 'workflow_action' && isRecord(result)) {
    if (typeof result['id'] === 'string') ids.push(result['id']);
    const run = result['run'];
    if (isRecord(run) && typeof run['id'] === 'string') ids.push(run['id']);
  }
  return uniq(ids);
}

/** Deterministic token-cost calculation used by trace aggregation and pricing-contract tests.
 *
 * @param attributes - Event attributes: `costUsd` wins when present and positive; otherwise `model`,
 *   `inputTokens`, `outputTokens`, and `cacheReadTokens` are priced from the
 *   `CORTEX_MODEL_PRICING_JSON` catalog (`inputPerMillionUsd`, `cachedInputPerMillionUsd` defaulting
 *   to the input rate, `outputPerMillionUsd`).
 * @returns The computed cost in USD; 0 when there is no direct cost, no model, no catalog, a
 *   malformed catalog, or a negative quantity/rate.
 * @throws Never — catalog parse failures are swallowed and yield 0.
 */
export function pricedCost(attributes: Record<string, unknown> | undefined): number {
  const direct = asNumber(attributes?.['costUsd']);
  if (direct > 0) return direct;
  const model = attributes?.['model'];
  if (typeof model !== 'string') return 0;
  const raw = process.env['CORTEX_MODEL_PRICING_JSON'];
  if (raw === undefined) return 0;
  try {
    const catalog = JSON.parse(raw) as Record<string, unknown>;
    const price = catalog[model];
    if (!isRecord(price)) return 0;
    const input = asNumber(attributes?.['inputTokens']);
    const output = asNumber(attributes?.['outputTokens']);
    const cached = asNumber(attributes?.['cacheReadTokens']);
    const inputRate = asNumber(price['inputPerMillionUsd']);
    const cachedRate = asNumber(price['cachedInputPerMillionUsd'], inputRate);
    const outputRate = asNumber(price['outputPerMillionUsd']);
    if ([input, output, cached, inputRate, cachedRate, outputRate].some(value => value < 0)) return 0;
    const uncachedInput = Math.max(0, input - cached);
    return (uncachedInput * inputRate + cached * cachedRate + output * outputRate) / 1_000_000;
  } catch {
    return 0;
  }
}

/**
 * Store-backed implementation of {@link EvaluationObservability}: persists events, aggregates spans
 * and trace rollups on ingest, and keeps suites/cases/scorers/runs/scores plus ROI baselines and
 * outcome events in ten dedicated stores. Writes use plain `set` (last write wins) rather than
 * compare-and-swap — the sink is the single writer of its own aggregates.
 */
class StoreBackedEvaluationObservability implements EvaluationObservability {
  private readonly services: MatbotMachine;
  private readonly traces: Store<CortexTrace>;
  private readonly spans: Store<CortexSpan>;
  private readonly events: Store<CortexTraceEvent>;
  private readonly suites: Store<EvaluationSuite>;
  private readonly cases: Store<EvaluationCase>;
  private readonly scorers: Store<ScorerDefinition>;
  private readonly evaluationRuns: Store<EvaluationRun>;
  private readonly scores: Store<ScoreResult>;
  private readonly baselines: Store<RoiBaseline>;
  private readonly outcomes: Store<OutcomeEvent>;

  /**
   * @param services - The matbot machine, used for `singleTurn` (rubric scoring) and the optional
   *   `WorkflowRunner` lookup.
   * @param traces - Store for {@link CortexTrace} aggregates.
   * @param spans - Store for {@link CortexSpan} records.
   * @param events - Store for raw {@link CortexTraceEvent}s.
   * @param suites - Store for {@link EvaluationSuite}s.
   * @param cases - Store for {@link EvaluationCase}s.
   * @param scorers - Store for {@link ScorerDefinition}s.
   * @param evaluationRuns - Store for {@link EvaluationRun}s.
   * @param scores - Store for {@link ScoreResult}s.
   * @param baselines - Store for {@link RoiBaseline}s.
   * @param outcomes - Store for {@link OutcomeEvent}s.
   * @throws Never.
   */
  constructor(
    services: MatbotMachine,
    traces: Store<CortexTrace>,
    spans: Store<CortexSpan>,
    events: Store<CortexTraceEvent>,
    suites: Store<EvaluationSuite>,
    cases: Store<EvaluationCase>,
    scorers: Store<ScorerDefinition>,
    evaluationRuns: Store<EvaluationRun>,
    scores: Store<ScoreResult>,
    baselines: Store<RoiBaseline>,
    outcomes: Store<OutcomeEvent>,
  ) {
    this.services = services;
    this.traces = traces;
    this.spans = spans;
    this.events = events;
    this.suites = suites;
    this.cases = cases;
    this.scorers = scorers;
    this.evaluationRuns = evaluationRuns;
    this.scores = scores;
    this.baselines = baselines;
    this.outcomes = outcomes;
  }

  /**
   * Ingests one observability event (the {@link ObservabilitySink} entry point): persists the
   * event, upserts the owning span, and rolls the aggregate trace up. Attributes are sanitized
   * before any write; span attributes merge with new values winning; identity fields stick from the
   * first sighting. Trace token/cost totals accumulate only on `end` events of `llm`/`evaluator`
   * kind (cost via {@link pricedCost}); the trace's `status`/`endedAt`/`durationMs` are set by the
   * agent kind's `end` event; `spanCount` is recomputed from the spans store and `eventCount`
   * incremented per event. `workspaceId` comes from the existing trace, else the event's
   * `workspaceId` attribute, else `CORTEX_WORKSPACE_ID`, else `'default'`.
   *
   * @param raw - The event to record.
   * @returns Resolves when all three writes (event, span, trace) complete.
   * @throws If any of the event/span/trace store writes rejects.
   */
  async record(raw: ObservabilityEvent): Promise<void> {
    const event: CortexTraceEvent = {
      ...raw,
      id: randomUUID(),
      version: randomUUID(),
      ...(raw.attributes !== undefined ? { attributes: sanitizedAttributes(raw.attributes) } : {}),
    };
    await this.events.set(event.id, event);

    const existingSpan = await this.spans.get(raw.spanId);
    const attributes = { ...(existingSpan?.attributes ?? {}), ...sanitizedAttributes(raw.attributes) };
    const span: CortexSpan = {
      id: raw.spanId,
      version: randomUUID(),
      traceId: raw.traceId,
      rootTraceId: raw.rootTraceId,
      spanId: raw.spanId,
      kind: raw.kind,
      name: raw.name,
      status: raw.status ?? existingSpan?.status ?? 'unset',
      startedAt: existingSpan?.startedAt ?? raw.timestamp,
      updatedAt: raw.timestamp,
      attributes,
      ...(raw.parentSpanId !== undefined ? { parentSpanId: raw.parentSpanId } : existingSpan?.parentSpanId !== undefined ? { parentSpanId: existingSpan.parentSpanId } : {}),
      ...(raw.sessionId !== undefined ? { sessionId: raw.sessionId } : existingSpan?.sessionId !== undefined ? { sessionId: existingSpan.sessionId } : {}),
      ...(raw.workflowRunId !== undefined ? { workflowRunId: raw.workflowRunId } : existingSpan?.workflowRunId !== undefined ? { workflowRunId: existingSpan.workflowRunId } : {}),
      ...(raw.phase === 'end' ? { endedAt: raw.timestamp, durationMs: raw.durationMs ?? 0 } : existingSpan?.endedAt !== undefined ? { endedAt: existingSpan.endedAt, durationMs: existingSpan.durationMs ?? 0 } : {}),
    };
    await this.spans.set(span.id, span);

    const existingTrace = await this.traces.get(raw.traceId);
    const billableEnd = raw.phase === 'end' && (raw.kind === 'llm' || raw.kind === 'evaluator');
    const inputTokens = billableEnd ? asNumber(raw.attributes?.['inputTokens']) : 0;
    const outputTokens = billableEnd ? asNumber(raw.attributes?.['outputTokens']) : 0;
    const costUsd = billableEnd ? pricedCost(raw.attributes) : 0;
    const workflowRunIds = uniq([...(existingTrace?.workflowRunIds ?? []), ...workflowIdsFromEvent(raw)]);
    const trace: CortexTrace = {
      id: raw.traceId,
      version: randomUUID(),
      traceId: raw.traceId,
      rootTraceId: raw.rootTraceId,
      workspaceId: existingTrace?.workspaceId ?? String(raw.attributes?.['workspaceId'] ?? process.env['CORTEX_WORKSPACE_ID'] ?? 'default'),
      status: raw.kind === 'agent' && raw.phase === 'end' ? raw.status ?? 'unset' : existingTrace?.status ?? 'unset',
      startedAt: existingTrace?.startedAt ?? raw.timestamp,
      updatedAt: raw.timestamp,
      spanCount: (await this.spansForTrace(raw.traceId)).length,
      eventCount: (existingTrace?.eventCount ?? 0) + 1,
      inputTokens: (existingTrace?.inputTokens ?? 0) + inputTokens,
      outputTokens: (existingTrace?.outputTokens ?? 0) + outputTokens,
      costUsd: (existingTrace?.costUsd ?? 0) + costUsd,
      workflowRunIds,
      ...(raw.sessionId !== undefined ? { sessionId: raw.sessionId } : existingTrace?.sessionId !== undefined ? { sessionId: existingTrace.sessionId } : {}),
      ...(raw.kind === 'agent' && raw.phase === 'end' ? { endedAt: raw.timestamp, durationMs: raw.durationMs ?? 0 } : existingTrace?.endedAt !== undefined ? { endedAt: existingTrace.endedAt, durationMs: existingTrace.durationMs ?? 0 } : {}),
      ...(raw.status === 'error' && typeof raw.attributes?.['error'] === 'string' ? { error: raw.attributes['error'] } : existingTrace?.error !== undefined ? { error: existingTrace.error } : {}),
    };
    await this.traces.set(trace.id, trace);
  }

  /**
   * Lists stored trace aggregates.
   *
   * @param query - Optional filter/sort/paging; cursor-paginated to completion.
   * @returns Matching {@link CortexTrace} records in query order.
   * @throws If a store page fetch rejects.
   */
  listTraces(query?: StoreQuery): Promise<CortexTrace[]> { return queryAll(this.traces, query); }

  /**
   * All spans belonging to one trace.
   *
   * @param traceId - The trace to collect spans for.
   * @returns The spans in store order (unsorted; {@link inspectTrace} sorts by start time).
   * @throws If the store query rejects.
   */
  private async spansForTrace(traceId: string): Promise<CortexSpan[]> {
    return queryAll(this.spans, { where: { op: 'eq', field: 'traceId', value: traceId } });
  }

  /**
   * Loads everything recorded about one trace: the aggregate, its spans (sorted by `startedAt`
   * ascending), its events (sorted by `timestamp` ascending), and the scores whose evaluator spans
   * ran on this trace. `trace` is null for an unknown id; the arrays are then empty.
   *
   * @param traceId - The trace to inspect.
   * @returns The trace (or null) with its time-ordered spans/events and evaluator scores.
   * @throws If any store query rejects.
   */
  async inspectTrace(traceId: string): Promise<{ trace: CortexTrace | null; spans: CortexSpan[]; events: CortexTraceEvent[]; scores: ScoreResult[] }> {
    const [trace, spans, events, scores] = await Promise.all([
      this.traces.get(traceId),
      this.spansForTrace(traceId),
      queryAll(this.events, { where: { op: 'eq', field: 'traceId', value: traceId } }),
      queryAll(this.scores, { where: { op: 'eq', field: 'evaluatorTraceId', value: traceId } }),
    ]);
    return {
      trace,
      spans: spans.sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      events: events.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      scores,
    };
  }

  /**
   * Replays a trace as playback only: the recorded event timeline is returned, no tool or workflow
   * write is executed, and `writesExecuted` is always false.
   *
   * @param traceId - The trace to replay.
   * @returns The trace (or null) and its event timeline, explicitly marked playback/no-writes.
   * @throws As {@link inspectTrace}.
   */
  async replayTrace(traceId: string): Promise<{ mode: 'playback'; writesExecuted: false; trace: CortexTrace | null; timeline: CortexTraceEvent[] }> {
    const inspected = await this.inspectTrace(traceId);
    return { mode: 'playback', writesExecuted: false, trace: inspected.trace, timeline: inspected.events };
  }

  /**
   * Creates or updates a suite along with its embedded cases and scorers. Omitted ids are derived
   * from content via {@link hashId} (suite: workspace+name; case/scorer: suite+name), so
   * re-upserting the same names updates in place and prior `createdAt` values survive. Scorer
   * defaults: threshold 0.7 for `model_rubric` else 1, weight 1, required true. Case defaults:
   * empty input/expected, and scorers defaulting to the ones defined in this same call. When the
   * call supplies cases/scorers the suite's id lists are replaced wholesale; otherwise the stored
   * ones are kept. `passThreshold` defaults to the stored value, else 1.
   *
   * @param input - The suite definition (cases and scorers optional).
   * @returns The stored suite plus the cases and scorers written this call (empty arrays when none).
   * @throws If any store write rejects.
   */
  async upsertSuite(input: EvaluationSuiteInput): Promise<{ suite: EvaluationSuite; cases: EvaluationCase[]; scorers: ScorerDefinition[] }> {
    const timestamp = nowIso();
    const suiteId = input.id ?? hashId('evaluation-suite', [input.workspaceId, input.name]);
    const existing = await this.suites.get(suiteId);
    const storedScorers: ScorerDefinition[] = [];
    for (const scorerInput of input.scorers ?? []) {
      const id = scorerInput.id ?? hashId('evaluation-scorer', [suiteId, scorerInput.name]);
      const prior = await this.scorers.get(id);
      const scorer: ScorerDefinition = {
        id,
        version: randomUUID(),
        workspaceId: input.workspaceId,
        name: scorerInput.name,
        type: scorerInput.type,
        threshold: scorerInput.threshold ?? (scorerInput.type === 'model_rubric' ? 0.7 : 1),
        weight: scorerInput.weight ?? 1,
        required: scorerInput.required ?? true,
        createdAt: prior?.createdAt ?? timestamp,
        updatedAt: timestamp,
        ...(scorerInput.path !== undefined ? { path: scorerInput.path } : {}),
        ...(scorerInput.expected !== undefined ? { expected: scorerInput.expected } : {}),
        ...(scorerInput.rubric !== undefined ? { rubric: scorerInput.rubric } : {}),
        ...(scorerInput.provider !== undefined ? { provider: scorerInput.provider } : {}),
        ...(scorerInput.modelVersion !== undefined ? { modelVersion: scorerInput.modelVersion } : {}),
        ...(scorerInput.config !== undefined ? { config: scorerInput.config } : {}),
      };
      await this.scorers.set(id, scorer);
      storedScorers.push(scorer);
    }
    const defaultScorerIds = storedScorers.map(item => item.id);
    const storedCases: EvaluationCase[] = [];
    for (const caseInput of input.cases ?? []) {
      const id = caseInput.id ?? hashId('evaluation-case', [suiteId, caseInput.name]);
      const prior = await this.cases.get(id);
      const item: EvaluationCase = {
        id,
        version: randomUUID(),
        suiteId,
        workspaceId: input.workspaceId,
        name: caseInput.name,
        input: caseInput.input ?? {},
        expected: caseInput.expected ?? {},
        scorerIds: caseInput.scorerIds ?? defaultScorerIds,
        tags: uniq(caseInput.tags ?? []),
        createdAt: prior?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await this.cases.set(id, item);
      storedCases.push(item);
    }
    const suite: EvaluationSuite = {
      id: suiteId,
      version: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      caseIds: storedCases.length > 0 ? storedCases.map(item => item.id) : existing?.caseIds ?? [],
      scorerIds: storedScorers.length > 0 ? storedScorers.map(item => item.id) : existing?.scorerIds ?? [],
      passThreshold: input.passThreshold ?? existing?.passThreshold ?? 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(input.description !== undefined ? { description: input.description } : existing?.description !== undefined ? { description: existing.description } : {}),
    };
    await this.suites.set(suite.id, suite);
    return { suite, cases: storedCases, scorers: storedScorers };
  }

  /**
   * Lists stored evaluation suites.
   *
   * @param query - Optional filter/sort/paging; cursor-paginated to completion.
   * @returns Matching suites in query order.
   * @throws If a store page fetch rejects.
   */
  listSuites(query?: StoreQuery): Promise<EvaluationSuite[]> { return queryAll(this.suites, query); }

  /**
   * Lists recorded evaluation runs.
   *
   * @param query - Optional filter/sort/paging; cursor-paginated to completion.
   * @returns Matching runs in query order.
   * @throws If a store page fetch rejects.
   */
  listEvaluationRuns(query?: StoreQuery): Promise<EvaluationRun[]> { return queryAll(this.evaluationRuns, query); }

  /**
   * Resolves what a case is scored against, by the fields present in its `input`, in priority
   * order: a string `traceId` inspects that recorded trace; a string `workflowId` (with a
   * `WorkflowRunner` service present) starts a `dry_run` workflow run, passing optional
   * `workflowVersion`, `inputs`, `evidenceSourceIds`, and `proposedActions`; otherwise the inline
   * `actual`/`output` (or the whole input record) is the target.
   *
   * @param item - The case being scored.
   * @returns The scoring target handed to each scorer.
   * @throws If the trace inspection or the workflow dry-run start rejects.
   */
  private async resolveCaseTarget(item: EvaluationCase): Promise<unknown> {
    const traceId = item.input['traceId'];
    if (typeof traceId === 'string') return this.inspectTrace(traceId);
    const workflowId = item.input['workflowId'];
    const runner = this.services.get('WorkflowRunner' as never) as WorkflowRunnerLike | undefined;
    if (typeof workflowId === 'string' && runner !== undefined) {
      return runner.startRun({
        workflowId,
        ...(typeof item.input['workflowVersion'] === 'string' ? { workflowVersion: item.input['workflowVersion'] } : {}),
        workspaceId: item.workspaceId,
        mode: 'dry_run',
        ...(isRecord(item.input['inputs']) ? { inputs: item.input['inputs'] } : {}),
        ...(Array.isArray(item.input['evidenceSourceIds']) ? { evidenceSourceIds: strings(item.input['evidenceSourceIds']) } : {}),
        ...(Array.isArray(item.input['proposedActions']) ? { proposedActions: item.input['proposedActions'].filter(isRecord) } : {}),
      });
    }
    return item.input['actual'] ?? item.input['output'] ?? item.input;
  }

  /**
   * Scores one case with one scorer, dispatching on {@link ScorerDefinition.type}: exact/substring
   * match, required-JSON-fields presence, workflow status, citation count, tool-name sequence,
   * latency/cost budget (partial credit as budget/actual when over budget), retrieval
   * precision/recall at k, and `model_rubric` — the LLM-judged case. Rubric scoring needs a provider
   * (`scorer.provider`, else `fallbackProvider`; score 0 with a rationale when neither exists),
   * calls `singleTurn`, parses the first JSON object in the reply, clamps the score to [0, 1], and
   * records evaluator start/end spans on `evaluationTraceId`; a judge failure scores 0 and records
   * an error end-span instead of throwing. `expected` comes from the scorer or, absent there, from
   * the case at the scorer's `path`; `actual`/`expected` in the result are sanitized.
   *
   * @param item - The case being scored (supplies `expected` when the scorer doesn't).
   * @param scorer - The scorer definition (type, threshold, weight, path, expected, rubric, config).
   * @param target - The resolved case target (see {@link resolveCaseTarget}).
   * @param evaluationTraceId - Trace id under which evaluator spans are recorded.
   * @param fallbackProvider - Provider for `model_rubric` when the scorer pins none.
   * @returns The score result minus the identity fields {@link runSuite} fills in.
   * @throws If an evaluator span store write rejects; judge failures are captured, not thrown.
   */
  private async score(item: EvaluationCase, scorer: ScorerDefinition, target: unknown, evaluationTraceId: string, fallbackProvider?: string): Promise<Omit<ScoreResult, 'id' | 'version' | 'evaluationRunId' | 'suiteId' | 'caseId' | 'createdAt'>> {
    const actual = field(target, scorer.path);
    const expected = scorer.expected ?? field(item.expected, scorer.path);
    let score = 0;
    let rationale = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    switch (scorer.type) {
      case 'equals':
        score = canonical(actual) === canonical(expected) ? 1 : 0;
        rationale = score === 1 ? 'Actual value equals the expected value.' : 'Actual value differs from the expected value.';
        break;
      case 'contains':
        score = String(actual ?? '').includes(String(expected ?? '')) ? 1 : 0;
        rationale = score === 1 ? 'Expected content is present.' : 'Expected content is absent.';
        break;
      case 'json_schema': {
        const required = strings((isRecord(scorer.config) ? scorer.config['required'] : undefined) ?? (isRecord(expected) ? expected['required'] : undefined));
        score = isRecord(actual) && required.every(key => key in actual) ? 1 : 0;
        rationale = score === 1 ? 'Required JSON fields are present.' : `Missing one or more required fields: ${required.join(', ')}.`;
        break;
      }
      case 'workflow_status':
        score = isRecord(target) && target['status'] === expected ? 1 : 0;
        rationale = `Workflow status is ${String(isRecord(target) ? target['status'] : undefined)}; expected ${String(expected)}.`;
        break;
      case 'citation_count': {
        const count = collectCitations(target).size;
        const minimum = asNumber(expected, asNumber(scorer.config?.['minimum'], 1));
        score = minimum <= 0 ? 1 : Math.min(1, count / minimum);
        rationale = `Resolved ${count} citation(s); required ${minimum}.`;
        break;
      }
      case 'tool_sequence': {
        const spans = isRecord(target) && Array.isArray(target['spans']) ? target['spans'] : [];
        const actualTools = spans.filter(isRecord).filter(span => span['kind'] === 'tool').map(span => String(span['name']));
        const expectedTools = strings(expected);
        score = canonical(actualTools) === canonical(expectedTools) ? 1 : 0;
        rationale = `Observed tool sequence ${canonical(actualTools)}.`;
        break;
      }
      case 'latency_budget': {
        const duration = asNumber(isRecord(target) && isRecord(target['trace']) ? target['trace']['durationMs'] : isRecord(target) ? target['durationMs'] : undefined);
        const budget = asNumber(expected, asNumber(scorer.config?.['maxMs']));
        score = duration <= budget ? 1 : budget > 0 ? Math.max(0, budget / duration) : 0;
        rationale = `Duration ${duration} ms; budget ${budget} ms.`;
        break;
      }
      case 'cost_budget': {
        const cost = asNumber(isRecord(target) && isRecord(target['trace']) ? target['trace']['costUsd'] : isRecord(target) ? target['costUsd'] : undefined);
        const budget = asNumber(expected, asNumber(scorer.config?.['maxUsd']));
        score = cost <= budget ? 1 : budget > 0 ? Math.max(0, budget / cost) : 0;
        rationale = `Cost $${cost.toFixed(6)}; budget $${budget.toFixed(6)}.`;
        break;
      }
      case 'policy_decision': {
        const spans = isRecord(target) && Array.isArray(target['spans']) ? target['spans'] : [];
        const decisions = spans.filter(isRecord).filter(span => span['kind'] === 'guardrail').map(span => isRecord(span['attributes']) ? span['attributes']['policyOutcome'] : undefined);
        score = decisions.includes(expected) ? 1 : 0;
        rationale = `Observed policy outcomes ${canonical(decisions)}.`;
        break;
      }
      case 'retrieval_precision_at_k':
      case 'retrieval_recall_at_k': {
        const actualIds = strings(field(target, scorer.path ?? 'retrievedSourceIds'));
        const expectedIds = new Set(strings(expected));
        const relevant = actualIds.filter(id => expectedIds.has(id)).length;
        score = scorer.type === 'retrieval_precision_at_k'
          ? (actualIds.length === 0 ? 0 : relevant / actualIds.length)
          : (expectedIds.size === 0 ? 1 : relevant / expectedIds.size);
        rationale = `${relevant} relevant source(s), ${actualIds.length} retrieved, ${expectedIds.size} expected.`;
        break;
      }
      case 'model_rubric': {
        const provider = scorer.provider ?? fallbackProvider;
        if (provider === undefined) {
          score = 0;
          rationale = 'Model rubric scorer has no provider.';
          break;
        }
        const prompt = [
          'Evaluate the candidate against the rubric. Return only JSON with keys score (0..1), passed (boolean), and rationale (string).',
          `Rubric: ${scorer.rubric ?? scorer.name}`,
          `Expected: ${canonical(item.expected)}`,
          `Candidate: ${canonical(target)}`,
        ].join('\n\n');
        const spanId = randomUUID();
        const startedAt = Date.now();
        const model = this.services.providers.get(provider)?.model;
        await this.record({ traceId: evaluationTraceId, rootTraceId: evaluationTraceId, spanId, timestamp: nowIso(), phase: 'start', kind: 'evaluator', name: scorer.name, attributes: { scorerId: scorer.id, provider, model: model ?? null } });
        try {
          const result = await this.services.singleTurn({ provider, prompt, system: 'You are a strict evaluation judge. Do not add prose outside the JSON object.' });
          inputTokens = result.usage.inputTokens;
          outputTokens = result.usage.outputTokens;
          const match = /\{[\s\S]*\}/.exec(result.text);
          const parsed = match === null ? {} : JSON.parse(match[0]) as Record<string, unknown>;
          score = Math.max(0, Math.min(1, asNumber(parsed['score'])));
          rationale = typeof parsed['rationale'] === 'string' ? parsed['rationale'] : result.text.slice(0, 1_000);
          await this.record({ traceId: evaluationTraceId, rootTraceId: evaluationTraceId, spanId, timestamp: nowIso(), phase: 'end', kind: 'evaluator', name: scorer.name, status: 'ok', durationMs: Date.now() - startedAt, attributes: { scorerId: scorer.id, provider, model: model ?? null, inputTokens, outputTokens, score, costCenter: 'evaluation' } });
        } catch (error) {
          score = 0;
          rationale = `Judge failed: ${error instanceof Error ? error.message : String(error)}`;
          await this.record({ traceId: evaluationTraceId, rootTraceId: evaluationTraceId, spanId, timestamp: nowIso(), phase: 'end', kind: 'evaluator', name: scorer.name, status: 'error', durationMs: Date.now() - startedAt, attributes: { scorerId: scorer.id, provider, error: rationale } });
        }
        break;
      }
    }

    return {
      scorerId: scorer.id,
      scorerVersion: scorer.version,
      scorerType: scorer.type,
      passed: score >= scorer.threshold,
      score,
      weight: scorer.weight,
      rationale,
      ...(actual !== undefined ? { actual: sanitize(actual) } : {}),
      ...(expected !== undefined ? { expected: sanitize(expected) } : {}),
      evaluatorTraceId: evaluationTraceId,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  }

  /**
   * Executes every case in a suite, scoring each with its assigned scorers (a case with no scorers
   * of its own falls back to the suite's). The run is persisted as `running` up front and finalized
   * to `completed` or `failed`; missing cases/scorers are skipped silently. The run passes when no
   * required scorer failed and the pass rate meets the suite's threshold; the overall score is the
   * weight-weighted mean of the results.
   *
   * @param suiteId - Suite to run.
   * @param candidate - Candidate label recorded on the run (default `'working-tree'`).
   * @param provider - Optional provider for `model_rubric` scoring when a scorer pins none.
   * @returns The completed run and all score results, in execution order.
   * @throws If the suite is unknown (before any run record exists), or — after persisting the
   *   failed run — if case resolution or scoring rejects.
   */
  async runSuite(suiteId: string, candidate = 'working-tree', provider?: string): Promise<{ run: EvaluationRun; results: ScoreResult[] }> {
    const suite = await this.suites.get(suiteId);
    if (suite === null) throw new Error(`Unknown evaluation suite "${suiteId}".`);
    const startedAt = nowIso();
    const traceId = randomUUID();
    let run: EvaluationRun = {
      id: randomUUID(), version: randomUUID(), suiteId, suiteVersion: suite.version,
      workspaceId: suite.workspaceId, candidate, status: 'running', passed: false,
      score: 0, passRate: 0, caseCount: suite.caseIds.length, startedAt, updatedAt: startedAt, traceId,
    };
    await this.evaluationRuns.set(run.id, run);
    const results: ScoreResult[] = [];
    try {
      for (const caseId of suite.caseIds) {
        const item = await this.cases.get(caseId);
        if (item === null) continue;
        const target = await this.resolveCaseTarget(item);
        const scorerIds = item.scorerIds.length > 0 ? item.scorerIds : suite.scorerIds;
        for (const scorerId of scorerIds) {
          const scorer = await this.scorers.get(scorerId);
          if (scorer === null) continue;
          const scored = await this.score(item, scorer, target, traceId, provider);
          const result: ScoreResult = {
            id: randomUUID(), version: randomUUID(), evaluationRunId: run.id, suiteId,
            caseId: item.id, createdAt: nowIso(), ...scored,
          };
          await this.scores.set(result.id, result);
          results.push(result);
        }
      }
      const totalWeight = results.reduce((sum, item) => sum + item.weight, 0);
      const score = totalWeight === 0 ? 0 : results.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;
      const passRate = results.length === 0 ? 0 : results.filter(item => item.passed).length / results.length;
      let hardFailure = false;
      for (const result of results) {
        const scorer = await this.scorers.get(result.scorerId);
        if (!result.passed && (scorer?.required ?? true)) hardFailure = true;
      }
      const finishedAt = nowIso();
      run = { ...run, version: randomUUID(), status: 'completed', passed: !hardFailure && passRate >= suite.passThreshold, score, passRate, updatedAt: finishedAt, finishedAt };
      await this.evaluationRuns.set(run.id, run);
      return { run, results };
    } catch (error) {
      const finishedAt = nowIso();
      run = { ...run, version: randomUUID(), status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: finishedAt, finishedAt };
      await this.evaluationRuns.set(run.id, run);
      throw error;
    }
  }

  /**
   * Aggregates operational metrics across traces, spans, events, outcomes, and evaluation runs.
   * Loads all six stores (no server-side filter), so the cost is O(total data). When `workspaceId`
   * is given, traces/outcomes/runs are filtered by their `workspaceId` and spans/events by
   * membership in the selected traces' ids. Latency percentiles use {@link percentile}; approval
   * waits are measured per workflow run from `workflow.approval_requested` to
   * `workflow.approval_approved`.
   *
   * @param workspaceId - Optional workspace filter; omit to aggregate across all workspaces.
   * @returns The computed snapshot; rates are 0 whenever their denominator is empty.
   * @throws If any store query rejects.
   */
  async metrics(workspaceId?: string): Promise<ObservabilityMetrics> {
    const [traces, spans, events, outcomes, runs, scores] = await Promise.all([
      queryAll(this.traces), queryAll(this.spans), queryAll(this.events), queryAll(this.outcomes), queryAll(this.evaluationRuns), queryAll(this.scores),
    ]);
    const selectedTraces = workspaceId === undefined ? traces : traces.filter(item => item.workspaceId === workspaceId);
    const traceIds = new Set(selectedTraces.map(item => item.traceId));
    const selectedSpans = spans.filter(item => traceIds.has(item.traceId));
    const selectedEvents = events.filter(item => traceIds.has(item.traceId));
    const selectedOutcomes = workspaceId === undefined ? outcomes : outcomes.filter(item => item.workspaceId === workspaceId);
    const selectedRuns = workspaceId === undefined ? runs : runs.filter(item => item.workspaceId === workspaceId);
    const durations = selectedTraces.map(item => item.durationMs).filter((value): value is number => value !== undefined);
    const byKind: Record<string, number> = {};
    selectedSpans.forEach(span => { byKind[span.kind] = (byKind[span.kind] ?? 0) + 1; });
    const verified = selectedOutcomes.filter(item => item.status === 'verified_completed').length;
    const failed = selectedOutcomes.filter(item => item.status === 'failed').length;
    const escalated = selectedOutcomes.filter(item => item.status === 'escalated').length;
    const denominator = selectedOutcomes.length;
    const evalCompleted = selectedRuns.filter(item => item.status === 'completed');
    const retrievalSpans = selectedSpans.filter(item => item.kind === 'retriever' || item.kind === 'reranker');
    const selectedEvaluationRunIds = new Set(selectedRuns.map(item => item.id));
    const retrievalScores = scores.filter(item => selectedEvaluationRunIds.has(item.evaluationRunId) && (item.scorerType === 'retrieval_precision_at_k' || item.scorerType === 'retrieval_recall_at_k'));
    const citedTraceIds = new Set<string>();
    let citationCount = 0;
    for (const span of selectedSpans) {
      const citations = collectCitations(span.attributes);
      if (citations.size > 0) citedTraceIds.add(span.traceId);
      citationCount += citations.size;
    }
    const toolSpans = selectedSpans.filter(item => item.kind === 'tool');
    const guardrailEvents = selectedEvents.filter(item => item.kind === 'guardrail' && item.phase === 'end');
    const denied = guardrailEvents.filter(item => item.attributes?.['policyOutcome'] === 'denied' || item.attributes?.['policyOutcome'] === 'aborted').length;
    const approvalsRequestedEvents = selectedEvents.filter(item => item.name === 'workflow.approval_requested');
    const approvalsApprovedEvents = selectedEvents.filter(item => item.name === 'workflow.approval_approved');
    const approvalsRejectedEvents = selectedEvents.filter(item => item.name === 'workflow.approval_rejected');
    const approvalRequestedAt = new Map<string, number>();
    approvalsRequestedEvents.forEach(item => { if (item.workflowRunId !== undefined) approvalRequestedAt.set(item.workflowRunId, Date.parse(item.timestamp)); });
    const approvalWaits = approvalsApprovedEvents.flatMap(item => {
      const start = item.workflowRunId === undefined ? undefined : approvalRequestedAt.get(item.workflowRunId);
      return start === undefined ? [] : [Math.max(0, Date.parse(item.timestamp) - start)];
    });
    const approvalsRequested = approvalsRequestedEvents.reduce((sum, item) => sum + (Array.isArray(item.attributes?.['approvals']) ? item.attributes['approvals'].length : 1), 0);
    const approvalsApproved = approvalsApprovedEvents.reduce((sum, item) => sum + (Array.isArray(item.attributes?.['approvalIds']) ? item.attributes['approvalIds'].length : 1), 0);
    const approvalsRejected = approvalsRejectedEvents.reduce((sum, item) => sum + (Array.isArray(item.attributes?.['approvalIds']) ? item.attributes['approvalIds'].length : 1), 0);
    return {
      traces: { total: selectedTraces.length, completed: selectedTraces.filter(item => item.status === 'ok').length, errors: selectedTraces.filter(item => item.status === 'error').length },
      tokens: { input: selectedTraces.reduce((sum, item) => sum + item.inputTokens, 0), output: selectedTraces.reduce((sum, item) => sum + item.outputTokens, 0) },
      costUsd: selectedTraces.reduce((sum, item) => sum + item.costUsd, 0),
      latencyMs: { average: durations.length === 0 ? 0 : durations.reduce((a, b) => a + b, 0) / durations.length, p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), p99: percentile(durations, 0.99) },
      spans: byKind,
      retrieval: { operations: retrievalSpans.length, averageLatencyMs: retrievalSpans.length === 0 ? 0 : retrievalSpans.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) / retrievalSpans.length, scoredResults: retrievalScores.length, averageScore: retrievalScores.length === 0 ? 0 : retrievalScores.reduce((sum, item) => sum + item.score, 0) / retrievalScores.length },
      citations: { resolved: citationCount, tracesWithCitations: citedTraceIds.size, coverageRate: selectedTraces.length === 0 ? 0 : citedTraceIds.size / selectedTraces.length },
      actions: { attempted: toolSpans.length, succeeded: toolSpans.filter(item => item.status === 'ok').length, failed: toolSpans.filter(item => item.status === 'error').length, successRate: toolSpans.length === 0 ? 0 : toolSpans.filter(item => item.status === 'ok').length / toolSpans.length },
      policy: { decisions: guardrailEvents.length, denied, denyRate: guardrailEvents.length === 0 ? 0 : denied / guardrailEvents.length },
      workflows: { outcomes: denominator, verifiedCompleted: verified, failed, escalated, completionRate: denominator === 0 ? 0 : verified / denominator, escalationRate: denominator === 0 ? 0 : escalated / denominator, approvalsRequested, approvalsApproved, approvalsRejected, approvalRate: approvalsApproved + approvalsRejected === 0 ? 0 : approvalsApproved / (approvalsApproved + approvalsRejected), averageApprovalWaitMs: approvalWaits.length === 0 ? 0 : approvalWaits.reduce((sum, item) => sum + item, 0) / approvalWaits.length },
      evaluations: { runs: evalCompleted.length, passed: evalCompleted.filter(item => item.passed).length, passRate: evalCompleted.length === 0 ? 0 : evalCompleted.filter(item => item.passed).length / evalCompleted.length },
    };
  }

  /**
   * Creates or updates a manual-effort/cost ROI baseline. The id defaults to a content hash of
   * workspace + workflow + name (see {@link hashId}), making re-upserts idempotent; negative
   * `manualActiveMinutes`, `loadedHourlyRateUsd`, and `fixedCostUsd` are clamped to zero; a prior
   * `createdAt` is preserved on update.
   *
   * @param input - Baseline fields.
   * @returns The stored baseline.
   * @throws If the store write rejects.
   */
  async upsertBaseline(input: Omit<RoiBaseline, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<RoiBaseline> {
    const id = input.id ?? hashId('roi-baseline', [input.workspaceId, input.workflowId, input.name]);
    const existing = await this.baselines.get(id);
    const timestamp = nowIso();
    const baseline: RoiBaseline = {
      id, version: randomUUID(), workspaceId: input.workspaceId, workflowId: input.workflowId,
      name: input.name, manualActiveMinutes: Math.max(0, input.manualActiveMinutes),
      loadedHourlyRateUsd: Math.max(0, input.loadedHourlyRateUsd), effectiveFrom: input.effectiveFrom,
      createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
      ...(input.fixedCostUsd !== undefined ? { fixedCostUsd: Math.max(0, input.fixedCostUsd) } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    await this.baselines.set(id, baseline);
    return baseline;
  }

  /**
   * Records a business outcome for a workflow run and notifies the WorkflowRunner (when registered)
   * via `recordBusinessOutcome`. Validates against the referenced baseline — it must exist and
   * belong to the same workspace and workflow — and requires `verifiedByPrincipalId` for
   * `verified_completed` outcomes. Minute fields are clamped to zero; `recordedAt` is set to now.
   *
   * @param input - Outcome fields; `id` may be supplied for repeatable writes.
   * @returns The persisted outcome.
   * @throws If the baseline is unknown, belongs to another workspace/workflow, a verified outcome
   *   lacks `verifiedByPrincipalId`, or the store write / runner notification rejects.
   */
  async recordOutcome(input: Omit<OutcomeEvent, 'id' | 'version' | 'recordedAt'> & { id?: string }): Promise<OutcomeEvent> {
    const baseline = await this.baselines.get(input.baselineId);
    if (baseline === null) throw new Error(`Unknown ROI baseline "${input.baselineId}".`);
    if (baseline.workspaceId !== input.workspaceId || baseline.workflowId !== input.workflowId) {
      throw new Error('ROI baseline must belong to the same workspace and workflow as the outcome.');
    }
    if (input.status === 'verified_completed' && input.verifiedByPrincipalId === undefined) {
      throw new Error('Verified outcomes require verifiedByPrincipalId.');
    }
    const outcome: OutcomeEvent = {
      id: input.id ?? randomUUID(), version: randomUUID(), workspaceId: input.workspaceId,
      workflowId: input.workflowId, workflowRunId: input.workflowRunId, baselineId: input.baselineId,
      status: input.status, humanActiveMinutes: Math.max(0, input.humanActiveMinutes),
      reviewMinutes: Math.max(0, input.reviewMinutes), reworkMinutes: Math.max(0, input.reworkMinutes),
      additionalValueUsd: input.additionalValueUsd, occurredAt: input.occurredAt, recordedAt: nowIso(),
      ...(input.verifiedByPrincipalId !== undefined ? { verifiedByPrincipalId: input.verifiedByPrincipalId } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    await this.outcomes.set(outcome.id, outcome);
    const runner = this.services.get('WorkflowRunner' as never) as WorkflowRunnerLike | undefined;
    await runner?.recordBusinessOutcome?.(outcome.workflowRunId, outcome.id, outcome.status);
    return outcome;
  }

  /**
   * Computes the ROI report for a workspace from verified outcomes only (other statuses contribute
   * nothing). Per outcome, saved time is the baseline's manual minutes minus human/review/rework
   * minutes (floored at zero) over 60, valued at the baseline's loaded hourly rate; outcomes whose
   * baseline is missing are skipped. Operating cost is the summed cost of all traces in the
   * workspace; fixed cost sums the workspace's baselines. `roi` and `paybackOutcomes` are null when
   * their denominators are zero.
   *
   * @param workspaceId - Workspace to report on.
   * @returns The totals plus a per-workflow breakdown sorted by benefit, descending.
   * @throws If any store query rejects.
   */
  async roi(workspaceId: string): Promise<RoiReport> {
    const [baselines, outcomes, traces] = await Promise.all([queryAll(this.baselines), queryAll(this.outcomes), queryAll(this.traces)]);
    const baselineMap = new Map(baselines.filter(item => item.workspaceId === workspaceId).map(item => [item.id, item]));
    const verified = outcomes.filter(item => item.workspaceId === workspaceId && item.status === 'verified_completed');
    const byWorkflow = new Map<string, { workflowId: string; verifiedOutcomes: number; timeSavedHours: number; benefitUsd: number }>();
    let timeSavedHours = 0;
    let laborBenefitUsd = 0;
    let additionalValueUsd = 0;
    for (const outcome of verified) {
      const baseline = baselineMap.get(outcome.baselineId);
      if (baseline === undefined) continue;
      const saved = Math.max(0, baseline.manualActiveMinutes - outcome.humanActiveMinutes - outcome.reviewMinutes - outcome.reworkMinutes) / 60;
      const labor = saved * baseline.loadedHourlyRateUsd;
      timeSavedHours += saved;
      laborBenefitUsd += labor;
      additionalValueUsd += outcome.additionalValueUsd;
      const current = byWorkflow.get(outcome.workflowId) ?? { workflowId: outcome.workflowId, verifiedOutcomes: 0, timeSavedHours: 0, benefitUsd: 0 };
      current.verifiedOutcomes++;
      current.timeSavedHours += saved;
      current.benefitUsd += labor + outcome.additionalValueUsd;
      byWorkflow.set(outcome.workflowId, current);
    }
    const operatingCostUsd = traces.filter(item => item.workspaceId === workspaceId).reduce((sum, item) => sum + item.costUsd, 0);
    const fixedCostUsd = [...baselineMap.values()].reduce((sum, item) => sum + (item.fixedCostUsd ?? 0), 0);
    const totalBenefitUsd = laborBenefitUsd + additionalValueUsd;
    const totalCost = operatingCostUsd + fixedCostUsd;
    const netBenefitUsd = totalBenefitUsd - totalCost;
    const benefitPerOutcome = verified.length === 0 ? 0 : totalBenefitUsd / verified.length;
    return {
      workspaceId, verifiedOutcomes: verified.length, timeSavedHours, laborBenefitUsd,
      additionalValueUsd, operatingCostUsd, fixedCostUsd, totalBenefitUsd, netBenefitUsd,
      roi: totalCost === 0 ? null : netBenefitUsd / totalCost,
      paybackOutcomes: benefitPerOutcome <= 0 ? null : totalCost / benefitPerOutcome,
      byWorkflow: [...byWorkflow.values()].sort((a, b) => b.benefitUsd - a.benefitUsd),
    };
  }
}

/**
 * Loose input record for the `evaluation_action` tool: one `action` plus the optional fields that
 * action needs (ids, suite/baseline/outcome payloads, query). The executor validates per action and
 * answers unknown/malformed input with a tool error event rather than throwing.
 */
interface EvaluationActionInput {
  action: string;
  traceId?: string;
  workspaceId?: string;
  suiteId?: string;
  candidate?: string;
  provider?: string;
  suite?: EvaluationSuiteInput;
  baseline?: Omit<RoiBaseline, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { id?: string };
  outcome?: Omit<OutcomeEvent, 'id' | 'version' | 'recordedAt'> & { id?: string };
  query?: StoreQuery;
}

/**
 * Builds the `evaluation_action` multi-action tool (traces, inspect_trace, replay, upsert_suite,
 * suites, run_suite, evaluation_runs, metrics, upsert_baseline, record_outcome, roi) over the given
 * service. The executor maps each action to the corresponding service call and converts any thrown
 * error into a tool error event.
 *
 * @param service - The observability/evaluation service to expose.
 * @returns The `evaluation_action` tool.
 * @throws Never.
 */
function createEvaluationActionTool(service: EvaluationObservability): Tool {
  return {
    name: 'evaluation_action',
    description:
      'Inspect end-to-end traces, replay them without side effects, manage and run regression suites, and report operational and ROI metrics.\n\n' +
      'Actions: traces, inspect_trace, replay, upsert_suite, suites, run_suite, evaluation_runs, metrics, upsert_baseline, record_outcome, roi.',
    inputSchema: {
      type: 'object', required: ['action'], properties: {
        action: { type: 'string', enum: ['traces', 'inspect_trace', 'replay', 'upsert_suite', 'suites', 'run_suite', 'evaluation_runs', 'metrics', 'upsert_baseline', 'record_outcome', 'roi'] },
        traceId: { type: 'string' }, workspaceId: { type: 'string' }, suiteId: { type: 'string' },
        candidate: { type: 'string' }, provider: { type: 'string' }, suite: { type: 'object' },
        baseline: { type: 'object' }, outcome: { type: 'object' }, query: { type: 'object' },
      },
    },
    executor: {
      async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
        const parsed = isRecord(input) ? input as unknown as EvaluationActionInput : { action: '' };
        try {
          switch (parsed.action) {
            case 'traces': yield { type: 'result', value: { traces: await service.listTraces(parsed.query) } }; return;
            case 'inspect_trace':
              if (parsed.traceId === undefined) { yield { type: 'error', message: 'evaluation_action inspect_trace requires "traceId".' }; return; }
              yield { type: 'result', value: await service.inspectTrace(parsed.traceId) }; return;
            case 'replay':
              if (parsed.traceId === undefined) { yield { type: 'error', message: 'evaluation_action replay requires "traceId".' }; return; }
              yield { type: 'result', value: await service.replayTrace(parsed.traceId) }; return;
            case 'upsert_suite':
              if (parsed.suite === undefined) { yield { type: 'error', message: 'evaluation_action upsert_suite requires "suite".' }; return; }
              yield { type: 'result', value: await service.upsertSuite(parsed.suite) }; return;
            case 'suites': yield { type: 'result', value: { suites: await service.listSuites(parsed.query) } }; return;
            case 'run_suite':
              if (parsed.suiteId === undefined) { yield { type: 'error', message: 'evaluation_action run_suite requires "suiteId".' }; return; }
              yield { type: 'result', value: await service.runSuite(parsed.suiteId, parsed.candidate, parsed.provider) }; return;
            case 'evaluation_runs': yield { type: 'result', value: { runs: await service.listEvaluationRuns(parsed.query) } }; return;
            case 'metrics': yield { type: 'result', value: await service.metrics(parsed.workspaceId) }; return;
            case 'upsert_baseline':
              if (parsed.baseline === undefined) { yield { type: 'error', message: 'evaluation_action upsert_baseline requires "baseline".' }; return; }
              yield { type: 'result', value: await service.upsertBaseline(parsed.baseline) }; return;
            case 'record_outcome':
              if (parsed.outcome === undefined) { yield { type: 'error', message: 'evaluation_action record_outcome requires "outcome".' }; return; }
              yield { type: 'result', value: await service.recordOutcome(parsed.outcome) }; return;
            case 'roi':
              if (parsed.workspaceId === undefined) { yield { type: 'error', message: 'evaluation_action roi requires "workspaceId".' }; return; }
              yield { type: 'result', value: await service.roi(parsed.workspaceId) }; return;
            default: yield { type: 'error', message: `Unknown evaluation_action "${String(parsed.action)}".` };
          }
        } catch (error) {
          yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
        }
      },
    },
  };
}

/**
 * Builds the store-backed {@link EvaluationObservability} service using ten
 * dedicated stores created through the machine's store factory.
 * @param services The matbot machine providing stores, providers, and singleTurn.
 * @returns The service instance.
 * @throws If any backing store cannot be created.
 */
export function createEvaluationObservability(services: MatbotMachine): EvaluationObservability {
  return new StoreBackedEvaluationObservability(
    services,
    services.createStore<CortexTrace>(TRACE_STORE),
    services.createStore<CortexSpan>(SPAN_STORE),
    services.createStore<CortexTraceEvent>(EVENT_STORE),
    services.createStore<EvaluationSuite>(SUITE_STORE),
    services.createStore<EvaluationCase>(CASE_STORE),
    services.createStore<ScorerDefinition>(SCORER_STORE),
    services.createStore<EvaluationRun>(EVAL_RUN_STORE),
    services.createStore<ScoreResult>(SCORE_STORE),
    services.createStore<RoiBaseline>(BASELINE_STORE),
    services.createStore<OutcomeEvent>(OUTCOME_STORE),
  );
}

/**
 * Evaluation & observability plugin: registers the EvaluationObservability
 * service (Observability sink) and the `evaluation_action` tool.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  /**
   * Registers the web UI contribution, builds the observability service, registers it as the
   * `Observability` sink, and exposes the `evaluation_action` tool.
   *
   * @param services - The machine to wire into.
   * @returns Resolves when registration completes.
   * @throws If service or tool registration rejects.
   */
  async setup(services) {
    services.contributions?.register('webui','evaluation',uiContribution);
    const service = createEvaluationObservability(services);
    await services.register('Observability', service);
    services.tools.register(createEvaluationActionTool(service));
  },
};

export default plugin;
