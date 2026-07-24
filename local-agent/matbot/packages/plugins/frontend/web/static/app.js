// Insecure-context Web Crypto shims (crypto.randomUUID / crypto.subtle.digest, for plain-HTTP local
// hosting) live in the web-bundle loader (apps/web-bundle/src/loader.js), which runs before any module
// — including this frontend — so they're already in place by the time anything here runs. In
// server-backed mode the runtime executes in Node, where Web Crypto is always available.

// ── State ─────────────────────────────────────────────────────────────────────

// localStorage keys
const LS_FONT_SIZE      = 'fontSize';
const LS_PROVIDER       = 'provider';
const LS_SIDEBAR        = 'sidebarSections';
const LS_SIDEBAR_WIDTH  = 'sidebarWidth';

let currentSessionId = null;
let sending = false;          // current session busy? mirrors the server's 'session-busy' status
const busySessions   = new Set();
const unreadSessions = new Set();
const updatedFiles   = new Set();

// ── Scroll control ────────────────────────────────────────────────────────────
//
// We want to avoid the "chasing the bottom" scroll behaviour that makes it
// impossible to read earlier output while the model is still generating.
//
// Strategy:
//   1. On the *first* content token of a turn we scroll so the assistant
//      wrapper sits at the top of the messages viewport.
//   2. After that we do NOT auto-scroll — the user can read at their own pace.
//   3. When the turn finishes, if the bottom of messages is below the fold
//      we morph the send button into a ▼ down-arrow that scrolls to bottom.
//   4. Any manual scroll by the user suppresses ALL auto-scrolling for 10 s.

let scrollSuppressUntil = 0;    // epoch ms — suppress auto-scroll until this time
let programmaticScroll = false; // true while *we* are moving scrollTop (so the
                                // 'scroll' event handler can ignore it)

function isScrollSuppressed() {
  return Date.now() < scrollSuppressUntil;
}

// Call this wrapper before any programmatic scroll so the scroll-listener can
// distinguish user-initiated scrolls from our own.
function programmaticScrollTo(fn) {
  programmaticScroll = true;
  fn();
  // Reset the flag asynchronously — the browser fires 'scroll' synchronously
  // (or at least before the next rAF), so this is safe.
  requestAnimationFrame(() => { programmaticScroll = false; });
}

// Listen for user-initiated scrolls on the messages pane.
// 'wheel' catches mouse wheels and trackpad gestures.
// 'touchmove' catches finger-drags on touch screens.
// Together they cover the vast majority of deliberate user scrolls.
function onUserScroll() {
  if (!programmaticScroll) {
    scrollSuppressUntil = Date.now() + 5000;   // 100ms suppression (temp for testing)
  }
}

// True when the bottom edge of #messages is at or above the bottom of the
// viewport (i.e. the user can see the most recent content without scrolling).
function isMessagesBottomVisible() {
  // True when all content fits in the messages container without scrolling.
  // False when there's overflow — meaning content is hidden off-screen and
  // the user may want the scroll-down button to jump to the bottom.
  const textBlock = messagesEl.querySelector('.message.assistant:last-child .msg-text');
  if (!textBlock) {
    return true;
  }
  const h = window.innerHeight - (chatHeaderEl?.offsetHeight ?? 0)
           - (document.getElementById('input-area')?.offsetHeight ?? 0);
  const fits = textBlock.offsetHeight <= h;
  const atBottom = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 2;
  return fits || atBottom;
}

// Send-button glyphs (SVG, so they render identically across platforms instead of relying on
// font-dependent unicode). Play triangle for send; down-chevron when the button morphs into a
// scroll-to-bottom control.
const ICON_SEND   = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M9 6v12l9-6z"/></svg>';
const ICON_SCROLL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const ICON_STOP   = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
const ICON_TRASH  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';

// Morph the send button into a scroll-down button. Stop is now its own button, and the input
// stays enabled while a turn runs (so you can type-ahead and queue), so neither is touched here.
function showScrollDownButton() {
  sendBtn.innerHTML = ICON_SCROLL;
  sendBtn.classList.add('scroll-down-mode');
}

// Scroll to the very bottom of the messages pane and restore the send button. The Stop button's
// visibility is driven independently by the server's busy status, so we don't reason about it here.
function scrollToBottomAndReset() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  resetSendButton();
  inputEl.focus();
}

// Restore the send button to its normal (play) state.
function resetSendButton() {
  sendBtn.innerHTML = ICON_SEND;
  sendBtn.classList.remove('scroll-down-mode', 'stop-mode');
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.title = '';
  sendBtn.disabled = false;
}

function showStopButton() {
  sendBtn.innerHTML = ICON_STOP;
  sendBtn.classList.remove('scroll-down-mode');
  sendBtn.classList.add('stop-mode');
  sendBtn.setAttribute('aria-label', 'Stop');
  sendBtn.title = 'Stop the running turn and drop anything queued';
  sendBtn.disabled = false;
}

// ── Floating scroll-down button ─────────────────────────────────
//
// A separate ▼ button that appears when the current message text is
// taller than the visible area, letting the user jump to the bottom
// without conflating scroll and send/stop actions.

let scrollDownBtn = null; // initialised in init()

function updateScrollDownButton() {
  if (!scrollDownBtn) return;
  if (isMessagesBottomVisible()) {
    scrollDownBtn.style.display = 'none';
  } else {
    scrollDownBtn.style.display = 'flex';
  }
}



// ── Elements ──────────────────────────────────────────────────────────────────

const messagesEl     = document.getElementById('messages');
const sessionsBanner = document.getElementById('sessions-banner');
const sessionListEl  = document.getElementById('session-list');
const chatHeaderEl   = document.getElementById('chat-header');
const chatTitleEl    = document.getElementById('chat-title');
const inputEl        = document.getElementById('input');
const sendBtn        = document.getElementById('send-btn');
const stopBtn        = document.getElementById('stop-btn');
const newBtn         = document.getElementById('new-btn');
const providerSel    = document.getElementById('provider-select');
const burgerBtn      = document.getElementById('burger');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const expertMenuEl       = document.getElementById('expert-menu');
const expertToggleBtn    = document.getElementById('expert-toggle-btn');
const expertPopoverEl    = document.getElementById('expert-popover');
const expertEnabledEl    = document.getElementById('expert-enabled');
const expertAllEl        = document.getElementById('expert-all');
const expertListEl       = document.getElementById('expert-list');
const expertModeEl       = document.getElementById('expert-mode');
const expertSynthesizeEl = document.getElementById('expert-synthesize');
const expertStatusEl     = document.getElementById('expert-status');
const workspaceToggleBtn = document.getElementById('workspace-toggle-btn');
const workspacePopoverEl = document.getElementById('workspace-popover');
const workspaceListEl    = document.getElementById('workspace-list');
const workspaceNameEl    = document.getElementById('workspace-name');
const workspaceAvatarEl  = document.getElementById('workspace-avatar');
const workspaceStatusEl  = document.getElementById('workspace-status');
const workspaceNewBtn    = document.getElementById('workspace-new-btn');
const workspaceRenameBtn = document.getElementById('workspace-rename-btn');
const workspaceConfigBtn = document.getElementById('workspace-config-btn');
const workspaceSettingsScreenEl = document.getElementById('workspace-settings-screen');
const workspaceSettingsCancelBtn = document.getElementById('workspace-settings-cancel-btn');
const workspaceContextNameEl = document.getElementById('workspace-context-name');
const workspaceRagPathsEl = document.getElementById('workspace-rag-paths');
const workspaceRagProgressBarEl = document.getElementById('workspace-rag-progress-bar');
const workspaceRagStatusEl = document.getElementById('workspace-rag-status');
const workspaceRagCurrentFileEl = document.getElementById('workspace-rag-current-file');
const workspaceRagSaveBtn = document.getElementById('workspace-rag-save-btn');
const workspaceDeleteDialogEl = document.getElementById('workspace-delete-dialog');
const workspaceDeleteMessageEl = document.getElementById('workspace-delete-message');
const workspaceDeleteCancelBtn = document.getElementById('workspace-delete-cancel');
const workspaceDeleteConfirmBtn = document.getElementById('workspace-delete-confirm');
const memoryBrowserBtn = document.getElementById('memory-browser-btn');
const memoryBrowserStatusEl = document.getElementById('memory-browser-status');
const memoryBrowserOverlay = document.getElementById('memory-browser-overlay');
const memoryBrowserCountEl = document.getElementById('memory-browser-count');
const memoryBrowserRefreshBtn = document.getElementById('memory-browser-refresh');
const memoryBrowserCloseBtn = document.getElementById('memory-browser-close');
const memoryBrowserSearchForm = document.getElementById('memory-browser-search-form');
const memoryBrowserSearchEl = document.getElementById('memory-browser-search');
const memoryBrowserFilterEl = document.getElementById('memory-browser-filter');
const memoryBrowserNewFactEl = document.getElementById('memory-browser-new-fact');
const memoryBrowserAddBtn = document.getElementById('memory-browser-add');
const memoryBrowserPanelStatusEl = document.getElementById('memory-browser-panel-status');
const memoryBrowserListEl = document.getElementById('memory-browser-list');
const memoryBrowserLoadMoreBtn = document.getElementById('memory-browser-load-more');
const memoryBrowserEmptyEl = document.getElementById('memory-browser-empty');
const memoryBrowserDetailForm = document.getElementById('memory-browser-detail-form');
const memoryBrowserStateEl = document.getElementById('memory-browser-state');
const memoryBrowserMemoryTitleEl = document.getElementById('memory-browser-memory-title');
const memoryBrowserFactInput = document.getElementById('memory-browser-fact-input');
const memoryBrowserSessionIdInput = document.getElementById('memory-browser-session-id');
const memoryBrowserMessageIdInput = document.getElementById('memory-browser-message-id');
const memoryBrowserCreatedAtInput = document.getElementById('memory-browser-created-at');
const memoryBrowserVersionInput = document.getElementById('memory-browser-version');
const memoryBrowserDreamSkillInput = document.getElementById('memory-browser-dream-skill');
const memoryBrowserIgnoreUntilInput = document.getElementById('memory-browser-ignore-until');
const memoryBrowserDeleteBtn = document.getElementById('memory-browser-delete');
const memoryBrowserSaveBtn = document.getElementById('memory-browser-save');
const architectureScreenEl = document.getElementById('architecture-screen');
const architectureTitleEl = document.getElementById('architecture-title');
const architectureNavBtns = Array.from(document.querySelectorAll('.architecture-nav-btn'));
const architectureTabBtns = Array.from(document.querySelectorAll('.architecture-tab'));
const architecturePanelEls = Array.from(document.querySelectorAll('.architecture-panel'));
const architectureSourceStatusEl = document.getElementById('architecture-source-status');
const architectureSourceRefreshBtn = document.getElementById('architecture-source-refresh');
const architectureSourceListEl = document.getElementById('architecture-source-list');
const architectureSourceDetailEl = document.getElementById('architecture-source-detail');
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
const architectureWorkflowStatusEl = document.getElementById('architecture-workflow-status');
const architectureWorkflowRefreshBtn = document.getElementById('architecture-workflow-refresh');
const architectureApprovalListEl = document.getElementById('architecture-approval-list');
const architectureApprovalDetailEl = document.getElementById('architecture-approval-detail');
const workflowOpsTabBtns = Array.from(document.querySelectorAll('.workflow-ops-tab'));
const workflowOpsPanelEls = Array.from(document.querySelectorAll('.workflow-ops-view'));
const workflowOpsWorkflowCountEl = document.getElementById('workflow-ops-workflow-count');
const workflowOpsRunCountEl = document.getElementById('workflow-ops-run-count');
const workflowOpsPendingCountEl = document.getElementById('workflow-ops-pending-count');
const workflowOpsAcceptanceRateEl = document.getElementById('workflow-ops-acceptance-rate');
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
const architectureGraphForm = document.getElementById('architecture-graph-form');
const architectureGraphRefreshBtn = document.getElementById('architecture-graph-refresh');
const architectureGraphRetrieveBtn = document.getElementById('architecture-graph-retrieve');
const architectureGraphSearchEl = document.getElementById('architecture-graph-search');
const architectureGraphSourceEl = document.getElementById('architecture-graph-source');
const architectureGraphStatusEl = document.getElementById('architecture-graph-status');
const architectureGraphListEl = document.getElementById('architecture-graph-list');
const architectureGraphDetailEl = document.getElementById('architecture-graph-detail');
const architectureReviewForm = document.getElementById('architecture-review-form');
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
let workspaceState = { active: 'default', workspaces: [] };
let workspaceRagPoll = null;
let workspaceRagConfig = null;
let workspaceRagSavedSnapshot = null;
let workspaceRagSaving = false;
let workspaceRagLoadSeq = 0;
let workspaceSwitching = false;
const WORKSPACE_RESTART_TIMEOUT_MS = 120000;
const WORKSPACE_RESTART_STATUS_INTERVAL_MS = 5000;
let memoryBrowserState = { items: [], cursor: undefined, selected: null, loaded: false };
let architectureView = 'sources';
let architectureSourcesState = { sources: [], selected: null, citation: null, events: null, healthReport: null, loaded: false };
let architectureSqlState = { plan: null, approvalToken: '', executed: null };
let architectureSqlBusy = '';
let architectureSqlPlanRequest = 0;
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
let architectureWorkflowBusy = '';
let architectureWorkflowLoadRequest = 0;
let architectureEvaluationState = { metrics: null, roi: null, traces: [], suites: [], runs: [], selectedTrace: null, traceDetail: null, selectedSuite: null, loaded: false };
let architectureEvaluationLoadRequest = 0;
let architectureGraphState = { entities: [], relationships: [], retrieve: null, selected: null, loaded: false };
let architectureGraphRetrieveRequest = 0;
let architectureReviewState = { reviews: [], selected: null, loaded: false };

function closeSidebar() { document.body.classList.remove('sidebar-open'); }
if (burgerBtn)      burgerBtn.onclick      = () => document.body.classList.toggle('sidebar-open');
if (sidebarOverlay) sidebarOverlay.onclick = closeSidebar;

// ── Sidebar section collapse / expand ──────────────────────────────────────────


function loadSidebarState() {
  try {
    const raw = localStorage[LS_SIDEBAR];
    if (!raw) return;
    const state = JSON.parse(raw);
    for (const [name, collapsed] of Object.entries(state)) {
      const section = document.querySelector('.sidebar-section[data-section="' + name + '"]');
      if (!section) continue;
      if (collapsed) section.classList.add('collapsed');
      else           section.classList.remove('collapsed');
    }
  } catch { /* ignore */ }
}

function saveSidebarState() {
  const state = {};
  for (const el of document.querySelectorAll('.sidebar-section[data-section]')) {
    state[el.dataset.section] = el.classList.contains('collapsed');
  }
  localStorage.setItem(LS_SIDEBAR, JSON.stringify(state));
}

document.getElementById('sidebar').addEventListener('click', (e) => {
  const heading = e.target.closest('.sidebar-heading');
  if (!heading) return;
  const section = heading.closest('.sidebar-section');
  if (!section) return;
  section.classList.toggle('collapsed');
  saveSidebarState();
});

loadSidebarState();

// ── Sidebar resize ────────────────────────────────────────────────────────────

{
  const sidebarEl  = document.getElementById('sidebar');
  const resizerEl  = document.getElementById('sidebar-resizer');
  const MIN_W = 160, MAX_W = 600;

  const savedW = parseInt(localStorage.getItem(LS_SIDEBAR_WIDTH) ?? '');
  if (savedW >= MIN_W && savedW <= MAX_W) sidebarEl.style.width = savedW + 'px';

  resizerEl?.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = sidebarEl.offsetWidth;
    resizerEl.classList.add('active');
    document.body.classList.add('sidebar-resizing');

    function onMove(e) {
      const w = Math.max(MIN_W, Math.min(MAX_W, startWidth + e.clientX - startX));
      sidebarEl.style.width = w + 'px';
    }
    function onUp() {
      resizerEl.classList.remove('active');
      document.body.classList.remove('sidebar-resizing');
      localStorage.setItem(LS_SIDEBAR_WIDTH, String(sidebarEl.offsetWidth));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// ── Markdown ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/[&<>\"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c] ?? c));
}

function md(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') return '<p>' + escHtml(text) + '</p>';
  const result = marked.parse(text);
  // Open all links in new tab
  return result.replace(/<a /g, '<a target=\"_blank\" rel=\"noopener noreferrer\" ');
}

// ── Transport ───────────────────────────────────────────────────────────────
//
// All server I/O goes through window.matbotTransport, set up before this script runs:
//   - http-transport.js  (Node-served: fetch + SSE to server.ts)
//   - browser.js         (in-process bundle: drives services.run directly)
// This file is byte-identical in both modes; only the transport behind T differs.
const T = window.matbotTransport;

// ── API ───────────────────────────────────────────────────────────────────────

async function apiListSessions() {
  try {
    const sessions = await callTool('session_action', { action: 'list' });
    sessionsBanner.style.display = 'none';
    return sessions;
  } catch (e) {
    if (String(e).includes('404')) sessionsBanner.style.display = 'flex';
    return [];
  }
}
async function apiGetSession(id)  { try { return await callTool('session_action', { action: 'get', sessionId: id }); } catch { return null; } }
async function apiSessionBusy(id) { return T.sessionBusy(id); }
async function apiListProviders() { try { return (await callTool('provider', { action: 'list' })).providers.map(p => p.name); } catch { return []; } }

async function refreshProviderSelect() {
  const current  = providerSel.value;
  const providers = await apiListProviders();
  providerSel.innerHTML = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = p;
    providerSel.appendChild(opt);
  }
  providerSel.value = providers.includes(current) ? current : (providers[0] ?? '');
  localStorage.setItem(LS_PROVIDER, providerSel.value);
}

// ── Tool API ──────────────────────────────────────────────────────────────────

async function callTool(toolName, input) {
  return T.callTool(toolName, input);
}

// ── Memory browser ───────────────────────────────────────────────────────────

function setMemoryBrowserLauncherStatus(text, isError = false) {
  if (!memoryBrowserStatusEl) return;
  memoryBrowserStatusEl.textContent = text || '';
  memoryBrowserStatusEl.classList.toggle('error', Boolean(isError));
}

function setMemoryBrowserPanelStatus(text, isError = false) {
  if (!memoryBrowserPanelStatusEl) return;
  memoryBrowserPanelStatusEl.textContent = text || '';
  memoryBrowserPanelStatusEl.classList.toggle('error', Boolean(isError));
}

function formatMemoryBrowserDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getMemoryBrowserState(item) {
  if (item?.ignoreUntil) return 'ignored';
  if (item?.dreamSkill) return 'processed';
  return 'unprocessed';
}

function memoryBrowserWhere() {
  const clauses = [];
  const q = memoryBrowserSearchEl?.value.trim() ?? '';
  const state = memoryBrowserFilterEl?.value ?? 'all';
  if (q) clauses.push({ op: 'stringContains', field: 'fact', value: q });
  if (state === 'unprocessed') clauses.push({ op: 'exists', field: 'dreamSkill', value: false });
  if (state === 'processed') clauses.push({ op: 'exists', field: 'dreamSkill', value: true });
  if (state === 'ignored') clauses.push({ op: 'exists', field: 'ignoreUntil', value: true });
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { op: 'and', clauses };
}

async function callMemoryBrowserAction(input) {
  return callTool('remembered_facts_action', input);
}

function renderMemoryBrowserCount(result) {
  if (!memoryBrowserCountEl) return;
  const loaded = memoryBrowserState.items.length;
  memoryBrowserCountEl.textContent = result && result.total !== undefined
    ? `${loaded} of ${result.total}`
    : `${loaded} loaded`;
}

function renderMemoryBrowserList() {
  if (!memoryBrowserListEl) return;
  memoryBrowserListEl.innerHTML = '';

  if (!memoryBrowserState.items.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9ca3af;font-size:12px;padding:8px 10px;';
    empty.textContent = '(none)';
    memoryBrowserListEl.appendChild(empty);
    return;
  }

  for (const item of memoryBrowserState.items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'memory-browser-item';
    row.dataset.id = item.id;
    row.classList.toggle('active', memoryBrowserState.selected?.id === item.id);

    const fact = document.createElement('div');
    fact.className = 'memory-browser-item-fact';
    fact.textContent = item.fact || '(empty fact)';

    const meta = document.createElement('div');
    meta.className = 'memory-browser-item-meta';
    meta.textContent = `${getMemoryBrowserState(item)} | ${formatMemoryBrowserDate(item.createdAt)}`;

    row.append(fact, meta);
    row.onclick = () => selectMemoryBrowserMemory(item.id);
    memoryBrowserListEl.appendChild(row);
  }
}

function renderMemoryBrowserDetail() {
  const item = memoryBrowserState.selected;
  if (memoryBrowserEmptyEl) memoryBrowserEmptyEl.hidden = Boolean(item);
  if (memoryBrowserDetailForm) memoryBrowserDetailForm.hidden = !item;
  if (!item) return;

  if (memoryBrowserStateEl) memoryBrowserStateEl.textContent = getMemoryBrowserState(item);
  if (memoryBrowserMemoryTitleEl) memoryBrowserMemoryTitleEl.textContent = item.id;
  if (memoryBrowserFactInput) memoryBrowserFactInput.value = item.fact || '';
  if (memoryBrowserSessionIdInput) memoryBrowserSessionIdInput.value = item.sessionId || '';
  if (memoryBrowserMessageIdInput) memoryBrowserMessageIdInput.value = item.messageId || '';
  if (memoryBrowserCreatedAtInput) memoryBrowserCreatedAtInput.value = item.createdAt || '';
  if (memoryBrowserVersionInput) memoryBrowserVersionInput.value = item.version || '';
  if (memoryBrowserDreamSkillInput) memoryBrowserDreamSkillInput.value = item.dreamSkill || '';
  if (memoryBrowserIgnoreUntilInput) memoryBrowserIgnoreUntilInput.value = item.ignoreUntil || '';
}

async function selectMemoryBrowserMemory(id) {
  if (!id) return;
  setMemoryBrowserPanelStatus('Loading...');
  try {
    const item = await callMemoryBrowserAction({ action: 'get', id });
    if (!item) throw new Error('Memory not found.');
    memoryBrowserState.selected = item;
    const idx = memoryBrowserState.items.findIndex(candidate => candidate.id === item.id);
    if (idx >= 0) memoryBrowserState.items[idx] = item;
    renderMemoryBrowserList();
    renderMemoryBrowserDetail();
    setMemoryBrowserPanelStatus('');
  } catch (err) {
    setMemoryBrowserPanelStatus(String(err?.message || err), true);
  }
}

async function loadMemoryBrowserMemories(append = false) {
  setMemoryBrowserPanelStatus('Loading...');
  if (memoryBrowserRefreshBtn) memoryBrowserRefreshBtn.disabled = true;
  if (memoryBrowserLoadMoreBtn) memoryBrowserLoadMoreBtn.disabled = true;

  try {
    const query = {
      limit: 50,
      sort: [{ field: 'createdAt', dir: 'desc' }],
    };
    const where = memoryBrowserWhere();
    if (where) query.where = where;
    if (append && memoryBrowserState.cursor) query.cursor = memoryBrowserState.cursor;

    const result = await callMemoryBrowserAction({ action: 'query', query });
    const items = Array.isArray(result?.items) ? result.items : [];
    const previousSelection = memoryBrowserState.selected?.id;
    memoryBrowserState.items = append ? memoryBrowserState.items.concat(items) : items;
    memoryBrowserState.cursor = result?.cursor;
    memoryBrowserState.loaded = true;
    if (memoryBrowserLoadMoreBtn) memoryBrowserLoadMoreBtn.hidden = !memoryBrowserState.cursor;
    renderMemoryBrowserCount(result);
    renderMemoryBrowserList();

    const nextSelection = previousSelection && memoryBrowserState.items.some(item => item.id === previousSelection)
      ? previousSelection
      : memoryBrowserState.items[0]?.id;
    if (nextSelection) await selectMemoryBrowserMemory(nextSelection);
    else {
      memoryBrowserState.selected = null;
      renderMemoryBrowserDetail();
      setMemoryBrowserPanelStatus('');
    }
  } catch (err) {
    setMemoryBrowserPanelStatus(String(err?.message || err), true);
  } finally {
    if (memoryBrowserRefreshBtn) memoryBrowserRefreshBtn.disabled = false;
    if (memoryBrowserLoadMoreBtn) memoryBrowserLoadMoreBtn.disabled = false;
  }
}

