import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, ToolEvent } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-capabilities-types';
import type {} from '@matatbread/matbot-file-services-types';
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION, async setup(services) {
        services.contributions?.register('retrieval', 'host-files', { title: 'Host text index', scope: 'host', async search(query) { const index = services.FileIndex; if (!index)
                throw new Error('File index unloaded'); const response = await index.search(query.query, query.limit, query.signal) as {
                results: Array<{
                    id: string;
                    path: string;
                    content: string;
                }>;
            }; return response.results.map(hit => ({ id: hit.id, sourceId: 'host-files', workspaceId: query.workspaceId, content: hit.content, citation: { path: hit.path } })); } });
        services.contributions?.register('health', 'file-index', { async probe() { const index = services.FileIndex; if (!index)
                throw new Error('File index unloaded'); return { state: 'ready', details: await index.health() }; } });
        services.tools.register({ name: 'file_index', description: 'Index configured host roots, search host text files, inspect or cancel indexing jobs. Workspace RAG uses workspace_rag.', inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['index', 'reconcile', 'search', 'status', 'cancel'] }, root: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' }, jobId: { type: 'string' } } }, executor: { async *execute(input, ctx): AsyncIterable<ToolEvent> {
                    const index = services.FileIndex;
                    if (!index)
                        throw new Error('File index unavailable');
                    const args = input as {
                        action: string;
                        root?: string;
                        query?: string;
                        limit?: number;
                        jobId?: string;
                    };
                    ctx.signal.throwIfAborted();
                    let value: unknown;
                    switch (args.action) {
                        case 'index':
                        case 'reconcile':
                            value = await index.index(args.root, ctx.signal);
                            break;
                        case 'search':
                            value = await index.search(args.query ?? '', args.limit, ctx.signal);
                            break;
                        case 'status':
                            value = await index.health();
                            break;
                        case 'cancel':
                            value = await index.cancel(args.jobId);
                            break;
                        default: throw new Error('Unknown index action');
                    }
                    yield { type: 'result', value };
                } } });
    } };
