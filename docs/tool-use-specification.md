# Tool Use Specification

This document specifies what is needed to bring Cortex's tool use to parity with
modern coding-agent harnesses such as OpenCode, Claude Code, Codex CLI, and
similar tools. It covers the runtime loop, the standard tool set, the
permission system, context management, and the user-facing streaming contract.

The specification is grounded in three sources:

- an audit of the current Matbot/Cortex tool layer (`local-agent/matbot`,
  especially `packages/core/runner/src/runner.ts`, `packages/core/plugin-api/src/types.ts`);
- Anthropic's published guidance ("Building effective agents", "Writing
  effective tools for agents — with agents");
- a source study of `sst/opencode` (tool registry, permission evaluation,
  session loop, subagents, compaction, snapshots).

---

## 1. Current state summary

Cortex already has a solid foundation: an AsyncIterable streaming tool model,
hook-based interception (`screen`, `contribute`, `toolcall`, `toolresult`,
`followup`), plugin-owned tool registration with collision resolution, SSE
pipeline events, workspace confinement for shell tools, and a policy-checked
file broker. The gaps versus a modern harness are:

| # | Gap | Consequence |
| --- | --- | --- |
| G1 | No iteration/token budget on the agentic loop (`for(;;)` in runner.ts) | Runaway turns; no harness-controlled stopping |
| G2 | Sequential execution of parallel tool calls | Slow; ignores provider concurrency semantics |
| G3 | Input schemas advertised but never validated by the runtime | Malformed args crash or misbehave downstream |
| G4 | No read/glob/grep/edit/write navigation-and-edit tool set over host repos | Model cannot do coding-agent work; discovery relies on RAG |
| G5 | No diff/patch-based editing, no read-before-edit enforcement | Unsafe, unverifiable file mutation |
| G6 | No first-class permission/approval system (hooks only) | No allow/ask/deny UX; `approved` flags are self-declared by the model |
| G7 | No output truncation policy outside bash; no pagination contract | Context blowups; no "re-read at offset" pattern |
| G8 | `isError` dropped by the openai-compat adapter; truncated tool-call JSON aborts the turn | Model cannot distinguish errors; one bad stream kills the turn |
| G9 | No subagent/nested-loop primitive (`task`) | Expert panel is single-shot; no orchestrator-workers pattern |
| G10 | No todo/task tracking, doom-loop detection, retry/backoff, compaction | Poor long-run behavior and observability |
| G11 | Multi-action `*_action` mega-tools with loose schemas | Weak schema guidance; no per-action permission surface |

Each gap maps to a numbered requirement below.

---

## 2. Design principles (from research)

These principles constrain everything that follows:

1. **Invest in the agent-computer interface (ACI), not just prompts.**
   Tool descriptions, parameter names, and error messages are prompt surface.
   They deserve the same review effort as system prompts.
2. **Poka-yoke the arguments.** Make mistakes hard: require absolute paths,
   enforce uniqueness in edit matching, validate inputs at the boundary, and
   return corrective, actionable error text instead of tracebacks.
3. **Return high-signal, token-efficient results.** Prefer targeted search
   over exhaustive listing; support truncation with head/tail previews and an
   explicit re-read path; resolve opaque IDs to meaningful names where possible.
4. **Keep formats close to natural text.** Avoid asking the model to emit
   line-counted diffs or heavy escaping; exact string replacement beats unified
   diff authoring for most models.
5. **Simple, composable loop; complexity only when measured to help.** One
   while-loop agent with well-documented tools outperforms elaborate frameworks.
6. **Namespacing and selective tool sets.** Fewer, clearly bounded tools beat
   many overlapping ones; per-agent tool subsets reduce distraction.
7. **Transparency.** Every planning step, tool call, approval, and cost is
   visible to the user as it happens.

---

## 3. Runtime requirements

### R1. Bounded agentic loop (G1)

`runSession()` must accept loop policy options:

```ts
interface LoopPolicy {
  maxIterations?: number        // default e.g. 50; hard stop
  maxToolCallsPerTurn?: number  // default e.g. 200
  tokenBudget?: { input?: number; output?: number } // cumulative across iterations
  stopWhen?: (state: LoopState) => boolean
}
```

Behavior when a limit is hit:

- Do not end the turn silently. Append a synthetic assistant-visible note
  ("iteration budget reached; summarize progress and stop or ask the user")
  and complete gracefully so the last message is coherent.
