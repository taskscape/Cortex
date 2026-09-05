/** Expert reviews: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
const expertMenuEl       = document.getElementById('expert-menu');

const expertToggleBtn    = document.getElementById('expert-toggle-btn');

const expertPopoverEl    = document.getElementById('expert-popover');

const expertEnabledEl    = document.getElementById('expert-enabled');

const expertAllEl        = document.getElementById('expert-all');

const expertListEl       = document.getElementById('expert-list');

const expertModeEl       = document.getElementById('expert-mode');

const expertSynthesizeEl = document.getElementById('expert-synthesize');

const expertStatusEl     = document.getElementById('expert-status');

const architectureReviewForm = document.getElementById('architecture-review-form');

const architectureReviewModalEl = document.getElementById('architecture-review-modal');

const architectureReviewOpenBtn = document.getElementById('architecture-review-open-btn');

const architectureReviewCloseBtn = document.getElementById('architecture-review-close-btn');

const architectureReviewCancelBtn = document.getElementById('architecture-review-cancel-btn');

const architectureReviewQuestionEl = document.getElementById('architecture-review-question');

const architectureReviewTargetTypeEl = document.getElementById('architecture-review-target-type');

const architectureReviewTargetIdEl = document.getElementById('architecture-review-target-id');

const architectureReviewWorkflowIdEl = document.getElementById('architecture-review-workflow-id');

const architectureReviewRunIdEl = document.getElementById('architecture-review-run-id');

const architectureReviewExpertsEl = document.getElementById('architecture-review-experts');

const architectureReviewRefreshBtn = document.getElementById('architecture-review-refresh');

const architectureReviewCreateBtn = document.getElementById('architecture-review-create-btn');

const architectureReviewStatusEl = document.getElementById('architecture-review-status');

const architectureReviewListEl = document.getElementById('architecture-review-list');

const architectureReviewDetailEl = document.getElementById('architecture-review-detail');

let expertPanelExperts = [];

let expertPanelBusy = false;

let architectureReviewState = { reviews: [], selected: null, loaded: false };

function renderArchitectureReviewList() {
  host.architectureClear(architectureReviewListEl);
  if (!architectureReviewListEl) return;
  const reviews = architectureReviewState.reviews;
  if (!reviews.length) {
    architectureReviewListEl.appendChild(host.architectureEmpty('No reviews'));
    return;
  }
  for (const review of reviews) {
    const expertIds = Array.isArray(review.expertIds) && review.expertIds.length
      ? review.expertIds
      : (review.experts || []).map(expert => expert.expertId).filter(Boolean);
    architectureReviewListEl.appendChild(host.architectureItemButton({
      title: review.question || review.id,
      meta: [review.targetType, review.targetId, review.workflowRunId, expertIds.length ? `Experts: ${expertIds.join(', ')}` : undefined].filter(Boolean).join(' | '),
      badge: review.status,
      active: architectureReviewState.selected?.id === review.id,
      onClick: () => selectArchitectureReview(review.id),
    }));
  }
}

function renderArchitectureReviewDetail() {
  host.architectureClear(architectureReviewDetailEl);
  if (!architectureReviewDetailEl) return;
  const review = architectureReviewState.selected;
  if (!review) {
    architectureReviewDetailEl.appendChild(host.architectureEmpty('Select a review'));
    return;
  }
  architectureReviewDetailEl.append(
    host.architectureHeading(3, review.question || review.id),
    host.architectureKeyValues([
      ['Review', review.id],
      ['Status', review.status],
      ['Mode', review.reviewMode || review.mode],
      ['Target', [review.targetType, review.targetId].filter(Boolean).join(': ')],
      ['Workflow', review.workflowId],
      ['Run', review.workflowRunId],
      ['Sources', review.sourceIds],
      ['Created', host.architectureDate(review.createdAt)],
    ])
  );
  if (review.synthesis) {
    architectureReviewDetailEl.append(host.architectureHeading(4, 'Synthesis'), host.architectureMuted(review.synthesis));
  }
  const experts = Array.isArray(review.experts) ? review.experts : [];
  architectureReviewDetailEl.appendChild(host.architectureHeading(4, 'Expert Cards'));
  if (experts.length) {
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const expert of experts) {
      grid.appendChild(host.architectureCard(expert.title || expert.expertId, [
        expert.answer,
        `Risks: ${host.architectureString(expert.risks)}`,
        `Mitigations: ${host.architectureString(expert.mitigations)}`,
        `Checklist: ${host.architectureString(expert.approvalChecklist)}`,
      ], expert.recommendation || expert.confidence));
    }
    architectureReviewDetailEl.appendChild(grid);
  } else {
    architectureReviewDetailEl.appendChild(host.architectureEmpty('No expert cards'));
  }
  const risks = Array.isArray(review.riskRegister) ? review.riskRegister : [];
  if (risks.length) {
    architectureReviewDetailEl.append(host.architectureHeading(4, 'Risk Register'), host.architectureTable(risks, ['severity', 'description', 'ownerExpertId', 'mitigation']));
  }
}

async function selectArchitectureReview(reviewId) {
  const review = architectureReviewState.reviews.find(item => item.id === reviewId);
  if (!review) return;
  architectureReviewState.selected = review;
  renderArchitectureReviewList();
  renderArchitectureReviewDetail();
  host.architectureStatus(architectureReviewStatusEl, 'Loading review...');
  try {
    const result = await host.callTool('expert_panel', { action: 'get_review', reviewId });
    if (architectureReviewState.selected?.id !== review.id) return;
    if (result?.review) {
      architectureReviewState.selected = result.review;
      const idx = architectureReviewState.reviews.findIndex(item => item.id === result.review.id);
      if (idx >= 0) architectureReviewState.reviews[idx] = result.review;
    }
    renderArchitectureReviewList();
    renderArchitectureReviewDetail();
    host.architectureStatus(architectureReviewStatusEl, `${architectureReviewState.reviews.length} review(s)`);
  } catch (err) {
    host.architectureStatus(architectureReviewStatusEl, String(err?.message || err), true);
  }
}

async function loadArchitectureReviews() {
  if (architectureReviewRefreshBtn) architectureReviewRefreshBtn.disabled = true;
  host.architectureStatus(architectureReviewStatusEl, 'Loading reviews...');
  try {
    const result = await host.callTool('expert_panel', { action: 'list_reviews' });
    architectureReviewState.reviews = Array.isArray(result?.reviews) ? result.reviews : [];
    architectureReviewState.loaded = true;
    const previousId = architectureReviewState.selected?.id;
    const next = architectureReviewState.reviews.find(review => review.id === previousId) || architectureReviewState.reviews[0] || null;
    architectureReviewState.selected = next;
    renderArchitectureReviewList();
    renderArchitectureReviewDetail();
    if (next) await selectArchitectureReview(next.id);
    else host.architectureStatus(architectureReviewStatusEl, 'No reviews');
  } catch (err) {
    host.architectureStatus(architectureReviewStatusEl, String(err?.message || err), true);
    architectureReviewState.loaded = true;
  } finally {
    if (architectureReviewRefreshBtn) architectureReviewRefreshBtn.disabled = false;
  }
}

async function createArchitectureReview(event) {
  event?.preventDefault();
  const question = architectureReviewQuestionEl?.value.trim() || '';
  if (!question) {
    host.architectureStatus(architectureReviewStatusEl, 'Question is required.', true);
    return;
  }
  const experts = [...new Set(Array.from(architectureReviewExpertsEl?.selectedOptions || [])
    .map(option => option.value.trim())
    .filter(Boolean))];
  const targetId = architectureReviewTargetIdEl?.value.trim() || undefined;
  const workflowId = architectureReviewWorkflowIdEl?.value.trim() || undefined;
  const workflowRunId = architectureReviewRunIdEl?.value.trim() || undefined;
  const targetType = architectureReviewTargetTypeEl?.value || 'workflow';
  if (!targetId) {
    host.architectureStatus(architectureReviewStatusEl, 'Target ID is required.', true);
    return;
  }
  if (targetType === 'workflow' && !workflowId) {
    host.architectureStatus(architectureReviewStatusEl, 'Workflow ID is required for workflow reviews.', true);
    return;
  }
  if (targetType === 'workflow_run' && !workflowRunId) {
    host.architectureStatus(architectureReviewStatusEl, 'Run ID is required for workflow run reviews.', true);
    return;
  }
  if (!experts.length) {
    host.architectureStatus(architectureReviewStatusEl, 'Select at least one expert.', true);
    return;
  }
  host.architectureStatus(architectureReviewStatusEl, 'Creating review...');
  if (architectureReviewCreateBtn) architectureReviewCreateBtn.disabled = true;
  try {
    const result = await host.callTool('expert_panel', {
      action: 'review',
      question,
      mode: 'review',
      reviewMode: 'pre_automation_review',
      targetType,
      ...(targetId ? { targetId } : {}),
      ...(workflowId ? { workflowId } : {}),
      ...(workflowRunId ? { workflowRunId } : {}),
      ...(experts.length ? { experts } : {}),
      synthesize: true,
    });
    const review = result?.review;
    if (review?.id) {
      const existing = architectureReviewState.reviews.findIndex(item => item.id === review.id);
      if (existing >= 0) architectureReviewState.reviews[existing] = review;
      else architectureReviewState.reviews.unshift(review);
      architectureReviewState.selected = review;
      architectureReviewState.loaded = true;
      renderArchitectureReviewList();
      renderArchitectureReviewDetail();
    } else {
      await loadArchitectureReviews();
    }
    host.architectureStatus(architectureReviewStatusEl, 'Review created.');
    if (architectureReviewModalEl) architectureReviewModalEl.hidden = true;
  } catch (err) {
    host.architectureStatus(architectureReviewStatusEl, String(err?.message || err), true);
  } finally {
    if (architectureReviewCreateBtn) architectureReviewCreateBtn.disabled = false;
  }
}

function setExpertStatus(text, isError = false) {
  if (!expertStatusEl) return;
  expertStatusEl.textContent = text || '';
  expertStatusEl.classList.toggle('error', Boolean(isError));
}

function updateExpertControlsState() {
  if (expertEnabledEl) expertEnabledEl.disabled = expertPanelBusy || expertPanelExperts.length === 0;
  if (expertToggleBtn) {
    const enabled = expertEnabledEl?.checked === true;
    expertToggleBtn.classList.toggle('enabled', enabled);
    expertToggleBtn.classList.toggle('active', expertPopoverEl?.classList.contains('open') === true);
    expertToggleBtn.setAttribute('aria-expanded', expertPopoverEl?.classList.contains('open') ? 'true' : 'false');
    expertToggleBtn.textContent = enabled ? 'Experts on' : 'Experts';
  }
}

function setExpertPopoverOpen(open) {
  if (!expertPopoverEl) return;
  if (open) host.setWorkspaceSettingsOpen(false);
  expertPopoverEl.classList.toggle('open', open);
  updateExpertControlsState();
}

async function loadExperts() {
  if (!expertListEl) return;
  try {
    const result = await host.callTool('expert_panel', { action: 'list' });
    renderExpertPanel(Array.isArray(result.experts) ? result.experts : []);
    setExpertStatus(result.experts?.length ? '' : 'No experts configured.', !result.experts?.length);
  } catch {
    expertPanelExperts = [];
    renderExpertPanel([]);
    setExpertStatus('expert_panel plugin unavailable.', true);
  }
}

function renderExpertPanel(experts) {
  if (!expertListEl) return;
  expertPanelExperts = [...experts];
  expertListEl.innerHTML = '';

  if (!expertPanelExperts.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9ca3af;font-size:12px;padding:2px 0 2px 20px;';
    empty.textContent = '(none)';
    expertListEl.appendChild(empty);
    updateExpertControlsState();
    return;
  }

  for (const expert of expertPanelExperts) {
    const label = document.createElement('label');
    label.className = 'expert-option';
    if (expert.description) label.title = expert.description;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'expert-choice';
    checkbox.value = expert.id;
    checkbox.checked = true;

    const text = document.createElement('span');
    text.textContent = expert.title || expert.id;

    label.appendChild(checkbox);
    label.appendChild(text);
    expertListEl.appendChild(label);
  }

  if (expertAllEl) expertAllEl.checked = true;
  updateExpertControlsState();
}

function selectedExpertIds() {
  if (expertAllEl?.checked) return [];
  return Array.from(document.querySelectorAll('.expert-choice:checked')).map(el => el.value);
}

function syncExpertAllFromChoices() {
  if (!expertAllEl) return;
  const choices = Array.from(document.querySelectorAll('.expert-choice'));
  expertAllEl.checked = choices.length > 0 && choices.every(choice => choice.checked);
}

function expertUserSummary(question, selected, mode, synthesize) {
  return [
    `Expert panel (${mode})`,
    `Experts: ${selected.length ? selected.join(', ') : 'all'}`,
    `Synthesize decision: ${synthesize ? 'yes' : 'no'}`,
    '',
    question
  ].join('\n');
}

function formatExpertPanelResult(result) {
  const lines = [
    '## Expert panel',
    `Mode: ${result?.mode ?? 'parallel'}`
  ];

  const opinions = Array.isArray(result?.experts) ? result.experts : [];
  for (const opinion of opinions) {
    lines.push('', `### ${opinion.title || opinion.expertId || 'Expert'}`, opinion.answer || '(No answer returned.)');
    const citations = Array.isArray(opinion.citations) ? opinion.citations : [];
    if (citations.length) {
      lines.push('', 'Citations:');
      for (const citation of citations) {
        const title = citation.title || citation.id || citation.path || 'source';
        const path = citation.path ? ` - ${citation.path}` : '';
        lines.push(`- ${title}${path}`);
      }
    }
  }

  if (result?.synthesis) {
    lines.push('', '### Synthesis', result.synthesis);
  }

  if (!opinions.length && !result?.synthesis) {
    lines.push('', 'No expert response was returned.');
  }

  return lines.join('\n');
}

async function runExpertPanelFromUi() {
  if (expertPanelBusy) return;
  const question = host.inputEl.value.trim();
  const mode = expertModeEl?.value || 'parallel';
  const synthesize = expertSynthesizeEl?.checked !== false;
  const experts = selectedExpertIds();

  if (!question) {
    setExpertStatus('Enter a question for the panel.', true);
    host.inputEl.focus();
    return;
  }
  if (!expertAllEl?.checked && experts.length === 0) {
    setExpertStatus('Select at least one expert, or choose all experts.', true);
    return;
  }

  host.closeSidebar();
  setExpertPopoverOpen(false);
  expertPanelBusy = true;
  updateExpertControlsState();
  setExpertStatus('Running expert panel...');
  host.inputEl.value = '';
  host.inputEl.style.height = 'auto';

  try {
    if (host.newSessionPromise && !(await host.newSessionPromise)) return;
    if (!host.currentSessionId) {
      const { id } = await host.apiNewSession();
      host.currentSessionId = id;
      location.hash = id;
    }
    await host.connectSessionStream(host.currentSessionId);

    const input = { question, mode, synthesize, maxCitationsPerExpert: 5, provider: host.providerSel.value };
    if (experts.length) input.experts = experts;
    const result = await host.T.submitExpertPanel(host.currentSessionId, input);
    if (result?.session) {
      if (result.traceId) host.foldedTraces.add(result.traceId);
      host.renderSession(result.session);
    }
    if (result?.isError) {
      setExpertStatus(result.error || 'Expert panel failed.', true);
    } else {
      setExpertStatus('Complete.');
    }
  } catch (err) {
    const message = err?.message ?? String(err);
    host.showSubmitError(expertUserSummary(question, experts, mode, synthesize), message);
    setExpertStatus(message, true);
  } finally {
    expertPanelBusy = false;
    updateExpertControlsState();
    // This flow consumes the HTTP response directly rather than the stream's `done` event, so it never
    // reaches the refresh wired in there. The server titles this session out of band too — same hook.
    host.refreshTitlesAfterFollowup();
  }
}
return {
get expertMenuEl(){return expertMenuEl},
get expertToggleBtn(){return expertToggleBtn},
get expertPopoverEl(){return expertPopoverEl},
get expertEnabledEl(){return expertEnabledEl},
get expertAllEl(){return expertAllEl},
get expertListEl(){return expertListEl},
get expertModeEl(){return expertModeEl},
get expertSynthesizeEl(){return expertSynthesizeEl},
get expertStatusEl(){return expertStatusEl},
get architectureReviewForm(){return architectureReviewForm},
get architectureReviewModalEl(){return architectureReviewModalEl},
get architectureReviewOpenBtn(){return architectureReviewOpenBtn},
get architectureReviewCloseBtn(){return architectureReviewCloseBtn},
get architectureReviewCancelBtn(){return architectureReviewCancelBtn},
get architectureReviewQuestionEl(){return architectureReviewQuestionEl},
get architectureReviewTargetTypeEl(){return architectureReviewTargetTypeEl},
get architectureReviewTargetIdEl(){return architectureReviewTargetIdEl},
get architectureReviewWorkflowIdEl(){return architectureReviewWorkflowIdEl},
get architectureReviewRunIdEl(){return architectureReviewRunIdEl},
get architectureReviewExpertsEl(){return architectureReviewExpertsEl},
get architectureReviewRefreshBtn(){return architectureReviewRefreshBtn},
get architectureReviewCreateBtn(){return architectureReviewCreateBtn},
get architectureReviewStatusEl(){return architectureReviewStatusEl},
get architectureReviewListEl(){return architectureReviewListEl},
get architectureReviewDetailEl(){return architectureReviewDetailEl},
get expertPanelExperts(){return expertPanelExperts},set expertPanelExperts(value){expertPanelExperts=value},
get expertPanelBusy(){return expertPanelBusy},set expertPanelBusy(value){expertPanelBusy=value},
get architectureReviewState(){return architectureReviewState},set architectureReviewState(value){architectureReviewState=value},
get renderArchitectureReviewList(){return renderArchitectureReviewList},
get renderArchitectureReviewDetail(){return renderArchitectureReviewDetail},
get selectArchitectureReview(){return selectArchitectureReview},
get loadArchitectureReviews(){return loadArchitectureReviews},
get createArchitectureReview(){return createArchitectureReview},
get setExpertStatus(){return setExpertStatus},
get updateExpertControlsState(){return updateExpertControlsState},
get setExpertPopoverOpen(){return setExpertPopoverOpen},
get loadExperts(){return loadExperts},
get renderExpertPanel(){return renderExpertPanel},
get selectedExpertIds(){return selectedExpertIds},
get syncExpertAllFromChoices(){return syncExpertAllFromChoices},
get expertUserSummary(){return expertUserSummary},
get formatExpertPanelResult(){return formatExpertPanelResult},
get runExpertPanelFromUi(){return runExpertPanelFromUi},
async activate(force=false){if(force||!architectureReviewState.loaded)return loadArchitectureReviews();},
status(){return architectureReviewStatusEl;},
mount(){
architectureReviewRefreshBtn?.addEventListener('click', () => host.loadArchitecturePanel('reviews', true), {signal:lifecycle.signal});

architectureReviewForm?.addEventListener('submit', createArchitectureReview, {signal:lifecycle.signal});

architectureReviewOpenBtn?.addEventListener('click', () => {
    if (!architectureReviewModalEl) return;
    architectureReviewModalEl.hidden = false;
    architectureReviewQuestionEl?.focus();
  }, {signal:lifecycle.signal});

const closeArchitectureReviewModal = () => {
    if (architectureReviewModalEl) architectureReviewModalEl.hidden = true;
    architectureReviewOpenBtn?.focus();
  };

architectureReviewCloseBtn?.addEventListener('click', closeArchitectureReviewModal, {signal:lifecycle.signal});

architectureReviewCancelBtn?.addEventListener('click', closeArchitectureReviewModal, {signal:lifecycle.signal});

expertToggleBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  setExpertPopoverOpen(!expertPopoverEl?.classList.contains('open'));
}, {signal:lifecycle.signal});

expertPopoverEl?.addEventListener('click', event => event.stopPropagation(), {signal:lifecycle.signal});

document.addEventListener('click', () => setExpertPopoverOpen(false), {signal:lifecycle.signal});

expertEnabledEl?.addEventListener('change', () => updateExpertControlsState(), {signal:lifecycle.signal});

expertAllEl?.addEventListener('change', () => {
  const checked = expertAllEl.checked;
  document.querySelectorAll('.expert-choice').forEach(choice => { choice.checked = checked; });
}, {signal:lifecycle.signal});

expertListEl?.addEventListener('change', (event) => {
  if (event.target?.classList?.contains('expert-choice')) syncExpertAllFromChoices();
}, {signal:lifecycle.signal});
},dispose(){lifecycle.abort();}
};
}
