/** Skills: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
async function loadSkills() {
  const generation = host.workspaceGeneration;
  const workspaceId = host.activeWorkspaceId();
  let result;
  try {
    result = await host.callTool('skill_action', { action: 'list' });
  } catch {
    // skills plugin not loaded — leave the section empty.
    renderSkills([]);
    return;
  }
  if (generation !== host.workspaceGeneration || workspaceId !== host.activeWorkspaceId()) return;
  renderSkills(Array.isArray(result.skills) ? result.skills : []);
}

function renderSkills(skills) {
  const el = document.getElementById('skill-list');
  if (!el) return;
  el.innerHTML = '';

  skills = [...skills].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  let memoryBrowserInserted = false;

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
        await host.callTool('skill_action', { action: 'delete', name: s.name });
      } catch (err) {
        alert('Failed to delete skill: ' + (err?.message ?? err));
        return;
      }
      loadSkills();
    };
    actions.appendChild(removeBtn);

    row.appendChild(actions);
    el.appendChild(row);

    if (!memoryBrowserInserted &&
        s.name.localeCompare('Inner voice', undefined, { sensitivity: 'base' }) === 0) {
      host.appendMemoryBrowserLauncher(el);
      memoryBrowserInserted = true;
    }
  }

  // Cognition normally seeds "Inner voice". Keep the memory command available at
  // the end of the list if that skill is unavailable during startup or reload.
  if (!memoryBrowserInserted) host.appendMemoryBrowserLauncher(el);
}

const skillEditorOverlay = document.getElementById('skill-editor-overlay');

const skillEditorText    = document.getElementById('skill-editor-text');

const skillEditorTitle   = document.getElementById('skill-editor-title');

const skillEditorError   = document.getElementById('skill-editor-error');

const skillEditorSave    = document.getElementById('skill-editor-save');

const skillEditorRoot    = document.getElementById('skill-editor');

const skillTriggerList   = document.getElementById('skill-trigger-list');

const skillTriggerDialog = document.getElementById('skill-trigger-dialog');

const skillTriggerDialogKind = document.getElementById('skill-trigger-dialog-kind');

const skillTriggerDialogRule = document.getElementById('skill-trigger-dialog-rule');

const skillTriggerDialogAction = document.getElementById('skill-trigger-dialog-action');

const skillTriggerDialogError = document.getElementById('skill-trigger-dialog-error');

const TRIGGER_KINDS = ['ephemeral', 'contextual', 'retract', 'followup'];

let editingSkillName = null;

let skillEditor = null;

let editingSkillSavedContent = '';

let editingTriggerId = null;

function setSkillTab(tab) {
  for (const btn of document.querySelectorAll('.skill-tab')) btn.classList.toggle('active', btn.dataset.tab === tab);
  document.getElementById('skill-editor-pane-content').classList.toggle('active', tab === 'content');
  document.getElementById('skill-editor-pane-triggers').classList.toggle('active', tab === 'triggers');
  document.getElementById('skill-editor-pane-metadata').classList.toggle('active', tab === 'metadata');
  skillEditorRoot.classList.toggle('tab-triggers', tab === 'triggers');
  skillEditorRoot.classList.toggle('tab-metadata', tab === 'metadata');
}

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

  const body = document.createElement('div');
  body.className = 'trigger-body';
  const action = document.createElement('div');
  action.className = 'trigger-action';
  action.textContent = `Action: skill_action use ${editingSkillName ?? ''}`.trim();
  body.append(txt, action);

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

  row.append(sel, body, editBtn, delBtn);
  return row;
}

function renderTriggers(conditions) {
  skillTriggerList.innerHTML = '';
  for (const c of conditions) skillTriggerList.appendChild(makeTriggerRow(c));
}

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
      await host.callTool('trigger_action', { action: 'update', id: editingTriggerId, conditions });
    } else {
      await host.callTool('trigger_action', { action: 'remove', id: editingTriggerId });
      editingTriggerId = null;
    }
  } else if (conditions.length) {
    const res = await host.callTool('trigger_action', {
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
  host.setWorkspaceSettingsOpen(false);
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
  host.callTool('trigger_action', { action: 'query', tool: 'skill_action', params: { action: 'use', name } })
    .then((res) => {
      const trig = Array.isArray(res?.triggers) ? res.triggers[0] : undefined;
      editingTriggerId = trig?.id ?? null;
      renderTriggers(Array.isArray(trig?.conditions) ? trig.conditions : []);
    })
    .catch(() => { /* triggers plugin not loaded — leave the triggers tab empty. */ });
  // Derived analysis, likewise independent of TinyMDE; absent until the background pass has cached it.
  host.callTool('skill_action', { action: 'metadata', name })
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
    const result = await host.callTool('skill_action', { action: 'load', name });
    editingSkillSavedContent = result.content ?? '';
    editor.setContent(editingSkillSavedContent);
  } catch (err) {
    editor.setContent('');
    skillEditorError.textContent = 'Failed to load: ' + (err?.message ?? err);
  }
  skillEditorSave.disabled = false;
  skillEditorOverlay.querySelector('.TinyMDE')?.focus();
}

