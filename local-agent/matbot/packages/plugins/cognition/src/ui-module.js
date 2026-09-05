/** Memories: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
let memoryBrowserStatusEl = null;

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

let memoryBrowserState = { items: [], cursor: undefined, selected: null, loaded: false };

function setMemoryBrowserLauncherStatus(text, isError = false) {
  if (!memoryBrowserStatusEl) return;
  memoryBrowserStatusEl.textContent = text || '';
  memoryBrowserStatusEl.hidden = !text;
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
  return host.callTool('remembered_facts_action', input);
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
    closeMemoryBrowser();
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
  host.setWorkspaceSettingsOpen(false);
  setMemoryBrowserLauncherStatus('');
  memoryBrowserOverlay.classList.add('open');
  host.closeSidebar();
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

function appendMemoryBrowserLauncher(el) {
  const row = document.createElement('div');
  row.id = 'memory-browser-btn';
  row.className = 'skill-entry';
  row.setAttribute('role', 'button');
  row.tabIndex = 0;

  const label = document.createElement('span');
  label.className = 'skill-name-label';
  label.textContent = 'Open memory browser';
  row.appendChild(label);
  el.appendChild(row);

  const status = document.createElement('div');
  status.id = 'memory-browser-status';
  status.hidden = true;
  el.appendChild(status);
  memoryBrowserStatusEl = status;
}
return {
get memoryBrowserStatusEl(){return memoryBrowserStatusEl},set memoryBrowserStatusEl(value){memoryBrowserStatusEl=value},
get memoryBrowserOverlay(){return memoryBrowserOverlay},
get memoryBrowserCountEl(){return memoryBrowserCountEl},
get memoryBrowserRefreshBtn(){return memoryBrowserRefreshBtn},
get memoryBrowserCloseBtn(){return memoryBrowserCloseBtn},
get memoryBrowserSearchForm(){return memoryBrowserSearchForm},
get memoryBrowserSearchEl(){return memoryBrowserSearchEl},
get memoryBrowserFilterEl(){return memoryBrowserFilterEl},
get memoryBrowserNewFactEl(){return memoryBrowserNewFactEl},
get memoryBrowserAddBtn(){return memoryBrowserAddBtn},
get memoryBrowserPanelStatusEl(){return memoryBrowserPanelStatusEl},
get memoryBrowserListEl(){return memoryBrowserListEl},
get memoryBrowserLoadMoreBtn(){return memoryBrowserLoadMoreBtn},
get memoryBrowserEmptyEl(){return memoryBrowserEmptyEl},
get memoryBrowserDetailForm(){return memoryBrowserDetailForm},
get memoryBrowserStateEl(){return memoryBrowserStateEl},
get memoryBrowserMemoryTitleEl(){return memoryBrowserMemoryTitleEl},
get memoryBrowserFactInput(){return memoryBrowserFactInput},
get memoryBrowserSessionIdInput(){return memoryBrowserSessionIdInput},
get memoryBrowserMessageIdInput(){return memoryBrowserMessageIdInput},
get memoryBrowserCreatedAtInput(){return memoryBrowserCreatedAtInput},
get memoryBrowserVersionInput(){return memoryBrowserVersionInput},
get memoryBrowserDreamSkillInput(){return memoryBrowserDreamSkillInput},
get memoryBrowserIgnoreUntilInput(){return memoryBrowserIgnoreUntilInput},
get memoryBrowserDeleteBtn(){return memoryBrowserDeleteBtn},
get memoryBrowserSaveBtn(){return memoryBrowserSaveBtn},
get memoryBrowserState(){return memoryBrowserState},set memoryBrowserState(value){memoryBrowserState=value},
get setMemoryBrowserLauncherStatus(){return setMemoryBrowserLauncherStatus},
get setMemoryBrowserPanelStatus(){return setMemoryBrowserPanelStatus},
get formatMemoryBrowserDate(){return formatMemoryBrowserDate},
get getMemoryBrowserState(){return getMemoryBrowserState},
get memoryBrowserWhere(){return memoryBrowserWhere},
get callMemoryBrowserAction(){return callMemoryBrowserAction},
get renderMemoryBrowserCount(){return renderMemoryBrowserCount},
get renderMemoryBrowserList(){return renderMemoryBrowserList},
get renderMemoryBrowserDetail(){return renderMemoryBrowserDetail},
get selectMemoryBrowserMemory(){return selectMemoryBrowserMemory},
get loadMemoryBrowserMemories(){return loadMemoryBrowserMemories},
get memoryBrowserSelectedData(){return memoryBrowserSelectedData},
get saveMemoryBrowserSelection(){return saveMemoryBrowserSelection},
get deleteMemoryBrowserSelection(){return deleteMemoryBrowserSelection},
get addMemoryBrowserMemory(){return addMemoryBrowserMemory},
get openMemoryBrowser(){return openMemoryBrowser},
get closeMemoryBrowser(){return closeMemoryBrowser},
get appendMemoryBrowserLauncher(){return appendMemoryBrowserLauncher},
mount(){
if (memoryBrowserOverlay) {
  const activateMemoryBrowserLauncher = async (e) => {
    e.stopPropagation();
    try {
      await openMemoryBrowser();
    } catch (err) {
      setMemoryBrowserLauncherStatus(String(err?.message || err), true);
    }
  };
  document.getElementById('skill-list')?.addEventListener('click', (e) => {
    if (!e.target.closest('#memory-browser-btn')) return;
    void activateMemoryBrowserLauncher(e);
  }, {signal:lifecycle.signal});
  document.getElementById('skill-list')?.addEventListener('keydown', (e) => {
    if (!e.target.closest('#memory-browser-btn') || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    void activateMemoryBrowserLauncher(e);
  }, {signal:lifecycle.signal});
  memoryBrowserOverlay.addEventListener('click', (e) => {
    if (e.target === memoryBrowserOverlay) closeMemoryBrowser();
  }, {signal:lifecycle.signal});
  memoryBrowserCloseBtn?.addEventListener('click', closeMemoryBrowser, {signal:lifecycle.signal});
  memoryBrowserRefreshBtn?.addEventListener('click', () => loadMemoryBrowserMemories(false), {signal:lifecycle.signal});
  memoryBrowserLoadMoreBtn?.addEventListener('click', () => loadMemoryBrowserMemories(true), {signal:lifecycle.signal});
  memoryBrowserAddBtn?.addEventListener('click', addMemoryBrowserMemory, {signal:lifecycle.signal});
  memoryBrowserFilterEl?.addEventListener('change', () => {
    memoryBrowserState.selected = null;
    renderMemoryBrowserDetail();
    loadMemoryBrowserMemories(false);
  }, {signal:lifecycle.signal});
  memoryBrowserSearchForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    memoryBrowserState.selected = null;
    renderMemoryBrowserDetail();
    loadMemoryBrowserMemories(false);
  }, {signal:lifecycle.signal});
  memoryBrowserDetailForm?.addEventListener('submit', saveMemoryBrowserSelection, {signal:lifecycle.signal});
  memoryBrowserDeleteBtn?.addEventListener('click', deleteMemoryBrowserSelection, {signal:lifecycle.signal});
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && memoryBrowserOverlay.classList.contains('open')) closeMemoryBrowser();
  }, {signal:lifecycle.signal});
}
},dispose(){lifecycle.abort();}
};
}
