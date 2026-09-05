/** SQL: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
const architectureSqlForm = document.getElementById('architecture-sql-form');

const architectureSqlMetricEl = document.getElementById('architecture-sql-metric');

const architectureSqlDimensionEl = document.getElementById('architecture-sql-dimension');

const architectureSqlFilterColumnEl = document.getElementById('architecture-sql-filter-column');

const architectureSqlFilterValueEl = document.getElementById('architecture-sql-filter-value');

const architectureSqlLimitEl = document.getElementById('architecture-sql-limit');

const architectureSqlPlanBtn = document.getElementById('architecture-sql-plan-btn');

const architectureSqlApproveBtn = document.getElementById('architecture-sql-approve-btn');

const architectureSqlExecuteBtn = document.getElementById('architecture-sql-execute-btn');

const architectureSqlStatusEl = document.getElementById('architecture-sql-status');

const architectureSqlPreviewEl = document.getElementById('architecture-sql-preview');

const architectureSqlResultsEl = document.getElementById('architecture-sql-results');

const architectureSqlValidationForm = document.getElementById('architecture-sql-validation-form');

const architectureSqlValidationInputEl = document.getElementById('architecture-sql-validation-input');

const architectureSqlValidationBtn = document.getElementById('architecture-sql-validation-btn');

const architectureSqlValidationResultEl = document.getElementById('architecture-sql-validation-result');

let architectureSqlState = { plan: null, approvalToken: '', executed: null };

let architectureSqlBusy = '';

let architectureSqlPlanRequest = 0;

let architectureSqlValidationState = null;

function architectureSqlPlanInput() {
  const metricName = architectureSqlMetricEl?.value.trim() || 'total_revenue';
  const dimensions = (architectureSqlDimensionEl?.value || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const filterColumn = architectureSqlFilterColumnEl?.value.trim() || '';
  const filterValue = architectureSqlFilterValueEl?.value.trim() || '';
  const filters = filterColumn ? [{ columnId: filterColumn, op: 'eq', value: filterValue }] : [];
  const limit = Math.max(1, Number(architectureSqlLimitEl?.value || 50));
  return { workspaceId: host.activeWorkspaceId(), metricName, dimensions, filters, limit };
}

function invalidateArchitectureSqlPlan() {
  if (!architectureSqlBusy && !architectureSqlState.plan && !architectureSqlState.approvalToken && !architectureSqlState.executed) return;
  architectureSqlPlanRequest += 1;
  architectureSqlBusy = '';
  architectureSqlState = { plan: null, approvalToken: '', executed: null };
  host.architectureStatus(architectureSqlStatusEl, 'Query inputs changed. Plan and approve again.');
  renderArchitectureSqlResults();
}

function renderArchitectureSqlValidation() {
  host.architectureClear(architectureSqlValidationResultEl);
  if (!architectureSqlValidationResultEl || !architectureSqlValidationState) return;
  const result = architectureSqlValidationState;
  architectureSqlValidationResultEl.classList.toggle('error', !result.valid);
  architectureSqlValidationResultEl.setAttribute('role', result.valid ? 'status' : 'alert');
  architectureSqlValidationResultEl.appendChild(host.architectureHeading(4, result.valid ? 'SQL validation passed' : 'SQL validation errors'));
  if (result.valid) {
    architectureSqlValidationResultEl.appendChild(host.architectureMuted('Read-only SELECT with an explicit row limit.'));
    return;
  }
  const list = document.createElement('ul');
  for (const reason of result.reasons || []) {
    const item = document.createElement('li');
    item.textContent = reason;
    list.appendChild(item);
  }
  architectureSqlValidationResultEl.appendChild(list);
}

async function validateArchitectureSql(event) {
  event?.preventDefault();
  if (!architectureSqlValidationInputEl || architectureSqlValidationBtn?.disabled) return;
  architectureSqlValidationBtn.disabled = true;
  architectureSqlValidationState = null;
  renderArchitectureSqlValidation();
  try {
    architectureSqlValidationState = await host.callTool('structured_data_action', {
      action: 'validate_sql',
      sql: architectureSqlValidationInputEl.value,
    });
  } catch (err) {
    architectureSqlValidationState = { valid: false, reasons: [String(err?.message || err)] };
  } finally {
    architectureSqlValidationBtn.disabled = false;
    renderArchitectureSqlValidation();
  }
}

function renderArchitectureSqlResults() {
  if (architectureSqlPreviewEl) {
    architectureSqlPreviewEl.textContent = architectureSqlState.plan?.queryRun?.sql || '';
  }
  if (architectureSqlPlanBtn) architectureSqlPlanBtn.disabled = Boolean(architectureSqlBusy);
  if (architectureSqlApproveBtn) {
    architectureSqlApproveBtn.disabled = Boolean(architectureSqlBusy) || !architectureSqlState.plan?.queryRun?.id || Boolean(architectureSqlState.approvalToken);
  }
  if (architectureSqlExecuteBtn) {
    architectureSqlExecuteBtn.disabled = Boolean(architectureSqlBusy) || !architectureSqlState.plan?.queryRun?.id || !architectureSqlState.approvalToken || Boolean(architectureSqlState.executed);
  }
  host.architectureClear(architectureSqlResultsEl);
  if (!architectureSqlResultsEl) return;

  const plan = architectureSqlState.plan;
  if (!plan) {
    architectureSqlResultsEl.appendChild(host.architectureEmpty('No query plan'));
    return;
  }
  const run = architectureSqlState.executed?.run || plan.queryRun;
  architectureSqlResultsEl.append(
    host.architectureHeading(3, 'Query Run'),
    host.architectureKeyValues([
      ['Run', run?.id],
      ['Status', run?.status],
      ['Metric', plan.metric?.businessName || plan.metric?.name],
      ['Table', plan.table?.displayName || plan.table?.tableName],
      ['Row limit', run?.rowLimit],
      ['SQL hash', run?.sqlHash],
      ['Sources', run?.sourceIds],
      ['Estimated cost', plan.costEstimate ? `${plan.costEstimate.complexity} (score ${plan.costEstimate.score})` : undefined],
      ['Cost factors', plan.costEstimate?.factors],
      ['Warning', plan.rowCapWarning],
    ])
  );

  if (Array.isArray(plan.validation?.reasons) && plan.validation.reasons.length) {
    architectureSqlResultsEl.append(host.architectureHeading(4, 'Validation'), host.architectureInlineBadges(plan.validation.reasons));
  }

  const executed = architectureSqlState.executed;
  if (!executed) return;
  const rows = Array.isArray(executed.rows) ? executed.rows : [];
  const fields = Array.isArray(executed.fields) && executed.fields.length
    ? executed.fields
    : Array.from(new Set(rows.flatMap(row => Object.keys(row || {}))));
  architectureSqlResultsEl.append(host.architectureHeading(4, 'Rows'));
  architectureSqlResultsEl.appendChild(rows.length && fields.length ? host.architectureTable(rows, fields) : host.architectureEmpty('No rows'));
  if (executed.citation) {
    architectureSqlResultsEl.append(host.architectureHeading(4, 'Result Citation'), host.architectureMuted(executed.citation.text || executed.citation.sourceId));
  }
}

async function planArchitectureSql(event) {
  event?.preventDefault();
  if (architectureSqlBusy) return;
  const requestId = ++architectureSqlPlanRequest;
  architectureSqlBusy = 'plan';
  host.architectureStatus(architectureSqlStatusEl, 'Planning query...');
  architectureSqlState = { plan: null, approvalToken: '', executed: null };
  renderArchitectureSqlResults();
  try {
    const plan = await host.callTool('structured_data_action', { action: 'plan_query', plan: architectureSqlPlanInput() });
    if (requestId !== architectureSqlPlanRequest) return;
    if (!plan?.queryRun?.id) throw new Error('Query planning returned no query run.');
    architectureSqlState.plan = plan;
    renderArchitectureSqlResults();
    host.architectureStatus(architectureSqlStatusEl, plan.rowCapWarning || 'Query planned.');
  } catch (err) {
    if (requestId !== architectureSqlPlanRequest) return;
    host.architectureStatus(architectureSqlStatusEl, String(err?.message || err), true);
  } finally {
    if (requestId === architectureSqlPlanRequest) {
      architectureSqlBusy = '';
      renderArchitectureSqlResults();
    }
  }
}

async function approveArchitectureSql() {
  const runId = architectureSqlState.plan?.queryRun?.id;
  if (!runId || architectureSqlBusy) return;
  architectureSqlBusy = 'approve';
  host.architectureStatus(architectureSqlStatusEl, 'Approving query...');
  renderArchitectureSqlResults();
  try {
    const result = await host.callTool('structured_data_action', { action: 'approve_query', queryRunId: runId });
    if (!result?.approvalToken) throw new Error('Query approval returned no approval token.');
    architectureSqlState.approvalToken = result.approvalToken;
    if (result?.queryRun && architectureSqlState.plan) architectureSqlState.plan.queryRun = result.queryRun;
    renderArchitectureSqlResults();
    host.architectureStatus(architectureSqlStatusEl, 'Query approved.');
  } catch (err) {
    host.architectureStatus(architectureSqlStatusEl, String(err?.message || err), true);
  } finally {
    architectureSqlBusy = '';
    renderArchitectureSqlResults();
  }
}

async function executeArchitectureSql() {
  const runId = architectureSqlState.plan?.queryRun?.id;
  if (!runId || !architectureSqlState.approvalToken || architectureSqlBusy) return;
  architectureSqlBusy = 'execute';
  host.architectureStatus(architectureSqlStatusEl, 'Executing query...');
  renderArchitectureSqlResults();
  try {
    const result = await host.callTool('structured_data_action', {
      action: 'execute_query',
      queryRunId: runId,
      approvalToken: architectureSqlState.approvalToken,
    });
    architectureSqlState.executed = result;
    renderArchitectureSqlResults();
    host.architectureSourcesState.loaded = false;
    host.architectureStatus(architectureSqlStatusEl, `Executed ${Array.isArray(result?.rows) ? result.rows.length : 0} row(s).`);
  } catch (err) {
    host.architectureStatus(architectureSqlStatusEl, String(err?.message || err), true);
  } finally {
    architectureSqlBusy = '';
    renderArchitectureSqlResults();
  }
}
return {
get architectureSqlForm(){return architectureSqlForm},
get architectureSqlMetricEl(){return architectureSqlMetricEl},
get architectureSqlDimensionEl(){return architectureSqlDimensionEl},
get architectureSqlFilterColumnEl(){return architectureSqlFilterColumnEl},
get architectureSqlFilterValueEl(){return architectureSqlFilterValueEl},
get architectureSqlLimitEl(){return architectureSqlLimitEl},
get architectureSqlPlanBtn(){return architectureSqlPlanBtn},
get architectureSqlApproveBtn(){return architectureSqlApproveBtn},
get architectureSqlExecuteBtn(){return architectureSqlExecuteBtn},
get architectureSqlStatusEl(){return architectureSqlStatusEl},
get architectureSqlPreviewEl(){return architectureSqlPreviewEl},
get architectureSqlResultsEl(){return architectureSqlResultsEl},
get architectureSqlValidationForm(){return architectureSqlValidationForm},
get architectureSqlValidationInputEl(){return architectureSqlValidationInputEl},
get architectureSqlValidationBtn(){return architectureSqlValidationBtn},
get architectureSqlValidationResultEl(){return architectureSqlValidationResultEl},
get architectureSqlState(){return architectureSqlState},set architectureSqlState(value){architectureSqlState=value},
get architectureSqlBusy(){return architectureSqlBusy},set architectureSqlBusy(value){architectureSqlBusy=value},
get architectureSqlPlanRequest(){return architectureSqlPlanRequest},set architectureSqlPlanRequest(value){architectureSqlPlanRequest=value},
get architectureSqlValidationState(){return architectureSqlValidationState},set architectureSqlValidationState(value){architectureSqlValidationState=value},
get architectureSqlPlanInput(){return architectureSqlPlanInput},
get invalidateArchitectureSqlPlan(){return invalidateArchitectureSqlPlan},
get renderArchitectureSqlValidation(){return renderArchitectureSqlValidation},
get validateArchitectureSql(){return validateArchitectureSql},
get renderArchitectureSqlResults(){return renderArchitectureSqlResults},
get planArchitectureSql(){return planArchitectureSql},
get approveArchitectureSql(){return approveArchitectureSql},
get executeArchitectureSql(){return executeArchitectureSql},
async activate(force=false){renderArchitectureSqlResults();},
status(){return architectureSqlStatusEl;},
mount(){
architectureSqlForm?.addEventListener('submit', planArchitectureSql, {signal:lifecycle.signal});

architectureSqlApproveBtn?.addEventListener('click', approveArchitectureSql, {signal:lifecycle.signal});

architectureSqlExecuteBtn?.addEventListener('click', executeArchitectureSql, {signal:lifecycle.signal});

architectureSqlValidationForm?.addEventListener('submit', validateArchitectureSql, {signal:lifecycle.signal});

[
    architectureSqlMetricEl,
    architectureSqlDimensionEl,
    architectureSqlFilterColumnEl,
    architectureSqlFilterValueEl,
    architectureSqlLimitEl,
  ].forEach(control => control?.addEventListener('input', invalidateArchitectureSqlPlan, {signal:lifecycle.signal}));
},dispose(){lifecycle.abort();architectureSqlPlanRequest++;}
};
}
