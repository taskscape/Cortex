// Cortex chat shell. Product panels register their own UI, state and handlers.
(async()=>{
const ui=await window.CortexUI.prepare(window.matbotTransport);
const featureApis={};
// Provider selection belongs to conversation UI and works without administration tools.
function createProviderPicker(host){
const LS_PROVIDER       = 'provider';

function providerStorageKey(workspaceId = host.activeWorkspaceId()) {
  return `${LS_PROVIDER}:${workspaceId || 'default'}`;
}

function savedProviderForWorkspace(workspaceId = host.activeWorkspaceId()) {
  const scoped = localStorage.getItem(providerStorageKey(workspaceId));
  if (scoped) return scoped;
  // Migrate the former global preference for the default workspace only.
  return workspaceId === 'default' ? (localStorage.getItem(LS_PROVIDER) || '') : '';
}

let providerDiscoveryFailed = false;

const providerSel    = document.getElementById('provider-select');


async function apiListProviders() {
  try {
    const providers = (await host.transport.listProviders()).providers.map(p => p.name);
    providerDiscoveryFailed = false;
    return providers;
  } catch {
    providerDiscoveryFailed = true;
    return [];
  }
}

async function refreshProviderSelect() {
  const generation = host.workspaceGeneration;
  const workspaceId = host.activeWorkspaceId();
  const previous = providerSel.value || savedProviderForWorkspace(workspaceId);
  let providers;
  try {
    providers = (await host.transport.listProviders()).providers.map(p => p.name);
    providerDiscoveryFailed = false;
  } catch {
    providerSel.dataset.error = 'Provider list unavailable. Check the active workspace and retry after Cortex restarts.';
    providerSel.title = providerSel.dataset.error;
    return false;
  }
  if (generation !== host.workspaceGeneration || workspaceId !== host.activeWorkspaceId()) return false;
  const saved = savedProviderForWorkspace(workspaceId);
  providerSel.innerHTML = '';
  delete providerSel.dataset.error;
  providerSel.title = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = p;
    providerSel.appendChild(opt);
  }
  providerSel.value = providers.includes(saved)
    ? saved
    : (providers.includes(previous) ? previous : (providers[0] ?? ''));
  localStorage.setItem(providerStorageKey(workspaceId), providerSel.value);
  return true;
}


return {get LS_PROVIDER(){return LS_PROVIDER},
get providerStorageKey(){return providerStorageKey},
get savedProviderForWorkspace(){return savedProviderForWorkspace},
get providerDiscoveryFailed(){return providerDiscoveryFailed},set providerDiscoveryFailed(value){providerDiscoveryFailed=value},
get providerSel(){return providerSel},
get apiListProviders(){return apiListProviders},
get refreshProviderSelect(){return refreshProviderSelect}};
}
const providerPicker=createProviderPicker({transport:window.matbotTransport,activeWorkspaceId:()=>featureApis.workspace?.activeWorkspaceId?.()??'default',get workspaceGeneration(){return workspaceGeneration;}});
const LS_FONT_SIZE      = 'fontSize';

const LS_SIDEBAR        = 'sidebarSections';

const LS_SIDEBAR_WIDTH  = 'sidebarWidth';

const SIDEBAR_ACCORDION_SECTIONS = new Set(['files', 'architecture', 'plugins', 'skills']);

function applyBranding(value) {
  if (!value || typeof value !== 'object') return;
  const productName = typeof value.productName === 'string' && value.productName.trim() ? value.productName.trim() : 'Cortex';
  const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : productName;
  document.title = title;
  const brandTitle = document.getElementById('brand-title');
  if (brandTitle) brandTitle.textContent = productName;
  const composer = document.getElementById('input');
  if (composer) composer.placeholder = `Ask ${productName}...`;
  const root = document.documentElement;
  for (const [key, cssVariable] of [['brand', '--brand'], ['brandStrong', '--brand-strong'], ['brandSoft', '--brand-soft']]) {
    if (typeof value[key] === 'string') root.style.setProperty(cssVariable, value[key]);
  }
}

let currentSessionId = null;

let sending = false;

const busySessions   = new Set();

const unreadSessions = new Set();

let workspaceGeneration = 0;

let scrollSuppressUntil = 0;

let programmaticScroll = false;

function isScrollSuppressed() {
  return Date.now() < scrollSuppressUntil;
}

function programmaticScrollTo(fn) {
  programmaticScroll = true;
  fn();
  // Reset the flag asynchronously — the browser fires 'scroll' synchronously
  // (or at least before the next rAF), so this is safe.
  requestAnimationFrame(() => { programmaticScroll = false; });
}

function onUserScroll() {
  if (!programmaticScroll) {
    scrollSuppressUntil = Date.now() + 5000;   // 100ms suppression (temp for testing)
  }
}

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

const ICON_SEND   = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M9 6v12l9-6z"/></svg>';

const ICON_SCROLL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

const ICON_STOP   = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';

const ICON_TRASH  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';

function showScrollDownButton() {
  sendBtn.innerHTML = ICON_SCROLL;
  sendBtn.classList.add('scroll-down-mode');
}

function scrollToBottomAndReset() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  resetSendButton();
  inputEl.focus();
}

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

let scrollDownBtn = null;

function updateScrollDownButton() {
  if (!scrollDownBtn) return;
  if (isMessagesBottomVisible()) {
    scrollDownBtn.style.display = 'none';
  } else {
    scrollDownBtn.style.display = 'flex';
  }
}

const messagesEl     = document.getElementById('messages');

const sessionsBanner = document.getElementById('sessions-banner');

const sessionListEl  = document.getElementById('session-list');

const chatHeaderEl   = document.getElementById('chat-header');

const chatTitleEl    = document.getElementById('chat-title');

const inputEl        = document.getElementById('input');

const sendBtn        = document.getElementById('send-btn');

const stopBtn        = document.getElementById('stop-btn');

const newBtn         = document.getElementById('new-btn');

const burgerBtn      = document.getElementById('burger');

const sidebarOverlay = document.getElementById('sidebar-overlay');

const architectureScreenEl = document.getElementById('architecture-screen');

const architectureTitleEl = document.getElementById('architecture-title');

let architectureNavBtns = Array.from(document.querySelectorAll('.architecture-nav-btn'));

let architectureTabBtns = Array.from(document.querySelectorAll('.architecture-tab'));

let architecturePanelEls = Array.from(document.querySelectorAll('.architecture-panel'));

let architectureView = 'sources';

