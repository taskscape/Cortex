import type {ContributionRegistry} from '@matatbread/matbot-plugin-api';
import type {} from '@matatbread/matbot-capabilities-types';
import {ExpertSessionService,ExpertSessionError} from '@matatbread/matbot-expert-panel-session';
import {prepareWorkspaceAttachments} from '@matatbread/matbot-tool-workspace/attachments';
import type { WorkspaceManager, WorkspaceSummary } from '@matatbread/matbot-workspace-manager-types';
export type { WorkspaceManager, WorkspaceSummary } from '@matatbread/matbot-workspace-manager-types';
import { invokeToolEvents } from '@matatbread/matbot-core';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type {
  MatbotPlugin, Principal, Session, Store, ToolRegistry, FileStore, Vault, Message, MessageContent,
  FormField, PromptFn, SessionRunner, PluginRegistryEvent,
} from '@matatbread/matbot-core';
import { appendMessage, createMessage, createSession, PromptCancelledError, runAs, tryCurrentPrincipal } from '@matatbread/matbot-core';
import type { SkillManager } from '@matatbread/matbot-skills';
import { sseComment, sseEvent } from './sse-writer.js';
import { promises } from "node:fs";
const { readFile } = promises;

/** Install-scoped UI branding overrides served to the web client. */
export interface WebBranding {
  /** Product name shown in the UI. */
  productName: string;
  /** Browser tab title. */
  title: string;
  /** Base brand color (CSS color). */
  brand?: string;
  /** Strong accent color (CSS color). */
  brandStrong?: string;
  /** Soft accent color (CSS color). */
  brandSoft?: string;
}

const DEFAULT_WEB_BRANDING: WebBranding = { productName: 'Cortex', title: 'Cortex' };
const CSS_COLOR = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^<>]{1,80}\))$/;

/**
 * Parses install-scoped UI branding values. Invalid input falls back per field.
 *
 * Reads the `CORTEX_WEBUI_BRANDING_JSON` environment variable by default. Only presentation-safe
 * values are accepted: names and titles must be non-empty strings of at most 80 characters, and
 * colors must match a CSS hex/rgb(a)/hsl(a) pattern (rejecting anything that could carry markup).
 * Invalid JSON, a non-object value, or an invalid field degrades per field — the title defaults to
 * the product name when not given.
 *
 * @param raw - Raw JSON text; defaults to the environment variable. `undefined`/empty yields the
 *                defaults.
 * @returns The branding, with defaults filled in and optional colors omitted when invalid.
 * @throws Never - All parse failures fall back to defaults.
 */
