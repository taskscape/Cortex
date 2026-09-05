import type { WebUiContribution } from '@matatbread/matbot-capabilities-types';
function createFeature(host: any) { const lifetime = new AbortController(); const root = document.getElementById('architecture-panel-diagnostics')!; const output = root.querySelector('pre')!; let request = 0; const activate = async () => { const seq = ++request; try {
    const health = await host.transport.callTool('runtime_diagnostics', {});
    if (!lifetime.signal.aborted && seq === request)
        output.textContent = JSON.stringify(health, null, 2);
}
catch (error) {
    if (!lifetime.signal.aborted)
        output.textContent = String(error);
} }; return { activate, status: () => output, mount() { root.querySelector('button')!.addEventListener('click', () => void activate(), { signal: lifetime.signal }); }, dispose() { request++; lifetime.abort(); } }; }
export const uiContribution: WebUiContribution = { title: 'Diagnostics', view: 'diagnostics', slot: 'architecture', requiresTools: ['runtime_diagnostics'], moduleSource: 'export const createFeature = ' + createFeature.toString(), fragments: [{ id: 'architecture-panel-diagnostics', html: '<section class="architecture-panel" id="architecture-panel-diagnostics" data-architecture-panel="diagnostics" role="tabpanel"><h3>Capability health</h3><button>Refresh</button><pre aria-live="polite"></pre></section>' }] };
