# Cortex Codebase Hardening Review

Date: 2026-08-26
Scope: full working tree review of `local-agent/matbot/packages` (core + plugins), `local-agent/file-broker`, `local-agent/file-index`, `local-agent/http-utils`, `local-agent/docker/mem0`, and `scripts/*.ps1`. All findings below were verified against actual source; paths are repo-relative.

---

## Implementation status

Updated as fixes land. Baseline before work: `npm test` → 161 tests / 155 pass / 0 fail / 6 skip.

**Final state after implementation: `npm test` → 236 tests / 230 pass / 0 fail / 6 skip (skips are pre-existing environment-gated Postgres/CUDA/large-buffer cases). Matbot workspace typecheck (`pnpm -r run typecheck`) clean across all packages. Matbot CLI tests: 5/5 pass. Playwright WebUI suite: 144 passed / 118 skipped (project-configured) / 0 failed. New regression tests added: `tests/core-hardening.test.mjs`, `tests/config-hardening.test.mjs`, `tests/services-hardening.test.mjs`, `tests/webui-server-hardening.test.mjs`, `tests/executors-hardening.test.mjs`, `tests/workspace-rag-hardening.test.mjs`, `tests/storage-hardening.test.mjs`, `tests/broker-hardening.test.mjs`, `tests/final-hardening.test.mjs`, plus extensions to existing secret-detection and powershell-runtime tests.**

