/** Workflows: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
const architectureWorkflowStatusEl = document.getElementById('architecture-workflow-status');

const architectureWorkflowRefreshBtn = document.getElementById('architecture-workflow-refresh');

const architectureApprovalListEl = document.getElementById('architecture-approval-list');

const architectureApprovalDetailEl = document.getElementById('architecture-approval-detail');

const architectureHighRiskWriteModalEl = document.getElementById('architecture-high-risk-write-modal');

const architectureHighRiskWriteContentEl = document.getElementById('architecture-high-risk-write-content');

const architectureHighRiskWriteCloseBtn = document.getElementById('architecture-high-risk-write-close');

const architectureHighRiskWriteRejectBtn = document.getElementById('architecture-high-risk-write-reject');

const architectureHighRiskWriteApproveBtn = document.getElementById('architecture-high-risk-write-approve');

const workflowOpsTabBtns = Array.from(document.querySelectorAll('.workflow-ops-tab'));

const workflowOpsPanelEls = Array.from(document.querySelectorAll('.workflow-ops-view'));

const workflowOpsSummaryBtns = Array.from(document.querySelectorAll('[data-workflow-summary-view]'));

const workflowOpsWorkflowCountEl = document.getElementById('workflow-ops-workflow-count');

const workflowOpsRunCountEl = document.getElementById('workflow-ops-run-count');

const workflowOpsPendingCountEl = document.getElementById('workflow-ops-pending-count');

const workflowOpsAcceptanceRateEl = document.getElementById('workflow-ops-acceptance-rate');

const workflowOpsAcceptanceTrendEl = document.getElementById('workflow-ops-acceptance-trend');

const workflowOpsAttentionEl = document.getElementById('workflow-ops-attention');

const workflowOpsRecentRunsEl = document.getElementById('workflow-ops-recent-runs');

const workflowOpsShadowReadinessEl = document.getElementById('workflow-ops-shadow-readiness');

const workflowOpsCompileForm = document.getElementById('workflow-ops-compile-form');

const workflowOpsCompileNameEl = document.getElementById('workflow-ops-compile-name');

const workflowOpsCompileRiskEl = document.getElementById('workflow-ops-compile-risk');

const workflowOpsCompileTranscriptEl = document.getElementById('workflow-ops-compile-transcript');

const workflowOpsCompileSourcesEl = document.getElementById('workflow-ops-compile-sources');

const workflowOpsCompileToolEl = document.getElementById('workflow-ops-compile-tool');

const workflowOpsCompilePublishEl = document.getElementById('workflow-ops-compile-publish');

const workflowOpsCompileDryRunEl = document.getElementById('workflow-ops-compile-dry-run');

const workflowOpsCompileBtn = document.getElementById('workflow-ops-compile-btn');

const workflowOpsLibrarySearchEl = document.getElementById('workflow-ops-library-search');

const workflowOpsLibraryListEl = document.getElementById('workflow-ops-library-list');

const workflowOpsLibraryDetailEl = document.getElementById('workflow-ops-library-detail');

const workflowOpsRunSearchEl = document.getElementById('workflow-ops-run-search');

const workflowOpsRunStatusEl = document.getElementById('workflow-ops-run-status');

const workflowOpsRunListEl = document.getElementById('workflow-ops-run-list');

const workflowOpsRunDetailEl = document.getElementById('workflow-ops-run-detail');

const workflowOpsShadowListEl = document.getElementById('workflow-ops-shadow-list');

const workflowOpsShadowDetailEl = document.getElementById('workflow-ops-shadow-detail');

let architectureWorkflowState = {
  view: 'overview',
  compilations: [],
  runs: [],
  approvals: [],
  comparisons: [],
  shadowSummary: null,
  selectedCompilation: null,
  selectedRun: null,
  selectedShadowRun: null,
  selected: null,
  inspected: null,
  loaded: false,
};

let architectureWorkflowDecision = '';

let architectureHighRiskWriteContext = null;

let architectureWorkflowBusy = '';

let architectureWorkflowLoadRequest = 0;

let architectureWorkflowRefreshTimer = null;

const WORKFLOW_OPS_REFRESH_MS = 30000;

function workflowOpsWorkspaceQuery() {
  return { where: { op: 'eq', field: 'workspaceId', value: host.activeWorkspaceId() } };
}

function workflowOpsSplitValues(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function workflowOpsAcceptanceText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  return `${Math.round(numeric * 100)}%`;
}

function workflowOpsAcceptanceTrend() {
  const comparisons = [...architectureWorkflowState.comparisons].sort((left, right) =>
    String(left.comparedAt || left.createdAt || '').localeCompare(String(right.comparedAt || right.createdAt || ''))
  );
  if (!comparisons.length) return 'Trend: no labels';
  if (comparisons.length === 1) return 'Trend: new baseline';
  const recentSize = Math.ceil(comparisons.length / 2);
  const previous = comparisons.slice(0, comparisons.length - recentSize);
  const recent = comparisons.slice(comparisons.length - recentSize);
  const rate = records => records.filter(record => record.outcome === 'accepted').length / records.length;
  const delta = Math.round((rate(recent) - rate(previous)) * 100);
  return `Trend: ${delta > 0 ? '+' : ''}${delta} pp vs prior`;
}

function stopWorkflowOpsAutoRefresh() {
  if (architectureWorkflowRefreshTimer !== null) clearTimeout(architectureWorkflowRefreshTimer);
  architectureWorkflowRefreshTimer = null;
}

function scheduleWorkflowOpsAutoRefresh() {
  stopWorkflowOpsAutoRefresh();
  architectureWorkflowRefreshTimer = setTimeout(async () => {
    architectureWorkflowRefreshTimer = null;
    if (!host.architectureScreenEl?.classList.contains('open') || host.architectureView !== 'workflows') return;
    await loadArchitectureWorkflowApprovals();
    if (host.architectureScreenEl?.classList.contains('open') && host.architectureView === 'workflows') scheduleWorkflowOpsAutoRefresh();
  }, WORKFLOW_OPS_REFRESH_MS);
}

function activateWorkflowOpsView(view) {
  const allowed = new Set(['overview', 'library', 'runs', 'approvals', 'shadow']);
  architectureWorkflowState.view = allowed.has(view) ? view : 'overview';
  for (const btn of workflowOpsTabBtns) {
    const active = btn.dataset.workflowOpsView === architectureWorkflowState.view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
  }
  for (const panel of workflowOpsPanelEls) {
    const active = panel.dataset.workflowOpsPanel === architectureWorkflowState.view;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  }
}

function renderWorkflowOpsSummary() {
  if (workflowOpsWorkflowCountEl) workflowOpsWorkflowCountEl.textContent = String(architectureWorkflowState.compilations.length);
  if (workflowOpsRunCountEl) workflowOpsRunCountEl.textContent = String(architectureWorkflowState.runs.length);
  const pending = architectureWorkflowState.approvals.filter(approval => approval.status === 'pending').length;
  if (workflowOpsPendingCountEl) workflowOpsPendingCountEl.textContent = String(pending);
  if (workflowOpsAcceptanceRateEl) workflowOpsAcceptanceRateEl.textContent = workflowOpsAcceptanceText(architectureWorkflowState.shadowSummary?.acceptanceRate);
  if (workflowOpsAcceptanceTrendEl) workflowOpsAcceptanceTrendEl.textContent = workflowOpsAcceptanceTrend();
}

function workflowOpsSortedRuns() {
  return [...architectureWorkflowState.runs].sort((left, right) =>
    String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || ''))
  );
}

function renderWorkflowOpsOverview() {
  host.architectureClear(workflowOpsAttentionEl);
  host.architectureClear(workflowOpsRecentRunsEl);
  host.architectureClear(workflowOpsShadowReadinessEl);

  const pending = architectureWorkflowState.approvals.filter(approval => approval.status === 'pending');
  const failed = architectureWorkflowState.runs.filter(run => run.status === 'failed');
  if (workflowOpsAttentionEl) {
    if (!pending.length && !failed.length) workflowOpsAttentionEl.appendChild(host.architectureEmpty('No workflow operations need attention'));
    else {
      workflowOpsAttentionEl.appendChild(host.architectureKeyValues([
        ['Pending approvals', pending.length],
        ['Failed runs', failed.length],
      ]));
    }
  }

  if (workflowOpsRecentRunsEl) {
    const recent = workflowOpsSortedRuns().slice(0, 4);
    if (!recent.length) workflowOpsRecentRunsEl.appendChild(host.architectureEmpty('No workflow runs yet'));
    else {
      for (const run of recent) {
        const compilation = architectureWorkflowState.compilations.find(record =>
          record.workflowId === run.workflowId || record.definition?.id === run.workflowId
        );
        const workflowName = run.workflowName || compilation?.definition?.name || run.workflowId;
        const item = host.architectureItemButton({
          title: workflowName,
          meta: `${run.workflowId} | ${run.id} | ${host.architectureDate(run.updatedAt || run.createdAt)}`,
          badge: run.status,
          onClick: () => {
            activateWorkflowOpsView('runs');
            selectWorkflowOpsRun(run.id);
          },
        });
        item.dataset.runId = run.id;
        workflowOpsRecentRunsEl.appendChild(item);
      }
    }
  }

  if (workflowOpsShadowReadinessEl) {
    const summary = architectureWorkflowState.shadowSummary;
    if (!summary?.total) workflowOpsShadowReadinessEl.appendChild(host.architectureEmpty('No labeled shadow runs'));
    else {
      workflowOpsShadowReadinessEl.appendChild(host.architectureKeyValues([
        ['Compared runs', summary.total],
        ['Accepted', summary.accepted],
        ['Rejected', summary.rejected],
        ['Mixed', summary.mixed],
        ['Acceptance', workflowOpsAcceptanceText(summary.acceptanceRate)],
      ]));
    }
  }
}

function workflowOpsFilteredCompilations() {
  const term = String(workflowOpsLibrarySearchEl?.value || '').trim().toLowerCase();
  if (!term) return architectureWorkflowState.compilations;
  return architectureWorkflowState.compilations.filter(compilation => {
    const definition = compilation.definition || {};
    return [definition.name, definition.description, compilation.workflowId, compilation.id, compilation.status]
      .some(value => String(value || '').toLowerCase().includes(term));
  });
}

function renderWorkflowOpsLibraryList() {
  host.architectureClear(workflowOpsLibraryListEl);
  if (!workflowOpsLibraryListEl) return;
  const compilations = workflowOpsFilteredCompilations();
  if (!compilations.length) {
    workflowOpsLibraryListEl.appendChild(host.architectureEmpty('No compiled workflows'));
    return;
  }
  for (const compilation of compilations) {
    const definition = compilation.definition || {};
    const item = host.architectureItemButton({
      title: definition.name || compilation.workflowId || compilation.id,
      meta: [compilation.workflowVersion, definition.riskLevel, host.architectureDate(compilation.updatedAt || compilation.createdAt)].filter(Boolean).join(' | '),
      badge: compilation.status,
      active: architectureWorkflowState.selectedCompilation?.id === compilation.id,
      onClick: () => selectWorkflowOpsCompilation(compilation.id),
    });
    item.dataset.compilationId = compilation.id;
    if (compilation.workflowId) item.dataset.workflowId = compilation.workflowId;
    workflowOpsLibraryListEl.appendChild(item);
  }
}

function renderWorkflowOpsLibraryDetail() {
  host.architectureClear(workflowOpsLibraryDetailEl);
  if (!workflowOpsLibraryDetailEl) return;
  const compilation = architectureWorkflowState.selectedCompilation;
  if (!compilation) {
    workflowOpsLibraryDetailEl.appendChild(host.architectureEmpty('Select a compiled workflow'));
    return;
  }
  const definition = compilation.definition || {};
  workflowOpsLibraryDetailEl.append(
    host.architectureHeading(3, definition.name || compilation.workflowId || compilation.id),
    host.architectureKeyValues([
      ['Compilation', compilation.id],
      ['Status', compilation.status],
      ['Published workflow', compilation.workflowId],
      ['Version', compilation.workflowVersion],
      ['Risk', definition.riskLevel],
      ['Compiler', compilation.compilerVersion],
      ['Created', host.architectureDate(compilation.createdAt)],
      ['Updated', host.architectureDate(compilation.updatedAt)],
    ]),
    host.architectureHeading(4, 'Purpose'),
    host.architectureMuted(definition.description || 'No purpose recorded'),
    host.architectureHeading(4, 'Evidence and permissions'),
    host.architectureKeyValues([
      ['Sources', compilation.sourceIds || definition.allowedSourceIds],
      ['Tools', compilation.toolNames || definition.allowedTools],
      ['Approval gates', (definition.approvalGates || []).map(gate => [gate.id, gate.type].filter(Boolean).join(': '))],
      ['Success metrics', definition.successMetrics],
    ])
  );
  const validation = Array.isArray(compilation.validation) ? compilation.validation : [];
  const warnings = Array.isArray(compilation.warnings) ? compilation.warnings : [];
  workflowOpsLibraryDetailEl.appendChild(host.architectureHeading(4, 'Release checks'));
  workflowOpsLibraryDetailEl.appendChild(host.architectureInlineBadges([
    validation.length ? `${validation.length} validation error(s)` : 'validated',
    ...validation.map(error => [error?.path, error?.message].filter(Boolean).join(': ')),
    ...warnings,
  ]));

  if (compilation.workflowId) {
    const actions = document.createElement('div');
    actions.className = 'workflow-ops-actions';
    for (const [mode, label, primary] of [
      ['dry_run', 'Start dry run', false],
      ['shadow', 'Start shadow run', false],
      ['approval_gated', 'Start approval-gated run', true],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.classList.toggle('primary', primary);
      button.disabled = Boolean(architectureWorkflowBusy);
      button.onclick = () => startWorkflowOpsRun(compilation, mode);
      actions.appendChild(button);
    }
    workflowOpsLibraryDetailEl.appendChild(actions);
  }
}

function selectWorkflowOpsCompilation(compilationId) {
  const compilation = architectureWorkflowState.compilations.find(item => item.id === compilationId);
  if (!compilation) return;
  architectureWorkflowState.selectedCompilation = compilation;
  renderWorkflowOpsLibraryList();
  renderWorkflowOpsLibraryDetail();
}

async function compileWorkflowOperation(event) {
  event?.preventDefault();
  if (architectureWorkflowBusy) return;
  const name = workflowOpsCompileNameEl?.value.trim() || '';
  const transcript = workflowOpsCompileTranscriptEl?.value.trim() || '';
  if (!name || !transcript) return;
  const sourceIds = workflowOpsSplitValues(workflowOpsCompileSourcesEl?.value);
  const toolName = workflowOpsCompileToolEl?.value.trim() || '';
  architectureWorkflowBusy = 'compile';
  if (workflowOpsCompileBtn) workflowOpsCompileBtn.disabled = true;
  host.architectureStatus(architectureWorkflowStatusEl, 'Compiling governed workflow...');
  try {
    const result = await host.callTool('workflow_action', {
      action: 'compile',
      workspaceId: host.activeWorkspaceId(),
      name,
      purpose: transcript,
      transcript,
      sourceIds,
      ...(toolName ? {
        toolCalls: [{
          toolName,
          capability: 'write',
          sourceIds,
          reason: 'Compiled in Workflow Operations Center.',
        }],
      } : {}),
      riskLevel: workflowOpsCompileRiskEl?.value || 'medium',
      successMetrics: ['evidence cited', 'approval decision recorded', 'run completed'],
      publish: Boolean(workflowOpsCompilePublishEl?.checked),
      dryRun: Boolean(workflowOpsCompileDryRunEl?.checked),
      sampleInputs: {},
    });
    await loadArchitectureWorkflowApprovals(true);
    const compilationId = result?.compilation?.id;
    if (compilationId) selectWorkflowOpsCompilation(compilationId);
    activateWorkflowOpsView('library');
    host.architectureStatus(architectureWorkflowStatusEl, result?.published ? 'Workflow compiled, published, and smoke-tested.' : 'Workflow draft compiled.');
  } catch (err) {
    host.architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
  } finally {
    architectureWorkflowBusy = '';
    if (workflowOpsCompileBtn) workflowOpsCompileBtn.disabled = false;
    renderWorkflowOpsLibraryDetail();
  }
}

async function startWorkflowOpsRun(compilation, mode) {
  if (!compilation?.workflowId || architectureWorkflowBusy) return;
  architectureWorkflowBusy = `start:${mode}`;
  renderWorkflowOpsLibraryDetail();
  host.architectureStatus(architectureWorkflowStatusEl, `Starting ${mode.replaceAll('_', ' ')}...`);
  try {
    const run = await host.callTool('workflow_action', {
      action: mode === 'dry_run' ? 'dry_run' : 'start',
      workspaceId: host.activeWorkspaceId(),
      workflowId: compilation.workflowId,
      ...(compilation.workflowVersion ? { workflowVersion: compilation.workflowVersion } : {}),
      mode,
      inputs: compilation.sampleInputs || {},
      evidenceSourceIds: compilation.sourceIds || [],
      proposedActions: compilation.proposedActions || [],
    });
    await loadArchitectureWorkflowApprovals(true);
    activateWorkflowOpsView('runs');
    if (run?.id) await selectWorkflowOpsRun(run.id);
    host.architectureStatus(architectureWorkflowStatusEl, `${mode.replaceAll('_', ' ')} started.`);
  } catch (err) {
    host.architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
  } finally {
    architectureWorkflowBusy = '';
    renderWorkflowOpsLibraryDetail();
  }
}

function workflowOpsFilteredRuns() {
  const term = String(workflowOpsRunSearchEl?.value || '').trim().toLowerCase();
  const status = workflowOpsRunStatusEl?.value || 'all';
  return workflowOpsSortedRuns().filter(run => {
    if (status !== 'all' && run.status !== status) return false;
    if (!term) return true;
    return [run.id, run.workflowId, run.workflowVersion, run.mode, run.status]
      .some(value => String(value || '').toLowerCase().includes(term));
  });
}

function renderWorkflowOpsRunList() {
  host.architectureClear(workflowOpsRunListEl);
  if (!workflowOpsRunListEl) return;
  const runs = workflowOpsFilteredRuns();
  if (!runs.length) {
    workflowOpsRunListEl.appendChild(host.architectureEmpty('No matching workflow runs'));
    return;
  }
  for (const run of runs) {
    const item = host.architectureItemButton({
      title: run.workflowId,
      meta: [run.id, run.mode, host.architectureDate(run.updatedAt || run.createdAt)].filter(Boolean).join(' | '),
      badge: run.status,
      active: architectureWorkflowState.selectedRun?.id === run.id,
      onClick: () => selectWorkflowOpsRun(run.id),
    });
    item.dataset.runId = run.id;
    item.dataset.workflowId = run.workflowId;
    workflowOpsRunListEl.appendChild(item);
  }
}

function workflowOpsDisclosure(label, content, open = false) {
  const details = document.createElement('details');
  details.className = 'workflow-ops-disclosure';
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = label;
  details.append(summary, content);
  return details;
}

async function openWorkflowEvidenceSource(sourceId) {
  if (!sourceId) return;
  host.setArchitectureOpen(true, 'sources');
  if (!host.architectureSourcesState.loaded) await host.loadArchitectureSources();
  await host.selectArchitectureSource(sourceId);
}

function workflowOpsEvidenceLinks(current) {
  const wrap = document.createElement('div');
  wrap.className = 'architecture-key-values';
  const appendLinks = (label, references) => {
    const row = document.createElement('div');
    const key = document.createElement('strong');
    key.textContent = label;
    const values = document.createElement('span');
    values.className = 'architecture-inline-list';
    for (const reference of references) {
      const sourceId = typeof reference === 'string' ? reference : reference.sourceId;
      const value = typeof reference === 'string' ? reference : (reference.sourceVersionId || reference.sourceId);
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'architecture-link-button';
      link.dataset.sourceId = sourceId || '';
      link.textContent = value;
      link.addEventListener('click', () => void openWorkflowEvidenceSource(sourceId), {signal:lifecycle.signal});
      values.appendChild(link);
    }
    if (!values.childElementCount) values.appendChild(host.architectureMuted('-'));
    row.append(key, values);
    wrap.appendChild(row);
  };
  appendLinks('Source IDs', current.evidenceSourceIds || []);
  appendLinks('Source versions', current.evidenceSourceVersions || []);
  return wrap;
}

function workflowOpsActionCards(actions, emptyText) {
  const wrap = document.createElement('div');
  if (!actions.length) {
    wrap.appendChild(host.architectureEmpty(emptyText));
    return wrap;
  }
  wrap.className = 'architecture-card-grid';
  for (const action of actions) {
    const body = document.createElement('div');
    body.appendChild(host.architectureKeyValues([
      ['Action ID', action.id],
      ['Tool', action.toolName],
      ['Status', action.status],
      ['Approval required', action.requiresApproval === undefined ? undefined : (action.requiresApproval ? 'Yes' : 'No')],
      ['Reason', action.reason],
      ['Sources', action.sourceIds],
      ['Duration', action.durationMs === undefined ? undefined : `${action.durationMs} ms`],
      ['Error', action.error],
    ]));
    body.appendChild(host.architectureHeading(5, 'Inputs'));
    body.appendChild(host.architectureJsonBlock(action.input || {}));
    if (action.output !== undefined) {
      body.appendChild(host.architectureHeading(5, 'Output'));
      body.appendChild(host.architectureJsonBlock(action.output));
    }
    const disclosure = workflowOpsDisclosure(`${action.toolName || action.id} - ${action.status || 'unknown'}`, body);
    disclosure.classList.add('workflow-ops-action');
    disclosure.dataset.actionId = action.id || '';
    wrap.appendChild(disclosure);
  }
  return wrap;
}

function renderWorkflowOpsRunDetail() {
  host.architectureClear(workflowOpsRunDetailEl);
  if (!workflowOpsRunDetailEl) return;
  const run = architectureWorkflowState.selectedRun;
  if (!run) {
    workflowOpsRunDetailEl.appendChild(host.architectureEmpty('Select a workflow run'));
    return;
  }
  const inspected = architectureWorkflowState.inspected?.run?.id === run.id ? architectureWorkflowState.inspected : null;
  const current = inspected?.run || run;
  workflowOpsRunDetailEl.append(
    host.architectureHeading(3, current.id),
    host.architectureKeyValues([
      ['Workflow', current.workflowId],
      ['Version', current.workflowVersion],
      ['Mode', current.mode],
      ['Status', current.status],
      ['Principal', current.principalId],
      ['Created', host.architectureDate(current.createdAt)],
      ['Updated', host.architectureDate(current.updatedAt)],
      ['Error', current.error],
    ]),
    workflowOpsDisclosure('Typed inputs', host.architectureJsonBlock(current.inputs || {})),
    host.architectureHeading(4, 'Evidence'),
    workflowOpsEvidenceLinks(current),
    host.architectureHeading(4, 'Proposed Actions'),
    workflowOpsActionCards(current.proposedActions || [], 'No proposed actions'),
    host.architectureHeading(4, 'Executed Actions'),
    workflowOpsActionCards(current.executedActions || [], 'No actions executed')
  );
  const approvals = Array.isArray(inspected?.approvals) ? inspected.approvals : [];
  workflowOpsRunDetailEl.appendChild(host.architectureHeading(4, 'Approvals'));
  if (approvals.length) workflowOpsRunDetailEl.appendChild(host.architectureTable(approvals, ['gateId', 'status', 'reason', 'decidedAt']));
  else workflowOpsRunDetailEl.appendChild(host.architectureEmpty('No approval gates'));
  const events = Array.isArray(inspected?.events) ? inspected.events : [];
  workflowOpsRunDetailEl.appendChild(host.architectureHeading(4, 'Run Ledger'));
  if (events.length) workflowOpsRunDetailEl.appendChild(host.architectureTable(events, ['sequence', 'eventType', 'timestamp', 'principalId']));
  else workflowOpsRunDetailEl.appendChild(host.architectureEmpty('Loading run events...'));
}

async function selectWorkflowOpsRun(runId) {
  const run = architectureWorkflowState.runs.find(item => item.id === runId);
  if (!run) return;
  architectureWorkflowState.selectedRun = run;
  architectureWorkflowState.inspected = null;
  renderWorkflowOpsRunList();
  renderWorkflowOpsRunDetail();
  host.architectureStatus(architectureWorkflowStatusEl, 'Loading run ledger...');
  try {
    const inspected = await host.callTool('workflow_action', { action: 'inspect_run', runId });
    if (architectureWorkflowState.selectedRun?.id !== runId) return;
    architectureWorkflowState.inspected = inspected;
    if (inspected?.run) {
      architectureWorkflowState.selectedRun = inspected.run;
      const index = architectureWorkflowState.runs.findIndex(item => item.id === runId);
      if (index >= 0) architectureWorkflowState.runs[index] = inspected.run;
    }
    renderWorkflowOpsRunList();
    renderWorkflowOpsRunDetail();
    host.architectureStatus(architectureWorkflowStatusEl, `${architectureWorkflowState.runs.length} run(s)`);
  } catch (err) {
    if (architectureWorkflowState.selectedRun?.id === runId) host.architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
  }
}

function workflowOpsComparisonForRun(runId) {
  return architectureWorkflowState.comparisons.find(comparison => comparison.runId === runId) || null;
}

function workflowOpsShadowRuns() {
  return workflowOpsSortedRuns().filter(run => (
    run.mode === 'shadow' && !workflowOpsComparisonForRun(run.id)
  ));
}

function renderWorkflowOpsShadowList() {
  host.architectureClear(workflowOpsShadowListEl);
  if (!workflowOpsShadowListEl) return;
  const runs = workflowOpsShadowRuns();
  if (!runs.length) {
    workflowOpsShadowListEl.appendChild(host.architectureEmpty('No unlabeled shadow runs'));
    return;
  }
  for (const run of runs) {
    const item = host.architectureItemButton({
      title: run.workflowId,
      meta: `${run.id} | ${host.architectureDate(run.updatedAt || run.createdAt)}`,
      badge: 'unlabeled',
      active: architectureWorkflowState.selectedShadowRun?.id === run.id,
      onClick: () => selectWorkflowOpsShadowRun(run.id),
    });
    item.dataset.runId = run.id;
    workflowOpsShadowListEl.appendChild(item);
  }
}

function renderWorkflowOpsShadowDetail() {
  host.architectureClear(workflowOpsShadowDetailEl);
  if (!workflowOpsShadowDetailEl) return;
  const run = architectureWorkflowState.selectedShadowRun;
  if (!run) {
    workflowOpsShadowDetailEl.appendChild(host.architectureEmpty('Select a shadow run'));
    return;
  }
  const comparison = workflowOpsComparisonForRun(run.id);
  workflowOpsShadowDetailEl.append(
    host.architectureHeading(3, run.id),
    host.architectureKeyValues([
      ['Workflow', run.workflowId],
      ['Version', run.workflowVersion],
      ['Run status', run.status],
      ['Outcome', comparison?.outcome || 'unlabeled'],
      ['Score', comparison?.score],
      ['Recommendation hash', comparison?.recommendationHash],
      ['Human labels', comparison?.humanLabels || comparison?.labels],
      ['Evidence', comparison?.sourceIds || run.evidenceSourceIds],
    ]),
    host.architectureHeading(4, 'Proposed recommendation'),
    workflowOpsActionCards(run.proposedActions || [], 'No proposed actions')
  );
  const actions = document.createElement('div');
  actions.className = 'workflow-ops-actions';
  for (const [label, text] of [['accepted', 'Accept'], ['rejected', 'Reject'], ['mixed', 'Mark mixed']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.classList.toggle('primary', label === 'accepted');
    button.disabled = Boolean(architectureWorkflowBusy);
    button.onclick = () => labelWorkflowOpsShadow(run.id, label);
    actions.appendChild(button);
  }
  workflowOpsShadowDetailEl.appendChild(actions);
}

function selectWorkflowOpsShadowRun(runId) {
  const run = workflowOpsShadowRuns().find(item => item.id === runId);
  if (!run) return;
  architectureWorkflowState.selectedShadowRun = run;
  renderWorkflowOpsShadowList();
  renderWorkflowOpsShadowDetail();
}

async function labelWorkflowOpsShadow(runId, label) {
  if (!runId || architectureWorkflowBusy) return;
  architectureWorkflowBusy = `shadow:${runId}`;
  renderWorkflowOpsShadowDetail();
  host.architectureStatus(architectureWorkflowStatusEl, `Recording ${label} shadow outcome...`);
  try {
    await host.callTool('workflow_action', {
      action: 'compare_shadow_result',
      runId,
      labels: [label],
      note: 'Labeled in Workflow Operations Center.',
    });
    await loadArchitectureWorkflowApprovals(true);
    selectWorkflowOpsShadowRun(runId);
    activateWorkflowOpsView('shadow');
    host.architectureStatus(architectureWorkflowStatusEl, `Shadow outcome recorded as ${label}.`);
  } catch (err) {
    host.architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
  } finally {
    architectureWorkflowBusy = '';
    renderWorkflowOpsShadowDetail();
  }
}

function renderWorkflowOperationsCenter() {
  renderWorkflowOpsSummary();
  renderWorkflowOpsOverview();
  renderWorkflowOpsLibraryList();
  renderWorkflowOpsLibraryDetail();
  renderWorkflowOpsRunList();
  renderWorkflowOpsRunDetail();
  renderArchitectureApprovalList();
  renderArchitectureApprovalDetail();
  renderWorkflowOpsShadowList();
  renderWorkflowOpsShadowDetail();
}

function renderArchitectureApprovalList() {
  host.architectureClear(architectureApprovalListEl);
  if (!architectureApprovalListEl) return;
  const approvals = architectureWorkflowState.approvals;
  if (!approvals.length) {
    architectureApprovalListEl.appendChild(host.architectureEmpty('No approvals'));
    return;
  }
  for (const approval of approvals) {
    const item = host.architectureItemButton({
      title: approval.gateId || approval.id,
      meta: [approval.runId, approval.reason].filter(Boolean).join(' | '),
      badge: approval.status,
      active: architectureWorkflowState.selected?.id === approval.id && architectureWorkflowState.selected?.runId === approval.runId,
      onClick: () => selectArchitectureApproval(approval.id, approval.runId),
    });
    if (approval.id) item.dataset.approvalId = approval.id;
    if (approval.runId) item.dataset.runId = approval.runId;
    architectureApprovalListEl.appendChild(item);
  }
}

function highRiskWriteDetails(action) {
  const input = action?.input || {};
  const path = String(input.path || action?.path || '');
  const highRiskPath = /(^|[\\/])(?:\.env(?:\.[^\\/]*)?|config\.json|credentials(?:\.[^\\/]*)?)$/i.test(path);
  if (!highRiskPath || !['write', 'admin'].includes(action?.capability || 'write')) return null;
  const before = input.existingContent ?? input.before;
  const after = input.content ?? input.after;
  const diff = input.unifiedDiff || input.diff || action.diff || (
    before !== undefined && after !== undefined
      ? `--- ${path}\n+++ ${path}\n-${String(before)}\n+${String(after)}`
      : 'Unified diff unavailable; reject the write until the proposed content can be inspected.'
  );
  return {
    path,
    diff,
    warnings: Array.isArray(input.warnings) && input.warnings.length
      ? input.warnings
      : ['Sensitive configuration path requires explicit approval.'],
    backupPath: input.backupPath || action.backupPath,
  };
}

function closeHighRiskWriteModal() {
  if (architectureHighRiskWriteModalEl) architectureHighRiskWriteModalEl.hidden = true;
  architectureHighRiskWriteContext = null;
}

function openHighRiskWriteModal(action, approval) {
  const details = highRiskWriteDetails(action);
  if (!details || !architectureHighRiskWriteModalEl || !architectureHighRiskWriteContentEl) return;
  architectureHighRiskWriteContext = { action, approval };
  host.architectureClear(architectureHighRiskWriteContentEl);
  architectureHighRiskWriteContentEl.appendChild(host.architectureKeyValues([
    ['Path', details.path],
    ['Backup path', details.backupPath],
    ['Warnings', details.warnings],
  ]));
  architectureHighRiskWriteContentEl.appendChild(host.architectureHeading(4, 'Unified diff'));
  const diff = document.createElement('pre');
  diff.className = 'architecture-code high-risk-write-diff';
  diff.textContent = details.diff;
  architectureHighRiskWriteContentEl.appendChild(diff);
  architectureHighRiskWriteModalEl.hidden = false;
  architectureHighRiskWriteRejectBtn?.focus();
}

function renderArchitectureApprovalDetail() {
  host.architectureClear(architectureApprovalDetailEl);
  if (!architectureApprovalDetailEl) return;
  const approval = architectureWorkflowState.selected;
  if (!approval) {
    architectureApprovalDetailEl.appendChild(host.architectureEmpty('Select an approval'));
    return;
  }
  const inspected = architectureWorkflowState.inspected || {};
  const run = inspected.run || null;
  architectureApprovalDetailEl.append(
    host.architectureHeading(3, approval.gateId || approval.id),
    host.architectureKeyValues([
      ['Approval', approval.id],
      ['Status', approval.status],
      ['Run', approval.runId],
      ['Reason', approval.reason],
      ['Decided', host.architectureDate(approval.decidedAt)],
    ])
  );
  if (approval.status === 'pending') {
    const actions = document.createElement('div');
    actions.className = 'architecture-card-actions';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = 'Approve';
    approve.disabled = Boolean(architectureWorkflowDecision);
    approve.onclick = () => decideArchitectureApproval('approve', approval);
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'danger';
    reject.textContent = 'Reject';
    reject.disabled = Boolean(architectureWorkflowDecision);
    reject.onclick = () => decideArchitectureApproval('reject', approval);
    actions.append(approve, reject);
    architectureApprovalDetailEl.appendChild(actions);
  }
  if (run) {
    architectureApprovalDetailEl.append(
      host.architectureHeading(4, 'Run'),
      host.architectureKeyValues([
        ['Workflow', run.workflowId],
        ['Mode', run.mode],
        ['Status', run.status],
        ['Sources', run.evidenceSourceIds],
        ['Created', host.architectureDate(run.createdAt)],
        ['Updated', host.architectureDate(run.updatedAt)],
      ])
    );
  }
  const proposed = Array.isArray(run?.proposedActions) ? run.proposedActions : [];
  if (proposed.length) {
    architectureApprovalDetailEl.appendChild(host.architectureHeading(4, 'Proposed Actions'));
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const action of proposed) {
      const highRisk = highRiskWriteDetails(action);
      if (highRisk) {
        const item = host.architectureItemButton({
          title: action.toolName || action.id,
          meta: [action.id, highRisk.path, `Sources: ${host.architectureString(action.sourceIds)}`].filter(Boolean).join(' | '),
          badge: 'high risk',
          onClick: () => openHighRiskWriteModal(action, approval),
        });
        item.dataset.highRiskWrite = action.id || highRisk.path;
        grid.appendChild(item);
      } else {
        grid.appendChild(host.architectureCard(action.toolName || action.id, [action.id, `Sources: ${host.architectureString(action.sourceIds)}`], action.status));
      }
    }
    architectureApprovalDetailEl.appendChild(grid);
  }
  const events = Array.isArray(inspected.events) ? inspected.events : [];
  if (events.length) {
    architectureApprovalDetailEl.appendChild(host.architectureHeading(4, 'Ledger'));
    architectureApprovalDetailEl.appendChild(host.architectureTable(events, ['sequence', 'eventType', 'timestamp']));
  }
}

async function selectArchitectureApproval(approvalId, runId) {
  const approval = architectureWorkflowState.approvals.find(item =>
    item.id === approvalId && (runId === undefined || item.runId === runId)
  );
  if (!approval) return;
  architectureWorkflowState.selected = approval;
  architectureWorkflowState.inspected = null;
  renderArchitectureApprovalList();
  renderArchitectureApprovalDetail();
  if (!approval.runId) return;
  host.architectureStatus(architectureWorkflowStatusEl, 'Loading run...');
  try {
    const inspected = await host.callTool('workflow_action', { action: 'inspect_run', runId: approval.runId });
    if (architectureWorkflowState.selected?.id !== approval.id || architectureWorkflowState.selected?.runId !== approval.runId) return;
    architectureWorkflowState.inspected = inspected;
    renderArchitectureApprovalDetail();
    host.architectureStatus(architectureWorkflowStatusEl, `${architectureWorkflowState.approvals.length} approval(s)`);
  } catch (err) {
    host.architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
  }
}

async function loadArchitectureWorkflowApprovals() {
  const requestId = ++architectureWorkflowLoadRequest;
  if (architectureWorkflowRefreshBtn) architectureWorkflowRefreshBtn.disabled = true;
  host.architectureStatus(architectureWorkflowStatusEl, 'Loading workflow operations...');
  try {
    const query = workflowOpsWorkspaceQuery();
    const results = await Promise.allSettled([
      host.callTool('workflow_action', { action: 'compilations', query }),
      host.callTool('workflow_action', { action: 'list_runs', query }),
      host.callTool('workflow_action', { action: 'list_approvals' }),
      host.callTool('workflow_action', { action: 'shadow_report', query }),
    ]);
    if (requestId !== architectureWorkflowLoadRequest) return;
    const [compilationsResult, runsResult, approvalsResult, shadowResult] = results;
    if (compilationsResult.status === 'fulfilled') architectureWorkflowState.compilations = Array.isArray(compilationsResult.value?.compilations) ? compilationsResult.value.compilations : [];
    if (runsResult.status === 'fulfilled') architectureWorkflowState.runs = Array.isArray(runsResult.value?.runs) ? runsResult.value.runs : [];
    if (approvalsResult.status === 'fulfilled') architectureWorkflowState.approvals = Array.isArray(approvalsResult.value?.approvals) ? approvalsResult.value.approvals : [];
    if (shadowResult.status === 'fulfilled') {
      architectureWorkflowState.shadowSummary = shadowResult.value?.summary || null;
      architectureWorkflowState.comparisons = Array.isArray(shadowResult.value?.comparisons) ? shadowResult.value.comparisons : [];
    }
    architectureWorkflowState.loaded = true;

    const previousCompilationId = architectureWorkflowState.selectedCompilation?.id;
    architectureWorkflowState.selectedCompilation = architectureWorkflowState.compilations.find(item => item.id === previousCompilationId)
      || architectureWorkflowState.compilations[0]
      || null;
    const previousSelectedRunId = architectureWorkflowState.selectedRun?.id;
    architectureWorkflowState.selectedRun = architectureWorkflowState.runs.find(run => run.id === previousSelectedRunId)
      || workflowOpsSortedRuns()[0]
      || null;
    const previousShadowRunId = architectureWorkflowState.selectedShadowRun?.id;
    architectureWorkflowState.selectedShadowRun = workflowOpsShadowRuns().find(run => run.id === previousShadowRunId)
      || workflowOpsShadowRuns()[0]
      || null;
    const previousId = architectureWorkflowState.selected?.id;
    const previousRunId = architectureWorkflowState.selected?.runId;
    const next = architectureWorkflowState.approvals.find(approval =>
      approval.id === previousId && approval.runId === previousRunId
    ) || architectureWorkflowState.approvals[0] || null;
    architectureWorkflowState.selected = next;
    architectureWorkflowState.inspected = null;
    renderWorkflowOperationsCenter();
    if (next) await selectArchitectureApproval(next.id, next.runId);
    else if (architectureWorkflowState.selectedRun) await selectWorkflowOpsRun(architectureWorkflowState.selectedRun.id);
    if (requestId !== architectureWorkflowLoadRequest) return;
    const failures = results.filter(result => result.status === 'rejected');
    host.architectureStatus(
      architectureWorkflowStatusEl,
      failures.length
        ? `Loaded with ${failures.length} unavailable workflow service(s). Refresh to retry.`
        : `${architectureWorkflowState.compilations.length} workflow(s), ${architectureWorkflowState.runs.length} run(s), ${architectureWorkflowState.approvals.filter(approval => approval.status === 'pending').length} pending approval(s).`,
      failures.length > 0
    );
  } catch (err) {
    if (requestId !== architectureWorkflowLoadRequest) return;
    host.architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
    architectureWorkflowState.loaded = true;
  } finally {
    if (requestId === architectureWorkflowLoadRequest && architectureWorkflowRefreshBtn) architectureWorkflowRefreshBtn.disabled = false;
  }
}

async function decideArchitectureApproval(action, approval) {
  if (!approval?.runId || architectureWorkflowDecision) return;
  architectureWorkflowDecision = `${approval.runId}:${approval.id}`;
  host.architectureStatus(architectureWorkflowStatusEl, action === 'approve' ? 'Approving...' : 'Rejecting...');
  renderArchitectureApprovalDetail();
  try {
    await host.callTool('workflow_action', {
      action,
      runId: approval.runId,
      approvalId: approval.id,
      reason: action === 'approve' ? 'Approved in architecture UI.' : 'Rejected in architecture UI.',
    });
    await loadArchitectureWorkflowApprovals();
  } catch (err) {
    host.architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
  } finally {
    architectureWorkflowDecision = '';
    renderArchitectureApprovalDetail();
  }
}
return {
get architectureWorkflowStatusEl(){return architectureWorkflowStatusEl},
get architectureWorkflowRefreshBtn(){return architectureWorkflowRefreshBtn},
get architectureApprovalListEl(){return architectureApprovalListEl},
get architectureApprovalDetailEl(){return architectureApprovalDetailEl},
get architectureHighRiskWriteModalEl(){return architectureHighRiskWriteModalEl},
get architectureHighRiskWriteContentEl(){return architectureHighRiskWriteContentEl},
get architectureHighRiskWriteCloseBtn(){return architectureHighRiskWriteCloseBtn},
get architectureHighRiskWriteRejectBtn(){return architectureHighRiskWriteRejectBtn},
get architectureHighRiskWriteApproveBtn(){return architectureHighRiskWriteApproveBtn},
get workflowOpsTabBtns(){return workflowOpsTabBtns},
get workflowOpsPanelEls(){return workflowOpsPanelEls},
get workflowOpsSummaryBtns(){return workflowOpsSummaryBtns},
get workflowOpsWorkflowCountEl(){return workflowOpsWorkflowCountEl},
get workflowOpsRunCountEl(){return workflowOpsRunCountEl},
get workflowOpsPendingCountEl(){return workflowOpsPendingCountEl},
get workflowOpsAcceptanceRateEl(){return workflowOpsAcceptanceRateEl},
get workflowOpsAcceptanceTrendEl(){return workflowOpsAcceptanceTrendEl},
get workflowOpsAttentionEl(){return workflowOpsAttentionEl},
get workflowOpsRecentRunsEl(){return workflowOpsRecentRunsEl},
get workflowOpsShadowReadinessEl(){return workflowOpsShadowReadinessEl},
get workflowOpsCompileForm(){return workflowOpsCompileForm},
get workflowOpsCompileNameEl(){return workflowOpsCompileNameEl},
get workflowOpsCompileRiskEl(){return workflowOpsCompileRiskEl},
get workflowOpsCompileTranscriptEl(){return workflowOpsCompileTranscriptEl},
get workflowOpsCompileSourcesEl(){return workflowOpsCompileSourcesEl},
get workflowOpsCompileToolEl(){return workflowOpsCompileToolEl},
get workflowOpsCompilePublishEl(){return workflowOpsCompilePublishEl},
get workflowOpsCompileDryRunEl(){return workflowOpsCompileDryRunEl},
get workflowOpsCompileBtn(){return workflowOpsCompileBtn},
get workflowOpsLibrarySearchEl(){return workflowOpsLibrarySearchEl},
get workflowOpsLibraryListEl(){return workflowOpsLibraryListEl},
get workflowOpsLibraryDetailEl(){return workflowOpsLibraryDetailEl},
get workflowOpsRunSearchEl(){return workflowOpsRunSearchEl},
get workflowOpsRunStatusEl(){return workflowOpsRunStatusEl},
get workflowOpsRunListEl(){return workflowOpsRunListEl},
get workflowOpsRunDetailEl(){return workflowOpsRunDetailEl},
get workflowOpsShadowListEl(){return workflowOpsShadowListEl},
get workflowOpsShadowDetailEl(){return workflowOpsShadowDetailEl},
get architectureWorkflowState(){return architectureWorkflowState},set architectureWorkflowState(value){architectureWorkflowState=value},
get architectureWorkflowDecision(){return architectureWorkflowDecision},set architectureWorkflowDecision(value){architectureWorkflowDecision=value},
get architectureHighRiskWriteContext(){return architectureHighRiskWriteContext},set architectureHighRiskWriteContext(value){architectureHighRiskWriteContext=value},
get architectureWorkflowBusy(){return architectureWorkflowBusy},set architectureWorkflowBusy(value){architectureWorkflowBusy=value},
get architectureWorkflowLoadRequest(){return architectureWorkflowLoadRequest},set architectureWorkflowLoadRequest(value){architectureWorkflowLoadRequest=value},
get architectureWorkflowRefreshTimer(){return architectureWorkflowRefreshTimer},set architectureWorkflowRefreshTimer(value){architectureWorkflowRefreshTimer=value},
get WORKFLOW_OPS_REFRESH_MS(){return WORKFLOW_OPS_REFRESH_MS},
get workflowOpsWorkspaceQuery(){return workflowOpsWorkspaceQuery},
get workflowOpsSplitValues(){return workflowOpsSplitValues},
get workflowOpsAcceptanceText(){return workflowOpsAcceptanceText},
get workflowOpsAcceptanceTrend(){return workflowOpsAcceptanceTrend},
get stopWorkflowOpsAutoRefresh(){return stopWorkflowOpsAutoRefresh},
get scheduleWorkflowOpsAutoRefresh(){return scheduleWorkflowOpsAutoRefresh},
get activateWorkflowOpsView(){return activateWorkflowOpsView},
get renderWorkflowOpsSummary(){return renderWorkflowOpsSummary},
get workflowOpsSortedRuns(){return workflowOpsSortedRuns},
get renderWorkflowOpsOverview(){return renderWorkflowOpsOverview},
get workflowOpsFilteredCompilations(){return workflowOpsFilteredCompilations},
get renderWorkflowOpsLibraryList(){return renderWorkflowOpsLibraryList},
get renderWorkflowOpsLibraryDetail(){return renderWorkflowOpsLibraryDetail},
get selectWorkflowOpsCompilation(){return selectWorkflowOpsCompilation},
get compileWorkflowOperation(){return compileWorkflowOperation},
get startWorkflowOpsRun(){return startWorkflowOpsRun},
get workflowOpsFilteredRuns(){return workflowOpsFilteredRuns},
get renderWorkflowOpsRunList(){return renderWorkflowOpsRunList},
get workflowOpsDisclosure(){return workflowOpsDisclosure},
get openWorkflowEvidenceSource(){return openWorkflowEvidenceSource},
get workflowOpsEvidenceLinks(){return workflowOpsEvidenceLinks},
get workflowOpsActionCards(){return workflowOpsActionCards},
get renderWorkflowOpsRunDetail(){return renderWorkflowOpsRunDetail},
get selectWorkflowOpsRun(){return selectWorkflowOpsRun},
get workflowOpsComparisonForRun(){return workflowOpsComparisonForRun},
get workflowOpsShadowRuns(){return workflowOpsShadowRuns},
get renderWorkflowOpsShadowList(){return renderWorkflowOpsShadowList},
get renderWorkflowOpsShadowDetail(){return renderWorkflowOpsShadowDetail},
get selectWorkflowOpsShadowRun(){return selectWorkflowOpsShadowRun},
get labelWorkflowOpsShadow(){return labelWorkflowOpsShadow},
get renderWorkflowOperationsCenter(){return renderWorkflowOperationsCenter},
get renderArchitectureApprovalList(){return renderArchitectureApprovalList},
get highRiskWriteDetails(){return highRiskWriteDetails},
get closeHighRiskWriteModal(){return closeHighRiskWriteModal},
get openHighRiskWriteModal(){return openHighRiskWriteModal},
get renderArchitectureApprovalDetail(){return renderArchitectureApprovalDetail},
get selectArchitectureApproval(){return selectArchitectureApproval},
get loadArchitectureWorkflowApprovals(){return loadArchitectureWorkflowApprovals},
get decideArchitectureApproval(){return decideArchitectureApproval},
async activate(force=false){scheduleWorkflowOpsAutoRefresh();if(force||!architectureWorkflowState.loaded)return loadArchitectureWorkflowApprovals();},
status(){return architectureWorkflowStatusEl;},
mount(){
for (const btn of workflowOpsTabBtns) {
    btn.addEventListener('click', () => activateWorkflowOpsView(btn.dataset.workflowOpsView || 'overview'), {signal:lifecycle.signal});
    btn.addEventListener('keydown', event => {
      const current = workflowOpsTabBtns.indexOf(btn);
      let next = current;
      if (event.key === 'ArrowRight') next = (current + 1) % workflowOpsTabBtns.length;
      else if (event.key === 'ArrowLeft') next = (current - 1 + workflowOpsTabBtns.length) % workflowOpsTabBtns.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = workflowOpsTabBtns.length - 1;
      else return;
      event.preventDefault();
      workflowOpsTabBtns[next].focus();
      workflowOpsTabBtns[next].click();
    }, {signal:lifecycle.signal});
  }

for (const btn of workflowOpsSummaryBtns) {
    btn.addEventListener('click', () => activateWorkflowOpsView(btn.dataset.workflowSummaryView || 'overview'), {signal:lifecycle.signal});
  }

architectureWorkflowRefreshBtn?.addEventListener('click', () => host.loadArchitecturePanel('workflows', true), {signal:lifecycle.signal});

workflowOpsCompileForm?.addEventListener('submit', compileWorkflowOperation, {signal:lifecycle.signal});

workflowOpsLibrarySearchEl?.addEventListener('input', renderWorkflowOpsLibraryList, {signal:lifecycle.signal});

workflowOpsRunSearchEl?.addEventListener('input', renderWorkflowOpsRunList, {signal:lifecycle.signal});

workflowOpsRunStatusEl?.addEventListener('change', renderWorkflowOpsRunList, {signal:lifecycle.signal});

architectureHighRiskWriteCloseBtn?.addEventListener('click', closeHighRiskWriteModal, {signal:lifecycle.signal});

architectureHighRiskWriteRejectBtn?.addEventListener('click', async () => {
    const approval = architectureHighRiskWriteContext?.approval;
    closeHighRiskWriteModal();
    if (approval) await decideArchitectureApproval('reject', approval);
  }, {signal:lifecycle.signal});

architectureHighRiskWriteApproveBtn?.addEventListener('click', async () => {
    const approval = architectureHighRiskWriteContext?.approval;
    closeHighRiskWriteModal();
    if (approval) await decideArchitectureApproval('approve', approval);
  }, {signal:lifecycle.signal});
},dispose(){lifecycle.abort();architectureWorkflowLoadRequest++;clearTimeout(architectureWorkflowRefreshTimer);}
};
}
