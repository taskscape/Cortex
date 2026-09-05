/** Evaluation: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
const architectureEvaluationStatusEl = document.getElementById('architecture-evaluation-status');

const architectureEvaluationRefreshBtn = document.getElementById('architecture-evaluation-refresh');

const evaluationTraceCountEl = document.getElementById('evaluation-trace-count');

const evaluationPassRateEl = document.getElementById('evaluation-pass-rate');

const evaluationCompletionRateEl = document.getElementById('evaluation-completion-rate');

const evaluationNetBenefitEl = document.getElementById('evaluation-net-benefit');

const evaluationTraceListEl = document.getElementById('evaluation-trace-list');

const evaluationTraceDetailEl = document.getElementById('evaluation-trace-detail');

const evaluationSuiteListEl = document.getElementById('evaluation-suite-list');

const evaluationSuiteDetailEl = document.getElementById('evaluation-suite-detail');

const evaluationRoiDetailEl = document.getElementById('evaluation-roi-detail');

let architectureEvaluationState = { metrics: null, roi: null, traces: [], suites: [], runs: [], selectedTrace: null, traceDetail: null, selectedSuite: null, loaded: false };

let architectureEvaluationLoadRequest = 0;

function evaluationPercent(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '-';
}

function evaluationMoney(value) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function evaluationDuration(value) {
  const ms = Number(value) || 0;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function renderArchitectureEvaluationSummary() {
  const metrics = architectureEvaluationState.metrics || {};
  const roi = architectureEvaluationState.roi || {};
  if (evaluationTraceCountEl) evaluationTraceCountEl.textContent = String(metrics.traces?.total ?? architectureEvaluationState.traces.length);
  if (evaluationPassRateEl) evaluationPassRateEl.textContent = evaluationPercent(metrics.evaluations?.passRate);
  if (evaluationCompletionRateEl) evaluationCompletionRateEl.textContent = evaluationPercent(metrics.workflows?.completionRate);
  if (evaluationNetBenefitEl) evaluationNetBenefitEl.textContent = evaluationMoney(roi.netBenefitUsd);
}

function evaluationSortedTraces() {
  return [...architectureEvaluationState.traces].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

function renderArchitectureEvaluationTraceList() {
  host.architectureClear(evaluationTraceListEl);
  if (!evaluationTraceListEl) return;
  const traces = evaluationSortedTraces();
  if (!traces.length) {
    evaluationTraceListEl.appendChild(host.architectureEmpty('No traces recorded yet'));
    return;
  }
  for (const trace of traces.slice(0, 50)) {
    const item = host.architectureItemButton({
      title: trace.traceId,
      meta: `${host.architectureDate(trace.updatedAt)} · ${evaluationDuration(trace.durationMs)} · ${evaluationMoney(trace.costUsd)}`,
      badge: trace.status,
      active: architectureEvaluationState.selectedTrace?.traceId === trace.traceId,
      onClick: () => selectArchitectureEvaluationTrace(trace.traceId),
    });
    item.dataset.traceId = trace.traceId;
    evaluationTraceListEl.appendChild(item);
  }
}

function renderArchitectureEvaluationTraceDetail() {
  host.architectureClear(evaluationTraceDetailEl);
  if (!evaluationTraceDetailEl) return;
  const trace = architectureEvaluationState.selectedTrace;
  if (!trace) {
    evaluationTraceDetailEl.appendChild(host.architectureEmpty('Select a trace to inspect spans and replay safely'));
    return;
  }
  evaluationTraceDetailEl.appendChild(host.architectureHeading(3, trace.traceId));
  evaluationTraceDetailEl.appendChild(host.architectureInlineBadges([trace.status, ...(trace.workflowRunIds || [])]));
  evaluationTraceDetailEl.appendChild(host.architectureKeyValues([
    ['Root trace', trace.rootTraceId],
    ['Session', trace.sessionId],
    ['Duration', evaluationDuration(trace.durationMs)],
    ['Tokens', `${Number(trace.inputTokens || 0).toLocaleString()} in / ${Number(trace.outputTokens || 0).toLocaleString()} out`],
    ['Cost', evaluationMoney(trace.costUsd)],
    ['Started', host.architectureDate(trace.startedAt)],
  ]));
  const replay = document.createElement('button');
  replay.type = 'button';
  replay.textContent = 'Replay trace safely';
  replay.onclick = () => replayArchitectureEvaluationTrace(trace.traceId);
  evaluationTraceDetailEl.appendChild(replay);
  const spans = Array.isArray(architectureEvaluationState.traceDetail?.spans) ? architectureEvaluationState.traceDetail.spans : [];
  if (spans.length) {
    evaluationTraceDetailEl.appendChild(host.architectureHeading(4, 'Span waterfall'));
    evaluationTraceDetailEl.appendChild(host.architectureTable(spans.map(span => ({
      Kind: span.kind,
      Operation: span.name,
      Status: span.status,
      Duration: evaluationDuration(span.durationMs),
    })), ['Kind', 'Operation', 'Status', 'Duration']));
  }
}

async function selectArchitectureEvaluationTrace(traceId) {
  const trace = architectureEvaluationState.traces.find(item => item.traceId === traceId);
  if (!trace) return;
  architectureEvaluationState.selectedTrace = trace;
  architectureEvaluationState.traceDetail = null;
  renderArchitectureEvaluationTraceList();
  renderArchitectureEvaluationTraceDetail();
  try {
    const detail = await host.callTool('evaluation_action', { action: 'inspect_trace', traceId });
    if (architectureEvaluationState.selectedTrace?.traceId !== traceId) return;
    architectureEvaluationState.traceDetail = detail;
    renderArchitectureEvaluationTraceDetail();
  } catch (err) {
    if (architectureEvaluationState.selectedTrace?.traceId !== traceId) return;
    host.architectureStatus(architectureEvaluationStatusEl, String(err?.message || err), true);
  }
}

async function replayArchitectureEvaluationTrace(traceId) {
  host.architectureStatus(architectureEvaluationStatusEl, 'Replaying recorded trace without side effects…');
  try {
    const replay = await host.callTool('evaluation_action', { action: 'replay', traceId });
    host.architectureStatus(architectureEvaluationStatusEl, `Playback ready: ${replay.timeline?.length || 0} event(s), writes executed: ${replay.writesExecuted ? 'yes' : 'no'}`);
  } catch (err) {
    host.architectureStatus(architectureEvaluationStatusEl, String(err?.message || err), true);
  }
}

function renderArchitectureEvaluationSuiteList() {
  host.architectureClear(evaluationSuiteListEl);
  if (!evaluationSuiteListEl) return;
  if (!architectureEvaluationState.suites.length) {
    evaluationSuiteListEl.appendChild(host.architectureEmpty('No regression suites'));
    return;
  }
  for (const suite of architectureEvaluationState.suites) {
    const latest = architectureEvaluationState.runs.filter(run => run.suiteId === suite.id).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0];
    const item = host.architectureItemButton({
      title: suite.name,
      meta: `${suite.caseIds?.length || 0} case(s) · gate ${evaluationPercent(suite.passThreshold)}`,
      badge: latest ? (latest.passed ? 'passed' : latest.status) : 'not run',
      active: architectureEvaluationState.selectedSuite?.id === suite.id,
      onClick: () => { architectureEvaluationState.selectedSuite = suite; renderArchitectureEvaluationSuiteList(); renderArchitectureEvaluationSuiteDetail(); },
    });
    item.dataset.suiteId = suite.id;
    evaluationSuiteListEl.appendChild(item);
  }
}

function renderArchitectureEvaluationSuiteDetail() {
  host.architectureClear(evaluationSuiteDetailEl);
  if (!evaluationSuiteDetailEl) return;
  const suite = architectureEvaluationState.selectedSuite;
  if (!suite) {
    evaluationSuiteDetailEl.appendChild(host.architectureEmpty('Select a regression suite'));
    return;
  }
  const runs = architectureEvaluationState.runs.filter(run => run.suiteId === suite.id).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  evaluationSuiteDetailEl.appendChild(host.architectureHeading(3, suite.name));
  if (suite.description) evaluationSuiteDetailEl.appendChild(host.architectureMuted(suite.description));
  evaluationSuiteDetailEl.appendChild(host.architectureKeyValues([
    ['Cases', suite.caseIds?.length || 0],
    ['Scorers', suite.scorerIds?.length || 0],
    ['Pass gate', evaluationPercent(suite.passThreshold)],
    ['Version', suite.version],
  ]));
  const runButton = document.createElement('button');
  runButton.type = 'button';
  runButton.textContent = 'Run regression suite';
  runButton.onclick = () => runArchitectureEvaluationSuite(suite.id, runButton);
  evaluationSuiteDetailEl.appendChild(runButton);
  if (runs.length) {
    evaluationSuiteDetailEl.appendChild(host.architectureHeading(4, 'Recent runs'));
    evaluationSuiteDetailEl.appendChild(host.architectureTable(runs.slice(0, 10).map(run => ({
      Candidate: run.candidate,
      Status: run.status,
      Score: evaluationPercent(run.score),
      Pass: run.passed ? 'yes' : 'no',
    })), ['Candidate', 'Status', 'Score', 'Pass']));
  }
}

async function runArchitectureEvaluationSuite(suiteId, button) {
  if (button) button.disabled = true;
  host.architectureStatus(architectureEvaluationStatusEl, 'Running regression suite…');
  try {
    const result = await host.callTool('evaluation_action', { action: 'run_suite', suiteId, candidate: 'webui', ...(host.providerSel.value ? { provider: host.providerSel.value } : {}) });
    await loadArchitectureEvaluation(true);
    host.architectureStatus(architectureEvaluationStatusEl, `Evaluation ${result.run.passed ? 'passed' : 'failed'} at ${evaluationPercent(result.run.score)}.` , !result.run.passed);
  } catch (err) {
    host.architectureStatus(architectureEvaluationStatusEl, String(err?.message || err), true);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderArchitectureEvaluationRoi() {
  host.architectureClear(evaluationRoiDetailEl);
  if (!evaluationRoiDetailEl) return;
  const roi = architectureEvaluationState.roi;
  const metrics = architectureEvaluationState.metrics;
  if (!roi) {
    evaluationRoiDetailEl.appendChild(host.architectureEmpty('No ROI evidence available'));
    return;
  }
  evaluationRoiDetailEl.appendChild(host.architectureKeyValues([
    ['Verified outcomes', roi.verifiedOutcomes],
    ['Time saved', `${Number(roi.timeSavedHours || 0).toFixed(1)} h`],
    ['Total benefit', evaluationMoney(roi.totalBenefitUsd)],
    ['Operating cost', evaluationMoney(roi.operatingCostUsd)],
    ['Net benefit', evaluationMoney(roi.netBenefitUsd)],
    ['ROI', roi.roi === null ? 'Awaiting cost baseline' : evaluationPercent(roi.roi)],
    ['Approval rate', evaluationPercent(metrics?.workflows?.approvalRate)],
    ['Escalation rate', evaluationPercent(metrics?.workflows?.escalationRate)],
    ['Action success', evaluationPercent(metrics?.actions?.successRate)],
    ['Citation coverage', evaluationPercent(metrics?.citations?.coverageRate)],
  ]));
  if (Array.isArray(roi.byWorkflow) && roi.byWorkflow.length) {
    evaluationRoiDetailEl.appendChild(host.architectureHeading(4, 'Benefit by workflow'));
    evaluationRoiDetailEl.appendChild(host.architectureTable(roi.byWorkflow.map(item => ({
      Workflow: item.workflowId,
      Outcomes: item.verifiedOutcomes,
      Hours: Number(item.timeSavedHours || 0).toFixed(1),
      Benefit: evaluationMoney(item.benefitUsd),
    })), ['Workflow', 'Outcomes', 'Hours', 'Benefit']));
  }
}

async function loadArchitectureEvaluation(force = false) {
  if (!force && architectureEvaluationState.loaded) return;
  const request = ++architectureEvaluationLoadRequest;
  host.architectureStatus(architectureEvaluationStatusEl, 'Loading traces, evaluations, and sponsor evidence…');
  const workspaceId = host.activeWorkspaceId();
  const query = { where: { op: 'eq', field: 'workspaceId', value: workspaceId } };
  const [traceResult, suiteResult, runResult, metricsResult, roiResult] = await Promise.allSettled([
    host.callTool('evaluation_action', { action: 'traces', query }),
    host.callTool('evaluation_action', { action: 'suites', query }),
    host.callTool('evaluation_action', { action: 'evaluation_runs', query }),
    host.callTool('evaluation_action', { action: 'metrics', workspaceId }),
    host.callTool('evaluation_action', { action: 'roi', workspaceId }),
  ]);
  if (request !== architectureEvaluationLoadRequest) return;
  const previousTraceId = architectureEvaluationState.selectedTrace?.traceId;
  const previousSuiteId = architectureEvaluationState.selectedSuite?.id;
  architectureEvaluationState.traces = traceResult.status === 'fulfilled' && Array.isArray(traceResult.value?.traces) ? traceResult.value.traces : [];
  architectureEvaluationState.suites = suiteResult.status === 'fulfilled' && Array.isArray(suiteResult.value?.suites) ? suiteResult.value.suites : [];
  architectureEvaluationState.runs = runResult.status === 'fulfilled' && Array.isArray(runResult.value?.runs) ? runResult.value.runs : [];
  architectureEvaluationState.metrics = metricsResult.status === 'fulfilled' ? metricsResult.value : null;
  architectureEvaluationState.roi = roiResult.status === 'fulfilled' ? roiResult.value : null;
  architectureEvaluationState.selectedTrace = architectureEvaluationState.traces.find(item => item.traceId === previousTraceId) || evaluationSortedTraces()[0] || null;
  architectureEvaluationState.selectedSuite = architectureEvaluationState.suites.find(item => item.id === previousSuiteId) || architectureEvaluationState.suites[0] || null;
  architectureEvaluationState.traceDetail = null;
  architectureEvaluationState.loaded = true;
  renderArchitectureEvaluationSummary();
  renderArchitectureEvaluationTraceList();
  renderArchitectureEvaluationTraceDetail();
  renderArchitectureEvaluationSuiteList();
  renderArchitectureEvaluationSuiteDetail();
  renderArchitectureEvaluationRoi();
  const failures = [traceResult, suiteResult, runResult, metricsResult, roiResult].filter(result => result.status === 'rejected').length;
  host.architectureStatus(architectureEvaluationStatusEl, failures ? `Loaded with ${failures} unavailable service(s).` : `${architectureEvaluationState.traces.length} trace(s), ${architectureEvaluationState.suites.length} suite(s).`, failures > 0);
  if (architectureEvaluationState.selectedTrace) await selectArchitectureEvaluationTrace(architectureEvaluationState.selectedTrace.traceId);
}
return {
get architectureEvaluationStatusEl(){return architectureEvaluationStatusEl},
get architectureEvaluationRefreshBtn(){return architectureEvaluationRefreshBtn},
get evaluationTraceCountEl(){return evaluationTraceCountEl},
get evaluationPassRateEl(){return evaluationPassRateEl},
get evaluationCompletionRateEl(){return evaluationCompletionRateEl},
get evaluationNetBenefitEl(){return evaluationNetBenefitEl},
get evaluationTraceListEl(){return evaluationTraceListEl},
get evaluationTraceDetailEl(){return evaluationTraceDetailEl},
get evaluationSuiteListEl(){return evaluationSuiteListEl},
get evaluationSuiteDetailEl(){return evaluationSuiteDetailEl},
get evaluationRoiDetailEl(){return evaluationRoiDetailEl},
get architectureEvaluationState(){return architectureEvaluationState},set architectureEvaluationState(value){architectureEvaluationState=value},
get architectureEvaluationLoadRequest(){return architectureEvaluationLoadRequest},set architectureEvaluationLoadRequest(value){architectureEvaluationLoadRequest=value},
get evaluationPercent(){return evaluationPercent},
get evaluationMoney(){return evaluationMoney},
get evaluationDuration(){return evaluationDuration},
get renderArchitectureEvaluationSummary(){return renderArchitectureEvaluationSummary},
get evaluationSortedTraces(){return evaluationSortedTraces},
get renderArchitectureEvaluationTraceList(){return renderArchitectureEvaluationTraceList},
get renderArchitectureEvaluationTraceDetail(){return renderArchitectureEvaluationTraceDetail},
get selectArchitectureEvaluationTrace(){return selectArchitectureEvaluationTrace},
get replayArchitectureEvaluationTrace(){return replayArchitectureEvaluationTrace},
get renderArchitectureEvaluationSuiteList(){return renderArchitectureEvaluationSuiteList},
get renderArchitectureEvaluationSuiteDetail(){return renderArchitectureEvaluationSuiteDetail},
get runArchitectureEvaluationSuite(){return runArchitectureEvaluationSuite},
get renderArchitectureEvaluationRoi(){return renderArchitectureEvaluationRoi},
get loadArchitectureEvaluation(){return loadArchitectureEvaluation},
async activate(force=false){if(force||!architectureEvaluationState.loaded)return loadArchitectureEvaluation();},
status(){return architectureEvaluationStatusEl;},
mount(){
architectureEvaluationRefreshBtn?.addEventListener('click', () => host.loadArchitecturePanel('evaluation', true), {signal:lifecycle.signal});
},dispose(){lifecycle.abort();architectureEvaluationLoadRequest++;}
};
}
