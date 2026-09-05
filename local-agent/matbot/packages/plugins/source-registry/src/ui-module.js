/** Sources: state, rendering and event handling owned by the capability. */
export function createFeature(host){
const lifecycle=new AbortController();
const architectureSourceStatusEl = document.getElementById('architecture-source-status');

const architectureSourceRefreshBtn = document.getElementById('architecture-source-refresh');

const architectureSourceListEl = document.getElementById('architecture-source-list');

const architectureSourceDetailEl = document.getElementById('architecture-source-detail');

const architectureSourceHealthSummaryEl = document.getElementById('architecture-source-health-summary');

const architectureSourceHealthModalEl = document.getElementById('architecture-source-health-modal');

const architectureSourceHealthModalContentEl = document.getElementById('architecture-source-health-modal-content');

const architectureSourceHealthModalCloseBtn = document.getElementById('architecture-source-health-modal-close');

let architectureSourcesState = { sources: [], selected: null, citation: null, events: null, selectedEvent: null, healthReport: null, loaded: false };

let architectureSourcesLoadSeq = 0;

function sourceHealthFindings(sourceId) {
  const findings = Array.isArray(architectureSourcesState.healthReport?.findings)
    ? architectureSourcesState.healthReport.findings
    : [];
  return findings.filter(finding => finding.sourceId === sourceId);
}

function sourceHealthSeverity(sourceId) {
  const severities = sourceHealthFindings(sourceId).map(finding => String(finding.severity || '').toLowerCase());
  if (severities.includes('critical') || severities.includes('error')) return 'critical';
  if (severities.includes('warning') || severities.includes('warn')) return 'warning';
  return 'healthy';
}

function renderArchitectureSourceHealthSummary() {
  host.architectureClear(architectureSourceHealthSummaryEl);
  if (!architectureSourceHealthSummaryEl) return;
  const report = architectureSourcesState.healthReport;
  const counts = [
    ['Healthy', report?.healthySources ?? architectureSourcesState.sources.filter(source => sourceHealthSeverity(source.id) === 'healthy').length, 'good'],
    ['Warnings', report?.warningCount ?? 0, 'warn'],
    ['Critical', report?.criticalCount ?? 0, 'bad'],
  ];
  for (const [label, value, tone] of counts) {
    const card = document.createElement('div');
    card.className = `source-health-count ${tone}`;
    card.dataset.healthCount = label.toLowerCase();
    const count = document.createElement('strong');
    count.textContent = String(value);
    const text = document.createElement('span');
    text.textContent = label;
    card.append(count, text);
    architectureSourceHealthSummaryEl.appendChild(card);
  }
}

function openArchitectureSourceHealthModal(sourceId) {
  const source = architectureSourcesState.sources.find(item => item.id === sourceId);
  if (!source || !architectureSourceHealthModalEl || !architectureSourceHealthModalContentEl) return;
  const report = architectureSourcesState.healthReport || {};
  const connector = (report.connectorHealth || []).find(item => item.connectorInstanceId === source.connectorInstanceId);
  host.architectureClear(architectureSourceHealthModalContentEl);
  architectureSourceHealthModalContentEl.append(
    host.architectureKeyValues([
      ['Source ID', source.id],
      ['Version ID', sourceHealthFindings(source.id).find(finding => finding.sourceVersionId)?.sourceVersionId],
      ['Connector health snapshot', connector ? `${connector.displayName || connector.connectorInstanceId}: ${connector.healthState}` : source.connectorInstanceId],
      ['Warning count', report.warningCount ?? 0],
      ['Critical count', report.criticalCount ?? 0],
      ['Health', source.healthState],
      ['Freshness', source.stalenessState],
    ]),
  );
  architectureSourceHealthModalEl.hidden = false;
}

function renderArchitectureSourceList() {
  host.architectureClear(architectureSourceListEl);
  renderArchitectureSourceHealthSummary();
  const sources = architectureSourcesState.sources;
  if (!architectureSourceListEl) return;
  if (!sources.length) {
    architectureSourceListEl.appendChild(host.architectureEmpty('No sources'));
    return;
  }
  for (const source of sources) {
    const status = source.healthState || source.stalenessState || source.sourceKind;
    const severity = sourceHealthSeverity(source.id);
    const findings = sourceHealthFindings(source.id);
    const item = host.architectureItemButton({
      title: source.title || source.id,
      meta: [source.sourceKind, source.uri].filter(Boolean).join(' | '),
      badge: status,
      active: architectureSourcesState.selected?.id === source.id,
      onClick: async () => {
        await selectArchitectureSource(source.id);
        openArchitectureSourceHealthModal(source.id);
      },
    });
    item.classList.add('architecture-source-item', `health-${severity}`);
    item.dataset.sourceId = source.id;
    if (severity !== 'healthy') {
      const indicator = document.createElement('span');
      indicator.className = `source-health-indicator ${severity === 'critical' ? 'bad' : 'warn'}`;
      indicator.setAttribute('aria-label', `${severity} source`);
      indicator.textContent = '\u26a0';
      item.querySelector('.architecture-item-title')?.appendChild(indicator);
    }
    const tooltip = document.createElement('span');
    tooltip.className = 'source-health-tooltip';
    tooltip.role = 'tooltip';
    tooltip.textContent = findings.length
      ? findings.map(finding => finding.issueType || finding.message).join(', ')
      : `${source.healthState || 'healthy'} / ${source.stalenessState || 'current'}`;
    item.appendChild(tooltip);
    architectureSourceListEl.appendChild(item);
  }
}

function renderArchitectureSourceDetail() {
  host.architectureClear(architectureSourceDetailEl);
  if (!architectureSourceDetailEl) return;
  const source = architectureSourcesState.selected;
  if (!source) {
    architectureSourceDetailEl.appendChild(host.architectureEmpty('Select a source'));
    return;
  }

  architectureSourceDetailEl.append(
    host.architectureHeading(3, source.title || source.id),
    host.architectureKeyValues([
      ['ID', source.id],
      ['URI', source.uri],
      ['Kind', source.sourceKind],
      ['Sensitivity', source.sensitivity],
      ['Permission', source.permissionState],
      ['Trust', source.trustLevel],
      ['Health', source.healthState],
      ['Freshness', source.stalenessState],
      ['Connector', source.connectorInstanceId],
      ['Observed', host.architectureDate(source.lastObservedAt)],
      ['Last read', host.architectureDate(source.lastSuccessfulReadAt)],
    ])
  );

  const limitations = Array.isArray(source.knownLimitations) ? source.knownLimitations : [];
  if (limitations.length) {
    architectureSourceDetailEl.append(host.architectureHeading(4, 'Limitations'), host.architectureInlineBadges(limitations));
  }

  const citation = architectureSourcesState.citation;
  architectureSourceDetailEl.append(host.architectureHeading(4, 'Citation'));
  architectureSourceDetailEl.appendChild(host.architectureMuted(citation?.text || citation?.sourceId || 'No citation available'));

  const findings = sourceHealthFindings(source.id);
  architectureSourceDetailEl.append(host.architectureHeading(4, 'Health Findings'));
  if (findings.length) {
    const grid = document.createElement('div');
    grid.className = 'architecture-card-grid';
    for (const finding of findings) {
      grid.appendChild(host.architectureCard(finding.issueType || finding.id, [finding.message, finding.sourceVersionId], finding.severity));
    }
    architectureSourceDetailEl.appendChild(grid);
  } else {
    architectureSourceDetailEl.appendChild(host.architectureEmpty('No findings'));
  }

  const events = architectureSourcesState.events || {};
  const access = Array.isArray(events.access) ? events.access : [];
  const health = Array.isArray(events.health) ? events.health : [];
  const versions = Array.isArray(events.versions) ? events.versions : [];
  const timeline = [
    ...access.map(event => ({ kind: 'access', event, timestamp: event.timestamp })),
    ...health.map(event => ({ kind: 'health', event, timestamp: event.checkedAt })),
    ...versions.map(event => ({ kind: 'version', event, timestamp: event.observedAt })),
  ].sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));
  architectureSourceDetailEl.append(host.architectureHeading(4, 'Events'));
  if (timeline.length) {
    const list = document.createElement('div');
    list.className = 'architecture-list architecture-source-events';
    for (const entry of timeline.slice(0, 12)) {
      const event = entry.event;
      const item = host.architectureItemButton({
        title: event.action || event.state || (entry.kind === 'version' ? 'version observed' : event.eventType) || event.id,
        meta: [event.sourceId || source.id, event.workspaceId || source.workspaceId, host.architectureDate(entry.timestamp)].filter(Boolean).join(' | '),
        badge: entry.kind,
        active: architectureSourcesState.selectedEvent?.event?.id === event.id,
        onClick: () => {
          architectureSourcesState.selectedEvent = entry;
          renderArchitectureSourceDetail();
        },
      });
      item.dataset.sourceEventId = event.id;
      item.dataset.sourceEventType = entry.kind;
      list.appendChild(item);
    }
    architectureSourceDetailEl.appendChild(list);
  } else {
    architectureSourceDetailEl.appendChild(host.architectureEmpty('No events'));
  }

  const selectedEvent = architectureSourcesState.selectedEvent;
  if (selectedEvent) {
    const event = selectedEvent.event;
    const detail = document.createElement('div');
    detail.id = 'architecture-source-event-detail';
    detail.className = 'architecture-detail-card';
    detail.append(
      host.architectureHeading(4, 'Event details'),
      host.architectureKeyValues([
        ['Event type', selectedEvent.kind],
        ['Event ID', event.id],
        ['Timestamp', host.architectureDate(selectedEvent.timestamp)],
        ['Source', event.sourceId || source.id],
        ['Source version', event.sourceVersionId || (selectedEvent.kind === 'version' ? event.id : undefined)],
        ['Workspace', event.workspaceId || source.workspaceId],
        ['User', event.principalId || event.effectiveUserId],
        ['Tool', event.toolName || event.toolCallId],
        ['Action', event.action || event.state || (selectedEvent.kind === 'version' ? 'observed' : undefined)],
        ['Allowed', event.allowed],
        ['Message', event.message],
        ['Provenance', event.provenance ? JSON.stringify(event.provenance) : undefined],
        ['Metadata', event.details ? JSON.stringify(event.details) : undefined],
      ]),
    );
    architectureSourceDetailEl.appendChild(detail);
  }
}

