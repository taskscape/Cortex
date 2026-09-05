/** Plugins: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
const architectureOpenPluginManagementBtn = document.getElementById('architecture-open-plugin-management');

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
  const generation = host.workspaceGeneration;
  const workspaceId = host.activeWorkspaceId();
  let listResult;
  try {
    listResult = await host.callTool('plugin', { action: 'list' });
  } catch {
    return;
  }
  let localResult = [];
  try {
    localResult = await host.callTool('plugin', { action: 'discover_local' });
  } catch { /* discover_local optional */ }
  if (generation !== host.workspaceGeneration || workspaceId !== host.activeWorkspaceId()) return;
  renderPlugins(listResult.loaded ?? [], Array.isArray(localResult) ? localResult : []);
}

const HOST_RUNTIME = host.T.hostRuntime || 'node';

const CORE_PLUGIN_NAMES = new Set([
  '@matatbread/matbot-sessions',
  '@matatbread/matbot-tool-workspace',
  '@matatbread/matbot-workflow-governance',
  '@matatbread/matbot-frontend',
]);

const corePluginRemovalDialogEl = document.getElementById('core-plugin-removal-dialog');

const corePluginRemovalMessageEl = document.getElementById('core-plugin-removal-message');

const corePluginRemovalCloseBtn = document.getElementById('core-plugin-removal-close');

const corePluginRemovalCancelBtn = document.getElementById('core-plugin-removal-cancel');

function closeCorePluginRemovalDialog() {
  if (corePluginRemovalDialogEl) corePluginRemovalDialogEl.hidden = true;
}

function openCorePluginRemovalDialog(plugin) {
  if (!corePluginRemovalDialogEl) return;
  if (corePluginRemovalMessageEl) corePluginRemovalMessageEl.textContent = `The core plugin ${plugin.name} (${plugin.specifier}) was selected for removal.`;
  corePluginRemovalDialogEl.hidden = false;
  corePluginRemovalCancelBtn?.focus();
}

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
      if (CORE_PLUGIN_NAMES.has(p.name)) {
        removeBtn.dataset.corePlugin = p.name;
        removeBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          openCorePluginRemovalDialog(p);
        };
      } else {
        removeBtn.onclick = (e) => {
          e.stopPropagation();
          host.closeSidebar();
          // Direct submit so it queues during a turn instead of being blocked by the input.
          host.submit(`Remove the plugin '${p.specifier}'`);
        };
      }
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
        host.closeSidebar();
        // Direct submit so it queues during a turn instead of being blocked by the input.
        host.submit(`Add the plugin '${p.specifier}'`);
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
return {
get LS_PROVIDER(){return host.providerPicker.LS_PROVIDER},
get providerStorageKey(){return host.providerPicker.providerStorageKey},
get savedProviderForWorkspace(){return host.providerPicker.savedProviderForWorkspace},
get providerDiscoveryFailed(){return host.providerPicker.providerDiscoveryFailed},set providerDiscoveryFailed(value){host.providerPicker.providerDiscoveryFailed=value},
get providerSel(){return host.providerPicker.providerSel},
get architectureOpenPluginManagementBtn(){return architectureOpenPluginManagementBtn},
get apiListProviders(){return host.providerPicker.apiListProviders},
get refreshProviderSelect(){return host.providerPicker.refreshProviderSelect},
get makePluginLabel(){return makePluginLabel},
get loadPlugins(){return loadPlugins},
get HOST_RUNTIME(){return HOST_RUNTIME},
get CORE_PLUGIN_NAMES(){return CORE_PLUGIN_NAMES},
get corePluginRemovalDialogEl(){return corePluginRemovalDialogEl},
get corePluginRemovalMessageEl(){return corePluginRemovalMessageEl},
get corePluginRemovalCloseBtn(){return corePluginRemovalCloseBtn},
get corePluginRemovalCancelBtn(){return corePluginRemovalCancelBtn},
get closeCorePluginRemovalDialog(){return closeCorePluginRemovalDialog},
get openCorePluginRemovalDialog(){return openCorePluginRemovalDialog},
get runsHere(){return runsHere},
get renderPlugins(){return renderPlugins},
async activate(force=false){return loadPlugins();},
status(){return null;},
mount(){
architectureOpenPluginManagementBtn?.addEventListener('click', () => {
    host.setArchitectureOpen(false, host.architectureView, { skipWorkspace: true });
    const section = document.querySelector('[data-section="plugins"]');
    if (section?.classList.contains('collapsed')) section.querySelector('.sidebar-heading')?.click();
    document.body.classList.add('sidebar-open');
  }, {signal:lifecycle.signal});

corePluginRemovalCloseBtn?.addEventListener('click', closeCorePluginRemovalDialog, {signal:lifecycle.signal});

corePluginRemovalCancelBtn?.addEventListener('click', closeCorePluginRemovalDialog, {signal:lifecycle.signal});
},dispose(){lifecycle.abort();}
};
}
