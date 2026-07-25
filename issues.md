# Cortex — Code Review Findings

Review date: 2026-07-25 · Reviewed at `main` @ `00f9f8f` · ~50k LOC across 232 source files.

Scope: `local-agent/file-index`, `local-agent/file-broker`, `local-agent/http-utils`,
`local-agent/matbot/packages/**`, `local-agent/matbot/apps/**`, `scripts/`, `tests/`.

At review time `npm test` passed 20/20. Every issue below was confirmed by reading the
code, not inferred from test failures.

Each issue states the problem, the evidence, why it matters, and a proposed fix. Issues
that have since been addressed carry a **Resolution** note recording what changed and what
was deliberately left out.

**Status: 2 of 23 fixed, 1 partial** (as of `c315f8c`, suite 22/22).

| | Issues |
|---|---|
| Fixed | [#1](#1-file-index-index-accepts-an-arbitrary-root-with-no-allowlist) (arbitrary index root), [#16](#16-path-normalisation-is-duplicated-across-file-broker-and-file-index) (duplicated path normalisation) |
| Partial | [#11](#11-path-canonicalisation-does-not-resolve-symlinks) (symlink resolution — file-index done, file-broker outstanding) |
| Highest-severity open | [#2](#2-three-local-services-bind-all-interfaces-with-no-authentication) (unauthenticated listeners on all interfaces) |

---

## Contents

| # | Severity | Status | Issue |
|---|---|---|---|
| [1](#1-file-index-index-accepts-an-arbitrary-root-with-no-allowlist) | Critical | **Fixed** | `file-index` `/index` accepts an arbitrary filesystem root |
| [2](#2-three-local-services-bind-all-interfaces-with-no-authentication) | High | Open | Three local services bind all interfaces with no authentication |
| [3](#3-stored-xss-markdown-is-rendered-into-innerhtml-unsanitised) | High | Open | Stored XSS — markdown rendered into `innerHTML` unsanitised |
| [4](#4-shell-tools-inherit-the-full-process-environment-including-api-keys) | High | Open | Shell tools inherit the full process environment, including API keys |
| [5](#5-workflow-approvals-are-written-without-compare-and-swap) | High | Open | Workflow approvals are written without compare-and-swap |
| [6](#6-static-route-handlers-are-not-awaited) | Medium | Open | Static route handlers are not awaited |
| [7](#7-the-bash-tool-leaks-child-processes-and-can-double-finalise) | Medium | Open | The `bash` tool leaks child processes and can double-finalise |
| [8](#8-workspace-rag-writes-its-index-non-atomically-and-silently-resets-on-corruption) | Medium | Open | `workspace-rag` writes non-atomically and silently resets on corruption |
| [9](#9-front-end-loads-unpinned-third-party-scripts-from-a-cdn) | Medium | Open | Front end loads unpinned third-party scripts from a CDN |
| [10](#10-file-broker-declares-excludedpatterns-but-never-enforces-them) | Medium | Open | `file-broker` declares `excludedPatterns` but never enforces them |
| [11](#11-path-canonicalisation-does-not-resolve-symlinks) | Medium | **Partial** | Path canonicalisation does not resolve symlinks |
| [12](#12-the-indexer-walks-into-excluded-directories-and-aborts-on-a-single-unreadable-one) | Medium | Open | The indexer walks into excluded directories and aborts on one unreadable one |
| [13](#13-indexing-a-second-root-discards-the-first-roots-skip-list) | Low | Open | Indexing a second root discards the first root's skip list |
| [14](#14-appjs-is-a-5618-line-flat-script-with-ten-duplicated-listdetail-panels) | Refactor | Open | `app.js` is a 5,618-line flat script with ten duplicated list/detail panels |
| [15](#15-spawnandstream-is-duplicated-across-bash-and-powershell-and-has-diverged) | Refactor | Open | `spawnAndStream` is duplicated across `bash`/`powershell` and has diverged |
| [16](#16-path-normalisation-is-duplicated-across-file-broker-and-file-index) | Refactor | **Fixed** | Path normalisation is duplicated across `file-broker` and `file-index` |
| [17](#17-readjson-is-duplicated-inside-the-workspace-rag-package) | Refactor | Open | `readJson` is duplicated inside the `workspace-rag` package |
| [18](#18-registry-lookups-use-as-never-casts-that-defeat-the-typed-service-registry) | Refactor | Open | Registry lookups use `as never` casts that defeat the typed service registry |
| [19](#19-typescript-strictness-is-split-between-the-two-halves-of-the-repo) | Refactor | Open | TypeScript strictness is split between the two halves of the repo |
| [20](#20-dead-code-commented-out-routes-and-redundant-version-bumps) | Cleanup | Open | Dead code — commented-out routes and redundant version bumps |
| [21](#21-secret-detection-discards-whole-files-on-broad-heuristics) | Quality | Open | Secret detection discards whole files on broad heuristics |
| [22](#22-index-search-ranks-by-term-presence-and-over-weights-path-matches) | Quality | Open | Index search ranks by term presence and over-weights path matches |
| [23](#23-no-unit-coverage-for-the-http-surface-of-the-web-server) | Quality | Open | No unit coverage for the HTTP surface of the web server |

---

# Security

## 1. `file-index` `/index` accepts an arbitrary root with no allowlist

**Severity: Critical · Status: FIXED in `c315f8c`** — see the Resolution at the end of this entry.

**Where:** [local-agent/file-index/src/server.ts:31-49](local-agent/file-index/src/server.ts:31)

```ts
const body = await readJsonBody<{ root?: string }>(request, { validate: isIndexRequest });
const config = await readWorkspaceConfig();
const root = body.root ?? config.roots[0]?.path;
```

`isIndexRequest` only checks that `root` is a string. The value is passed straight to
`indexRoot()` and never compared against `config.roots`. The configured roots
(`C:\Projects`, `C:\Users\Maciej\Documents` — see `local-agent/config/workspaces.json`)
serve only as a *default*, not as a boundary.

**Why it matters.** `POST /index {"root":"C:\\Users\\Maciej"}` indexes the user's entire
profile — `.ssh`, `.aws`, browser profile directories, everything. The content then
becomes readable through `POST /search`, which has no path filtering at all. None of the
protections that exist elsewhere apply here: `file-broker`'s `deniedPathFragments` are
enforced in `evaluateAccess()`, which `file-index` never calls. Combined with issue #2
(the service listens on every interface with no auth), any host on the same LAN can read
arbitrary files off the machine.

**Proposed fix.** Validate the requested root against the configured roots before
indexing, reusing the containment predicate rather than writing a third copy:

```ts
// server.ts
import { isPathInside } from "@local-agent/paths";   // see issue #16

const root = body.root ?? config.roots[0]?.path;
if (!root) { sendJson(response, 400, { error: "No root supplied and no configured roots exist." }); return; }
if (!config.roots.some(configured => isPathInside(root, configured.path))) {
  sendJson(response, 403, { error: "Requested root is outside the configured workspace roots." });
  return;
}
```

Additionally, apply `file-broker`'s `deniedPathFragments` inside the indexer walk so the
two services share one deny policy — indexing a file is a read, and should clear the same
bar as `GET /read`. Add a regression test mirroring the existing
`"file broker blocks writes outside configured roots"` case in `tests/`.

### Resolution

Fixed by root authorization (option A) plus per-file policy enforcement (option D), on top
of the shared-package extraction from issue #16.

Two further facts found while implementing, both of which shaped the fix:

- **No caller ever passes `root`.** The only client of file-index is `LocalFileIndexClient`,
  which calls `/search` only. `/index` is invoked by hand, so tightening it broke nothing.
- **`.env` is on the indexable-extensions list** ([extract.ts:12](local-agent/file-index/src/extract.ts:12)),
  and `looksLikeSecret` does not match `TOKEN=…` or `DATABASE_URL=…` shapes. `.env` files
  inside the *legitimately configured* roots were already reaching `/search`, so the root
  allowlist alone would not have closed the leak.

**What changed**

| File | Change |
|---|---|
| `local-agent/paths/` | New shared package (issue #16): `canonicalPath`, `isPathInside`, `normalizeWindowsPath`, plus `realCanonicalPath`/`isRealPathInside` and the workspace/security policy engine moved out of file-broker. |
| `file-index/src/index-root.ts` | New. `resolveIndexRoot` — a request may narrow to a subtree of a configured root, never leave it. Rejects with `HttpError(403)` and does not echo the requested path. |
| `file-index/src/server.ts` | Calls `resolveIndexRoot`; loads the security policy; passes both into `indexRoot`. Replaces the bespoke dynamic-import config reader. |
| `file-index/src/indexer.ts` | `evaluateAccess(file, "read", …)` per file: denied paths and high-risk files (`.env`, `.pem`, `.key`) are skipped with a reason instead of indexed. |
| `file-broker/src/{policy,path-normalization}.ts`, `file-index/src/path-normalization.ts` | Deleted — the three copies now import from `@local-agent/paths`. |

**Containment resolves symlinks.** `isRealPathInside` uses `realpath.native`, so a junction
planted inside a configured root cannot redirect the walk, and 8.3 short names
(`C:\PROGRA~1`) canonicalise to their long form. The walk itself does not follow directory
links — `readdir`'s `isDirectory()` is false for a junction — which is now documented in
`walk()` as load-bearing rather than left as incidental behaviour.

**Verified.** `POST /index {"root":"C:\\Users\\mzag"}` → `403`, store unchanged; `.ssh` and
`C:\Windows\System32` likewise. A subtree of a configured root still indexes. A junction
escaping a configured root is rejected (confirmed against a real junction, not a stub).
`.env` content is absent from `/search` while ordinary files remain searchable. Two
regression tests added; suite is 22/22.

**Still outstanding.** The existing `local-agent/file-index/data/index.json` is *not*
purged by this change. If `/index` was ever pointed at a sensitive tree, those chunks are
still served by `/search` — delete the store and reindex. `IndexStore.version` is declared
and never checked by `loadStore`, so a version bump cannot yet auto-discard a stale store;
worth fixing alongside issue #22.

---

## 2. Three local services bind all interfaces with no authentication

**Severity: High**

**Where:**
- [local-agent/file-broker/src/server.ts:77](local-agent/file-broker/src/server.ts:77) — `server.listen(port, ...)`
- [local-agent/file-index/src/server.ts:86](local-agent/file-index/src/server.ts:86) — `server.listen(port, ...)`
- [local-agent/matbot/packages/plugins/frontend/web/src/plugin.ts:104](local-agent/matbot/packages/plugins/frontend/web/src/plugin.ts:104) — `server.listen(port, '0.0.0.0', ...)`

`http.Server.listen(port)` with no host binds `::`/`0.0.0.0`. The frontend does it
explicitly. All three log `http://localhost:...` on startup, which misrepresents what
they actually did. None of them require any credential.

The exposed capabilities are: read any file under the configured roots, **write** files
under `C:\Projects` (`POST /write`), index and search arbitrary paths (issue #1), and —
via the WebUI's `POST /tools/:name` — invoke every registered tool, including
`powershell` and `bash`, i.e. arbitrary code execution as the logged-in user.

The default CORS origin is `*` ([server.ts:301](local-agent/matbot/packages/plugins/frontend/web/src/server.ts:301)),
so any web page the user visits can also drive these endpoints.

**The codebase already has the right pattern.** `memory-browser` defaults to loopback:

```ts
// packages/plugins/memory-browser/src/index.ts:17
const HOST = process.env['MATBOT_MEMORY_BROWSER_HOST'] ?? '127.0.0.1';
```

**Proposed fix.**

1. Default every listener to `127.0.0.1`, with an explicit env override for the rare
   remote-access case, matching `memory-browser`:
   ```ts
   const host = process.env['MATBOT_WEB_HOST'] ?? '127.0.0.1';
   server.listen(port, host, () => { ... });
   ```
   Same for `FILE_BROKER_HOST` and `FILE_INDEX_HOST`.
2. Log the address actually bound (`server.address()`), not a hardcoded `localhost`.
3. Default `cors` to `http://localhost:${port}` instead of `*`; keep `*` opt-in.
4. When a non-loopback host *is* configured, require a shared token
   (`Authorization: Bearer`) resolved through the `Vault`, and refuse to start without
   one. This makes remote exposure a deliberate, credentialed act rather than the default.

---

## 3. Stored XSS — markdown is rendered into `innerHTML` unsanitised

**Severity: High**

**Where:** [local-agent/matbot/packages/plugins/frontend/web/static/app.js:412-418](local-agent/matbot/packages/plugins/frontend/web/static/app.js:412)

```js
function md(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') return '<p>' + escHtml(text) + '</p>';
  const result = marked.parse(text);
  return result.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
}
```

`marked` has not sanitised HTML since v5 — its `sanitize` option was removed and the
project directs users to DOMPurify. Raw HTML in the markdown source passes straight
through. The result is assigned to `innerHTML` at six call sites: lines
[4155](local-agent/matbot/packages/plugins/frontend/web/static/app.js:4155),
[4456](local-agent/matbot/packages/plugins/frontend/web/static/app.js:4456),
[4506](local-agent/matbot/packages/plugins/frontend/web/static/app.js:4506),
[5042](local-agent/matbot/packages/plugins/frontend/web/static/app.js:5042),
[5052](local-agent/matbot/packages/plugins/frontend/web/static/app.js:5052),
[5167](local-agent/matbot/packages/plugins/frontend/web/static/app.js:5167).

Note the fallback branch escapes correctly — so the *degraded* path is safe and the
normal path is not.

**Why it matters.** The text reaching `md()` is not user-authored. It is model output,
tool results, workspace-RAG chunks read off disk, and fetched web content. A
`<img src=x onerror="fetch('/tools/powershell',{method:'POST',body:...})">` in any
indexed file or any page the agent reads executes in a same-origin context that can
invoke every tool the agent exposes. This converts "the agent read a hostile document"
into "arbitrary code execution on the host" — the classic prompt-injection-to-RCE bridge.

**Proposed fix.**

1. Sanitise before insertion. Vendor DOMPurify locally (see issue #9 — do not add another
   CDN dependency):
   ```js
   function md(text) {
     if (!text) return '';
     if (typeof marked === 'undefined') return '<p>' + escHtml(text) + '</p>';
     return DOMPurify.sanitize(marked.parse(text), {
       ADD_ATTR: ['target', 'rel'],
       FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'],
     });
   }
   ```
2. Set link attributes via a DOMPurify `afterSanitizeAttributes` hook rather than the
   `.replace(/<a /g, ...)` string patch, which is itself fragile (it rewrites `<a ` inside
   code blocks and text nodes).
3. Serve a Content-Security-Policy header from `server.ts` — `default-src 'self'; script-src 'self'`
   — as defence in depth. This requires issue #9 to be fixed first, since the current
   CDN `<script>` tags would violate it.
4. Add a Playwright case asserting that a message containing `<img src=x onerror=...>`
   renders as inert text.

---

## 4. Shell tools inherit the full process environment, including API keys

**Severity: High**

**Where:** [local-agent/matbot/packages/plugins/powershell/src/index.ts:150-154](local-agent/matbot/packages/plugins/powershell/src/index.ts:150)
(and the same block in `packages/plugins/bash/src/index.ts`)

```ts
const mergedEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) mergedEnv[k] = v;
}
if (env) Object.assign(mergedEnv, env);
```

Every variable in the agent process — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and whatever
else `.env` supplied to the Vault — is handed to every script the model writes. A
one-line `echo $env:OPENAI_API_KEY` exfiltrates them, and a model persuaded by injected
content will happily write that line.

This also runs against the design stated in `local-agent/matbot/CLAUDE.md`: *"Secrets and
configuration go through the `Vault` … Reaching for `process.env` directly is
non-portable."* The Vault's whole purpose is to keep credentials out of ambient scope; the
shell tools re-broadcast them.

**Proposed fix.** Start from an explicit minimal environment rather than inheriting:

```ts
const PASSTHROUGH = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC',
                     'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'TZ'];

const mergedEnv: Record<string, string> = {};
for (const key of PASSTHROUGH) {
  const value = process.env[key];
  if (value !== undefined) mergedEnv[key] = value;
}
if (env) Object.assign(mergedEnv, env);   // caller-supplied vars still honoured
```

Callers that genuinely need a credential pass it explicitly through the tool's `env`
parameter, which keeps the grant visible in the transcript and auditable. Make the
allowlist configurable via plugin `Settings` for workflows that need more. Add a test
asserting a script cannot observe a sentinel variable set on the parent process.

---

## 5. Workflow approvals are written without compare-and-swap

**Severity: High**

**Where:** [local-agent/matbot/packages/plugins/workflow-governance/src/index.ts:1120-1196](local-agent/matbot/packages/plugins/workflow-governance/src/index.ts:1120)

`approveRun`, `rejectRun`, and `escalateRun` all follow read → mutate → `set`:

```ts
const run = await this.requireRun(runId);
const pending = await this.pendingApprovals(runId, approvalId);
for (const approval of pending) {
  const updated = withOptional({ ...approval, version: randomUUID(), status: 'approved' as const, ... });
  await this.approvals.set(updated.id, updated);   // no CAS
}
```

`updateRun` ([index.ts:1662](local-agent/matbot/packages/plugins/workflow-governance/src/index.ts:1662))
does the same for the run document. Fourteen `store.set` calls in this file; zero
`store.cas` calls.

`CLAUDE.md` is explicit: *"All writes use compare-and-swap (`store.cas(id, expectedVersion, next)`).
Never write without version check when concurrent updates are possible."* The web
server's own `appendSessionMessages` ([server.ts:506-521](local-agent/matbot/packages/plugins/frontend/web/src/server.ts:506))
implements the retry-on-CAS-failure loop correctly — so the pattern exists in-repo.

**Why it matters.** Concurrent updates are not hypothetical here: the approval UI is
driven over HTTP with no per-run serialisation, so a double-click, two reviewers, or an
approve racing an escalate all interleave. The loser's decision is silently overwritten,
and the run status is recomputed from a `run` snapshot read before the race. In a module
whose entire purpose is governance and audit, a lost or inverted approval decision is the
worst possible failure — and it leaves no trace, because `appendEvent` records the
decision that *was* processed, not the one that was clobbered.

**Proposed fix.**

1. Route every mutation through a CAS helper with bounded retry, modelled on
   `appendSessionMessages`:
   ```ts
   private async mutate<T extends { id: string; version: string }>(
     store: Store<T>, id: string, apply: (current: T) => T,
   ): Promise<T> {
     for (let attempt = 0; attempt < 5; attempt++) {
       const current = await store.get(id);
       if (!current) throw new Error(`Unknown document "${id}".`);
       const saved = await store.cas(id, current.version, { ...apply(current), version: randomUUID() });
       if (saved.ok) return saved.doc;
     }
     throw new Error(`Contended write on "${id}" — retry limit exceeded.`);
   }
   ```
2. Re-read the run *after* the approval writes land, so the derived `status` /
   `completionState` reflect committed state rather than a pre-race snapshot.
3. Reject a decision on an approval that is no longer `pending`, with a 409, instead of
   overwriting it — an already-decided approval is a conflict, not an update.
4. Extend `tests/workflow-governance-runtime.mjs` with a concurrent approve/reject case.

---

# Correctness

## 6. Static route handlers are not awaited

**Severity: Medium**

**Where:** [local-agent/matbot/packages/plugins/frontend/web/src/server.ts:544-547](local-agent/matbot/packages/plugins/frontend/web/src/server.ts:544)

```ts
if (method === 'GET' && url in staticRoutes) {
  staticRoutes[url]?.();     // async — not awaited
  return;
}
```

`static200` returns an `async` thunk that `readFile`s and writes the response. The call
is not awaited and the returned promise is discarded, so the surrounding `try/catch` in
`createServer` ([server.ts:427-437](local-agent/matbot/packages/plugins/frontend/web/src/server.ts:427))
— which exists precisely to turn handler failures into a 500 — cannot see it.

A rejection therefore becomes an unhandled promise rejection (process exit under Node's
default `--unhandled-rejections=throw`) while the client's socket is left open until it
times out, with no status line ever written.

This is reachable today, not theoretically: the `/matbot.html` route resolves
`../../../../../apps/web-bundle/dist/matbot.html`, a build output outside the package.
The route is registered unconditionally, so requesting it before `web-bundle` has been
built produces exactly this ENOENT.

**Proposed fix.**

```ts
if (method === 'GET' && url in staticRoutes) {
  await staticRoutes[url]!();
  return;
}
```

and inside `static200`, translate a missing file into a 404 rather than a 500:

```ts
function static200(res: ServerResponse, contentType: string, path: string) {
  return async () => {
    let body: string;
    try { body = await readFile(new URL(path, import.meta.url), 'utf-8'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { json(res, 404, { error: 'Not found' }); return; }
      throw e;
    }
    res.writeHead(200, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
}
```

Separately, gate the `/matbot.html` route on the file existing — the comment already
calls it a testing hack that should not be in production.

---

## 7. The `bash` tool leaks child processes and can double-finalise

**Severity: Medium**

**Where:** [local-agent/matbot/packages/plugins/bash/src/index.ts:53-96](local-agent/matbot/packages/plugins/bash/src/index.ts:53)

`bash` and `powershell` carry independent copies of `spawnAndStream` (issue #15). The
copies have **diverged**, and only the `powershell` copy carries the fixes:

**a. `return()` does not kill the child.**

```ts
// bash — the child keeps running
async return(): Promise<IteratorResult<ToolEvent>> {
  if (timer !== undefined) clearTimeout(timer);
  opts.signal.removeEventListener('abort', killOnAbort);
  return { done: true, value: undefined as never };
},
```
```ts
// powershell — correct
async return(): Promise<IteratorResult<ToolEvent>> {
  child.kill('SIGTERM');
  await finish();
  return { done: true, value: undefined as never };
},
```

`return()` runs whenever the consumer breaks out of the `for await` — an aborted turn, a
rejected tool call, a torn-down SSE stream. In `bash` the spawned process is orphaned and
keeps running, holding its cwd and file handles. Repeated aborts accumulate them.

**b. No `finalized` guard.** `powershell` has one; `bash` does not. `child.on('error')`
and `child.on('close')` can both fire (an `ENOENT` spawn failure emits `error` and then
`close`), so `bash` pushes two terminal events and two `null` sentinels — a spurious
second `error`/`result` event, and a `null` left in the queue.

**c. Timeouts are indistinguishable from failures** (both copies). The timeout kills with
`SIGTERM`; the `close` handler then reports `Process exited with code N` with no mention
of the timeout. On Windows, `SIGTERM` is not a real signal — Node translates it to an
unconditional `TerminateProcess`, so the child gets no chance to clean up.

**Proposed fix.** Fold both copies into one shared implementation (issue #15), taking the
`powershell` version as the base, and add timeout reporting:

```ts
let timedOut = false;
if (opts.timeout !== undefined) {
  timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeout);
}
// in the close handler:
if (timedOut) {
  push({ type: 'error', message: `Process timed out after ${opts.timeout}ms`, ... });
}
```

Add a test that aborts mid-run and asserts the child process is gone.

---

## 8. `workspace-rag` writes its index non-atomically and silently resets on corruption

**Severity: Medium**

**Where:**
[local-agent/matbot/packages/plugins/workspace-rag/src/index.ts:570-581](local-agent/matbot/packages/plugins/workspace-rag/src/index.ts:570),
[local-agent/matbot/packages/plugins/workspace-rag/src/storage.ts:171-182](local-agent/matbot/packages/plugins/workspace-rag/src/storage.ts:171)

```ts
async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(filePath, 'utf8')) as T; }
  catch { return fallback; }          // swallows EVERYTHING
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');   // in-place
}
```

The write truncates the live file and rewrites it in place. A crash, a `Ctrl+C`, or a
workspace switch mid-write leaves a truncated file. On the next read, the bare `catch`
cannot tell a syntax error from a missing file, so it returns the empty fallback — and
the next write persists that emptiness. The user's RAG index is gone, silently, with no
log line and no error.

**The codebase already does this correctly** in `file-index`
([store.ts:34-61](local-agent/file-index/src/store.ts:34)): temp-file-plus-rename on
write, and `ENOENT`-only fallback on read, rethrowing everything else.

**Proposed fix.** Adopt the `file-index` pattern in `workspace-rag` (and de-duplicate the
two copies per issue #17):

```ts
async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  let raw: string;
  try { raw = await readFile(filePath, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
  try { return JSON.parse(raw) as T; }
  catch (e) {
    // Preserve the damaged file for recovery rather than overwriting it on the next save.
    await rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => undefined);
    console.warn(`[workspace-rag] ${filePath} was unreadable and has been quarantined; reindex required.`);
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(tmp, filePath); }
  catch (e) { await rm(tmp, { force: true }).catch(() => undefined); throw e; }
}
```

Better still: promote the `file-index` helpers into a shared `@local-agent/json-store`
package and have both consume it.

---

## 9. Front end loads unpinned third-party scripts from a CDN

**Severity: Medium**

**Where:** [local-agent/matbot/packages/plugins/frontend/web/static/index.html:8-13](local-agent/matbot/packages/plugins/frontend/web/static/index.html:8)

```html
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tiny-markdown-editor/dist/tiny-mde.min.css">
<script src="https://cdn.jsdelivr.net/npm/tiny-markdown-editor/dist/tiny-mde.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap" rel="stylesheet">
```

Three problems, compounding:

- **No version pin.** `npm/marked` resolves to whatever is latest at page load. The app
  silently adopts new major versions, including breaking ones.
- **No Subresource Integrity.** Nothing verifies what arrives. A CDN compromise, a
  hijacked package publish, or any TLS-terminating middlebox injects script that runs
  with full access to the tool-invocation API — the same escalation path as issue #3.
- **Offline.** The README describes Cortex as a *Windows-native local assistant*; the
  WebUI silently degrades without internet. The `md()` fallback at
  [app.js:414](local-agent/matbot/packages/plugins/frontend/web/static/app.js:414) hints
  this is known, but the editor and fonts have no fallback at all.

The same block is baked into the offline `web-bundle`
(`apps/web-bundle/dist/matbot.html`), so the browser-only build has the same dependency.

**Proposed fix.** Vendor the assets. Add `marked`, `tiny-markdown-editor`, `dompurify`
(issue #3), and the Inter woff2 files as devDependencies, copy them into `static/vendor/`
in the build step, and serve them from the existing static-route table:

```ts
'/vendor/marked.min.js': static200(res, 'application/javascript; charset=utf-8', '../static/vendor/marked.min.js'),
```

This pins versions through `package-lock.json`, removes the network dependency, and
unblocks the CSP proposed in issue #3. If a CDN must be kept for some deployment, pin the
exact version and add `integrity` + `crossorigin` attributes.

---

## 10. `file-broker` declares `excludedPatterns` but never enforces them

**Severity: Medium**

**Where:** [local-agent/paths/src/policy.ts:13](local-agent/paths/src/policy.ts:13) and
[policy.ts:38-71](local-agent/paths/src/policy.ts:38) — moved out of `file-broker` by
issue #16; the defect moved with it unchanged.

`WorkspaceConfig` declares `excludedPatterns: string[]`, and
`local-agent/config/workspaces.json` populates it with eleven patterns
(`**\node_modules\**`, `**\.git\**`, `**\*.exe`, …). `evaluateAccess()` never reads the
field. Only `file-index` honours it
([indexer.ts:43](local-agent/file-index/src/indexer.ts:43)).

**Why it matters.** Two services read one config file and disagree about what it means. A
path excluded from indexing is still fully readable and writable through
`GET /read` and `POST /write`. An operator who adds a pattern to protect something gets
protection in one service and none in the other, with nothing to signal the gap. Worse,
`**\.git\**` is excluded from indexing but writable through the broker — a write into
`.git/hooks/` is a code-execution primitive.

**Proposed fix.** Enforce the same patterns in `evaluateAccess`, sharing one predicate
with the indexer:

```ts
// policy.ts
import { minimatch } from "minimatch";

const root = workspaces.roots.find(item => isPathInside(targetPath, item.path));
if (!root) return { allowed: false, reason: "Path is outside configured workspace roots." };

const relative = path.relative(root.path, targetPath).replace(/\//g, "\\");
const excluded = workspaces.excludedPatterns.find(p => minimatch(relative, p, { nocase: true }));
if (excluded) return { allowed: false, reason: `Path matches excluded pattern: ${excluded}` };
```

Move `isExcluded` from `file-index/src/indexer.ts` into the shared path package proposed
in issue #16 so there is exactly one implementation. If the exclusions are genuinely
meant to be indexing-only, rename the field to `indexExcludedPatterns` so the narrower
scope is visible in the config.

> **Since `c315f8c`:** unchanged, but the prerequisite is now in place. `evaluateAccess`
> lives in `@local-agent/paths`, so enforcing the patterns is a local edit there plus
> moving `isExcluded` alongside it — no new package needed. Note the gap widened in one
> direction: `file-index` now enforces `evaluateAccess` per file (issue #1), so the two
> services agree on *denied fragments* and *high-risk extensions* while still disagreeing
> on *excluded patterns*.

---

## 11. Path canonicalisation does not resolve symlinks

**Severity: Medium · Status: PARTIAL as of `c315f8c`**

`realCanonicalPath`/`isRealPathInside` now exist in `@local-agent/paths` and are used by
`file-index`'s root check (issue #1), so **the indexer half is closed**: a junction cannot
redirect an index run out of a configured root.

**Still open: `file-broker`.** Its `evaluateAccess` continues to use the lexical
`isPathInside`, so `GET /read` and `POST /write` remain escapable through a junction planted
inside a configured root — the original finding below applies unchanged to the broker.
Closing it means making `evaluateAccess` async and awaiting at its three call sites in
`file-broker/src/server.ts` plus the test assertion. That was deliberately left out of the
issue #1 change, which was scoped to the indexer and should not alter broker behaviour.

The original finding, which still describes the broker:

**Where:** [local-agent/paths/src/paths.ts:16-24](local-agent/paths/src/paths.ts:16) — the
lexical pair that `file-broker`'s `evaluateAccess` still calls.

```ts
export function canonicalPath(inputPath: string): string {
  return path.resolve(inputPath).toLowerCase().replace(/\//g, "\\");
}
```

`path.resolve` is purely lexical — it normalises `..` and separators but never touches the
filesystem. `isPathInside` therefore compares *strings*, not real locations.

Consequences on Windows:

- A directory symlink or junction inside `C:\Projects` pointing at `C:\Users\Maciej\.ssh`
  passes `isPathInside` and defeats `deniedPathFragments`, because the denied fragment
  never appears in the lexical path. Junctions need no elevation to create, and the agent
  itself can create one through the `powershell` tool.
- 8.3 short names (`C:\PROGRA~1`) canonicalise to a different string than their long form,
  so a denied fragment can be sidestepped by spelling.
- Case-insensitive lowercasing is correct for NTFS defaults but wrong for volumes with
  case sensitivity enabled (WSL interop), where two distinct files collapse to one key.

**Proposed fix.** Resolve the real path before comparing, and make the check `async`:

```ts
import { realpath } from "node:fs/promises";

export async function canonicalPath(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  try {
    return (await realpath.native(resolved)).toLowerCase();
  } catch (e) {
    // Not-yet-existing target (a create): canonicalise the nearest existing ancestor and
    // re-append the tail, so a write through a symlinked parent is still caught.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved.toLowerCase();
    return path.join(await canonicalPath(parent), path.basename(resolved)).toLowerCase();
  }
}
```

`realpath.native` also expands 8.3 short names, fixing that case at the same time. Update
`evaluateAccess` and its callers to await. Add tests covering a junction that escapes a
root and a short-name spelling of a denied path.

---

## 12. The indexer walks into excluded directories and aborts on a single unreadable one

**Severity: Medium**

**Where:** [local-agent/file-index/src/indexer.ts:35-42](local-agent/file-index/src/indexer.ts:35) and
[indexer.ts:124-137](local-agent/file-index/src/indexer.ts:124)

```ts
async function* walk(root: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });   // unguarded
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) { yield* walk(fullPath); continue; }    // no exclusion check
    yield fullPath;
  }
}
```

**a. Exclusions are applied per *file*, after the walk has already descended.** With
`**\node_modules\**` configured, `walk` still recurses through every directory in every
`node_modules` tree, stats nothing but yields every path, and `isExcluded` runs a
`minimatch` per file. Over a root like `C:\Projects`, that is the dominant cost of an
index run — and it is pure waste, since the entire subtree is excluded by definition.

**b. One unreadable directory aborts the whole run.** `fs.readdir` is not wrapped. A
single `EPERM` or `EBUSY` anywhere under the root — a locked build directory, a
protected system folder, a file held by another process — rejects out of the generator,
propagates through `indexRoot`, and fails the entire `POST /index` request. Nothing is
persisted, so a partial index is not even retained. On a broad root this makes indexing
unreliable rather than merely slow.

Note `walk` also treats a directory symlink as a file (`entry.isDirectory()` is false for
a symlink), yielding it and letting the later `fs.stat` filter it out — correct by
accident, and worth a comment so it is not "fixed" into an infinite loop later.

> **Since `c315f8c`:** that last point is done — `walk` now documents the symlink behaviour
> as load-bearing, because issue #1's root authorisation depends on it (a followed junction
> would escape the authorised subtree mid-walk). **(a)** and **(b)** are unchanged and still
> the substance of this issue. One knock-on: `evaluateAccess` now runs per file, so an
> excluded `node_modules` tree costs a policy call per file on top of the `minimatch` —
> the directory-level pruning in (a) is worth marginally more than it was.

**Proposed fix.** Prune at the directory level and tolerate per-directory failures:

```ts
async function* walk(root: string, base: string, patterns: string[],
                     skipped: IndexStore["skipped"]): AsyncGenerator<string> {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (e) {
    skipped.push({ path: root, reason: `unreadable-directory: ${(e as Error).message}` });
    return;                                     // skip this subtree, keep indexing
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      // Prune before descending — an excluded subtree is never walked.
      if (isExcluded(path.relative(base, fullPath), patterns)) {
        skipped.push({ path: fullPath, reason: "excluded-pattern" });
        continue;
      }
      yield* walk(fullPath, base, patterns, skipped);
      continue;
    }
    yield fullPath;
  }
}
```

The unreadable directories now surface in the run's `skipped` list, which the existing
`summarize()` already reports, so the failure is visible rather than fatal.

---

## 13. Indexing a second root discards the first root's skip list

**Severity: Low**

**Where:** [local-agent/file-index/src/indexer.ts:99-108](local-agent/file-index/src/indexer.ts:99)

```ts
const outsideRoot = existing.chunks.filter(chunk => !isWithinRoot(chunk.canonicalPath, rootCanonical));
return {
  version: 1,
  updatedAt: new Date().toISOString(),
  chunks: [...outsideRoot, ...nextChunks],   // merged across roots
  skipped                                     // replaced wholesale
};
```

`chunks` correctly preserves entries from other roots; `skipped` does not. Indexing
`C:\Projects` and then `C:\Users\Maciej\Documents` leaves a store whose chunks span both
roots but whose skip list describes only Documents. `summarize()` reports that skip count
via `GET /health`, so the diagnostic silently under-reports — which matters most for the
`possible-secret` entries, the ones an operator would actually want to audit.

**Proposed fix.** Partition `skipped` on the same predicate used for chunks:

```ts
const outsideRootSkipped = existing.skipped.filter(entry =>
  !isWithinRoot(normalizeWindowsPath(entry.path).canonicalPath, rootCanonical));

return {
  version: 1,
  updatedAt: new Date().toISOString(),
  chunks:  [...outsideRoot, ...nextChunks],
  skipped: [...outsideRootSkipped, ...skipped],
};
```

---

# Refactoring

## 14. `app.js` is a 5,618-line flat script with ten duplicated list/detail panels

**Severity: Refactor (largest single maintainability item)**

**Where:** [local-agent/matbot/packages/plugins/frontend/web/static/app.js](local-agent/matbot/packages/plugins/frontend/web/static/app.js) (5,618 lines),
[static/index.html](local-agent/matbot/packages/plugins/frontend/web/static/index.html) (4,686 lines)

One file, no modules, ~180 top-level functions in a single scope, disambiguated only by
name prefix (`architecture*`, `workflowOps*`, `memoryBrowser*`, `evaluation*`). Together
with `index.html` it is 10,304 lines — roughly a fifth of the repository — in two files.

The duplication is systematic. Ten master/detail panels each hand-roll the same four
functions:

```
renderArchitectureSourceList          / …SourceDetail          / selectArchitectureSource
renderArchitectureApprovalList        / …ApprovalDetail        / selectArchitectureApproval
renderArchitectureEvaluationTraceList / …TraceDetail           / selectArchitectureEvaluationTrace
renderArchitectureEvaluationSuiteList / …SuiteDetail
renderArchitectureGraphList           / …GraphDetail           / selectArchitectureGraphEntity
renderArchitectureReviewList          / …ReviewDetail
renderWorkflowOpsLibraryList          / …LibraryDetail         / selectWorkflowOpsCompilation
renderWorkflowOpsRunList              / …RunDetail             / selectWorkflowOpsRun
renderWorkflowOpsShadowList           / …ShadowDetail          / selectWorkflowOpsShadowRun
renderMemoryBrowserList               / …Detail                / selectMemoryBrowserMemory
```

Each pair repeats the same skeleton: clear the container, handle the empty case, map items
to `architectureItemButton(...)`, track a `selectedId`, wire a click handler, re-render the
detail pane. The DOM-builder helpers (`architectureCard`, `architectureTable`,
`architectureBadge`, `architectureKeyValues`, `architectureEmpty`, …) already exist and are
good — they are just invoked from ten near-identical call sites.

The cost is concrete: a change to selection behaviour, keyboard handling, empty-state copy,
or error display must be made ten times, and the panels have already drifted (some show a
status line on failure, some do not).

**Proposed fix — incremental, no framework.**

1. **Split by panel into ES modules**, served from the existing static-route table.
   `app.js` becomes a thin entry that imports them:
   ```
   static/
     app.js                 — bootstrap, transport wiring, event demux
     lib/markdown.js        — md(), escHtml() (issue #3 lives here)
     lib/dom.js             — card/table/badge/keyValues builders
     lib/master-detail.js   — the shared panel controller
     panels/sources.js  panels/workflow-ops.js  panels/evaluation.js
     panels/graph.js    panels/reviews.js       panels/memory.js
   ```
   Requires only changing the `<script>` tag to `type="module"`. Do this first — it is
   mechanical and makes the rest reviewable.

2. **Extract one `masterDetail` controller** and express each panel as configuration:
   ```js
   // lib/master-detail.js
   export function masterDetail({ listEl, detailEl, statusEl, load, keyOf, renderItem, renderDetail, emptyText }) {
     let items = [], selectedId = null;
     const setStatus = (text, isError) => { /* one implementation */ };
     async function refresh(force) { /* one load/error/empty path */ }
     function select(id) { selectedId = id; draw(); }
     function draw() { /* one list render + one detail render */ }
     return { refresh, select, get selected() { return items.find(i => keyOf(i) === selectedId); } };
   }
   ```
   ```js
   // panels/sources.js
   export const sourcesPanel = masterDetail({
     listEl: byId('sourceList'), detailEl: byId('sourceDetail'), statusEl: byId('sourceStatus'),
     load: () => callTool('source_registry', { action: 'list' }),
     keyOf: source => source.id,
     renderItem: source => ({ title: source.name, meta: source.kind, badge: source.health }),
     renderDetail: source => [architectureCard(source.name, …), architectureTable(…)],
     emptyText: 'No sources registered.',
   });
   ```
   Ten panels collapse to ten config objects — a realistic 1,500–2,000 line reduction with
   uniform behaviour as a side effect.

3. **Split `index.html`** the same way: move the per-panel markup into `<template>`
   elements, and lift the inline `<style>` block into a served `app.css`.

Sequence it panel by panel, keeping the Playwright suite
(`tests/webui/matbot-webui.spec.mjs`) green at each step — it is the only safety net for
this file, and it should be run after every extraction.

---

## 15. `spawnAndStream` is duplicated across `bash`/`powershell` and has diverged

**Severity: Refactor**

**Where:** `packages/plugins/bash/src/index.ts:24-97` and
`packages/plugins/powershell/src/index.ts:30-119`

A `sed`-normalised diff of the two files shows the ~70-line `spawnAndStream` — the
callback-to-`AsyncIterable` bridge, the queue, the wakeup latch, the abort listener, the
timeout, all four child event handlers — is one function copied twice.

They are no longer the same function. `powershell` gained a `finalized` guard, a `done`
guard, a `finish()` teardown, and a `child.kill()` in `return()`. `bash` got none of
them, which is issue #7. This is the concrete cost of the copy: a bug was found and fixed
in one instance, and the other still ships it.

`CLAUDE.md` anticipates exactly this: *"a small, stable, already-shared utility (e.g. an
`AsyncIterable` broadcaster) belongs in `plugin-api` once a second package needs it, not
copy-pasted."* The second package exists.

**Proposed fix.** Extract to a shared module — `packages/core/plugin-api/src/spawn-stream.ts`
is the natural home per that guidance, since both plugins already depend on `plugin-api`:

```ts
export interface SpawnStreamOptions {
  cwd?: string;
  env: Record<string, string>;
  timeout?: number;
  signal: AbortSignal;
  cleanup?: () => Promise<void>;    // powershell's temp-file removal; bash passes nothing
}

export function spawnAndStream(command: string, args: string[], opts: SpawnStreamOptions): AsyncIterable<ToolEvent>;
```

Take the `powershell` implementation as the base (it has the fixes), make `cleanup`
optional, and add the timeout reporting from issue #7. Both plugins shrink to
input-parsing plus a single call. This is the highest-value extraction in the repo: it is
~70 lines, it is provably identical in intent, and it fixes a live bug as a side effect.

---

## 16. Path normalisation is duplicated across `file-broker` and `file-index`

**Severity: Refactor · Status: FIXED in `c315f8c`**

`@local-agent/paths` now holds the single copy of `canonicalPath`, `isPathInside`,
`normalizeWindowsPath`, and the workspace/security policy engine. All three duplicated
modules are deleted (`file-broker/src/path-normalization.ts`, `file-broker/src/policy.ts`,
`file-index/src/path-normalization.ts`), and the third containment predicate that had been
inlined as `isWithinRoot` in the indexer is no longer a separate implementation. Git
recorded the policy move as a rename at 96% similarity, so the history stays legible.

Two deliberate carve-outs:

- **The package name now undersells its contents.** It carries the policy engine as well as
  path primitives; `@local-agent/workspace-policy` would be more honest if a rename is wanted.
- **`isExcluded` was left in `file-index/src/indexer.ts`** rather than moved, because it
  still has exactly one consumer — moving it now would be the speculative abstraction
  `CLAUDE.md` warns against. It moves when issue #10 gives it a second.

The original finding, for reference. **The paths below no longer exist** — they describe the
state at review time, before the extraction:

**Where:** `local-agent/file-broker/src/path-normalization.ts` and
`local-agent/file-index/src/path-normalization.ts` (both deleted)

Two files with the same name in two packages, implementing the same lowercase-and-
backslash canonicalisation:

```ts
// file-broker
return path.resolve(inputPath).toLowerCase().replace(/\//g, "\\");
// file-index
const canonicalPath = nativePath.toLowerCase().replace(/\//g, "\\");
```

Plus a third containment predicate inlined in the indexer:

```ts
// file-index/src/indexer.ts:111
function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}\\`);
}
```
which is `isPathInside` from `file-broker/src/path-normalization.ts:7`, re-derived.

Three implementations of one security-relevant predicate is exactly how issue #11 will
get fixed in one place and remain broken in the other two — and issue #1's fix needs this
predicate in a third package.

**Proposed fix.** Add `local-agent/paths` as a workspace package, mirroring the existing
`@local-agent/http-utils` (which is already shared by both services and has its own test —
`"shared HTTP JSON helpers validate content type, shape, and body size"` — so the pattern
and its test conventions are established):

```
local-agent/paths/
  package.json          — name: "@local-agent/paths"
  src/index.ts          — canonicalPath, isPathInside, normalizeWindowsPath, isExcluded
```

Register it in the root `package.json` `workspaces` array, add it to both services'
dependencies, delete the three copies. The symlink fix (issue #11) and the shared
exclusion predicate (issue #10) then land once, and `file-index` gains the root check
(issue #1) by importing rather than reimplementing.

---

## 17. `readJson` is duplicated inside the `workspace-rag` package

**Severity: Refactor**

**Where:** [workspace-rag/src/index.ts:570-576](local-agent/matbot/packages/plugins/workspace-rag/src/index.ts:570) and
[workspace-rag/src/storage.ts:171-177](local-agent/matbot/packages/plugins/workspace-rag/src/storage.ts:171)

Byte-identical `readJson<T>` in two files of the *same package*, alongside two
near-identical writers (`writeJson` pretty-prints, `writeCompactJson` does not). No import
boundary justifies this — `storage.ts` and `index.ts` are siblings.

**Proposed fix.** Move both into `workspace-rag/src/json-file.ts` and import from each,
applying the atomic-write and quarantine fixes from issue #8 once:

```ts
// src/json-file.ts
export async function readJson<T>(filePath: string, fallback: T): Promise<T> { … }
export async function writeJson(filePath: string, value: unknown, opts?: { pretty?: boolean }): Promise<void> { … }
```

`writeCompactJson(p, v)` becomes `writeJson(p, v)`; `writeJson(p, v)` becomes
`writeJson(p, v, { pretty: true })`.

---

## 18. Registry lookups use `as never` casts that defeat the typed service registry

**Severity: Refactor**

**Where:** [frontend/web/src/plugin.ts:64, 77, 78](local-agent/matbot/packages/plugins/frontend/web/src/plugin.ts:64)

```ts
const workspaceManager = services.get?.('WorkspaceManager' as never) as WorkspaceManager | undefined;
workspaceRagManager: () => services.get?.('WorkspaceRagManager' as never) as WorkspaceRagManager | undefined,
sessionTitler:       () => services.get?.('SessionTitler' as never) as SessionTitler | undefined,
```

The double cast — `as never` to force the key past `keyof MatbotServices`, then `as T` to
reassert the value type — turns off type checking in both directions. A typo in the key
string compiles, and so does a mismatched value type; both surface as `undefined` at
runtime, which the optional-chaining call sites will silently swallow.

`CLAUDE.md` specifies the intended mechanism, and **this same file already uses it
correctly** for `WebPrincipalResolver` — `server.ts:89-94` declares the augmentation, and
`plugin.ts:80` reads `services.WebPrincipalResolver` as a plain typed member with no cast.
Three services in the same object literal use the escape hatch instead.

**Proposed fix.** Augment `MatbotServices` for each, in the module that owns the interface:

```ts
// server.ts, next to the existing WebPrincipalResolver augmentation
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    WorkspaceManager?:    WorkspaceManager;
    WorkspaceRagManager?: WorkspaceRagManager;
    SessionTitler?:       SessionTitler;
  }
}
```

Call sites become the member reads the design calls for:

```ts
const workspaceManager = services.WorkspaceManager;
workspaceRagManager: () => services.WorkspaceRagManager,
sessionTitler:       () => services.SessionTitler,
```

The structural interfaces are already declared locally in `server.ts` precisely so
`frontend-web` carries no dependency on the optional plugins, so the augmentation costs
nothing. Sweep for other `as never` registry lookups at the same time:

```bash
grep -rn "get?.('.*' as never)" --include=*.ts local-agent/matbot/packages
```

---

## 19. TypeScript strictness is split between the two halves of the repo

**Severity: Refactor**

**Where:** [tsconfig.base.json](tsconfig.base.json) vs `local-agent/matbot/tsconfig.base.json`

| Flag | root (`local-agent/*` services) | `local-agent/matbot/*` |
|---|---|---|
| `strict` | ✅ | ✅ |
| `exactOptionalPropertyTypes` | ❌ | ✅ |
| `noUncheckedIndexedAccess` | ❌ | ✅ |
| `verbatimModuleSyntax` | ❌ | ✅ |
| `skipLibCheck` | `true` | `false` |
| `target` | ES2022 | ES2024 |

`file-index`, `file-broker`, `http-utils`, and now `paths` inherit the weaker root config.
`CLAUDE.md` documents the strict set as a hard constraint (*"Strict TypeScript. `strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`"*)
without scoping it to the matbot subtree.

The gap is visible in the code. `normalizeWindowsPath`
([local-agent/paths/src/paths.ts:26-38](local-agent/paths/src/paths.ts:26)) returns
`relativePath: undefined` against a `relativePath?: string` field — which
`exactOptionalPropertyTypes` rejects, and which the matbot half works around with the
conditional-spread idiom throughout. `config.roots[0]?.path`
([file-index/src/index-root.ts:12](local-agent/file-index/src/index-root.ts:12)) is
optional-chained by hand, which `noUncheckedIndexedAccess` would have required rather than
left to discipline.

These are the packages handling untrusted paths — the weaker settings are inverted
relative to risk.

> **Since `c315f8c`:** unchanged, and now slightly worse in principle. The new
> `@local-agent/paths` package extends the same weak root config, so the containment
> predicate that authorises index roots — the single most security-sensitive function in
> the `local-agent/*` half — is compiled without `noUncheckedIndexedAccess` or
> `exactOptionalPropertyTypes`. The two examples above both now live in code that issue #1
> introduced or moved, so aligning the config is a smaller job than it was: the fallout is
> concentrated in one package.

**Proposed fix.** Align the root config, then fix the fallout in one pass:

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "types": ["node"]
  }
}
```

Expect a small number of errors, now concentrated in `local-agent/paths/src/paths.ts` and
the indexer's array indexing. `skipLibCheck: true` can stay at the root if third-party
`.d.ts` files prove noisy; the other three flags are the ones that catch real defects.

---

## 20. Dead code — commented-out routes and redundant version bumps

**Severity: Cleanup**

**a. Commented-out route table.** [frontend/web/src/server.ts:548-551](local-agent/matbot/packages/plugins/frontend/web/src/server.ts:548)
— four commented lines of the previous routing approach, immediately below the table that
replaced them. Delete; git has it.

**b. Redundant `version` assignment.** `workflow-governance/src/index.ts` lines
[1150](local-agent/matbot/packages/plugins/workflow-governance/src/index.ts:1150) and
[1217](local-agent/matbot/packages/plugins/workflow-governance/src/index.ts:1217) set
`version: randomUUID()` on the object passed to `updateRun`, which overwrites it
unconditionally one line later:
```ts
private async updateRun(run: WorkflowRun): Promise<WorkflowRun> {
  const updated = { ...run, version: randomUUID() };
```
`rejectRun` (line 1186) correctly omits it. Drop the two redundant assignments — they
suggest the caller controls versioning when it does not, which is precisely the confusion
behind issue #5.

**c. Misleading startup logs.** `file-broker` and `file-index` print
`listening on http://localhost:PORT` while bound to every interface (issue #2). Log
`server.address()`.

---

# Quality

## 21. Secret detection discards whole files on broad heuristics

**Severity: Quality**

**Where:** [local-agent/file-index/src/indexer.ts:144-153](local-agent/file-index/src/indexer.ts:144)

```ts
const patterns = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /password\s*[:=]\s*["']?[^"'\s]+/i,
  /api[_-]?key\s*[:=]\s*["']?[^"'\s]+/i
];
return patterns.some(pattern => pattern.test(content));
```

A single match excludes the **entire file** from the index. The last two patterns match
ordinary source and documentation: a TypeScript interface with `password: string`, a
config sample with `apiKey: "REPLACE_ME"`, a doc line reading `api_key = your key here`.
In this repository, `docs/configuration.md` and the provider config examples in
`CLAUDE.md` would both trip it.

The failure is silent from the user's side — the file lands in `skipped` with reason
`possible-secret`, but the operator experiences it as "search cannot find something I know
is there", with no obvious cause. This is the worst shape for a heuristic: high false
positive rate, whole-file blast radius, invisible effect.

**Proposed fix.**

1. **Redact the matching chunk, don't drop the file.** Chunking already happens
   downstream; move the check after `chunkText` and replace matched spans with
   `[redacted]`, keeping the rest of the file searchable.
2. **Tighten the value patterns** to require secret-shaped values rather than any
   non-whitespace — e.g. at least 16 characters of base64/hex, and exclude obvious
   placeholders (`REPLACE_ME`, `your-key-here`, `xxx`, `${...}`, `<...>`).
3. **Report it.** Include the reason and the matched pattern name in the `/search`
   response metadata when a file was partly redacted, so the gap is visible.
4. Keep the `sk-` and `PRIVATE KEY` patterns as whole-file exclusions — those are
   high-precision and the conservative behaviour is right for them.

> **Since `c315f8c`:** unchanged, but no longer load-bearing for the highest-risk files.
> `evaluateAccess` now excludes high-risk extensions (`.env`, `.pem`, `.key`) by extension
> before content is ever read, so those no longer depend on this heuristic catching them —
> which it did not, for `TOKEN=` and `DATABASE_URL=` shapes. `looksLikeSecret` is now
> explicitly a content backstop for ordinary files, and the false-positive problem described
> above is the whole of what remains. That makes the "redact the chunk, don't drop the file"
> fix strictly safer to apply than it was at review time.

---

## 22. Index search ranks by term presence and over-weights path matches

**Severity: Quality**

**Where:** [local-agent/file-index/src/search.ts:41-72](local-agent/file-index/src/search.ts:41)

```ts
for (const term of terms) {
  if (content.includes(term)) score += 2;
  if (pathText.includes(term)) score += 3;
}
```

Three properties worth noting:

- **Presence, not frequency.** A chunk mentioning a term once scores the same as one
  built around it. There is no term-frequency or document-frequency component, so common
  words contribute as much as rare ones.
- **Path outranks content.** A path match is worth more than a content match, so every
  chunk of a file whose *name* contains the query outranks the chunk that actually answers
  it — and a file with many chunks floods the result set, since there is no per-file cap.
- **Substring matching.** `content.includes(term)` matches inside words: searching `id`
  hits `provider`, `valid`, `hidden`.

`searchChunks` is also a full linear scan over every chunk in the store on each query, with
the whole index resident in memory (`loadStore` parses one JSON file). Fine at current
scale; it degrades linearly with the size of `C:\Projects`.

**Proposed fix.** Keep it simple and dependency-free, but make ranking defensible:

1. Score with BM25 over the existing chunks — it needs only document frequency per term
   and chunk length, both computable at index time and storable alongside the chunks.
2. Match on tokenised terms with word boundaries rather than `String.includes`, reusing
   the existing `tokenize()` on chunk content at index time.
3. Reduce the path weight below the content weight, and cap results per file (e.g. best 2
   chunks) so one large file cannot fill the response.
4. Precompute an inverted index (`term → chunk ids`) in `IndexStore` at save time to
   replace the full scan. Bump `IndexStore.version` to `2` and rebuild on load when the
   stored version is older — `loadStore` already carries the field but never checks it,
   which is itself worth fixing.

---

## 23. No unit coverage for the HTTP surface of the web server

**Severity: Quality**

**Where:** `tests/` (20 tests, all passing) vs
[frontend/web/src/server.ts](local-agent/matbot/packages/plugins/frontend/web/src/server.ts) (1,154 lines)

`server.ts` is the process's main attack surface and its most concurrency-dense code —
SSE fan-out, the busy-tracker handshake, pending-prompt lifecycle, CAS retry, workspace
delete readiness, direct tool invocation. It has no Node-level test. The only coverage is
`tests/webui/matbot-webui.spec.mjs`, which drives it through a real browser: slow, and
unable to reach the paths that matter here (concurrent submits, abandoned SSE consumers,
CAS contention, malformed `$context` envelopes).

Every issue found in this file — the unawaited static route (#6), the `*` CORS default
(#2) — is in a branch no test exercises. The tests that do exist are good and follow a
consistent runtime-flow pattern; the gap is specifically the HTTP layer.

**Proposed fix.** Add `tests/frontend-web-server.test.mjs` following the existing
`*-runtime.mjs` conventions, constructing `createWebServer` with in-memory stubs
(`Store`, `SessionRunner`, `ToolRegistry`) and listening on port 0. Priority cases:

- `GET /` and `GET /matbot.html` when the backing file is absent → 404, not a hang (#6)
- `POST /sessions/:id/submit` twice concurrently → one busy tracker, one `idle`, correct
  `busy` transitions
- SSE consumer disconnecting with a prompt parked → prompt resolves, turn does not hang
- `POST /sessions/:id/prompt` with `cancel: true` → `PromptCancelledError`, queue intact
- `POST /tools/:name` with a malformed `$context` → 400; unknown `sessionId` → 404
- `DELETE /workspaces/:id` for the active workspace → 400; for a RAG-locked one → 409
- `appendSessionMessages` under a forced CAS conflict → retries, then falls back to `set`

These are pure-function-adjacent given the dependency-injection shape `createWebServer`
already has; no browser required.

---

# Suggested sequencing

Grouped so related fixes land together and each group leaves the tree green.

**Done (`c315f8c`):** #1 (arbitrary index root), #16 (shared path package), #11 for
file-index only. This was the first half of the original group 1.

| Order | Group | Issues | Rationale |
|---|---|---|---|
| 1 | Close the network exposure | #2 | Now the highest-severity open item, and the one that made #1 remotely reachable. Small diff, independent of everything else. |
| 2 | Contain untrusted content | #3, #9 | Vendoring the assets unblocks the CSP; do them together. |
| 3 | Lock down tool execution | #4, #7, #15 | The `spawnAndStream` extraction fixes #7 as a side effect. |
| 4 | Correctness in persistence | #5, #8, #13 | CAS and atomic writes; both have in-repo reference implementations. |
| 5 | Finish the shared path package | #11 (broker half), #10, #12, #19 | The package exists; what remains is migrating `file-broker` to the real-path predicate, enforcing exclusions, pruning the walk, and raising strictness. All four now touch one package. |
| 6 | Front-end structure | #14 | Largest effort; run the Playwright suite after each panel extraction. |
| 7 | Polish | #6, #17, #18, #20, #21, #22, #23 | Independent; #23 is worth pulling earlier if #14 is scheduled. |

**One operational task is not a code change and is still outstanding:** purge
`local-agent/file-index/data/index.json` on any machine whose `/index` may have been
pointed at a sensitive tree, then reindex. The fix in #1 stops new leaks; it does not
retract chunks already in the store.
