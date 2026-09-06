import path from 'node:path';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-capabilities-types';
import type {} from '@matatbread/matbot-workspace-manager-types';
import { Mem0Client } from './mem0-client.js';
export { Mem0Client };
/**
 * Derives the workspace id from a config file path: the immediate parent
 * directory name when the config lives in a `workspaces/<name>/` directory,
 * otherwise `'default'`.
 *
 * @param configPath - Path to a `matbot.yaml`, or `undefined`/empty meaning no
 *   workspace layout was supplied.
 * @returns The workspace id (`'default'` when the path is missing or not
 *   inside a `workspaces/` directory); lowercase normalization is not applied.
 */
export function workspaceIdFromConfigPath(configPath: string | undefined) { if (!configPath)
    return 'default'; const dir = path.dirname(path.resolve(configPath)); return path.basename(path.dirname(dir)).toLowerCase() === 'workspaces' ? path.basename(dir) : 'default'; }
/**
 * Namespaces a base Mem0 user id per workspace, so different workspaces never
 * share memories even when the backend user is the same.
 * @param base - Base user id (e.g. `MEM0_USER_ID` or `'local-agent'`).
 * @param workspace - Workspace id to scope under.
 * @returns The combined id in the form `<base>:workspace:<workspace>`.
 */
export const workspaceScopedMem0UserId = (base: string, workspace: string) => base + ':workspace:' + workspace;
/**
 * Builds the Mem0-backed memory plugin: claims the `MemoryWriteSink` service
 * and forwards writes and searches to a Mem0 HTTP server over the network
 * (base URL, API key, and base user id from `MEM0_BASE_URL`, `MEM0_API_KEY`,
 * and `MEM0_USER_ID`). Registers a workspace-scoped `retrieval` source and a
 * `health` probe that performs a sentinel search against the backend. All
 * calls are scoped to the derived workspace and aborted on plugin teardown.
 *
 * @returns The matbot plugin specification.
 * @throws Never - the factory only builds the spec; `setup` raises errors.
 */
export function createMem0Plugin(): MatbotPluginSpec {
    let lifetime = new AbortController();
    return { apiVersion: PLUGIN_API_VERSION, /**
             * Creates the Mem0 client, claims the `MemoryWriteSink` service, and
             * registers the `mem0` retrieval source and health probe.
             *
             * @param services - Machine services; must not already have a `MemoryWriteSink`.
             * @throws Error - If a `MemoryWriteSink` is already selected by another plugin.
             */
            async setup(services) {
            lifetime = new AbortController();
            if (services.MemoryWriteSink)
                throw new Error('A memory write sink is already selected');
            const workspaceId = services.WorkspaceContext?.id ?? workspaceIdFromConfigPath(services.configPath);
            const client = new Mem0Client({ baseUrl: process.env.MEM0_BASE_URL ?? 'http://localhost:8888', ...(process.env.MEM0_API_KEY !== undefined ? { apiKey: process.env.MEM0_API_KEY } : {}), userId: workspaceScopedMem0UserId(process.env.MEM0_USER_ID ?? 'local-agent', workspaceId), workspaceId });
            /**
             * Forwards one knowledge entry to the Mem0 backend over HTTP. The
             * request is aborted when the plugin is torn down or the caller's
             * signal fires.
             * @param entry - Knowledge entry to send.
             * @param signal - Optional caller abort signal.
             * @throws Error - On network failure or a non-success Mem0 response.
             */
            await services.register('MemoryWriteSink', { index: (entry, signal) => client.add(entry, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])])) });
            /**
             * Searches the Mem0 backend over HTTP for memories scoped to this
             * plugin's workspace. Only meaningful for that workspace.
             *
             * @param query - Retrieval parameters: terms, limit, workspace id,
             *   principal, and abort signal.
             * @returns Hits built from the matched knowledge entries, truncated
             *   to `query.limit`, each citing the entry's source.
             * @throws Error - If `query.workspaceId` differs from the plugin's
             *   workspace, or on network failure / non-success Mem0 response.
             */
            services.contributions?.register('retrieval', 'mem0', { title: 'Mem0 memories', scope: 'workspace', async search(query) { if (query.workspaceId !== workspaceId)
                    throw new Error('Mem0 workspace mismatch'); const entries = await client.search(query.query, AbortSignal.any([lifetime.signal, query.signal])); return entries.slice(0, query.limit).map(knowledge => ({ id: knowledge.id, sourceId: 'mem0', workspaceId, content: knowledge.content, knowledge, citation: knowledge.source })); } });
            /**
             * Health probe: performs a sentinel search against the Mem0
             * backend; reaching the service counts as ready regardless of hits.
             * @param signal - Probe abort signal; aborting fails the probe.
             * @returns `ready` status when the backend responded.
             * @throws Error - On network failure or a non-success Mem0 response.
             */
            services.contributions?.register('health', 'mem0', { async probe(signal) { await client.search('__cortex_health_probe__', signal); return { state: 'ready' }; } });
        }, /**
             * Aborts the plugin lifetime, cancelling any in-flight Mem0 requests
             * issued through the registered sink and sources.
             */
            async teardown() { lifetime.abort(); } };
}
export const plugin = createMem0Plugin();
