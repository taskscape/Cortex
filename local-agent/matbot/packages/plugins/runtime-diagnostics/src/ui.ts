import type { WebUiContribution } from '@matatbread/matbot-capabilities-types';
/**
 * Factory for the diagnostics architecture panel. Serialized into the
 * `uiContribution` module source and executed in the browser, where it wires
 * the panel's refresh button and output `<pre>` to the `runtime_diagnostics`
 * tool via the host transport. Stale responses (a newer refresh started, or
 * the panel was disposed) are discarded; all listeners share one lifetime
 * {@link AbortController}.
 *
 * @param host - Web host object exposing `transport.callTool(name, input)`.
 * @returns Feature object with `activate` (fetch and render the health
 *   report), `status` (output element accessor), `mount` (attaches the
 *   refresh listener), and `dispose` (aborts the lifetime and invalidates
 *   in-flight renders).
 */
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
