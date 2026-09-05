/** Workspace RAG: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
const workspaceSettingsScreenEl = document.getElementById('workspace-settings-screen');

const workspaceSettingsCancelBtn = document.getElementById('workspace-settings-cancel-btn');

const workspaceContextNameEl = document.getElementById('workspace-context-name');

const workspaceRagPathsEl = document.getElementById('workspace-rag-paths');

const workspaceRagProgressBarEl = document.getElementById('workspace-rag-progress-bar');

const workspaceRagStatusEl = document.getElementById('workspace-rag-status');

const workspaceRagCurrentFileEl = document.getElementById('workspace-rag-current-file');

const workspaceRagSaveBtn = document.getElementById('workspace-rag-save-btn');

let workspaceRagPoll = null;

let workspaceRagConfig = null;

let workspaceRagSavedSnapshot = null;

let workspaceRagSaving = false;

let workspaceRagLoadSeq = 0;

function setWorkspaceSettingsOpen(open) {
  if (!workspaceSettingsScreenEl || !host.workspaceConfigBtn) return;
  if (host.workspaceSwitching && open) return;
  workspaceSettingsScreenEl.classList.toggle('open', open);
  document.body.classList.toggle('workspace-settings-open', open);
  host.workspaceConfigBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    host.setArchitectureOpen(false, host.architectureView, { skipWorkspace: true });
    host.setWorkspacePopoverOpen(false);
    host.closeSidebar();
    loadWorkspaceRagConfig();
    startWorkspaceRagPoll();
  } else {
    stopWorkspaceRagPoll();
  }
}

function setWorkspaceRagStatus(text, isError = false) {
  if (!workspaceRagStatusEl) return;
  workspaceRagStatusEl.textContent = text || '';
  workspaceRagStatusEl.classList.toggle('error', Boolean(isError));
}

function renderWorkspaceRagStatus(status) {
  if (!status) return;
  if (status.workspaceId && status.workspaceId !== host.activeWorkspaceId()) return;
  const job = status.job && typeof status.job === 'object' ? status.job : null;
  const totalFiles = Number(job?.totalFiles ?? 0);
  const processedFiles = Number(job?.processedFiles ?? 0);
  const terminal = typeof job?.state === 'string' && (job.state.startsWith('active_') || ['cancelled', 'retryable_failure', 'permanent_failure'].includes(job.state));
  const percent = totalFiles > 0
    ? Math.max(0, Math.min(100, Math.round(processedFiles / totalFiles * 100)))
    : (terminal && job?.discoveryComplete ? 100 : 0);
  if (workspaceRagProgressBarEl) workspaceRagProgressBarEl.style.width = percent + '%';
  const accel = status.accelerated
    ? `CUDA · ${status.embeddingModel || 'GPU embeddings'}`
    : (status.nvidiaAvailable ? 'CPU (NVIDIA detected)' : 'CPU');
  const state = !status.available
    ? 'unavailable'
    : (job?.state || status.activeState || 'pending');
  const backend = status.backend === 'postgres-pgvector'
    ? ' · Postgres/pgvector'
    : (status.backend === 'memory' ? ' · Memory (test)' : '');
  const progress = job ? ` · ${processedFiles}/${totalFiles} files · ${percent}%` : '';
  const changes = job
    ? ` · ${job.addedFiles ?? 0} added, ${job.changedFiles ?? 0} changed, ${job.unchangedFiles ?? 0} unchanged, ${job.removedFiles ?? 0} removed`
    : '';
  const indexed = Number.isFinite(Number(status.indexedDocuments))
    ? ` · ${Number(status.indexedDocuments)} indexed in database`
    : '';
  const resumed = Number(job?.resumedFiles) > 0 ? ` · resumed ${Number(job.resumedFiles)} from interrupted run` : '';
  const checkpoints = Number(job?.publishedCheckpoints) > 0
    ? ` · ${Number(job.publishedCheckpoints)} checkpoint${Number(job.publishedCheckpoints) === 1 ? '' : 's'} published`
    : '';
  const watcher = status.watcher
    ? ` · watcher ${status.watcher.state}${status.watcher.pendingChanges ? ' (pending)' : ''}${status.watcher.reconcileQueued ? ' (queued)' : ''}`
    : '';
  const message = status.message ? ' · ' + status.message : '';
  const accelerationMessage = status.accelerationMessage ? ' · ' + status.accelerationMessage : '';
  const isError = !status.available || ['retryable_failure', 'permanent_failure'].includes(state) || status.watcher?.state === 'degraded';
  setWorkspaceRagStatus(`${state}${progress}${changes}${indexed}${resumed}${checkpoints} · ${accel}${backend}${watcher}${message}${accelerationMessage}`, isError);
  if (workspaceRagCurrentFileEl) {
    const currentFile = typeof job?.currentPath === 'string' && job.currentPath.trim()
      ? job.currentPath.trim()
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
    active?.name || config?.contextName || host.activeWorkspace().name || 'Workspace',
  ).trim() || host.activeWorkspace().name || 'Workspace';
  return {
    contextId: active?.id || config?.activeContextId || '',
    contextName,
    paths,
  };
}

function currentWorkspaceRagFormSnapshot() {
  return {
    contextId: activeWorkspaceRagContext()?.id || workspaceRagSavedSnapshot?.contextId || '',
    contextName: workspaceContextNameEl?.value?.trim() || host.activeWorkspace().name || 'Workspace',
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
  if (workspaceContextNameEl) workspaceContextNameEl.value = active?.name || config?.contextName || host.activeWorkspace().name || '';
  if (workspaceRagPathsEl) workspaceRagPathsEl.value = Array.isArray(active?.paths ?? config?.paths) ? (active?.paths ?? config.paths).join('\n') : '';
  workspaceRagSavedSnapshot = workspaceRagSnapshotFromConfig(config);
  updateWorkspaceRagSaveState();
}

function resetWorkspaceRagConfigForm() {
  workspaceRagConfig = null;
  workspaceRagSavedSnapshot = null;
  workspaceRagSaving = false;
  if (workspaceContextNameEl) workspaceContextNameEl.value = host.activeWorkspace().name || '';
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
    const status = await host.callTool('workspace_rag', { action: 'status' });
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
  const workspaceId = host.activeWorkspaceId();
  resetWorkspaceRagConfigForm();
  setWorkspaceRagStatus('Loading workspace settings...');
  try {
    const [config, status] = await Promise.all([
      host.callTool('workspace_rag', { action: 'get_config' }),
      host.callTool('workspace_rag', { action: 'status' }),
    ]);
    if (loadSeq !== workspaceRagLoadSeq || workspaceId !== host.activeWorkspaceId()) return;
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
return {
get workspaceSettingsScreenEl(){return workspaceSettingsScreenEl},
get workspaceSettingsCancelBtn(){return workspaceSettingsCancelBtn},
get workspaceContextNameEl(){return workspaceContextNameEl},
get workspaceRagPathsEl(){return workspaceRagPathsEl},
get workspaceRagProgressBarEl(){return workspaceRagProgressBarEl},
get workspaceRagStatusEl(){return workspaceRagStatusEl},
get workspaceRagCurrentFileEl(){return workspaceRagCurrentFileEl},
get workspaceRagSaveBtn(){return workspaceRagSaveBtn},
get workspaceRagPoll(){return workspaceRagPoll},set workspaceRagPoll(value){workspaceRagPoll=value},
get workspaceRagConfig(){return workspaceRagConfig},set workspaceRagConfig(value){workspaceRagConfig=value},
get workspaceRagSavedSnapshot(){return workspaceRagSavedSnapshot},set workspaceRagSavedSnapshot(value){workspaceRagSavedSnapshot=value},
get workspaceRagSaving(){return workspaceRagSaving},set workspaceRagSaving(value){workspaceRagSaving=value},
get workspaceRagLoadSeq(){return workspaceRagLoadSeq},set workspaceRagLoadSeq(value){workspaceRagLoadSeq=value},
get setWorkspaceSettingsOpen(){return setWorkspaceSettingsOpen},
get setWorkspaceRagStatus(){return setWorkspaceRagStatus},
get renderWorkspaceRagStatus(){return renderWorkspaceRagStatus},
get parseWorkspaceRagPaths(){return parseWorkspaceRagPaths},
get workspaceRagSnapshotFromConfig(){return workspaceRagSnapshotFromConfig},
get currentWorkspaceRagFormSnapshot(){return currentWorkspaceRagFormSnapshot},
get workspaceRagSnapshotsEqual(){return workspaceRagSnapshotsEqual},
get updateWorkspaceRagSaveState(){return updateWorkspaceRagSaveState},
get activeWorkspaceRagContext(){return activeWorkspaceRagContext},
get renderWorkspaceRagConfig(){return renderWorkspaceRagConfig},
get resetWorkspaceRagConfigForm(){return resetWorkspaceRagConfigForm},
get loadWorkspaceRagStatus(){return loadWorkspaceRagStatus},
get loadWorkspaceRagConfig(){return loadWorkspaceRagConfig},
get startWorkspaceRagPoll(){return startWorkspaceRagPoll},
get stopWorkspaceRagPoll(){return stopWorkspaceRagPoll},
mount(){
workspaceContextNameEl?.addEventListener('input', updateWorkspaceRagSaveState, {signal:lifecycle.signal});

workspaceRagPathsEl?.addEventListener('input', updateWorkspaceRagSaveState, {signal:lifecycle.signal});

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
    const result = await host.callTool('workspace_rag', input);
    if (result?.config) renderWorkspaceRagConfig(result.config);
    else workspaceRagSavedSnapshot = nextSnapshot;
    if (result?.status) renderWorkspaceRagStatus(result.status);
  } catch (e) {
    setWorkspaceRagStatus(String(e.message || e), true);
  } finally {
    workspaceRagSaving = false;
    updateWorkspaceRagSaveState();
  }
}, {signal:lifecycle.signal});

workspaceSettingsCancelBtn?.addEventListener('click', () => {
  setWorkspaceSettingsOpen(false);
}, {signal:lifecycle.signal});
},dispose(){lifecycle.abort();workspaceRagLoadSeq++;clearTimeout(workspaceRagPoll);}
};
}