| Item | Status | Implementation notes |
| --- | --- | --- |
| C1 | ✅ DONE | WebUI server: loopback Host validation (403), optional timing-safe `x-cortex-token` on mutating routes via `CORTEX_WEBUI_TOKEN`, CORS reflects Origin only for loopback allowlist origins (foreign/no-origin gets no ACAO header), deny-by-default shell-tool list (`bash`/`powershell`/`docker-bash`, incl. percent-encoding evasion) returns 403 on `/tools/:name` and `/stream/tools/:name` unless `CORTEX_WEBUI_ALLOW_SHELL_TOOLS=1`. Binding was already loopback (`WEB_LISTEN_HOST`). Tests: `tests/webui-server-hardening.test.mjs` (9 cases); harness compatibility confirmed (specs use the fake harness server, not this one). |
| C2 | ✅ DONE | Both servers bind `127.0.0.1` (env-overridable); shared `assertLoopbackRequest` (403 on foreign Host) and optional timing-safe token check (`x-cortex-token`, enabled via `CORTEX_FILE_BROKER_TOKEN` / `CORTEX_FILE_INDEX_TOKEN`, `/health` exempt) in http-utils, reused by both servers. Tests: `tests/services-hardening.test.mjs`. |
| C3 | ✅ DONE | bash + powershell executors build a minimal env from an explicit case-insensitive `SAFE_ENV_KEYS` allowlist (PATH/HOME/TEMP/SYSTEMROOT/COMSPEC/etc.); `process.env` never spread; canary-secret non-leak tested live. |
| C4 | ✅ DONE | All six published ports prefixed `127.0.0.1:`; compose YAML re-parsed clean. |
| C5 | ✅ DONE | Empty terms skipped before the `indexOf` scan loop; regression test added (`tests/core-hardening.test.mjs`). |
| H1 | ✅ DONE | Toolcall-hook abort path persists session via `store.set` before yielding `aborted`; test asserts persisted assistant turn. |
| H2 | ✅ DONE | Pump prelude awaits moved inside guarded region; failures emit `error` event; tested with failing store + unhandled-rejection trap. |
| H3 | ✅ DONE | New `v2/regex-evaluator.ts`: strengthened group-nesting validator (rejects `((a+)b)+c`, `(?:x+)*`, `(a|aa)+$` class patterns) applied to BOTH lanes; memory lane executes matches in a worker_threads Worker with a 250 ms hard budget → terminate + "time budget" error. Tested: catastrophic pattern terminates ~280 ms, no hang. |
| H4 | ✅ DONE | New `openVerified()` in file-writer: lstat rejects final-component symlinks/junctions/reparse points, open+fstat swap check, post-open realpath re-containment vs workspace roots (403 on failure); read streams and write's previous-content read go through the verified handle; atomic temp+rename preserves mitigation. Residual Windows race documented honestly (no reliable O_NOFOLLOW). Tested at HTTP level with junction escapes + unit level. |
| H5 | ✅ DONE | Both local executors confine LLM-supplied cwd via `confineWorkspaceCwd(requested, ctx.workdir)` — resolve + base-prefix containment; escapes rejected with descriptive tool error before spawn; auto-create only inside confined root. Sibling-prefix tricks covered by tests. |
| H6 | ◐ PARTIAL | URL pinned to v2.12.0. WinSW publishes no release hashes (verified), so SHA256 verification fails closed: install requires `-ExpectedSha256` or `CORTEX_WINSW_SHA256`, verifies before moving into place. |
| H7 | ✅ DONE | sqlite put fails fast once configurable `maxBytes` (default 256 MiB) is crossed while streaming (no row written); versions now content-addressed `sha256:size` persisted via ALTER TABLE migration — equal-size distinct writes get distinct CAS versions; legacy rows fall back until next write. Stale-version rejection tested. |
| H8 | ✅ DONE | Pre-aborted signal checks added everywhere the pattern existed: sqlite `watch` (returns promptly), workspace-rag late-interaction search + retrieval rerank (now use `AbortSignal.any([caller, AbortSignal.timeout(n)])` like search-backend). Tested for prompt return. |
| H9 | ✅ DONE | CAS bypass fallback removed from appendSessionMessages: 10 attempts with randomized backoff, then exported `SessionConflictError` → HTTP 409. Test proves zero message loss under contention and zero unconditional `store.set` calls. |
| M1 | ✅ DONE | Teardown results paired with their plugin via teardown-order array; misattribution regression-tested. |
| M2 | ✅ DONE | Unique monotonic CAS versions (timestamp + same-ms sequence counter); retries bounded at 8 with backoff, deterministic rejection on exhaustion. |
| M3 | ✅ DONE | Quote-aware comment scanner (`stripComment`); quoted `#` preserved (double/single/trailing-comment cases tested). |
| M4 | ✅ DONE | Sequence items with mappings recursively parsed as records; `\|`/`>` block scalars accept chomping indicators (+/-, explicit indent accepted). Limitation: tokenizer drops blank lines so keep-chomping cannot preserve trailing blank lines beyond final newline (documented in file header). |
| M5 | ✅ DONE | Browser import failures route through the same `failLoad` funnel as node failures; `onLoadError: 'throw'` honored on both platforms. |
| M6 | ✅ DONE | `scrubSpanValue` helper scrubs span `input`/`result` attributes (strings direct, objects via JSON round-trip); secret redaction asserted in spans. |
| M7 | ✅ DONE | `Promise.allSettled` with warned-and-skipped rejections; throwing contributor no longer fails the turn. |
| M8 | ◐ PARTIAL | Timer cleared in `finally` (leak fixed). Event-emission order intentionally unchanged to avoid breaking consumers. |
| M9 | ✅ DONE | Optional `FetchRetryOptions.timeoutMs` overall budget; per-attempt `AbortSignal.timeout` slices composed with caller signal via `AbortSignal.any`; backoff capped to remaining budget; backward-compatible signature. Hung-connection timeout tested against never-responding server. |
| M10 | ✅ DONE | Scrub values sorted by descending length; overlapping-secret redaction order-independent (tested both insertion orders). |
| M11 | ✅ DONE | Evidence fetch uses the re-authorized document object hash (`authorizedDocument.contentSha256`); dead branch + `contentHashFromObjectPath` removed; e2e evidence test passes. Manager-level lazy-worker AbortController aborted in `close()` before `repository.close()`; restart guard prevents post-close respawn; blocked-embed close test returns promptly. Evaluation k clamped to searched depth (min(k,25)) in metrics and persisted configuration. |
| M12 | ✅ DONE | Lazy batch failures logged via console.warn section-scoped; abort distinguished (silent rethrow on abort); stop-on-failure semantics preserved. |
| M13 | ✅ DONE | Rate limiter rolls back unused reservation when wait aborts (post-abort consumers not delayed — tested); pre-aborted signals throw immediately; large consumes split into ≤30 s slices. |
| M14–M18 | see notes | M15/M16 SKIPPED deliberately: require batching/schema-level changes (single-statement `reuseEmbeddings`, join restructuring) — higher-risk follow-up work. M17 PARTIAL: manager env reads centralized into config helpers; postgres env reads validated locally but not moved. M18 PARTIAL: startup-time opportunistic pruning of `retrieval_runs`/`regex_runs` older than `CORTEX_RAG_V2_AUDIT_RETENTION_DAYS` (default 30, 0 disables) — payload stripping not done. |
| M19 | ✅ DONE | Kept `'primary'` behavior (product default, tests depend on it); fixed the divergent JSDoc. |
| M20 | ✅ DONE | Pool/port/timeout env vars parsed via exported `positiveInteger` helper with sane fallbacks; NaN no longer reaches `PoolConfig`. |
| M21 | ✅ DONE | Object-store root gates `workspace.id` against `/^[A-Za-z0-9_-]{1,128}$/` with thrown config error before path join. |
| M22 | ✅ DONE | Standing `'error'` listener in `RagV2LineIndexWriter` constructor captures first error; surfaced from `add()`/`close()` instead of crashing the process; destroyed-stream close rejects (tested). |
| M23 | ✅ DONE | (folded into M11 row above) |
| M24 | ✅ DONE | Atomic write: same-dir temp file → fsync → rename over target, temp cleanup on failure; mirrors file-index pattern. Concurrency/no-residue tested. |
| M25 | ✅ DONE | Non-HttpError details logged server-side; generic `"Internal server error."` returned; HttpError messages pass through. |
| M26 | ✅ DONE | `requiredQuery` throws `HttpError(400, ...)`; missing param now maps to 400 (tested). |
| M27 | ✅ DONE | Batch size validated/clamped (>=1, fallback 128 + warning); process-wide lock serializes `model.encode`; 2M-char request cap returns 413. CUDA contract tests pass against fake sidecar. |
| M28 | ✅ DONE | Inline `Invoke-CheckedCommand` helpers; npm build and docker compose invocations throw on non-zero `$LASTEXITCODE` in start-local-agent.ps1 and run-service.ps1. All modified .ps1 pass `Parser::ParseFile` with zero errors. |
| M29 | ✅ DONE | `RandomNumberGenerator::GetInt32` replaces modulo bias; RNG disposed in try/finally; `.env` ACL restricted via `icacls /inheritance:r` + current-user grant. |
| M30 | ✅ DONE | Port-owner processes verified against name allowlist (node/powershell/pwsh/docker-compose) before `Stop-Process -Force`; foreign owners skipped with warning. |
| M31 | ✅ DONE | Neo4j healthcheck added (wget on container-local 7474); mem0-api depends on `service_healthy`. |
| M32 | ◐ PARTIAL | Upstream publishes no version tags (verified via Docker Hub API), so pinned multi-arch manifest digest `sha256:2fcf4bb…b7065c75` with sync-note comment. |
| M33 | ✅ DONE | `WebCryptoVault` doc rewritten to state plaintext in-memory reality and that AES-GCM/PBKDF2 helpers are standalone/unwired; `DriveVault` comment corrected likewise. No encryption implemented (documented decision needed separately). |
| M34 | ✅ DONE | Fresh TokenClient minted per `awaitToken` call with callback wired at init time; mutable shared callback slot removed; popup still opens synchronously in gesture. Typecheck-verified (browser-targeted). |
| M35 | ✅ DONE | Poll sleep uses `{ once:true }` + explicit listener removal; readdir failures warn-and-retry instead of permanent exit; skills dir created at startup. Injectable fs seams added; retry + creation tested. |
| M36 | ✅ DONE | Container provisioning serialized via exported `withContainerLock(name, fn)` promise-chain lock (failure-safe, self-cleaning); script piped via stdin (`docker exec -i … exec bash -s`) instead of `-e MATBOT_SCRIPT` argv env; PIDfile/group-kill preserved. |
| M37 | ✅ DONE | `readBody` destroys request and stops accumulating immediately on limit breach (connection torn down); tested oversized-body teardown. |
| M38 | ✅ DONE | OPFS `writeData` try/catch aborts writable on failure (no abandoned writables); named puts serialized per `(name, namespace)` via in-flight promise chain. Typecheck-verified (browser-targeted). |
| M39 | ✅ DONE | FilesystemStore plain `set` routed through the same per-id `withLock`; unlocked `writeDoc` primitive avoids cas self-deadlock; interleaving serialization tested; `tests/filesystem-store.test.mjs` green. |
| M40 | ✅ DONE | bash_config validates at boundary cognition-style: action enum, dns string-array, container-name charset ≤128, finite integer maxOutputBytes; unknown fields ignored; descriptive errors. 11 bad-shape rejections tested. |
| M41/M42 | ⏸ DEFERRED | http-tool SSRF documentation/response caps and SQLite query push-down are design-level changes requiring product decisions on trust boundaries and SQL feature scope; left as documented follow-ups. |
| L1 | ✅ DONE | SSE parser accepts `data:x` per spec (optional single space stripped). |
| L2 | ✅ DONE | Strict `/^(\d+)\.(\d+)$/` apiVersion parse; unparseable warns instead of silently passing NaN comparisons. |
| L3 | ✅ DONE | Tool collision resolver fails closed: only explicit Overwrite/Always-overwrite answers overwrite; unrecognized keeps existing tool. |
| L4 | ✅ DONE | LookupKnowledgeIndex backed by Map (O(1) id replace); `docs` is a getter returning readonly snapshot. |
| L5 | ✅ DONE | Collision warnings via `setProvider`; numeric-string coercion for known numeric params; object/array params warn-and-skip. |
| L6 | ✅ DONE | Sort comparator pairwise type-aware (numbers numeric, booleans false<true, strings codepoint; cross-type falls back to deterministic string order). |
| L7 | ✅ DONE | Loader single-log funnel; runner catches unknown-typed with instanceof Error stack/message/cause extraction (stack recorded as span `errorStack`). |
| L8 | ✅ DONE | Scoped hooks now a real `ScopedHookRegistry extends HookRegistry` (cast removed); settings legacy-doc migration typeof/array-guarded; loader `mod['default']` guarded before cast. |
| L9 | ✅ DONE | PL/pgSQL DO-block interpolations re-validated through exported `quoteIdentifier` gate at interpolation point; throws `Unsafe SQL identifier`; validator unit-tested. |
| L10 | ✅ DONE | Dead setext alternative removed from census detector. (Naive conflict heuristics left as-is — quality tuning, not hardening.) |
| L11 | ✅ DONE | (folded into H8 sidecar fix) |
| L12 | ⏸ SKIPPED | Evidence PK is `(run_id, evidence_id)` with fresh UUID run ids per search — cross-run overwrite does not occur in current code; changing scheme = audit-shape churn for no observed bug. |
| L13 | ✅ DONE | Backup retention keeps N most-recent per target (default 20, `CORTEX_FILE_BROKER_MAX_BACKUPS`), oldest pruned first; `CORTEX_FILE_BROKER_BACKUP_ROOT` override added. Retention isolation tested. |
| L14 | ✅ DONE | diff.ts rewritten as in-file LCS DP (Uint16 table, prefix/suffix trim) emitting unified hunks with 3 context lines; >5000 lines/side falls back to positional with note; API shape unchanged. Mid-file-insertion renders single hunk (tested). |
| L15 | ✅ DONE | Stale indexer comment corrected; FILE_LEVEL_SECRETS extended with AWS AKIA / GitHub ghp_ousr_ / Google AIza high-confidence patterns (+ near-miss negatives tested). |
| L16 | ✅ DONE | Config fingerprint uses bigint `mtimeNs` (NTFS 100ns granularity distinguishes same-millisecond edits); covered by existing config-cache reload test. |
| L17 | ✅ DONE | health-check.ps1 prints endpoint + status only; bodies behind `-ShowBody`/`SHOW_BODIES`. |
| L18 | ✅ DONE | Matbot launch no longer interpolates paths into `powershell -Command`; literal command + `-WorkingDirectory` + argument-array Start-Process; equivalence traced (same script/args/port/log locations). Parse-checked. |
| L19 | ✅ DONE | Abort listeners removed on completion/abort/pre-aborted construction. |
| L20 | ✅ DONE | PowerShell temp scripts in per-run mkdtemp dirs under `%TEMP%\matbot-powershell`; whole run dir removed via try/finally around execution (covers abort/timeout/abandonment). |
| L21 | ✅ DONE | Telegram principal id derived from immutable numeric sender id (`telegram-${from.id}`) in poll dispatch and handleMessage; display name kept as label only. |
| L22 | ✅ DONE | json-validation `pattern`: >1000-char patterns rejected pre-compile; compile fails closed as validation error; residual ReDoS risk documented (first-party schemas today). Hook-level tests. |
| L23 | ✅ DONE | `/indx.html` typo fixed; `/index.html` serves the UI. |
| L24 | ✅ DONE | OPFS delete logs per-file removal failures; webcrypto base64 chunked (0x8000) — ~300 KB roundtrip tested past old RangeError limit incl. wrong-passphrase rejection. |
| X1–X12 (cross-cutting) | ◐ PARTIAL | Fixed as side effects: X1 (CAS standardization via M2/H7/H9), X2 partially (allSettled in system-context), X3 partially (M40 boundary validation), X4 (lazy-worker logging), X7 (span scrubbing M6), X8 (named config constants in touched areas), X9 (boundary casts removed L8), X11 (env centralization M17/M20). Deferred as refactors: shared PowerShell module (X5), spawnAndStream consolidation (X6), console.* logging framework (X7 full), magic-number sweep beyond touched files (X8 full). These are churn-risk refactors better done incrementally. |

