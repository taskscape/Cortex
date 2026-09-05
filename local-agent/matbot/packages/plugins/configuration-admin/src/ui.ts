import type { WebUiContribution } from '@matatbread/matbot-capabilities-types';
function createFeature(host: any) {
    const lifetime = new AbortController();
    let version = '', request = 0;
    const root = document.getElementById('architecture-panel-configuration')!;
    const select = root.querySelector('select')!, editor = root.querySelector('textarea')!, status = root.querySelector('[role="status"]')!, history = root.querySelector('[data-history]')!;
    const call = (input: any) => host.transport.callTool('configuration_action', input);
    const run = async (operation: () => Promise<void>) => { try {
        await operation();
    }
    catch (error) {
        if (!lifetime.signal.aborted)
            status.textContent = String(error);
    } };
    const read = async () => { const seq = ++request; const result = await call({ action: 'get', id: select.value }); if (seq !== request || lifetime.signal.aborted)
        return; version = result.version; editor.value = JSON.stringify(result.value, null, 2); status.textContent = 'Changes apply: ' + result.apply; history.replaceChildren(); };
    const activate = async () => run(async () => { const rows = await call({ action: 'list' }); if (lifetime.signal.aborted)
        return; const previous = select.value; select.replaceChildren(...rows.map((row: any) => { const option = document.createElement('option'); option.value = row.id; option.textContent = row.title; return option; })); if (rows.some((row: any) => row.id === previous))
        select.value = previous; if (rows.length)
        await read();
    else
        status.textContent = 'No configuration providers are loaded.'; });
    return { activate, status: () => status, mount() {
            select.addEventListener('change', () => void run(read), { signal: lifetime.signal });
            root.querySelector('[data-save]')!.addEventListener('click', () => void run(async () => { const result = await call({ action: 'update', id: select.value, value: JSON.parse(editor.value), expectedVersion: version }); if (lifetime.signal.aborted)
                return; version = result.version; editor.value = JSON.stringify(result.value, null, 2); status.textContent = result.historyPending ? 'Saved; history finalization is pending.' : 'Saved. Changes apply: ' + result.apply; }), { signal: lifetime.signal });
            root.querySelector('[data-refresh]')!.addEventListener('click', () => void run(read), { signal: lifetime.signal });
            root.querySelector('[data-show-history]')!.addEventListener('click', () => void run(async () => { const page = await call({ action: 'history', id: select.value }); if (lifetime.signal.aborted)
                return; history.replaceChildren(...page.items.map((row: any) => { const button = document.createElement('button'); button.textContent = 'Restore values before ' + row.at + ' (' + row.state + ')'; button.disabled = row.state !== 'applied'; button.addEventListener('click', () => void run(async () => { await call({ action: 'restore', id: select.value, historyId: row.id, expectedVersion: version }); await read(); }), { signal: lifetime.signal }); return button; })); }), { signal: lifetime.signal });
        }, dispose() { request++; lifetime.abort(); } };
}
export const uiContribution: WebUiContribution = { title: 'Configuration', view: 'configuration', slot: 'architecture', moduleSource: 'export const createFeature = ' + createFeature.toString(), requiresTools: ['configuration_action'], fragments: [{ id: 'architecture-panel-configuration', html: '<section class="architecture-panel" id="architecture-panel-configuration" data-architecture-panel="configuration" role="tabpanel"><h3>Configuration</h3><label>Settings owner <select aria-label="Settings owner"></select></label><textarea aria-label="Settings JSON" rows="16" style="width:100%"></textarea><button data-save>Save</button><button data-refresh>Reload</button><button data-show-history>History</button><p role="status"></p><div data-history></div></section>' }] };
