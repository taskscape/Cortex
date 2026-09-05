/** Context graph: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
const architectureGraphForm = document.getElementById('architecture-graph-form');

const architectureGraphRefreshBtn = document.getElementById('architecture-graph-refresh');

const architectureGraphRetrieveBtn = document.getElementById('architecture-graph-retrieve');

const architectureGraphSearchEl = document.getElementById('architecture-graph-search');

const architectureGraphSourceEl = document.getElementById('architecture-graph-source');

const architectureGraphStatusEl = document.getElementById('architecture-graph-status');

const architectureGraphListEl = document.getElementById('architecture-graph-list');

const architectureGraphDetailEl = document.getElementById('architecture-graph-detail');

let architectureGraphState = { entities: [], relationships: [], retrieve: null, selected: null, loaded: false };

let architectureGraphRetrieveRequest = 0;

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
  const entityIds = new Set(architectureGraphEntities().map(entity => entity.id));
  return relationships.filter(relationship => {
    if (!relationship?.subjectEntityId || !relationship?.objectEntityId) return false;
    if (relationship.subjectEntityId === relationship.objectEntityId) return false;
    if (!entityIds.has(relationship.subjectEntityId) || !entityIds.has(relationship.objectEntityId)) return false;
    if (relationship.confidence !== undefined) {
      const confidence = Number(relationship.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return false;
    }
    return true;
  });
}

function renderArchitectureGraphList() {
  host.architectureClear(architectureGraphListEl);
  if (!architectureGraphListEl) return;
  const entities = architectureGraphEntities();
  if (!entities.length) {
    architectureGraphListEl.appendChild(host.architectureEmpty('No entities'));
    return;
  }
  for (const entity of entities) {
    architectureGraphListEl.appendChild(host.architectureItemButton({
      title: entity.canonicalName || entity.id,
      meta: [entity.id, Array.isArray(entity.aliases) ? entity.aliases.join(', ') : ''].filter(Boolean).join(' | '),
      badge: entity.type,
      active: architectureGraphState.selected?.id === entity.id,
      onClick: () => selectArchitectureGraphEntity(entity.id),
    }));
  }
}

function renderArchitectureGraphDetail() {
  host.architectureClear(architectureGraphDetailEl);
  if (!architectureGraphDetailEl) return;
  const entity = architectureGraphState.selected;
  if (!entity) {
    architectureGraphDetailEl.appendChild(host.architectureEmpty('Select an entity'));
    return;
  }
  architectureGraphDetailEl.append(
    host.architectureHeading(3, entity.canonicalName || entity.id),
    host.architectureKeyValues([
      ['ID', entity.id],
      ['Type', entity.type],
      ['Aliases', entity.aliases],
      ['Sensitivity', entity.sensitivity],
      ['Updated', host.architectureDate(entity.updatedAt)],
    ])
  );

  const relationships = architectureGraphRelationships().filter(rel =>
    rel.subjectEntityId === entity.id || rel.objectEntityId === entity.id
  );
  architectureGraphDetailEl.appendChild(host.architectureHeading(4, 'Relationships'));
  if (relationships.length) {
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const rel of relationships) {
      grid.appendChild(host.architectureCard(rel.predicate || rel.id, [
        `${rel.subjectEntityId} -> ${rel.objectEntityId}`,
        `Source: ${host.architectureString(rel.sourceId)}`,
        rel.evidenceSpan,
      ], rel.confidence !== undefined ? `confidence ${rel.confidence}` : rel.extractionMethod));
    }
    architectureGraphDetailEl.appendChild(grid);
  } else {
    architectureGraphDetailEl.appendChild(host.architectureEmpty('No relationships'));
  }

  const facts = Array.isArray(architectureGraphState.retrieve?.facts) ? architectureGraphState.retrieve.facts : [];
  const validRelationships = new Set(architectureGraphRelationships());
  const entityFacts = facts.filter(fact =>
    validRelationships.has(fact?.relationship)
    && (fact?.subject?.id === entity.id || fact?.object?.id === entity.id)
  );
  if (entityFacts.length) {
    architectureGraphDetailEl.appendChild(host.architectureHeading(4, 'Evidence'));
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const fact of entityFacts) {
      grid.appendChild(host.architectureCard(fact.relationship?.predicate || fact.sourceId, [
        `${host.architectureString(fact.subject?.canonicalName || fact.subject?.id)} -> ${host.architectureString(fact.object?.canonicalName || fact.object?.id)}`,
        fact.citation?.text,
        `Version: ${host.architectureString(fact.sourceVersionId)}`,
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
  host.architectureStatus(architectureGraphStatusEl, 'Loading graph...');
  try {
    const result = await host.callTool('context_graph_action', {
      action: 'list',
      query: { where: { op: 'eq', field: 'workspaceId', value: host.activeWorkspaceId() } },
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
    host.architectureStatus(architectureGraphStatusEl, `${architectureGraphState.entities.length} entity record(s)`);
  } catch (err) {
    host.architectureStatus(architectureGraphStatusEl, String(err?.message || err), true);
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
  host.architectureStatus(architectureGraphStatusEl, 'Retrieving graph context...');
  const terms = [...new Set((architectureGraphSearchEl?.value || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean))];
  const sourceIds = [...new Set((architectureGraphSourceEl?.value || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean))];
  try {
    const retrieve = await host.callTool('context_graph_action', {
      action: 'retrieve',
      workspaceId: host.activeWorkspaceId(),
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
    host.architectureStatus(architectureGraphStatusEl, `Retrieved ${factCount} fact(s).`);
  } catch (err) {
    if (requestId !== architectureGraphRetrieveRequest) return;
    host.architectureStatus(architectureGraphStatusEl, String(err?.message || err), true);
  } finally {
    if (requestId === architectureGraphRetrieveRequest) {
      if (architectureGraphRetrieveBtn) architectureGraphRetrieveBtn.disabled = false;
      if (architectureGraphRefreshBtn) architectureGraphRefreshBtn.disabled = false;
    }
  }
}
return {
get architectureGraphForm(){return architectureGraphForm},
get architectureGraphRefreshBtn(){return architectureGraphRefreshBtn},
get architectureGraphRetrieveBtn(){return architectureGraphRetrieveBtn},
get architectureGraphSearchEl(){return architectureGraphSearchEl},
get architectureGraphSourceEl(){return architectureGraphSourceEl},
get architectureGraphStatusEl(){return architectureGraphStatusEl},
get architectureGraphListEl(){return architectureGraphListEl},
get architectureGraphDetailEl(){return architectureGraphDetailEl},
get architectureGraphState(){return architectureGraphState},set architectureGraphState(value){architectureGraphState=value},
get architectureGraphRetrieveRequest(){return architectureGraphRetrieveRequest},set architectureGraphRetrieveRequest(value){architectureGraphRetrieveRequest=value},
get architectureGraphEntities(){return architectureGraphEntities},
get architectureGraphRelationships(){return architectureGraphRelationships},
get renderArchitectureGraphList(){return renderArchitectureGraphList},
get renderArchitectureGraphDetail(){return renderArchitectureGraphDetail},
get selectArchitectureGraphEntity(){return selectArchitectureGraphEntity},
get loadArchitectureGraph(){return loadArchitectureGraph},
get firstRetrievedArchitectureGraphEntity(){return firstRetrievedArchitectureGraphEntity},
get retrieveArchitectureGraph(){return retrieveArchitectureGraph},
async activate(force=false){if(force||!architectureGraphState.loaded)return loadArchitectureGraph(force);},
status(){return architectureGraphStatusEl;},
mount(){
architectureGraphRefreshBtn?.addEventListener('click', () => host.loadArchitecturePanel('graph', true), {signal:lifecycle.signal});

architectureGraphForm?.addEventListener('submit', retrieveArchitectureGraph, {signal:lifecycle.signal});
},dispose(){lifecycle.abort();architectureGraphRetrieveRequest++;}
};
}