---

## Executive summary

The codebase is generally disciplined (strict TS config, parameterized SQL, RLS with role separation, boundary-validated query engine, careful symlink handling in `paths/`). However, the review surfaced a consistent theme: **the trust boundary is drawn in the wrong place for a localhost product**. Several HTTP surfaces bind to all interfaces or accept cross-origin requests without auth, so "localhost-only" assumptions do not hold. The second theme is **inconsistent application of the project's own rules**: CAS versions are implemented three different ways (one of which silently degrades to last-write-wins), error-isolation idioms diverge across packages, and validation is thorough in some tools while others cast untrusted input blindly.

### Top risks (fix first)

| # | Risk | Location |
| --- | --- | --- |
| 1 | Unauthenticated, CORS-open tool invocation over HTTP = remote code execution from any web page | `local-agent/matbot/packages/plugins/frontend/web/src/server.ts:1142` |
| 2 | File broker binds `0.0.0.0` with no auth; LAN + browser CSRF can read/write workspace files | `local-agent/file-broker/src/server.ts:86` |
| 3 | Full host env (incl. vault-resolved API keys) passed into LLM-initiated shell commands | `plugins/bash/src/index.ts:164`, `plugins/powershell/src/index.ts:209` |
| 4 | Docker stack publishes Postgres/Neo4j/mem0 on all host interfaces with weak generated passwords | `local-agent/docker/mem0/docker-compose.yml:30-100` |
| 5 | Empty search term hangs the process in an infinite loop (LLM-controlled input) | `packages/core/knowledge/src/lookup-knowledge-index.ts:56` |

