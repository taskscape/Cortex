import http from 'node:http';
import { HttpError, assertLoopbackRequest, assertSharedToken, isJsonObject, readJsonBody, requestAbortSignal, sendJson, sendJsonError } from '@local-agent/http-utils';
import { FileAccessError, type HostFileAccessService } from './service.js';
export function createFileBrokerServer(service: Pick<HostFileAccessService, 'health' | 'list' | 'read' | 'write'>, token?: string) {
    return http.createServer(async (request, response) => {
        try {
            assertLoopbackRequest(request);
            const url = new URL(request.url ?? '/', 'http://' + (request.headers.host ?? 'localhost'));
            const signal = requestAbortSignal(request);
            if (request.method === 'GET' && url.pathname === '/health') {
                sendJson(response, 200, await service.health(signal));
                return;
            }
            assertSharedToken(request, token);
            const target = () => { const value = url.searchParams.get('path'); if (!value)
                throw new HttpError(400, 'Missing query parameter: path'); return value; };
            if (request.method === 'GET' && url.pathname === '/list') {
                sendJson(response, 200, await service.list(target(), signal));
                return;
            }
            if (request.method === 'GET' && url.pathname === '/read') {
                sendJson(response, 200, await service.read(target(), signal));
                return;
            }
            if (request.method === 'POST' && url.pathname === '/write') {
                const body = await readJsonBody<{
                    path: string;
                    content: string;
                    approved?: boolean;
                }>(request, { validate: (value): value is {
                        path: string;
                        content: string;
                        approved?: boolean;
                    } => isJsonObject(value) && typeof value.path === 'string' && value.path.length > 0 && typeof value.content === 'string' && (value.approved === undefined || typeof value.approved === 'boolean') });
                sendJson(response, 200, await service.write(body.path, body.content, body.approved === true, signal));
                return;
            }
            sendJson(response, 404, { error: 'Not found.' });
        }
        catch (error) {
            if (error instanceof FileAccessError)
                sendJson(response, error.status, error.payload);
            else
                sendJsonError(response, error);
        }
    });
}