export function parseWebBranding(raw = process.env['CORTEX_WEBUI_BRANDING_JSON']): WebBranding {
  if (!raw) return { ...DEFAULT_WEB_BRANDING };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return { ...DEFAULT_WEB_BRANDING };
    /**
     * Validates one branding string field.
     *
     * @param key - Field to read.
     * @param fallback - Value used when the field is missing, empty, or longer than 80 characters.
     * @returns The trimmed value, or `fallback`.
     * @throws Never.
     */
    const text = (key: 'productName' | 'title', fallback: string) => {
      const candidate = value[key];
      return typeof candidate === 'string' && candidate.trim() && candidate.trim().length <= 80 ? candidate.trim() : fallback;
    };
    /**
     * Validates one branding color field against the safe CSS color pattern.
     *
     * @param key - Field to read.
     * @returns The trimmed value, or `undefined` when missing or not a safe CSS color.
     * @throws Never.
     */
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

/** Dependencies injected into the HTTP+SSE chat server. */
export interface WebServerDeps {
  listProviders?: () => {name:string}[];
  contributions?:ContributionRegistry;
  attachments?: () => import('@matatbread/matbot-tool-workspace/attachments').AttachmentResolver | undefined;
  expertSessions?: () => ExpertSessionService | undefined;
  invokeTool?: (tool: import('@matatbread/matbot-plugin-api').Tool, input: unknown, ctx: import('@matatbread/matbot-plugin-api').ToolContext) => AsyncIterable<import('@matatbread/matbot-plugin-api').ToolEvent>;

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
  // Access-Control-Allow-Origin override. Default (unset): reflect the request Origin only when it
  // is a loopback origin (http(s)://127.0.0.1|localhost|[::1]:<port>); foreign origins get no ACAO
  // header. Mutating requests from disallowed origins are rejected before routing.
  cors?:          string;
  workdir?:       string;
  files?:         FileStore;
  configPath?:    string;
  /** Identity of the process answering this request. A workspace switch replaces the process, so the
   *  client cannot tell a completed switch from the outgoing process still serving unless the answer
   *  says who produced it — the registry file it would otherwise poll is written *before* the handoff,
   *  so the old process reports the new workspace while still serving the old one's sessions. */
  runtime?:       { id: string; workspace?: string };
  workspaceManager?: WorkspaceManager;
  getWorkspaceManager?:()=>WorkspaceManager|undefined;
  workspaceRagManager?: () => WorkspaceRagManager | undefined;
  /** Resolved per call, like {@link skills} — the titler plugin may load in any order, or not at all. */
  sessionTitler?: () => SessionTitler | undefined;
  /** Derives the security principal for each request. Defaults to {@link defaultWebPrincipal}. */
  resolvePrincipal?: WebPrincipalResolver;
  /** Install-scoped display configuration. Never read from workspace-local state. */
  branding?: WebBranding;
}

/** Structural view of the session-titler plugin's service — kept local so frontend-web carries no
 *  dependency on an optional plugin (same treatment as {@link WorkspaceRagManager}). */
export interface SessionTitler {
  titleSession(input: { sessionId: string; provider: string; signal?: AbortSignal }): Promise<string | undefined>;
}

/** Indexing lock state for a workspace's RAG pipeline. */
export interface WorkspaceRagLockStatus {
  /** True when indexing is running or pending. */
  locked: boolean;
  /** Why the lock is held. */
  reason?: string;
  /** Machine-readable lock state. */
  state?: string;
  /** Human-readable status message. */
  message?: string;
}

/**
 * Structural view of the workspace-RAG plugin's service — kept local so
 * frontend-web carries no dependency on an optional plugin.
 */
export interface WorkspaceRagManager {
  /**
   * Reports the RAG indexing lock status for a workspace.
   * @param workspaceId Workspace to query.
   * @returns The lock status.
   */
  workspaceLockStatus(workspaceId: string): WorkspaceRagLockStatus;
}

/**
 * Whether a workspace may be deleted right now, and why not when it may not.
 *
 * Mirrors the RAG lock status fields ({@link WorkspaceRagLockStatus}) so the UI can show both the
 * verdict and the blocker.
 */
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

/**
 * Body of `POST /sessions/:id/submit`.
 *
 * `content` is either plain text or a form response; `sessionId` overrides the id in the path;
 * `concatQueue` chooses between joining the running turn's batch (`true`) and a separate queued
 * turn (`false`, the server-side default when unspecified); attachments reference workspace files.
 */
interface SubmitBody {
  content:      string | { type: 'form-response'; values: Record<string, string> };
  provider:     string;       // opaque name passed to deps.resolveProvider
  sessionId?:   string;
  traceId?:     string;
  concatQueue?: boolean;      // true (default): merge into the running turn's batch; false: own turn
  attachments?: WorkspaceAttachment[];
}

/** Reference to a workspace file attached to a submission. */
interface WorkspaceAttachment {
  namespace: 'workspace';
  path:      string;
}



/**
 * Optional `$context` envelope fields for direct tool invocation.
 *
 * Lets `POST /tools/:name` and `POST /stream/tools/:name` opt into a real session or provider;
 * without it the tool runs against a stub session. Interactive prompting is unavailable in either
 * case (see {@link nonInteractivePrompt}).
 */
interface DirectToolContextSpec {
  provider?:  string;
  sessionId?: string;
}

/**
 * A resolved direct tool call: the parsed input plus optional session/provider context.
 *
 * Produced by {@link resolveDirectToolInvocation} from the request body's optional `$context`
 * envelope.
 */
interface DirectToolInvocation {
  input:      unknown;
  session?:   Session;
  provider?:  string;
}

// How long a connection that is still mid-request may hold up `close()` before it is cut. Long enough
// for an in-flight response to finish, short enough that shutdown stays bounded.
const CLOSE_GRACE_MS = 1000;

// Header carrying the optional shared secret (env CORTEX_WEBUI_TOKEN) on mutating requests.
const TOKEN_HEADER = 'x-cortex-token';

// Execution-class tools are denied for direct HTTP invocation by default — the classic
// localhost-CSRF/DNS-rebinding RCE path. CORTEX_WEBUI_ALLOW_SHELL_TOOLS=1 opts back in.
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'powershell', 'docker-bash']);

// CAS retry budget for appendSessionMessages. Contended appends retry with randomized backoff and
// then fail the request (409) — never a bypassing unconditional write.
const MAX_CAS_ATTEMPTS = 10;