- Emit a new pipeline event `loop:limit {reason, iterations, tokens}`.
- Per-session/per-agent overrides via configuration; `0` disables a limit only
  when an explicit opt-in flag is set (no unbounded defaults).

### R2. Parallel tool execution (G2)

When the assistant emits multiple `tool-call` blocks:

- Execute them concurrently by default, each through its own AbortController
  linked to the turn signal.
- Provide a per-tool `serial: true` hint (default false); if any call in the
  batch is serial, run the batch sequentially to preserve ordering semantics
  (e.g., multiple edits to the same file).
- Enforce per-tool concurrency limits (`maxConcurrency`, default 4).
- Preserve result ordering by call id; all results still land in one
  `role:'tool'` message.
- Stream `tool:start` / `tool:end` per call interleaved, tagged with `callId`,
  so the WebUI can render concurrent activity.

### R3. Schema validation at the boundary (G3)

- Validate every tool input against its `inputSchema` before execution.
  Use a small standards-compliant JSON Schema validator (draft 2020-12 subset:
  `type`, `required`, `properties`, `enum`, `const`, `minimum/maximum`,
  `minLength/maxLength`, `pattern`, `items`, `anyOf/oneOf/allOf`, `$ref`
  within-document).
- On failure, do not execute. Return an `isError` tool result whose message is
  model-facing and corrective:
  `"Invalid input for tool 'read': 'offset' must be an integer >= 1. Re-read the schema and retry."`
  Register a synthetic `invalid` tool result path (as OpenCode does) so
  providers that drop malformed calls still see feedback.
- Extend `Tool` with optional `outputSchema`; validate non-conforming results
  in debug mode and log (do not block).

### R4. Error fidelity (G8)

