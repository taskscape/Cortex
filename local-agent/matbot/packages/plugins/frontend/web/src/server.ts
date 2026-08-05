import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  MatbotPlugin, Principal, Session, Store, ToolRegistry, FileStore, Vault, Message, MessageContent,
  FormField, PromptFn, SessionRunner, PluginRegistryEvent,
} from '@matatbread/matbot-core';
import { appendMessage, createMessage, createSession, PromptCancelledError, runAs, tryCurrentPrincipal } from '@matatbread/matbot-core';
import type { SkillManager } from '@matatbread/matbot-skills';
import { sseComment, sseEvent } from './sse-writer.js';
import { promises } from "node:fs";
const { readFile } = promises;

export interface WebBranding {
  productName: string;
  title: string;
  brand?: string;
  brandStrong?: string;
  brandSoft?: string;
}

const DEFAULT_WEB_BRANDING: WebBranding = { productName: 'Cortex', title: 'Cortex' };
const CSS_COLOR = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^<>]{1,80}\))$/;

/** Parse only presentation-safe branding values. Invalid input falls back per field. */
export function parseWebBranding(raw = process.env['CORTEX_WEBUI_BRANDING_JSON']): WebBranding {
  if (!raw) return { ...DEFAULT_WEB_BRANDING };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return { ...DEFAULT_WEB_BRANDING };
    const text = (key: 'productName' | 'title', fallback: string) => {
      const candidate = value[key];
      return typeof candidate === 'string' && candidate.trim() && candidate.trim().length <= 80 ? candidate.trim() : fallback;
    };
    const color = (key: 'brand' | 'brandStrong' | 'brandSoft') => {
      const candidate = value[key];
      return typeof candidate === 'string' && CSS_COLOR.test(candidate.trim()) ? candidate.trim() : undefined;
    };
    const brand = color('brand');
    const brandStrong = color('brandStrong');
    const brandSoft = color('brandSoft');
    return {
      productName: text('productName', DEFAULT_WEB_BRANDING.productName),
      title: text('title', text('productName', DEFAULT_WEB_BRANDING.title)),
      ...(brand !== undefined ? { brand } : {}),
      ...(brandStrong !== undefined ? { brandStrong } : {}),
      ...(brandSoft !== undefined ? { brandSoft } : {}),
    };
  } catch {
    return { ...DEFAULT_WEB_BRANDING };
  }
}

export interface WebServerDeps {
  store:          Store<Session>;
  /** Per-session turn serialiser — submits queue instead of running concurrently. */
  run:            SessionRunner;
  vault:          Vault;
  loadPlugin:     (specifier: string) => Promise<MatbotPlugin>;
  unloadPlugin:   (specifier: string) => Promise<boolean>;
  watchPlugins?:  (signal?: AbortSignal) => AsyncIterable<PluginRegistryEvent>;
  tools?:         ToolRegistry;
  // Resolved lazily (a thunk, not a captured value) because the skills plugin may register its
  // SkillManager *after* frontend-web sets up — load order isn't guaranteed. Returns undefined until
  // then; the watch loop is started on first /events connect, by which point boot is complete.
  skills?:        () => SkillManager | undefined;
  cors?:          string;  // Access-Control-Allow-Origin value, default '*'
  workdir?:       string;
  files?:         FileStore;
  configPath?:    string;
  /** Identity of the process answering this request. A workspace switch replaces the process, so the
   *  client cannot tell a completed switch from the outgoing process still serving unless the answer
   *  says who produced it — the registry file it would otherwise poll is written *before* the handoff,
   *  so the old process reports the new workspace while still serving the old one's sessions. */
  runtime?:       { id: string; workspace?: string };
  workspaceManager?: WorkspaceManager;
  workspaceRagManager?: () => WorkspaceRagManager | undefined;
  /** Resolved per call, like {@link skills} — the titler plugin may load in any order, or not at all. */
  sessionTitler?: () => SessionTitler | undefined;
  /** Derives the security principal for each request. Defaults to {@link defaultWebPrincipal}. */
  resolvePrincipal?: WebPrincipalResolver;
  /** Install-scoped display configuration. Never read from workspace-local state. */
  branding?: WebBranding;
}

export interface WorkspaceSummary {
  id:         string;
  name:       string;
  configPath: string;
  createdAt:  string;
  updatedAt:  string;
  active:     boolean;
}

/** Structural view of the session-titler plugin's service — kept local so frontend-web carries no
 *  dependency on an optional plugin (same treatment as {@link WorkspaceRagManager}). */
export interface SessionTitler {
  titleSession(input: { sessionId: string; provider: string; signal?: AbortSignal }): Promise<string | undefined>;
}

export interface WorkspaceManager {
  current(): Promise<WorkspaceSummary>;
  list(): Promise<{ active: string; workspaces: WorkspaceSummary[] }>;
  create(name: string): Promise<WorkspaceSummary>;
  rename(id: string, name: string): Promise<WorkspaceSummary>;
  delete(id: string): Promise<{ id: string; deleted: true }>;
  switch(id: string): Promise<{ active: string; restarting: boolean }>;
}

export interface WorkspaceRagLockStatus {
  locked: boolean;
  reason?: string;
  state?: string;
  message?: string;
}

export interface WorkspaceRagManager {
  workspaceLockStatus(workspaceId: string): WorkspaceRagLockStatus;
}

interface WorkspaceDeleteReadiness {
  canDelete: boolean;
  locked: boolean;
  reason?: string;
  state?: string;
  message?: string;
}

/**
 * Derives the security principal for an incoming HTTP request. The default ({@link defaultWebPrincipal})
 * returns one constant placeholder; a plugin can register its own under `services.WebPrincipalResolver` to
 * derive a real identity from the request — typically auth headers. It is resolved once at the
 * request entry and established ambiently via `runAs()` for the whole request, so every downstream
 * store/file/vault access (and the submitted turn) reads it via `currentPrincipal()`.
 */
export type WebPrincipalResolver = (req: IncomingMessage) => Principal | Promise<Principal>;

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** Registered by @matatbread/matbot-frontend-web: derive the per-request principal (default: a constant placeholder). */
    WebPrincipalResolver?: WebPrincipalResolver;
  }
}

interface SubmitBody {
  content:      string | { type: 'form-response'; values: Record<string, string> };
  provider:     string;       // opaque name passed to deps.resolveProvider
  sessionId?:   string;
  traceId?:     string;
  concatQueue?: boolean;      // true (default): merge into the running turn's batch; false: own turn
  attachments?: WorkspaceAttachment[];
}

