import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Filter, MatbotPluginSpec, MatbotMachine, Principal, Store, StoreQuery, Tool, ToolEvent } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, runAs, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

/**
 * One remembered fact document, stored in the `remembered_facts` store.
 * `dreamSkill` marks a fact as processed by a dream/skill run; `ignoreUntil`
 * suppresses re-processing until the given ISO timestamp.
 */
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
const CLOSE_GRACE_MS = 1_000;

let activeServer: ReturnType<typeof createServer> | undefined;
let activeUrl: string | undefined;
let startupError: string | undefined;

/**
 * Checks whether a value is a plain, non-array object.
 * @param value - Value to test.
 * @returns True when `value` is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Writes a JSON response with no-cache headers.
 * @param res - Response to write to; headers must not have been sent yet.
 * @param status - HTTP status code to send.
 * @param body - Value serialized as the JSON response body.
 */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-cache',
  });
  res.end(payload);
}

/**
 * Reads a request body as UTF-8 text with a size cap.
 * @param req - Incoming request whose body is streamed and collected.
 * @param maxBytes - Maximum accepted body size in bytes; defaults to 1 MiB.
 * @returns The full body as a UTF-8 string.
 * @throws Error - If the body exceeds `maxBytes` or the request stream errors.
 */
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

/**
 * Reads a request body and parses it as JSON.
 * @param req - Incoming request to read.
 * @returns The parsed body, or an empty object for an empty body.
 * @throws Error - If the body exceeds the size cap or is not valid JSON
 *   (JSON.parse {@link SyntaxError}).
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

/**
 * Parses and clamps a `limit` query parameter.
 * @param raw - Raw parameter value; `null` (absent) means the default.
 * @returns The parsed limit clamped to the 1–200 range; 50 for absent or
 *   non-numeric values.
 */
function parseLimit(raw: string | null): number {
  if (raw === null) return 50;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(n)));
}

/**
 * Builds a store filter from list-query parameters. `q` filters the `fact`
 * field by substring; `state` selects `unprocessed` (no `dreamSkill`),
 * `processed` (has `dreamSkill`), or `ignored` (has `ignoreUntil`); `all`
 * (default) adds no clause.
 *
 * @param params - Query parameters of the list request.
 * @returns A single filter clause, an `and` of clauses, or `undefined` when no
 *   filtering was requested.
 */
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

/**
 * Applies a partial update to a fact document without touching the store.
 * Only `fact`, `dreamSkill`, and `ignoreUntil` are mutable; setting a nullable
 * field to `null` or `''` removes it. The result carries a fresh version token
 * and must be written back via `store.cas` with the caller's expected version.
 *
 * @param current - The current stored document.
 * @param input - Patch payload; absent keys are left unchanged.
 * @returns The next document, or `{ error }` when a present field has an
 *   invalid type (`fact` must be a non-empty string; the other two a string,
 *   `null`, or `''`).
 */
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

/**
 * Serves a bundled static asset from disk with no-cache headers.
 * @param res - Response to write the asset to.
 * @param path - Asset path relative to this module's URL.
 * @param contentType - Content-Type header value for the asset.
 * @throws Error - If the asset file cannot be read (the HTTP handler converts
 *   this into a 500 response).
 */
async function serveStatic(res: ServerResponse, path: string, contentType: string): Promise<void> {
  const body = await readFile(new URL(path, import.meta.url), 'utf8');
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

/**
 * Create the local HTTP server backing the memory browser UI. Serves static assets plus a JSON API
 * over the store: list/query memories, create, read, patch (compare-and-swap), and delete. Every
 * request runs under the given principal so store authorization applies.
 *
 * @param store The `remembered_facts` store to browse.
 * @param principal Principal under which all store operations execute.
 * @returns A Node HTTP server; call `.listen()` to start it.
 * @throws Never - request handler failures are answered as 500 responses.
 */
export function createMemoryBrowserServer(store: Store<RememberedFact>, principal: Principal) {
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

/**
 * Close a server created by {@link createMemoryBrowserServer}, releasing idle keep-alive sockets
 * immediately and force-closing any remaining connections after the grace period, so shutdown can
 * never hang on an in-flight request.
 * @param server The server to close.
 * @param graceMs How long to wait before force-closing active connections.
 * @throws Never - close errors are logged as warnings, not rethrown.
 */
export async function closeMemoryBrowserServer(
  server: ReturnType<typeof createServer>,
  graceMs = CLOSE_GRACE_MS,
): Promise<void> {
  // server.close() waits for active requests, including a half-sent request body or a store call that
  // never settles. Release idle keep-alive sockets now and bound the remaining wait so plugin unload
  // and process shutdown cannot hang indefinitely.
  server.closeIdleConnections();
  const graceTimer = setTimeout(() => server.closeAllConnections(), Math.max(0, graceMs));
  try {
    await new Promise<void>(resolve => {
      server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          console.warn('[memory-browser] Error closing server:', String(error));
        }
        resolve();
      });
    });
  } finally {
    clearTimeout(graceTimer);
  }
}

/**
 * Factory for the `open_memory_browser` tool, which reports the local URL of
 * the running memory browser server (or an error event when it never started).
 *
 * @returns The tool specification with an empty input schema.
 */
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

/**
 * The memory-browser plugin. Registers the `open_memory_browser` tool in every session and, except
 * in sub-agents, starts a local HTTP server on `MATBOT_MEMORY_BROWSER_HOST:PORT` (default
 * 127.0.0.1:19779) browsing the shared `remembered_facts` store.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Standalone local browser for remembered_facts memory records.',
  },

  /**
   * Reports whether the browser server started and where to reach it.
   * @returns A human-readable availability message for the installing user.
   */
  async installationMessage() {
    return activeUrl
      ? `Memory browser is available at ${activeUrl}/.`
      : `Memory browser did not start: ${startupError ?? 'unknown startup error'}.`;
  },

  /**
   * Registers the `open_memory_browser` tool and, outside sub-agents, starts
   * the local HTTP server bound to the configured host/port. Store operations
   * run under the ambient principal (or a `memory-browser` fallback). A port
   * already in use is tolerated: startup resolves with `startupError` set
   * instead of rejecting.
   *
   * @param services - Machine services; used to register the tool and create
   *   the `remembered_facts` store.
   * @throws Error - If the server fails to listen for a reason other than
   *   `EADDRINUSE`.
   */
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

  /**
   * Stops the memory browser server and clears its module-level state. A
   * no-op when the server never started.
   */
  async teardown() {
    const server = activeServer;
    activeServer = undefined;
    activeUrl = undefined;
    if (server) {
      await closeMemoryBrowserServer(server);
    }
  },
};