function memoryBrowserSelectedData() {
  const current = memoryBrowserState.selected;
  if (!current) return null;
  const fact = memoryBrowserFactInput?.value.trim() ?? '';
  if (!fact) throw new Error('Fact is required.');

  const data = {
    ...current,
    fact,
    sessionId: current.sessionId || 'manual',
    messageId: current.messageId || 'manual',
    createdAt: current.createdAt || new Date().toISOString(),
  };
  delete data.id;
  delete data.version;

  const dreamSkill = memoryBrowserDreamSkillInput?.value.trim() ?? '';
  const ignoreUntil = memoryBrowserIgnoreUntilInput?.value.trim() ?? '';
  if (dreamSkill) data.dreamSkill = dreamSkill;
  else delete data.dreamSkill;
  if (ignoreUntil) data.ignoreUntil = ignoreUntil;
  else delete data.ignoreUntil;

  return data;
}

async function saveMemoryBrowserSelection(event) {
  event.preventDefault();
  const selected = memoryBrowserState.selected;
  if (!selected) return;
  setMemoryBrowserPanelStatus('Saving...');
  if (memoryBrowserSaveBtn) memoryBrowserSaveBtn.disabled = true;

  try {
    const result = await callMemoryBrowserAction({
      action: 'cas',
      id: selected.id,
      expected: selected.version,
      data: memoryBrowserSelectedData(),
    });
    if (result?.ok === false) {
      if (result.current) {
        memoryBrowserState.selected = result.current;
        const idx = memoryBrowserState.items.findIndex(item => item.id === result.current.id);
        if (idx >= 0) memoryBrowserState.items[idx] = result.current;
        renderMemoryBrowserList();
        renderMemoryBrowserDetail();
      }
      throw new Error('Version conflict. Reloaded the current memory.');
    }
    const saved = result?.doc;
    if (!saved?.id) throw new Error('Memory save returned no document.');
    memoryBrowserState.selected = saved;
    const idx = memoryBrowserState.items.findIndex(item => item.id === saved.id);
    if (idx >= 0) memoryBrowserState.items[idx] = saved;
    else memoryBrowserState.items.unshift(saved);
    renderMemoryBrowserList();
    renderMemoryBrowserDetail();
    setMemoryBrowserPanelStatus('Saved.');
  } catch (err) {
    setMemoryBrowserPanelStatus(String(err?.message || err), true);
  } finally {
    if (memoryBrowserSaveBtn) memoryBrowserSaveBtn.disabled = false;
  }
}

async function deleteMemoryBrowserSelection() {
  const selected = memoryBrowserState.selected;
  if (!selected) return;
  if (!confirm('Delete this memory?')) return;
  setMemoryBrowserPanelStatus('Deleting...');
  if (memoryBrowserDeleteBtn) memoryBrowserDeleteBtn.disabled = true;

  try {
    const result = await callMemoryBrowserAction({ action: 'delete', id: selected.id, expected: selected.version });
    if (result?.deleted === false) throw new Error('Delete did not apply. The memory may have changed.');
    memoryBrowserState.items = memoryBrowserState.items.filter(item => item.id !== selected.id);
    memoryBrowserState.selected = null;
    renderMemoryBrowserList();
    renderMemoryBrowserDetail();
    renderMemoryBrowserCount();
    if (memoryBrowserState.items.length) await selectMemoryBrowserMemory(memoryBrowserState.items[0].id);
    setMemoryBrowserPanelStatus('Deleted.');
  } catch (err) {
    setMemoryBrowserPanelStatus(String(err?.message || err), true);
  } finally {
    if (memoryBrowserDeleteBtn) memoryBrowserDeleteBtn.disabled = false;
  }
}

async function addMemoryBrowserMemory() {
  const fact = memoryBrowserNewFactEl?.value.trim() ?? '';
  if (!fact) return;
  setMemoryBrowserPanelStatus('Adding...');
  if (memoryBrowserAddBtn) memoryBrowserAddBtn.disabled = true;

  try {
    const saved = await callMemoryBrowserAction({
      action: 'set',
      data: {
        fact,
        sessionId: 'manual',
        messageId: 'manual',
        createdAt: new Date().toISOString(),
      },
    });
    if (!saved?.id) throw new Error('Memory add returned no document.');
    if (memoryBrowserNewFactEl) memoryBrowserNewFactEl.value = '';
    memoryBrowserState.items.unshift(saved);
    memoryBrowserState.selected = saved;
    renderMemoryBrowserCount();
    renderMemoryBrowserList();
    renderMemoryBrowserDetail();
    setMemoryBrowserPanelStatus('Added.');
  } catch (err) {
    setMemoryBrowserPanelStatus(String(err?.message || err), true);
  } finally {
    if (memoryBrowserAddBtn) memoryBrowserAddBtn.disabled = false;
  }
}

async function openMemoryBrowser() {
  if (!memoryBrowserOverlay) return;
  setMemoryBrowserLauncherStatus('');
  memoryBrowserOverlay.classList.add('open');
  closeSidebar();
  if (!memoryBrowserState.loaded) await loadMemoryBrowserMemories(false);
  else {
    if (memoryBrowserLoadMoreBtn) memoryBrowserLoadMoreBtn.hidden = !memoryBrowserState.cursor;
    renderMemoryBrowserCount();
    renderMemoryBrowserList();
    renderMemoryBrowserDetail();
  }
  setTimeout(() => memoryBrowserSearchEl?.focus(), 0);
}

function closeMemoryBrowser() {
  memoryBrowserOverlay?.classList.remove('open');
}

if (memoryBrowserOverlay) {
  memoryBrowserBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await openMemoryBrowser();
    } catch (err) {
      setMemoryBrowserLauncherStatus(String(err?.message || err), true);
    }
  });
  memoryBrowserOverlay.addEventListener('click', (e) => {
    if (e.target === memoryBrowserOverlay) closeMemoryBrowser();
  });
  memoryBrowserCloseBtn?.addEventListener('click', closeMemoryBrowser);
  memoryBrowserRefreshBtn?.addEventListener('click', () => loadMemoryBrowserMemories(false));
  memoryBrowserLoadMoreBtn?.addEventListener('click', () => loadMemoryBrowserMemories(true));
  memoryBrowserAddBtn?.addEventListener('click', addMemoryBrowserMemory);
  memoryBrowserFilterEl?.addEventListener('change', () => {
    memoryBrowserState.selected = null;
    renderMemoryBrowserDetail();
    loadMemoryBrowserMemories(false);
  });
  memoryBrowserSearchForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    memoryBrowserState.selected = null;
    renderMemoryBrowserDetail();
    loadMemoryBrowserMemories(false);
  });
  memoryBrowserDetailForm?.addEventListener('submit', saveMemoryBrowserSelection);
  memoryBrowserDeleteBtn?.addEventListener('click', deleteMemoryBrowserSelection);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && memoryBrowserOverlay.classList.contains('open')) closeMemoryBrowser();
  });
}

// ── Architecture panels ─────────────────────────────────────────────────────

const ARCHITECTURE_PANEL_TITLES = {
  sources: 'Sources',
  sql: 'SQL Preview',
  workflows: 'Workflow Operations Center',
  evaluation: 'Evaluation, Observability & ROI',
  graph: 'Graph Entities',
  reviews: 'Expert Reviews',
};

function architectureString(value, fallback = '-') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.length ? value.map(item => architectureString(item, '')).filter(Boolean).join(', ') : fallback;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); }
    catch { return fallback; }
  }
  return String(value);
}

function architectureDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function architectureBadgeClass(value) {
  const text = String(value || '').toLowerCase();
  // Check negative states first: values such as "unhealthy" contain the
  // positive word "healthy" and would otherwise be rendered as successful.
  if (['failed', 'rejected', 'critical', 'blocked', 'unhealthy', 'denied', 'error'].some(term => text.includes(term))) return 'bad';
  if (['pending', 'planned', 'waiting', 'degraded', 'stale', 'warning', 'review', 'changes'].some(term => text.includes(term))) return 'warn';
  if (['healthy', 'fresh', 'allowed', 'approved', 'succeeded', 'complete', 'accepted'].some(term => text.includes(term))) return 'good';
  return '';
}

function architectureClear(el) {
  if (el) el.replaceChildren();
}

function architectureStatus(el, text, isError = false) {
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('error', Boolean(isError));
}

function architectureEmpty(text) {
  const div = document.createElement('div');
  div.className = 'architecture-empty';
  div.textContent = text;
  return div;
}

function architectureBadge(text, className = architectureBadgeClass(text)) {
  const span = document.createElement('span');
  span.className = 'architecture-badge' + (className ? ' ' + className : '');
  span.textContent = architectureString(text, 'unknown');
  return span;
}

function architectureMuted(text) {
  const div = document.createElement('div');
  div.className = 'architecture-muted';
  div.textContent = architectureString(text, '');
  return div;
}

function architectureHeading(level, text) {
  const tag = level === 4 ? 'h4' : 'h3';
  const heading = document.createElement(tag);
  heading.textContent = text;
  return heading;
}

function architectureKeyValues(entries) {
  const dl = document.createElement('dl');
  dl.className = 'architecture-kv';
  for (const [label, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (value instanceof Node) dd.appendChild(value);
    else dd.textContent = architectureString(value);
    dl.append(dt, dd);
  }
  return dl;
}

function architectureInlineBadges(values) {
  const wrap = document.createElement('div');
  wrap.className = 'architecture-inline-list';
  for (const value of values.filter(value => value !== undefined && value !== null && value !== '')) {
    wrap.appendChild(architectureBadge(value));
  }
  if (!wrap.childElementCount) wrap.appendChild(architectureMuted('-'));
  return wrap;
}

function architectureItemButton({ title, meta, badge, active, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'architecture-item';
  btn.classList.toggle('active', Boolean(active));
  const titleRow = document.createElement('div');
  titleRow.className = 'architecture-item-title';
  const titleEl = document.createElement('span');
  titleEl.textContent = architectureString(title, '(untitled)');
  titleRow.appendChild(titleEl);
  if (badge !== undefined && badge !== null && badge !== '') titleRow.appendChild(architectureBadge(badge));
  btn.appendChild(titleRow);
  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'architecture-item-meta';
    metaEl.textContent = meta;
    btn.appendChild(metaEl);
  }
  btn.onclick = onClick;
  return btn;
}

function architectureCard(title, lines = [], badge) {
  const card = document.createElement('div');
  card.className = 'architecture-card';
  const header = document.createElement('div');
  header.className = 'architecture-item-title';
  const heading = document.createElement('h3');
  heading.textContent = architectureString(title, '(untitled)');
  header.appendChild(heading);
  if (badge !== undefined && badge !== null && badge !== '') header.appendChild(architectureBadge(badge));
  card.appendChild(header);
  for (const line of lines) {
    const p = document.createElement('p');
    p.textContent = architectureString(line, '');
    card.appendChild(p);
  }
  return card;
}

function architectureTable(rows, fields) {
  const table = document.createElement('table');
  table.className = 'architecture-table';
  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  for (const field of fields) {
    const th = document.createElement('th');
    th.textContent = field;
    trHead.appendChild(th);
  }
  thead.appendChild(trHead);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const field of fields) {
      const td = document.createElement('td');
      td.textContent = architectureString(row?.[field], '');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  return table;
}

function architectureJsonBlock(value) {
  const pre = document.createElement('pre');
  pre.className = 'architecture-code';
  pre.textContent = JSON.stringify(value ?? null, null, 2);
  return pre;
}

function setArchitectureOpen(open, view = architectureView, options = {}) {
  if (!architectureScreenEl) return;
  if (open && !options.skipWorkspace) setWorkspaceSettingsOpen(false);
  if (open) closeMemoryBrowser();
  architectureScreenEl.classList.toggle('open', Boolean(open));
  document.body.classList.toggle('architecture-open', Boolean(open));
  if (!open) return;
  activateArchitecturePanel(view);
  closeSidebar();
  loadArchitecturePanel(view).catch(err => {
    const statusEl = architectureStatusElement(view);
    architectureStatus(statusEl, String(err?.message || err), true);
  });
}

function architectureStatusElement(view) {
  if (view === 'sources') return architectureSourceStatusEl;
  if (view === 'sql') return architectureSqlStatusEl;
  if (view === 'workflows') return architectureWorkflowStatusEl;
  if (view === 'evaluation') return architectureEvaluationStatusEl;
  if (view === 'graph') return architectureGraphStatusEl;
  if (view === 'reviews') return architectureReviewStatusEl;
  return null;
}

function activateArchitecturePanel(view) {
  architectureView = ARCHITECTURE_PANEL_TITLES[view] ? view : 'sources';
  if (architectureTitleEl) architectureTitleEl.textContent = ARCHITECTURE_PANEL_TITLES[architectureView];
  for (const btn of architectureNavBtns) {
    const active = btn.dataset.architectureView === architectureView;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  for (const btn of architectureTabBtns) {
    const active = btn.dataset.architectureTab === architectureView;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
  }
  for (const panel of architecturePanelEls) {
    const active = panel.dataset.architecturePanel === architectureView;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  }
}

async function loadArchitecturePanel(view, force = false) {
  if (view === 'sources' && (force || !architectureSourcesState.loaded)) return loadArchitectureSources();
  if (view === 'workflows' && (force || !architectureWorkflowState.loaded)) return loadArchitectureWorkflowApprovals();
  if (view === 'evaluation' && (force || !architectureEvaluationState.loaded)) return loadArchitectureEvaluation();
  if (view === 'graph' && (force || !architectureGraphState.loaded)) return loadArchitectureGraph(force);
  if (view === 'reviews' && (force || !architectureReviewState.loaded)) return loadArchitectureReviews();
  if (view === 'sql') renderArchitectureSqlResults();
  return undefined;
}

function sourceHealthFindings(sourceId) {
  const findings = Array.isArray(architectureSourcesState.healthReport?.findings)
    ? architectureSourcesState.healthReport.findings
    : [];
  return findings.filter(finding => finding.sourceId === sourceId);
}

function renderArchitectureSourceList() {
  architectureClear(architectureSourceListEl);
  const sources = architectureSourcesState.sources;
  if (!architectureSourceListEl) return;
  if (!sources.length) {
    architectureSourceListEl.appendChild(architectureEmpty('No sources'));
    return;
  }
  for (const source of sources) {
    const status = source.healthState || source.stalenessState || source.sourceKind;
    architectureSourceListEl.appendChild(architectureItemButton({
      title: source.title || source.id,
      meta: [source.sourceKind, source.uri].filter(Boolean).join(' | '),
      badge: status,
      active: architectureSourcesState.selected?.id === source.id,
      onClick: () => selectArchitectureSource(source.id),
    }));
  }
}

function renderArchitectureSourceDetail() {
  architectureClear(architectureSourceDetailEl);
  if (!architectureSourceDetailEl) return;
  const source = architectureSourcesState.selected;
  if (!source) {
    architectureSourceDetailEl.appendChild(architectureEmpty('Select a source'));
    return;
  }

  architectureSourceDetailEl.append(
    architectureHeading(3, source.title || source.id),
    architectureKeyValues([
      ['ID', source.id],
      ['URI', source.uri],
      ['Kind', source.sourceKind],
      ['Sensitivity', source.sensitivity],
      ['Permission', source.permissionState],
      ['Trust', source.trustLevel],
      ['Health', source.healthState],
      ['Freshness', source.stalenessState],
      ['Connector', source.connectorInstanceId],
      ['Observed', architectureDate(source.lastObservedAt)],
      ['Last read', architectureDate(source.lastSuccessfulReadAt)],
    ])
  );

  const limitations = Array.isArray(source.knownLimitations) ? source.knownLimitations : [];
  if (limitations.length) {
    architectureSourceDetailEl.append(architectureHeading(4, 'Limitations'), architectureInlineBadges(limitations));
  }

  const citation = architectureSourcesState.citation;
  architectureSourceDetailEl.append(architectureHeading(4, 'Citation'));
  architectureSourceDetailEl.appendChild(architectureMuted(citation?.text || citation?.sourceId || 'No citation available'));

  const findings = sourceHealthFindings(source.id);
  architectureSourceDetailEl.append(architectureHeading(4, 'Health Findings'));
  if (findings.length) {
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const finding of findings) {
      grid.appendChild(architectureCard(finding.issueType || finding.id, [finding.message, finding.sourceVersionId], finding.severity));
    }
    architectureSourceDetailEl.appendChild(grid);
  } else {
    architectureSourceDetailEl.appendChild(architectureEmpty('No findings'));
  }

  const events = architectureSourcesState.events || {};
  const access = Array.isArray(events.access) ? events.access : [];
  const health = Array.isArray(events.health) ? events.health : [];
  architectureSourceDetailEl.append(architectureHeading(4, 'Events'));
  if (access.length || health.length) {
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const event of [...access, ...health].slice(0, 8)) {
      grid.appendChild(architectureCard(event.action || event.state || event.eventType || event.id, [event.message, architectureDate(event.timestamp || event.checkedAt)], event.allowed === false ? 'denied' : event.state));
    }
    architectureSourceDetailEl.appendChild(grid);
  } else {
    architectureSourceDetailEl.appendChild(architectureEmpty('No events'));
  }
}

async function selectArchitectureSource(sourceId) {
  const source = architectureSourcesState.sources.find(item => item.id === sourceId);
  if (!source) return;
  architectureSourcesState.selected = source;
  renderArchitectureSourceList();
  renderArchitectureSourceDetail();
  architectureStatus(architectureSourceStatusEl, 'Loading source details...');
  try {
    const [citationResult, eventsResult] = await Promise.allSettled([
      callTool('source_action', { action: 'citation', sourceId: source.id }),
      callTool('source_action', { action: 'events', sourceId: source.id }),
    ]);
    if (architectureSourcesState.selected?.id !== source.id) return;
    architectureSourcesState.citation = citationResult.status === 'fulfilled' ? citationResult.value : null;
    architectureSourcesState.events = eventsResult.status === 'fulfilled' ? eventsResult.value : null;
    renderArchitectureSourceDetail();
    architectureStatus(architectureSourceStatusEl, `${architectureSourcesState.sources.length} source(s)`);
  } catch (err) {
    architectureStatus(architectureSourceStatusEl, String(err?.message || err), true);
  }
}

async function loadArchitectureSources() {
  if (architectureSourceRefreshBtn) architectureSourceRefreshBtn.disabled = true;
  architectureStatus(architectureSourceStatusEl, 'Loading sources...');
  try {
    const [sourceResult, healthResult] = await Promise.allSettled([
      callTool('source_action', {
        action: 'list',
        query: { where: { op: 'eq', field: 'workspaceId', value: activeWorkspaceId() } },
      }),
      callTool('source_health_action', { action: 'report', workspaceId: activeWorkspaceId() }),
    ]);
    if (sourceResult.status !== 'fulfilled') throw sourceResult.reason;
    architectureSourcesState.sources = Array.isArray(sourceResult.value?.sources) ? sourceResult.value.sources : [];
    architectureSourcesState.healthReport = healthResult.status === 'fulfilled' ? healthResult.value : null;
    architectureSourcesState.loaded = true;
    const previousId = architectureSourcesState.selected?.id;
    const next = architectureSourcesState.sources.find(source => source.id === previousId) || architectureSourcesState.sources[0] || null;
    architectureSourcesState.selected = next;
    architectureSourcesState.citation = null;
    architectureSourcesState.events = null;
    renderArchitectureSourceList();
    renderArchitectureSourceDetail();
    if (next) await selectArchitectureSource(next.id);
    else architectureStatus(architectureSourceStatusEl, 'No sources');
  } catch (err) {
    architectureStatus(architectureSourceStatusEl, String(err?.message || err), true);
    architectureSourcesState.loaded = true;
    renderArchitectureSourceList();
    renderArchitectureSourceDetail();
  } finally {
    if (architectureSourceRefreshBtn) architectureSourceRefreshBtn.disabled = false;
  }
}

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
  return { workspaceId: activeWorkspaceId(), metricName, dimensions, filters, limit };
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
  architectureClear(architectureSqlResultsEl);
  if (!architectureSqlResultsEl) return;

  const plan = architectureSqlState.plan;
  if (!plan) {
    architectureSqlResultsEl.appendChild(architectureEmpty('No query plan'));
    return;
  }
  const run = architectureSqlState.executed?.run || plan.queryRun;
  architectureSqlResultsEl.append(
    architectureHeading(3, 'Query Run'),
    architectureKeyValues([
      ['Run', run?.id],
      ['Status', run?.status],
      ['Metric', plan.metric?.businessName || plan.metric?.name],
      ['Table', plan.table?.displayName || plan.table?.tableName],
      ['Row limit', run?.rowLimit],
      ['SQL hash', run?.sqlHash],
      ['Sources', run?.sourceIds],
      ['Warning', plan.rowCapWarning],
    ])
  );

  if (Array.isArray(plan.validation?.reasons) && plan.validation.reasons.length) {
    architectureSqlResultsEl.append(architectureHeading(4, 'Validation'), architectureInlineBadges(plan.validation.reasons));
  }

  const executed = architectureSqlState.executed;
  if (!executed) return;
  const rows = Array.isArray(executed.rows) ? executed.rows : [];
  const fields = Array.isArray(executed.fields) && executed.fields.length
    ? executed.fields
    : Array.from(new Set(rows.flatMap(row => Object.keys(row || {}))));
  architectureSqlResultsEl.append(architectureHeading(4, 'Rows'));
  architectureSqlResultsEl.appendChild(rows.length && fields.length ? architectureTable(rows, fields) : architectureEmpty('No rows'));
  if (executed.citation) {
    architectureSqlResultsEl.append(architectureHeading(4, 'Result Citation'), architectureMuted(executed.citation.text || executed.citation.sourceId));
  }
}

async function planArchitectureSql(event) {
  event?.preventDefault();
  if (architectureSqlBusy) return;
  const requestId = ++architectureSqlPlanRequest;
  architectureSqlBusy = 'plan';
  architectureStatus(architectureSqlStatusEl, 'Planning query...');
  architectureSqlState = { plan: null, approvalToken: '', executed: null };
  renderArchitectureSqlResults();
  try {
    const plan = await callTool('structured_data_action', { action: 'plan_query', plan: architectureSqlPlanInput() });
    if (requestId !== architectureSqlPlanRequest) return;
    if (!plan?.queryRun?.id) throw new Error('Query planning returned no query run.');
    architectureSqlState.plan = plan;
    renderArchitectureSqlResults();
    architectureStatus(architectureSqlStatusEl, plan.rowCapWarning || 'Query planned.');
  } catch (err) {
    if (requestId !== architectureSqlPlanRequest) return;
    architectureStatus(architectureSqlStatusEl, String(err?.message || err), true);
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
  architectureStatus(architectureSqlStatusEl, 'Approving query...');
  renderArchitectureSqlResults();
  try {
    const result = await callTool('structured_data_action', { action: 'approve_query', queryRunId: runId });
    if (!result?.approvalToken) throw new Error('Query approval returned no approval token.');
    architectureSqlState.approvalToken = result.approvalToken;
    if (result?.queryRun && architectureSqlState.plan) architectureSqlState.plan.queryRun = result.queryRun;
    renderArchitectureSqlResults();
    architectureStatus(architectureSqlStatusEl, 'Query approved.');
  } catch (err) {
    architectureStatus(architectureSqlStatusEl, String(err?.message || err), true);
  } finally {
    architectureSqlBusy = '';
    renderArchitectureSqlResults();
  }
}

async function executeArchitectureSql() {
  const runId = architectureSqlState.plan?.queryRun?.id;
  if (!runId || !architectureSqlState.approvalToken || architectureSqlBusy) return;
  architectureSqlBusy = 'execute';
  architectureStatus(architectureSqlStatusEl, 'Executing query...');
  renderArchitectureSqlResults();
  try {
    const result = await callTool('structured_data_action', {
      action: 'execute_query',
      queryRunId: runId,
      approvalToken: architectureSqlState.approvalToken,
    });
    architectureSqlState.executed = result;
    renderArchitectureSqlResults();
    architectureSourcesState.loaded = false;
    architectureStatus(architectureSqlStatusEl, `Executed ${Array.isArray(result?.rows) ? result.rows.length : 0} row(s).`);
  } catch (err) {
    architectureStatus(architectureSqlStatusEl, String(err?.message || err), true);
  } finally {
    architectureSqlBusy = '';
    renderArchitectureSqlResults();
  }
}

function workflowOpsWorkspaceQuery() {
  return { where: { op: 'eq', field: 'workspaceId', value: activeWorkspaceId() } };
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
}

function workflowOpsSortedRuns() {
  return [...architectureWorkflowState.runs].sort((left, right) =>
    String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || ''))
  );
}