function closeSidebar() { document.body.classList.remove('sidebar-open'); }

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
    let expandedAccordionSection = null;
    for (const section of document.querySelectorAll('.sidebar-section[data-section]')) {
      if (!SIDEBAR_ACCORDION_SECTIONS.has(section.dataset.section) || section.classList.contains('collapsed')) continue;
      if (expandedAccordionSection) section.classList.add('collapsed');
      else expandedAccordionSection = section;
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

function escHtml(s) {
  return String(s).replace(/[&<>\"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c] ?? c));
}

function md(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') return '<p>' + escHtml(text) + '</p>';
  const template = document.createElement('template');
  template.innerHTML = marked.parse(text);
  const blocked = 'script,style,iframe,object,embed,form,input,button,textarea,select,option,meta,link,base,img';
  for (const node of template.content.querySelectorAll(blocked)) node.remove();
  const safeUrl = value => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return true;
    if (/^\/\//.test(trimmed)) return false;
    if (/^(?:https?:|mailto:|#|\/(?!\/)|\.{0,2}\/)/i.test(trimmed)) return true;
    try {
      const parsed = new URL(trimmed, window.location.href);
      return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  };
  for (const element of template.content.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === 'href' || name === 'src' || name === 'xlink:href') && !safeUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  for (const anchor of template.content.querySelectorAll('a[href]')) {
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  }
  return template.innerHTML;
}

const T = window.matbotTransport;

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

async function callTool(toolName, input) {
  return T.callTool(toolName, input);
}

let ARCHITECTURE_PANEL_TITLES = {
  sources: 'Sources',
  sql: 'SQL Preview',
  workflows: 'Workflow Operations Center',
  evaluation: 'Evaluation, Observability & ROI',
  graph: 'Graph Entities',
  reviews: 'Expert Reviews',
  plugins: 'Plugins',
};

let ARCHITECTURE_HASH_VIEWS = new Set(Object.keys(ARCHITECTURE_PANEL_TITLES));

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
  if (open && !options.skipWorkspace) featureApis.rag.setWorkspaceSettingsOpen(false);
  if (open) featureApis.memory.closeMemoryBrowser();
  architectureScreenEl.classList.toggle('open', Boolean(open));
  document.body.classList.toggle('architecture-open', Boolean(open));
  if (!open) {
    featureApis.workflows.stopWorkflowOpsAutoRefresh();
    return;
  }
  activateArchitecturePanel(view);
  closeSidebar();
  loadArchitecturePanel(view).catch(err => {
    const statusEl = architectureStatusElement(view);
    architectureStatus(statusEl, String(err?.message || err), true);
  });
}

function architectureStatusElement(view){const id=ui.descriptors.find(d=>d.view===view)?.id;return id?featureApis[id]?.status?.():null;}

function activateArchitecturePanel(view) {
  architectureView = ARCHITECTURE_PANEL_TITLES[view] ? view : Object.keys(ARCHITECTURE_PANEL_TITLES)[0];
  if (!architectureView) { setArchitectureOpen(false); return; }
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
  if (architectureView === 'workflows') featureApis.workflows.scheduleWorkflowOpsAutoRefresh();
  else featureApis.workflows.stopWorkflowOpsAutoRefresh();
  if (architectureView !== 'sources' && featureApis.sources.architectureSourceHealthModalEl) featureApis.sources.architectureSourceHealthModalEl.hidden = true;
  if (architectureScreenEl?.classList.contains('open')) {
    history.replaceState(null, '', `${location.pathname}#${architectureView}`);
  }
}

async function loadArchitecturePanel(view,force=false){const id=ui.descriptors.find(d=>d.view===view)?.id;return id?featureApis[id]?.activate?.(force):undefined;}

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

const TITLE_REFRESH_DELAYS_MS = [1500, 5000];

let titleRefreshTimers = [];

function refreshTitlesAfterFollowup() {
  // Debounce: keep at most one pending pair of refreshes.
  for (const t of titleRefreshTimers) clearTimeout(t);
  titleRefreshTimers = [];

  for (const delay of TITLE_REFRESH_DELAYS_MS) {
    titleRefreshTimers.push(setTimeout(() => {
      apiListSessions().then(sessions => {
        renderSessions(sessions);
        const current = sessions.find(s => s.id === currentSessionId);
        if (current?.title && chatHeaderEl) chatTitleEl.textContent = current.title;
      }).catch(() => {});
    }, delay));
  }
}

async function apiNewSession() {
  return T.createSession();
}

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

function showEmpty() {
  messagesEl.innerHTML =
    '<div class=\"empty-state\">' +
    '<strong>Start a conversation</strong>' +
    '<span>Type a message below to begin.</span>' +
    '</div>';
}

function truncateAtWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function renderSessions(sessions) {
  sessionListEl.innerHTML = '';
  for (const s of sessions) {
    const label = truncateAtWord(s.title || s.preview || s.id.slice(0, 8), 44);
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

function appendMessageAttachments(bubble, content) {
  if (!bubble) return;
  const refs = (content ?? []).filter(part => part.type === 'file-ref');
  if (!refs.length) return;
  let tray = bubble.querySelector('.message-attachments');
  if (!tray) {
    tray = document.createElement('div');
    tray.className = 'message-attachments';
    bubble.appendChild(tray);
  }
  for (const ref of refs) {
    if ([...tray.children].some(item => item.dataset.attachmentPath === ref.name)) continue;
    const attachment = document.createElement('button');
    attachment.type = 'button';
    attachment.className = 'message-attachment';
    attachment.dataset.attachmentPath = ref.name;
    attachment.title = `Open workspace file ${ref.name}`;
    attachment.onclick = () => T.openFile('workspace', ref.name);
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '📎';
    attachment.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'message-attachment-name';
    name.textContent = ref.name;
    attachment.appendChild(name);
    tray.appendChild(attachment);
  }
}

function appendUserTurn(content, msgIdx, traceId) {
  const runs = [];
  for (const c of content) {
    if (c.type !== 'text' || !c.text) continue;
    const robo = c.origin === 'robo';
    const prev = runs[runs.length - 1];
    if (prev && prev.robo === robo) prev.text += '\n' + c.text;
    else runs.push({ robo, text: c.text });
  }
  const attachments = content.filter(c => c.type === 'file-ref');
  if (!runs.length && !attachments.length) return null;
  messagesEl.querySelector('.empty-state')?.remove();
  if (messagesEl.querySelector('.message')) {
    messagesEl.appendChild(createMsgDivider(msgIdx));
  }
  let last = null;
  let lastHuman = null;
  for (const run of runs) {
    last = makeBubble(run.robo ? 'robo' : 'user', run.text);
    // Tag with the turn's traceId so a replayed `queued` for this still-running turn adopts the
    // existing bubble (renderTurn) instead of drawing a second one.
    if (traceId) last.dataset.trace = traceId;
    messagesEl.appendChild(last);
    if (!run.robo) lastHuman = last;
  }
  if (!last && attachments.length) {
    last = makeBubble('user', '');
    if (traceId) last.dataset.trace = traceId;
    messagesEl.appendChild(last);
  }
  appendMessageAttachments(lastHuman ?? last, attachments);
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

async function openSession(id, scrollTarget) {
  closeSidebar();
  setArchitectureOpen(false);
  featureApis.rag.setWorkspaceSettingsOpen(false);
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
  featureApis.files.loadFiles();
  inputEl.focus();
}

let newSessionPromise = null;

function handleNewSession() {
  if (newSessionPromise) return newSessionPromise;

  closeSidebar();
  setArchitectureOpen(false);
  featureApis.rag.setWorkspaceSettingsOpen(false);
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

async function submitFormResponse(sessionId, values) {
  if (!sessionId) return;
  // A form answer is just another submission; it renders over the persistent stream like any turn.
  await postSubmit(sessionId, { type: 'form-response', values });
}

let streamSessionId = null;

let streamAc        = null;

let streamReady     = Promise.resolve();

const turnQueues    = new Map();

let activeBatchHead = null;

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

async function sendMessage(concat = false) {
  if (featureApis.experts.expertEnabledEl?.checked) {
    await featureApis.experts.runExpertPanelFromUi();
    return;
  }
  const content = inputEl.value.trim();
  if (!content) return;
  const attachments = [...featureApis.files.selectedWorkspaceFiles.values()]
    .map(file => ({ namespace: 'workspace', path: file.path }));
  inputEl.value = '';
  inputEl.style.height = 'auto';
  if (await submit(content, concat, attachments)) {
    featureApis.files.clearWorkspaceFileAttachments();
  } else {
    inputEl.value = content;
  }
}

async function submit(content, concat = false, attachments = []) {
  const provider = providerPicker.providerSel.value;
  if (!content) return false;
  if (!provider) {
    showSubmitError(content, 'no model provider is available in the active workspace');
    return false;
  }
  if (newSessionPromise && !(await newSessionPromise)) return false;
  if (!currentSessionId) {
    const { id } = await apiNewSession();
    currentSessionId = id;
  }
  // Ensure the persistent event stream is bound to this session before we enqueue, so the turn's
  // events have a consumer (covers the just-created session and the "New session" button path).
  await connectSessionStream(currentSessionId);
  return postSubmit(currentSessionId, content, concat, attachments);
}

async function postSubmit(sid, content, concat = false, attachments = []) {
  const provider = providerPicker.providerSel.value;
  if (!provider) return false;
  try {
    await T.submit(sid, {
      content,
      provider,
      concatQueue: concat,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    return true;
  } catch (e) {
    showSubmitError(content, e.name === 'TimeoutError' ? 'submit timed out (no response)' : (e.message || String(e)));
    return false;
  }
}

function showSubmitError(content, msg) {
  const text = typeof content === 'string' ? content : '';
  if (text) appendUserBubble(text);
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.textContent = '[send failed: ' + msg + ']';
  messagesEl.appendChild(div);
}

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
            appendMessageAttachments(userBubble, ev.content);
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
          appendMessageAttachments(userBubble, ev.content);
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
          if (providerToolPending && !ev.isError) { providerToolPending = false; providerPicker.refreshProviderSelect(); }
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
          featureApis.files.loadFiles();
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
    featureApis.files.loadFiles();
    // If the output extends below the viewport fold, morph the send button
    // into a ▼ down-arrow so the user can jump to the bottom with one click.
    maybeShowScrollDown();
  }
}

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

  const [sessions, providers] = await Promise.all([apiListSessions(), providerPicker.apiListProviders(), featureApis.workspace.loadWorkspaces()]);

  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = p;
    providerPicker.providerSel.appendChild(opt);
  }
  if (providerPicker.providerDiscoveryFailed) {
    const unavailable = document.createElement('option');
    unavailable.value = '';
    unavailable.textContent = 'Provider list unavailable — retry after restart';
    unavailable.disabled = true;
    unavailable.selected = true;
    providerPicker.providerSel.appendChild(unavailable);
    providerPicker.providerSel.dataset.error = unavailable.textContent;
    providerPicker.providerSel.title = 'Check the active workspace provider configuration and retry after Cortex restarts.';
  }

  const savedProvider = providerPicker.savedProviderForWorkspace();
  if (savedProvider && providers.includes(savedProvider)) {
    providerPicker.providerSel.value = savedProvider;
  }
  localStorage.setItem(providerPicker.providerStorageKey(), providerPicker.providerSel.value);

  providerPicker.providerSel.addEventListener('change', () => {
    localStorage.setItem(providerPicker.providerStorageKey(), providerPicker.providerSel.value);
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
        featureApis.files.updatedFiles.add(name);
        item.classList.add('updated');
        // Update the size display if present.
        const sizeEl = item.querySelector('.file-size');
        if (sizeEl && event.size !== undefined) sizeEl.textContent = featureApis.files.formatSize(event.size);
      } else {
        // New file — mark updated before reloading so the dot appears.
        featureApis.files.updatedFiles.add(name);
        featureApis.files.loadFiles();
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
      timer = setTimeout(() => { timer = null; featureApis.skills.loadSkills(); }, 150);
    }
  })();

  // Skill content saved/deleted — incl. by the LLM mid-turn via skill_action, which this UI's own
  // save/delete buttons already refresh after locally but has no other way to learn about.
  (async function connectSkillWatchStream() {
    if (!T.skillEvents) return;
    let timer = null;
    for await (const _event of T.skillEvents(new AbortController().signal)) {
      if (timer) continue;
      timer = setTimeout(() => { timer = null; featureApis.skills.loadSkills(); }, 150);
    }
  })();

  // Plugin load/unload → refresh the plugins panel. Catches tool-less plugins the tool stream can't
  // see (pure provider/hook/storage), and supersedes the old poll-on-`plugin`-tool-success refresh.
  (async function connectPluginWatchStream() {
    if (!T.pluginEvents) return;
    let timer = null;
    for await (const _event of T.pluginEvents(new AbortController().signal)) {
      if (timer) continue;
      timer = setTimeout(() => { timer = null; featureApis.runtime.loadPlugins(); featureApis.experts.loadExperts(); }, 150);
    }
  })();

  renderSessions(sessions);

  // Dismiss open divider menus on any background click.
  document.addEventListener('click', () => {
    document.querySelectorAll('.msg-divider.open').forEach(d => d.classList.remove('open'));
  });

  const rawFragment = decodeURIComponent(location.hash.slice(1));
  const startArchitectureView = ARCHITECTURE_HASH_VIEWS.has(rawFragment) ? rawFragment : null;
  const tildeIdx    = rawFragment.indexOf('~');
  const fragmentSid = tildeIdx >= 0 ? rawFragment.slice(0, tildeIdx) : rawFragment;
  const fragmentNav = tildeIdx >= 0 ? (() => { try { return JSON.parse(rawFragment.slice(tildeIdx + 1)); } catch { return null; } })() : null;
  const startId     = (!startArchitectureView && fragmentSid && sessions.some(s => s.id === fragmentSid))
    ? fragmentSid : sessions[0]?.id;
  if (startId === 'new') {
    await handleNewSession();
  } else if (startId) {
    await openSession(startId, fragmentNav?.msg);
  } else {
    showEmpty();
    setBusyState(false);
  }
  if (startArchitectureView) setArchitectureOpen(true, startArchitectureView);
  featureApis.files.loadFiles();
  featureApis.runtime.loadPlugins();
  featureApis.skills.loadSkills();
  featureApis.experts.loadExperts();
}
const featureHost={get LS_FONT_SIZE(){return LS_FONT_SIZE},
get providerPicker(){return providerPicker},
get LS_PROVIDER(){return providerPicker.LS_PROVIDER},
get LS_SIDEBAR(){return LS_SIDEBAR},
get LS_SIDEBAR_WIDTH(){return LS_SIDEBAR_WIDTH},
get SIDEBAR_ACCORDION_SECTIONS(){return SIDEBAR_ACCORDION_SECTIONS},
get applyBranding(){return applyBranding},
get providerStorageKey(){return providerPicker.providerStorageKey},
get savedProviderForWorkspace(){return providerPicker.savedProviderForWorkspace},
get currentSessionId(){return currentSessionId},set currentSessionId(value){currentSessionId=value},
get sending(){return sending},set sending(value){sending=value},
get busySessions(){return busySessions},
get unreadSessions(){return unreadSessions},
get updatedFiles(){return featureApis.files.updatedFiles},
get selectedWorkspaceFiles(){return featureApis.files.selectedWorkspaceFiles},
get knownWorkspaceFiles(){return featureApis.files.knownWorkspaceFiles},
get selectedWorkspaceOwner(){return featureApis.files.selectedWorkspaceOwner},set selectedWorkspaceOwner(value){featureApis.files.selectedWorkspaceOwner=value},
get workspaceGeneration(){return workspaceGeneration},set workspaceGeneration(value){workspaceGeneration=value},
get providerDiscoveryFailed(){return providerPicker.providerDiscoveryFailed},set providerDiscoveryFailed(value){providerPicker.providerDiscoveryFailed=value},
get scrollSuppressUntil(){return scrollSuppressUntil},set scrollSuppressUntil(value){scrollSuppressUntil=value},
get programmaticScroll(){return programmaticScroll},set programmaticScroll(value){programmaticScroll=value},
get isScrollSuppressed(){return isScrollSuppressed},
get programmaticScrollTo(){return programmaticScrollTo},
get onUserScroll(){return onUserScroll},
get isMessagesBottomVisible(){return isMessagesBottomVisible},
get ICON_SEND(){return ICON_SEND},
get ICON_SCROLL(){return ICON_SCROLL},
get ICON_STOP(){return ICON_STOP},
get ICON_TRASH(){return ICON_TRASH},
get showScrollDownButton(){return showScrollDownButton},
get scrollToBottomAndReset(){return scrollToBottomAndReset},
get resetSendButton(){return resetSendButton},
get showStopButton(){return showStopButton},
get scrollDownBtn(){return scrollDownBtn},set scrollDownBtn(value){scrollDownBtn=value},
get updateScrollDownButton(){return updateScrollDownButton},
get messagesEl(){return messagesEl},
get sessionsBanner(){return sessionsBanner},
get sessionListEl(){return sessionListEl},
get chatHeaderEl(){return chatHeaderEl},
get chatTitleEl(){return chatTitleEl},
get inputEl(){return inputEl},
get attachmentTrayEl(){return featureApis.files.attachmentTrayEl},
get sendBtn(){return sendBtn},
get stopBtn(){return stopBtn},
get newBtn(){return newBtn},
get providerSel(){return providerPicker.providerSel},
get burgerBtn(){return burgerBtn},
get sidebarOverlay(){return sidebarOverlay},
get expertMenuEl(){return featureApis.experts.expertMenuEl},
get expertToggleBtn(){return featureApis.experts.expertToggleBtn},
get expertPopoverEl(){return featureApis.experts.expertPopoverEl},
get expertEnabledEl(){return featureApis.experts.expertEnabledEl},
get expertAllEl(){return featureApis.experts.expertAllEl},
get expertListEl(){return featureApis.experts.expertListEl},
get expertModeEl(){return featureApis.experts.expertModeEl},
get expertSynthesizeEl(){return featureApis.experts.expertSynthesizeEl},
get expertStatusEl(){return featureApis.experts.expertStatusEl},
get workspaceToggleBtn(){return featureApis.workspace.workspaceToggleBtn},
get workspacePopoverEl(){return featureApis.workspace.workspacePopoverEl},
get workspaceListEl(){return featureApis.workspace.workspaceListEl},
get workspaceNameEl(){return featureApis.workspace.workspaceNameEl},
get workspaceAvatarEl(){return featureApis.workspace.workspaceAvatarEl},
get workspaceStatusEl(){return featureApis.workspace.workspaceStatusEl},
get workspaceNewBtn(){return featureApis.workspace.workspaceNewBtn},
get workspaceRenameBtn(){return featureApis.workspace.workspaceRenameBtn},
get workspaceConfigBtn(){return featureApis.workspace.workspaceConfigBtn},
get workspaceSettingsScreenEl(){return featureApis.rag.workspaceSettingsScreenEl},
get workspaceSettingsCancelBtn(){return featureApis.rag.workspaceSettingsCancelBtn},
get workspaceContextNameEl(){return featureApis.rag.workspaceContextNameEl},
get workspaceRagPathsEl(){return featureApis.rag.workspaceRagPathsEl},
get workspaceRagProgressBarEl(){return featureApis.rag.workspaceRagProgressBarEl},
get workspaceRagStatusEl(){return featureApis.rag.workspaceRagStatusEl},
get workspaceRagCurrentFileEl(){return featureApis.rag.workspaceRagCurrentFileEl},
get workspaceRagSaveBtn(){return featureApis.rag.workspaceRagSaveBtn},
get workspaceDeleteDialogEl(){return featureApis.workspace.workspaceDeleteDialogEl},
get workspaceDeleteMessageEl(){return featureApis.workspace.workspaceDeleteMessageEl},
get workspaceDeleteCancelBtn(){return featureApis.workspace.workspaceDeleteCancelBtn},
get workspaceDeleteConfirmBtn(){return featureApis.workspace.workspaceDeleteConfirmBtn},
get memoryBrowserStatusEl(){return featureApis.memory.memoryBrowserStatusEl},set memoryBrowserStatusEl(value){featureApis.memory.memoryBrowserStatusEl=value},
get memoryBrowserOverlay(){return featureApis.memory.memoryBrowserOverlay},
get memoryBrowserCountEl(){return featureApis.memory.memoryBrowserCountEl},
get memoryBrowserRefreshBtn(){return featureApis.memory.memoryBrowserRefreshBtn},
get memoryBrowserCloseBtn(){return featureApis.memory.memoryBrowserCloseBtn},
get memoryBrowserSearchForm(){return featureApis.memory.memoryBrowserSearchForm},
get memoryBrowserSearchEl(){return featureApis.memory.memoryBrowserSearchEl},
get memoryBrowserFilterEl(){return featureApis.memory.memoryBrowserFilterEl},
get memoryBrowserNewFactEl(){return featureApis.memory.memoryBrowserNewFactEl},
get memoryBrowserAddBtn(){return featureApis.memory.memoryBrowserAddBtn},
get memoryBrowserPanelStatusEl(){return featureApis.memory.memoryBrowserPanelStatusEl},
get memoryBrowserListEl(){return featureApis.memory.memoryBrowserListEl},
get memoryBrowserLoadMoreBtn(){return featureApis.memory.memoryBrowserLoadMoreBtn},
get memoryBrowserEmptyEl(){return featureApis.memory.memoryBrowserEmptyEl},
get memoryBrowserDetailForm(){return featureApis.memory.memoryBrowserDetailForm},
get memoryBrowserStateEl(){return featureApis.memory.memoryBrowserStateEl},
get memoryBrowserMemoryTitleEl(){return featureApis.memory.memoryBrowserMemoryTitleEl},
get memoryBrowserFactInput(){return featureApis.memory.memoryBrowserFactInput},
get memoryBrowserSessionIdInput(){return featureApis.memory.memoryBrowserSessionIdInput},
get memoryBrowserMessageIdInput(){return featureApis.memory.memoryBrowserMessageIdInput},
get memoryBrowserCreatedAtInput(){return featureApis.memory.memoryBrowserCreatedAtInput},
get memoryBrowserVersionInput(){return featureApis.memory.memoryBrowserVersionInput},
get memoryBrowserDreamSkillInput(){return featureApis.memory.memoryBrowserDreamSkillInput},
get memoryBrowserIgnoreUntilInput(){return featureApis.memory.memoryBrowserIgnoreUntilInput},
get memoryBrowserDeleteBtn(){return featureApis.memory.memoryBrowserDeleteBtn},
get memoryBrowserSaveBtn(){return featureApis.memory.memoryBrowserSaveBtn},
get architectureScreenEl(){return architectureScreenEl},
get architectureTitleEl(){return architectureTitleEl},
get architectureNavBtns(){return architectureNavBtns},
get architectureTabBtns(){return architectureTabBtns},
get architecturePanelEls(){return architecturePanelEls},
get architectureSourceStatusEl(){return featureApis.sources.architectureSourceStatusEl},
get architectureSourceRefreshBtn(){return featureApis.sources.architectureSourceRefreshBtn},
get architectureSourceListEl(){return featureApis.sources.architectureSourceListEl},
get architectureSourceDetailEl(){return featureApis.sources.architectureSourceDetailEl},
get architectureSourceHealthSummaryEl(){return featureApis.sources.architectureSourceHealthSummaryEl},
get architectureSourceHealthModalEl(){return featureApis.sources.architectureSourceHealthModalEl},
get architectureSourceHealthModalContentEl(){return featureApis.sources.architectureSourceHealthModalContentEl},
get architectureSourceHealthModalCloseBtn(){return featureApis.sources.architectureSourceHealthModalCloseBtn},
get architectureSqlForm(){return featureApis.sql.architectureSqlForm},
get architectureSqlMetricEl(){return featureApis.sql.architectureSqlMetricEl},
get architectureSqlDimensionEl(){return featureApis.sql.architectureSqlDimensionEl},
get architectureSqlFilterColumnEl(){return featureApis.sql.architectureSqlFilterColumnEl},
get architectureSqlFilterValueEl(){return featureApis.sql.architectureSqlFilterValueEl},
get architectureSqlLimitEl(){return featureApis.sql.architectureSqlLimitEl},
get architectureSqlPlanBtn(){return featureApis.sql.architectureSqlPlanBtn},
get architectureSqlApproveBtn(){return featureApis.sql.architectureSqlApproveBtn},
get architectureSqlExecuteBtn(){return featureApis.sql.architectureSqlExecuteBtn},
get architectureSqlStatusEl(){return featureApis.sql.architectureSqlStatusEl},
get architectureSqlPreviewEl(){return featureApis.sql.architectureSqlPreviewEl},
get architectureSqlResultsEl(){return featureApis.sql.architectureSqlResultsEl},
get architectureSqlValidationForm(){return featureApis.sql.architectureSqlValidationForm},
get architectureSqlValidationInputEl(){return featureApis.sql.architectureSqlValidationInputEl},
get architectureSqlValidationBtn(){return featureApis.sql.architectureSqlValidationBtn},
get architectureSqlValidationResultEl(){return featureApis.sql.architectureSqlValidationResultEl},
get architectureWorkflowStatusEl(){return featureApis.workflows.architectureWorkflowStatusEl},
get architectureWorkflowRefreshBtn(){return featureApis.workflows.architectureWorkflowRefreshBtn},
get architectureApprovalListEl(){return featureApis.workflows.architectureApprovalListEl},
get architectureApprovalDetailEl(){return featureApis.workflows.architectureApprovalDetailEl},
get architectureHighRiskWriteModalEl(){return featureApis.workflows.architectureHighRiskWriteModalEl},
get architectureHighRiskWriteContentEl(){return featureApis.workflows.architectureHighRiskWriteContentEl},
get architectureHighRiskWriteCloseBtn(){return featureApis.workflows.architectureHighRiskWriteCloseBtn},
get architectureHighRiskWriteRejectBtn(){return featureApis.workflows.architectureHighRiskWriteRejectBtn},
get architectureHighRiskWriteApproveBtn(){return featureApis.workflows.architectureHighRiskWriteApproveBtn},
get workflowOpsTabBtns(){return featureApis.workflows.workflowOpsTabBtns},
get workflowOpsPanelEls(){return featureApis.workflows.workflowOpsPanelEls},
get workflowOpsSummaryBtns(){return featureApis.workflows.workflowOpsSummaryBtns},
get workflowOpsWorkflowCountEl(){return featureApis.workflows.workflowOpsWorkflowCountEl},
get workflowOpsRunCountEl(){return featureApis.workflows.workflowOpsRunCountEl},
get workflowOpsPendingCountEl(){return featureApis.workflows.workflowOpsPendingCountEl},
get workflowOpsAcceptanceRateEl(){return featureApis.workflows.workflowOpsAcceptanceRateEl},
get workflowOpsAcceptanceTrendEl(){return featureApis.workflows.workflowOpsAcceptanceTrendEl},
get workflowOpsAttentionEl(){return featureApis.workflows.workflowOpsAttentionEl},
get workflowOpsRecentRunsEl(){return featureApis.workflows.workflowOpsRecentRunsEl},
get workflowOpsShadowReadinessEl(){return featureApis.workflows.workflowOpsShadowReadinessEl},
get workflowOpsCompileForm(){return featureApis.workflows.workflowOpsCompileForm},
get workflowOpsCompileNameEl(){return featureApis.workflows.workflowOpsCompileNameEl},
get workflowOpsCompileRiskEl(){return featureApis.workflows.workflowOpsCompileRiskEl},
get workflowOpsCompileTranscriptEl(){return featureApis.workflows.workflowOpsCompileTranscriptEl},
get workflowOpsCompileSourcesEl(){return featureApis.workflows.workflowOpsCompileSourcesEl},
get workflowOpsCompileToolEl(){return featureApis.workflows.workflowOpsCompileToolEl},
get workflowOpsCompilePublishEl(){return featureApis.workflows.workflowOpsCompilePublishEl},
get workflowOpsCompileDryRunEl(){return featureApis.workflows.workflowOpsCompileDryRunEl},
get workflowOpsCompileBtn(){return featureApis.workflows.workflowOpsCompileBtn},
get workflowOpsLibrarySearchEl(){return featureApis.workflows.workflowOpsLibrarySearchEl},
get workflowOpsLibraryListEl(){return featureApis.workflows.workflowOpsLibraryListEl},
get workflowOpsLibraryDetailEl(){return featureApis.workflows.workflowOpsLibraryDetailEl},
get workflowOpsRunSearchEl(){return featureApis.workflows.workflowOpsRunSearchEl},
get workflowOpsRunStatusEl(){return featureApis.workflows.workflowOpsRunStatusEl},
get workflowOpsRunListEl(){return featureApis.workflows.workflowOpsRunListEl},
get workflowOpsRunDetailEl(){return featureApis.workflows.workflowOpsRunDetailEl},
get workflowOpsShadowListEl(){return featureApis.workflows.workflowOpsShadowListEl},
get workflowOpsShadowDetailEl(){return featureApis.workflows.workflowOpsShadowDetailEl},
get architectureEvaluationStatusEl(){return featureApis.evaluation.architectureEvaluationStatusEl},
get architectureEvaluationRefreshBtn(){return featureApis.evaluation.architectureEvaluationRefreshBtn},
get evaluationTraceCountEl(){return featureApis.evaluation.evaluationTraceCountEl},
get evaluationPassRateEl(){return featureApis.evaluation.evaluationPassRateEl},
get evaluationCompletionRateEl(){return featureApis.evaluation.evaluationCompletionRateEl},
get evaluationNetBenefitEl(){return featureApis.evaluation.evaluationNetBenefitEl},
get evaluationTraceListEl(){return featureApis.evaluation.evaluationTraceListEl},
get evaluationTraceDetailEl(){return featureApis.evaluation.evaluationTraceDetailEl},
get evaluationSuiteListEl(){return featureApis.evaluation.evaluationSuiteListEl},
get evaluationSuiteDetailEl(){return featureApis.evaluation.evaluationSuiteDetailEl},
get evaluationRoiDetailEl(){return featureApis.evaluation.evaluationRoiDetailEl},
get architectureGraphForm(){return featureApis.graph.architectureGraphForm},
get architectureGraphRefreshBtn(){return featureApis.graph.architectureGraphRefreshBtn},
get architectureGraphRetrieveBtn(){return featureApis.graph.architectureGraphRetrieveBtn},
get architectureGraphSearchEl(){return featureApis.graph.architectureGraphSearchEl},
get architectureGraphSourceEl(){return featureApis.graph.architectureGraphSourceEl},
get architectureGraphStatusEl(){return featureApis.graph.architectureGraphStatusEl},
get architectureGraphListEl(){return featureApis.graph.architectureGraphListEl},
get architectureGraphDetailEl(){return featureApis.graph.architectureGraphDetailEl},
get architectureReviewForm(){return featureApis.experts.architectureReviewForm},
get architectureReviewModalEl(){return featureApis.experts.architectureReviewModalEl},
get architectureReviewOpenBtn(){return featureApis.experts.architectureReviewOpenBtn},
get architectureReviewCloseBtn(){return featureApis.experts.architectureReviewCloseBtn},
get architectureReviewCancelBtn(){return featureApis.experts.architectureReviewCancelBtn},
get architectureReviewQuestionEl(){return featureApis.experts.architectureReviewQuestionEl},
get architectureReviewTargetTypeEl(){return featureApis.experts.architectureReviewTargetTypeEl},
get architectureReviewTargetIdEl(){return featureApis.experts.architectureReviewTargetIdEl},
get architectureReviewWorkflowIdEl(){return featureApis.experts.architectureReviewWorkflowIdEl},
get architectureReviewRunIdEl(){return featureApis.experts.architectureReviewRunIdEl},
get architectureReviewExpertsEl(){return featureApis.experts.architectureReviewExpertsEl},
get architectureReviewRefreshBtn(){return featureApis.experts.architectureReviewRefreshBtn},
get architectureReviewCreateBtn(){return featureApis.experts.architectureReviewCreateBtn},
get architectureReviewStatusEl(){return featureApis.experts.architectureReviewStatusEl},
get architectureReviewListEl(){return featureApis.experts.architectureReviewListEl},
get architectureReviewDetailEl(){return featureApis.experts.architectureReviewDetailEl},
get architectureOpenPluginManagementBtn(){return featureApis.runtime.architectureOpenPluginManagementBtn},
get expertPanelExperts(){return featureApis.experts.expertPanelExperts},set expertPanelExperts(value){featureApis.experts.expertPanelExperts=value},
get expertPanelBusy(){return featureApis.experts.expertPanelBusy},set expertPanelBusy(value){featureApis.experts.expertPanelBusy=value},
get workspaceState(){return featureApis.workspace.workspaceState},set workspaceState(value){featureApis.workspace.workspaceState=value},
get workspaceRagPoll(){return featureApis.rag.workspaceRagPoll},set workspaceRagPoll(value){featureApis.rag.workspaceRagPoll=value},
get workspaceRagConfig(){return featureApis.rag.workspaceRagConfig},set workspaceRagConfig(value){featureApis.rag.workspaceRagConfig=value},
get workspaceRagSavedSnapshot(){return featureApis.rag.workspaceRagSavedSnapshot},set workspaceRagSavedSnapshot(value){featureApis.rag.workspaceRagSavedSnapshot=value},
get workspaceRagSaving(){return featureApis.rag.workspaceRagSaving},set workspaceRagSaving(value){featureApis.rag.workspaceRagSaving=value},
get workspaceRagLoadSeq(){return featureApis.rag.workspaceRagLoadSeq},set workspaceRagLoadSeq(value){featureApis.rag.workspaceRagLoadSeq=value},
get workspaceSwitching(){return featureApis.workspace.workspaceSwitching},set workspaceSwitching(value){featureApis.workspace.workspaceSwitching=value},
get WORKSPACE_RESTART_TIMEOUT_MS(){return featureApis.workspace.WORKSPACE_RESTART_TIMEOUT_MS},
get WORKSPACE_RESTART_STATUS_INTERVAL_MS(){return featureApis.workspace.WORKSPACE_RESTART_STATUS_INTERVAL_MS},
get memoryBrowserState(){return featureApis.memory.memoryBrowserState},set memoryBrowserState(value){featureApis.memory.memoryBrowserState=value},
get architectureView(){return architectureView},set architectureView(value){architectureView=value},
get architectureSourcesState(){return featureApis.sources.architectureSourcesState},set architectureSourcesState(value){featureApis.sources.architectureSourcesState=value},
get architectureSourcesLoadSeq(){return featureApis.sources.architectureSourcesLoadSeq},set architectureSourcesLoadSeq(value){featureApis.sources.architectureSourcesLoadSeq=value},
get architectureSqlState(){return featureApis.sql.architectureSqlState},set architectureSqlState(value){featureApis.sql.architectureSqlState=value},
get architectureSqlBusy(){return featureApis.sql.architectureSqlBusy},set architectureSqlBusy(value){featureApis.sql.architectureSqlBusy=value},
get architectureSqlPlanRequest(){return featureApis.sql.architectureSqlPlanRequest},set architectureSqlPlanRequest(value){featureApis.sql.architectureSqlPlanRequest=value},
get architectureSqlValidationState(){return featureApis.sql.architectureSqlValidationState},set architectureSqlValidationState(value){featureApis.sql.architectureSqlValidationState=value},
get architectureWorkflowState(){return featureApis.workflows.architectureWorkflowState},set architectureWorkflowState(value){featureApis.workflows.architectureWorkflowState=value},
get architectureWorkflowDecision(){return featureApis.workflows.architectureWorkflowDecision},set architectureWorkflowDecision(value){featureApis.workflows.architectureWorkflowDecision=value},
get architectureHighRiskWriteContext(){return featureApis.workflows.architectureHighRiskWriteContext},set architectureHighRiskWriteContext(value){featureApis.workflows.architectureHighRiskWriteContext=value},
get architectureWorkflowBusy(){return featureApis.workflows.architectureWorkflowBusy},set architectureWorkflowBusy(value){featureApis.workflows.architectureWorkflowBusy=value},
get architectureWorkflowLoadRequest(){return featureApis.workflows.architectureWorkflowLoadRequest},set architectureWorkflowLoadRequest(value){featureApis.workflows.architectureWorkflowLoadRequest=value},
get architectureWorkflowRefreshTimer(){return featureApis.workflows.architectureWorkflowRefreshTimer},set architectureWorkflowRefreshTimer(value){featureApis.workflows.architectureWorkflowRefreshTimer=value},
get WORKFLOW_OPS_REFRESH_MS(){return featureApis.workflows.WORKFLOW_OPS_REFRESH_MS},
get architectureEvaluationState(){return featureApis.evaluation.architectureEvaluationState},set architectureEvaluationState(value){featureApis.evaluation.architectureEvaluationState=value},
get architectureEvaluationLoadRequest(){return featureApis.evaluation.architectureEvaluationLoadRequest},set architectureEvaluationLoadRequest(value){featureApis.evaluation.architectureEvaluationLoadRequest=value},
get architectureGraphState(){return featureApis.graph.architectureGraphState},set architectureGraphState(value){featureApis.graph.architectureGraphState=value},
get architectureGraphRetrieveRequest(){return featureApis.graph.architectureGraphRetrieveRequest},set architectureGraphRetrieveRequest(value){featureApis.graph.architectureGraphRetrieveRequest=value},
get architectureReviewState(){return featureApis.experts.architectureReviewState},set architectureReviewState(value){featureApis.experts.architectureReviewState=value},
get closeSidebar(){return closeSidebar},
get loadSidebarState(){return loadSidebarState},
get saveSidebarState(){return saveSidebarState},
get escHtml(){return escHtml},
get md(){return md},
get T(){return T},
get apiListSessions(){return apiListSessions},
get apiGetSession(){return apiGetSession},
get apiSessionBusy(){return apiSessionBusy},
get apiListProviders(){return providerPicker.apiListProviders},
get refreshProviderSelect(){return providerPicker.refreshProviderSelect},
get callTool(){return callTool},
get setMemoryBrowserLauncherStatus(){return featureApis.memory.setMemoryBrowserLauncherStatus},
get setMemoryBrowserPanelStatus(){return featureApis.memory.setMemoryBrowserPanelStatus},
get formatMemoryBrowserDate(){return featureApis.memory.formatMemoryBrowserDate},
get getMemoryBrowserState(){return featureApis.memory.getMemoryBrowserState},
get memoryBrowserWhere(){return featureApis.memory.memoryBrowserWhere},
get callMemoryBrowserAction(){return featureApis.memory.callMemoryBrowserAction},
get renderMemoryBrowserCount(){return featureApis.memory.renderMemoryBrowserCount},
get renderMemoryBrowserList(){return featureApis.memory.renderMemoryBrowserList},
get renderMemoryBrowserDetail(){return featureApis.memory.renderMemoryBrowserDetail},
get selectMemoryBrowserMemory(){return featureApis.memory.selectMemoryBrowserMemory},
get loadMemoryBrowserMemories(){return featureApis.memory.loadMemoryBrowserMemories},
get memoryBrowserSelectedData(){return featureApis.memory.memoryBrowserSelectedData},
get saveMemoryBrowserSelection(){return featureApis.memory.saveMemoryBrowserSelection},
get deleteMemoryBrowserSelection(){return featureApis.memory.deleteMemoryBrowserSelection},
get addMemoryBrowserMemory(){return featureApis.memory.addMemoryBrowserMemory},
get openMemoryBrowser(){return featureApis.memory.openMemoryBrowser},
get closeMemoryBrowser(){return featureApis.memory.closeMemoryBrowser},
get ARCHITECTURE_PANEL_TITLES(){return ARCHITECTURE_PANEL_TITLES},
get ARCHITECTURE_HASH_VIEWS(){return ARCHITECTURE_HASH_VIEWS},
get architectureString(){return architectureString},
get architectureDate(){return architectureDate},
get architectureBadgeClass(){return architectureBadgeClass},
get architectureClear(){return architectureClear},
get architectureStatus(){return architectureStatus},
get architectureEmpty(){return architectureEmpty},
get architectureBadge(){return architectureBadge},
get architectureMuted(){return architectureMuted},
get architectureHeading(){return architectureHeading},
get architectureKeyValues(){return architectureKeyValues},
get architectureInlineBadges(){return architectureInlineBadges},
get architectureItemButton(){return architectureItemButton},
get architectureCard(){return architectureCard},
get architectureTable(){return architectureTable},
get architectureJsonBlock(){return architectureJsonBlock},
get setArchitectureOpen(){return setArchitectureOpen},
get architectureStatusElement(){return architectureStatusElement},
get activateArchitecturePanel(){return activateArchitecturePanel},
get loadArchitecturePanel(){return loadArchitecturePanel},
get sourceHealthFindings(){return featureApis.sources.sourceHealthFindings},
get sourceHealthSeverity(){return featureApis.sources.sourceHealthSeverity},
get renderArchitectureSourceHealthSummary(){return featureApis.sources.renderArchitectureSourceHealthSummary},
get openArchitectureSourceHealthModal(){return featureApis.sources.openArchitectureSourceHealthModal},
get renderArchitectureSourceList(){return featureApis.sources.renderArchitectureSourceList},
get renderArchitectureSourceDetail(){return featureApis.sources.renderArchitectureSourceDetail},
get selectArchitectureSource(){return featureApis.sources.selectArchitectureSource},
get loadArchitectureSources(){return featureApis.sources.loadArchitectureSources},
get architectureSqlPlanInput(){return featureApis.sql.architectureSqlPlanInput},
get invalidateArchitectureSqlPlan(){return featureApis.sql.invalidateArchitectureSqlPlan},
get renderArchitectureSqlValidation(){return featureApis.sql.renderArchitectureSqlValidation},
get validateArchitectureSql(){return featureApis.sql.validateArchitectureSql},
get renderArchitectureSqlResults(){return featureApis.sql.renderArchitectureSqlResults},
get planArchitectureSql(){return featureApis.sql.planArchitectureSql},
get approveArchitectureSql(){return featureApis.sql.approveArchitectureSql},
get executeArchitectureSql(){return featureApis.sql.executeArchitectureSql},
get workflowOpsWorkspaceQuery(){return featureApis.workflows.workflowOpsWorkspaceQuery},
get workflowOpsSplitValues(){return featureApis.workflows.workflowOpsSplitValues},
get workflowOpsAcceptanceText(){return featureApis.workflows.workflowOpsAcceptanceText},
get workflowOpsAcceptanceTrend(){return featureApis.workflows.workflowOpsAcceptanceTrend},
get stopWorkflowOpsAutoRefresh(){return featureApis.workflows.stopWorkflowOpsAutoRefresh},
get scheduleWorkflowOpsAutoRefresh(){return featureApis.workflows.scheduleWorkflowOpsAutoRefresh},
get activateWorkflowOpsView(){return featureApis.workflows.activateWorkflowOpsView},
get renderWorkflowOpsSummary(){return featureApis.workflows.renderWorkflowOpsSummary},
get workflowOpsSortedRuns(){return featureApis.workflows.workflowOpsSortedRuns},
get renderWorkflowOpsOverview(){return featureApis.workflows.renderWorkflowOpsOverview},
get workflowOpsFilteredCompilations(){return featureApis.workflows.workflowOpsFilteredCompilations},
get renderWorkflowOpsLibraryList(){return featureApis.workflows.renderWorkflowOpsLibraryList},
get renderWorkflowOpsLibraryDetail(){return featureApis.workflows.renderWorkflowOpsLibraryDetail},
get selectWorkflowOpsCompilation(){return featureApis.workflows.selectWorkflowOpsCompilation},
get compileWorkflowOperation(){return featureApis.workflows.compileWorkflowOperation},
get startWorkflowOpsRun(){return featureApis.workflows.startWorkflowOpsRun},
get workflowOpsFilteredRuns(){return featureApis.workflows.workflowOpsFilteredRuns},
get renderWorkflowOpsRunList(){return featureApis.workflows.renderWorkflowOpsRunList},
get workflowOpsDisclosure(){return featureApis.workflows.workflowOpsDisclosure},
get openWorkflowEvidenceSource(){return featureApis.workflows.openWorkflowEvidenceSource},
get workflowOpsEvidenceLinks(){return featureApis.workflows.workflowOpsEvidenceLinks},
get workflowOpsActionCards(){return featureApis.workflows.workflowOpsActionCards},
get renderWorkflowOpsRunDetail(){return featureApis.workflows.renderWorkflowOpsRunDetail},
get selectWorkflowOpsRun(){return featureApis.workflows.selectWorkflowOpsRun},
get workflowOpsComparisonForRun(){return featureApis.workflows.workflowOpsComparisonForRun},
get workflowOpsShadowRuns(){return featureApis.workflows.workflowOpsShadowRuns},
get renderWorkflowOpsShadowList(){return featureApis.workflows.renderWorkflowOpsShadowList},
get renderWorkflowOpsShadowDetail(){return featureApis.workflows.renderWorkflowOpsShadowDetail},
get selectWorkflowOpsShadowRun(){return featureApis.workflows.selectWorkflowOpsShadowRun},
get labelWorkflowOpsShadow(){return featureApis.workflows.labelWorkflowOpsShadow},
get renderWorkflowOperationsCenter(){return featureApis.workflows.renderWorkflowOperationsCenter},
get renderArchitectureApprovalList(){return featureApis.workflows.renderArchitectureApprovalList},
get highRiskWriteDetails(){return featureApis.workflows.highRiskWriteDetails},
get closeHighRiskWriteModal(){return featureApis.workflows.closeHighRiskWriteModal},
get openHighRiskWriteModal(){return featureApis.workflows.openHighRiskWriteModal},
get renderArchitectureApprovalDetail(){return featureApis.workflows.renderArchitectureApprovalDetail},
get selectArchitectureApproval(){return featureApis.workflows.selectArchitectureApproval},
get loadArchitectureWorkflowApprovals(){return featureApis.workflows.loadArchitectureWorkflowApprovals},
get decideArchitectureApproval(){return featureApis.workflows.decideArchitectureApproval},
get architectureGraphEntities(){return featureApis.graph.architectureGraphEntities},
get architectureGraphRelationships(){return featureApis.graph.architectureGraphRelationships},
get evaluationPercent(){return featureApis.evaluation.evaluationPercent},
get evaluationMoney(){return featureApis.evaluation.evaluationMoney},
get evaluationDuration(){return featureApis.evaluation.evaluationDuration},
get renderArchitectureEvaluationSummary(){return featureApis.evaluation.renderArchitectureEvaluationSummary},
get evaluationSortedTraces(){return featureApis.evaluation.evaluationSortedTraces},
get renderArchitectureEvaluationTraceList(){return featureApis.evaluation.renderArchitectureEvaluationTraceList},
get renderArchitectureEvaluationTraceDetail(){return featureApis.evaluation.renderArchitectureEvaluationTraceDetail},
get selectArchitectureEvaluationTrace(){return featureApis.evaluation.selectArchitectureEvaluationTrace},
get replayArchitectureEvaluationTrace(){return featureApis.evaluation.replayArchitectureEvaluationTrace},
get renderArchitectureEvaluationSuiteList(){return featureApis.evaluation.renderArchitectureEvaluationSuiteList},
get renderArchitectureEvaluationSuiteDetail(){return featureApis.evaluation.renderArchitectureEvaluationSuiteDetail},
get runArchitectureEvaluationSuite(){return featureApis.evaluation.runArchitectureEvaluationSuite},
get renderArchitectureEvaluationRoi(){return featureApis.evaluation.renderArchitectureEvaluationRoi},
get loadArchitectureEvaluation(){return featureApis.evaluation.loadArchitectureEvaluation},
get renderArchitectureGraphList(){return featureApis.graph.renderArchitectureGraphList},
get renderArchitectureGraphDetail(){return featureApis.graph.renderArchitectureGraphDetail},
get selectArchitectureGraphEntity(){return featureApis.graph.selectArchitectureGraphEntity},
get loadArchitectureGraph(){return featureApis.graph.loadArchitectureGraph},
get firstRetrievedArchitectureGraphEntity(){return featureApis.graph.firstRetrievedArchitectureGraphEntity},
get retrieveArchitectureGraph(){return featureApis.graph.retrieveArchitectureGraph},
get renderArchitectureReviewList(){return featureApis.experts.renderArchitectureReviewList},
get renderArchitectureReviewDetail(){return featureApis.experts.renderArchitectureReviewDetail},
get selectArchitectureReview(){return featureApis.experts.selectArchitectureReview},
get loadArchitectureReviews(){return featureApis.experts.loadArchitectureReviews},
get createArchitectureReview(){return featureApis.experts.createArchitectureReview},
get setWorkspaceStatus(){return featureApis.workspace.setWorkspaceStatus},
get setWorkspaceSwitching(){return featureApis.workspace.setWorkspaceSwitching},
get workspaceRestartSleep(){return featureApis.workspace.workspaceRestartSleep},
get workspaceStateHasActiveId(){return featureApis.workspace.workspaceStateHasActiveId},
get isWorkspaceFetchFailure(){return featureApis.workspace.isWorkspaceFetchFailure},
get waitForWorkspaceRestart(){return featureApis.workspace.waitForWorkspaceRestart},
get workspaceInitial(){return featureApis.workspace.workspaceInitial},
get activeWorkspace(){return featureApis.workspace.activeWorkspace},
get activeWorkspaceId(){return featureApis.workspace.activeWorkspaceId},
get setWorkspacePopoverOpen(){return featureApis.workspace.setWorkspacePopoverOpen},
get setWorkspaceSettingsOpen(){return featureApis.rag.setWorkspaceSettingsOpen},
get confirmWorkspaceDelete(){return featureApis.workspace.confirmWorkspaceDelete},
get workspaceDeleteErrorMessage(){return featureApis.workspace.workspaceDeleteErrorMessage},
get renderWorkspaces(){return featureApis.workspace.renderWorkspaces},
get loadWorkspaces(){return featureApis.workspace.loadWorkspaces},
get setWorkspaceRagStatus(){return featureApis.rag.setWorkspaceRagStatus},
get renderWorkspaceRagStatus(){return featureApis.rag.renderWorkspaceRagStatus},
get parseWorkspaceRagPaths(){return featureApis.rag.parseWorkspaceRagPaths},
get workspaceRagSnapshotFromConfig(){return featureApis.rag.workspaceRagSnapshotFromConfig},
get currentWorkspaceRagFormSnapshot(){return featureApis.rag.currentWorkspaceRagFormSnapshot},
get workspaceRagSnapshotsEqual(){return featureApis.rag.workspaceRagSnapshotsEqual},
get updateWorkspaceRagSaveState(){return featureApis.rag.updateWorkspaceRagSaveState},
get activeWorkspaceRagContext(){return featureApis.rag.activeWorkspaceRagContext},
get renderWorkspaceRagConfig(){return featureApis.rag.renderWorkspaceRagConfig},
get resetWorkspaceRagConfigForm(){return featureApis.rag.resetWorkspaceRagConfigForm},
get loadWorkspaceRagStatus(){return featureApis.rag.loadWorkspaceRagStatus},
get loadWorkspaceRagConfig(){return featureApis.rag.loadWorkspaceRagConfig},
get startWorkspaceRagPoll(){return featureApis.rag.startWorkspaceRagPoll},
get stopWorkspaceRagPoll(){return featureApis.rag.stopWorkspaceRagPoll},
get setExpertStatus(){return featureApis.experts.setExpertStatus},
get updateExpertControlsState(){return featureApis.experts.updateExpertControlsState},
get setExpertPopoverOpen(){return featureApis.experts.setExpertPopoverOpen},
get loadExperts(){return featureApis.experts.loadExperts},
get renderExpertPanel(){return featureApis.experts.renderExpertPanel},
get selectedExpertIds(){return featureApis.experts.selectedExpertIds},
get syncExpertAllFromChoices(){return featureApis.experts.syncExpertAllFromChoices},
get expertUserSummary(){return featureApis.experts.expertUserSummary},
get formatExpertPanelResult(){return featureApis.experts.formatExpertPanelResult},
get runExpertPanelFromUi(){return featureApis.experts.runExpertPanelFromUi},
get maybeShowScrollDown(){return maybeShowScrollDown},
get renameSession(){return renameSession},
get hideSession(){return hideSession},
get TITLE_REFRESH_DELAYS_MS(){return TITLE_REFRESH_DELAYS_MS},
get titleRefreshTimers(){return titleRefreshTimers},set titleRefreshTimers(value){titleRefreshTimers=value},
get refreshTitlesAfterFollowup(){return refreshTitlesAfterFollowup},
get apiNewSession(){return apiNewSession},
get formatSize(){return featureApis.files.formatSize},
get syncWorkspaceFileAttachmentRows(){return featureApis.files.syncWorkspaceFileAttachmentRows},
get renderAttachmentTray(){return featureApis.files.renderAttachmentTray},
get setWorkspaceFileAttached(){return featureApis.files.setWorkspaceFileAttached},
get clearWorkspaceFileAttachments(){return featureApis.files.clearWorkspaceFileAttachments},
get reconcileWorkspaceFileAttachments(){return featureApis.files.reconcileWorkspaceFileAttachments},
get renderFiles(){return featureApis.files.renderFiles},
get loadFiles(){return featureApis.files.loadFiles},
get makePluginLabel(){return featureApis.runtime.makePluginLabel},
get loadPlugins(){return featureApis.runtime.loadPlugins},
get HOST_RUNTIME(){return featureApis.runtime.HOST_RUNTIME},
get CORE_PLUGIN_NAMES(){return featureApis.runtime.CORE_PLUGIN_NAMES},
get corePluginRemovalDialogEl(){return featureApis.runtime.corePluginRemovalDialogEl},
get corePluginRemovalMessageEl(){return featureApis.runtime.corePluginRemovalMessageEl},
get corePluginRemovalCloseBtn(){return featureApis.runtime.corePluginRemovalCloseBtn},
get corePluginRemovalCancelBtn(){return featureApis.runtime.corePluginRemovalCancelBtn},
get closeCorePluginRemovalDialog(){return featureApis.runtime.closeCorePluginRemovalDialog},
get openCorePluginRemovalDialog(){return featureApis.runtime.openCorePluginRemovalDialog},
get runsHere(){return featureApis.runtime.runsHere},
get renderPlugins(){return featureApis.runtime.renderPlugins},
get loadSkills(){return featureApis.skills.loadSkills},
get renderSkills(){return featureApis.skills.renderSkills},
get appendMemoryBrowserLauncher(){return featureApis.memory.appendMemoryBrowserLauncher},
get skillEditorOverlay(){return featureApis.skills.skillEditorOverlay},
get skillEditorText(){return featureApis.skills.skillEditorText},
get skillEditorTitle(){return featureApis.skills.skillEditorTitle},
get skillEditorError(){return featureApis.skills.skillEditorError},
get skillEditorSave(){return featureApis.skills.skillEditorSave},
get skillEditorRoot(){return featureApis.skills.skillEditorRoot},
get skillTriggerList(){return featureApis.skills.skillTriggerList},
get skillTriggerDialog(){return featureApis.skills.skillTriggerDialog},
get skillTriggerDialogKind(){return featureApis.skills.skillTriggerDialogKind},
get skillTriggerDialogRule(){return featureApis.skills.skillTriggerDialogRule},
get skillTriggerDialogAction(){return featureApis.skills.skillTriggerDialogAction},
get skillTriggerDialogError(){return featureApis.skills.skillTriggerDialogError},
get TRIGGER_KINDS(){return featureApis.skills.TRIGGER_KINDS},
get editingSkillName(){return featureApis.skills.editingSkillName},set editingSkillName(value){featureApis.skills.editingSkillName=value},
get skillEditor(){return featureApis.skills.skillEditor},set skillEditor(value){featureApis.skills.skillEditor=value},
get editingSkillSavedContent(){return featureApis.skills.editingSkillSavedContent},set editingSkillSavedContent(value){featureApis.skills.editingSkillSavedContent=value},
get editingTriggerId(){return featureApis.skills.editingTriggerId},set editingTriggerId(value){featureApis.skills.editingTriggerId=value},
get setSkillTab(){return featureApis.skills.setSkillTab},
get renderSkillMetadata(){return featureApis.skills.renderSkillMetadata},
get makeTriggerRow(){return featureApis.skills.makeTriggerRow},
get renderTriggers(){return featureApis.skills.renderTriggers},
get saveTriggers(){return featureApis.skills.saveTriggers},
get ensureSkillEditor(){return featureApis.skills.ensureSkillEditor},
get openSkillEditor(){return featureApis.skills.openSkillEditor},
get closeSkillEditor(){return featureApis.skills.closeSkillEditor},
get uploadFiles(){return featureApis.files.uploadFiles},
get makeThinkingBlock(){return makeThinkingBlock},
get makeToolBlock(){return makeToolBlock},
get makeToolResultBlock(){return makeToolResultBlock},
get formatElapsed(){return formatElapsed},
get makeTokenStatsBlock(){return makeTokenStatsBlock},
get showEmpty(){return showEmpty},
get truncateAtWord(){return truncateAtWord},
get renderSessions(){return renderSessions},
get makeBubble(){return makeBubble},
get scrollMessagesToBottom(){return scrollMessagesToBottom},
get appendUserBubble(){return appendUserBubble},
get appendRoboBubble(){return appendRoboBubble},
get appendMessageAttachments(){return appendMessageAttachments},
get appendUserTurn(){return appendUserTurn},
get createMsgDivider(){return createMsgDivider},
get handleDividerAction(){return handleDividerAction},
get showEditSessionBanner(){return showEditSessionBanner},
get flashMessage(){return flashMessage},
get scrollToMsgIdx(){return scrollToMsgIdx},
get createAssistantWrap(){return createAssistantWrap},
get appendMarker(){return appendMarker},
get renderMarker(){return renderMarker},
get renderContentParts(){return renderContentParts},
get renderSession(){return renderSession},
get openSession(){return openSession},
get newSessionPromise(){return newSessionPromise},set newSessionPromise(value){newSessionPromise=value},
get handleNewSession(){return handleNewSession},
get submitFormResponse(){return submitFormResponse},
get streamSessionId(){return streamSessionId},set streamSessionId(value){streamSessionId=value},
get streamAc(){return streamAc},set streamAc(value){streamAc=value},
get streamReady(){return streamReady},set streamReady(value){streamReady=value},
get turnQueues(){return turnQueues},
get activeBatchHead(){return activeBatchHead},set activeBatchHead(value){activeBatchHead=value},
get foldedTraces(){return foldedTraces},
get queueFor(){return queueFor},
get wake(){return wake},
get pushTurnEvent(){return pushTurnEvent},
get turnEvents(){return turnEvents},
get connectSessionStream(){return connectSessionStream},
get sendMessage(){return sendMessage},
get submit(){return submit},
get postSubmit(){return postSubmit},
get showSubmitError(){return showSubmitError},
get renderTurn(){return renderTurn},
get setBusyState(){return setBusyState},
get requestStop(){return requestStop},
get init(){return init},
get filesSectionEl(){return featureApis.files.filesSectionEl},};
await ui.bind(featureHost,featureApis);
ui.onChange=()=>{architectureNavBtns=Array.from(document.querySelectorAll('.architecture-nav-btn')).filter(el=>!el.hidden);architectureTabBtns=Array.from(document.querySelectorAll('.architecture-tab')).filter(el=>!el.hidden);architecturePanelEls=Array.from(document.querySelectorAll('.architecture-panel'));ARCHITECTURE_PANEL_TITLES=Object.fromEntries(ui.descriptors.filter(d=>d.view).map(d=>[d.view,d.panelTitle??d.title]));ARCHITECTURE_HASH_VIEWS=new Set(Object.keys(ARCHITECTURE_PANEL_TITLES));
  if(architectureScreenEl?.classList.contains('open')&&!ARCHITECTURE_HASH_VIEWS.has(architectureView)){
    setArchitectureOpen(false);history.replaceState(null,'',location.pathname+location.search);
  }
};ui.onChange();
void fetch('/branding', { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(applyBranding).catch(() => {});

if (burgerBtn)      burgerBtn.onclick      = () => document.body.classList.toggle('sidebar-open');

if (sidebarOverlay) sidebarOverlay.onclick = closeSidebar;

document.getElementById('sidebar').addEventListener('click', (e) => {
  const heading = e.target.closest('.sidebar-heading');
  if (!heading) return;
  const section = heading.closest('.sidebar-section');
  if (!section) return;
  if (SIDEBAR_ACCORDION_SECTIONS.has(section.dataset.section) && section.classList.contains('collapsed')) {
    for (const other of document.querySelectorAll('.sidebar-section[data-section]')) {
      if (other !== section && SIDEBAR_ACCORDION_SECTIONS.has(other.dataset.section)) {
        other.classList.add('collapsed');
      }
    }
  }
  section.classList.toggle('collapsed');
  saveSidebarState();
});

loadSidebarState();

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

document.getElementById('architecture-list')?.addEventListener('click',event=>{const button=event.target.closest('[data-architecture-view]');if(button&&!button.hidden)setArchitectureOpen(true,button.dataset.architectureView);});
document.querySelector('.architecture-tabs')?.addEventListener('click',event=>{const button=event.target.closest('[data-architecture-tab]');if(button&&!button.hidden)setArchitectureOpen(true,button.dataset.architectureTab);});
document.querySelector('.architecture-tabs')?.addEventListener('keydown',event=>{
 const button=event.target.closest('[data-architecture-tab]');if(!button)return;const current=architectureTabBtns.indexOf(button);let next=current;
 if(event.key==='ArrowRight')next=(current+1)%architectureTabBtns.length;
 else if(event.key==='ArrowLeft')next=(current-1+architectureTabBtns.length)%architectureTabBtns.length;
 else if(event.key==='Home')next=0;else if(event.key==='End')next=architectureTabBtns.length-1;else return;
 event.preventDefault();architectureTabBtns[next]?.focus();architectureTabBtns[next]?.click();
});

newBtn.addEventListener('click', async (e) => {
  if (e.button !== 0) return; // let right-click / middle-click open in new tab
  e.preventDefault();
  await handleNewSession();
});

sendBtn.onclick = () => {
  if (sendBtn.classList.contains('scroll-down-mode')) scrollToBottomAndReset();
  else if (sending) requestStop();
  else sendMessage(false);
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

window.addEventListener('hashchange', async () => {
  const raw      = location.hash.slice(1);
  const ti       = raw.indexOf('~');
  const id       = ti >= 0 ? raw.slice(0, ti) : raw;
  const nav      = ti >= 0 ? (() => { try { return JSON.parse(raw.slice(ti + 1)); } catch { return null; } })() : null;
  if (ARCHITECTURE_HASH_VIEWS.has(id)) {
    setArchitectureOpen(true, id);
  } else if (id === 'new') {
    await handleNewSession();
  } else if (id && id !== currentSessionId) {
    await openSession(id, nav?.msg).catch(console.error);
  } else if (id === currentSessionId && nav?.msg !== undefined) {
    history.replaceState(null, '', location.pathname + '#' + id);
    scrollToMsgIdx(nav.msg);
  }
});

init().then(()=>{document.body.dataset.cortexReady='true';}).catch(console.error);
})().catch(console.error);