---

## Critical

### C1. Unauthenticated, CORS-open RCE surface in the WebUI server
`local-agent/matbot/packages/plugins/frontend/web/src/server.ts:1142-1242`, `273-279`, `469`, `596-600`

`POST /tools/:name` invokes any registered tool — including `bash`, `powershell`, `docker-bash` — with no authentication (default principal is boot principal / constant anonymous). CORS defaults to `Access-Control-Allow-Origin: *` with blanket 204 OPTIONS, so **any website open in a browser on the host** can `fetch http://localhost:<port>/tools/bash` and execute arbitrary shell commands (classic localhost CSRF/DNS-rebinding).

Recommendation:
- Bind to loopback explicitly and reject unexpected `Origin`/`Host` headers.
- Require a per-install token header on every route.
- Exclude execution-class tools from direct HTTP invocation by default.

Related: direct tool invocation bypasses the hook-driven pump loop, so opt-in validation hooks (e.g. json-validation) never run — inputs may reach executors completely unvalidated.

### C2. File broker and file index bind to all interfaces with zero authentication
`local-agent/file-broker/src/server.ts:86`, `local-agent/file-index/src/server.ts:92`

Both call `server.listen(port)` without a host argument → binds `0.0.0.0` + IPv6 despite docs claiming localhost-only. No auth token, Origin, or Host checks anywhere. Any LAN process can read/write workspace files via the broker (`approved=true` is attacker-supplied, not a defense); `/search` exposes indexed content and absolute paths.

Recommendation:
- `server.listen(port, "127.0.0.1")`.
- Shared-secret header checked on every route.
- Reject requests whose `Host` is not the loopback origin (DNS-rebinding defense).

### C3. Host environment leaked into local shell executors
`local-agent/matbot/packages/plugins/bash/src/index.ts:164-168`, `powershell/src/index.ts:209-213`

Local executors copy the entire `process.env` — including every vault-resolved credential matbot loaded — into every LLM-initiated command. The docker executor explicitly avoids this ("do not leak process.env"), making the local path an inconsistency with real exfiltration impact (`env | curl -d @- ...`).

Recommendation: pass a minimal default env (PATH/HOME/TEMP) like the docker executor, or an explicit allowlist.

### C4. Docker stack publishes databases on all interfaces
`local-agent/docker/mem0/docker-compose.yml:30-31, 54-55, 74-75, 84-85, 98-100`

`"8888:8000"`, `"5432:5432"`, `"7474:7474"`, `"7687:7687"`, etc. publish without host-IP prefix, exposing Postgres (password from a biased PRNG, see M14), Neo4j, and mem0 to the LAN.

Recommendation: prefix every mapping with `127.0.0.1:`. Treat mem0-api's `MEM0_API_KEY` as unenforced until verified upstream.

### C5. Infinite event-loop hang on empty search term
`local-agent/matbot/packages/core/knowledge/src/lookup-knowledge-index.ts:56-61`

`text.indexOf('', pos)` always returns `pos`; if any search term is the empty string the loop never advances and freezes the whole process. Terms come from LLM tool calls (untrusted).

Fix: skip terms where `t.length === 0` (and reject empty terms at the tool boundary).

---

## High

### H1. Session not persisted on toolcall-hook abort — data loss
`core/runner/src/runner.ts:369-384`

