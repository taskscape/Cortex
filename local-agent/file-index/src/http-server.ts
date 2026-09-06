import http from 'node:http';
import { assertLoopbackRequest, assertSharedToken, isJsonObject, readJsonBody, requestAbortSignal, sendJson, sendJsonError } from '@local-agent/http-utils';
import type { FileIndexService } from './service.js';
/**
 * Creates the file-index HTTP server exposing `FileIndexService` over
 * loopback-only endpoints: `GET /health` (no token required), plus
 * token-gated `POST /index`, `POST /search`, and `POST /cancel`. Every request
 * must carry a loopback `Host` header (DNS-rebinding defense). All thrown
 * errors (including `HttpError` from authorization) are reported via
 * {@link sendJsonError}.
 *
 * @param service - The backing service; health/index/search plus `cancel`.
 * @param token - Optional shared secret checked on every non-health request.
 * @returns An `http.Server` the caller must `listen()` itself.
 */
export function createFileIndexServer(service: Pick<FileIndexService, 'health' | 'index' | 'search'> & {
    cancel(id?: string): unknown | Promise<unknown>;
}, token?: string) {
    return http.createServer(async (request, response) => {
        try {
            assertLoopbackRequest(request);
            const url = new URL(request.url ?? '/', 'http://' + (request.headers.host ?? 'localhost'));
            const signal = requestAbortSignal(request);
            if (request.method === 'GET' && url.pathname === '/health') {
                sendJson(response, 200, await service.health());
                return;
            }
            assertSharedToken(request, token);
            if (request.method === 'POST' && url.pathname === '/cancel') {
                const body = await readJsonBody<{
                    id?: string;
                }>(request, { validate: (v): v is {
                        id?: string;
                    } => isJsonObject(v) && (v.id === undefined || typeof v.id === 'string') });
                sendJson(response, 200, await service.cancel(body.id));
                return;
            }
            if (request.method === 'POST' && url.pathname === '/index') {
                const body = await readJsonBody<{
                    root?: string;
                }>(request, { validate: (v): v is {
                        root?: string;
                    } => isJsonObject(v) && (v.root === undefined || typeof v.root === 'string') });
                sendJson(response, 200, await service.index(body.root, signal));
                return;
            }
            if (request.method === 'POST' && url.pathname === '/search') {
                const body = await readJsonBody<{
                    query: string;
                    limit?: number;
                }>(request, { validate: (v): v is {
                        query: string;
                        limit?: number;
                    } => isJsonObject(v) && typeof v.query === 'string' && v.query.trim().length > 0 && (v.limit === undefined || (typeof v.limit === 'number' && Number.isFinite(v.limit))) });
                sendJson(response, 200, await service.search(body.query, body.limit, signal));
                return;
            }
            sendJson(response, 404, { error: 'Not found.' });
        }
        catch (error) {
            sendJsonError(response, error);
        }
    });
}
