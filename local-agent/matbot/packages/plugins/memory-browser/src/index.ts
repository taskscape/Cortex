import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Filter, MatbotPluginSpec, MatbotMachine, Principal, Store, StoreQuery, Tool, ToolEvent } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, runAs, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

interface RememberedFact {
  id: string;
  version: string;
  fact: string;
  sessionId: string;
  messageId: string;
  createdAt: string;
  dreamSkill?: string;
  ignoreUntil?: string;
}

const HOST = process.env['MATBOT_MEMORY_BROWSER_HOST'] ?? '127.0.0.1';
const PORT = Number(process.env['MATBOT_MEMORY_BROWSER_PORT'] ?? 19779);
const BASE_URL = `http://${HOST}:${PORT}`;

let activeServer: ReturnType<typeof createServer> | undefined;
let activeUrl: string | undefined;
let startupError: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-cache',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function parseLimit(raw: string | null): number {
  if (raw === null) return 50;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(n)));
}

function memoryFilter(params: URLSearchParams): Filter | undefined {
  const clauses: Filter[] = [];
  const q = params.get('q')?.trim();
  const state = params.get('state') ?? 'all';

  if (q) clauses.push({ op: 'stringContains', field: 'fact', value: q });
  if (state === 'unprocessed') clauses.push({ op: 'exists', field: 'dreamSkill', value: false });
  if (state === 'processed') clauses.push({ op: 'exists', field: 'dreamSkill', value: true });
  if (state === 'ignored') clauses.push({ op: 'exists', field: 'ignoreUntil', value: true });

  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { op: 'and', clauses };
}

function safePatch(current: RememberedFact, input: Record<string, unknown>): RememberedFact | { error: string } {
  const next: RememberedFact = { ...current, version: crypto.randomUUID() };

  if (Object.prototype.hasOwnProperty.call(input, 'fact')) {
    if (typeof input.fact !== 'string' || input.fact.trim() === '') return { error: '"fact" must be a non-empty string.' };
    next.fact = input.fact.trim();
  }
  if (Object.prototype.hasOwnProperty.call(input, 'dreamSkill')) {
    if (input.dreamSkill === null || input.dreamSkill === '') delete next.dreamSkill;
    else if (typeof input.dreamSkill === 'string') next.dreamSkill = input.dreamSkill;
    else return { error: '"dreamSkill" must be a string, null, or empty string.' };
  }
  if (Object.prototype.hasOwnProperty.call(input, 'ignoreUntil')) {
    if (input.ignoreUntil === null || input.ignoreUntil === '') delete next.ignoreUntil;
    else if (typeof input.ignoreUntil === 'string') next.ignoreUntil = input.ignoreUntil;
    else return { error: '"ignoreUntil" must be a string, null, or empty string.' };
  }

  return next;
}