- The openai-compat adapter must serialize `isError` into the tool-role
  content (e.g., wrap as JSON `{"error": ..., "is_error": true}` or the
  provider's native error convention) so models can react to failures.
- Truncated/malformed tool-call argument streams must not abort the whole
  turn: synthesize a failed tool-call with an `isError` result explaining the
  truncation, then continue the loop so the model can retry.
- Define a stable error taxonomy in results:
  `{ error: string, code?: 'invalid_input'|'not_found'|'permission_denied'|'timeout'|'aborted'|'internal', retryable?: boolean }`.

### R5. Retry and resilience

- Wrap provider `complete()` calls in bounded exponential backoff (initial
  2 s, ×2, jitter, honor `retry-after`, max ~5 attempts, cap 30 s) for
  429/5xx/network errors; never retry context overflow.
- Publish a `retry {attempt, nextAt}` pipeline event so the UI can show status.
- Optional per-tool retry wrapper (`retries: n`) for flaky networked tools;
  never auto-retry mutating tools (edit, write, shell) unless they are
  verified idempotent.

### R6. Doom-loop detection (G10)

Track consecutive identical tool calls (same name + normalized identical
input). After N=3 identical calls in a turn, raise a hook event
(`doom_loop`) which, under the default permission policy, asks the user or
injects a warning result telling the model to change strategy.

### R7. Compaction and context budgeting (G10)

- Track cumulative usage per turn/session (input/output/cache tokens, cost)
  from provider usage payloads; expose in `usage` events (already exists) and
  persist on messages.
- Add automatic compaction: when estimated history size approaches the model's
  usable window (input limit − reserved output − safety margin), run a hidden
  summarization completion that replaces older history with a durable summary
  block, preserving the most recent turns verbatim (default: clamp 25% of the
  window between 2k–15k tokens). Mark compacted messages; keep raw history in
  the store for replay/audit.
- Standardize pruning of old tool outputs (protect recent N tokens of tool
  output; replace older outputs with `[truncated]` placeholders in provider
  submissions, keeping full data in persistence).

---

## 4. Permission and approval system (G6)

A harness-level permission system sits *in front of* the existing hooks: it is
implemented as the built-in `toolcall` hook of highest relevance, but has a
declared config schema, UI integration, and rule semantics.

### R8. Rule model

```yaml
permission:
  edit:
    "**/*.md": allow
    "*": ask
  bash:
    "git *": allow
    "rm *": deny
    "*": ask
  webfetch:
    "https://docs.example.com/*": allow
    "*": ask
  read:
    "*.env": ask
    "*.env.example": allow
```

- A rule is `{ permission: string, pattern: string, action: allow|ask|deny }`.
- Evaluation flattens configured rulesets plus session-approved rules and takes
  the **last matching rule wins**, using glob wildcard matching on both the
  permission name and the subject pattern.
- Default action when nothing matches: `ask` (configurable globally).
- Tools fully denied by `{"*": deny}` rules are **hidden from the model's tool
  menu entirely**, not merely blocked at call time.
- Per-agent rulesets merge over global config; sessions can carry overrides.
- The model-self-declared `approved` flag on file-broker writes must be
  replaced by this system (the broker keeps its server-side policy as defense
  in depth).

### R9. Ask flow

- Tools declare what they need via a new executor capability:
  `ctx.ask({ permission, patterns, metadata })` (e.g., edit asks with the
  computed **diff** in metadata; shell asks with parsed command patterns;
  webfetch asks with the URL).
- Outcomes: `once`, `always` (adds an approved rule for the session),
  `reject` (with optional user feedback string fed back to the model as an
  `isError` tool result, preserving tool pairing).
- New pipeline events: `permission:ask {id, permission, patterns, metadata}`,
  `permission:reply {id, outcome}`; the WebUI renders approve/deny dialogs,
  showing diffs for edits and commands for shell. Pending asks are cancelled
  when the turn is aborted.

### R10. Sandbox posture baseline

Keep and formalize current strengths; add what's missing:

- Shell: cwd confined to workspace root (already), allowlisted env (already),
  timeouts with SIGKILL escalation (already); add network-egress policy knob
  and per-workspace command deny patterns.
- Filesystem: all host-FS access continues through file-broker roots; add
  `external_directory`-style ask whenever a shell command or tool touches a
  path outside the active workspace root (parse tree-sitter-style command
  analysis later; start with tool-level path checks).
- Secrets: continue excluding vault values from tool env (already).

---

## 5. Standard tool set (G4, G5, G11)

Add a first-class "coding harness" tool set operating over a designated
workspace root (host repo via file-broker, or workspace scratch area). All new
tools follow the naming conventions and description-quality bar in §2.

### R11. Core navigation tools

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `read` | `filePath` (absolute required), `offset?` (1-indexed line), `limit?` (default 2000 lines) | Reads text files with line-number prefixes; hard caps: 2000 lines, 2000 chars/line, ~50 KB/call; appends `(Use offset=N to continue.)` hint; directory paths return listings; images/PDFs become attachments (WebUI already supports resources); binary sniffing; fuzzy "did you mean" suggestions from the directory on missing files |
| `glob` | `pattern`, `path?` | Fast file matching honoring `.gitignore`; cap 100 results with explicit truncation notice |
| `grep` | `pattern` (regex), `path?`, `include?` (glob) | Ripgrep-backed (`--json`, ignore-aware, `.git` excluded); cap 100 matches, 2000 chars per matched line; invalid regex returns a typed, corrective error |
| `list` | `path?` | Compact recursive tree listing (depth-capped) |

On Windows, grep/glob should use a bundled ripgrep binary rather than
PowerShell pipelines for speed and ignore-file fidelity.

### R12. Edit and write tools

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `edit` | `filePath`, `oldString`, `newString`, `replaceAll?` | Exact unique-string replacement; error on multiple matches unless `replaceAll`; bounded fuzzy fallback chain (line-trimmed → whitespace-normalized → block-anchor with similarity threshold) with all matches still reported; empty `oldString` on existing file redirects to `write`; CRLF/BOM preserved both directions; result includes a unified diff (additions/deletions counted) |
| `write` | `filePath`, `content` | Full-file write with diff generation; requires prior `read` of the same file within the session when overwriting (read-before-edit enforcement tracked per session+file+mtime); refuses silent overwrite of changed-on-disk files |
| `apply_patch` *(optional)* | multi-file patch text | Only expose if a target model family demonstrably prefers it; otherwise keep `edit`/`write` |

Read-before-edit enforcement: record `{filePath, mtimeOrHash}` on every
successful `read`; `edit`/`write` fail with a corrective message when the file
was never read or changed since (`"File has been modified since read. Read it again before editing."`).

After every successful `edit`/`write`: emit `file:changed` broadcast (exists),
generate the diff into the tool result metadata (drives the permission dialog
and the UI), and optionally run project-configured formatters/linters, feeding
diagnostics back into the tool result ("LSP/analyzer errors detected in this
file, please fix: ...") — integrate with the existing evaluation-observability
spans rather than building new plumbing.

### R13. Task tracking tool (G10)

```jsonc
// todowrite — replaces the session's list wholesale
{ "todos": [ { "content": "string",
               "status": "pending|in_progress|completed|cancelled",
               "priority": "high|medium|low" } ] }
```

- Persisted per session; broadcast `todo:updated` for the WebUI (render as the
  live task list OpenCode/Claude Code show).
- System-prompt guidance instructs the model to create todos for multi-step
  work (3+ steps), keep exactly one `in_progress`, and update in real time.

### R14. Subagent tool (G9)

Add a `task` tool implementing the orchestrator-workers pattern:

- Parameters: `description`, `prompt`, `subagent_type`, optional `task_id`
  (resume a previous subagent session).
- Executes a **full nested agentic loop** (tools included) in a child session
  linked to the parent (`parentSessionId`), with its own system prompt, tool
  subset, and permission inheritance (child inherits parent deny rules; nested
  `task` denied by default; depth limit configurable, default 1).
- Returns the subagent's final assistant text as the tool result, wrapped in a
  structured envelope with status.
- Built-in subagent profiles: `general` (all tools except todo/task), 
  `explore` (read-only: read/glob/grep/list/bash-read-only), and reuse the
  expert panel as additional `subagent_type`s so experts gain tool access and
  iteration instead of single-shot `single_turn`.
- The `task` description dynamically lists available subagent types.
- Background mode (flag-gated initially): returns immediately; on completion a
  synthetic message injects the result into the parent session, triggering a
  new loop turn (reuse the followup/resubmit machinery, respecting its depth cap).

### R15. Decompose mega-tools (G11)

Do **not** rewrite the existing enterprise `*_action` tools wholesale; instead:

- For new domains, prefer focused tools with strict schemas.
- Where an `*_action` remains, split the loose schema into per-action
  `anyOf`/discriminated schemas so validation (R3) and permissions (R8) can key
  on the action, and move procedural detail out of the `description` string
  into concise parameter descriptions.
- Namespace new tools consistently (`fs_read`, `fs_grep`, ... or bare harness
  names like opencode's `read`/`grep`) and avoid overlap between RAG retrieval
  tools (`contextual_search`, `workspace_rag`) and raw FS navigation — describe
  boundaries explicitly in both descriptions.

---

## 6. Output contracts

### R16. Universal truncation policy (G7)

Apply inside the runner wrapper (not per-tool):

- Defaults: 2 000 lines / 50 KB per tool result (configurable globally and
  per tool: `tools.<name>.output.maxLines/maxBytes`).
- On overflow: persist the full output (existing workspace artifact storage),
  return a head/tail preview plus:
  `"...N lines truncated... Full output saved to <resource-url>. Use read with offset/limit or grep to inspect."`
- Mark the result `{ truncated: true, totalBytes, savedTo }` in metadata.
- Structured results: truncate per-field string values with the same preview
  discipline; never emit megabyte JSON blobs into context.

### R17. Result formatting guidance

- Prefer markdown/text close to training distribution over deeply nested JSON
  for human-readable artifacts (search hits, diffs, listings).
- Include semantic names alongside any IDs required for follow-up calls.
- Errors always actionable: what was wrong, what to do instead, corrected
  example input where cheap.

---

## 7. Streaming and persistence

### R18. Fine-grained tool-call streaming

- Adapters should emit incremental tool-call deltas (id/name known, arguments
  accumulating) as a new pipeline event `tool:delta {callId, name?, argsDelta}`
  so the WebUI can show calls forming instead of appearing after completion.
- Tool part lifecycle surfaced as states: `pending → running → completed |
  error`, including `metadata.output` rolling updates for streaming shell
  output (bash already streams stdout/stderr — generalize the pattern).

### R19. Persistence invariants

- Tool calls/results remain ordinary message content blocks (current design is
  correct); add `isError`, `truncated`, and permission decision metadata to the
  persisted blocks.
- Orphaned tool calls (turn aborted mid-execution) must be finalized as errored
  results on disk so subsequent provider submissions never contain unpaired
  `tool-call` blocks (both adapters currently require pairing).

---

## 8. System prompt architecture

### R20. Assembled, layered system context

Formalize the system-context builder into ordered layers:

1. Base persona + identity (model name/id disclosure).
2. Environment block: OS, shell, cwd/workspace root, date, git presence.
3. Project instructions: `AGENTS.md` / `CLAUDE.md` discovery upward from the
   workspace root (one level + workspace-local), plus configured instruction
   globs/URLs.
4. Tool-set overview and usage conventions (when to grep vs RAG vs read;
   parallelism hints; budget etiquette).
5. Skills listing (existing skills plugin) and MCP instructions (existing).

Lazy directory instructions: when `read` opens a file, walk upward and attach
any not-yet-included directory-level `AGENTS.md` as a `<system-reminder>`
appended to that read output, de-duplicated per session.

---

## 9. Observability and evaluation

### R21. Metrics

Per tool call, record (evaluation-observability spans already exist): latency,
outcome (ok/error/validation-denied/permission-denied), retries, truncated
flag, bytes returned, tokens attributed. Aggregate per session: total tool
calls, error rate, doom-loop incidents, permission asks and outcomes, cost.

### R22. Tool evaluations

Adopt Anthropic's practice: maintain a suite of realistic tasks exercising the
harness tools (multi-step code-navigation and edit tasks against fixture
repos), with verifiable outcomes and expected-tool-call telemetry. Gate tool
description changes and runner changes on this suite (extend the existing
regression-suite machinery in `evaluation-observability`). Collect: task
success, redundant-call counts, validation-error rates, token spend.

---

## 10. Configuration surface

New workspace configuration keys (documented in `docs/configuration.md`):

```yaml
agent:
  loop:
    maxIterations: 50
    maxToolCallsPerTurn: 200
  subagents:
    depth: 1
    profiles: { ... }
permission:
  edit: { "*": ask }
  bash: { "git *": allow, "rm *": deny, "*": ask }
  webfetch: { "*": ask }
tools:
  output: { maxLines: 2000, maxBytes: 51200 }
  read: { maxLines: 2000 }
  grep: { maxResults: 100 }
compaction:
  enabled: true
  preserveRecentTokens: auto   # clamps 2k..15k
snapshot: true                  # per-message undo (see R23, phase 3)
```

---

## 11. Delivery phases

**Phase 1 — Safety and correctness (foundation)**
R3 schema validation, R4 error fidelity, R16 truncation, R18/R19 streaming and
persistence invariants, R1 loop budgets. These change no tool semantics and
unblock everything else.

**Phase 2 — Harness tool set**
R11 read/glob/grep/list, R12 edit/write with diffs and read-before-edit,
R13 todos, R8/R9/R10 permissions with WebUI dialogs, R6 doom-loop detection.

**Phase 3 — Composition**
R14 task/subagents with expert-panel integration, R7 compaction, R5 retry,
R15 mega-tool decomposition, R20 layered system prompts with lazy instructions.

**Phase 4 — Parity polish**
Formatter/LSP diagnostics feedback after edits, snapshots/revert per message
(shadow-git style), background subagents, apply_patch for models that prefer
it, tool evaluations wired into release gates (R22).

---

## 12. Acceptance criteria

Cortex meets parity when:

1. A turn cannot loop unboundedly; limits produce graceful, visible stops.
2. Multiple tool calls in one assistant turn execute concurrently with
   isolated cancellation.
3. Every tool input is validated; invalid inputs yield corrective `isError`
   results without executing.
4. The model can navigate and modify a host repository using
   read/glob/grep/edit/write with diffs shown to the user, read-before-edit
   enforced, and analyzer errors fed back.
5. Configured allow/ask/deny permission rules gate edits, shell commands, and
   fetches, with interactive approve/deny (once/always) in the WebUI; denied
   tools disappear from the menu.
6. Large outputs never enter context untruncated; full output is retrievable
   via read/grep at a persisted location.
7. `isError` survives both provider adapters; malformed/truncated tool-call
   streams degrade to a retryable failed call instead of killing the turn.
8. Multi-step work uses todowrite with live WebUI rendering; repeated
   identical tool calls trigger intervention.
9. `task` spawns tool-using subagents (including experts) with inherited deny
   rules and configurable depth.
10. Long sessions compact automatically within the context window while
    preserving recent turns and auditability.
