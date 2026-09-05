/** Files: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
const updatedFiles   = new Set();

const selectedWorkspaceFiles = new Map();

const knownWorkspaceFiles = new Set();

let selectedWorkspaceOwner = null;

const attachmentTrayEl = document.getElementById('attachment-tray');

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function syncWorkspaceFileAttachmentRows() {
  document.querySelectorAll('#file-list .file-item').forEach(row => {
    const selected = selectedWorkspaceFiles.has(row.dataset.path);
    row.classList.toggle('attached', selected);
    const button = row.querySelector('.file-attach-btn');
    if (button) {
      button.setAttribute('aria-pressed', String(selected));
      button.title = selected ? 'Remove from next message' : 'Attach to next message';
      button.setAttribute('aria-label', button.title);
    }
  });
}

function renderAttachmentTray() {
  if (!attachmentTrayEl) return;
  attachmentTrayEl.innerHTML = '';
  for (const file of selectedWorkspaceFiles.values()) {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    chip.dataset.attachmentPath = file.path;
    chip.title = file.path + (file.size !== undefined ? ` (${formatSize(file.size)})` : '');

    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '📎';
    chip.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'attachment-chip-name';
    name.textContent = file.path;
    chip.appendChild(name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-chip-remove';
    remove.title = `Remove ${file.path} from the next message`;
    remove.setAttribute('aria-label', remove.title);
    remove.textContent = '×';
    remove.onclick = () => {
      selectedWorkspaceFiles.delete(file.path);
      renderAttachmentTray();
      syncWorkspaceFileAttachmentRows();
    };
    chip.appendChild(remove);
    attachmentTrayEl.appendChild(chip);
  }
  attachmentTrayEl.hidden = selectedWorkspaceFiles.size === 0;
}

function setWorkspaceFileAttached(file, attached = true) {
  const owner = host.workspaceState.active || 'default';
  if (selectedWorkspaceOwner !== null && selectedWorkspaceOwner !== owner) {
    selectedWorkspaceFiles.clear();
  }
  selectedWorkspaceOwner = owner;
  if (attached) selectedWorkspaceFiles.set(file.path, { path: file.path, size: file.size });
  else selectedWorkspaceFiles.delete(file.path);
  renderAttachmentTray();
  syncWorkspaceFileAttachmentRows();
}

function clearWorkspaceFileAttachments() {
  selectedWorkspaceFiles.clear();
  selectedWorkspaceOwner = host.workspaceState.active || 'default';
  renderAttachmentTray();
  syncWorkspaceFileAttachmentRows();
}

function reconcileWorkspaceFileAttachments(files) {
  const owner = host.workspaceState.active || 'default';
  if (selectedWorkspaceOwner !== null && selectedWorkspaceOwner !== owner) {
    selectedWorkspaceFiles.clear();
  }
  selectedWorkspaceOwner = owner;
  const available = new Map(files.map(file => [file.path, file]));
  for (const path of [...selectedWorkspaceFiles.keys()]) {
    const current = available.get(path);
    if (current) selectedWorkspaceFiles.set(path, { path, size: current.size });
    else selectedWorkspaceFiles.delete(path);
  }
  renderAttachmentTray();
}

function renderFiles(files) {
  const el = document.getElementById('file-list');
  if (!el) return;
  knownWorkspaceFiles.clear();
  for (const file of files || []) {
    if (file?.path) knownWorkspaceFiles.add(file.path);
  }
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
      host.T.openFile('workspace', f.path);
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
    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'file-attach-btn';
    attachBtn.textContent = '📎';
    attachBtn.setAttribute('aria-pressed', String(selectedWorkspaceFiles.has(f.path)));
    attachBtn.title = selectedWorkspaceFiles.has(f.path) ? 'Remove from next message' : 'Attach to next message';
    attachBtn.setAttribute('aria-label', attachBtn.title);
    attachBtn.onclick = (e) => {
      e.stopPropagation();
      setWorkspaceFileAttached(f, !selectedWorkspaceFiles.has(f.path));
    };
    actions.appendChild(attachBtn);
    const delBtn = document.createElement('button');
    delBtn.className = 'file-action-btn';
    delBtn.textContent = '\u00d7';
    delBtn.title = 'Delete';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await host.callTool('workspace_action', { action: 'delete', path: f.path });
        selectedWorkspaceFiles.delete(f.path);
        renderAttachmentTray();
        loadFiles();
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    };
    actions.appendChild(delBtn);
    div.appendChild(actions);
    el.appendChild(div);
  }
  syncWorkspaceFileAttachmentRows();
}

async function loadFiles() {
  const generation = host.workspaceGeneration;
  const workspaceId = host.activeWorkspaceId();
  try {
    const data = await host.callTool('workspace_action', { action: 'list' });
    if (generation !== host.workspaceGeneration || workspaceId !== host.activeWorkspaceId()) return;
    const files = Array.isArray(data) ? data : (data?.files ?? []);
    reconcileWorkspaceFileAttachments(files);
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
          host.submit('Please discover local plugins and add the workspace plugin to enable file management.');
        };
        el.appendChild(prompt);
      }
    } else {
      renderFiles([]);
    }
  }
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  for (const file of files) {
    try {
      if (knownWorkspaceFiles.has(file.name) && !window.confirm(`Replace existing workspace file "${file.name}"?`)) {
        continue;
      }
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const CHUNK = 0x8000;
      let bin = '';
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      await host.callTool('workspace_action', { action: 'write', path: file.name, content: btoa(bin), encoding: 'base64' });
      setWorkspaceFileAttached({ path: file.name, size: file.size });
    } catch (err) {
      alert('Upload failed for ' + file.name + ': ' + err.message);
    }
  }
  loadFiles();
}

const filesSectionEl = document.querySelector('[data-section="files"]');
return {
get updatedFiles(){return updatedFiles},
get selectedWorkspaceFiles(){return selectedWorkspaceFiles},
get knownWorkspaceFiles(){return knownWorkspaceFiles},
get selectedWorkspaceOwner(){return selectedWorkspaceOwner},set selectedWorkspaceOwner(value){selectedWorkspaceOwner=value},
get attachmentTrayEl(){return attachmentTrayEl},
get formatSize(){return formatSize},
get syncWorkspaceFileAttachmentRows(){return syncWorkspaceFileAttachmentRows},
get renderAttachmentTray(){return renderAttachmentTray},
get setWorkspaceFileAttached(){return setWorkspaceFileAttached},
get clearWorkspaceFileAttachments(){return clearWorkspaceFileAttachments},
get reconcileWorkspaceFileAttachments(){return reconcileWorkspaceFileAttachments},
get renderFiles(){return renderFiles},
get loadFiles(){return loadFiles},
get uploadFiles(){return uploadFiles},
get filesSectionEl(){return filesSectionEl},
mount(){
if (filesSectionEl) {
  filesSectionEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    filesSectionEl.classList.add('drop-over');
  }, {signal:lifecycle.signal});
  filesSectionEl.addEventListener('dragleave', (e) => {
    if (!filesSectionEl.contains(e.relatedTarget)) filesSectionEl.classList.remove('drop-over');
  }, {signal:lifecycle.signal});
  filesSectionEl.addEventListener('drop', (e) => {
    e.preventDefault();
    filesSectionEl.classList.remove('drop-over');
    if (e.dataTransfer?.files.length) uploadFiles(e.dataTransfer.files);
  }, {signal:lifecycle.signal});
}

document.getElementById('upload-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('upload-input')?.click();
}, {signal:lifecycle.signal});

document.getElementById('upload-input')?.addEventListener('change', function() {
  if (this.files?.length) { uploadFiles(this.files); this.value = ''; }
}, {signal:lifecycle.signal});
},dispose(){lifecycle.abort();}
};
}