async function serveStatic(res: ServerResponse, path: string, contentType: string): Promise<void> {
  const body = await readFile(new URL(path, import.meta.url), 'utf8');
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function createMemoryBrowserServer(store: Store<RememberedFact>, principal: Principal) {
  return createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const requestUrl = new URL(req.url ?? '/', BASE_URL);
    try {
      await runAs(principal, async () => {
        if (method === 'GET' && requestUrl.pathname === '/') {
          await serveStatic(res, '../static/index.html', 'text/html; charset=utf-8');
          return;
        }
        if (method === 'GET' && requestUrl.pathname === '/app.js') {
          await serveStatic(res, '../static/app.js', 'application/javascript; charset=utf-8');
          return;
        }
        if (method === 'GET' && requestUrl.pathname === '/style.css') {
          await serveStatic(res, '../static/style.css', 'text/css; charset=utf-8');
          return;
        }
        if (method === 'GET' && requestUrl.pathname === '/api/health') {
          json(res, 200, { status: 'ok' });
          return;
        }

        if (method === 'GET' && requestUrl.pathname === '/api/memories') {
          const query: StoreQuery = {
            limit: parseLimit(requestUrl.searchParams.get('limit')),
            sort: [{ field: 'createdAt', dir: requestUrl.searchParams.get('sort') === 'asc' ? 'asc' : 'desc' }],
          };
          const where = memoryFilter(requestUrl.searchParams);
          if (where !== undefined) query.where = where;
          const cursor = requestUrl.searchParams.get('cursor');
          if (cursor) query.cursor = cursor;
          json(res, 200, await store.query(query));
          return;
        }

        if (method === 'POST' && requestUrl.pathname === '/api/memories') {
          const input = await readJson(req);
          if (!isRecord(input) || typeof input.fact !== 'string' || input.fact.trim() === '') {
            json(res, 400, { error: '"fact" is required.' });
            return;
          }
          const now = new Date().toISOString();
          const doc: RememberedFact = {
            id: crypto.randomUUID(),
            version: crypto.randomUUID(),
            fact: input.fact.trim(),
            sessionId: typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : 'manual',
            messageId: typeof input.messageId === 'string' && input.messageId.trim() ? input.messageId.trim() : 'manual',
            createdAt: now,
          };
          await store.set(doc.id, doc);
          json(res, 201, doc);
          return;
        }

        const memoryMatch = /^\/api\/memories\/([^/]+)$/.exec(requestUrl.pathname);
        if (memoryMatch) {
          const id = decodeURIComponent(memoryMatch[1]!);

          if (method === 'GET') {
            const doc = await store.get(id);
            if (!doc) json(res, 404, { error: 'Memory not found.' });
            else json(res, 200, doc);
            return;
          }

          if (method === 'PATCH') {
            const input = await readJson(req);
            if (!isRecord(input) || typeof input.expected !== 'string') {
              json(res, 400, { error: '"expected" version is required.' });
              return;
            }
            const current = await store.get(id);
            if (!current) {
              json(res, 404, { error: 'Memory not found.' });
              return;
            }
            const next = safePatch(current, input);
            if ('error' in next) {
              json(res, 400, { error: next.error });
              return;
            }
            const result = await store.cas(id, input.expected, next);
            if (!result.ok) json(res, 409, { error: 'Version conflict.', current: result.current });
            else json(res, 200, result.doc);
            return;
          }

          if (method === 'DELETE') {
            let expected = requestUrl.searchParams.get('expected') ?? undefined;
            if (expected === undefined) {
              try {
                const input = await readJson(req);
                if (isRecord(input) && typeof input.expected === 'string') expected = input.expected;
              } catch { /* DELETE bodies are optional. */ }
            }
            json(res, 200, { deleted: await store.delete(id, expected) });
            return;
          }
        }

        json(res, 404, { error: 'Not found.' });
      });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    }
  });
}

function openMemoryBrowserTool(): Tool {
  return {
    name: 'open_memory_browser',
    description: 'Return the local URL for the standalone Cortex memory browser window.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    executor: {
      async *execute(): AsyncIterable<ToolEvent> {
        if (!activeUrl) {
          yield { type: 'error', message: startupError ?? 'Memory browser server is not running.' };
          return;
        }
        yield { type: 'result', value: { url: activeUrl } };
      },
    },
  };
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Standalone local browser for remembered_facts memory records.',
  },

  async installationMessage() {
    return activeUrl
      ? `Memory browser is available at ${activeUrl}/.`
      : `Memory browser did not start: ${startupError ?? 'unknown startup error'}.`;
  },

  async setup(services: MatbotMachine) {
    services.tools.register(openMemoryBrowserTool());
    if (services.isSubAgent()) return;

    const store = services.createStore<RememberedFact>('remembered_facts');
    const principal = tryCurrentPrincipal() ?? { id: 'memory-browser', type: 'user' as const };
    const server = createMemoryBrowserServer(store, principal);

    await new Promise<void>((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
          startupError = `Port ${PORT} is already in use.`;
          console.warn(`[memory-browser] ${startupError}`);
          resolve();
          return;
        }
        reject(e);
      });
      server.listen(PORT, HOST, () => {
        activeServer = server;
        activeUrl = BASE_URL;
        startupError = undefined;
        services.registerFrontend({ name: 'memory-browser' });
        process.stderr.write(`[memory-browser] ${BASE_URL}/\n`);
        resolve();
      });
    });
  },

  async teardown() {
    const server = activeServer;
    activeServer = undefined;
    activeUrl = undefined;
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  },
};