/** Thrown by {@link appendSessionMessages} when the session stays contended past the CAS retry budget. */
export class SessionConflictError extends Error {
  /**
   * Creates the error for a session whose appends kept conflicting past the CAS retry budget.
   *
   * @param sessionId - Session the conflicting writes targeted.
   * @throws Never.
   */
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was concurrently modified; please retry.`);
    this.name = 'SessionConflictError';
  }
}

/**
 * Waits for a fixed delay.
 *
 * @param ms - Milliseconds to wait.
 * @returns Resolves once the delay has elapsed; not abortable.
 * @throws Never.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reads a request body into a UTF-8 string, enforcing a size cap.
 *
 * When the cap is exceeded the connection is destroyed immediately (rather than drained) so an
 * oversized body cannot keep consuming memory, and the returned promise rejects.
 *
 * @param req - Request whose body to buffer.
 * @param maxBytes - Cap in bytes; larger bodies reject. Defaults to 1 MiB.
 * @returns The body, decoded as UTF-8.
 * @throws Error - When the body exceeds `maxBytes` or the request stream errors.
 */
async function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        // Stop buffering immediately and tear down the connection: continuing to drain would let an
        // oversized body consume memory long after the limit was exceeded.
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

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
/**
 * Default request identity resolver: the ambient boot principal, falling back
 * to a fixed anonymous `web-user` when none is established.
 * @returns The resolved principal for a request.
 * @throws Never - A missing boot principal resolves to the anonymous identity instead of throwing.
 */
export const defaultWebPrincipal: WebPrincipalResolver = () => tryCurrentPrincipal() ?? ANONYMOUS_WEB_USER;

/**
 * Writes a JSON response with `content-type` and `content-length` headers.
 *
 * @param res - Response to write to.
 * @param status - HTTP status code.
 * @param body - Value serialised as the JSON body.
 * @returns Nothing.
 * @throws Never - Socket failures surface as response stream events, not exceptions.
 */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type':   'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Builds the CORS headers for a response.
 *
 * The `access-control-allow-origin` value is the caller-chosen origin (reflected), or absent when
 * `undefined` is passed; the allowed headers include the shared-secret header.
 *
 * @param origin - Origin to allow, or `undefined` to send no `access-control-allow-origin`.
 * @returns Header records to apply to the response.
 * @throws Never.
 */
function corsHeaders(origin: string | undefined): Record<string, string> {
  return {
    ...(origin !== undefined ? { 'access-control-allow-origin': origin } : {}),
    'access-control-allow-headers': 'content-type, authorization, x-cortex-token',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  };
}

// DNS-rebinding defense, mirroring http-utils assertLoopbackRequest for file-broker/file-index:
// only requests whose Host names a loopback origin are served.
/**
 * Checks whether a `Host` header names a loopback host (DNS-rebinding defense).
 *
 * Strips the port (bracket-aware for IPv6 literals) before comparing.
 *
 * @param hostHeader - Raw `Host` header value.
 * @returns `true` for `localhost`, `127.0.0.1`, or `[::1]` (on any port).
 * @throws Never.
 */
function isLoopbackHost(hostHeader: string): boolean {
  const host = hostHeader.trim().toLowerCase();
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.includes(':') ? host.slice(0, host.lastIndexOf(':')) : host;
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

// CORS allowlist: loopback origins on any port (the UI is served from this same server).
/**
 * Checks whether an `Origin` header is a loopback origin (CORS allowlist).
 *
 * Only http(s) URLs whose hostname is `localhost`, `127.0.0.1`, or `::1` (on any port) qualify —
 * the UI is served from this same server.
 *
 * @param origin - Raw `Origin` header value.
 * @returns `true` when the origin is loopback and may be reflected.
 * @throws Never.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Compares a presented shared secret with the expected one in constant time.
 *
 * Length is checked first so {@link timingSafeEqual}'s length-mismatch throw is unreachable.
 *
 * @param presented - Token from the request header.
 * @param expected - Configured token.
 * @returns `true` when the two are byte-identical.
 * @throws Never.
 */
function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Decodes a URI-encoded tool name from a route path, tolerating bad escapes.
 *
 * @param raw - Encoded tool name from the URL.
 * @returns The decoded name, or the raw input when decoding fails.
 * @throws Never.
 */
function decodeToolName(raw: string): string {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/**
 * Narrows a value to a plain object record.
 *
 * @param value - Value to test.
 * @returns `true` when the value is a non-null, non-array object.
 * @throws Never.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The single interactive prompt implementation is the SSE round-trip built per-submit (see the
// `/sessions/:id/submit` handler): it parks on `pendingPrompts` and is answered via
// `POST /sessions/:id/prompt`. The direct tool-invocation endpoints (`/tools/:name`,
// `/stream/tools/:name`) may opt into a real session/provider with the `$context` envelope, but still
// have no answer channel, so they CANNOT prompt interactively — a known, deliberate blind spot. Any
// UI flow that needs to ask the user something must drive the tool through `/submit` instead. This
// fallback makes that boundary explicit: take the default if one was offered, otherwise fail loudly
// rather than hang.
/**
 * Prompt stand-in for contexts with no answer channel (the direct tool-invocation endpoints).
 *
 * Resolves immediately with the offered default (for a string question the `def` argument, for a
 * field the field default); with no default it rejects rather than hanging, so a tool that needs
 * the user fails fast instead of blocking. Flows that must ask the user have to drive the tool
 * through `/sessions/:id/submit`, whose SSE round-trip prompt can actually receive an answer.
 *
 * @param p - Question string or form field offered by the tool.
 * @param def - Default answer for a string question.
 * @returns Resolves with the default, or rejects when none is offered.
 * @throws Never - The rejection is delivered via the returned promise.
 */
const nonInteractivePrompt: PromptFn = ((p: string | FormField, def?: string) => {
  const fallback = typeof p === 'string' ? def : p.default;
  return fallback !== undefined
    ? Promise.resolve(fallback)
    : Promise.reject(new Error(`Non-interactive context (use /submit for interactive prompts): "${typeof p === 'string' ? p : p.label}"`));
}) as PromptFn;

/**
 * Creates the HTTP + SSE chat server.
 * @param deps Injected services and registries (see {@link WebServerDeps}).
 * @returns A Node `http.Server` serving the static UI, session submit/abort,
 *          prompt round-trips, workspace management, direct tool invocation,
 *          and multiplexed SSE event streams.
 * @throws Never - Watch-loop and request failures are handled internally (logged or answered
 *          per-response); nothing here throws synchronously.
 */
export function createWebServer(deps: WebServerDeps) {
  // CORS: an explicit deps.cors value wins; otherwise only loopback origins are reflected.
  const configuredCors = deps.cors;
  /**
   * Picks the `access-control-allow-origin` value for a request.
   *
   * An explicit `deps.cors` wins; otherwise a request `Origin` is reflected only when it is a
   * loopback origin (see {@link isLoopbackOrigin}), and an absent origin gets none.
   *
   * @param req - Incoming request.
   * @returns The origin to reflect, or `undefined` to withhold the header.
   * @throws Never.
   */
  const resolveCorsOrigin = (req: IncomingMessage): string | undefined => {
    if (configuredCors !== undefined) return configuredCors;
    const origin = req.headers.origin;
    if (origin === undefined || !isLoopbackOrigin(origin)) return undefined;
    return origin;
  };
  // Optional shared secret on mutating routes. Unset/empty → no token required.
  const requiredToken = process.env['CORTEX_WEBUI_TOKEN'];
  const shellToolsAllowed = process.env['CORTEX_WEBUI_ALLOW_SHELL_TOOLS'] === '1';
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
  const fallbackExpertSessions = new ExpertSessionService({store:deps.store,run:deps.run,resolve:name=>deps.tools?.resolve(name)??null,invoke:deps.invokeTool??invokeToolEvents,...(deps.sessionTitler?{titleSession:(input:{sessionId:string;provider:string})=>deps.sessionTitler?.()?.titleSession(input)??Promise.resolve()}: {})});
  /**
   * Resolves the expert-session service for a call, preferring an injected provider.
   *
   * Returns `deps.expertSessions()` when one is supplied, else the server-owned fallback service,
   * which shares the store, runner, tool resolution, and optional session titler.
   *
   * @returns The expert-session service, or `undefined` when an injected provider reports none.
   * @throws Never.
   */
  const expertSessions=()=>deps.expertSessions?deps.expertSessions():fallbackExpertSessions;
  // session ID → the parked prompt's settlers. `resolve` delivers an answer (applying the default
  // fallback); `cancel` rejects it with PromptCancelledError — the "give up" path.
  const pendingPrompts = new Map<string, { resolve: (answer: string) => void; cancel: () => void }>();

  // One multiplexed event stream (GET /events) carries every global, non-session event — session
  // busy/idle, file changes, and tool/skill/plugin CRUD — each tagged by name and demuxed client-side.
  // Browsers cap HTTP/1.1 at ~6 sockets per host; a separate SSE connection per panel would exhaust
  // that and starve ordinary fetches (the sidebar load, tool calls), so the whole UI shares one socket.
  const globalListeners = new Set<ServerResponse>();

  /**
   * Writes a pre-formatted SSE message to every connected global-stream client.
   *
   * Connections that have gone unwritable are pruned from the listener set as they are encountered.
   *
   * @param msg - Fully serialised SSE frame (see {@link sseEvent}).
   * @returns Nothing.
   * @throws Never.
   */
  const broadcast = (msg: string): void => {
    for (const res of globalListeners) { if (res.writable) res.write(msg); else globalListeners.delete(res); }
  };

  // Per-file watchers (GET /events/files/:ns/:name), keyed `<namespace>/<name>` so single-file streams
  // don't collide across namespaces. Separate from the global stream: a targeted watch, not the firehose.
  const fileEventListeners = new Map<string, Set<ServerResponse>>();
  const watchAc            = new AbortController();

  /**
   * Logs a watch loop that stopped unexpectedly, unless shutdown already aborted it.
   *
   * @param name - Human-readable watch name for the log line (e.g. `file`, `tool`).
   * @param error - The failure that ended the loop.
   * @returns Nothing.
   * @throws Never.
   */
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

  /**
   * Starts the skill-CRUD broadcast loop, at most once per server lifetime.
   *
   * Broadcasts `skill-changed` events (saves/deletes, including mid-turn LLM edits) to the global
   * stream. Called lazily on the first `/events` connect, by which point the skills plugin has
   * finished setup even when it loaded after frontend-web.
   *
   * @param skills - Skill manager to watch.
   * @returns Nothing.
   * @throws Never - Loop failures are reported via {@link reportWatchFailure}.
   */
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

  /**
   * Writes a pre-formatted SSE message to every per-session stream for one session.
   *
   * Unwritable connections are pruned; a session with no connected clients is a no-op.
   *
   * @param sessionId - Session whose subscriber connections receive the message.
   * @param msg - Fully serialised SSE frame (see {@link sseEvent}).
   * @returns Nothing.
   * @throws Never.
   */
  function sendToSession(sessionId: string, msg: string): void {
    const conns = sessionConns.get(sessionId);
    if (conns === undefined) return;
    for (const res of conns) { if (res.writable) res.write(msg); else conns.delete(res); }
  }

  // Broadcast a session's busy/idle transition to the global status listeners (sidebar), deduped
  // against the last value. Authoritative busy comes from the runner (running || queued > 0).
  /**
   * Publishes a session's busy/idle transition to the global stream, deduped.
   *
   * Busy state is read authoritatively from the runner (`running || queued > 0`) and broadcast only
   * on change; when idle, the session's cached state is dropped.
   *
   * @param sessionId - Session to re-evaluate.
   * @returns Nothing.
   * @throws Never.
   */
  function updateBusy(sessionId: string): void {
    const busy = deps.run.status(sessionId).busy;
    if ((busyState.get(sessionId) ?? false) === busy) return;
    if (busy) busyState.set(sessionId, true); else busyState.delete(sessionId);
    broadcast(sseEvent('session-busy', { sessionId, busy }));
  }

  /**
   * Determines whether a workspace can be deleted, and why not when it cannot.
   *
   * Refusal order: no workspace manager, an explicit `deleteCheck` verdict from the manager, an
   * unknown workspace, the active workspace, then an active or pending RAG indexing lock.
   *
   * @param workspaceId - Workspace to evaluate.
   * @returns The readiness verdict, including lock state and message when applicable.
   * @throws Error - If the workspace manager's `list()` or `deleteCheck()` fails.
   */
  async function workspaceDeleteReadiness(workspaceId: string): Promise<WorkspaceDeleteReadiness> {
    const workspaceManager=deps.getWorkspaceManager?deps.getWorkspaceManager():deps.workspaceManager;
    if (!workspaceManager) return { canDelete: false, locked: false, reason: 'Workspace manager unavailable.' };
    if (workspaceManager.deleteCheck) return workspaceManager.deleteCheck(workspaceId);
    const state = await workspaceManager.list();
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

    // DNS-rebinding defense: a foreign (or missing) Host header never reaches the routes.
    const host = req.headers.host;
    if (host === undefined || !isLoopbackHost(host)) {
      json(res, 403, { error: 'Forbidden.' });
      return;
    }

    // Set CORS headers on every response — the origin only when allowlisted.
    for (const [k, v] of Object.entries(corsHeaders(resolveCorsOrigin(req)))) {
      res.setHeader(k, v);
    }

    // CORS alone only hides responses: a browser can still send a simple POST
    // (including text/plain) without preflight. Reject foreign writes before any
    // tool, session, prompt, or workspace operation can run. Native clients have
    // no Origin; explicit CORS configuration remains the browser allowlist.
    const mutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const origin = req.headers.origin;
    if (mutating && origin !== undefined && !(configuredCors === '*'
      || (configuredCors !== undefined ? origin === configuredCors : isLoopbackOrigin(origin)))) {
      json(res, 403, { error: 'Request origin is not allowed to modify Cortex.' });
      return;
    }

    // Shared-secret gate on mutating routes. GET/OPTIONS stay open so the UI keeps rendering.
    if (mutating && requiredToken) {
      const presented = req.headers[TOKEN_HEADER];
      if (typeof presented !== 'string' || !tokensEqual(presented, requiredToken)) {
        json(res, 401, { error: 'Unauthorized.' });
        return;
      }
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
      if (!res.headersSent) json(res, e instanceof SessionConflictError ? 409 : 500, { error: String(e) });
      else if (res.writable)  res.end();
    }
  });

  /**
   * Builds a `ToolContext` for server-driven tool invocations.
   *
   * With no explicit invocation context the tool runs against a stub session owned by the request
   * principal and no provider; a `$context`-resolved invocation (see
   * {@link resolveDirectToolInvocation}) supplies a real session and/or provider. Prompting uses
   * {@link nonInteractivePrompt} — there is no answer channel outside `/submit`. Optional
   * environment fields (workdir, files, configPath) are spread only when present, and the call id
   * is freshly minted per invocation.
   *
   * @param ac - Controller whose signal cancels the tool execution (tied to the request).
   * @param principal - Request principal attributed to the invocation.
   * @param invocation - Optional session/provider context resolved from a `$context` envelope.
   * @returns The tool context object.
   * @throws Never.
   */
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

  /**
   * Splits a direct tool-call body into tool input and optional execution context.
   *
   * A body containing a `$context` key is treated as `{ $context?, input? }`: the context may name
   * a provider and/or an existing session (validated and fetched — an unknown session is a 404),
   * and everything else runs as plain input. A body without `$context` passes through untouched.
   *
   * @param rawInput - Parsed request body.
   * @returns `{ ok: true, invocation }` on success, or `{ ok: false, status, error }` with the HTTP
   *          status (400/404) to answer with.
   * @throws Never - Failures are returned as the `ok: false` variant.
   */
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

  /**
   * Builds a handler that serves one bundled static file with a 200 response.
   *
   * The file is read from disk (module-relative path) on every request.
   *
   * @param res - Response the handler writes to.
   * @param contentType - `Content-Type` to serve the file as.
   * @param path - Module-relative path of the static file.
   * @returns An async handler performing the read and the write.
   * @throws Error - If the file cannot be read (propagates to the request-level error handler).
   */
  function static200(res: ServerResponse, contentType: string, path: string) {
    return async () => {
      const body = await readFile(new URL(path, import.meta.url), "utf-8");
      res.writeHead(200, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
  }
  /**
   * Routes and serves one request after authentication, CORS, and principal setup.
   *
   * Handled in order: branding; plugin-contributed `webui` listings and contributed HTTP routes;
   * static UI files; providers and health; workspace administration (routed through the
   * `workspace_admin_action` tool when contributions are present, else direct workspace-manager
   * routes); the multiplexed global SSE stream (`/events`); session status, create, submit,
   * expert-panel, abort, and prompt round-trip; the persistent per-session SSE stream; direct
   * buffered (`/tools/:name`) and streaming (`/stream/tools/:name`) tool invocation, with
   * execution-class shell tools denied unless `CORTEX_WEBUI_ALLOW_SHELL_TOOLS=1`; the single-file
   * SSE watch; and read-only file serving (only files marked `allowed`, reported as 404 rather
   * than 403 when unresolvable so path existence is not revealed). Everything else is a 404.
   * Submits are fire-and-forget: turn output and interactive prompts reach clients over the
   * per-session SSE stream, not the submit response.
   *
   * @param req - Incoming request.
   * @param res - Response to write to.
   * @param method - HTTP method (`GET` when absent).
   * @param url - Request URL (`/` when absent).
   * @param principal - Principal resolved for this request and already established ambiently.
   * @returns Resolves once the response has been fully written or handed off to a persistent
   *          stream.
   * @throws Error - Unexpected failures propagate to the request-level handler, which answers 500
   *          (409 for {@link SessionConflictError}) when headers have not been sent.
   */
  async function handleRequest(
    req: IncomingMessage, res: ServerResponse, method: string, url: string, principal: Principal,
  ): Promise<void> {

    if (method === 'GET' && url === '/branding') {
      json(res, 200, branding);
      return;
    }

    // --- Static UI ---
    if(method==='GET'&&url==='/ui/contributions'){
      const rows=deps.contributions?.list('webui');
      json(res,200,rows?rows.map(({id,owner,value})=>({id,owner,...value})):[]);return;
    }
    const routes=deps.contributions?.list('http').filter(row=>row.value.method===method&&row.value.path===url)??[];
    if(routes.length>1){json(res,503,{error:'Conflicting plugin routes'});return;}
    if(routes.length){const route=routes[0]!;const ac=new AbortController();req.once('aborted',()=>ac.abort());let body:unknown;
      if(method!=='GET'){try{body=JSON.parse(await readBody(req));}catch{json(res,400,{error:'Invalid JSON'});return;}}
      try{const ctx=makeToolCtx(ac,principal);ctx.signal=AbortSignal.any([ac.signal,route.signal]);ctx.signal.throwIfAborted();const response=await route.value.handle({body,context:ctx,url});json(res,response.status,response.body);}finally{ac.abort();}return;
    }
    const staticRoutes: Record<string, () => Promise<void>> = {
      '/': static200(res, 'text/html; charset=utf-8', "../static/index.html"),
      '/index.html': static200(res, 'text/html; charset=utf-8', "../static/index.html"),
      '/feature-runtime.js':static200(res,'application/javascript; charset=utf-8','../static/feature-runtime.js'),
      '/feature-fallbacks.js':static200(res,'application/javascript; charset=utf-8','../static/feature-fallbacks.js'),
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

    // Read-only conversation metadata is independent of optional administration tools.
    if(method==='GET'&&url==='/providers'){json(res,200,{providers:deps.listProviders?.()??[]});return;}

    // --- GET /health ---
    if (method === 'GET' && url === '/health') {
      json(res, 200, { status: 'ok' }); return;
    }

    const workspaceManager=deps.getWorkspaceManager?deps.getWorkspaceManager():deps.workspaceManager;
    if(deps.contributions&&url.startsWith('/workspaces')){
      const match=/^\/workspaces(?:\/([^/]+)(?:\/(delete-check|rename|switch))?)?$/.exec(url);
      if(match){let action:string|undefined;let body:Record<string,unknown>={};const id=match[1]?decodeURIComponent(match[1]):undefined;
        if(method==='GET')action=id?(match[2]==='delete-check'?'delete_check':undefined):'list';
        if(method==='POST')action=id?(match[2]==='rename'?'rename':match[2]==='switch'?'switch':undefined):'create';
        if(method==='DELETE'&&id&&!match[2])action='delete';
        if(action){if(method==='POST'&&action!=='switch'){try{body=JSON.parse(await readBody(req)) as Record<string,unknown>;}catch{json(res,400,{error:'Invalid JSON'});return;}}
          const tool=deps.tools?.resolve('workspace_admin_action');if(!tool){json(res,404,{error:'Workspace administration unavailable'});return;}
          const ac=new AbortController();req.once('aborted',()=>ac.abort());try{for await(const event of (deps.invokeTool??invokeToolEvents)(tool,{action,...(id?{id}:{}),...(body.name!==undefined?{name:body.name}:{})},makeToolCtx(ac,principal))){
            if(event.type==='error'){json(res,event.code==='permission_denied'?403:event.code==='approval_required'?409:400,{error:event.message,code:event.code});return;}
            if(event.type==='result'){const result=event.value as Record<string,unknown>;const status=action==='delete_check'&&result.canDelete===false?(result.locked?409:400):action==='create'?201:200;json(res,status,action==='list'?{...result,...(deps.runtime?{runtime:deps.runtime}:{})}:result);return;}
          }}finally{ac.abort();}json(res,500,{error:'Workspace administration returned no result'});return;
        }
      }
    }
    if (method === 'GET' && url === '/workspaces') {
      if (!workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      json(res, 200, { ...await workspaceManager.list(), ...(deps.runtime !== undefined ? { runtime: deps.runtime } : {}) }); return;
    }

    const workspaceDeleteCheck = /^\/workspaces\/([^/]+)\/delete-check$/.exec(url);
    if (method === 'GET' && workspaceDeleteCheck) {
      if (!workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      const readiness = await workspaceDeleteReadiness(decodeURIComponent(workspaceDeleteCheck[1]!));
      json(res, readiness.canDelete ? 200 : (readiness.locked ? 409 : 400), readiness);
      return;
    }

    if (method === 'POST' && url === '/workspaces') {
      if (!workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      let body: { name?: unknown };
      try { body = JSON.parse(await readBody(req)) as { name?: unknown }; }
      catch (e) { json(res, 400, { error: String(e) }); return; }
      if (typeof body.name !== 'string') { json(res, 400, { error: 'Workspace name is required' }); return; }
      json(res, 201, await workspaceManager.create(body.name)); return;
    }

    const workspaceRename = /^\/workspaces\/([^/]+)\/rename$/.exec(url);
    if (method === 'POST' && workspaceRename) {
      if (!workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      let body: { name?: unknown };
      try { body = JSON.parse(await readBody(req)) as { name?: unknown }; }
      catch (e) { json(res, 400, { error: String(e) }); return; }
      if (typeof body.name !== 'string') { json(res, 400, { error: 'Workspace name is required' }); return; }
      json(res, 200, await workspaceManager.rename(decodeURIComponent(workspaceRename[1]!), body.name)); return;
    }

    const workspaceSwitch = /^\/workspaces\/([^/]+)\/switch$/.exec(url);
    if (method === 'POST' && workspaceSwitch) {
      if (!workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      json(res, 200, await workspaceManager.switch(decodeURIComponent(workspaceSwitch[1]!))); return;
    }

    const workspaceDelete = /^\/workspaces\/([^/]+)$/.exec(url);
    if (method === 'DELETE' && workspaceDelete) {
      if (!workspaceManager) { json(res, 404, { error: 'Workspace manager unavailable' }); return; }
      try {
        const workspaceId = decodeURIComponent(workspaceDelete[1]!);
        const readiness = await workspaceDeleteReadiness(workspaceId);
        if (!readiness.canDelete) {
          json(res, readiness.locked ? 409 : 400, readiness);
          return;
        }
        json(res, 200, await workspaceManager.delete(workspaceId));
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
      if (expertSessions()?.busy(targetId)) {
        json(res, 409, { error: 'Session is busy running an expert panel.' }); return;
      }

      const traceId = body.traceId ?? crypto.randomUUID();

      // Normalise content into MessageContent[]. The runner appends + persists the user message
      // when this submission's turn actually starts (persist-at-turn-start) — never here — so a
      // mid-turn submit queues behind the running turn instead of clobbering session state.
      let preparedAttachments: Awaited<ReturnType<typeof prepareWorkspaceAttachments>>;
      try {
        const resolver=deps.attachments?.();if(deps.attachments&&!resolver&&Array.isArray(body.attachments)&&body.attachments.length)throw new Error('Attachment resolver unavailable');
        preparedAttachments = await (resolver?.resolve ?? prepareWorkspaceAttachments)(deps.files, body.attachments);
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
      /**
       * Interactive prompt for this submission: parks on `pendingPrompts` and emits a `prompt` SSE
       * event on the session's stream.
       *
       * Resolves when `POST /sessions/:id/prompt` answers (an empty answer falls back to the offered
       * default, else `''`); rejects with {@link PromptCancelledError} on the cancel path. At most
       * one prompt is outstanding per session, since turns are serialised.
       *
       * @param p - Question string or form field offered by the tool.
       * @param defaultValue - Default answer for a string question.
       * @returns Resolves with the user's answer; rejects when cancelled or released.
       * @throws Never - The rejection is delivered via the returned promise.
       */
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

      const ac=new AbortController();req.once('aborted',()=>ac.abort());
      try {const service=expertSessions();if(!service){json(res,503,{error:'Expert session service unavailable'});return;}json(res,200,await service.submit(sessionId,parsed,makeToolCtx(ac,principal),event=>sendToSession(sessionId,sseEvent(event.type,event))));}
      catch(error){if(error instanceof ExpertSessionError)json(res,error.status,{error:error.message});else throw error;}
      finally{ac.abort();}
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
      const toolName = decodeToolName(toolCallMatch[1]!);
      if (!shellToolsAllowed && SHELL_TOOL_NAMES.has(toolName)) {
        json(res, 403, { error: `Tool "${toolName}" may not be invoked directly over HTTP. Set CORTEX_WEBUI_ALLOW_SHELL_TOOLS=1 to allow it.` });
        return;
      }

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
        for await (const ev of (deps.invokeTool ?? invokeToolEvents)(tool, invocation.invocation.input, toolCtx)) {
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
      const toolName = decodeToolName(streamToolMatch[1]!);
      if (!shellToolsAllowed && SHELL_TOOL_NAMES.has(toolName)) {
        json(res, 403, { error: `Tool "${toolName}" may not be invoked directly over HTTP. Set CORTEX_WEBUI_ALLOW_SHELL_TOOLS=1 to allow it.` });
        return;
      }

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
        for await (const ev of (deps.invokeTool ?? invokeToolEvents)(tool, invocation.invocation.input, makeToolCtx(ac, principal, invocation.invocation))) {
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
        ...corsHeaders(resolveCorsOrigin(req)),
      });
      for await (const chunk of handle.stream()) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    json(res, 404, { error: 'Not found' });
  }

  /**
   * Shuts the server down in dependency order and releases every waiting party.
   *
   * Ends all per-session, global, and per-file SSE streams; aborts the watch loops; resolves all
   * pending prompts with an empty answer; then closes the listener — dropping idle keep-alive
   * sockets immediately and cutting any connection still mid-request after a one-second grace
   * ({@link CLOSE_GRACE_MS}), so a workspace switch cannot stall process exit indefinitely. Close
   * errors are logged, not thrown.
   *
   * @returns Resolves once the listener has closed, gracefully or after the grace cut.
   * @throws Never.
   */
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