interface WorkspaceAttachment {
  namespace: 'workspace';
  path:      string;
}

const MAX_WORKSPACE_ATTACHMENTS = 20;

interface DirectToolContextSpec {
  provider?:  string;
  sessionId?: string;
}

interface DirectToolInvocation {
  input:      unknown;
  session?:   Session;
  provider?:  string;
}

interface ExpertPanelSubmitBody {
  question:               string;
  provider:               string;
  experts?:               string[];
  mode?:                  'parallel' | 'review' | 'debate';
  synthesize?:            boolean;
  maxCitationsPerExpert?: number;
  traceId?:               string;
}

// How long a connection that is still mid-request may hold up `close()` before it is cut. Long enough
// for an in-flight response to finish, short enough that shutdown stays bounded.
const CLOSE_GRACE_MS = 1000;

// Last-resort anonymous identity, used only when no boot principal is established and no resolver
// override is registered (e.g. tests, or a realm with no carrier).
const ANONYMOUS_WEB_USER: Principal = {
  id:   'web-user',
  type: 'user',
};

// All matbot frontends are single-principal today, so the default request identity is the process
// boot principal (the pod/sandbox/system identity established at the entry) — keeping web sessions
// attributed to the same identity as the rest of the app. A multi-user deployment registers a
// `WebPrincipalResolver` (e.g. deriving identity from headers) which overrides this entirely; that
// override is deliberately NOT chained to the boot principal, so it never leaks the operator
// identity to anonymous visitors.
export const defaultWebPrincipal: WebPrincipalResolver = () => tryCurrentPrincipal() ?? ANONYMOUS_WEB_USER;

async function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) { reject(new Error('Request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type':   'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin':  origin,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function prepareWorkspaceAttachments(
  files: FileStore | undefined,
  rawAttachments: unknown,
): Promise<{ refs: MessageContent[]; ephemeral: MessageContent[] }> {
  if (rawAttachments === undefined) return { refs: [], ephemeral: [] };
  if (!Array.isArray(rawAttachments)) throw new Error('"attachments" must be an array.');
  if (rawAttachments.length > MAX_WORKSPACE_ATTACHMENTS) {
    throw new Error(`A message can attach at most ${MAX_WORKSPACE_ATTACHMENTS} workspace files.`);
  }
  if (rawAttachments.length > 0 && files === undefined) {
    throw new Error('Workspace file attachments are unavailable because no file store is configured.');
  }

  const refs: MessageContent[] = [];
  const paths = new Set<string>();
  for (const raw of rawAttachments) {
    if (!isRecord(raw) || raw.namespace !== 'workspace' || typeof raw.path !== 'string') {
      throw new Error('Each attachment must identify a workspace file with { namespace: "workspace", path }.');
    }
    const path = raw.path;
    if (!path.trim() || path.length > 1024) throw new Error('Attachment paths must contain 1 to 1024 characters.');
    if (paths.has(path)) continue;
    paths.add(path);

    const handle = await files!.getByName(path, 'workspace');
    if (!handle) throw new Error(`Workspace attachment not found: ${JSON.stringify(path)}.`);
    refs.push({ type: 'file-ref', fileId: handle.id, name: handle.name, mimeType: handle.mimeType });
  }

  if (refs.length === 0) return { refs, ephemeral: [] };
  const calls = refs.map(ref => {
    const name = (ref as Extract<MessageContent, { type: 'file-ref' }>).name;
    return `- ${JSON.stringify(name)}: workspace_action ${JSON.stringify({ action: 'read', path: name })}`;
  });
  return {
    refs,
    ephemeral: [{
      type: 'text',
      origin: 'robo',
      text: [
        '[Explicit Cortex Files attachments]',
        'The user explicitly attached the workspace files listed below to this message.',
        'Read them with workspace_action using each exact path. They are imported workspace files, not host filesystem paths.',
        'Prefer these attachments over same-named paths from Workspace RAG or other retrieved context. Do not use file_broker_action for these attachments.',
        ...calls,
        '[End explicit Cortex Files attachments]',
      ].join('\n'),
    }],
  };
}

// The single interactive prompt implementation is the SSE round-trip built per-submit (see the
// `/sessions/:id/submit` handler): it parks on `pendingPrompts` and is answered via
// `POST /sessions/:id/prompt`. The direct tool-invocation endpoints (`/tools/:name`,
// `/stream/tools/:name`) may opt into a real session/provider with the `$context` envelope, but still
// have no answer channel, so they CANNOT prompt interactively — a known, deliberate blind spot. Any
// UI flow that needs to ask the user something must drive the tool through `/submit` instead. This
// fallback makes that boundary explicit: take the default if one was offered, otherwise fail loudly
// rather than hang.
const nonInteractivePrompt: PromptFn = ((p: string | FormField, def?: string) => {
  const fallback = typeof p === 'string' ? def : p.default;
  return fallback !== undefined
    ? Promise.resolve(fallback)
    : Promise.reject(new Error(`Non-interactive context (use /submit for interactive prompts): "${typeof p === 'string' ? p : p.label}"`));
}) as PromptFn;

function normaliseExpertPanelSubmitBody(value: unknown): { ok: true; body: ExpertPanelSubmitBody } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'Request body must be an object.' };

  const question = typeof value.question === 'string' ? value.question.trim() : '';
  if (!question) return { ok: false, error: '"question" is required.' };

  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  if (!provider) return { ok: false, error: '"provider" is required.' };

  const mode = value.mode === 'review' || value.mode === 'debate' || value.mode === 'parallel'
    ? value.mode
    : 'parallel';

  let experts: string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'experts')) {
    if (!Array.isArray(value.experts)) return { ok: false, error: '"experts" must be an array of expert ids.' };
    experts = value.experts
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean);
  }

  const maxCitationsPerExpert = typeof value.maxCitationsPerExpert === 'number'
    ? value.maxCitationsPerExpert
    : undefined;

  return {
    ok: true,
    body: {
      question,
      provider,
      mode,
      ...(experts !== undefined ? { experts } : {}),
      ...(typeof value.synthesize === 'boolean' ? { synthesize: value.synthesize } : {}),
      ...(maxCitationsPerExpert !== undefined ? { maxCitationsPerExpert } : {}),
      ...(typeof value.traceId === 'string' && value.traceId.trim() ? { traceId: value.traceId.trim() } : {}),
    },
  };
}

