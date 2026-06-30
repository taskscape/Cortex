(function () {
  const refs = {
    count: document.getElementById('count-label'),
    refresh: document.getElementById('refresh-btn'),
    form: document.getElementById('search-form'),
    search: document.getElementById('search-input'),
    filter: document.getElementById('state-filter'),
    status: document.getElementById('status'),
    list: document.getElementById('memory-list'),
    more: document.getElementById('load-more-btn'),
    empty: document.getElementById('empty-detail'),
    detail: document.getElementById('detail-form'),
    state: document.getElementById('memory-state'),
    title: document.getElementById('memory-title'),
    fact: document.getElementById('fact-input'),
    sessionId: document.getElementById('session-id'),
    messageId: document.getElementById('message-id'),
    createdAt: document.getElementById('created-at'),
    version: document.getElementById('version'),
    dreamSkill: document.getElementById('dream-skill'),
    ignoreUntil: document.getElementById('ignore-until'),
    save: document.getElementById('save-btn'),
    delete: document.getElementById('delete-btn'),
    newFact: document.getElementById('new-fact'),
    add: document.getElementById('add-memory-btn'),
  };

  const state = {
    items: [],
    cursor: undefined,
    selected: null,
  };

  function setStatus(text, isError) {
    refs.status.textContent = text || '';
    refs.status.classList.toggle('error', Boolean(isError));
  }

  function fmtDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString();
  }

  function memoryState(item) {
    if (item.ignoreUntil) return 'ignored';
    if (item.dreamSkill) return 'processed';
    return 'unprocessed';
  }

  async function api(path, options) {
    const res = await fetch(path, {
      ...options,
      headers: {
        ...(options && options.headers ? options.headers : {}),
        ...(options && options.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function listUrl(cursor) {
    const params = new URLSearchParams();
    const q = refs.search.value.trim();
    if (q) params.set('q', q);
    params.set('state', refs.filter.value || 'all');
    params.set('limit', '50');
    if (cursor) params.set('cursor', cursor);
    return '/api/memories?' + params.toString();
  }

  async function loadMemories(append) {
    setStatus('Loading...');
    try {
      const result = await api(listUrl(append ? state.cursor : undefined));
      state.items = append ? state.items.concat(result.items || []) : (result.items || []);
      state.cursor = result.cursor;
      refs.more.hidden = !state.cursor;
      refs.count.textContent = result.total !== undefined
        ? state.items.length + ' of ' + result.total
        : state.items.length + ' loaded';
      renderList();
      if (!state.selected && state.items.length) selectMemory(state.items[0].id);
      setStatus('');
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  function renderList() {
    refs.list.innerHTML = '';
    for (const item of state.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'memory-item' + (state.selected && state.selected.id === item.id ? ' active' : '');
      btn.dataset.id = item.id;

      const fact = document.createElement('div');
      fact.className = 'memory-fact';
      fact.textContent = item.fact || '(empty fact)';

      const meta = document.createElement('div');
      meta.className = 'memory-meta';
      meta.textContent = memoryState(item) + ' | ' + fmtDate(item.createdAt);

      btn.appendChild(fact);
      btn.appendChild(meta);
      btn.addEventListener('click', () => selectMemory(item.id));
      refs.list.appendChild(btn);
    }
  }

  async function selectMemory(id) {
    try {
      const item = await api('/api/memories/' + encodeURIComponent(id));
      state.selected = item;
      renderList();
      renderDetail();
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  function renderDetail() {
    const item = state.selected;
    refs.empty.classList.toggle('hidden', Boolean(item));
    refs.detail.classList.toggle('hidden', !item);
    if (!item) return;

    refs.state.textContent = memoryState(item);
    refs.title.textContent = item.id;
    refs.fact.value = item.fact || '';
    refs.sessionId.value = item.sessionId || '';
    refs.messageId.value = item.messageId || '';
    refs.createdAt.value = item.createdAt || '';
    refs.version.value = item.version || '';
    refs.dreamSkill.value = item.dreamSkill || '';
    refs.ignoreUntil.value = item.ignoreUntil || '';
  }

  async function saveSelected(event) {
    event.preventDefault();
    if (!state.selected) return;
    setStatus('Saving...');
    try {
      const body = {
        expected: state.selected.version,
        fact: refs.fact.value,
        dreamSkill: refs.dreamSkill.value,
        ignoreUntil: refs.ignoreUntil.value,
      };
      const saved = await api('/api/memories/' + encodeURIComponent(state.selected.id), {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      state.selected = saved;
      const idx = state.items.findIndex(item => item.id === saved.id);
      if (idx >= 0) state.items[idx] = saved;
      renderList();
      renderDetail();
      setStatus('Saved.');
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  async function deleteSelected() {
    if (!state.selected) return;
    if (!confirm('Delete this memory?')) return;
    setStatus('Deleting...');
    try {
      await api('/api/memories/' + encodeURIComponent(state.selected.id), {
        method: 'DELETE',
        body: JSON.stringify({ expected: state.selected.version }),
      });
      const deletedId = state.selected.id;
      state.items = state.items.filter(item => item.id !== deletedId);
      state.selected = null;
      renderList();
      renderDetail();
      if (state.items.length) selectMemory(state.items[0].id);
      setStatus('Deleted.');
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  async function addMemory() {
    const fact = refs.newFact.value.trim();
    if (!fact) return;
    setStatus('Adding...');
    try {
      const saved = await api('/api/memories', {
        method: 'POST',
        body: JSON.stringify({ fact }),
      });
      refs.newFact.value = '';
      state.items.unshift(saved);
      state.selected = saved;
      renderList();
      renderDetail();
      setStatus('Added.');
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  refs.form.addEventListener('submit', event => {
    event.preventDefault();
    state.selected = null;
    renderDetail();
    loadMemories(false);
  });
  refs.filter.addEventListener('change', () => {
    state.selected = null;
    renderDetail();
    loadMemories(false);
  });
  refs.refresh.addEventListener('click', () => loadMemories(false));
  refs.more.addEventListener('click', () => loadMemories(true));
  refs.detail.addEventListener('submit', saveSelected);
  refs.delete.addEventListener('click', deleteSelected);
  refs.add.addEventListener('click', addMemory);

  refs.more.hidden = true;
  loadMemories(false);
}());