function renderWorkflowOpsOverview() {
  architectureClear(workflowOpsAttentionEl);
  architectureClear(workflowOpsRecentRunsEl);
  architectureClear(workflowOpsShadowReadinessEl);

  const pending = architectureWorkflowState.approvals.filter(approval => approval.status === 'pending');
  const failed = architectureWorkflowState.runs.filter(run => run.status === 'failed');
  if (workflowOpsAttentionEl) {
    if (!pending.length && !failed.length) workflowOpsAttentionEl.appendChild(architectureEmpty('No workflow operations need attention'));
    else {
      workflowOpsAttentionEl.appendChild(architectureKeyValues([
        ['Pending approvals', pending.length],
        ['Failed runs', failed.length],
      ]));
    }
  }

  if (workflowOpsRecentRunsEl) {
    const recent = workflowOpsSortedRuns().slice(0, 4);
    if (!recent.length) workflowOpsRecentRunsEl.appendChild(architectureEmpty('No workflow runs yet'));
    else {
      for (const run of recent) {
        const item = architectureItemButton({
          title: run.workflowId,
          meta: `${run.id} | ${architectureDate(run.updatedAt || run.createdAt)}`,
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
    if (!summary?.total) workflowOpsShadowReadinessEl.appendChild(architectureEmpty('No labeled shadow runs'));
    else {
      workflowOpsShadowReadinessEl.appendChild(architectureKeyValues([
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
  architectureClear(workflowOpsLibraryListEl);
  if (!workflowOpsLibraryListEl) return;
  const compilations = workflowOpsFilteredCompilations();
  if (!compilations.length) {
    workflowOpsLibraryListEl.appendChild(architectureEmpty('No compiled workflows'));
    return;
  }
  for (const compilation of compilations) {
    const definition = compilation.definition || {};
    const item = architectureItemButton({
      title: definition.name || compilation.workflowId || compilation.id,
      meta: [compilation.workflowVersion, definition.riskLevel, architectureDate(compilation.updatedAt || compilation.createdAt)].filter(Boolean).join(' | '),
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
  architectureClear(workflowOpsLibraryDetailEl);
  if (!workflowOpsLibraryDetailEl) return;
  const compilation = architectureWorkflowState.selectedCompilation;
  if (!compilation) {
    workflowOpsLibraryDetailEl.appendChild(architectureEmpty('Select a compiled workflow'));
    return;
  }
  const definition = compilation.definition || {};
  workflowOpsLibraryDetailEl.append(
    architectureHeading(3, definition.name || compilation.workflowId || compilation.id),
    architectureKeyValues([
      ['Compilation', compilation.id],
      ['Status', compilation.status],
      ['Published workflow', compilation.workflowId],
      ['Version', compilation.workflowVersion],
      ['Risk', definition.riskLevel],
      ['Compiler', compilation.compilerVersion],
      ['Created', architectureDate(compilation.createdAt)],
      ['Updated', architectureDate(compilation.updatedAt)],
    ]),
    architectureHeading(4, 'Purpose'),
    architectureMuted(definition.description || 'No purpose recorded'),
    architectureHeading(4, 'Evidence and permissions'),
    architectureKeyValues([
      ['Sources', compilation.sourceIds || definition.allowedSourceIds],
      ['Tools', compilation.toolNames || definition.allowedTools],
      ['Approval gates', (definition.approvalGates || []).map(gate => [gate.id, gate.type].filter(Boolean).join(': '))],
      ['Success metrics', definition.successMetrics],
    ])
  );
  const validation = Array.isArray(compilation.validation) ? compilation.validation : [];
  const warnings = Array.isArray(compilation.warnings) ? compilation.warnings : [];
  workflowOpsLibraryDetailEl.appendChild(architectureHeading(4, 'Release checks'));
  workflowOpsLibraryDetailEl.appendChild(architectureInlineBadges([
    validation.length ? `${validation.length} validation error(s)` : 'validated',
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
  architectureStatus(architectureWorkflowStatusEl, 'Compiling governed workflow...');
  try {
    const result = await callTool('workflow_action', {
      action: 'compile',
      workspaceId: activeWorkspaceId(),
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
    architectureStatus(architectureWorkflowStatusEl, result?.published ? 'Workflow compiled, published, and smoke-tested.' : 'Workflow draft compiled.');
  } catch (err) {
    architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
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
  architectureStatus(architectureWorkflowStatusEl, `Starting ${mode.replaceAll('_', ' ')}...`);
  try {
    const run = await callTool('workflow_action', {
      action: mode === 'dry_run' ? 'dry_run' : 'start',
      workspaceId: activeWorkspaceId(),
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
    architectureStatus(architectureWorkflowStatusEl, `${mode.replaceAll('_', ' ')} started.`);
  } catch (err) {
    architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
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
  architectureClear(workflowOpsRunListEl);
  if (!workflowOpsRunListEl) return;
  const runs = workflowOpsFilteredRuns();
  if (!runs.length) {
    workflowOpsRunListEl.appendChild(architectureEmpty('No matching workflow runs'));
    return;
  }
  for (const run of runs) {
    const item = architectureItemButton({
      title: run.workflowId,
      meta: [run.id, run.mode, architectureDate(run.updatedAt || run.createdAt)].filter(Boolean).join(' | '),
      badge: run.status,
      active: architectureWorkflowState.selectedRun?.id === run.id,
      onClick: () => selectWorkflowOpsRun(run.id),
    });
    item.dataset.runId = run.id;
    item.dataset.workflowId = run.workflowId;
    workflowOpsRunListEl.appendChild(item);
  }
}

function workflowOpsActionCards(actions, emptyText) {
  const wrap = document.createElement('div');
  if (!actions.length) {
    wrap.appendChild(architectureEmpty(emptyText));
    return wrap;
  }
  wrap.className = 'architecture-card-grid';
  for (const action of actions) {
    wrap.appendChild(architectureCard(action.toolName || action.id, [
      action.id,
      action.reason,
      `Sources: ${architectureString(action.sourceIds)}`,
    ].filter(Boolean), action.status));
  }
  return wrap;
}

function renderWorkflowOpsRunDetail() {
  architectureClear(workflowOpsRunDetailEl);
  if (!workflowOpsRunDetailEl) return;
  const run = architectureWorkflowState.selectedRun;
  if (!run) {
    workflowOpsRunDetailEl.appendChild(architectureEmpty('Select a workflow run'));
    return;
  }
  const inspected = architectureWorkflowState.inspected?.run?.id === run.id ? architectureWorkflowState.inspected : null;
  const current = inspected?.run || run;
  workflowOpsRunDetailEl.append(
    architectureHeading(3, current.id),
    architectureKeyValues([
      ['Workflow', current.workflowId],
      ['Version', current.workflowVersion],
      ['Mode', current.mode],
      ['Status', current.status],
      ['Principal', current.principalId],
      ['Created', architectureDate(current.createdAt)],
      ['Updated', architectureDate(current.updatedAt)],
      ['Error', current.error],
    ]),
    architectureHeading(4, 'Typed inputs'),
    architectureJsonBlock(current.inputs || {}),
    architectureHeading(4, 'Evidence'),
    architectureKeyValues([
      ['Source IDs', current.evidenceSourceIds],
      ['Source versions', (current.evidenceSourceVersions || []).map(reference => reference.sourceVersionId || reference.sourceId)],
    ]),
    architectureHeading(4, 'Proposed Actions'),
    workflowOpsActionCards(current.proposedActions || [], 'No proposed actions'),
    architectureHeading(4, 'Executed Actions'),
    workflowOpsActionCards(current.executedActions || [], 'No actions executed')
  );
  const approvals = Array.isArray(inspected?.approvals) ? inspected.approvals : [];
  workflowOpsRunDetailEl.appendChild(architectureHeading(4, 'Approvals'));
  if (approvals.length) workflowOpsRunDetailEl.appendChild(architectureTable(approvals, ['gateId', 'status', 'reason', 'decidedAt']));
  else workflowOpsRunDetailEl.appendChild(architectureEmpty('No approval gates'));
  const events = Array.isArray(inspected?.events) ? inspected.events : [];
  workflowOpsRunDetailEl.appendChild(architectureHeading(4, 'Run Ledger'));
  if (events.length) workflowOpsRunDetailEl.appendChild(architectureTable(events, ['sequence', 'eventType', 'timestamp', 'principalId']));
  else workflowOpsRunDetailEl.appendChild(architectureEmpty('Loading run events...'));
}

async function selectWorkflowOpsRun(runId) {
  const run = architectureWorkflowState.runs.find(item => item.id === runId);
  if (!run) return;
  architectureWorkflowState.selectedRun = run;
  architectureWorkflowState.inspected = null;
  renderWorkflowOpsRunList();
  renderWorkflowOpsRunDetail();
  architectureStatus(architectureWorkflowStatusEl, 'Loading run ledger...');
  try {
    const inspected = await callTool('workflow_action', { action: 'inspect_run', runId });
    if (architectureWorkflowState.selectedRun?.id !== runId) return;
    architectureWorkflowState.inspected = inspected;
    if (inspected?.run) {
      architectureWorkflowState.selectedRun = inspected.run;
      const index = architectureWorkflowState.runs.findIndex(item => item.id === runId);
      if (index >= 0) architectureWorkflowState.runs[index] = inspected.run;
    }
    renderWorkflowOpsRunList();
    renderWorkflowOpsRunDetail();
    architectureStatus(architectureWorkflowStatusEl, `${architectureWorkflowState.runs.length} run(s)`);
  } catch (err) {
    if (architectureWorkflowState.selectedRun?.id === runId) architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
  }
}

function workflowOpsComparisonForRun(runId) {
  return architectureWorkflowState.comparisons.find(comparison => comparison.runId === runId) || null;
}

function workflowOpsShadowRuns() {
  return workflowOpsSortedRuns().filter(run => run.mode === 'shadow');
}

function renderWorkflowOpsShadowList() {
  architectureClear(workflowOpsShadowListEl);
  if (!workflowOpsShadowListEl) return;
  const runs = workflowOpsShadowRuns();
  if (!runs.length) {
    workflowOpsShadowListEl.appendChild(architectureEmpty('No shadow runs'));
    return;
  }
  for (const run of runs) {
    const comparison = workflowOpsComparisonForRun(run.id);
    const item = architectureItemButton({
      title: run.workflowId,
      meta: `${run.id} | ${architectureDate(run.updatedAt || run.createdAt)}`,
      badge: comparison?.outcome || 'unlabeled',
      active: architectureWorkflowState.selectedShadowRun?.id === run.id,
      onClick: () => selectWorkflowOpsShadowRun(run.id),
    });
    item.dataset.runId = run.id;
    workflowOpsShadowListEl.appendChild(item);
  }
}

function renderWorkflowOpsShadowDetail() {
  architectureClear(workflowOpsShadowDetailEl);
  if (!workflowOpsShadowDetailEl) return;
  const run = architectureWorkflowState.selectedShadowRun;
  if (!run) {
    workflowOpsShadowDetailEl.appendChild(architectureEmpty('Select a shadow run'));
    return;
  }
  const comparison = workflowOpsComparisonForRun(run.id);
  workflowOpsShadowDetailEl.append(
    architectureHeading(3, run.id),
    architectureKeyValues([
      ['Workflow', run.workflowId],
      ['Version', run.workflowVersion],
      ['Run status', run.status],
      ['Outcome', comparison?.outcome || 'unlabeled'],
      ['Score', comparison?.score],
      ['Recommendation hash', comparison?.recommendationHash],
      ['Human labels', comparison?.humanLabels || comparison?.labels],
      ['Evidence', comparison?.sourceIds || run.evidenceSourceIds],
    ]),
    architectureHeading(4, 'Proposed recommendation'),
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
  architectureStatus(architectureWorkflowStatusEl, `Recording ${label} shadow outcome...`);
  try {
    await callTool('workflow_action', {
      action: 'compare_shadow_result',
      runId,
      labels: [label],
      note: 'Labeled in Workflow Operations Center.',
    });
    await loadArchitectureWorkflowApprovals(true);
    selectWorkflowOpsShadowRun(runId);
    activateWorkflowOpsView('shadow');
    architectureStatus(architectureWorkflowStatusEl, `Shadow outcome recorded as ${label}.`);
  } catch (err) {
    architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
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
  architectureClear(architectureApprovalListEl);
  if (!architectureApprovalListEl) return;
  const approvals = architectureWorkflowState.approvals;
  if (!approvals.length) {
    architectureApprovalListEl.appendChild(architectureEmpty('No approvals'));
    return;
  }
  for (const approval of approvals) {
    const item = architectureItemButton({
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

function renderArchitectureApprovalDetail() {
  architectureClear(architectureApprovalDetailEl);
  if (!architectureApprovalDetailEl) return;
  const approval = architectureWorkflowState.selected;
  if (!approval) {
    architectureApprovalDetailEl.appendChild(architectureEmpty('Select an approval'));
    return;
  }
  const inspected = architectureWorkflowState.inspected || {};
  const run = inspected.run || null;
  architectureApprovalDetailEl.append(
    architectureHeading(3, approval.gateId || approval.id),
    architectureKeyValues([
      ['Approval', approval.id],
      ['Status', approval.status],
      ['Run', approval.runId],
      ['Reason', approval.reason],
      ['Decided', architectureDate(approval.decidedAt)],
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
      architectureHeading(4, 'Run'),
      architectureKeyValues([
        ['Workflow', run.workflowId],
        ['Mode', run.mode],
        ['Status', run.status],
        ['Sources', run.evidenceSourceIds],
        ['Created', architectureDate(run.createdAt)],
        ['Updated', architectureDate(run.updatedAt)],
      ])
    );
  }
  const proposed = Array.isArray(run?.proposedActions) ? run.proposedActions : [];
  if (proposed.length) {
    architectureApprovalDetailEl.appendChild(architectureHeading(4, 'Proposed Actions'));
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const action of proposed) {
      grid.appendChild(architectureCard(action.toolName || action.id, [action.id, `Sources: ${architectureString(action.sourceIds)}`], action.status));
    }
    architectureApprovalDetailEl.appendChild(grid);
  }
  const events = Array.isArray(inspected.events) ? inspected.events : [];
  if (events.length) {
    architectureApprovalDetailEl.appendChild(architectureHeading(4, 'Ledger'));
    architectureApprovalDetailEl.appendChild(architectureTable(events, ['sequence', 'eventType', 'timestamp']));
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
  architectureStatus(architectureWorkflowStatusEl, 'Loading run...');
  try {
    const inspected = await callTool('workflow_action', { action: 'inspect_run', runId: approval.runId });
    if (architectureWorkflowState.selected?.id !== approval.id || architectureWorkflowState.selected?.runId !== approval.runId) return;
    architectureWorkflowState.inspected = inspected;
    renderArchitectureApprovalDetail();
    architectureStatus(architectureWorkflowStatusEl, `${architectureWorkflowState.approvals.length} approval(s)`);
  } catch (err) {
    architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
  }
}

async function loadArchitectureWorkflowApprovals() {
  const requestId = ++architectureWorkflowLoadRequest;
  if (architectureWorkflowRefreshBtn) architectureWorkflowRefreshBtn.disabled = true;
  architectureStatus(architectureWorkflowStatusEl, 'Loading workflow operations...');
  try {
    const query = workflowOpsWorkspaceQuery();
    const results = await Promise.allSettled([
      callTool('workflow_action', { action: 'compilations', query }),
      callTool('workflow_action', { action: 'list_runs', query }),
      callTool('workflow_action', { action: 'list_approvals' }),
      callTool('workflow_action', { action: 'shadow_report', query }),
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
    architectureStatus(
      architectureWorkflowStatusEl,
      failures.length
        ? `Loaded with ${failures.length} unavailable workflow service(s). Refresh to retry.`
        : `${architectureWorkflowState.compilations.length} workflow(s), ${architectureWorkflowState.runs.length} run(s), ${architectureWorkflowState.approvals.filter(approval => approval.status === 'pending').length} pending approval(s).`,
      failures.length > 0
    );
  } catch (err) {
    if (requestId !== architectureWorkflowLoadRequest) return;
    architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
    architectureWorkflowState.loaded = true;
  } finally {
    if (requestId === architectureWorkflowLoadRequest && architectureWorkflowRefreshBtn) architectureWorkflowRefreshBtn.disabled = false;
  }
}

async function decideArchitectureApproval(action, approval) {
  if (!approval?.runId || architectureWorkflowDecision) return;
  architectureWorkflowDecision = `${approval.runId}:${approval.id}`;
  architectureStatus(architectureWorkflowStatusEl, action === 'approve' ? 'Approving...' : 'Rejecting...');
  renderArchitectureApprovalDetail();
  try {
    await callTool('workflow_action', {
      action,
      runId: approval.runId,
      approvalId: approval.id,
      reason: action === 'approve' ? 'Approved in architecture UI.' : 'Rejected in architecture UI.',
    });
    await loadArchitectureWorkflowApprovals();
  } catch (err) {
    architectureStatus(architectureWorkflowStatusEl, String(err?.message || err), true);
  } finally {
    architectureWorkflowDecision = '';
    renderArchitectureApprovalDetail();
  }
}

function architectureGraphEntities() {
  const byId = new Map();
  for (const entity of architectureGraphState.entities) {
    if (entity?.id) byId.set(entity.id, entity);
  }
  const retrieve = architectureGraphState.retrieve || {};
  for (const entity of Array.isArray(retrieve.entities) ? retrieve.entities : []) {
    if (entity?.id) byId.set(entity.id, entity);
  }
  for (const fact of Array.isArray(retrieve.facts) ? retrieve.facts : []) {
    if (fact?.subject?.id) byId.set(fact.subject.id, fact.subject);
    if (fact?.object?.id) byId.set(fact.object.id, fact.object);
  }
  return [...byId.values()];
}

function architectureGraphRelationships() {
  const relationships = [...architectureGraphState.relationships];
  const facts = Array.isArray(architectureGraphState.retrieve?.facts) ? architectureGraphState.retrieve.facts : [];
  for (const fact of facts) {
    if (fact?.relationship) relationships.push(fact.relationship);
  }
  return relationships;
}

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
  architectureClear(evaluationTraceListEl);
  if (!evaluationTraceListEl) return;
  const traces = evaluationSortedTraces();
  if (!traces.length) {
    evaluationTraceListEl.appendChild(architectureEmpty('No traces recorded yet'));
    return;
  }
  for (const trace of traces.slice(0, 50)) {
    const item = architectureItemButton({
      title: trace.traceId,
      meta: `${architectureDate(trace.updatedAt)} · ${evaluationDuration(trace.durationMs)} · ${evaluationMoney(trace.costUsd)}`,
      badge: trace.status,
      active: architectureEvaluationState.selectedTrace?.traceId === trace.traceId,
      onClick: () => selectArchitectureEvaluationTrace(trace.traceId),
    });
    item.dataset.traceId = trace.traceId;
    evaluationTraceListEl.appendChild(item);
  }
}

function renderArchitectureEvaluationTraceDetail() {
  architectureClear(evaluationTraceDetailEl);
  if (!evaluationTraceDetailEl) return;
  const trace = architectureEvaluationState.selectedTrace;
  if (!trace) {
    evaluationTraceDetailEl.appendChild(architectureEmpty('Select a trace to inspect spans and replay safely'));
    return;
  }
  evaluationTraceDetailEl.appendChild(architectureHeading(3, trace.traceId));
  evaluationTraceDetailEl.appendChild(architectureInlineBadges([trace.status, ...(trace.workflowRunIds || [])]));
  evaluationTraceDetailEl.appendChild(architectureKeyValues([
    ['Root trace', trace.rootTraceId],
    ['Session', trace.sessionId],
    ['Duration', evaluationDuration(trace.durationMs)],
    ['Tokens', `${Number(trace.inputTokens || 0).toLocaleString()} in / ${Number(trace.outputTokens || 0).toLocaleString()} out`],
    ['Cost', evaluationMoney(trace.costUsd)],
    ['Started', architectureDate(trace.startedAt)],
  ]));
  const replay = document.createElement('button');
  replay.type = 'button';
  replay.textContent = 'Replay trace safely';
  replay.onclick = () => replayArchitectureEvaluationTrace(trace.traceId);
  evaluationTraceDetailEl.appendChild(replay);
  const spans = Array.isArray(architectureEvaluationState.traceDetail?.spans) ? architectureEvaluationState.traceDetail.spans : [];
  if (spans.length) {
    evaluationTraceDetailEl.appendChild(architectureHeading(4, 'Span waterfall'));
    evaluationTraceDetailEl.appendChild(architectureTable(spans.map(span => ({
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
    const detail = await callTool('evaluation_action', { action: 'inspect_trace', traceId });
    if (architectureEvaluationState.selectedTrace?.traceId !== traceId) return;
    architectureEvaluationState.traceDetail = detail;
    renderArchitectureEvaluationTraceDetail();
  } catch (err) {
    if (architectureEvaluationState.selectedTrace?.traceId !== traceId) return;
    architectureStatus(architectureEvaluationStatusEl, String(err?.message || err), true);
  }
}

async function replayArchitectureEvaluationTrace(traceId) {
  architectureStatus(architectureEvaluationStatusEl, 'Replaying recorded trace without side effects…');
  try {
    const replay = await callTool('evaluation_action', { action: 'replay', traceId });
    architectureStatus(architectureEvaluationStatusEl, `Playback ready: ${replay.timeline?.length || 0} event(s), writes executed: ${replay.writesExecuted ? 'yes' : 'no'}`);
  } catch (err) {
    architectureStatus(architectureEvaluationStatusEl, String(err?.message || err), true);
  }
}

function renderArchitectureEvaluationSuiteList() {
  architectureClear(evaluationSuiteListEl);
  if (!evaluationSuiteListEl) return;
  if (!architectureEvaluationState.suites.length) {
    evaluationSuiteListEl.appendChild(architectureEmpty('No regression suites'));
    return;
  }
  for (const suite of architectureEvaluationState.suites) {
    const latest = architectureEvaluationState.runs.filter(run => run.suiteId === suite.id).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0];
    const item = architectureItemButton({
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
  architectureClear(evaluationSuiteDetailEl);
  if (!evaluationSuiteDetailEl) return;
  const suite = architectureEvaluationState.selectedSuite;
  if (!suite) {
    evaluationSuiteDetailEl.appendChild(architectureEmpty('Select a regression suite'));
    return;
  }
  const runs = architectureEvaluationState.runs.filter(run => run.suiteId === suite.id).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  evaluationSuiteDetailEl.appendChild(architectureHeading(3, suite.name));
  if (suite.description) evaluationSuiteDetailEl.appendChild(architectureMuted(suite.description));
  evaluationSuiteDetailEl.appendChild(architectureKeyValues([
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
    evaluationSuiteDetailEl.appendChild(architectureHeading(4, 'Recent runs'));
    evaluationSuiteDetailEl.appendChild(architectureTable(runs.slice(0, 10).map(run => ({
      Candidate: run.candidate,
      Status: run.status,
      Score: evaluationPercent(run.score),
      Pass: run.passed ? 'yes' : 'no',
    })), ['Candidate', 'Status', 'Score', 'Pass']));
  }
}

async function runArchitectureEvaluationSuite(suiteId, button) {
  if (button) button.disabled = true;
  architectureStatus(architectureEvaluationStatusEl, 'Running regression suite…');
  try {
    const result = await callTool('evaluation_action', { action: 'run_suite', suiteId, candidate: 'webui', ...(providerSel.value ? { provider: providerSel.value } : {}) });
    await loadArchitectureEvaluation(true);
    architectureStatus(architectureEvaluationStatusEl, `Evaluation ${result.run.passed ? 'passed' : 'failed'} at ${evaluationPercent(result.run.score)}.` , !result.run.passed);
  } catch (err) {
    architectureStatus(architectureEvaluationStatusEl, String(err?.message || err), true);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderArchitectureEvaluationRoi() {
  architectureClear(evaluationRoiDetailEl);
  if (!evaluationRoiDetailEl) return;
  const roi = architectureEvaluationState.roi;
  const metrics = architectureEvaluationState.metrics;
  if (!roi) {
    evaluationRoiDetailEl.appendChild(architectureEmpty('No ROI evidence available'));
    return;
  }
  evaluationRoiDetailEl.appendChild(architectureKeyValues([
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
    evaluationRoiDetailEl.appendChild(architectureHeading(4, 'Benefit by workflow'));
    evaluationRoiDetailEl.appendChild(architectureTable(roi.byWorkflow.map(item => ({
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
  architectureStatus(architectureEvaluationStatusEl, 'Loading traces, evaluations, and sponsor evidence…');
  const workspaceId = activeWorkspaceId();
  const query = { where: { op: 'eq', field: 'workspaceId', value: workspaceId } };
  const [traceResult, suiteResult, runResult, metricsResult, roiResult] = await Promise.allSettled([
    callTool('evaluation_action', { action: 'traces', query }),
    callTool('evaluation_action', { action: 'suites', query }),
    callTool('evaluation_action', { action: 'evaluation_runs', query }),
    callTool('evaluation_action', { action: 'metrics', workspaceId }),
    callTool('evaluation_action', { action: 'roi', workspaceId }),
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
  architectureStatus(architectureEvaluationStatusEl, failures ? `Loaded with ${failures} unavailable service(s).` : `${architectureEvaluationState.traces.length} trace(s), ${architectureEvaluationState.suites.length} suite(s).`, failures > 0);
  if (architectureEvaluationState.selectedTrace) await selectArchitectureEvaluationTrace(architectureEvaluationState.selectedTrace.traceId);
}

function renderArchitectureGraphList() {
  architectureClear(architectureGraphListEl);
  if (!architectureGraphListEl) return;
  const entities = architectureGraphEntities();
  if (!entities.length) {
    architectureGraphListEl.appendChild(architectureEmpty('No entities'));
    return;
  }
  for (const entity of entities) {
    architectureGraphListEl.appendChild(architectureItemButton({
      title: entity.canonicalName || entity.id,
      meta: [entity.id, Array.isArray(entity.aliases) ? entity.aliases.join(', ') : ''].filter(Boolean).join(' | '),
      badge: entity.type,
      active: architectureGraphState.selected?.id === entity.id,
      onClick: () => selectArchitectureGraphEntity(entity.id),
    }));
  }
}

function renderArchitectureGraphDetail() {
  architectureClear(architectureGraphDetailEl);
  if (!architectureGraphDetailEl) return;
  const entity = architectureGraphState.selected;
  if (!entity) {
    architectureGraphDetailEl.appendChild(architectureEmpty('Select an entity'));
    return;
  }
  architectureGraphDetailEl.append(
    architectureHeading(3, entity.canonicalName || entity.id),
    architectureKeyValues([
      ['ID', entity.id],
      ['Type', entity.type],
      ['Aliases', entity.aliases],
      ['Sensitivity', entity.sensitivity],
      ['Updated', architectureDate(entity.updatedAt)],
    ])
  );

  const relationships = architectureGraphRelationships().filter(rel =>
    rel.subjectEntityId === entity.id || rel.objectEntityId === entity.id
  );
  architectureGraphDetailEl.appendChild(architectureHeading(4, 'Relationships'));
  if (relationships.length) {
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const rel of relationships) {
      grid.appendChild(architectureCard(rel.predicate || rel.id, [
        `${rel.subjectEntityId} -> ${rel.objectEntityId}`,
        `Source: ${architectureString(rel.sourceId)}`,
        rel.evidenceSpan,
      ], rel.confidence !== undefined ? `confidence ${rel.confidence}` : rel.extractionMethod));
    }
    architectureGraphDetailEl.appendChild(grid);
  } else {
    architectureGraphDetailEl.appendChild(architectureEmpty('No relationships'));
  }

  const facts = Array.isArray(architectureGraphState.retrieve?.facts) ? architectureGraphState.retrieve.facts : [];
  const entityFacts = facts.filter(fact => fact?.subject?.id === entity.id || fact?.object?.id === entity.id);
  if (entityFacts.length) {
    architectureGraphDetailEl.appendChild(architectureHeading(4, 'Evidence'));
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const fact of entityFacts) {
      grid.appendChild(architectureCard(fact.relationship?.predicate || fact.sourceId, [
        `${architectureString(fact.subject?.canonicalName || fact.subject?.id)} -> ${architectureString(fact.object?.canonicalName || fact.object?.id)}`,
        fact.citation?.text,
        `Version: ${architectureString(fact.sourceVersionId)}`,
      ], fact.sourceId));
    }
    architectureGraphDetailEl.appendChild(grid);
  }
}

function selectArchitectureGraphEntity(entityId) {
  const entity = architectureGraphEntities().find(item => item.id === entityId);
  if (!entity) return;
  architectureGraphState.selected = entity;
  renderArchitectureGraphList();
  renderArchitectureGraphDetail();
}

async function loadArchitectureGraph(resetRetrieve = false) {
  if (architectureGraphRefreshBtn) architectureGraphRefreshBtn.disabled = true;
  if (architectureGraphRetrieveBtn) architectureGraphRetrieveBtn.disabled = true;
  architectureStatus(architectureGraphStatusEl, 'Loading graph...');
  try {
    const result = await callTool('context_graph_action', {
      action: 'list',
      query: { where: { op: 'eq', field: 'workspaceId', value: activeWorkspaceId() } },
    });
    architectureGraphState.entities = Array.isArray(result?.entities) ? result.entities : [];
    architectureGraphState.relationships = Array.isArray(result?.relationships) ? result.relationships : [];
    if (resetRetrieve) architectureGraphState.retrieve = null;
    architectureGraphState.loaded = true;
    const previousId = architectureGraphState.selected?.id;
    const next = architectureGraphEntities().find(entity => entity.id === previousId) || architectureGraphEntities()[0] || null;
    architectureGraphState.selected = next;
    renderArchitectureGraphList();
    renderArchitectureGraphDetail();
    architectureStatus(architectureGraphStatusEl, `${architectureGraphState.entities.length} entity record(s)`);
  } catch (err) {
    architectureStatus(architectureGraphStatusEl, String(err?.message || err), true);
    architectureGraphState.loaded = true;
  } finally {
    if (architectureGraphRefreshBtn) architectureGraphRefreshBtn.disabled = false;
    if (architectureGraphRetrieveBtn) architectureGraphRetrieveBtn.disabled = false;
  }
}

function firstRetrievedArchitectureGraphEntity(retrieve) {
  const direct = Array.isArray(retrieve?.entities) ? retrieve.entities.find(entity => entity?.id) : null;
  if (direct) return direct;
  const facts = Array.isArray(retrieve?.facts) ? retrieve.facts : [];
  for (const fact of facts) {
    if (fact?.subject?.id) return fact.subject;
    if (fact?.object?.id) return fact.object;
  }
  return null;
}

async function retrieveArchitectureGraph(event) {
  event?.preventDefault();
  if (architectureGraphRetrieveBtn?.disabled) return;
  const requestId = ++architectureGraphRetrieveRequest;
  if (architectureGraphRetrieveBtn) architectureGraphRetrieveBtn.disabled = true;
  if (architectureGraphRefreshBtn) architectureGraphRefreshBtn.disabled = true;
  architectureStatus(architectureGraphStatusEl, 'Retrieving graph context...');
  const terms = (architectureGraphSearchEl?.value || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const sourceIds = (architectureGraphSourceEl?.value || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  try {
    const retrieve = await callTool('context_graph_action', {
      action: 'retrieve',
      workspaceId: activeWorkspaceId(),
      terms,
      ...(sourceIds.length ? { sourceIds } : {}),
      maxRelationships: 25,
    });
    if (requestId !== architectureGraphRetrieveRequest) return;
    architectureGraphState.retrieve = retrieve;
    architectureGraphState.selected = firstRetrievedArchitectureGraphEntity(retrieve) || architectureGraphEntities()[0] || null;
    renderArchitectureGraphList();
    renderArchitectureGraphDetail();
    const factCount = Array.isArray(architectureGraphState.retrieve?.facts) ? architectureGraphState.retrieve.facts.length : 0;
    architectureStatus(architectureGraphStatusEl, `Retrieved ${factCount} fact(s).`);
  } catch (err) {
    if (requestId !== architectureGraphRetrieveRequest) return;
    architectureStatus(architectureGraphStatusEl, String(err?.message || err), true);
  } finally {
    if (requestId === architectureGraphRetrieveRequest) {
      if (architectureGraphRetrieveBtn) architectureGraphRetrieveBtn.disabled = false;
      if (architectureGraphRefreshBtn) architectureGraphRefreshBtn.disabled = false;
    }
  }
}

function renderArchitectureReviewList() {
  architectureClear(architectureReviewListEl);
  if (!architectureReviewListEl) return;
  const reviews = architectureReviewState.reviews;
  if (!reviews.length) {
    architectureReviewListEl.appendChild(architectureEmpty('No reviews'));
    return;
  }
  for (const review of reviews) {
    architectureReviewListEl.appendChild(architectureItemButton({
      title: review.question || review.id,
      meta: [review.targetType, review.targetId, review.workflowRunId].filter(Boolean).join(' | '),
      badge: review.status,
      active: architectureReviewState.selected?.id === review.id,
      onClick: () => selectArchitectureReview(review.id),
    }));
  }
}

function renderArchitectureReviewDetail() {
  architectureClear(architectureReviewDetailEl);
  if (!architectureReviewDetailEl) return;
  const review = architectureReviewState.selected;
  if (!review) {
    architectureReviewDetailEl.appendChild(architectureEmpty('Select a review'));
    return;
  }
  architectureReviewDetailEl.append(
    architectureHeading(3, review.question || review.id),
    architectureKeyValues([
      ['Review', review.id],
      ['Status', review.status],
      ['Mode', review.reviewMode || review.mode],
      ['Target', [review.targetType, review.targetId].filter(Boolean).join(': ')],
      ['Workflow', review.workflowId],
      ['Run', review.workflowRunId],
      ['Sources', review.sourceIds],
      ['Created', architectureDate(review.createdAt)],
    ])
  );
  if (review.synthesis) {
    architectureReviewDetailEl.append(architectureHeading(4, 'Synthesis'), architectureMuted(review.synthesis));
  }
  const experts = Array.isArray(review.experts) ? review.experts : [];
  architectureReviewDetailEl.appendChild(architectureHeading(4, 'Expert Cards'));
  if (experts.length) {
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const expert of experts) {
      grid.appendChild(architectureCard(expert.title || expert.expertId, [
        expert.answer,
        `Risks: ${architectureString(expert.risks)}`,
        `Mitigations: ${architectureString(expert.mitigations)}`,
        `Checklist: ${architectureString(expert.approvalChecklist)}`,
      ], expert.recommendation || expert.confidence));
    }
    architectureReviewDetailEl.appendChild(grid);
  } else {
    architectureReviewDetailEl.appendChild(architectureEmpty('No expert cards'));
  }
  const risks = Array.isArray(review.riskRegister) ? review.riskRegister : [];
  if (risks.length) {
    architectureReviewDetailEl.append(architectureHeading(4, 'Risk Register'), architectureTable(risks, ['severity', 'description', 'ownerExpertId', 'mitigation']));
  }
}

async function selectArchitectureReview(reviewId) {
  const review = architectureReviewState.reviews.find(item => item.id === reviewId);
  if (!review) return;
  architectureReviewState.selected = review;
  renderArchitectureReviewList();
  renderArchitectureReviewDetail();
  architectureStatus(architectureReviewStatusEl, 'Loading review...');
  try {
    const result = await callTool('expert_panel', { action: 'get_review', reviewId });
    if (architectureReviewState.selected?.id !== review.id) return;
    if (result?.review) {
      architectureReviewState.selected = result.review;
      const idx = architectureReviewState.reviews.findIndex(item => item.id === result.review.id);
      if (idx >= 0) architectureReviewState.reviews[idx] = result.review;
    }
    renderArchitectureReviewList();
    renderArchitectureReviewDetail();
    architectureStatus(architectureReviewStatusEl, `${architectureReviewState.reviews.length} review(s)`);
  } catch (err) {
    architectureStatus(architectureReviewStatusEl, String(err?.message || err), true);
  }
}

async function loadArchitectureReviews() {
  if (architectureReviewRefreshBtn) architectureReviewRefreshBtn.disabled = true;
  architectureStatus(architectureReviewStatusEl, 'Loading reviews...');
  try {
    const result = await callTool('expert_panel', { action: 'list_reviews' });
    architectureReviewState.reviews = Array.isArray(result?.reviews) ? result.reviews : [];
    architectureReviewState.loaded = true;
    const previousId = architectureReviewState.selected?.id;
    const next = architectureReviewState.reviews.find(review => review.id === previousId) || architectureReviewState.reviews[0] || null;
    architectureReviewState.selected = next;
    renderArchitectureReviewList();
    renderArchitectureReviewDetail();
    if (next) await selectArchitectureReview(next.id);
    else architectureStatus(architectureReviewStatusEl, 'No reviews');
  } catch (err) {
    architectureStatus(architectureReviewStatusEl, String(err?.message || err), true);
    architectureReviewState.loaded = true;
  } finally {
    if (architectureReviewRefreshBtn) architectureReviewRefreshBtn.disabled = false;
  }
}

async function createArchitectureReview(event) {
  event?.preventDefault();
  const question = architectureReviewQuestionEl?.value.trim() || '';
  if (!question) {
    architectureStatus(architectureReviewStatusEl, 'Question is required.', true);
    return;
  }
  const experts = (architectureReviewExpertsEl?.value || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const targetId = architectureReviewTargetIdEl?.value.trim() || undefined;
  const workflowId = architectureReviewWorkflowIdEl?.value.trim() || undefined;
  const workflowRunId = architectureReviewRunIdEl?.value.trim() || undefined;
  architectureStatus(architectureReviewStatusEl, 'Creating review...');
  if (architectureReviewCreateBtn) architectureReviewCreateBtn.disabled = true;
  try {
    const result = await callTool('expert_panel', {
      action: 'review',
      question,
      mode: 'review',
      reviewMode: 'pre_automation_review',
      targetType: architectureReviewTargetTypeEl?.value || 'workflow',
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
    architectureStatus(architectureReviewStatusEl, 'Review created.');
  } catch (err) {
    architectureStatus(architectureReviewStatusEl, String(err?.message || err), true);
  } finally {
    if (architectureReviewCreateBtn) architectureReviewCreateBtn.disabled = false;
  }
}

if (architectureScreenEl) {
  for (const btn of architectureNavBtns) {
    btn.addEventListener('click', () => setArchitectureOpen(true, btn.dataset.architectureView || 'sources'));
  }
  for (const btn of architectureTabBtns) {
    btn.addEventListener('click', () => setArchitectureOpen(true, btn.dataset.architectureTab || 'sources'));
    btn.addEventListener('keydown', event => {
      const current = architectureTabBtns.indexOf(btn);
      let next = current;
      if (event.key === 'ArrowRight') next = (current + 1) % architectureTabBtns.length;
      else if (event.key === 'ArrowLeft') next = (current - 1 + architectureTabBtns.length) % architectureTabBtns.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = architectureTabBtns.length - 1;
      else return;
      event.preventDefault();
      architectureTabBtns[next].focus();
      architectureTabBtns[next].click();
    });
  }
  for (const btn of workflowOpsTabBtns) {
    btn.addEventListener('click', () => activateWorkflowOpsView(btn.dataset.workflowOpsView || 'overview'));
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
    });
  }
  architectureSourceRefreshBtn?.addEventListener('click', () => loadArchitecturePanel('sources', true));
  architectureSqlForm?.addEventListener('submit', planArchitectureSql);
  architectureSqlApproveBtn?.addEventListener('click', approveArchitectureSql);
  architectureSqlExecuteBtn?.addEventListener('click', executeArchitectureSql);
  architectureWorkflowRefreshBtn?.addEventListener('click', () => loadArchitecturePanel('workflows', true));
  architectureEvaluationRefreshBtn?.addEventListener('click', () => loadArchitecturePanel('evaluation', true));
  workflowOpsCompileForm?.addEventListener('submit', compileWorkflowOperation);
  workflowOpsLibrarySearchEl?.addEventListener('input', renderWorkflowOpsLibraryList);
  workflowOpsRunSearchEl?.addEventListener('input', renderWorkflowOpsRunList);
  workflowOpsRunStatusEl?.addEventListener('change', renderWorkflowOpsRunList);
  architectureGraphRefreshBtn?.addEventListener('click', () => loadArchitecturePanel('graph', true));
  architectureGraphForm?.addEventListener('submit', retrieveArchitectureGraph);
  architectureReviewRefreshBtn?.addEventListener('click', () => loadArchitecturePanel('reviews', true));
  architectureReviewForm?.addEventListener('submit', createArchitectureReview);
}

// ── Cortex workspaces ───────────────────────────────────────────────────────

function setWorkspaceStatus(text, isError = false) {
  if (!workspaceStatusEl) return;
  workspaceStatusEl.textContent = text || '';
  workspaceStatusEl.classList.toggle('error', Boolean(isError));
}

function setWorkspaceSwitching(value) {
  workspaceSwitching = Boolean(value);
  if (workspaceToggleBtn) workspaceToggleBtn.disabled = workspaceSwitching;
  if (workspaceNewBtn) workspaceNewBtn.disabled = workspaceSwitching;
  if (workspaceRenameBtn) workspaceRenameBtn.disabled = workspaceSwitching;
  if (workspaceConfigBtn) workspaceConfigBtn.disabled = workspaceSwitching;
  renderWorkspaces();
}

function workspaceRestartSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function workspaceStateHasActiveId(state, id) {
  return state?.active === id || Boolean(state?.workspaces?.some(workspace => workspace.id === id && workspace.active));
}

function isWorkspaceFetchFailure(error) {
  const message = String(error?.message || error || '');
  return error instanceof TypeError || /failed to fetch|networkerror|fetch failed/i.test(message);
}

async function waitForWorkspaceRestart(workspaceId) {
  const startedAt = Date.now();
  let nextStatusAt = startedAt + WORKSPACE_RESTART_STATUS_INTERVAL_MS;
  let sawUnavailable = false;
  await workspaceRestartSleep(350);
  while (Date.now() - startedAt < WORKSPACE_RESTART_TIMEOUT_MS) {
    try {
      const nextState = await T.listWorkspaces();
      if (workspaceStateHasActiveId(nextState, workspaceId) && (sawUnavailable || Date.now() - startedAt >= 1200)) {
        workspaceState = nextState;
        renderWorkspaces();
        return;
      }
    } catch (_e) {
      sawUnavailable = true;
    }
    const now = Date.now();
    if (now >= nextStatusAt) {
      setWorkspaceStatus(`Restarting... ${Math.floor((now - startedAt) / 1000)}s`);
      nextStatusAt = now + WORKSPACE_RESTART_STATUS_INTERVAL_MS;
    }
    await workspaceRestartSleep(500);
  }
  throw new Error(`Timed out after ${Math.floor(WORKSPACE_RESTART_TIMEOUT_MS / 1000)} seconds waiting for workspace restart. Refresh once Cortex is back online.`);
}

function workspaceInitial(name) {
  const trimmed = String(name || 'Default').trim();
  return (trimmed[0] || 'C').toUpperCase();
}

function activeWorkspace() {
  return workspaceState.workspaces.find(w => w.active) ??
         workspaceState.workspaces.find(w => w.id === workspaceState.active) ??
         workspaceState.workspaces[0] ??
         { id: 'default', name: 'Default', active: true };
}

function activeWorkspaceId() {
  return activeWorkspace().id || workspaceState.active || 'default';
}

function setWorkspacePopoverOpen(open) {
  if (!workspacePopoverEl || !workspaceToggleBtn) return;
  if (workspaceSwitching && !open) return;
  workspacePopoverEl.classList.toggle('open', open);
  workspaceToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) setWorkspaceSettingsOpen(false);
}

function setWorkspaceSettingsOpen(open) {
  if (!workspaceSettingsScreenEl || !workspaceConfigBtn) return;
  if (workspaceSwitching && open) return;
  workspaceSettingsScreenEl.classList.toggle('open', open);
  document.body.classList.toggle('workspace-settings-open', open);
  workspaceConfigBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    setArchitectureOpen(false, architectureView, { skipWorkspace: true });
    setWorkspacePopoverOpen(false);
    closeSidebar();
    loadWorkspaceRagConfig();
    startWorkspaceRagPoll();
  } else {
    stopWorkspaceRagPoll();
  }
}

function confirmWorkspaceDelete(workspace) {
  if (!workspaceDeleteDialogEl || !workspaceDeleteMessageEl || !workspaceDeleteCancelBtn || !workspaceDeleteConfirmBtn) {
    return Promise.resolve(false);
  }
  workspaceDeleteMessageEl.textContent = `Delete "${workspace.name}" and its local workspace files?`;
  const restoreFocus = document.activeElement;
  workspaceDeleteDialogEl.classList.add('open');
  workspaceDeleteDialogEl.setAttribute('aria-hidden', 'false');
  workspaceDeleteConfirmBtn.focus();

  return new Promise(resolve => {
    const finish = (confirmed) => {
      workspaceDeleteDialogEl.classList.remove('open');
      workspaceDeleteDialogEl.setAttribute('aria-hidden', 'true');
      workspaceDeleteCancelBtn.removeEventListener('click', onCancel);
      workspaceDeleteConfirmBtn.removeEventListener('click', onConfirm);
      workspaceDeleteDialogEl.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeyDown);
      if (!confirmed && restoreFocus instanceof HTMLElement && restoreFocus.isConnected) restoreFocus.focus();
      resolve(confirmed);
    };
    const onCancel = (event) => { event.stopPropagation(); finish(false); };
    const onConfirm = (event) => { event.stopPropagation(); finish(true); };
    const onBackdrop = (event) => {
      event.stopPropagation();
      if (event.target === workspaceDeleteDialogEl) finish(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') finish(false);
    };
    workspaceDeleteCancelBtn.addEventListener('click', onCancel);
    workspaceDeleteConfirmBtn.addEventListener('click', onConfirm);
    workspaceDeleteDialogEl.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKeyDown);
  });
}

function workspaceDeleteErrorMessage(error) {
  const details = error?.details;
  if (details?.locked) {
    const suffix = details.state ? ` (${details.state})` : '';
    return `${details.reason || 'Workspace indexing is currently running or pending.'}${suffix}`;
  }
  return String(error?.message || error);
}

function renderWorkspaces() {
  const current = activeWorkspace();
  if (workspaceNameEl) workspaceNameEl.textContent = current.name || 'Default';
  if (workspaceAvatarEl) workspaceAvatarEl.textContent = workspaceInitial(current.name);
  if (!workspaceListEl) return;
  workspaceListEl.innerHTML = '';
  for (const workspace of workspaceState.workspaces) {
    const row = document.createElement('div');
    row.className = 'workspace-row';
    row.dataset.workspaceId = workspace.id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'workspace-option' + (workspace.active ? ' active' : '');
    btn.dataset.workspaceId = workspace.id;
    btn.disabled = workspaceSwitching;
    btn.setAttribute('aria-disabled', workspaceSwitching ? 'true' : 'false');
    btn.innerHTML = `<span class="workspace-option-name"></span><span class="workspace-option-check">${workspace.active ? '✓' : ''}</span>`;
    btn.querySelector('.workspace-option-name').textContent = workspace.name;
    btn.addEventListener('click', async () => {
      if (workspaceSwitching) return;
      if (workspace.active) { setWorkspacePopoverOpen(false); return; }
      try {
        setWorkspaceSwitching(true);
        setWorkspaceStatus('Switching...');
        let result;
        try {
          result = await T.switchWorkspace(workspace.id);
        } catch (e) {
          if (!isWorkspaceFetchFailure(e)) throw e;
          result = { active: workspace.id, restarting: true };
        }
        if (result?.restarting) {
          setWorkspaceStatus('Restarting...');
          await waitForWorkspaceRestart(workspace.id);
          window.location.reload();
        } else {
          await loadWorkspaces();
          setWorkspacePopoverOpen(false);
          setWorkspaceSwitching(false);
        }
      } catch (e) {
        setWorkspaceSwitching(false);
        setWorkspaceStatus(String(e.message || e), true);
      }
    });
    row.appendChild(btn);
    if (!workspace.active) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'workspace-delete-btn';
      deleteBtn.innerHTML = ICON_TRASH;
      deleteBtn.title = `Delete ${workspace.name}`;
      deleteBtn.setAttribute('aria-label', `Delete ${workspace.name}`);
      deleteBtn.disabled = workspaceSwitching;
      deleteBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (workspaceSwitching) return;
        try {
          setWorkspaceStatus('Checking workspace...');
          await T.checkWorkspaceDelete(workspace.id);
        } catch (e) {
          setWorkspaceStatus(workspaceDeleteErrorMessage(e), true);
          return;
        }
        const confirmed = await confirmWorkspaceDelete(workspace);
        if (!confirmed) {
          setWorkspaceStatus('');
          return;
        }
        try {
          setWorkspaceStatus('Deleting...');
          await T.deleteWorkspace(workspace.id);
          await loadWorkspaces();
        } catch (e) {
          setWorkspaceStatus(String(e.message || e), true);
        }
      });
      row.appendChild(deleteBtn);
    }
    workspaceListEl.appendChild(row);
  }
}

async function loadWorkspaces() {
  if (!T.listWorkspaces || !workspaceToggleBtn) return;
  try {
    workspaceState = await T.listWorkspaces();
    workspaceRagConfig = null;
    renderWorkspaces();
    if (workspaceSettingsScreenEl?.classList.contains('open')) void loadWorkspaceRagConfig();
    setWorkspaceStatus('');
  } catch (e) {
    setWorkspaceStatus('Workspace API unavailable.', true);
  }
}

workspaceToggleBtn?.addEventListener('click', () => {
  if (workspaceSwitching) return;
  setWorkspacePopoverOpen(!workspacePopoverEl?.classList.contains('open'));
});

workspaceConfigBtn?.addEventListener('click', () => {
  if (workspaceSwitching) return;
  setWorkspaceSettingsOpen(true);
});

workspaceNewBtn?.addEventListener('click', async () => {
  if (workspaceSwitching) return;
  const name = prompt('New workspace name');
  if (!name || !name.trim()) return;
  try {
    await T.createWorkspace(name.trim());
    await loadWorkspaces();
  } catch (e) {
    setWorkspaceStatus(String(e.message || e), true);
  }
});

workspaceRenameBtn?.addEventListener('click', async () => {
  if (workspaceSwitching) return;
  const current = activeWorkspace();
  const name = prompt('Rename workspace', current.name || 'Default');
  if (!name || !name.trim()) return;
  try {
    await T.renameWorkspace(current.id, name.trim());
    await loadWorkspaces();
  } catch (e) {
    setWorkspaceStatus(String(e.message || e), true);
  }
});

document.addEventListener('click', (e) => {
  if (!workspacePopoverEl?.classList.contains('open')) return;
  if (e.target.closest('#workspace-menu')) return;
  setWorkspacePopoverOpen(false);
});

function setWorkspaceRagStatus(text, isError = false) {
  if (!workspaceRagStatusEl) return;
  workspaceRagStatusEl.textContent = text || '';
  workspaceRagStatusEl.classList.toggle('error', Boolean(isError));
}

function renderWorkspaceRagStatus(status) {
  if (!status) return;
  if (status.workspaceId && status.workspaceId !== activeWorkspaceId()) return;
  if (workspaceRagProgressBarEl) workspaceRagProgressBarEl.style.width = Math.max(0, Math.min(100, status.percent ?? 0)) + '%';
  const accel = status.accelerated
    ? `CUDA · ${status.embeddingModel || 'GPU embeddings'}`
    : (status.nvidiaAvailable ? 'CPU (NVIDIA detected)' : 'CPU');
  const state = status.state || 'idle';
  const percent = Math.max(0, Math.min(100, status.percent ?? 0));
  const storage = status.storageBackend === 'postgres-pgvector'
    ? ' · Postgres/pgvector'
    : (status.storageBackend === 'json' ? ' · JSON' : '');
  const message = status.message ? ' · ' + status.message : '';
  const accelerationMessage = status.accelerationMessage ? ' · ' + status.accelerationMessage : '';
  setWorkspaceRagStatus(`${state} · ${percent}% · ${accel}${storage}${message}${accelerationMessage}`, state === 'error');
  if (workspaceRagCurrentFileEl) {
    const currentFile = typeof status.currentFile === 'string' && status.currentFile.trim()
      ? status.currentFile.trim()
      : '';
    workspaceRagCurrentFileEl.textContent = currentFile ? `Current file: ${currentFile}` : '';
    workspaceRagCurrentFileEl.title = currentFile;
  }
}

function parseWorkspaceRagPaths(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function workspaceRagSnapshotFromConfig(config) {
  const active = activeWorkspaceRagContext(config);
  const paths = Array.isArray(active?.paths ?? config?.paths)
    ? (active?.paths ?? config.paths).map(item => String(item))
    : [];
  const contextName = String(
    active?.name || config?.contextName || activeWorkspace().name || 'Workspace',
  ).trim() || activeWorkspace().name || 'Workspace';
  return {
    contextId: active?.id || config?.activeContextId || '',
    contextName,
    paths,
  };
}

function currentWorkspaceRagFormSnapshot() {
  return {
    contextId: activeWorkspaceRagContext()?.id || workspaceRagSavedSnapshot?.contextId || '',
    contextName: workspaceContextNameEl?.value?.trim() || activeWorkspace().name || 'Workspace',
    paths: parseWorkspaceRagPaths(workspaceRagPathsEl?.value || ''),
  };
}

function workspaceRagSnapshotsEqual(left, right) {
  if (!left || !right) return false;
  if (left.contextId !== right.contextId || left.contextName !== right.contextName) return false;
  if (left.paths.length !== right.paths.length) return false;
  return left.paths.every((item, index) => item === right.paths[index]);
}

function updateWorkspaceRagSaveState() {
  if (!workspaceRagSaveBtn) return;
  const hasLoadedConfig = Boolean(workspaceRagSavedSnapshot);
  const dirty = hasLoadedConfig && !workspaceRagSnapshotsEqual(workspaceRagSavedSnapshot, currentWorkspaceRagFormSnapshot());
  workspaceRagSaveBtn.disabled = workspaceRagSaving || !dirty;
  workspaceRagSaveBtn.setAttribute('aria-disabled', workspaceRagSaveBtn.disabled ? 'true' : 'false');
  workspaceRagSaveBtn.title = workspaceRagSaving
    ? 'Saving...'
    : (dirty ? 'Save changes' : 'No changes to save');
}

function activeWorkspaceRagContext(config = workspaceRagConfig) {
  if (!config) return null;
  const contexts = Array.isArray(config.contexts) ? config.contexts : [];
  return contexts.find(context => context.id === config.activeContextId) ?? contexts[0] ?? null;
}

function renderWorkspaceRagConfig(config) {
  workspaceRagConfig = config;
  const active = activeWorkspaceRagContext(config);
  if (workspaceContextNameEl) workspaceContextNameEl.value = active?.name || config?.contextName || activeWorkspace().name || '';
  if (workspaceRagPathsEl) workspaceRagPathsEl.value = Array.isArray(active?.paths ?? config?.paths) ? (active?.paths ?? config.paths).join('\n') : '';
  workspaceRagSavedSnapshot = workspaceRagSnapshotFromConfig(config);
  updateWorkspaceRagSaveState();
}

function resetWorkspaceRagConfigForm() {
  workspaceRagConfig = null;
  workspaceRagSavedSnapshot = null;
  workspaceRagSaving = false;
  if (workspaceContextNameEl) workspaceContextNameEl.value = activeWorkspace().name || '';
  if (workspaceRagPathsEl) workspaceRagPathsEl.value = '';
  if (workspaceRagProgressBarEl) workspaceRagProgressBarEl.style.width = '0%';
  if (workspaceRagCurrentFileEl) {
    workspaceRagCurrentFileEl.textContent = '';
    workspaceRagCurrentFileEl.title = '';
  }
  updateWorkspaceRagSaveState();
}

async function loadWorkspaceRagStatus() {
  try {
    const status = await callTool('workspace_rag', { action: 'status' });
    renderWorkspaceRagStatus(status);
  } catch (e) {
    setWorkspaceRagStatus('workspace_rag plugin unavailable.', true);
    if (workspaceRagCurrentFileEl) {
      workspaceRagCurrentFileEl.textContent = '';
      workspaceRagCurrentFileEl.title = '';
    }
  }
}

async function loadWorkspaceRagConfig() {
  const loadSeq = ++workspaceRagLoadSeq;
  const workspaceId = activeWorkspaceId();
  resetWorkspaceRagConfigForm();
  setWorkspaceRagStatus('Loading workspace settings...');
  try {
    const [config, status] = await Promise.all([
      callTool('workspace_rag', { action: 'get_config' }),
      callTool('workspace_rag', { action: 'status' }),
    ]);
    if (loadSeq !== workspaceRagLoadSeq || workspaceId !== activeWorkspaceId()) return;
    if (status?.workspaceId && status.workspaceId !== workspaceId) return;
    renderWorkspaceRagConfig(config);
    renderWorkspaceRagStatus(status);
  } catch (e) {
    if (loadSeq !== workspaceRagLoadSeq) return;
    workspaceRagSavedSnapshot = null;
    updateWorkspaceRagSaveState();
    setWorkspaceRagStatus('workspace_rag plugin unavailable.', true);
    if (workspaceRagCurrentFileEl) {
      workspaceRagCurrentFileEl.textContent = '';
      workspaceRagCurrentFileEl.title = '';
    }
  }
}

function startWorkspaceRagPoll() {
  stopWorkspaceRagPoll();
  workspaceRagPoll = setInterval(() => { loadWorkspaceRagStatus(); }, 3000);
}

function stopWorkspaceRagPoll() {
  if (workspaceRagPoll !== null) {
    clearInterval(workspaceRagPoll);
    workspaceRagPoll = null;
  }
}

workspaceContextNameEl?.addEventListener('input', updateWorkspaceRagSaveState);
workspaceRagPathsEl?.addEventListener('input', updateWorkspaceRagSaveState);

workspaceRagSaveBtn?.addEventListener('click', async () => {
  if (workspaceRagSaving || !workspaceRagSavedSnapshot) return;
  const nextSnapshot = currentWorkspaceRagFormSnapshot();
  if (workspaceRagSnapshotsEqual(workspaceRagSavedSnapshot, nextSnapshot)) {
    updateWorkspaceRagSaveState();
    return;
  }
  workspaceRagSaving = true;
  updateWorkspaceRagSaveState();
  try {
    const input = {
      action: 'configure',
      contextName: nextSnapshot.contextName,
      paths: nextSnapshot.paths,
    };
    if (nextSnapshot.contextId) input.contextId = nextSnapshot.contextId;
    const result = await callTool('workspace_rag', input);
    if (result?.config) renderWorkspaceRagConfig(result.config);
    else workspaceRagSavedSnapshot = nextSnapshot;
    if (result?.status) renderWorkspaceRagStatus(result.status);
  } catch (e) {
    setWorkspaceRagStatus(String(e.message || e), true);
  } finally {
    workspaceRagSaving = false;
    updateWorkspaceRagSaveState();
  }
});

workspaceSettingsCancelBtn?.addEventListener('click', () => {
  setWorkspaceSettingsOpen(false);
});

// ── Expert panel ─────────────────────────────────────────────────────────────

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
  expertPopoverEl.classList.toggle('open', open);
  updateExpertControlsState();
}

async function loadExperts() {
  if (!expertListEl) return;
  try {
    const result = await callTool('expert_panel', { action: 'list' });
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
  const question = inputEl.value.trim();
  const mode = expertModeEl?.value || 'parallel';
  const synthesize = expertSynthesizeEl?.checked !== false;
  const experts = selectedExpertIds();

  if (!question) {
    setExpertStatus('Enter a question for the panel.', true);
    inputEl.focus();
    return;
  }
  if (!expertAllEl?.checked && experts.length === 0) {
    setExpertStatus('Select at least one expert, or choose all experts.', true);
    return;
  }

  closeSidebar();
  setExpertPopoverOpen(false);
  expertPanelBusy = true;
  updateExpertControlsState();
  setExpertStatus('Running expert panel...');
  inputEl.value = '';
  inputEl.style.height = 'auto';

  try {
    if (newSessionPromise && !(await newSessionPromise)) return;
    if (!currentSessionId) {
      const { id } = await apiNewSession();
      currentSessionId = id;
      location.hash = id;
    }
    await connectSessionStream(currentSessionId);

    const input = { question, mode, synthesize, maxCitationsPerExpert: 5, provider: providerSel.value };
    if (experts.length) input.experts = experts;
    const result = await T.submitExpertPanel(currentSessionId, input);
    if (result?.session) {
      if (result.traceId) foldedTraces.add(result.traceId);
      renderSession(result.session);
    }
    if (result?.isError) {
      setExpertStatus(result.error || 'Expert panel failed.', true);
    } else {
      setExpertStatus('Complete.');
    }
  } catch (err) {
    const message = err?.message ?? String(err);
    showSubmitError(expertUserSummary(question, experts, mode, synthesize), message);
    setExpertStatus(message, true);
  } finally {
    expertPanelBusy = false;
    updateExpertControlsState();
    // This flow consumes the HTTP response directly rather than the stream's `done` event, so it never
    // reaches the refresh wired in there. The server titles this session out of band too — same hook.
    refreshTitlesAfterFollowup();
  }
}

expertToggleBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  setExpertPopoverOpen(!expertPopoverEl?.classList.contains('open'));
});

expertPopoverEl?.addEventListener('click', event => event.stopPropagation());

document.addEventListener('click', () => setExpertPopoverOpen(false));

expertEnabledEl?.addEventListener('change', () => updateExpertControlsState());

expertAllEl?.addEventListener('change', () => {
  const checked = expertAllEl.checked;
  document.querySelectorAll('.expert-choice').forEach(choice => { choice.checked = checked; });
});

expertListEl?.addEventListener('change', (event) => {
  if (event.target?.classList?.contains('expert-choice')) syncExpertAllFromChoices();
});

// Join an in-progress server run for sessionId. renderedCount is the number of
// non-system messages already in the DOM so incremental appends start from there.
// If the bottom of messages is not visible in the viewport, transform the
// send button into a ▼ down-arrow that scrolls to bottom on click.
function maybeShowScrollDown() {
  if (sending) return;
  updateScrollDownButton();
}

async function renameSession(id, current) {
  const title = window.prompt('Rename session:', current ?? '');
  if (!title || !title.trim()) return;
  try {
    await callTool('session_action', { action: 'rename', sessionId: id, title: title.trim() });
    if (id === currentSessionId && chatHeaderEl) chatTitleEl.textContent = title.trim();
    apiListSessions().then(renderSessions);
  } catch (e) { alert('Rename failed: ' + e.message); }
}

async function hideSession(id) {
  try {
    await callTool('session_action', { action: 'hide', sessionId: id });
    const sessions = await apiListSessions();
    if (id === currentSessionId) {
      currentSessionId = sessions[0]?.id ?? null;
      if (currentSessionId) { await openSession(currentSessionId); return; }
      showEmpty();
      setBusyState(false);
      if (chatHeaderEl) chatTitleEl.textContent = '';
    }
    renderSessions(sessions);
  } catch (e) { alert('Hide failed: ' + e.message); }
}

// A session title can be written by a `followup` hook, which runs *post-commit* — after the `done`
// event carrying the session was already emitted. So the title on that event is the pre-hook value and
// nothing else announces the later write. Re-read the list a moment afterwards so a hook-written title
// reaches the sidebar and header without a page reload. Two passes: a fast model lands well inside the
// first, a slow local one inside the second.
const TITLE_REFRESH_DELAYS_MS = [1500, 5000];

function refreshTitlesAfterFollowup() {
  for (const delay of TITLE_REFRESH_DELAYS_MS) {
    setTimeout(() => {
      apiListSessions().then(sessions => {
        renderSessions(sessions);
        const current = sessions.find(s => s.id === currentSessionId);
        if (current?.title && chatHeaderEl) chatTitleEl.textContent = current.title;
      }).catch(() => {});
    }, delay);
  }
}

async function apiNewSession() {
  return T.createSession();
}

// ── Workspace files ───────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderFiles(files) {
  const el = document.getElementById('file-list');
  if (!el) return;
  el.innerHTML = '';
  if (!files || !files.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9ca3af;font-size:12px;padding:4px 10px;';
    empty.textContent = '(empty)';
    el.appendChild(empty);
    return;
  }
  for (const f of files) {
    const div = document.createElement('div');
    div.className = 'file-item' + (updatedFiles.has(f.path) ? ' updated' : '');
    div.dataset.path = f.path;
    div.title = f.path + (f.size !== undefined ? ' (' + formatSize(f.size) + ')' : '');
    div.onclick = () => {
      updatedFiles.delete(f.path);
      div.classList.remove('updated');
      T.openFile('workspace', f.path);
    };
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = f.path;
    div.appendChild(nameEl);
    if (f.size !== undefined) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'file-size';
      sizeEl.textContent = formatSize(f.size);
      div.appendChild(sizeEl);
    }
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'file-action-btn';
    delBtn.textContent = '\u00d7';
    delBtn.title = 'Delete';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await callTool('workspace_action', { action: 'delete', path: f.path });
        loadFiles();
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    };
    actions.appendChild(delBtn);
    div.appendChild(actions);
    el.appendChild(div);
  }
}

async function loadFiles() {
  try {
    const data = await callTool('workspace_action', { action: 'list' });
    const files = Array.isArray(data) ? data : (data?.files ?? []);
    renderFiles(files);
  } catch (e) {
    const msg = String(e);
    if (msg.includes('not found') || msg.includes('404')) {
      const el = document.getElementById('file-list');
      if (el) {
        el.innerHTML = '';
        const prompt = document.createElement('div');
        prompt.className = 'plugin-prompt-banner';
        prompt.style.display = 'block';
        prompt.innerHTML = `Workspace plugin not loaded - workspace file management is unavailable.<button style="display:block;margin:6px 10px;padding:4px 12px;font-size:0.86em;color:#fff;background:#2563eb;border:none;border-radius:5px;cursor:pointer;font-family:inherit;font-weight:500;">Enable workspace</button>`;
        const btn = prompt.querySelector('button');
        btn.onmouseover = () => { btn.style.background = '#1d4ed8'; };
        btn.onmouseout  = () => { btn.style.background = '#2563eb'; };
        btn.onclick = () => {
          submit('Please discover local plugins and add the workspace plugin to enable file management.');
        };
        el.appendChild(prompt);
      }
    } else {
      renderFiles([]);
    }
  }
}

function makePluginLabel(name) {
  const container = document.createElement('span');
  container.className = 'plugin-name-label';
  // Split at the last non-alpha char so the trailing word is always visible.
  const idx = name.search(/[^a-zA-Z][a-zA-Z]+$/);
  const prefix = document.createElement('span');
  prefix.className = 'plugin-name-prefix';
  const suffix = document.createElement('span');
  suffix.className = 'plugin-name-suffix';
  if (idx >= 0) {
    prefix.textContent = name.slice(0, idx + 1); // includes the separator
    suffix.textContent = name.slice(idx + 1);
    container.appendChild(prefix);
    container.appendChild(suffix);
  } else {
    prefix.textContent = name;
    container.appendChild(prefix);
  }
  return container;
}

async function loadPlugins() {
  let listResult;
  try {
    listResult = await callTool('plugin', { action: 'list' });
  } catch {
    return;
  }
  let localResult = [];
  try {
    localResult = await callTool('plugin', { action: 'discover_local' });
  } catch { /* discover_local optional */ }
  renderPlugins(listResult.loaded ?? [], Array.isArray(localResult) ? localResult : []);
}

// A plugin can run here only if its declared matbotRuntime includes the host runtime. The transport
// reports it ('node' when served over HTTP, 'browser' for the in-process bundle); default 'node'.
// An absent/empty declaration means "unknown" — allow it (the backend's load/rollback gate is the
// real arbiter; we only suppress installs that are guaranteed to fail).
const HOST_RUNTIME = T.hostRuntime || 'node';
function runsHere(p) {
  const rt = p && p.matbotRuntime;
  if (!Array.isArray(rt) || rt.length === 0) return true;
  return rt.includes(HOST_RUNTIME);
}

function renderPlugins(loaded, local) {
  const el = document.getElementById('plugin-list');
  if (!el) return;
  el.innerHTML = '';

  const loadedNames = new Set(loaded.map(p => p.name));

  for (const p of loaded) {
    const det = document.createElement('details');
    det.className = 'plugin-entry';
    const sum = document.createElement('summary');
    if (p.description) sum.title = p.description;
    const main = document.createElement('div');
    main.className = 'plugin-summary-main';
    main.appendChild(makePluginLabel(p.name));
    const types = p.types ?? [];
    if (types.length) {
      const badges = document.createElement('div');
      badges.className = 'plugin-badges';
      for (const ty of types) {
        const isService = ty.startsWith('service:');
        const badge = document.createElement('span');
        badge.className = 'plugin-badge';
        badge.dataset.type = isService ? 'service' : ty;
        badge.textContent = isService ? ty.slice('service:'.length) : ty;
        if (isService) badge.title = ty;
        badges.appendChild(badge);
      }
      main.appendChild(badges);
    }
    sum.appendChild(main);
    if (p.specifier) {
      const actions = document.createElement('div');
      actions.className = 'plugin-actions';
      const removeBtn = document.createElement('button');
      removeBtn.className = 'plugin-action-btn remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove plugin';
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        closeSidebar();
        // Direct submit so it queues during a turn instead of being blocked by the input.
        submit(`Remove the plugin '${p.specifier}'`);
      };
      actions.appendChild(removeBtn);
      sum.appendChild(actions);
    }
    det.appendChild(sum);
    const tools = p.tools ?? [];
    if (tools.length) {
      const toolList = document.createElement('div');
      toolList.className = 'plugin-tool-list';
      for (const t of tools) {
        const name = typeof t === 'string' ? t : t.name;
        const desc = typeof t === 'object' && t !== null ? t.description : undefined;
        const row = document.createElement('div');
        row.className = 'plugin-tool-row';
        row.textContent = name;
        if (desc) row.title = desc;
        toolList.appendChild(row);
      }
      det.appendChild(toolList);
    }
    el.appendChild(det);
  }

  for (const p of local) {
    if (loadedNames.has(p.name)) continue;
    const row = document.createElement('div');
    row.className = 'plugin-entry-inactive';
    // This is the node-hosted web frontend, so a plugin whose declared matbotRuntime excludes 'node'
    // can never activate here. Show it struck-through with no add button rather than offering an
    // install that would only fail (and roll back) on the runtime gate.
    const compatible = runsHere(p);
    if (!compatible) row.classList.add('plugin-incompatible');
    const runtimeNote = !compatible ? `requires runtime: ${(p.matbotRuntime ?? []).join(', ')} — cannot run on this host` : '';
    if (p.description || runtimeNote) row.title = [p.description, runtimeNote].filter(Boolean).join(' — ');
    row.appendChild(makePluginLabel(p.name));
    if (compatible) {
      const actions = document.createElement('div');
      actions.className = 'plugin-actions';
      const addBtn = document.createElement('button');
      addBtn.className = 'plugin-action-btn add';
      addBtn.textContent = '+';
      addBtn.title = 'Add plugin';
      addBtn.onclick = (e) => {
        e.stopPropagation();
        closeSidebar();
        // Direct submit so it queues during a turn instead of being blocked by the input.
        submit(`Add the plugin '${p.specifier}'`);
      };
      actions.appendChild(addBtn);
      row.appendChild(actions);
    }
    el.appendChild(row);
  }

  if (!loaded.length && !local.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9ca3af;font-size:12px;padding:4px 10px;';
    empty.textContent = '(none)';
    el.appendChild(empty);
  }
}

// ── Skills ──────────────────────────────────────────────────────────────────

async function loadSkills() {
  let result;
  try {
    result = await callTool('skill_action', { action: 'list' });
  } catch {
    // skills plugin not loaded — leave the section empty.
    renderSkills([]);
    return;
  }
  renderSkills(Array.isArray(result.skills) ? result.skills : []);
}

function renderSkills(skills) {
  const el = document.getElementById('skill-list');
  if (!el) return;
  el.innerHTML = '';

  skills = [...skills].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  for (const s of skills) {
    const row = document.createElement('div');
    row.className = 'skill-entry';
    row.onclick = () => openSkillEditor(s.name);

    // Skill names are short phrases, not long unbreakable identifiers — place them
    // plainly rather than reusing the plugin-name prefix/suffix split.
    const label = document.createElement('span');
    label.className = 'skill-name-label';
    label.textContent = s.name;
    row.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'plugin-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'plugin-action-btn edit';
    editBtn.textContent = '✎';
    editBtn.title = 'Edit skill';
    editBtn.onclick = (e) => { e.stopPropagation(); openSkillEditor(s.name); };
    actions.appendChild(editBtn);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'plugin-action-btn remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Delete skill';
    removeBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete skill "${s.name}"?`)) return;
      try {
        await callTool('skill_action', { action: 'delete', name: s.name });
      } catch (err) {
        alert('Failed to delete skill: ' + (err?.message ?? err));
        return;
      }
      loadSkills();
    };
    actions.appendChild(removeBtn);

    row.appendChild(actions);
    el.appendChild(row);
  }

  if (!skills.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9ca3af;font-size:12px;padding:4px 10px;';
    empty.textContent = '(none)';
    el.appendChild(empty);
  }
}

const skillEditorOverlay = document.getElementById('skill-editor-overlay');
const skillEditorText    = document.getElementById('skill-editor-text');
const skillEditorTitle   = document.getElementById('skill-editor-title');
const skillEditorError   = document.getElementById('skill-editor-error');
const skillEditorSave    = document.getElementById('skill-editor-save');
const skillEditorRoot    = document.getElementById('skill-editor');
const skillTriggerList   = document.getElementById('skill-trigger-list');
const TRIGGER_KINDS = ['ephemeral', 'contextual', 'retract', 'followup'];
let editingSkillName = null;
let skillEditor = null;   // TinyMDE.Editor, created lazily on first open
// A skill is fired by (at most) one Trigger whose invoke is skill_action(use, {name}); its
// `conditions` are what the Triggers tab edits. `editingTriggerId` is that trigger's id (null when
// the skill has no trigger yet — we create one on save if conditions are added).
let editingTriggerId = null;

function setSkillTab(tab) {
  for (const btn of document.querySelectorAll('.skill-tab')) btn.classList.toggle('active', btn.dataset.tab === tab);
  document.getElementById('skill-editor-pane-content').classList.toggle('active', tab === 'content');
  document.getElementById('skill-editor-pane-triggers').classList.toggle('active', tab === 'triggers');
  document.getElementById('skill-editor-pane-metadata').classList.toggle('active', tab === 'metadata');
  skillEditorRoot.classList.toggle('tab-triggers', tab === 'triggers');
  skillEditorRoot.classList.toggle('tab-metadata', tab === 'metadata');
}

// Render the skill's metadata pane: the "system skill" toggle (always), then the read-only derived
// LLM analysis. `knowledge` is null until the background analysis has run and cached it (see
// SkillManager) — show a note rather than empty sections. `catalogue` is the current advertise flag.
function renderSkillMetadata(catalogue, knowledge) {
  const el = document.getElementById('skill-metadata');
  el.innerHTML = '';

  // System-skill toggle — advertise this skill in the system prompt (using its summary). Independent
  // of whether analysis has run; the editor persists it (with content + triggers) on Save.
  const sysRow = document.createElement('label');
  sysRow.className = 'meta-system';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'skill-system-checkbox';
  cb.checked = catalogue === true;
  const sysLbl = document.createElement('span');
  sysLbl.textContent = 'This is a system skill';
  sysRow.append(cb, sysLbl);
  el.appendChild(sysRow);
  const sysHint = document.createElement('div');
  sysHint.className = 'meta-note';
  sysHint.textContent = 'When set, the skill is advertised in the system prompt using the generated summary below.';
  el.appendChild(sysHint);

  if (!knowledge) {
    const note = document.createElement('div');
    note.className = 'meta-note';
    note.textContent = 'No analysis yet. Metadata (summary, entities, tags) is generated in the background after a skill is saved.';
    el.appendChild(note);
    return;
  }

  const section = (label, build) => {
    const wrap = document.createElement('div');
    wrap.className = 'meta-section';
    const lbl = document.createElement('div');
    lbl.className = 'meta-label';
    lbl.textContent = label;
    wrap.appendChild(lbl);
    wrap.appendChild(build());
    el.appendChild(wrap);
  };

  const chips = (items, cls) => {
    if (!Array.isArray(items) || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'meta-empty';
      empty.textContent = '(none)';
      return empty;
    }
    const row = document.createElement('div');
    row.className = 'meta-chips';
    for (const item of items) {
      const chip = document.createElement('span');
      chip.className = 'meta-chip ' + cls;
      chip.textContent = item;
      row.appendChild(chip);
    }
    return row;
  };

  section('Summary', () => {
    const p = document.createElement('div');
    if (knowledge.summary) {
      p.className = 'meta-summary';
      p.textContent = knowledge.summary;
    } else {
      p.className = 'meta-empty';
      p.textContent = '(none)';
    }
    return p;
  });
  section('Entities', () => chips(knowledge.entities, 'entity'));
  section('Tags', () => chips(knowledge.tags, 'tag'));
}

// One condition row: a phase <select> + the rubric <textarea>, both disabled (read-only) until ✎ is
// clicked; × removes the row. New rows (no `c`) start editable. Nothing is persisted until Save,
// which replaces the skill's trigger conditions wholesale (conditions have no stable id).
function makeTriggerRow(c) {
  const editable = !c;
  const row = document.createElement('div');
  row.className = 'trigger-row';

  const sel = document.createElement('select');
  sel.className = 'trigger-kind';
  for (const k of TRIGGER_KINDS) {
    const o = document.createElement('option');
    o.value = k; 
    o.textContent = { 'ephemeral': 'User Ephemeral', 'contextual': 'User Contextual', 'retract': 'Agent Retract', 'followup': 'Agent Follow-up' }[k];
    sel.appendChild(o);
  }
  // ephemeral/contextual = fire on the user message (route knowledge in for this turn / fold it in
  // durably); retract/followup = fire on the assistant response (discard+redo / keep+steer). Most
  // skill triggers route on user input.
  sel.value = c?.kind ?? 'ephemeral';
  sel.disabled = !editable;

  const txt = document.createElement('textarea');
  txt.className = 'trigger-text';
  txt.rows = 2;
  txt.value = c?.rule ?? '';
  txt.disabled = !editable;
  txt.placeholder = '"MATCH if the message is …; DO NOT MATCH if …" — judged against the latest turn';

  const editBtn = document.createElement('button');
  editBtn.className = 'trigger-edit';
  editBtn.title = 'Edit';
  editBtn.textContent = '✎';
  editBtn.classList.toggle('editing', editable);
  editBtn.onclick = () => {
    const enable = txt.disabled;
    txt.disabled = sel.disabled = !enable;
    editBtn.classList.toggle('editing', enable);
    if (enable) txt.focus();
  };

  const delBtn = document.createElement('button');
  delBtn.className = 'trigger-del';
  delBtn.title = 'Remove';
  delBtn.textContent = '×';
  delBtn.onclick = () => row.remove();

  row.append(sel, txt, editBtn, delBtn);
  return row;
}

function renderTriggers(conditions) {
  skillTriggerList.innerHTML = '';
  for (const c of conditions) skillTriggerList.appendChild(makeTriggerRow(c));
}

// Collect the live rows into a `conditions` array and reconcile the skill's single load-trigger:
// update it (or create it if absent) when there are conditions, remove it when the last one is
// cleared. Conditions have no stable id, so this is a wholesale replace, not a per-row diff.
async function saveTriggers(name) {
  const conditions = [];
  for (const row of skillTriggerList.querySelectorAll('.trigger-row')) {
    const kind = row.querySelector('.trigger-kind').value;
    const rule = row.querySelector('.trigger-text').value.trim();
    if (!rule) continue; // an empty row is a no-op, not a delete
    conditions.push({ kind, rule });
  }

  if (editingTriggerId) {
    if (conditions.length) {
      await callTool('trigger_action', { action: 'update', id: editingTriggerId, conditions });
    } else {
      await callTool('trigger_action', { action: 'remove', id: editingTriggerId });
      editingTriggerId = null;
    }
  } else if (conditions.length) {
    const res = await callTool('trigger_action', {
      action: 'add', conditions, tool: 'skill_action', params: { action: 'use', name },
    });
    editingTriggerId = res?.id ?? null;
  }
}

function ensureSkillEditor() {
  if (!skillEditor) {
    skillEditor = new TinyMDE.Editor({ textarea: skillEditorText });
    new TinyMDE.CommandBar({
      element: 'skill-editor-toolbar',
      editor: skillEditor,
      commands: [
        { name: 'h1', action: 'h1', title: 'Level 1 heading', innerHTML: '<span style="font-size:1.3em;font-weight:700">H</span>' },
        { name: 'h2', action: 'h2', title: 'Level 2 heading', innerHTML: '<span style="font-size:1.05em;font-weight:700">H</span>' },
        { name: 'h3', action: 'h3', title: 'Level 3 heading', innerHTML: '<span style="font-size:0.82em;font-weight:700">H</span>' },
        '|', 'bold', 'italic', 'strikethrough', '|', 'code', 'blockquote', '|', 'ul', 'ol', '|', 'insertLink',
      ],
    });
  }
  return skillEditor;
}

async function openSkillEditor(name) {
  editingSkillName = name;
  skillEditorError.textContent = '';
  skillEditorTitle.textContent = name;
  editingTriggerId = null;
  renderTriggers([]);
  renderSkillMetadata(false, null);
  setSkillTab('content');
  skillEditorOverlay.classList.add('open');
  // Triggers live in their own store now, keyed by the tool they invoke — find the one that loads
  // this skill. Independent of the markdown editor, so load it even if TinyMDE is absent.
  callTool('trigger_action', { action: 'query', tool: 'skill_action', params: { action: 'use', name } })
    .then((res) => {
      const trig = Array.isArray(res?.triggers) ? res.triggers[0] : undefined;
      editingTriggerId = trig?.id ?? null;
      renderTriggers(Array.isArray(trig?.conditions) ? trig.conditions : []);
    })
    .catch(() => { /* triggers plugin not loaded — leave the triggers tab empty. */ });
  // Derived analysis, likewise independent of TinyMDE; absent until the background pass has cached it.
  callTool('skill_action', { action: 'metadata', name })
    .then((meta) => renderSkillMetadata(meta?.catalogue ?? false, meta?.knowledge ?? null))
    .catch(() => { /* old skills plugin without the metadata action — leave the note. */ });
  // The editor needs TinyMDE (CDN, http(s) only). On an offline file:// bundle it never loaded —
  // degrade with a message rather than throwing on `new TinyMDE.Editor`.
  if (typeof TinyMDE === 'undefined') {
    skillEditorError.textContent = 'Markdown editor unavailable offline (TinyMDE failed to load).';
    skillEditorSave.disabled = true;
    return;
  }
  const editor = ensureSkillEditor();
  editor.setContent('Loading…');
  skillEditorSave.disabled = true;
  try {
    const result = await callTool('skill_action', { action: 'load', name });
    editor.setContent(result.content ?? '');
  } catch (err) {
    editor.setContent('');
    skillEditorError.textContent = 'Failed to load: ' + (err?.message ?? err);
  }
  skillEditorSave.disabled = false;
  skillEditorOverlay.querySelector('.TinyMDE')?.focus();
}

function closeSkillEditor() {
  skillEditorOverlay.classList.remove('open');
  editingSkillName = null;
}

if (skillEditorOverlay) {
  skillEditorOverlay.addEventListener('click', (e) => {
    if (e.target === skillEditorOverlay) closeSkillEditor();
  });
  document.getElementById('skill-editor-close').onclick  = closeSkillEditor;
  document.getElementById('skill-editor-cancel').onclick = closeSkillEditor;
  for (const btn of document.querySelectorAll('.skill-tab')) btn.onclick = () => setSkillTab(btn.dataset.tab);
  document.getElementById('skill-trigger-add').onclick = () => {
    const row = makeTriggerRow();
    skillTriggerList.appendChild(row);
    row.querySelector('.trigger-text').focus();
  };
  skillEditorSave.onclick = async () => {
    if (editingSkillName === null) return;
    skillEditorSave.disabled = true;
    skillEditorError.textContent = '';
    try {
      if (skillEditor) {
        const sysCb = document.getElementById('skill-system-checkbox');
        await callTool('skill_action', {
          action: 'save', name: editingSkillName, content: skillEditor.getContent(),
          ...(sysCb ? { catalogue: sysCb.checked } : {}),
        });
      }
      await saveTriggers(editingSkillName);
    } catch (err) {
      skillEditorError.textContent = 'Failed to save: ' + (err?.message ?? err);
      skillEditorSave.disabled = false;
      return;
    }
    closeSkillEditor();
    loadSkills();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && skillEditorOverlay.classList.contains('open')) closeSkillEditor();
  });
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const CHUNK = 0x8000;
      let bin = '';
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      await callTool('workspace_action', { action: 'write', path: file.name, content: btoa(bin), encoding: 'base64' });
    } catch (err) {
      alert('Upload failed for ' + file.name + ': ' + err.message);
    }
  }
  loadFiles();
}

// ── DOM builders ──────────────────────────────────────────────────────────────

function makeThinkingBlock(label, openByDefault) {
  const details = document.createElement('details');
  details.className = 'thinking-block';
  if (openByDefault) details.open = true;
  const summary = document.createElement('summary');
  summary.className = 'thinking-summary';
  summary.textContent = label;
  const content = document.createElement('div');
  content.className = 'thinking-content';
  details.appendChild(summary);
  details.appendChild(content);
  return { details, content };
}

function makeToolBlock(name, input, callId) {
  const det = document.createElement('details');
  det.className = 'tool-block';
  if (callId) det.dataset.callId = callId;
  const sum = document.createElement('summary');
  sum.className = 'tool-header';
  sum.textContent = '\u2699 ' + name;
  det.appendChild(sum);
  const inputStr = input !== undefined && input !== null
    ? (typeof input === 'string' ? input : JSON.stringify(input, null, 2))
    : '';
  if (inputStr && inputStr !== '{}') {
    const pre = document.createElement('pre');
    pre.className = 'tool-args';
    pre.textContent = inputStr;
    det.appendChild(pre);
  }
  return det;
}

function makeToolResultBlock(result, isError) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-result' + (isError ? ' tool-result-error' : '');
  const icon = document.createElement('span');
  icon.className = 'tool-result-icon';
  icon.textContent = isError ? '\u2717' : '\u2713';
  const pre = document.createElement('pre');
  pre.className = 'tool-result-text';
  const s = result === null || result === undefined ? ''
    : typeof result === 'string' ? result
    : JSON.stringify(result, null, 2);
  pre.textContent = s.length > 2000 ? s.slice(0, 2000) + '\n[\u2026 truncated]' : s;
  wrap.appendChild(icon);
  wrap.appendChild(pre);
  return wrap;
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0.0s';
  if (ms < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + 's';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return minutes + 'm ' + seconds.toString().padStart(2, '0') + 's';
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return hours + 'h ' + remMinutes.toString().padStart(2, '0') + 'm';
}

function makeTokenStatsBlock(inputTokens, outputTokens, costUsd, cacheReadTokens, cacheCreationTokens, elapsedMs) {
  const det = document.createElement('details');
  det.className = 'token-stats turn-stats';
  const sum = document.createElement('summary');
  sum.textContent = 'tokens · ' + formatElapsed(elapsedMs);
  const body = document.createElement('div');
  body.className = 'token-stats-body';
  const s = (t) => { const el = document.createElement('span'); el.textContent = t; return el; };
  let inLabel = '\u2191 ' + inputTokens.toLocaleString() + ' in';
  if (cacheReadTokens > 0) inLabel += ' (' + cacheReadTokens.toLocaleString() + ' cached)';
  body.appendChild(s(inLabel));
  body.appendChild(s('\u2193 ' + outputTokens.toLocaleString() + ' out'));
  if (cacheCreationTokens > 0) body.appendChild(s('\u2601 ' + cacheCreationTokens.toLocaleString() + ' written'));
  if (costUsd > 0) body.appendChild(s('\u2248 $' + costUsd.toFixed(4)));
  body.appendChild(s('\u23f1 ' + formatElapsed(elapsedMs)));
  det.appendChild(sum);
  det.appendChild(body);
  return det;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function showEmpty() {
  messagesEl.innerHTML =
    '<div class=\"empty-state\">' +
    '<strong>Start a conversation</strong>' +
    '<span>Type a message below to begin.</span>' +
    '</div>';
}

function renderSessions(sessions) {
  sessionListEl.innerHTML = '';
  for (const s of sessions) {
    const label = (s.title || s.preview || s.id.slice(0, 8)).slice(0, 44);
    const el = document.createElement('div');
    el.className = 'session-item' +
      (s.id === currentSessionId ? ' active' : '') +
      (busySessions.has(s.id) ? ' busy' : '') +
      (!busySessions.has(s.id) && s.id !== currentSessionId && unreadSessions.has(s.id) ? ' unread' : '');
    el.dataset.sid = s.id;

    const labelEl = document.createElement('span');
    labelEl.className = 'session-label';
    labelEl.textContent = label;
    labelEl.title = label;
    labelEl.onclick = () => openSession(s.id);

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'session-action-btn';
    renameBtn.textContent = '\u2710';
    renameBtn.title = 'Rename';
    renameBtn.onclick = e => { e.stopPropagation(); renameSession(s.id, s.title || ''); };

    const hideBtn = document.createElement('button');
    hideBtn.className = 'session-action-btn';
    hideBtn.textContent = '\u00d7';
    hideBtn.title = 'Hide';
    hideBtn.onclick = e => { e.stopPropagation(); hideSession(s.id); };

    actions.appendChild(renameBtn);
    actions.appendChild(hideBtn);
    el.appendChild(labelEl);
    el.appendChild(actions);
    sessionListEl.appendChild(el);
  }
}

function makeBubble(className, text) {
  const div = document.createElement('div');
  div.className = 'message ' + className;
  const inner = document.createElement('div');
  inner.className = 'md-body';
  inner.innerHTML = md(text);
  div.appendChild(inner);
  return div;
}

// Scroll the latest message into view (e.g. the user just sent it). Respect the suppression timer
// in case they scrolled away earlier.
function scrollMessagesToBottom() {
  if (!isScrollSuppressed()) {
    programmaticScrollTo(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }
}

function appendUserBubble(text, msgIdx, pending, traceId) {
  messagesEl.querySelector('.empty-state')?.remove();
  if (messagesEl.querySelector('.message')) {
    messagesEl.appendChild(createMsgDivider(msgIdx));
  }
  const div = makeBubble('user' + (pending ? ' pending' : ''), text);
  if (traceId) div.dataset.trace = traceId;
  messagesEl.appendChild(div);
  scrollMessagesToBottom();
  return div;
}

// A machine-authored turn (a followup resubmission). Presented agent-side with the robot badge.
function appendRoboBubble(text, msgIdx, traceId) {
  messagesEl.querySelector('.empty-state')?.remove();
  if (messagesEl.querySelector('.message')) {
    messagesEl.appendChild(createMsgDivider(msgIdx));
  }
  const div = makeBubble('robo', text);
  if (traceId) div.dataset.trace = traceId;
  messagesEl.appendChild(div);
  scrollMessagesToBottom();
  return div;
}

// Render one stored user turn, split by block provenance: contiguous human blocks render as the user
// bubble, contiguous robo blocks (a hook-injected fragment) as an agent-side robo bubble. One stored
// message can therefore become two bubbles, under a single turn divider. Returns the last bubble.
function appendUserTurn(content, msgIdx, traceId) {
  const runs = [];
  for (const c of content) {
    if (c.type !== 'text' || !c.text) continue;
    const robo = c.origin === 'robo';
    const prev = runs[runs.length - 1];
    if (prev && prev.robo === robo) prev.text += '\n' + c.text;
    else runs.push({ robo, text: c.text });
  }
  if (!runs.length) return null;
  messagesEl.querySelector('.empty-state')?.remove();
  if (messagesEl.querySelector('.message')) {
    messagesEl.appendChild(createMsgDivider(msgIdx));
  }
  let last = null;
  for (const run of runs) {
    last = makeBubble(run.robo ? 'robo' : 'user', run.text);
    // Tag with the turn's traceId so a replayed `queued` for this still-running turn adopts the
    // existing bubble (renderTurn) instead of drawing a second one.
    if (traceId) last.dataset.trace = traceId;
    messagesEl.appendChild(last);
  }
  scrollMessagesToBottom();
  return last;
}

function createMsgDivider(msgIdx) {
  const div = document.createElement('div');
  div.className = 'msg-divider';
  if (msgIdx !== undefined) div.dataset.msgIdx = msgIdx;

  const line = document.createElement('div');
  line.className = 'msg-divider-line';
  div.appendChild(line);

  const menu = document.createElement('div');
  menu.className = 'msg-divider-menu';
  for (const [icon, label, action, danger] of [
    ['🔗', 'Copy link', 'copy-link', false],
    ['✂',  'Cut',             'cut',       true],
    ['⎇',  'Fork',            'fork',      false],
    ['🗜', 'Compact',   'compact',   true],
    ['⇉',  'Split',          'split',      false],
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-divider-btn' + (danger ? ' danger' : '');
    const iconSpan = document.createElement('span');
    iconSpan.className = 'msg-divider-btn-icon';
    iconSpan.textContent = icon;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'msg-divider-btn-label';
    labelSpan.textContent = label;
    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    btn.addEventListener('click', (e) => { e.stopPropagation(); handleDividerAction(div, action); });
    menu.appendChild(btn);
  }
  div.appendChild(menu);

  div.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.msg-divider.open').forEach(d => { if (d !== div) d.classList.remove('open'); });
    div.classList.toggle('open');
  });

  return div;
}

async function handleDividerAction(divider, action) {
  divider.classList.remove('open');
  const msgIdx = divider.dataset.msgIdx !== undefined ? parseInt(divider.dataset.msgIdx) : undefined;

  if (action === 'copy-link') {
    const hash = currentSessionId + (msgIdx !== undefined ? '~' + JSON.stringify({ msg: msgIdx }) : '');
    const url = location.origin + location.pathname + '#' + hash;
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(url); copied = true; } catch { /* denied */ }
    }
    if (!copied) {
      // Fallback for plain-HTTP contexts where clipboard API is unavailable.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { copied = document.execCommand('copy'); } catch { /* */ }
      ta.remove();
    }
    if (copied) {
      const line = divider.querySelector('.msg-divider-line');
      if (line) {
        line.style.cssText = 'background:#6366f1;transition:none';
        setTimeout(() => { line.style.cssText = ''; }, 600);
      }
    } else {
      prompt('Copy this link:', url);
    }
    return;
  }

  if (!currentSessionId || msgIdx === undefined) return;

  try {
    if (action === 'fork') {
      const result = await callTool('session_edit', { action: 'fork', sessionId: currentSessionId, msgIndex: msgIdx });
      if (result?.newSessionId) {
        await openSession(result.newSessionId);
        apiListSessions().then(renderSessions);
      }
    } else if (action === 'cut') {
      if (!confirm('Delete all messages from this point forward?')) return;
      await callTool('session_edit', { action: 'cut', sessionId: currentSessionId, msgIndex: msgIdx });
      const session = await apiGetSession(currentSessionId);
      if (session) renderSession(session);
    } else if (action === 'split') {
      if (!confirm('Split session at this point? Messages before will be moved to a new session.')) return;
      const result = await callTool('session_edit', { action: 'split', sessionId: currentSessionId, msgIndex: msgIdx });
      if (result?.newSessionId) {
        // Navigate to the current (trimmed) session
        await openSession(result.currentSessionId);
        apiListSessions().then(renderSessions);
      }
    } else if (action === 'compact') {
      if (!confirm('Strip thinking blocks and tool calls from messages before this point?')) return;
      await callTool('session_edit', { action: 'compact', sessionId: currentSessionId, msgIndex: msgIdx });
      const session = await apiGetSession(currentSessionId);
      if (session) renderSession(session);
    }
  } catch (e) {
    if (String(e).includes('404')) {
      showEditSessionBanner();
    } else {
      alert(action + ' failed: ' + e.message);
    }
  }
}

function showEditSessionBanner() {
  if (document.getElementById('edit-session-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'edit-session-banner';
  banner.className = 'plugin-prompt-banner';
  banner.style.display = 'flex';
  const span = document.createElement('span');
  span.textContent = 'edit-session plugin not loaded — Cut, Fork, Split, and Compact are unavailable.';
  banner.appendChild(span);
  const btn = document.createElement('button');
  btn.textContent = 'Install edit-session';
  btn.onclick = () => {
    banner.remove();
    submit('Please discover and install the edit-session plugin');
  };
  banner.appendChild(btn);
  const inputArea = document.getElementById('input-area');
  inputArea?.parentElement?.insertBefore(banner, inputArea);
}

function flashMessage(el) {
  if (!el) return;
  el.classList.remove('msg-nav-flash');
  void el.offsetWidth; // force reflow to restart animation if already flashing
  el.classList.add('msg-nav-flash');
  setTimeout(() => el.classList.remove('msg-nav-flash'), 1200);
}

function scrollToMsgIdx(msgIdx) {
  // rAF defers until after the browser has laid out the newly-rendered messages.
  requestAnimationFrame(() => {
    const divider = messagesEl.querySelector(`.msg-divider[data-msg-idx="${msgIdx}"]`);
    const target = divider?.nextElementSibling;
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
    flashMessage(target);
  });
}

// anchorAfter: insert the wrap immediately after this node (its turn's user bubble) rather than at
// the container tail. Live, several submissions can be queued — and their user bubbles drawn — before
// any response streams; appending each response at the tail would group all bubbles then all
// responses. Anchoring each turn's wrap to its own user bubble keeps responses interleaved, matching
// the reload (renderSession) order. A joined in-progress turn has no user bubble (it's in committed
// history); passing nothing falls back to tail-append, which is correct there.
function createAssistantWrap(labelText, anchorAfter) {
  messagesEl.querySelector('.empty-state')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'message assistant';
  // Not sure we like the label in the UI — it takes up space and is redundant with the robot badge. Keep it commented out for now.
  // const label = document.createElement('div');
  // label.className = 'msg-label';
  // label.textContent = labelText || 'assistant';
  // wrap.appendChild(label);
  if (anchorAfter && anchorAfter.parentNode === messagesEl) {
    messagesEl.insertBefore(wrap, anchorAfter.nextSibling);
  } else {
    messagesEl.appendChild(wrap);
  }
  return wrap;
}

// Render marker blocks as centered cross-thread notices. Markers are opaque to the LLM; the UI
// is free to interpret known creators. Unknown creators get a generic, non-navigating chip.
function appendMarker(content, traceId) {
  messagesEl.querySelector('.empty-state')?.remove();
  for (const part of content) {
    if (part.type !== 'marker') continue;
    // A retraction supersedes the turn's original response: drop that response from the live view so
    // the thread matches what a refresh shows (the original is popped from the session and survives
    // only inside this marker). Idempotent — a no-op on reload, where the original was never rendered
    // (renderSession doesn't tag assistant wraps with a traceId).
    if (part.creator === 'matbot-retraction' && traceId) {
      messagesEl.querySelectorAll(`.message.assistant[data-trace="${traceId}"]`).forEach(el => el.remove());
    }
    messagesEl.appendChild(renderMarker(part));
  }
}

function renderMarker(part) {
  const note = document.createElement('div');
  note.className = 'marker-note';
  const data = part.data || {};

  const EDIT_SESSION_RELATIONS = {
    'continued-in': { icon: '↪', text: 'Conversation continued in another thread' },
    'split-from':   { icon: '↩', text: 'Earlier messages split to another thread' },
    'forked-from':  { icon: '⎇', text: 'Forked from another thread' },
  };
  const rel = EDIT_SESSION_RELATIONS[data.relation];
  if (part.creator === '@matatbread/matbot-edit-session' && data.peerSessionId && rel) {
    const icon = document.createElement('span');
    icon.className = 'marker-icon';
    icon.textContent = rel.icon;
    note.appendChild(icon);
    const text = document.createElement('span');
    text.textContent = rel.text;
    note.appendChild(text);
    const link = document.createElement('a');
    const hasTarget = typeof data.targetMsg === 'number';
    link.href = '#' + data.peerSessionId + (hasTarget ? '~' + JSON.stringify({ msg: data.targetMsg }) : '');
    link.textContent = 'Open →';
    link.addEventListener('click', (e) => { e.preventDefault(); openSession(data.peerSessionId, hasTarget ? data.targetMsg : undefined); });
    note.appendChild(link);
    return note;
  }

  // A retract-and-rerun: show a collapsed, thinking-styled block titled "Retraction" holding ONLY the
  // final text of the superseded response (no thinking/tool blocks). The response itself was removed
  // from the thread (see appendMarker), so this is the sole, de-emphasised trace of what was said.
  if (part.creator === 'matbot-retraction') {
    const retracted = Array.isArray(data.retracted) ? data.retracted : [];
    const text = retracted
      .flatMap(m => (m.content || []).filter(c => c.type === 'text').map(c => c.text))
      .join('\n\n').trim();
    const wrap = document.createElement('div');
    wrap.className = 'message assistant marker-block retraction';
    const { details, content: body } = makeThinkingBlock('↩️ Retraction', false);
    details.classList.add('retraction-block');
    body.classList.add('md-body');
    body.style.whiteSpace = 'normal';   // thinking-content defaults to pre-wrap; rendered markdown needs normal flow
    body.innerHTML = md(text || '_(no text content)_');
    wrap.appendChild(details);
    return wrap;
  }

  // A hook threw and was skipped — surface it as a warning so a misconfigured hook (e.g. a provider
  // with an unresolved secret) is visible rather than silently degrading.
  if (part.creator === 'matbot-hooks') {
    note.classList.add('marker-warn');
    const icon = document.createElement('span');
    icon.className = 'marker-icon';
    icon.textContent = '⚠️';
    note.appendChild(icon);
    const text = document.createElement('span');
    const who = data.pluginName ? ` (${data.pluginName})` : '';
    text.textContent = `A ${data.channel || 'hook'} hook${who} failed and was skipped: ${data.message || 'unknown error'}`;
    note.appendChild(text);
    return note;
  }

  // Everything else: render like a tool block — a collapsible whose title is the creator and whose
  // body is the marker's JSON data. Generic, so any creator (remember_fact, triggers, future ones)
  // gets a useful surface with no per-creator UI. Wrapped in an assistant-style container so it
  // inherits the same width/alignment a tool block has *inside a turn* — a bare .tool-block dropped
  // at the message-list top level full-bleeds and its overflow:hidden clips the content. The
  // `marker-block` class on the wrapper makes it easy to restyle or suppress later.
  const wrap = document.createElement('div');
  wrap.className = 'message assistant marker-block';
  const det = document.createElement('details');
  det.className = 'tool-block';
  const sum = document.createElement('summary');
  sum.className = 'tool-header';
  sum.textContent = '🔖 ' + part.creator;
  det.appendChild(sum);
  const pre = document.createElement('pre');
  pre.className = 'tool-args';
  pre.textContent = JSON.stringify(data, null, 2);
  det.appendChild(pre);
  wrap.appendChild(det);
  return wrap;
}

// Populate a wrapper from historical message content parts
function renderContentParts(wrap, content) {
  for (const part of content) {
    switch (part.type) {
      case 'text': {
        if (!part.text) break;
        const div = document.createElement('div');
        div.className = 'msg-text md-body';
        div.innerHTML = md(part.text);
        wrap.appendChild(div);
        break;
      }
      case 'thinking': {
        const { details, content: c } = makeThinkingBlock('\ud83d\udcad Thinking', false);
        c.textContent = part.thinking || '';
        wrap.appendChild(details);
        break;
      }
      case 'reasoning': {
        const { details, content: c } = makeThinkingBlock('\ud83d\udcad Reasoning', false);
        c.textContent = part.reasoning || '';
        wrap.appendChild(details);
        break;
      }
      case 'redacted-thinking': {
        const div = document.createElement('div');
        div.className = 'thinking-redacted';
        div.textContent = '\ud83d\udcad Thinking (redacted)';
        wrap.appendChild(div);
        break;
      }
      case 'tool-call':
        wrap.appendChild(makeToolBlock(part.name, part.input, part.id));
        break;
      case 'tool-result': {
        const toolBlock = part.id ? messagesEl.querySelector('[data-call-id="' + part.id + '"]') : null;
        if (toolBlock) {
          toolBlock.appendChild(makeToolResultBlock(part.result, part.isError));
        } else {
          wrap.appendChild(makeToolResultBlock(part.result, part.isError));
        }
        break;
      }
      case 'refusal': {
        const div = document.createElement('div');
        div.className = 'msg-refusal';
        div.textContent = part.text;
        wrap.appendChild(div);
        break;
      }
      case 'form': {
        const block = document.createElement('div');
        block.className = 'form-block';
        const inputs = {};
        for (const field of part.fields) {
          const labelEl = document.createElement('div');
          labelEl.className = 'form-field-label';
          labelEl.textContent = field.label;
          block.appendChild(labelEl);
          if (field.type === 'select') {
            const sel = document.createElement('select');
            sel.className = 'form-select';
            sel.name = field.name;
            for (const opt of field.options ?? []) {
              const o = document.createElement('option');
              o.value = o.textContent = opt;
              sel.appendChild(o);
            }
            if (field.default) sel.value = field.default;
            inputs[field.name] = sel;
            block.appendChild(sel);
          } else {
            const inp = document.createElement('input');
            inp.type = field.type === 'password' ? 'password' : 'text';
            inp.className = 'form-text-input';
            inp.name = field.name;
            inp.value = field.default ?? '';
            inputs[field.name] = inp;
            block.appendChild(inp);
          }
        }
        const actions = document.createElement('div');
        actions.className = 'form-actions';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'form-submit-btn';
        btn.textContent = part.submitLabel ?? 'Submit';
        btn.onclick = () => {
          const values = {};
          for (const [name, el] of Object.entries(inputs)) values[name] = el.value;
          btn.disabled = true;
          Object.values(inputs).forEach(el => { el.disabled = true; });
          block.closest('.message')?.remove();
          submitFormResponse(currentSessionId, values);
        };
        actions.appendChild(btn);
        block.appendChild(actions);
        wrap.appendChild(block);
        break;
      }
      default: {
        const div = document.createElement('div');
        div.className = 'msg-text';
        div.textContent = JSON.stringify(part);
        wrap.appendChild(div);
        break;
      }
    }
  }
}

// startIdx > 0 appends only messages from that index — used for incremental updates.
// origIdx (index in session.messages including system) is passed to dividers so
// the edit-session plugin tools can reference exact positions.
function renderSession(session, startIdx, scrollTarget) {
  const allMsgs = session.messages;
  if (!startIdx) {
    if (!allMsgs.some(m => m.role !== 'system')) { showEmpty(); return; }
    messagesEl.innerHTML = '';
  }
  let nonSysCount = 0;
  for (let origIdx = 0; origIdx < allMsgs.length; origIdx++) {
    const msg = allMsgs[origIdx];
    if (msg.role === 'system') continue;
    const fi = nonSysCount++;
    if (startIdx && fi < startIdx) continue;
    if (msg.role === 'user') {
      // Stored history is pure committed messages; queued/pending items arrive via the live stream,
      // not from here. Split by block provenance: genuine user blocks → user bubble, robo blocks
      // (a hook-injected fragment) → agent-side robo bubble. A wholly-robo turn (followup resubmit)
      // is just one whose blocks are all robo.
      appendUserTurn(msg.content, origIdx, msg.traceId);
    } else if (msg.role === 'assistant') {
      const wrap = createAssistantWrap('assistant');
      renderContentParts(wrap, msg.content);
    } else if (msg.role === 'tool') {
      // Results are attached to their matching .tool-block via data-call-id; no wrapper needed.
      const dummy = document.createDocumentFragment();
      renderContentParts(dummy, msg.content);
    } else if (msg.role === 'marker') {
      appendMarker(msg.content, msg.traceId);
    }
  }
  if (scrollTarget !== undefined) {
    const divider = messagesEl.querySelector(`.msg-divider[data-msg-idx="${scrollTarget}"]`);
    const target  = divider?.nextElementSibling;
    if (target) { target.scrollIntoView({ block: 'start', behavior: 'instant' }); flashMessage(target); return; }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function openSession(id, scrollTarget) {
  closeSidebar();
  setArchitectureOpen(false);
  currentSessionId = id;
  unreadSessions.delete(id);
  sessionListEl.querySelector('[data-sid="' + id + '"]')?.classList.remove('unread');
  location.hash = id;
  const [sessions, session, busy] = await Promise.all([apiListSessions(), apiGetSession(id), apiSessionBusy(id)]);
  renderSessions(sessions);
  if (session) {
    renderSession(session, undefined, scrollTarget);
    if (chatHeaderEl) chatTitleEl.textContent = session.title ?? '';
  }
  setBusyState(busy);
  // One persistent stream for this session; it replays any in-progress turn and carries all future
  // turns. Renders happen via renderTurn() keyed by traceId.
  connectSessionStream(id);
  loadFiles();
  inputEl.focus();
}

// Shared: create a new session and navigate to it (used by click + hash). DOM event
// dispatch does not wait for an async listener, so retain the transition promise:
// a message typed immediately after clicking New must not be posted to the previous
// session while createSession() is still in flight.
let newSessionPromise = null;

function handleNewSession() {
  if (newSessionPromise) return newSessionPromise;

  closeSidebar();
  setArchitectureOpen(false);
  const pending = (async () => {
    try {
      const { id } = await apiNewSession();
      currentSessionId = id;
      // Bind the session stream as soon as the session exists. Waiting until the
      // first submit races the submit POST against SSE establishment and can lose
      // the complete response on a fast backend.
      void connectSessionStream(id);
      location.hash = id;
      showEmpty();
      setBusyState(false); // a brand-new session is idle; clear any Stop carried over from the last view
      if (chatHeaderEl) chatTitleEl.textContent = '';
      const sessions = await apiListSessions();
      renderSessions(sessions);
      inputEl.focus();
      return id;
    } catch (e) {
      alert('New session failed: ' + e.message);
      return null;
    }
  })();

  newSessionPromise = pending;
  void pending.then(() => {
    if (newSessionPromise === pending) newSessionPromise = null;
  });
  return pending;
}

// Left-click creates a new session in the current tab.
// Right-click / middle-click on the <a href="#new"> opens in a new tab naturally.
newBtn.addEventListener('click', async (e) => {
  if (e.button !== 0) return; // let right-click / middle-click open in new tab
  e.preventDefault();
  await handleNewSession();
});

// ── Form submission ───────────────────────────────────────────────────────────

async function submitFormResponse(sessionId, values) {
  if (!sessionId) return;
  // A form answer is just another submission; it renders over the persistent stream like any turn.
  await postSubmit(sessionId, { type: 'form-response', values });
}

// ── Send ──────────────────────────────────────────────────────────────────────

// ── Per-session event stream (one persistent connection; submits are fire-and-forget) ──────────
//
// A single GET /events/sessions/:id SSE carries ALL turns for the session. Events are demuxed by
// traceId into per-turn queues, each drained by renderTurn(). One connection per session (not per
// submission) is what keeps queued submits off the browser's ~6-socket-per-host limit — the cause
// of both the missing-queued-badge and the prompt-stall bugs.

let streamSessionId = null;       // session the persistent stream is bound to
let streamAc        = null;       // AbortController for the current stream
let streamReady     = Promise.resolve(); // settles after the transport confirms subscription
const turnQueues    = new Map();  // traceId -> { items, wake, done, started }

// Concat policy (the runner merges submissions queued behind a running turn into one turn, answered
// under the first/head submission's traceId). Mirror it in the UI: a submission that arrives while an
// earlier one is still queued-and-unanswered folds its text into that head bubble instead of getting
// its own turn — whose traceId the runner dropped, so it would never receive a response. activeBatchHead
// is the head's traceId; it resets the moment the head turn produces real output (its response has
// started, so the next submission begins a fresh batch). Tracked synchronously here — not via the DOM —
// so the refresh-replay, which delivers all pending `queued` events in one synchronous batch, folds
// correctly without racing the async bubble creation in renderTurn.
let activeBatchHead = null;   // { traceId, concat } | null — the open batch a follower may fold into
const foldedTraces  = new Set();

function queueFor(traceId) {
  let q = turnQueues.get(traceId);
  if (!q) { q = { items: [], wake: null, done: false, started: false }; turnQueues.set(traceId, q); }
  return q;
}

function wake(q) { if (q.wake) { const w = q.wake; q.wake = null; w(); } }

function pushTurnEvent(ev) {
  if (foldedTraces.has(ev.traceId)) return;   // a folded submission's later events (incl. cancelled) are noise

  // Markers can arrive after a turn's terminal event (e.g. a followup hook's, emitted post-commit).
  // If the turn's queue is gone/finished, render directly rather than re-spawning a renderTurn for a
  // done traceId; otherwise let it flow through the queue so it renders inline at the right spot.
  if (ev.type === 'marker') {
    const q = turnQueues.get(ev.traceId);
    if (!q || q.done) { appendMarker(ev.content ?? [], ev.traceId); return; }
  }

  if (ev.type === 'queued') {
    // Fold a follower into the head only when BOTH the head and this submission are concat — mirroring
    // the runner, which absorbs consecutive concat submissions into the head's turn and treats any
    // non-concat (Ctrl+Enter / robo) submission as a boundary that runs as its own turn.
    if (activeBatchHead !== null && activeBatchHead.concat && ev.concatQueue === true && ev.traceId !== activeBatchHead.traceId) {
      const headQ = turnQueues.get(activeBatchHead.traceId);
      if (headQ && !headQ.done) {
        headQ.items.push({ ...ev, type: 'queued-append' });
        wake(headQ);
        foldedTraces.add(ev.traceId);
        return;
      }
    }
    // Only a head still waiting behind a running turn (queued > 0) can absorb later concat
    // submissions: it sits in the runner's queue long enough for them to land behind it. A head that
    // runs immediately (queued === 0) is dequeued and its batch sealed by pump *synchronously* — before
    // any follower's submit POST can reach the queue — so it never merges one. Opening a foldable batch
    // for it would fold a quickly-queued next message into its bubble even though the runner ran it as
    // its own separate turn (visible only as the live/reload mismatch this guards against).
    activeBatchHead = ev.queued > 0 ? { traceId: ev.traceId, concat: ev.concatQueue === true } : null;
  } else if (activeBatchHead !== null && ev.traceId === activeBatchHead.traceId) {
    activeBatchHead = null;   // head turn has started responding → next submission opens a new batch
  }

  const q = queueFor(ev.traceId);
  q.items.push(ev);
  if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error' || ev.type === 'cancelled') q.done = true;
  wake(q);
  // First time we see this traceId, spin up its renderer. Every turn — ours or one we joined —
  // is created here from the stream; there is no optimistic/pre-registered path to race against.
  if (!q.started) { q.started = true; void renderTurn(streamSessionId, ev.traceId); }
}

async function* turnEvents(traceId) {
  const q = queueFor(traceId);
  for (;;) {
    while (q.items.length) yield q.items.shift();
    if (q.done) { turnQueues.delete(traceId); return; }
    await new Promise(res => { q.wake = res; });
  }
}

function connectSessionStream(sid) {
  if (streamSessionId === sid && streamAc && !streamAc.signal.aborted) return streamReady;
  if (streamAc) streamAc.abort();
  streamAc = new AbortController();
  streamSessionId = sid;
  turnQueues.clear();
  activeBatchHead = null;
  foldedTraces.clear();
  const ac = streamAc;
  let markReady = () => {};
  streamReady = new Promise(resolve => {
    let settled = false;
    markReady = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  // The transport owns the wire (reconnect, parsing); we just demux each turn event. Switching
  // sessions aborts ac (above), which ends the prior stream.
  void (async () => {
    try {
      for await (const ev of T.sessionEvents(sid, ac.signal)) {
        if (ev.type === 'stream-ready') {
          markReady();
          continue;
        }
        if (ac.signal.aborted || sid !== currentSessionId) break;
        pushTurnEvent(ev);
      }
    } catch {
      /* aborted or stream torn down */
    } finally {
      // Avoid trapping a caller forever if a custom transport closes without
      // implementing the handshake. First-party transports settle earlier.
      markReady();
    }
  })();
  return streamReady;
}

// Read the input box and submit it. The single entry point for *typed* messages; canned/programmatic
// messages (plugin install banners, etc.) call submit() directly so they aren't gated by the input.
// concat = true (Shift+Enter / send button): fold into the running turn's batch — fastest way to
// add more context. concat = false (Ctrl+Enter): a distinct queued turn, run in order — use when the
// next ask depends on this one's tools/state (e.g. install a plugin, then use it).
async function sendMessage(concat = true) {
  if (expertEnabledEl?.checked) {
    await runExpertPanelFromUi();
    return;
  }
  const content = inputEl.value.trim();
  if (!content) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  await submit(content, concat);
}

// Submit typed content to the current session, fire-and-forget. The server enqueues it and the
// turn (its 'queued' user bubble + response) renders entirely over the persistent stream — there's
// no optimistic rendering here, so there's a single source of truth.
// concat defaults false: robo/programmatic submits (plugin install/remove banners, etc.) must each be
// their own ordered turn — one's tools/state are a precondition for the next ("add plugin X" then "use
// X", X only visible to a later turn). The human path passes its choice explicitly via sendMessage.
async function submit(content, concat = false) {
  const provider = providerSel.value;
  if (!content || !provider) return;
  if (newSessionPromise && !(await newSessionPromise)) return;
  if (!currentSessionId) {
    const { id } = await apiNewSession();
    currentSessionId = id;
  }
  // Ensure the persistent event stream is bound to this session before we enqueue, so the turn's
  // events have a consumer (covers the just-created session and the "New session" button path).
  await connectSessionStream(currentSessionId);
  await postSubmit(currentSessionId, content, concat);
}

// POST a submission and return. The user bubble + response arrive on the stream as a 'queued' event
// then turn events. Only *failures* are surfaced here (the stream can't, since no turn was created):
// a timeout (incl. the socket-exhaustion stall that never errors on its own), network error, or
// non-2xx is shown inline so the message is never silently lost.
async function postSubmit(sid, content, concat = false) {
  const provider = providerSel.value;
  if (!provider) return;
  try {
    await T.submit(sid, { content, provider, concatQueue: concat });
  } catch (e) {
    showSubmitError(content, e.name === 'TimeoutError' ? 'submit timed out (no response)' : (e.message || String(e)));
  }
}

// The submission never reached a turn, so show what was typed plus the failure, inline.
function showSubmitError(content, msg) {
  const text = typeof content === 'string' ? content : '';
  if (text) appendUserBubble(text);
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.textContent = '[send failed: ' + msg + ']';
  messagesEl.appendChild(div);
}

// Render one turn by draining its event queue, keyed by traceId. The user bubble is created from
// the 'queued' event (so it lands in the live delta in stream order); the assistant wrap + loading
// dots are created lazily on first activity. A turn we merely joined (the in-progress run, replayed
// on connect) gets no 'queued' — its user message is already in committed/stored history.
async function renderTurn(sid, traceId) {
  let userBubble = null;   // set by the 'queued' event when this turn is a fresh submission
  let userBubbleText = ''; // raw markdown of the bubble; grows as concat'd submissions fold in
  let turnWrap   = null;   // assistant wrap, created lazily
  let loadingEl  = null;
  let started    = false;

  // First visible activity for this turn: drop the queued egg-timer and create the assistant wrap
  // with loading dots. Idempotent.
  function markStarted() {
    if (started) return;
    started = true;
    if (userBubble) userBubble.classList.remove('pending');
    turnWrap = createAssistantWrap('assistant', userBubble);
    turnWrap.dataset.trace = traceId;   // so a retraction marker for this turn can drop this wrap live
    loadingEl = document.createElement('div');
    loadingEl.className = 'msg-loading';
    turnWrap.appendChild(loadingEl);
    // The dots sit below the just-appended user bubble, so the bubble's own scroll-to-bottom (which
    // ran before the dots existed) left them under the fold. Re-pin to the bottom now they're in the DOM.
    scrollMessagesToBottom();
  }
  function removeLoading() { markStarted(); if (loadingEl) { loadingEl.remove(); loadingEl = null; } }

  // Per-turn streaming state
  let textEl          = null;
  let textAccum       = '';
  let textElFinalised = false;
  let thinkingContent = null;
  let thinkingAccum   = '';
  let currentTool     = null;
  let providerToolPending = false;
  let turnIn          = 0;
  let turnOut         = 0;
  let turnCost        = 0;
  let turnCacheRead   = 0;
  let turnCacheCreate = 0;
  let turnStartedAt   = null;


  function getOrMakeTextEl() {
    markStarted();
    if (!textEl) {
      textEl = document.createElement('div');
      textEl.className = 'msg-text md-body';
      turnWrap.appendChild(textEl);
    }
    return textEl;
  }

  function markTurnClockStarted() {
    if (turnStartedAt === null) turnStartedAt = performance.now();
  }

  function appendTurnStats() {
    if (!turnWrap) return;
    if (turnWrap.querySelector('.turn-stats')) return;
    const elapsedMs = turnStartedAt === null ? 0 : performance.now() - turnStartedAt;
    turnWrap.appendChild(makeTokenStatsBlock(turnIn, turnOut, turnCost, turnCacheRead, turnCacheCreate, elapsedMs));
  }

  // Called on the first content event of each turn.  Scrolls the
  // assistant message wrapper to the top of the messages viewport so
  // the user can read the output from the beginning.  Honours the
  // 10-second suppression window set by manual user scrolling.
  function scrollToOutputStart() {
    if (isScrollSuppressed()) return;
    programmaticScrollTo(() => {
      // While the text block fits within the viewport, scroll its bottom
      // into view so the user sees the message filling in from the bottom.
      // Once the content is taller than the container, stop scrolling so
      // the user can read from the top without it being pushed away.
      const el = textEl;
      const avail = window.innerHeight - (chatHeaderEl?.offsetHeight ?? 0)
                    - (document.getElementById('input-area')?.offsetHeight ?? 0);
      if (el && el.offsetHeight <= avail) {
        el.scrollIntoView({ block: 'end', behavior: 'instant' });
      }
      updateScrollDownButton();
    });
  }

  try {
    for await (const ev of turnEvents(traceId)) {
      switch (ev.type) {
        case 'queued': {
          markTurnClockStarted();
          // The submission itself, delivered on the stream. Render its user bubble here (in delta
          // order). queued > 0 ⇒ it's waiting behind a running turn → float the egg-timer; queued
          // === 0 ⇒ it runs immediately → show loading dots. A content event later promotes it.
          if (!userBubble) {
            const text = (ev.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
            // Adopt an already-rendered bubble for this turn rather than draw a second one: on reload /
            // navigate-back the running turn's user message is in committed history (renderSession drew
            // it, tagged with traceId), and the server now also seeds this turn's replay with a `queued`
            // so a late-connecting stream still gets the bubble. Idempotent: whichever arrived first wins.
            const existing = messagesEl.querySelector(`.message[data-trace="${traceId}"]`);
            if (existing) {
              userBubble = existing;
              userBubbleText = existing.querySelector('.md-body')?.textContent ?? text;
            } else if (text) {
              // A robo turn (followup resubmit) arrives all-robo → agent-side bubble. Live submissions
              // are never mixed (a hook-augmented turn only shows its split on reload, from committed
              // history), so an all-or-nothing check here is enough.
              const robo = (ev.content ?? []).some(c => c.type === 'text' && c.origin === 'robo');
              userBubble = robo ? appendRoboBubble(text, undefined, traceId) : appendUserBubble(text, undefined, ev.queued > 0, traceId);
              userBubbleText = text;
            }
          }
          if (ev.queued === 0) markStarted();
          break;
        }

        case 'queued-append': {
          markTurnClockStarted();
          // A later submission the runner folded into this turn (concat policy). Grow the head bubble
          // so the UI matches the single merged user message that gets persisted. Joined with '\n' to
          // match how renderSession concatenates a multi-block user message on reload.
          const text = (ev.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
          if (userBubble && text) {
            userBubbleText = userBubbleText ? `${userBubbleText}\n${text}` : text;
            const inner = userBubble.querySelector('.md-body');
            if (inner) inner.innerHTML = md(userBubbleText);
          }
          break;
        }

        case 'text-delta':
          markTurnClockStarted();
          removeLoading();
          if (textElFinalised) { textEl = null; textAccum = ''; textElFinalised = false; }
          textAccum += ev.delta;
          getOrMakeTextEl().innerHTML = md(textAccum);
          scrollToOutputStart();
          break;

        case 'thinking': {
          markTurnClockStarted();
          removeLoading();
          if (!thinkingContent) {
            const { details, content: c } = makeThinkingBlock('\ud83d\udcad Thinking', true);
            // Insert before text so thinking appears above the response
            turnWrap.insertBefore(details, textEl);
            thinkingContent = c;
          }
          thinkingAccum += ev.delta;
          thinkingContent.textContent = thinkingAccum;
            // If no text content yet, scroll to show the user processing is happening.
            if (!turnWrap.querySelector('.msg-text') && !isScrollSuppressed()) {
              programmaticScrollTo(() => {
                turnWrap.scrollIntoView({ block: 'end', behavior: 'instant' });
              });
            }
          break;
        }

        case 'tool:start': {
          markTurnClockStarted();
          removeLoading();
          if (ev.name === 'provider') providerToolPending = true;
          currentTool = makeToolBlock(ev.name, ev.input, ev.callId);
          currentTool.open = true;
          turnWrap.appendChild(currentTool);
            // If no text content yet, scroll to show the user processing is happening.
            if (!turnWrap.querySelector('.msg-text') && !isScrollSuppressed()) {
              programmaticScrollTo(() => {
                turnWrap.scrollIntoView({ block: 'end', behavior: 'instant' });
              });
            }
          break;
        }

        case 'tool:stdout':
        case 'tool:stderr': {
          markTurnClockStarted();
          if (currentTool) {
            let outEl = currentTool.querySelector('.tool-output');
            if (!outEl) {
              outEl = document.createElement('pre');
              outEl.className = 'tool-output';
              currentTool.appendChild(outEl);
            }
            outEl.textContent += ev.chunk;
            outEl.scrollTop = outEl.scrollHeight;
          }
          break;
        }

        case 'tool:end': {
          markTurnClockStarted();
          if (currentTool) {
            currentTool.appendChild(makeToolResultBlock(ev.result, ev.isError));
            currentTool.open = false;
          }
          currentTool = null;
          textElFinalised = true;
          textAccum = '';
          if (providerToolPending && !ev.isError) { providerToolPending = false; refreshProviderSelect(); }
          break;
        }

        case 'usage':
          markTurnClockStarted();
          turnIn  += ev.inputTokens;
          turnOut += ev.outputTokens;
          if (ev.costUsd              !== undefined) turnCost        += ev.costUsd;
          if (ev.cacheReadTokens     !== undefined) turnCacheRead   += ev.cacheReadTokens;
          if (ev.cacheCreationTokens !== undefined) turnCacheCreate += ev.cacheCreationTokens;
          break;

        case 'prompt': {
          markTurnClockStarted();
          removeLoading();
          const field      = ev.field;
          const rawQ       = ev.question ?? '';
          // Buttons come from a structured select/confirm field; failing that, from a
          // legacy trailing [A/B] in the question text. Otherwise it's a free-text input.
          const choiceMatch = field ? null : /\[([^\/\]]+)\/([^\/\]]+)\]\s*$/.exec(rawQ);
          const choices = field
            ? (field.type === 'select'  ? (field.options ?? [])
             : field.type === 'confirm' ? ['yes', 'no']
             : null)
            : (choiceMatch ? [choiceMatch[1], choiceMatch[2]] : null);
          const questionText = field ? field.label
            : (choiceMatch ? rawQ.slice(0, choiceMatch.index).trimEnd() : rawQ);
          const defaultValue = field ? field.default : ev.defaultValue;
          const inputType    = field && field.type === 'password' ? 'password' : 'text';
          // Cancel is the "give up" path (default on); only an explicit cancelable:false suppresses it.
          const cancelable   = !(field && field.cancelable === false);
          const allowOther   = !!(field && field.type === 'select' && field.allowOther);
          const result = await new Promise(resolve => {
            const block = document.createElement('div');
            block.className = 'prompt-block';
            // Settle the dialog: disable every control (incl. the cancel ×) once answered or cancelled.
            const done = () => block.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
            if (cancelable) {
              const x = document.createElement('button');
              x.type = 'button';
              x.className = 'prompt-cancel-x';
              x.title = 'Cancel';
              x.setAttribute('aria-label', 'Cancel');
              x.textContent = '×';
              x.onclick = () => { done(); resolve({ cancelled: true }); };
              block.appendChild(x);
            }
            const q = document.createElement('div');
            q.className = 'prompt-question';
            q.innerHTML = md(questionText);
            block.appendChild(q);
            if (choices) {
              const row = document.createElement('div');
              row.className = 'prompt-choices';
              let defaultBtn = null;
              for (const choice of choices) {
                const btn = document.createElement('button');
                btn.type = 'button';
                const isDefault = choice.toLowerCase() === (defaultValue ?? '').toLowerCase();
                btn.className = 'prompt-choice-btn' + (isDefault ? ' primary' : '');
                const cl = choice.toLowerCase();
                btn.textContent = cl === 'y' || cl === 'yes' ? 'Yes'
                  : cl === 'n' || cl === 'no' ? 'No'
                  : choice;
                btn.onclick = () => { done(); resolve({ answer: choice }); };
                if (isDefault) defaultBtn = btn;
                row.appendChild(btn);
              }
              if (allowOther) {
                const otherBtn = document.createElement('button');
                otherBtn.type = 'button';
                otherBtn.className = 'prompt-choice-btn';
                otherBtn.textContent = 'Other…';
                otherBtn.onclick = () => {
                  row.querySelectorAll('button').forEach(b => { b.disabled = true; });
                  const orow = document.createElement('div');
                  orow.className = 'prompt-row';
                  const inp = document.createElement('textarea');
                  inp.className = 'prompt-input';
                  inp.rows = 2;
                  const sbtn = document.createElement('button');
                  sbtn.type = 'button';
                  sbtn.className = 'prompt-submit';
                  sbtn.textContent = 'Submit';
                  const submitOther = () => {
                    const v = inp.value.trim();
                    if (field.required && !v) return;
                    done();
                    resolve({ answer: v });
                  };
                  sbtn.onclick = submitOther;
                  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitOther(); } });
                  orow.appendChild(inp);
                  orow.appendChild(sbtn);
                  block.appendChild(orow);
                  inp.focus();
                };
                row.appendChild(otherBtn);
              }
              block.appendChild(row);
              turnWrap.appendChild(block);
              // Prompt requires user attention — scroll to show it.
              if (!isScrollSuppressed()) {
                programmaticScrollTo(() => {
                  messagesEl.scrollTop = messagesEl.scrollHeight;
                });
              }
              (defaultBtn ?? row.querySelector('button'))?.focus();
            } else {
              const row = document.createElement('div');
              row.className = 'prompt-row';
              const inp = document.createElement('input');
              inp.type = inputType;
              inp.className = 'prompt-input';
              inp.value = defaultValue ?? '';
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'prompt-submit';
              btn.textContent = 'Submit';
              const submit = () => {
                done();
                resolve({ answer: inp.value.trim() || defaultValue || '' });
              };
              btn.onclick = submit;
              inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
              row.appendChild(inp);
              row.appendChild(btn);
              block.appendChild(row);
              turnWrap.appendChild(block);
              if (!isScrollSuppressed()) {
                programmaticScrollTo(() => {
                  messagesEl.scrollTop = messagesEl.scrollHeight;
                });
              }
              inp.focus();
            }
          });
          await T.answerPrompt(sid, result.cancelled ? { cancel: true } : { answer: result.answer });
          break;
        }

        case 'robo-user': {
          markTurnClockStarted();
          // Machine-authored content folded onto the running turn's user message (a screen hook's
          // `durable` result — e.g. a fired `contextual` trigger). Draw it as an agent-side robo
          // bubble so the live view matches the reload, where appendUserTurn splits the user turn's
          // robo blocks into exactly such a bubble.
          const text = (ev.content ?? [])
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
          if (text) appendRoboBubble(text, undefined, ev.traceId);
          break;
        }

        case 'marker': {
          markTurnClockStarted();
          // A marker appended to the session this turn (e.g. a hook that threw). Render it inline now;
          // on a later reload it comes back through renderSession's role==='marker' path identically.
          removeLoading();
          appendMarker(ev.content ?? [], ev.traceId);
          break;
        }

        case 'aborted': {
          markTurnClockStarted();
          removeLoading();
          if (ev.reason === 'user-abort') {
            // Partial content already in DOM and saved to store — nothing to re-render.
          } else {
            if (turnWrap) turnWrap.remove();
            if (ev.session) renderSession(ev.session);
          }
          break;
        }

        case 'cancelled': {
          markTurnClockStarted();
          // This queued submission was dropped (Stop pressed before it ran). It never executed and
          // was never persisted, so remove its bubble and (if any) its empty turn entirely.
          if (loadingEl) { loadingEl.remove(); loadingEl = null; }
          if (turnWrap) turnWrap.remove();
          if (userBubble) userBubble.remove();
          break;
        }

        case 'done':
          markTurnClockStarted();
          if (thinkingContent) {
            const det = thinkingContent.closest('details');
            if (det) det.open = false;
          }
          if (ev.session?.title && chatHeaderEl) chatTitleEl.textContent = ev.session.title;
          refreshTitlesAfterFollowup();
          appendTurnStats();
          loadFiles();
          // Back-fill origIdx on any dividers added without an index this turn.
          if (ev.session) {
            const allDividers = [...messagesEl.querySelectorAll('.msg-divider')];
            const unindexed   = allDividers.filter(d => d.dataset.msgIdx === undefined);
            if (unindexed.length > 0) {
              const indexed  = allDividers.filter(d => d.dataset.msgIdx !== undefined);
              const lastIdx  = indexed.length > 0 ? parseInt(indexed[indexed.length - 1].dataset.msgIdx) : -1;
              const newIdxs  = ev.session.messages
                .map((m, i) => ({ m, i }))
                .filter(({ m, i }) => m.role === 'user' && i > lastIdx)
                .map(({ i }) => i);
              for (let j = 0; j < Math.min(unindexed.length, newIdxs.length); j++) {
                unindexed[j].dataset.msgIdx = newIdxs[j];
              }
            }
          }
          break;

        case 'error': {
          removeLoading();
          const errDiv = document.createElement('div');
          errDiv.className = 'msg-error';
          errDiv.textContent = '[error: ' + (ev.error ?? ev.message ?? 'unknown') + ']';
          turnWrap.appendChild(errDiv);
          break;
        }
      }
      // NOTE: deliberately NO messagesEl.scrollTop = messagesEl.scrollHeight here.
      // We scrolled once to the output start; continuous bottom-chasing is gone.
    }
  } catch (e) {
    removeLoading();
    const errDiv = document.createElement('div');
    errDiv.className = 'msg-error';
    errDiv.textContent = '[error: ' + e.message + ']';
    turnWrap.appendChild(errDiv);
  } finally {
    // Don't markStarted() here — a turn that was only queued then cancelled must not spawn an empty
    // assistant wrap. Just clear any loading dots that are still showing.
    if (loadingEl) { loadingEl.remove(); loadingEl = null; }
    apiListSessions().then(renderSessions);
    loadFiles();
    // If the output extends below the viewport fold, morph the send button
    // into a ▼ down-arrow so the user can jump to the bottom with one click.
    maybeShowScrollDown();
  }
}

// ── Send / Stop button handlers ───────────────────────────────────────────────
//
// Send has three visual modes in one fixed slot: scroll-down (▼), stop (■), or default send (▶).
// The input stays live during a turn so you can type-ahead, but the action button aborts while busy.
sendBtn.onclick = () => {
  if (sendBtn.classList.contains('scroll-down-mode')) scrollToBottomAndReset();
  else if (sending) requestStop();
  else sendMessage();
};

document.getElementById('sessions-enable-btn').onclick = () => {
  submit('Discover the local plugins and add the sessions plugin to enable persistent conversations.');
};

inputEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  // Plain Enter → queued (own turn, run in order). Ctrl/Cmd+Enter → concat (fold into the running
  // batch). Shift+Enter keeps the textarea's newline behaviour.
  if (e.shiftKey) return;
  e.preventDefault();
  sendMessage(e.ctrlKey || e.metaKey);
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
});

// Sync the single send/stop affordance to a session's busy state. Called from each path that changes
// which session is in view and from the live status stream, so the button always reflects the
// session on screen, not stale state from the previously-viewed session.
function setBusyState(busy) {
  sending = busy;
  if (busy) showStopButton();
  else resetSendButton();
}

function requestStop() {
  const target = currentSessionId;
  if (!target) return;
  sendBtn.disabled = true;
  // Aborts the running turn AND drops everything still queued for the session; the resulting
  // aborted/cancelled events tidy the rendered turns over the persistent stream.
  Promise.resolve(T.abort(target))
    .catch(() => {})
    .finally(() => { sendBtn.disabled = false; });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Configure marked
  if (typeof marked !== 'undefined') {
    marked.use({ breaks: true, gfm: true });
  }

  {
    const MIN = 10, MAX = 22;
    function adjust(delta) {
      const cur = parseFloat(getComputedStyle(document.body).fontSize);
      const next = Math.min(MAX, Math.max(MIN, Math.round(cur) + delta));
      document.documentElement.style.setProperty('--fs', next + 'px');
      localStorage.setItem(LS_FONT_SIZE, next);
    }
    document.getElementById('fs-down').addEventListener('click', () => adjust(-1));
    document.getElementById('fs-up').addEventListener('click',   () => adjust(+1));
  };

  // ── Attach scroll listeners for user-scroll detection ─────────
  // 'wheel' catches mouse wheel + trackpad gestures.
  // 'touchmove' catches finger-drags on touch screens.
  // The 'scroll' event on #messages catches scrollbar dragging and
  // keyboard scrolling (PgUp / PgDn / arrows when messagesEl is focused).
  // We use the programmaticScroll flag to ignore scrolls we triggered.
  messagesEl.addEventListener('wheel', onUserScroll, { passive: true });
  messagesEl.addEventListener('touchmove', onUserScroll, { passive: true });
    messagesEl.addEventListener('scroll', () => {
    if (!programmaticScroll) {
      scrollSuppressUntil = Date.now() + 5000;   // 100ms (testing)
      // Update floating ▼ button visibility.
      updateScrollDownButton();
    }
  });

  // ── Floating scroll-down button ──
  scrollDownBtn = document.getElementById('scroll-down-btn');
  if (scrollDownBtn) {
    scrollDownBtn.onclick = () => {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
      inputEl.focus();
    };
  }

  const [sessions, providers] = await Promise.all([apiListSessions(), apiListProviders(), loadWorkspaces()]);

  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = p;
    providerSel.appendChild(opt);
  }

  const savedProvider = localStorage[LS_PROVIDER];
  if (savedProvider && providers.includes(savedProvider)) {
    providerSel.value = savedProvider;
  }

  providerSel.addEventListener('change', () => {
    localStorage.setItem(LS_PROVIDER, providerSel.value);
  });

  // Subscribe to session busy/idle transitions (the transport owns the wire + reconnect).
  (async function connectStatusStream() {
    for await (const { sessionId, busy } of T.statusEvents(new AbortController().signal)) {
      const item = sessionListEl.querySelector('[data-sid="' + sessionId + '"]');
      if (busy) {
        busySessions.add(sessionId);
        unreadSessions.delete(sessionId);
        if (item) { item.classList.add('busy'); item.classList.remove('unread'); }
      } else {
        busySessions.delete(sessionId);
        if (sessionId !== currentSessionId) {
          unreadSessions.add(sessionId);
          if (item) { item.classList.remove('busy'); item.classList.add('unread'); }
        } else {
          if (item) item.classList.remove('busy');
        }
      }
      // Drive the Stop button + the busy flag for the session currently in view.
      if (sessionId === currentSessionId) setBusyState(busy);
    }
  })();

  // Subscribe to file-change events. The stream carries every namespace; this panel shows the
  // workspace, so ignore events for other namespaces before touching it.
  (async function connectFileWatchStream() {
    for await (const event of T.fileEvents(new AbortController().signal)) {
      if (event.namespace !== 'workspace') continue;
      const { name } = event;
      const el = document.getElementById('file-list');
      const item = el?.querySelector('[data-path="' + CSS.escape(name) + '"]');
      if (item) {
        updatedFiles.add(name);
        item.classList.add('updated');
        // Update the size display if present.
        const sizeEl = item.querySelector('.file-size');
        if (sizeEl && event.size !== undefined) sizeEl.textContent = formatSize(event.size);
      } else {
        // New file — mark updated before reloading so the dot appears.
        updatedFiles.add(name);
        loadFiles();
      }
    }
  })();

  // Tool-registry CRUD → refresh the skills panel (skills are tools; a skill_action registered out
  // of band — e.g. the Drive backend restoring matbot-skills at boot, after this UI's one-shot loads
  // — surfaces here). Debounced: one plugin load fires many tool-changed events, want one re-query.
  (async function connectToolWatchStream() {
    if (!T.toolEvents) return;
    let timer = null;
    for await (const _event of T.toolEvents(new AbortController().signal)) {
      if (timer) continue;
      timer = setTimeout(() => { timer = null; loadSkills(); }, 150);
    }
  })();

  // Skill content saved/deleted — incl. by the LLM mid-turn via skill_action, which this UI's own
  // save/delete buttons already refresh after locally but has no other way to learn about.
  (async function connectSkillWatchStream() {
    if (!T.skillEvents) return;
    let timer = null;
    for await (const _event of T.skillEvents(new AbortController().signal)) {
      if (timer) continue;
      timer = setTimeout(() => { timer = null; loadSkills(); }, 150);
    }
  })();

  // Plugin load/unload → refresh the plugins panel. Catches tool-less plugins the tool stream can't
  // see (pure provider/hook/storage), and supersedes the old poll-on-`plugin`-tool-success refresh.
  (async function connectPluginWatchStream() {
    if (!T.pluginEvents) return;
    let timer = null;
    for await (const _event of T.pluginEvents(new AbortController().signal)) {
      if (timer) continue;
      timer = setTimeout(() => { timer = null; loadPlugins(); loadExperts(); }, 150);
    }
  })();

  renderSessions(sessions);

  // Dismiss open divider menus on any background click.
  document.addEventListener('click', () => {
    document.querySelectorAll('.msg-divider.open').forEach(d => d.classList.remove('open'));
  });

  const rawFragment = decodeURIComponent(location.hash.slice(1));
  const tildeIdx    = rawFragment.indexOf('~');
  const fragmentSid = tildeIdx >= 0 ? rawFragment.slice(0, tildeIdx) : rawFragment;
  const fragmentNav = tildeIdx >= 0 ? (() => { try { return JSON.parse(rawFragment.slice(tildeIdx + 1)); } catch { return null; } })() : null;
  const startId     = (fragmentSid && sessions.some(s => s.id === fragmentSid))
    ? fragmentSid : sessions[0]?.id;
  if (startId === 'new') {
    await handleNewSession();
  } else if (startId) {
    await openSession(startId, fragmentNav?.msg);
  } else {
    showEmpty();
    setBusyState(false);
  }
  loadFiles();
  loadPlugins();
  loadSkills();
  loadExperts();
}

// ── File drag-drop + upload button ───────────────────────────────────────────

const filesSectionEl = document.querySelector('[data-section="files"]');
if (filesSectionEl) {
  filesSectionEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    filesSectionEl.classList.add('drop-over');
  });
  filesSectionEl.addEventListener('dragleave', (e) => {
    if (!filesSectionEl.contains(e.relatedTarget)) filesSectionEl.classList.remove('drop-over');
  });
  filesSectionEl.addEventListener('drop', (e) => {
    e.preventDefault();
    filesSectionEl.classList.remove('drop-over');
    if (e.dataTransfer?.files.length) uploadFiles(e.dataTransfer.files);
  });
}

document.getElementById('upload-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('upload-input')?.click();
});
document.getElementById('upload-input')?.addEventListener('change', function() {
  if (this.files?.length) { uploadFiles(this.files); this.value = ''; }
});

window.addEventListener('hashchange', async () => {
  const raw      = location.hash.slice(1);
  const ti       = raw.indexOf('~');
  const id       = ti >= 0 ? raw.slice(0, ti) : raw;
  const nav      = ti >= 0 ? (() => { try { return JSON.parse(raw.slice(ti + 1)); } catch { return null; } })() : null;
  if (id === 'new') {
    await handleNewSession();
  } else if (id && id !== currentSessionId) {
    await openSession(id, nav?.msg).catch(console.error);
  } else if (id === currentSessionId && nav?.msg !== undefined) {
    history.replaceState(null, '', location.pathname + '#' + id);
    scrollToMsgIdx(nav.msg);
  }
});

init().catch(console.error);