`runSession` documents "persists at every exit"; screen/loop/catch abort paths persist. The toolcall-hook abort path returns without `store.set`, so the committed session loses the assistant turn that was streamed. Fix: persist before yielding `aborted`.

### H2. Unguarded awaits in fire-and-forget `pump` → potential process crash
`core/runner/src/session-runner.ts:208, 230, 233`

`store.get`, `store.set`, and `resolveProvider` run *before* the `try` block, but `pump` is invoked as `void pump(...)` — a storage failure becomes an unhandled rejection (process exit under modern Node defaults) and queued submissions stall. Fix: move these awaits inside the try/catch and emit an `error` event.

### H3. ReDoS filter bypassable; memory backend executes regexes unbounded
`plugins/workspace-rag/src/v2/manager.ts:1928-1940` (`assertSafeRegex`), `v2/memory-repository.ts:498`

The blocklist misses nesting across groups (`((a+)b)+c` passes). Postgres lane is protected by `statement_timeout = 2000ms`, but the memory lane compiles and runs synchronously with no timeout — one crafted pattern freezes the process. Fix: use RE2 or a bounded-timeout executor (worker thread with hard kill); add nested-group tests.

### H4. TOCTOU between policy check and filesystem operation in file broker
`local-agent/file-broker/src/server.ts:51-57, 64-75`, `paths/src/policy.ts:144-166`

Policy evaluation resolves symlinks, then `readTextFile`/`writeTextFile` re-open by path — a symlink swapped in between redirects I/O outside the workspace. The per-path write queue does not close this race against external processes. Fix: open once through an authorized realpath-resolved handle and stat/read/write via that handle.

### H5. Arbitrary LLM-supplied `cwd` in bash/powershell executors
`plugins/bash/src/index.ts:160-162`, `powershell/src/index.ts:205-207`

`cwd` is used verbatim and even auto-created (`mkdir recursive`) — commands can be rooted anywhere on the host. Fix: resolve against `ctx.workdir` and refuse escapes, or remove from the schema.

### H6. Service wrapper downloaded without integrity check, runs as LocalSystem
`scripts/install-cortex-service.ps1:10, 76`

`WinSW-x64.exe` pulled from a moving `latest` URL with no checksum, installed as LocalSystem service with write access to workspace roots. Compromised CDN/GitHub = SYSTEM code execution. Fix: pin version + SHA256 verification (or vendor the exe); consider a low-privilege service account.

### H7. SQLiteFileStore: unbounded buffering and meaningless CAS versions
`plugins/storage/sqlite/src/file-store.ts:56-59, 170-181, 215-228`

- `put` buffers all chunks then concats — hostile/large stream OOMs the process.
- `version = row.size.toString()` means two equal-size writes produce the same version → CAS silently degrades to last-write-wins, violating the repo-wide "never write without version check" rule.

Fix: enforce max size while streaming; use UUID or content-hash revisions.

### H8. Pre-aborted AbortSignal hangs `SQLiteFileStore.watch` forever
`plugins/storage/sqlite/src/file-store.ts:140-161`

Listeners attached after construction never fire on already-aborted signals; the generator parks indefinitely, leaking connections/watchers. Same late-subscribe pattern in workspace-rag sidecar clients (`v2/late-interaction.ts:35-41`, `v2/retrieval.ts:267-270`). Fix: check `signal?.aborted` up front, or standardize on `AbortSignal.any` (as `search-backend.ts:512` already does correctly).

### H9. CAS bypass on contention drops concurrent messages
`plugins/frontend/web/src/server.ts:676-696`

After 5 failed CAS attempts `appendSessionMessages` falls back to unconditional `set` — deliberate lost-update path clobbers concurrently appended turns. Fix: retry with backoff or fail the request; never bypass CAS on shared session documents.

---

## Medium

### Runner / core

- **M1. Teardown errors attributed to wrong plugin** — `core/runner/src/registry.ts:376-383`: results computed over reversed plugin array but indexed against forward order. Pair each result with its plugin.
- **M2. Settings CAS uses `Date.now()` versions** — `core/runner/src/settings.ts:63,76`: same-millisecond writes collide → silent clobber; `for(;;)` retry has no backoff/cap (livelock risk). Use monotonic/unique versions; bound retries. (Same pattern in triggers/skills/remember managers, see X1.)
- **M3. YAML comment stripping corrupts quoted `#` values** — `core/config/src/yaml.ts:30`: `line.replace(/#.*$/, '')` mangles `apiKey: "abc#123"` into a broken string. Use a quote-aware scanner.
- **M4. YAML parser cannot represent sequences of mappings or chomped scalars** — `core/config/src/yaml.ts:65-77, 94-106`: `- name: claude` items parse as literal strings, yet `loader.ts:88` requires records for `available_models` (throws). `|-`/`>` stored literally. Recurse `parse` for sequence items containing `:`; support chomping indicators; add tests.
- **M5. Browser import failures ignore `onLoadError: 'throw'`** — `core/runner/src/loader.ts:163-169`: browser path warns-and-skips regardless of policy, breaking the documented rollback contract.
- **M6. Observability spans record unsanitized tool inputs/results** — `core/runner/src/runner.ts:347, 455`: raw arguments/results (often embedding secrets) go to the observability sink without `vault.scrub`. Scrub attribute payloads.
- **M7. `SystemContextRegistry.build` not failure-isolated** — `core/runner/src/system-context.ts:40`: one throwing contributor fails the whole turn, inconsistent with isolation everywhere else. Use `Promise.allSettled`.
- **M8. Plugin unload timer leak + premature event** — `core/runner/src/registry.ts:367-372`: teardown timeout never cleared (keeps event loop alive); `unloaded` emitted before teardown settles.
- **M9. `fetchWithRetry` has no per-attempt/overall deadline** — `core/providers/_base/src/http-retry.ts:45-64`: hung connection blocks a turn indefinitely. Composite per-attempt `AbortSignal.timeout`.
- **M10. Vault scrub misses short secrets; ordering hazard** — `core/security/src/vault.ts:112-120`: sub-4-char values never redacted; sequential split/join can miss overlapping secrets depending on Map order. Sort by descending length.