async function selectArchitectureSource(sourceId) {
  const source = architectureSourcesState.sources.find(item => item.id === sourceId);
  if (!source) return;
  architectureSourcesState.selected = source;
  architectureSourcesState.selectedEvent = null;
  renderArchitectureSourceList();
  renderArchitectureSourceDetail();
  host.architectureStatus(architectureSourceStatusEl, 'Loading source details...');
  try {
    const [citationResult, eventsResult] = await Promise.allSettled([
      host.callTool('source_action', { action: 'citation', sourceId: source.id }),
      host.callTool('source_action', { action: 'events', sourceId: source.id }),
    ]);
    if (architectureSourcesState.selected?.id !== source.id) return;
    architectureSourcesState.citation = citationResult.status === 'fulfilled' ? citationResult.value : null;
    architectureSourcesState.events = eventsResult.status === 'fulfilled' ? eventsResult.value : null;
    renderArchitectureSourceDetail();
    host.architectureStatus(architectureSourceStatusEl, `${architectureSourcesState.sources.length} source(s)`);
  } catch (err) {
    host.architectureStatus(architectureSourceStatusEl, String(err?.message || err), true);
  }
}

async function loadArchitectureSources() {
  const loadSeq = ++architectureSourcesLoadSeq;
  const workspaceId = host.activeWorkspaceId();
  if (architectureSourceRefreshBtn) architectureSourceRefreshBtn.disabled = true;
  host.architectureStatus(architectureSourceStatusEl, 'Loading sources...');
  const healthResultPromise = host.callTool('source_health_action', {
    action: 'report',
    workspaceId,
  }).then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason }),
  );
  try {
    const sourceResult = await host.callTool('source_action', {
      action: 'list',
      query: { where: { op: 'eq', field: 'workspaceId', value: workspaceId } },
    });
    if (loadSeq !== architectureSourcesLoadSeq || workspaceId !== host.activeWorkspaceId()) return;
    architectureSourcesState.sources = Array.isArray(sourceResult?.sources) ? sourceResult.sources : [];
    architectureSourcesState.healthReport = null;
    architectureSourcesState.loaded = true;
    const previousId = architectureSourcesState.selected?.id;
    const next = architectureSourcesState.sources.find(source => source.id === previousId) || architectureSourcesState.sources[0] || null;
    architectureSourcesState.selected = next;
    architectureSourcesState.citation = null;
    architectureSourcesState.events = null;
    architectureSourcesState.selectedEvent = null;
    renderArchitectureSourceList();
    renderArchitectureSourceDetail();
    void healthResultPromise.then(healthResult => {
      if (loadSeq !== architectureSourcesLoadSeq || workspaceId !== host.activeWorkspaceId()) return;
      architectureSourcesState.healthReport = healthResult.status === 'fulfilled' ? healthResult.value : null;
      renderArchitectureSourceList();
      renderArchitectureSourceDetail();
      if (architectureSourceHealthModalEl && !architectureSourceHealthModalEl.hidden && architectureSourcesState.selected) {
        openArchitectureSourceHealthModal(architectureSourcesState.selected.id);
      }
    });
    if (next) await selectArchitectureSource(next.id);
    else host.architectureStatus(architectureSourceStatusEl, 'No sources');
  } catch (err) {
    if (loadSeq !== architectureSourcesLoadSeq || workspaceId !== host.activeWorkspaceId()) return;
    host.architectureStatus(architectureSourceStatusEl, String(err?.message || err), true);
    architectureSourcesState.loaded = true;
    renderArchitectureSourceList();
    renderArchitectureSourceDetail();
  } finally {
    if (loadSeq === architectureSourcesLoadSeq && architectureSourceRefreshBtn) {
      architectureSourceRefreshBtn.disabled = false;
    }
  }
}
return {
get architectureSourceStatusEl(){return architectureSourceStatusEl},
get architectureSourceRefreshBtn(){return architectureSourceRefreshBtn},
get architectureSourceListEl(){return architectureSourceListEl},
get architectureSourceDetailEl(){return architectureSourceDetailEl},
get architectureSourceHealthSummaryEl(){return architectureSourceHealthSummaryEl},
get architectureSourceHealthModalEl(){return architectureSourceHealthModalEl},
get architectureSourceHealthModalContentEl(){return architectureSourceHealthModalContentEl},
get architectureSourceHealthModalCloseBtn(){return architectureSourceHealthModalCloseBtn},
get architectureSourcesState(){return architectureSourcesState},set architectureSourcesState(value){architectureSourcesState=value},
get architectureSourcesLoadSeq(){return architectureSourcesLoadSeq},set architectureSourcesLoadSeq(value){architectureSourcesLoadSeq=value},
get sourceHealthFindings(){return sourceHealthFindings},
get sourceHealthSeverity(){return sourceHealthSeverity},
get renderArchitectureSourceHealthSummary(){return renderArchitectureSourceHealthSummary},
get openArchitectureSourceHealthModal(){return openArchitectureSourceHealthModal},
get renderArchitectureSourceList(){return renderArchitectureSourceList},
get renderArchitectureSourceDetail(){return renderArchitectureSourceDetail},
get selectArchitectureSource(){return selectArchitectureSource},
get loadArchitectureSources(){return loadArchitectureSources},
async activate(force=false){if(force||!architectureSourcesState.loaded)return loadArchitectureSources();},
status(){return architectureSourceStatusEl;},
mount(){
architectureSourceRefreshBtn?.addEventListener('click', () => host.loadArchitecturePanel('sources', true), {signal:lifecycle.signal});

architectureSourceHealthModalCloseBtn?.addEventListener('click', () => {
    if (architectureSourceHealthModalEl) architectureSourceHealthModalEl.hidden = true;
  }, {signal:lifecycle.signal});
},dispose(){lifecycle.abort();architectureSourcesLoadSeq++;}
};
}
