/** Workspaces: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
const workspaceToggleBtn = document.getElementById('workspace-toggle-btn');

const workspacePopoverEl = document.getElementById('workspace-popover');

const workspaceListEl    = document.getElementById('workspace-list');

const workspaceNameEl    = document.getElementById('workspace-name');

const workspaceAvatarEl  = document.getElementById('workspace-avatar');

const workspaceStatusEl  = document.getElementById('workspace-status');

const workspaceNewBtn    = document.getElementById('workspace-new-btn');

const workspaceRenameBtn = document.getElementById('workspace-rename-btn');

const workspaceConfigBtn = document.getElementById('workspace-config-btn');

const workspaceDeleteDialogEl = document.getElementById('workspace-delete-dialog');

const workspaceDeleteMessageEl = document.getElementById('workspace-delete-message');

const workspaceDeleteCancelBtn = document.getElementById('workspace-delete-cancel');

const workspaceDeleteConfirmBtn = document.getElementById('workspace-delete-confirm');

let workspaceState = { active: 'default', workspaces: [] };

let workspaceSwitching = false;

const WORKSPACE_RESTART_TIMEOUT_MS = 120000;

const WORKSPACE_RESTART_STATUS_INTERVAL_MS = 5000;

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
  if (host.inputEl) {
    host.inputEl.disabled = workspaceSwitching;
    host.inputEl.setAttribute('aria-disabled', workspaceSwitching ? 'true' : 'false');
  }
  if (host.sendBtn) {
    host.sendBtn.disabled = workspaceSwitching;
    host.sendBtn.setAttribute('aria-disabled', workspaceSwitching ? 'true' : 'false');
  }
  if (host.newBtn) {
    host.newBtn.disabled = workspaceSwitching;
    host.newBtn.setAttribute('aria-disabled', workspaceSwitching ? 'true' : 'false');
  }
  const workspaceUploadInput = document.getElementById('upload-input');
  if (workspaceUploadInput) workspaceUploadInput.disabled = workspaceSwitching;
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

async function waitForWorkspaceRestart(workspaceId, previousRuntimeId) {
  const startedAt = Date.now();
  let nextStatusAt = startedAt + WORKSPACE_RESTART_STATUS_INTERVAL_MS;
  let sawUnavailable = false;
  await workspaceRestartSleep(350);
  while (Date.now() - startedAt < WORKSPACE_RESTART_TIMEOUT_MS) {
    try {
      const nextState = await host.T.listWorkspaces();
      const runtimeId = nextState?.runtime?.id;
      // Older servers report no runtime identity; fall back to the previous heuristic rather than
      // hanging until the timeout.
      const replaced = runtimeId !== undefined
        ? (previousRuntimeId === undefined || runtimeId !== previousRuntimeId)
        : (sawUnavailable || Date.now() - startedAt >= 1200);
      if (workspaceStateHasActiveId(nextState, workspaceId) && replaced) {
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
  if (open) host.setWorkspaceSettingsOpen(false);
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
      if (event.key === 'Tab') {
        const focusable = [workspaceDeleteConfirmBtn, workspaceDeleteCancelBtn].filter(button => !button.disabled);
        const current = focusable.indexOf(document.activeElement);
        const next = event.shiftKey
          ? (current <= 0 ? focusable.length - 1 : current - 1)
          : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
        event.preventDefault();
        focusable[next]?.focus();
      }
    };
    workspaceDeleteCancelBtn.addEventListener('click', onCancel, {signal:lifecycle.signal});
    workspaceDeleteConfirmBtn.addEventListener('click', onConfirm, {signal:lifecycle.signal});
    workspaceDeleteDialogEl.addEventListener('click', onBackdrop, {signal:lifecycle.signal});
    document.addEventListener('keydown', onKeyDown, {signal:lifecycle.signal});
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
        // Captured before the switch: the process about to be replaced.
        const previousRuntimeId = workspaceState?.runtime?.id;
        let result;
        try {
          result = await host.T.switchWorkspace(workspace.id);
        } catch (e) {
          if (!isWorkspaceFetchFailure(e)) throw e;
          result = { active: workspace.id, restarting: true };
        }
        if (result?.restarting) {
          setWorkspaceStatus('Restarting...');
          await waitForWorkspaceRestart(workspace.id, previousRuntimeId);
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
    }, {signal:lifecycle.signal});
    row.appendChild(btn);
    if (!workspace.active) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'workspace-delete-btn';
      deleteBtn.innerHTML = host.ICON_TRASH;
      deleteBtn.title = `Delete ${workspace.name}`;
      deleteBtn.setAttribute('aria-label', `Delete ${workspace.name}`);
      deleteBtn.disabled = workspaceSwitching;
      deleteBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (workspaceSwitching) return;
        try {
          setWorkspaceStatus('Checking workspace...');
          await host.T.checkWorkspaceDelete(workspace.id);
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
          await host.T.deleteWorkspace(workspace.id);
          await loadWorkspaces();
        } catch (e) {
          setWorkspaceStatus(String(e.message || e), true);
        }
      }, {signal:lifecycle.signal});
      row.appendChild(deleteBtn);
    }
    workspaceListEl.appendChild(row);
  }
}

async function loadWorkspaces() {
  if (!host.T.listWorkspaces || !workspaceToggleBtn) return;
  try {
    const previousWorkspaceId = activeWorkspaceId();
    const nextWorkspaceState = await host.T.listWorkspaces();
    workspaceState = nextWorkspaceState;
    if (activeWorkspaceId() !== previousWorkspaceId) {
      host.workspaceGeneration += 1;
      host.selectedWorkspaceFiles.clear();
      host.selectedWorkspaceOwner = null;
      host.renderAttachmentTray();
      host.architectureSourcesLoadSeq += 1;
      host.architectureSqlPlanRequest += 1;
      host.architectureWorkflowLoadRequest += 1;
      host.architectureEvaluationLoadRequest += 1;
      host.architectureGraphRetrieveRequest += 1;
      host.workspaceRagLoadSeq += 1;
    }
    host.workspaceRagConfig = null;
    renderWorkspaces();
    if (host.workspaceSettingsScreenEl?.classList.contains('open')) void host.loadWorkspaceRagConfig();
    setWorkspaceStatus('');
  } catch (e) {
    setWorkspaceStatus('Workspace API unavailable.', true);
  }
}
return {
get workspaceToggleBtn(){return workspaceToggleBtn},
get workspacePopoverEl(){return workspacePopoverEl},
get workspaceListEl(){return workspaceListEl},
get workspaceNameEl(){return workspaceNameEl},
get workspaceAvatarEl(){return workspaceAvatarEl},
get workspaceStatusEl(){return workspaceStatusEl},
get workspaceNewBtn(){return workspaceNewBtn},
get workspaceRenameBtn(){return workspaceRenameBtn},
get workspaceConfigBtn(){return workspaceConfigBtn},
get workspaceDeleteDialogEl(){return workspaceDeleteDialogEl},
get workspaceDeleteMessageEl(){return workspaceDeleteMessageEl},
get workspaceDeleteCancelBtn(){return workspaceDeleteCancelBtn},
get workspaceDeleteConfirmBtn(){return workspaceDeleteConfirmBtn},
get workspaceState(){return workspaceState},set workspaceState(value){workspaceState=value},
get workspaceSwitching(){return workspaceSwitching},set workspaceSwitching(value){workspaceSwitching=value},
get WORKSPACE_RESTART_TIMEOUT_MS(){return WORKSPACE_RESTART_TIMEOUT_MS},
get WORKSPACE_RESTART_STATUS_INTERVAL_MS(){return WORKSPACE_RESTART_STATUS_INTERVAL_MS},
get setWorkspaceStatus(){return setWorkspaceStatus},
get setWorkspaceSwitching(){return setWorkspaceSwitching},
get workspaceRestartSleep(){return workspaceRestartSleep},
get workspaceStateHasActiveId(){return workspaceStateHasActiveId},
get isWorkspaceFetchFailure(){return isWorkspaceFetchFailure},
get waitForWorkspaceRestart(){return waitForWorkspaceRestart},
get workspaceInitial(){return workspaceInitial},
get activeWorkspace(){return activeWorkspace},
get activeWorkspaceId(){return activeWorkspaceId},
get setWorkspacePopoverOpen(){return setWorkspacePopoverOpen},
get confirmWorkspaceDelete(){return confirmWorkspaceDelete},
get workspaceDeleteErrorMessage(){return workspaceDeleteErrorMessage},
get renderWorkspaces(){return renderWorkspaces},
get loadWorkspaces(){return loadWorkspaces},
mount(){
workspaceToggleBtn?.addEventListener('click', () => {
  if (workspaceSwitching) return;
  setWorkspacePopoverOpen(!workspacePopoverEl?.classList.contains('open'));
}, {signal:lifecycle.signal});

workspaceConfigBtn?.addEventListener('click', () => {
  if (workspaceSwitching) return;
  host.setWorkspaceSettingsOpen(true);
}, {signal:lifecycle.signal});

workspaceNewBtn?.addEventListener('click', async () => {
  if (workspaceSwitching) return;
  const name = prompt('New workspace name');
  if (!name || !name.trim()) return;
  try {
    await host.T.createWorkspace(name.trim());
    await loadWorkspaces();
  } catch (e) {
    setWorkspaceStatus(String(e.message || e), true);
  }
}, {signal:lifecycle.signal});

workspaceRenameBtn?.addEventListener('click', async () => {
  if (workspaceSwitching) return;
  const current = activeWorkspace();
  const name = prompt('Rename workspace', current.name || 'Default');
  if (!name || !name.trim()) return;
  try {
    await host.T.renameWorkspace(current.id, name.trim());
    await loadWorkspaces();
  } catch (e) {
    setWorkspaceStatus(String(e.message || e), true);
  }
}, {signal:lifecycle.signal});

document.addEventListener('click', (e) => {
  if (!workspacePopoverEl?.classList.contains('open')) return;
  if (e.target.closest('#workspace-menu')) return;
  setWorkspacePopoverOpen(false);
}, {signal:lifecycle.signal});
},dispose(){lifecycle.abort();}
};
}