### Workspace RAG v2

- **M11. `close()` does not stop the lazy-embedding worker** — `v2/manager.ts:433-440`: worker keeps issuing calls against a closed PG pool after shutdown. Add a lazy-worker abort controller; await it before closing the repository.
- **M12. Lazy worker swallows failures silently** — `v2/manager.ts:2049-2053`: bare `catch` marks passages failed, logs nothing, abandons remaining batches. Log and distinguish abort vs failure.
- **M13. Rate limiter burns reserved budget when wait aborted; no delay cap** — `v2/rate-limiter.ts:22-37`: aborted waits never release reservations (throughput starvation); huge consumes schedule minutes ahead. Release on abort; clamp/split large requests.
- **M14→see C4.** Also: evidence byte-range fetched under wrong/dead content key — `v2/retrieval.ts:851-854`: dead branch plus fallback that throws in `assertHash`; use always-available `hit.contentSha256`.
- **M15. N+1 round trips in hot ingestion paths** — `v2/postgres-repository.ts:571-594` (one transaction per candidate record in `reuseEmbeddings`), `1139-1151` (`saveEvaluationRun` per metric row), `retrieval.ts:837-901` (sequential evidence fetch), `960-987` (per-hit neighbour queries). Batch into single statements/bounded concurrency.
- **M16. Validation query row explosion** — `v2/postgres-repository.ts:1983-1999`: four-way LEFT JOIN materializes sections × passages rows before `COUNT(DISTINCT)`. Use scalar subqueries.
- **M17. Per-file job-state transaction churn** — `v2/manager.ts:1489-1538`: up to 3 dedicated transactions per file during ingest; coalesce/debounce progress updates.
- **M18. Unbounded audit payload retention** — `v2/retrieval.ts:916-921`: every fused candidate persisted with passage text per search; no TTL/pruning on `retrieval_hits`/`retrieval_evidence`/`regex_runs`. Strip text, keep hash+ranges, or prune.
- **M19. Config doc says default `'off'`, implementation defaults `'primary'`** — `v2/config.ts:21-28`: doc/behavior divergence on the flag gating whether v2 serves retrieval — accidental-rollout hazard. Resolve deliberately.
- **M20. Env vars parsed unvalidated** — `v2/postgres-repository.ts:83-92`: `Number(...)` yields NaN straight into `PoolConfig.max`. Reuse `config.ts` helpers; centralize remaining direct `process.env` reads.
- **M21. Object-store root built from unsanitized `workspace.id`** — `v2/manager.ts:1898-1914`: `..`/absolute segments would escape configured root. Apply identifier sanitization.
- **M22. Stream writer lacks standing `'error'` listener** — `v2/object-store.ts:30-59`: mid-stream error with no listener crashes the process. Attach in constructor.
- **M23. Evaluation k mismatch** — `v2/manager.ts:941` searches at `min(k,25)` but reports recall@k. Clamp reported k or raise depth.

### Services & scripts

- **M24. Broker writes non-atomic** — `file-broker/src/file-writer.ts:66`: in-place truncate/write corrupts files on crash. The file-index store already does temp+rename correctly (`file-index/src/store.ts:91-104`) — reuse that pattern (+ optional fsync).
- **M25. Internal error text leaked in 500 responses** — `http-utils/src/index.ts:117-120`: raw `error.message` includes absolute paths. Log details server-side; return generic message for non-HttpError.
- **M26. Missing query param returns 500 instead of 400** — `file-broker/src/server.ts:90-97`: throw `HttpError(400)`.
- **M27. GPU endpoint: no concurrency control, no body-size bound** — `docker/mem0/workspace-rag-cuda/app.py:138-207`: concurrent `/embed` calls enter `model.encode` simultaneously (source of spurious CUDA OOMs); per-text length uncapped; no uvicorn body limit. Add `asyncio.Semaphore`, cap total chars, add middleware body cap. Also `BATCH_SIZE` parsed unvalidated at import (`app.py:22`) → container restart loop on garbage input.
- **M28. `$LASTEXITCODE` unchecked for native commands** — `scripts/start-local-agent.ps1:153,160,172`, `run-service.ps1:202,214`: `$ErrorActionPreference='Stop'` doesn't apply to native exes; failed build serves stale dist; failed compose-up falls through. Reuse `Invoke-LoggedCommand` from `run.ps1:55-68`.
- **M29. Secret generation modulo bias + unrestricted .env ACL** — `scripts/setup-secrets.ps1:10-15,61`: `% $chars.Length` biases first 8 alphabet chars; use `RandomNumberGenerator.GetInt32`. Restrict `.env` ACLs to current user (`icacls`). Registry persistence broadens exposure further.
- **M30. Port-based process killing targets arbitrary PIDs** — `start-local-agent.ps1:22-40`, `run-service.ps1:27-46`, `stop-local-agent.ps1:3-9`: `Stop-Process -Force` on port owners can kill unrelated apps. Verify image name or track PIDs.
- **M31. WinSW compose dependency on unhealthy Neo4j** — `docker-compose.yml:94-102` vs `32-36`: mem0-api depends on `service_started` only; crash-loops before bolt is ready. Add healthcheck + `service_healthy`.
- **M32. Unpinned base image** — `Dockerfile.mem0-api:9`: `mem0/mem0-api-server:latest` while everything else is pinned. Pin by digest.

