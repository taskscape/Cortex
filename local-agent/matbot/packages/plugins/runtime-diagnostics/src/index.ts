import { createToolInvoker } from '@matatbread/matbot-core';
import { uiContribution } from './ui.js';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, ToolEvent } from '@matatbread/matbot-plugin-api';
import type { HealthStatus } from '@matatbread/matbot-capabilities-types';
export async function collectHealth(services: MatbotMachine, signal: AbortSignal) {
    const rows = services.contributions?.list('health') ?? [];
    const results = await Promise.all(rows.map(async (row) => {
        const ac = new AbortController();
        const combined = AbortSignal.any([signal, row.signal, ac.signal]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const status = await Promise.race([row.value.probe(combined), new Promise<HealthStatus>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error('Health probe timed out')); }, Math.min(Math.max(row.value.timeoutMs ?? 3000, 50), 10000)); })]);
            return { id: row.id, owner: row.owner, ...status };
        }
        catch (error) {
            return { id: row.id, owner: row.owner, state: 'unavailable' as const, message: String(error) };
        }
        finally {
            clearTimeout(timer);
            ac.abort();
        }
    }));
    signal.throwIfAborted();
    return { state: results.every(r => r.state === 'ready') ? 'ready' : 'degraded', capabilities: results };
}
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION, async setup(services) {
        services.contributions?.register('webui', 'diagnostics', uiContribution);
        services.tools.register({ name: 'runtime_diagnostics', description: 'Report health of selected plugin capabilities and bounded dependency probes.', inputSchema: { type: 'object', properties: {} }, executor: { async *execute(_input, ctx): AsyncIterable<ToolEvent> { yield { type: 'result', value: await collectHealth(services, ctx.signal) }; } } });
        services.contributions?.register('http', 'diagnostics', { method: 'GET', path: '/api/diagnostics', async handle({ context }) { const tool = services.tools.resolve('runtime_diagnostics'); if (!tool)
                return { status: 503, body: { error: 'Diagnostics unavailable' } }; for await (const event of createToolInvoker(services).invoke(tool, {}, context)) {
                if (event.type === 'result')
                    return { status: 200, body: event.value };
                if (event.type === 'error')
                    return { status: event.code === 'permission_denied' ? 403 : 409, body: { error: event.message, code: event.code } };
            } return { status: 500, body: { error: 'No diagnostics result' } }; } });
    } };