function closeSkillEditor(force = false) {
  const currentContent = skillEditor?.getContent?.() ?? skillEditorText?.value ?? '';
  if (!force && editingSkillName !== null && currentContent !== editingSkillSavedContent) {
    if (!window.confirm('Discard unsaved skill changes?')) return false;
  }
  skillEditorOverlay.classList.remove('open');
  if (skillTriggerDialog?.open) skillTriggerDialog.close();
  editingSkillName = null;
  editingSkillSavedContent = '';
  return true;
}
return {
get loadSkills(){return loadSkills},
get renderSkills(){return renderSkills},
get skillEditorOverlay(){return skillEditorOverlay},
get skillEditorText(){return skillEditorText},
get skillEditorTitle(){return skillEditorTitle},
get skillEditorError(){return skillEditorError},
get skillEditorSave(){return skillEditorSave},
get skillEditorRoot(){return skillEditorRoot},
get skillTriggerList(){return skillTriggerList},
get skillTriggerDialog(){return skillTriggerDialog},
get skillTriggerDialogKind(){return skillTriggerDialogKind},
get skillTriggerDialogRule(){return skillTriggerDialogRule},
get skillTriggerDialogAction(){return skillTriggerDialogAction},
get skillTriggerDialogError(){return skillTriggerDialogError},
get TRIGGER_KINDS(){return TRIGGER_KINDS},
get editingSkillName(){return editingSkillName},set editingSkillName(value){editingSkillName=value},
get skillEditor(){return skillEditor},set skillEditor(value){skillEditor=value},
get editingSkillSavedContent(){return editingSkillSavedContent},set editingSkillSavedContent(value){editingSkillSavedContent=value},
get editingTriggerId(){return editingTriggerId},set editingTriggerId(value){editingTriggerId=value},
get setSkillTab(){return setSkillTab},
get renderSkillMetadata(){return renderSkillMetadata},
get makeTriggerRow(){return makeTriggerRow},
get renderTriggers(){return renderTriggers},
get saveTriggers(){return saveTriggers},
get ensureSkillEditor(){return ensureSkillEditor},
get openSkillEditor(){return openSkillEditor},
get closeSkillEditor(){return closeSkillEditor},
mount(){
if (skillEditorOverlay) {
  skillEditorOverlay.addEventListener('click', (e) => {
    if (e.target === skillEditorOverlay) closeSkillEditor();
  }, {signal:lifecycle.signal});
  document.getElementById('skill-editor-close').onclick  = () => closeSkillEditor();
  document.getElementById('skill-editor-cancel').onclick = () => closeSkillEditor();
  for (const btn of document.querySelectorAll('.skill-tab')) btn.onclick = () => setSkillTab(btn.dataset.tab);
  document.getElementById('skill-trigger-add').onclick = () => {
    skillTriggerDialogKind.value = 'ephemeral';
    skillTriggerDialogRule.value = '';
    skillTriggerDialogAction.value = `skill_action use ${editingSkillName ?? ''}`.trim();
    skillTriggerDialogError.textContent = '';
    skillTriggerDialog.showModal();
    skillTriggerDialogKind.focus();
  };
  document.getElementById('skill-trigger-dialog-cancel').onclick = () => skillTriggerDialog.close();
  document.getElementById('skill-trigger-dialog-save').onclick = () => {
    const rule = skillTriggerDialogRule.value.trim();
    if (!rule) {
      skillTriggerDialogError.textContent = 'Enter a classifier condition before adding the trigger.';
      skillTriggerDialogRule.focus();
      return;
    }
    skillTriggerList.appendChild(makeTriggerRow({ kind: skillTriggerDialogKind.value, rule }));
    skillTriggerDialog.close();
  };
  skillEditorSave.onclick = async () => {
    if (editingSkillName === null) return;
    skillEditorSave.disabled = true;
    skillEditorError.textContent = '';
    try {
      if (skillEditor) {
        const sysCb = document.getElementById('skill-system-checkbox');
        await host.callTool('skill_action', {
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
    editingSkillSavedContent = skillEditor?.getContent?.() ?? editingSkillSavedContent;
    closeSkillEditor(true);
    loadSkills();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && skillEditorOverlay.classList.contains('open')) closeSkillEditor();
  }, {signal:lifecycle.signal});
}
},dispose(){lifecycle.abort();}
};
}