### Plugins

- **M33. `WebCryptoVault` docs claim encryption; class stores plaintext** — `plugins/browser/src/webcrypto-vault.ts:7-15` vs `43-45`: AES-GCM/PBKDF2 helpers exist but are unused. Plaintext posture also in `local-vault.ts` and `drive-vault.ts`; OAuth token cached in plaintext localStorage (`drive-auth.ts:82-89`). Write down the system stance once; fix the misleading doc or wire in encryption.
- **M34. DriveAuth token-callback clobber race** — `drive-auth.ts:125-134, 178-198`: single mutable TokenClient callback slot; concurrent requests wedge future renewals permanently. One client per request or queue by request id.
- **M35. skills-node watcher: listener leak + permanent exit on transient errors** — `watcher.ts:58-62` (abort listeners accumulate per poll), `watcher.ts:46,64` (`readdir` failure kills watching for process lifetime; dir created after boot never picked up). `{ once: true }` + removal; treat readdir errors as retryable.
- **M36. docker-bash TOCTOU duplicate containers; script passed as argv env** — `index.ts:154-181` (concurrent create races; serialize with promise lock), `index.ts:459-468` (`-e MATBOT_SCRIPT=...` fails past ~32 KB on Windows; visible in process list — pipe via stdin instead).
- **M37. `readBody` keeps buffering after limit breach** — `frontend/web/src/server.ts:250-262`: cap protects parsing, not memory. Destroy the request on breach.
- **M38. OPFS store: write leak and non-atomic put** — `browser/src/opfs-file-store.ts:49-62` (no try/finally around writable swap), `77-105` (get→write→meta race mints duplicates). try/finally + per-name serialization.
- **M39. filesystem store: bare `set` bypasses the per-id lock** — `storage/filesystem/src/store.ts:65-69, 105-108`: interleaves with CAS windows, defeating the guarantee. Route through the same lock.
- **M40. `bash_config` executor trusts unvalidated input shape** — `docker-bash/src/index.ts:203-290`: correctness depends entirely on the opt-in json-validation hook; validate in-code like cognition does.
- **M41. `http` tool SSRF surface + unbounded response reads** — `http/src/index.ts:24-37`: document trust boundary; stream-read with byte cap.
- **M42. SQLite store `query()` full-table scans** — `storage/sqlite/src/store.ts:164-167`: O(n) JSON.parse per query in namespaces routed there precisely because they grow. Push filters into SQL or paginate.

---

## Low (condensed)

| # | Finding | Location |
| --- | --- | --- |
| L1 | `parseSSE` misses spec-compliant `data:` without space | `providers/_base/src/sse.ts:30` |
| L2 | `checkApiVersion` NaN hole skips warnings on malformed versions | `core/runner/src/registry.ts:98-115` |
| L3 | Tool collision resolver treats any free-text answer as overwrite (fail-open) | `core/runner/src/registry.ts:87-93` |
| L4 | `LookupKnowledgeIndex` linear dedup + publicly mutable `docs` | `knowledge/src/lookup-knowledge-index.ts:9,26-35` |
| L5 | Silent last-write-wins provider/model collisions in config loader; unvalidated model parameters | `config/src/loader.ts:109,159-168` |
| L6 | Sort comparator coerces booleans/nulls via `String()`, diverging from strict filter semantics | `storage/_base/src/query/sort.ts:12-13` |
| L7 | Double logging / mixed funnels in loader; `catch (e:any)` losing stacks | `core/runner/src/loader.ts:170-171`, `runner.ts:287,306` |
| L8 | Boundary casts (`as unknown as HookRegistry` etc.) bypass own validate-at-boundaries rule | `core/runner/src/registry.ts:310-316`, `settings.ts:52`, `loader.ts:176` |
| L9 | Interpolated identifiers inside PL/pgSQL DO blocks (safe today, injectable pattern tomorrow) | `v2/postgres-repository.ts:1877-1908` |
| L10 | Dead regex alternative in census heading detector; naive conflict heuristics flip answerability on bare "no"/"yes" | `v2/census.ts:103`, `v2/retrieval.ts:392-402`, `v2/semantic.ts:26` |
| L11 | Pre-aborted signals ignored by RAG sidecar clients (duplicate of H8 pattern) | `v2/late-interaction.ts:35-41`, `v2/retrieval.ts:267-270` |
| L12 | Evidence IDs collide across re-runs; audit rows silently overwritten | `v2/retrieval.ts:861` |
| L13 | Backups grow unbounded inside package tree; no retention | `file-broker/src/backup.ts:22-30` |
| L14 | Positional diff (not LCS) makes high-risk-write review artifact misleading | `file-broker/src/diff.ts:11-35` |
| L15 | Stale comment claims `TOKEN=` redaction gap that doesn't exist; FILE_LEVEL_SECRETS misses AWS/GitHub/Google key shapes | `file-index/src/indexer.ts:91`, `secrets.ts:11` |
| L16 | Config reload fingerprint `size:mtimeMs` misses rapid edits; broker caches, index reloads fresh — inconsistent mechanisms | `file-broker/src/config-cache.ts:44`, `file-index/src/server.ts:39-42` |
| L17 | Health-check dumps full response JSON to console/transcript | `scripts/health-check.ps1:38-42` |
| L18 | Matbot command string interpolated into `powershell -Command`; path with `'` breaks quoting | `start-local-agent.ps1:240-246`, `run.ps1:195` |
| L19 | Request-abort listener accumulation per keep-alive request | `http-utils/src/index.ts:79-90` |
| L20 | PowerShell temp scripts in stable shared directory; cleanup tied to iterator drain | `powershell/src/index.ts:33-39,141-148` |
| L21 | Telegram principal derived from spoofable display name instead of numeric id | `frontend/telegram/src/plugin.ts` (~205), also `bot.ts` |
| L22 | ReDoS surface in json-validation `pattern` keyword (first-party schemas today) | `json-validation/src/index.ts:71-74` |
| L23 | Route typo `/indx.html` — canonical `/index.html` 404s | `frontend/web/src/server.ts:716-717` |
| L24 | OPFS delete swallows failures via allSettled; base64 spread throws >~100 KB | `opfs-file-store.ts:163-166`, `webcrypto-vault.ts:140` |

