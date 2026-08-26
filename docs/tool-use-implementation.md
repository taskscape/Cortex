# Tool Use Implementation Plan

> Implements [Tool Use Specification](tool-use-specification.md). Tasks are marked
> ✅ when implemented and covered by automated tests, 🔶 for partially delivered
> scope, and ⬜ for not yet started. Test constraint: every new test confines all
> filesystem impact to a fresh `mkdtemp` directory under the system temp dir.

## Phase 1 — Safety and correctness (spec R1–R4, R6, R16, R18, R19)

| Task | Spec | Status |
| --- | --- | --- |
| JSON Schema validator module (`core/runner/src/schema-validator.ts`) with corrective, model-facing messages | R3 | ✅ |
| Runner validates tool inputs before execution; invalid input → `isError` result, no execution | R3 | ✅ |
| `LoopPolicy` on the agentic loop: max iterations, tool-call cap, graceful stop notice + `loop:limit` event | R1 | ✅ |
| Parallel tool execution with per-tool `serial` hint, concurrency limit, isolated results | R2 | ✅ |
| Universal output truncation policy in the runner (byte/line caps, head/tail preview, full output saved via FileStore when available) | R16 | ✅ |
| Error fidelity in openai-compat adapter: `is_error` serialized into tool-role content | R4 | ✅ |
| Malformed/truncated tool-call arguments degrade to a failed call (`parseError`) instead of aborting the turn (openai-compat + anthropic adapters) | R4 | ✅ |
| Orphaned tool-call finalization: aborted turns never persist unpaired `tool-call` blocks | R19 | ✅ |
| Doom-loop detection: repeated identical calls intercepted with corrective error | R6 | ✅ |
| Fine-grained `tool:delta` streaming of forming arguments | R18 | ⬜ |

## Phase 2 — Harness tool set + permissions (spec R8–R13)

| Task | Spec | Status |
| --- | --- | --- |
| Permission rule model: wildcard matching, last-match-wins evaluation, ruleset merge (`core/runner/src/permissions.ts`) | R8 | ✅ |
| Runner permission gate: allow / deny / ask; ask flow rides `PromptFn` with `permission:ask` / `permission:reply` events; "always" adds a session-approved rule; default action is `allow` so existing behavior is unchanged | R8, R9 | ✅ |
| New plugin package `packages/plugins/harness` (`@matatbread/matbot-tool-harness`, node) with `read`, `glob`, `grep`, `list`, `edit`, `write` tools confined to the session workspace root | R11, R12 | ✅ |
| `read`: line offsets, caps (2000 lines / 2000 chars per line / 50 KB), continue hints, binary sniffing, missing-file suggestions | R11 | ✅ |
| `edit`: exact unique-string replacement, multi-match errors, CRLF/BOM preservation, diff summary, read-before-edit enforcement | R12 | ✅ |
| `write`: overwrite guard (must read first; refuses changed-on-disk), creates directories, returns change summary | R12 | ✅ |
| `todowrite` tool: validated todo list per session, durable marker emission for UI rendering | R13 | ✅ |
| Formatter/LSP diagnostics feedback after edit/write | R12 | ⬜ |

## Phase 3 — Composition (spec R5, R7, R14, R15, R20)

| Task | Spec | Status |
| --- | --- | --- |
| Provider retry with backoff + `retry` status event | R5 | ⬜ |
| Automatic compaction and old-tool-output pruning | R7 | ⬜ |
| `task` subagent tool (nested loop, expert-panel integration) | R14 | ⬜ |
| Mega-tool schema decomposition | R15 | ⬜ |
| Layered system-context builder with lazy AGENTS.md discovery | R20 | ⬜ |

## Phase 4 — Parity polish (spec §11 phase 4)

Snapshots/revert, background subagents, apply_patch, release-gate tool evaluations: ⬜

## Test coverage

New Node test files (run via `npm test`, all temp-dir-confined):

- `tests/tool-use-runtime.test.mjs` — schema validator, loop budgets, parallel
  execution, doom-loop, orphan finalization, truncation, permission gate flows,
  denied-tool menu hiding.
- `tests/tool-use-harness.test.mjs` — harness tools end-to-end against temp dirs:
  read/glob/grep/list/edit/write/todowrite behaviors, confinement, caps.
- `tests/tool-use-adapters.test.mjs` — openai-compat conversion fidelity
  (`is_error` serialization, parseError tool calls).

## Verification

Full regression run after implementation (`npm run test:all` components):

| Suite | Result |
| --- | --- |
| Matbot monorepo typecheck (`pnpm -r typecheck`) | all packages pass |
| Node tests (`npm test`, includes the three new suites) | 272 tests — 266 pass, 0 fail, 6 pre-existing skips |
| Matbot CLI tests (`npm run test:cli`) | 5 pass, 0 fail |
| Playwright WebUI (`npm run test:webui`) | 144 passed, 0 failed (118 project-skipped as configured) |

Test isolation: harness tests create their fixture workspace via
`mkdtemp` under the system temp directory and remove it afterwards; runtime and
adapter tests are in-memory or stub `fetch`. No test touches paths outside the
system temp directory.