function expertUserSummary(question: string, selected: readonly string[] | undefined, mode: string, synthesize: boolean): string {
  return [
    `Expert panel (${mode})`,
    `Experts: ${selected && selected.length ? selected.join(', ') : 'all'}`,
    `Synthesize decision: ${synthesize ? 'yes' : 'no'}`,
    '',
    question,
  ].join('\n');
}

function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function formatExpertPanelResult(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const lines = [
    '## Expert panel',
    `Mode: ${textValue(record.mode, 'parallel')}`,
  ];

  const opinions = Array.isArray(record.experts) ? record.experts : [];
  for (const rawOpinion of opinions) {
    const opinion = isRecord(rawOpinion) ? rawOpinion : {};
    lines.push('', `### ${textValue(opinion.title, textValue(opinion.expertId, 'Expert'))}`, textValue(opinion.answer, '(No answer returned.)'));
    const citations = Array.isArray(opinion.citations) ? opinion.citations : [];
    if (citations.length) {
      lines.push('', 'Citations:');
      for (const rawCitation of citations) {
        const citation = isRecord(rawCitation) ? rawCitation : {};
        const title = textValue(citation.title, textValue(citation.id, textValue(citation.path, 'source')));
        const path = typeof citation.path === 'string' && citation.path ? ` - ${citation.path}` : '';
        lines.push(`- ${title}${path}`);
      }
    }
  }

  if (typeof record.synthesis === 'string' && record.synthesis) {
    lines.push('', '### Synthesis', record.synthesis);
  }

  if (!opinions.length && !record.synthesis) {
    lines.push('', 'No expert response was returned.');
  }

  return lines.join('\n');
}

function expertPanelUsage(result: unknown): { inputTokens: number; outputTokens: number } | null {
  const record = isRecord(result) ? result : {};
  const opinions = Array.isArray(record.experts) ? record.experts : [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const rawOpinion of opinions) {
    const opinion = isRecord(rawOpinion) ? rawOpinion : {};
    const usage = isRecord(opinion.usage) ? opinion.usage : {};
    if (typeof usage.inputTokens === 'number') inputTokens += usage.inputTokens;
    if (typeof usage.outputTokens === 'number') outputTokens += usage.outputTokens;
  }

  return inputTokens || outputTokens ? { inputTokens, outputTokens } : null;
}

function titleFromQuestion(question: string): string | undefined {
  const words = question.trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  if (!words) return undefined;
  return words.length > 60 ? `${words.slice(0, 60)}...` : words;
}