---

## Cross-cutting inconsistencies (coding practices)

1. **CAS version semantics drift.** Three implementations coexist: `Date.now().toString()` (`triggers/src/manager.ts:102`, `skills/src/manager.ts:230`, `cognition/src/remember/tool.ts:115`), `crypto.randomUUID()` (`edit-session`, `session-titler`), and `size.toString()` (`sqlite/file-store.ts:172`). Millisecond timestamps collide under burst writes — exactly where managers rely on CAS most. Standardize on unique monotonic versions.

2. **Three error-isolation idioms.** Hook `invoke()` (catch → log → marker), mount/quiescer `run()` (catch → log), plain propagation (`SystemContextRegistry.build`, `pump` prelude). A shared "run isolated, log, degrade" utility would close gaps H2/M7.

3. **Validation philosophy varies by plugin.** `cognition_config` hand-validates exhaustively; `bash_config` trusts schema; most tools cast `input as X` and depend on the opt-in json-validation hook — which direct HTTP invocation (C1) bypasses entirely.

4. **Error-swallow styles in workspace-rag.** Three coexisting styles: `console.warn` logs, pervasive silent `.catch(() => undefined)`, and fully silent catches (`v2/manager.ts:2049`). Mirror the index-creation warning pattern everywhere.

5. **~120 lines of duplicated PowerShell.** `Test-PortListening`, `Stop-PortListeners`, `Wait-CudaEmbeddingReady`, `Get-DockerEnvValue`, etc. copy-pasted between `start-local-agent.ps1` and `run-service.ps1` with drift already visible. Extract a shared module.

6. **Three near-identical `spawnAndStream` bridges** (bash, powershell, docker-bash) with drifted timer/listener cleanup (L-level leaks in each); duplicated `sanitizeTimeout` comments. Extract one node-common implementation.

7. **Raw `console.*` logging throughout core**, ad-hoc `[matbot]` prefixes, no levels, no scrubbing pass — which is what makes M6 (unsanitized spans) matter.

8. **Magic numbers inline:** hook default priority 50, `MAX_RESUBMIT_DEPTH = 8`, teardown 10s, timeouts (2s/3s/5s/30s) and caps (100/150/256/512/2000/12000) across workspace-rag — undocumented at constant sites; lift into named config.

9. **Strict-typing discipline erodes at boundaries:** exemplary `exactOptionalPropertyTypes` discipline overall, yet `as unknown as` / blind record casts appear precisely where untrusted data enters (L8, L5).

10. **Duplicated helpers:** `sha256`/`stableId`/`now` reimplemented identically across workspace-rag modules; `contentHashFromObjectPath` is dead code given the correct `contentSha256` path exists.

11. **Direct `process.env` access scattered** despite the stated Vault/Settings configuration rule (workspace-rag manager/repository, scripts).

12. **Plaintext-secrets posture undocumented as system stance** (M33) — decide once, document once.

### Practices worth keeping

- Storage `_base` query engine: closed AST, JSON-pointer boundary validation, cursor re-validation, CSP-safe compilation.
- Parameterized SQL everywhere in sqlite + postgres repositories; sanitized table names.
- RLS + role separation, migration advisory locks, evidence re-authorization with byte-range rehashing before delivery (workspace-rag).
- Atomic temp+rename persistence with cleanup in file-index store; recoverable-error classification in indexer walks; symlink-non-following traversal.
- `http-retry` honoring `Retry-After` and cancelling bodies pre-retry; `AbortSignal.any` usage in search-backend.
- docker-bash setsid+pidfile process-group kill.

---

## Prioritized hardening plan

**Phase 1 — Close the network/trust boundary (days):**
1. Bind all three Node services to loopback; add shared-secret header + Host/Origin checks (C1, C2).
2. Prefix all Docker ports with `127.0.0.1:`; verify mem0 API key enforcement (C4).
3. Minimal-env for local shell executors; confine `cwd` to workdir (C3, H5).
4. Fix the infinite loop on empty search terms (C5).
5. Pin WinSW with checksum (H6).

**Phase 2 — Correctness bugs (a week):**
6. Persist session on toolcall-hook abort; guard `pump` prelude awaits (H1, H2).
7. Bounded regex execution for memory backend (H3); fix TOCTOU in broker (H4).
8. CAS fixes: unique versions everywhere, no bypass fallback, sqlite size-as-version (H7, H9, M2, X1).
9. AbortSignal hygiene sweep: pre-aborted checks, listener cleanup (H8, M35, L19).
10. YAML parser: quote-aware comments, sequences-of-mappings, chomping + tests (M3, M4).

**Phase 3 — Operational hardening (ongoing):**
11. Workspace-rag: lazy-worker lifecycle, rate-limiter reservation release, N+1 batching, retention pruning, config default/doc reconciliation (M11-M23).
12. Scripts: shared PowerShell module, `$LASTEXITCODE` checks, secret-gen + ACL fixes, PID-safe stopping (M28-M30, X5).
13. Secrets stance: document plaintext-browser posture or implement encryption; scrub observability payloads (M6, M33).
14. Consolidate duplicated spawn/diff/validation logic; lift magic numbers into named config (X6, X8).

*Generated by automated multi-area code review; every finding was verified against working-tree source at review time.*