export function createWebServer(deps: WebServerDeps) {
  const origin = deps.cors ?? '*';
  const resolvePrincipal = deps.resolvePrincipal ?? defaultWebPrincipal;
  const branding = deps.branding ?? DEFAULT_WEB_BRANDING;

  // Persistent per-session event subscribers (the GET /events/sessions/:id SSE streams). Submits are
  // fire-and-forget — all turn output, and interactive prompts, reach clients over these. Holding one
  // connection per session (not per submission) is what keeps queued submits off the browser's
  // ~6-socket-per-host limit, which otherwise starved both the `queued` signal and POST /prompt.
  const sessionConns = new Map<string, Set<ServerResponse>>();
  const busyState    = new Map<string, boolean>();                     // last-broadcast busy per session
  // Sessions with a live server-owned busy tracker (see the submit handler). One transient tracker
  // per busy period drives the idle broadcast independently of any client events stream.
  const busyTrackers = new Set<string>();
  // Expert-panel composer submissions persist their own messages outside the model runner. Keep them
  // single-writer per session so they do not interleave with another forced panel run.
  const expertPanelBusySessions = new Set<string>();
  // session ID → the parked prompt's settlers. `resolve` delivers an answer (applying the default
  // fallback); `cancel` rejects it with PromptCancelledError — the "give up" path.
  const pendingPrompts = new Map<string, { resolve: (answer: string) => void; cancel: () => void }>();

  // One multiplexed event stream (GET /events) carries every global, non-session event — session
  // busy/idle, file changes, and tool/skill/plugin CRUD — each tagged by name and demuxed client-side.
  // Browsers cap HTTP/1.1 at ~6 sockets per host; a separate SSE connection per panel would exhaust
  // that and starve ordinary fetches (the sidebar load, tool calls), so the whole UI shares one socket.
  const globalListeners = new Set<ServerResponse>();

  const broadcast = (msg: string): void => {
    for (const res of globalListeners) { if (res.writable) res.write(msg); else globalListeners.delete(res); }
  };

  // Per-file watchers (GET /events/files/:ns/:name), keyed `<namespace>/<name>` so single-file streams
  // don't collide across namespaces. Separate from the global stream: a targeted watch, not the firehose.
  const fileEventListeners = new Map<string, Set<ServerResponse>>();
  const watchAc            = new AbortController();

  const reportWatchFailure = (name: string, error: unknown): void => {
    if (!watchAc.signal.aborted) {
      console.warn(`[frontend-web] ${name} watch stopped:`, error instanceof Error ? error.message : String(error));
    }
  };

  if (deps.files?.watch) {
    void (async () => {
      for await (const event of deps.files!.watch!(watchAc.signal)) {
        const msg = sseEvent('file-changed', event);
        broadcast(msg);
        const subs = fileEventListeners.get(`${event.namespace ?? ''}/${event.name}`);
        if (subs) for (const res of subs) { if (res.writable) res.write(msg); else subs.delete(res); }
      }
    })().catch(error => reportWatchFailure('file', error));
  }

  if (deps.tools) {
    void (async () => {
      for await (const event of deps.tools!.watch(watchAc.signal)) broadcast(sseEvent('tool-changed', event));
    })().catch(error => reportWatchFailure('tool', error));
  }

  // Skill content CRUD (save/delete), including saves the LLM makes mid-turn via skill_action. The
  // SkillManager is resolved lazily on first /events connect (see deps.skills) because the skills plugin
  // may load after frontend-web; the watch loop starts at most once, the first time a client subscribes.
  let skillWatchStarted = false;

  function startSkillWatch(skills: SkillManager): void {
    if (skillWatchStarted) return;
    skillWatchStarted = true;
    void (async () => {
      for await (const event of skills.watch(watchAc.signal)) broadcast(sseEvent('skill-changed', event));
    })().catch(error => reportWatchFailure('skill', error));
  }

  // Plugin load/unload. Covers tool-less plugins (pure provider/hook/storage — e.g. the storage backend
  // itself) that the tool-changed stream can't see.
  if (deps.watchPlugins) {
    void (async () => {
      for await (const event of deps.watchPlugins!(watchAc.signal)) broadcast(sseEvent('plugin-changed', event));
    })().catch(error => reportWatchFailure('plugin', error));
  }

  function sendToSession(sessionId: string, msg: string): void {
    const conns = sessionConns.get(sessionId);
    if (conns === undefined) return;
    for (const res of conns) { if (res.writable) res.write(msg); else conns.delete(res); }
  }

  // Broadcast a session's busy/idle transition to the global status listeners (sidebar), deduped
  // against the last value. Authoritative busy comes from the runner (running || queued > 0).
  function updateBusy(sessionId: string): void {
    const busy = deps.run.status(sessionId).busy;
    if ((busyState.get(sessionId) ?? false) === busy) return;
    if (busy) busyState.set(sessionId, true); else busyState.delete(sessionId);
    broadcast(sseEvent('session-busy', { sessionId, busy }));
  }

  async function workspaceDeleteReadiness(workspaceId: string): Promise<WorkspaceDeleteReadiness> {
    if (!deps.workspaceManager) return { canDelete: false, locked: false, reason: 'Workspace manager unavailable.' };
    const state = await deps.workspaceManager.list();
    const workspace = state.workspaces.find(item => item.id === workspaceId);
    if (!workspace) return { canDelete: false, locked: false, reason: `Unknown workspace "${workspaceId}".` };
    if (workspace.active || state.active === workspaceId) {
      return { canDelete: false, locked: false, reason: 'Cannot delete the active workspace. Switch to another workspace first.' };
    }

    const lock = deps.workspaceRagManager?.()?.workspaceLockStatus(workspaceId);
    if (lock?.locked) {
      return {
        canDelete: false,
        locked: true,
        reason: lock.reason ?? 'Workspace indexing is currently running or pending.',
        ...(lock.state !== undefined ? { state: lock.state } : {}),
        ...(lock.message !== undefined ? { message: lock.message } : {}),
      };
    }

    return {
      canDelete: true,
      locked: false,
      ...(lock?.state !== undefined ? { state: lock.state } : {}),
      ...(lock?.message !== undefined ? { message: lock.message } : {}),
    };
  }

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url    = req.url ?? '/';

    // Set CORS headers on every response
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      res.setHeader(k, v);
    }

    if (method === 'OPTIONS') { res.writeHead(204).end(); return; }

    try {
      // Establish the request's security principal at the entry, so every store/file/vault access
      // made while handling it (not just the submitted turn, which pump scopes separately) can read
      // it via currentPrincipal(). The resolver derives it from the request (default: one constant
      // placeholder); a plugin can register `services.WebPrincipalResolver` to read real identity off headers.
      const principal = await resolvePrincipal(req);
      await runAs(principal, () => handleRequest(req, res, method, url, principal));
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String(e) });
      else if (res.writable)  res.end();
    }
  });

  function makeToolCtx(ac: AbortController, principal: Principal, invocation?: Pick<DirectToolInvocation, 'session' | 'provider'>) {
    const now = new Date().toISOString();
    const stubSession: Session = {
      id: crypto.randomUUID(), version: crypto.randomUUID(),
      ownerPrincipalId: principal.id,
      status: 'active', contexts: [], messages: [],
      createdAt: now, updatedAt: now,
    };
    return {
      callId:     crypto.randomUUID(),
      session:    invocation?.session ?? stubSession,
      signal:     ac.signal,
      vault:      deps.vault,
      loadPlugin:   deps.loadPlugin,
      unloadPlugin: deps.unloadPlugin,
      prompt:       nonInteractivePrompt,
      ...(invocation?.provider !== undefined ? { provider: invocation.provider } : {}),
      ...(deps.workdir    !== undefined ? { workdir:    deps.workdir    } : {}),
      ...(deps.files      !== undefined ? { files:      deps.files      } : {}),
      ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
    };
  }

  async function resolveDirectToolInvocation(rawInput: unknown): Promise<
    | { ok: true; invocation: DirectToolInvocation }
    | { ok: false; status: number; error: string }
  > {
    if (!isRecord(rawInput) || !Object.prototype.hasOwnProperty.call(rawInput, '$context')) {
      return { ok: true, invocation: { input: rawInput } };
    }

    const contextRaw = rawInput['$context'];
    if (contextRaw !== undefined && !isRecord(contextRaw)) {
      return { ok: false, status: 400, error: '"$context" must be an object when provided.' };
    }

    const context = (contextRaw ?? {}) as Record<string, unknown>;
    const toolInput = Object.prototype.hasOwnProperty.call(rawInput, 'input') ? rawInput['input'] : {};
    const invocation: DirectToolInvocation = { input: toolInput };

    if (Object.prototype.hasOwnProperty.call(context, 'provider')) {
      if (typeof context.provider !== 'string' || context.provider.trim() === '') {
        return { ok: false, status: 400, error: '"$context.provider" must be a non-empty provider name.' };
      }
      invocation.provider = context.provider.trim();
    }

    if (Object.prototype.hasOwnProperty.call(context, 'sessionId')) {
      if (typeof context.sessionId !== 'string' || context.sessionId.trim() === '') {
        return { ok: false, status: 400, error: '"$context.sessionId" must be a non-empty session id.' };
      }
      const session = await deps.store.get(context.sessionId.trim());
      if (!session) {
        return { ok: false, status: 404, error: `Session "${context.sessionId.trim()}" not found.` };
      }
      invocation.session = session;
    }

    return { ok: true, invocation };
  }

  async function appendSessionMessages(
    sessionId: string,
    messages: readonly Message[],
    shapeSession?: (session: Session) => Session,
  ): Promise<Session | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await deps.store.get(sessionId);
      if (!current) return null;
      const shaped = shapeSession ? shapeSession(current) : current;
      const next = messages.reduce((session, message) => appendMessage(session, message), shaped);
      const saved = await deps.store.cas(sessionId, current.version, next);
      if (saved.ok) return saved.doc;
    }

    const current = await deps.store.get(sessionId);
    if (!current) return null;
    const shaped = shapeSession ? shapeSession(current) : current;
    const next = messages.reduce((session, message) => appendMessage(session, message), shaped);
    await deps.store.set(sessionId, next);
    return next;
  }

  function static200(res: ServerResponse, contentType: string, path: string) {
    return async () => {
      const body = await readFile(new URL(path, import.meta.url), "utf-8");
      res.writeHead(200, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
  }
  async function handleRequest(
    req: IncomingMessage, res: ServerResponse, method: string, url: string, principal: Principal,
  ): Promise<void> {

    if (method === 'GET' && url === '/branding') {
      json(res, 200, branding);
      return;
    }

    // --- Static UI ---
    const staticRoutes: Record<string, () => Promise<void>> = {
      '/': static200(res, 'text/html; charset=utf-8', "../static/index.html"),
      '/indx.html': static200(res, 'text/html; charset=utf-8', "../static/index.html"),
      '/app.js': static200(res, 'application/javascript; charset=utf-8', "../static/app.js"),
      '/http-transport.js': static200(res, 'application/javascript; charset=utf-8', "../static/http-transport.js"),
      '/favicon.ico': static200(res, 'image/svg+xml', "../static/favicon.svg"),
      // Hack - this exposes the web-bundle for testing purposes. In production, the web-bundle is served from the CDN.
      '/matbot.html': static200(res, 'text/html; charset=utf-8', "../../../../../apps/web-bundle/dist/matbot.html"),
    };
    if (method === 'GET' && url in staticRoutes) {
      staticRoutes[url]?.();
      return;
    }
    // if (method === 'GET' && url === '/')       { static200(res, 'text/html; charset=utf-8',              await html()); return; }
    // if (method === 'GET' && url === '/app.js') { static200(res, 'application/javascript; charset=utf-8', await js());   return; }
    // if (method === 'GET' && url === '/http-transport.js') { static200(res, 'application/javascript; charset=utf-8', await httpTransport()); return; }
    // if (method === 'GET' && url === '/favicon.ico') { static200(res, 'image/svg+xml', await favicon()); return; }

    // --- GET /health ---
    if (method === 'GET' && url === '/health') {
      json(res, 200, { status: 'ok' }); return;
    }

    if (method === 'GET' && url === '/workspaces') {
      if (!deps.workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      json(res, 200, { ...await deps.workspaceManager.list(), ...(deps.runtime !== undefined ? { runtime: deps.runtime } : {}) }); return;
    }

    const workspaceDeleteCheck = /^\/workspaces\/([^/]+)\/delete-check$/.exec(url);
    if (method === 'GET' && workspaceDeleteCheck) {
      if (!deps.workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      const readiness = await workspaceDeleteReadiness(decodeURIComponent(workspaceDeleteCheck[1]!));
      json(res, readiness.canDelete ? 200 : (readiness.locked ? 409 : 400), readiness);
      return;
    }

    if (method === 'POST' && url === '/workspaces') {
      if (!deps.workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      let body: { name?: unknown };
      try { body = JSON.parse(await readBody(req)) as { name?: unknown }; }
      catch (e) { json(res, 400, { error: String(e) }); return; }
      if (typeof body.name !== 'string') { json(res, 400, { error: 'Workspace name is required' }); return; }
      json(res, 201, await deps.workspaceManager.create(body.name)); return;
    }

    const workspaceRename = /^\/workspaces\/([^/]+)\/rename$/.exec(url);
    if (method === 'POST' && workspaceRename) {
      if (!deps.workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      let body: { name?: unknown };
      try { body = JSON.parse(await readBody(req)) as { name?: unknown }; }
      catch (e) { json(res, 400, { error: String(e) }); return; }
      if (typeof body.name !== 'string') { json(res, 400, { error: 'Workspace name is required' }); return; }
      json(res, 200, await deps.workspaceManager.rename(decodeURIComponent(workspaceRename[1]!), body.name)); return;
    }

    const workspaceSwitch = /^\/workspaces\/([^/]+)\/switch$/.exec(url);
    if (method === 'POST' && workspaceSwitch) {
      if (!deps.workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      json(res, 200, await deps.workspaceManager.switch(decodeURIComponent(workspaceSwitch[1]!))); return;
    }

    const workspaceDelete = /^\/workspaces\/([^/]+)$/.exec(url);
    if (method === 'DELETE' && workspaceDelete) {
      if (!deps.workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      try {
        const workspaceId = decodeURIComponent(workspaceDelete[1]!);
        const readiness = await workspaceDeleteReadiness(workspaceId);
        if (!readiness.canDelete) {
          json(res, readiness.locked ? 409 : 400, readiness);
          return;
        }
        json(res, 200, await deps.workspaceManager.delete(workspaceId));
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // --- GET /events --- (one multiplexed SSE stream: session busy/idle, file changes, and tool/skill/
    // plugin CRUD, demuxed client-side by event name. One socket for the whole UI — see globalListeners.)
    if (method === 'GET' && url === '/events') {
      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('event stream open'));
      // Send current busy state so the client is up-to-date immediately. Reconcile against the
      // authoritative runner status first: a stale true (busyState that never got its idle
      // transition — e.g. a turn that ended with no events consumer attached) self-heals here,
      // broadcasting false to existing listeners instead of replaying a phantom busy.
      for (const sessionId of [...busyState.keys()]) {
        if (!deps.run.status(sessionId).busy) { updateBusy(sessionId); continue; }
        res.write(sseEvent('session-busy', { sessionId, busy: true }));
      }
      // Wire skill CRUD lazily: by first connect the skills plugin has finished setup (load order may
      // place it after frontend-web), so deps.skills() now resolves.
      const skills = deps.skills?.();
      if (skills) startSkillWatch(skills);
      globalListeners.add(res);
      req.on('close', () => { globalListeners.delete(res); });
      return; // keep connection open
    }

    // --- GET /sessions/:id --- (status only — busy is server-internal state, not session data)
    const sessionStatusMatch = /^\/sessions\/([^/]+)$/.exec(url);
    if (method === 'GET' && sessionStatusMatch) {
      json(res, 200, { busy: deps.run.status(sessionStatusMatch[1]!).busy }); return;
    }

    // --- POST /sessions ---
    if (method === 'POST' && url === '/sessions') {
      const session = createSession({ ownerPrincipal: principal });
      await deps.store.set(session.id, session);
      json(res, 201, { id: session.id });
      return;
    }

    // --- POST /sessions/:id/submit ---
    const submitMatch = /^\/sessions\/([^/]+)\/submit$/.exec(url);
    if (method === 'POST' && submitMatch) {
      const sessionId = submitMatch[1]!;

      let raw: string;
      try { raw = await readBody(req); }
      catch (e) { json(res, 400, { error: String(e) }); return; }

      let body: SubmitBody;
      try { body = JSON.parse(raw) as SubmitBody; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      const targetId  = body.sessionId ?? sessionId;
      const session   = await deps.store.get(targetId);
      if (!session) { json(res, 404, { error: 'Session not found' }); return; }
      if (expertPanelBusySessions.has(targetId)) {
        json(res, 409, { error: 'Session is busy running an expert panel.' }); return;
      }

      const traceId = body.traceId ?? crypto.randomUUID();

      // Normalise content into MessageContent[]. The runner appends + persists the user message
      // when this submission's turn actually starts (persist-at-turn-start) — never here — so a
      // mid-turn submit queues behind the running turn instead of clobbering session state.
      let preparedAttachments: Awaited<ReturnType<typeof prepareWorkspaceAttachments>>;
      try {
        preparedAttachments = await prepareWorkspaceAttachments(deps.files, body.attachments);
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }

      const contentArr: MessageContent[] = typeof body.content === 'string'
        ? [{ type: 'text' as const, text: body.content }]
        : [body.content];
      contentArr.push(...preparedAttachments.refs);

      // Fire-and-forget: we enqueue and return immediately. The turn's output — and this prompt —
      // reach the client over its persistent GET /events/sessions/:id stream, not this request.
      // Answered via POST /sessions/:id/prompt. (Only one prompt is outstanding per session, since
      // turns are serialised.)
      const promptFn = ((p: string | FormField, defaultValue?: string): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          const def = typeof p === 'string' ? defaultValue : p.default;
          pendingPrompts.set(targetId, {
            resolve: answer => { pendingPrompts.delete(targetId); resolve(answer || def || ''); },
            cancel:  ()     => { pendingPrompts.delete(targetId); reject(new PromptCancelledError()); },
          });
          sendToSession(targetId, sseEvent('prompt', {
            type: 'prompt',
            traceId,
            question: typeof p === 'string' ? p : p.label,
            ...(def !== undefined ? { defaultValue: def } : {}),
            ...(typeof p === 'string' ? {} : { field: p }),
          }));
        })) as PromptFn;

      // The first submit of a busy period anchors the server-owned busy tracker on its OWN view
      // (claimed synchronously here, before any await, so two near-simultaneous submits can't both
      // become trackers). Concat/queued submits arriving mid-turn reuse it and don't tap their events.
      const isTracker = !busyTrackers.has(targetId);
      if (isTracker) busyTrackers.add(targetId);
      const trackAc = new AbortController();
      try {
        const view = await deps.run.open({
          sessionId:   targetId,
          signal:      isTracker ? trackAc.signal : new AbortController().signal,
          content:     contentArr,
          ...(preparedAttachments.ephemeral.length > 0 ? { ephemeral: preparedAttachments.ephemeral } : {}),
          provider:    body.provider,
          principal,
          prompt:      promptFn,
          traceId,
          concatQueue: body.concatQueue ?? false, // per-submission; conservative default (own turn) when unspecified
        });
        updateBusy(targetId);
        json(res, 200, { queued: view.queued, traceId: view.traceId });

        // Server-owned busy tracker. The busy:false broadcast requires *someone* draining this
        // session's stream when the turn ends — but a client's GET /events/sessions/:id consumer may
        // not be attached (user switched away). So whoever turns busy ON owns turning it OFF: drain
        // this submission's own view until the runner's deterministic `idle` event, driving updateBusy.
        // The view was subscribed (the `events` getter) before pump can run, so it can't miss even a
        // fast/erroring turn; one tracker per busy period, so cost is bounded by concurrent running
        // turns, nothing on idle sessions.
        if (isTracker) {
          void (async () => {
            try {
              for await (const ev of view.events) {
                updateBusy(targetId);
                // Tear down only on a *genuine* idle. `idle` fires after `running` flips false, so
                // status() is authoritative here: if a back-to-back submit has already re-armed the
                // session (running again, or freshly queued), keep tracking — this same view stays
                // subscribed across pump restarts and will see the next idle.
                if (ev.type === 'idle' && !deps.run.status(targetId).busy) break;
              }
            } catch { /* stream torn down */ }
            finally { busyTrackers.delete(targetId); trackAc.abort(); }
          })();
        }
      } catch (e) {
        if (isTracker) busyTrackers.delete(targetId);
        json(res, 500, { error: String(e) });
      }
      return;
    }

    // --- POST /sessions/:id/expert-panel ---
    // Deterministic composer-triggered expert-panel turn. This intentionally does not ask the model
    // to decide whether to call a tool; it persists the user prompt and formatted expert answer as
    // ordinary session messages while running the existing expert_panel tool with real context.
    const expertPanelSubmitMatch = /^\/sessions\/([^/]+)\/expert-panel$/.exec(url);
    if (method === 'POST' && expertPanelSubmitMatch) {
      const sessionId = expertPanelSubmitMatch[1]!;

      let raw: string;
      try { raw = await readBody(req); }
      catch (e) { json(res, 400, { error: String(e) }); return; }

      let parsed: unknown;
      try { parsed = raw ? JSON.parse(raw) : {}; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      const normalised = normaliseExpertPanelSubmitBody(parsed);
      if (!normalised.ok) { json(res, 400, { error: normalised.error }); return; }

      const body = normalised.body;
      const session = await deps.store.get(sessionId);
      if (!session) { json(res, 404, { error: 'Session not found' }); return; }
      if (deps.run.status(sessionId).busy || expertPanelBusySessions.has(sessionId)) {
        json(res, 409, { error: 'Session is busy.' }); return;
      }

      const tool = deps.tools?.resolve('expert_panel');
      if (!tool) { json(res, 404, { error: 'Tool "expert_panel" not found' }); return; }

      const traceId = body.traceId ?? crypto.randomUUID();
      const synthesize = body.synthesize !== false;
      const selectedExperts = body.experts?.length ? body.experts : undefined;
      const input = {
        action: 'ask',
        question: body.question,
        mode: body.mode ?? 'parallel',
        synthesize,
        maxCitationsPerExpert: body.maxCitationsPerExpert ?? 5,
        ...(selectedExperts !== undefined ? { experts: selectedExperts } : {}),
      };
      const userContent: MessageContent[] = [{
        type: 'text',
        text: expertUserSummary(body.question, selectedExperts, input.mode, synthesize),
      }];
      const userMessage = createMessage({
        role: 'user',
        content: userContent,
        traceId,
        providerName: body.provider,
        metadata: { expertPanel: { mode: input.mode, synthesize, experts: selectedExperts ?? 'all' } },
      });

      expertPanelBusySessions.add(sessionId);
      const ac = new AbortController();
      req.on('aborted', () => ac.abort());

      try {
        let committed = await appendSessionMessages(sessionId, [userMessage], current => {
          if (current.title || current.messages.some(message => message.role === 'user')) return current;
          const title = titleFromQuestion(body.question);
          return title ? { ...current, title } : current;
        });
        if (!committed) { json(res, 404, { error: 'Session not found' }); return; }

        sendToSession(sessionId, sseEvent('queued', {
          type: 'queued',
          content: userContent,
          queued: 0,
          concatQueue: false,
          traceId,
          rootTraceId: traceId,
        }));

        let result: unknown;
        let errorMessage: string | undefined;
        const markers: MessageContent[] = [];
        let stdout = '';
        let stderr = '';

        try {
          for await (const ev of tool.executor.execute(input, makeToolCtx(ac, principal, { session: committed, provider: body.provider }))) {
            if (ev.type === 'result') result = ev.value;
            else if (ev.type === 'stdout') stdout += ev.chunk;
            else if (ev.type === 'stderr') stderr += ev.chunk;
            else if (ev.type === 'marker') markers.push({ type: 'marker', creator: ev.creator, data: ev.data });
            else if (ev.type === 'error') errorMessage = ev.message;
          }
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : String(e);
        }

        const assistantText = errorMessage
          ? `Expert panel failed: ${errorMessage}`
          : formatExpertPanelResult(result);
        const assistantMessage = createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: assistantText }],
          traceId,
          providerName: body.provider,
          metadata: { expertPanel: { result, ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) } },
        });

        const messagesToAppend: Message[] = [];
        if (markers.length > 0) {
          messagesToAppend.push(createMessage({ role: 'marker', content: markers, traceId }));
        }
        messagesToAppend.push(assistantMessage);

        committed = await appendSessionMessages(sessionId, messagesToAppend);
        if (!committed) { json(res, 404, { error: 'Session not found' }); return; }

        if (markers.length > 0) {
          sendToSession(sessionId, sseEvent('marker', { type: 'marker', content: markers, traceId }));
        }
        sendToSession(sessionId, sseEvent('text-delta', { type: 'text-delta', delta: assistantText, traceId }));
        const usage = expertPanelUsage(result);
        if (usage) sendToSession(sessionId, sseEvent('usage', { type: 'usage', ...usage, traceId }));
        sendToSession(sessionId, sseEvent('done', { type: 'done', session: committed, traceId }));

        // This path commits messages itself instead of going through the pump, so no `followup` hook
        // runs and nothing would name the session beyond the truncation above. Fire-and-forget, after
        // `done`, deliberately without `ac.signal` (the finally below aborts it): the client picks the
        // new title up on its post-`done` refresh, so the response is not held up for a second call.
        void deps.sessionTitler?.()?.titleSession({ sessionId, provider: body.provider }).catch(() => {});

        json(res, 200, {
          traceId,
          session: committed,
          ...(result !== undefined ? { result } : {}),
          ...(errorMessage !== undefined ? { isError: true, error: errorMessage } : { isError: false }),
        });
      } finally {
        expertPanelBusySessions.delete(sessionId);
        ac.abort();
      }
      return;
    }

    // --- GET /events/sessions/:id --- (persistent per-session SSE: ALL turn output for the session)
    const eventsMatch = /^\/events\/sessions\/([^/]+)$/.exec(url);
    if (method === 'GET' && eventsMatch) {
      const sId = eventsMatch[1]!;
      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('events stream open'));

      let conns = sessionConns.get(sId);
      if (conns === undefined) { conns = new Set(); sessionConns.set(sId, conns); }
      conns.add(res);

      const ac = new AbortController();
      req.on('close', () => {
        ac.abort();
        const set = sessionConns.get(sId);
        if (set) {
          set.delete(res);
          if (set.size === 0) {
            sessionConns.delete(sId);
            // No viewers left: release any pending prompt so a turn parked on ctx.prompt() doesn't
            // hang awaiting an answer that can never arrive.
            const r = pendingPrompts.get(sId);
            if (r) { pendingPrompts.delete(sId); r.resolve(''); }
          }
        }
      });

      const view = await deps.run.open({ sessionId: sId, signal: ac.signal });
      void (async () => {
        try {
          for await (const ev of view.events) {
            if (!res.writable) break;
            // `idle` is the runner's busy→idle lifecycle signal (session-runner pump): it arrives
            // *after* `running` flips false, so updateBusy reads an authoritative idle with no
            // microtask race. It's status bookkeeping, not turn content — don't forward it to the
            // client (app.js has no case for it).
            if (ev.type === 'idle') { updateBusy(sId); continue; }
            res.write(sseEvent(ev.type, ev));
            updateBusy(sId);
          }
        } catch { /* stream torn down */ }
      })();
      return;
    }

    // --- POST /sessions/:id/abort ---
    const abortMatch = /^\/sessions\/([^/]+)\/abort$/.exec(url);
    if (method === 'POST' && abortMatch) {
      const sId    = abortMatch[1]!;
      // Release any pending prompt first so a turn parked on ctx.prompt() can observe the abort
      // rather than hang, then drop the queue + abort the running turn.
      const r = pendingPrompts.get(sId);
      if (r) { pendingPrompts.delete(sId); r.resolve(''); }
      deps.run.abort(sId);
      updateBusy(sId);
      json(res, 200, { ok: true });
      return;
    }

    // --- POST /tools/:name (buffered JSON response) ---
    const toolCallMatch = /^\/tools\/([^/]+)$/.exec(url);
    if (method === 'POST' && toolCallMatch) {
      const toolName = toolCallMatch[1]!;

      let raw: string;
      try { raw = await readBody(req); }
      catch (e) { json(res, 400, { error: String(e) }); return; }

      let input: unknown;
      try { input = raw ? JSON.parse(raw) : null; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      const tool = deps.tools?.resolve(toolName);
      if (!tool) { json(res, 404, { error: `Tool "${toolName}" not found` }); return; }

      const ac = new AbortController();
      req.on('close', () => ac.abort());

      const invocation = await resolveDirectToolInvocation(input);
      if (!invocation.ok) { json(res, invocation.status, { error: invocation.error }); return; }

      const toolCtx = makeToolCtx(ac, principal, invocation.invocation);
      let stdout = '';
      let stderr = '';
      const markers: Array<{ creator: string; data: unknown }> = [];
      let sawNonResultEvent = false;
      try {
        for await (const ev of tool.executor.execute(invocation.invocation.input, toolCtx)) {
          if (ev.type === 'result') { json(res, 200, ev.value); return; }
          sawNonResultEvent = true;
          if (ev.type === 'stdout') { stdout += ev.chunk; }
          if (ev.type === 'stderr') { stderr += ev.chunk; }
          if (ev.type === 'marker') { markers.push({ creator: ev.creator, data: ev.data }); }
          if (ev.type === 'error')  {
            json(res, 500, {
              error: ev.message,
              ...(ev.code !== undefined ? { code: ev.code } : {}),
              ...(stdout               ? { stdout }         : {}),
              ...(stderr               ? { stderr }         : {}),
            });
            return;
          }
        }
        if (sawNonResultEvent) {
          json(res, 200, {
            ok: true,
            ...(markers.length > 0 ? { markers } : {}),
            ...(stdout ? { stdout } : {}),
            ...(stderr ? { stderr } : {}),
          });
          return;
        }
        json(res, 500, { error: 'Tool returned no result' });
      } catch (e) {
        json(res, 500, { error: String(e), ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) });
      }
      return;
    }

    // --- POST /stream/tools/:name (SSE streaming) ---
    const streamToolMatch = /^\/stream\/tools\/([^/]+)$/.exec(url);
    if (method === 'POST' && streamToolMatch) {
      const toolName = streamToolMatch[1]!;

      let raw: string;
      try { raw = await readBody(req); }
      catch (e) { json(res, 400, { error: String(e) }); return; }

      let input: unknown;
      try { input = raw ? JSON.parse(raw) : null; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }

      const tool = deps.tools?.resolve(toolName);
      if (!tool) { json(res, 404, { error: `Tool "${toolName}" not found` }); return; }

      const ac = new AbortController();
      req.on('close', () => ac.abort());

      const invocation = await resolveDirectToolInvocation(input);
      if (!invocation.ok) { json(res, invocation.status, { error: invocation.error }); return; }

      res.writeHead(200, {
        'content-type':  'text/event-stream',
        'cache-control': 'no-cache',
        'connection':    'keep-alive',
      });
      res.write(sseComment('tool stream open'));

      try {
        for await (const ev of tool.executor.execute(invocation.invocation.input, makeToolCtx(ac, principal, invocation.invocation))) {
          if (!res.writable) break;
          res.write(sseEvent(ev.type, ev));
        }
      } catch (e) {
        if (res.writable) res.write(sseEvent('error', { type: 'error', message: String(e) }));
      } finally {
        res.end();
      }
      return;
    }

    // --- POST /sessions/:id/prompt ---
    const promptMatch = /^\/sessions\/([^/]+)\/prompt$/.exec(url);
    if (method === 'POST' && promptMatch) {
      const sId = promptMatch[1]!;
      let body: { answer?: string; cancel?: boolean };
      try { body = JSON.parse(await readBody(req)) as { answer?: string; cancel?: boolean }; }
      catch { json(res, 400, { error: 'Invalid JSON' }); return; }
      const entry = pendingPrompts.get(sId);
      if (!entry) { json(res, 409, { error: 'No pending prompt for this session' }); return; }
      if (body.cancel) {
        // Give up: reject the prompt (the tool closes its call with an error result) and abandon the
        // turn without disturbing the queue — pump advances to the next submission or idles.
        entry.cancel();
        deps.run.cancelTurn(sId);
      } else {
        entry.resolve(body.answer ?? '');
      }
      json(res, 200, { ok: true });
      return;
    }

    // --- GET /events/files/<namespace>/<name> --- (SSE: single-file watch)
    const fileEventMatch = /^\/events\/files\/([^/]+)\/(.+)$/.exec(url);
    if (method === 'GET' && fileEventMatch) {
      if (!deps.files?.watch) { json(res, 404, { error: 'File watch not available' }); return; }
      let key: string;
      try { key = `${decodeURIComponent(fileEventMatch[1]!)}/${decodeURIComponent(fileEventMatch[2]!)}`; }
      catch { json(res, 400, { error: 'Invalid path encoding' }); return; }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
      res.write(sseComment(`watching ${key}`));

      let subs = fileEventListeners.get(key);
      if (subs === undefined) { subs = new Set(); fileEventListeners.set(key, subs); }
      subs.add(res);
      req.on('close', () => {
        const s = fileEventListeners.get(key);
        if (s) { s.delete(res); if (s.size === 0) fileEventListeners.delete(key); }
      });
      return;
    }

    // --- GET /files/<namespace>/<name> --- (read-only static access; only files marked `allowed`)
    const fileMatch = /^\/files\/([^/]+)\/(.+)$/.exec(url);
    if (method === 'GET' && fileMatch && deps.files) {
      let namespace: string, name: string;
      try { namespace = decodeURIComponent(fileMatch[1]!); name = decodeURIComponent(fileMatch[2]!); }
      catch { json(res, 400, { error: 'Invalid path encoding' }); return; }

      // One read serves and gates: the handle we need to stream also carries `allowed`. A file that
      // isn't servable is reported as missing, not forbidden — don't reveal that the path exists.
      const handle = await deps.files.getByName(name, namespace);
      if (!handle) { json(res, 404, { error: 'Not found' }); return; }
      if (!handle.allowed) { json(res, 403, { error: 'Not allowed' }); return; }

      res.writeHead(200, {
        'content-type':  handle.mimeType,
        'cache-control': 'no-cache',
        ...corsHeaders(origin),
      });
      for await (const chunk of handle.stream()) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    json(res, 404, { error: 'Not found' });
  }

  async function close(): Promise<void> {
    // Close all persistent per-session event streams.
    for (const conns of sessionConns.values()) for (const res of conns) res.end();
    sessionConns.clear();
    busyState.clear();

    // Close the multiplexed global event stream(s).
    for (const res of globalListeners) res.end();
    globalListeners.clear();

    // Stop the watch loops and close the per-file watch SSE connections.
    watchAc.abort();
    for (const subs of fileEventListeners.values()) for (const res of subs) res.end();
    fileEventListeners.clear();

    // Resolve all pending prompts so callers don't hang.
    for (const entry of pendingPrompts.values()) entry.resolve('');
    pendingPrompts.clear();

    // `server.close()` stops accepting and then waits for every open connection. Node ≥19 drops IDLE
    // keep-alive sockets itself, but a connection that is mid-request holds the close open with no
    // deadline — a half-sent body, a slow client, a stream this file does not track. A workspace switch
    // gates the process's exit on this close, so an unbounded wait here means the outgoing process
    // keeps the port and its replacement can never bind. Idle sockets go now, the rest get a grace
    // period and are then cut.
    server.closeIdleConnections();
    const graceTimer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);

    await new Promise<void>((resolve) =>
      server.close(err => {
        if (err) {
          console.warn('[frontend-web] Error closing server:', String(err));
        }
        resolve();
      }),
    );
    clearTimeout(graceTimer);
  }

  return { server, close };
}
