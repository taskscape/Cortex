# Testing

> Part of the [Cortex Local Agent documentation](../README.md).

The repository has four test layers:

- Node tests in `tests\*.test.mjs` for backend/runtime behavior.
- Matbot CLI tests for ephemeral-store and workspace-storage isolation.
- Playwright WebUI tests in `tests\webui\matbot-webui.spec.mjs` for browser
  interactions against the real static WebUI and a fake Matbot server.
- The Playwright README question set in `tests\readme-qa\` for answer quality
  against a running Cortex, scored 0/1 by static rules.

Run the complete suite before treating a change as verified:

```powershell
npm run test:all
```

Run only the Node tests:

```powershell
npm test
```

Run the Matbot CLI isolation tests:

```powershell
npm run test:cli
```

Run the complete Playwright WebUI suite:

```powershell
npm run test:webui
```

First Playwright setup on a machine:

```powershell
npx playwright install chromium
```

Useful Playwright variants:

```powershell
# Desktop WebUI project only
npm run test:webui -- --project chromium

# Mobile WebUI project only
npm run test:webui -- --project mobile-chromium

# Run tests whose title matches a feature area
npm run test:webui -- --grep "workspace RAG"

# Debug a Playwright run locally
npm run test:webui -- --project chromium --headed --debug
```

The Playwright config starts `tests\webui\harness.mjs` on
`http://127.0.0.1:19787` and serves the same static frontend files used by the
Node WebUI. The harness implements fake Matbot transport endpoints for sessions,
tools, workspaces, files, plugins, skills, remembered facts, experts, and
workspace RAG, traces, evaluation suites, and ROI summaries. It validates WebUI behavior without calling real providers,
spending model tokens, writing production memory stores, or touching live RAG
databases.

Traces are retained on failure. Inspect a failing trace with:

```powershell
npx playwright show-trace <path-to-trace.zip>
```

Current Playwright coverage includes:

- shell load, providers, conversations, files, plugins, and skills;
- provider and font preference persistence;
- compatible plugin activation/deactivation and incompatible plugin display;
- workspace selector create/rename/delete/switch, including delete cancellation;
- workspace RAG settings save and ingestion progress display;
- remembered facts persisting across conversations;
- remembered facts isolated between workspaces;
- per-test memory reset in the Playwright harness;
- in-page memory browser create/edit/filter/delete/close behavior;
- `contextual_search` retrieval from remembered facts plus workspace RAG context;
- workspace RAG retrieval during conversation;
- source and connector health transport behavior;
- governed SQL planning, approval, execution, citations, and transient-error retry;
- workflow approval inspection and decisions;
- context graph relationship evidence;
- durable expert-review creation, recommendations, checklists, and risks;
- evaluation trace inspection and safe replay, regression-suite execution,
  sponsor metrics, responsive layout, and stale-selection protection;
- architecture tab semantics and keyboard navigation;
- expert panel all-expert and selected-expert composer flows;
- streaming output, tools, usage, and elapsed-time summary;
- interactive prompt controls;
- workspace file upload/delete;
- skill editor metadata, trigger controls, and confirmed deletion;
- session rename/hide/mark controls;
- send/stop busy behavior;
- mobile sidebar behavior.

## README question set (0/1 answer scoring)

`tests\readme-qa\readme-questions.json` is a static question set derived from
`README.md`. Every entry carries the question, the README passage that supports
it (`sourceQuote`), and a rubric of regular expressions:

- `expect.required` — groups of alternatives; each group must match once;
- `expect.forbidden` — patterns that must not appear.

An answer scores `1` only when every required group matches and no forbidden
pattern does, otherwise `0`. No model grades the answers, so the same answer
always produces the same score and a failure names the rule that was missed.
`tests\readme-qa\score.mjs` holds the scoring, normalizing markdown backticks
and whitespace before matching.

`tests\readme-qa.test.mjs` runs inside `npm test` and validates the rubric
itself without touching a model or the network: ids are unique, all patterns
compile, every `sourceQuote` still appears in `README.md`, each quote scores 1
against its own question, and non-answers score 0. A README edit that
invalidates a question fails there first.

The Playwright suite `tests\readme-qa\readme-qa.spec.mjs` asks each question
through the WebUI composer of a **running** Cortex — not the fake harness — so
real retrieval and a real provider answer it. Start Cortex first:

```powershell
scripts\run.ps1
npm run test:readme-qa
```

Each question runs in a fresh conversation, one Playwright test per question, so
the run reports 34 individual pass/fail results. Failures do not stop the suite;
every question is always scored. The run writes
`test-results\readme-qa\report.json`, `report.md` (the 0/1 table plus the reason
for each miss), and `answers.jsonl` (raw scored answers, appended as the run
proceeds so results survive Playwright's worker restart after a failure).

This suite is intentionally excluded from `npm run test:all`: it needs a live
Cortex and spends provider tokens.

Useful variants:

```powershell
# Score a single question by id
npm run test:readme-qa -- --grep "workspace-rag-cuda"

# Point at another Cortex instance
$env:CORTEX_WEBUI_URL = "http://127.0.0.1:19778"; npm run test:readme-qa

# Change what the assistant is told to answer from (retrieval probe)
$env:CORTEX_QA_PROMPT_PREFIX = "Answer from the workspace documentation. Question: "; npm run test:readme-qa
```

`CORTEX_QA_ANSWER_TIMEOUT_MS` (default 180000) and
`CORTEX_QA_TEST_TIMEOUT_MS` (default 240000) bound a slow turn.

Reading a failing run means separating three causes, which the stored answer
tells apart at a glance:

- **retrieval miss** — the answer says the README does not cover it. The corpus,
  not the rubric, is at fault: the workspace RAG context has to include
  `README.md` before the score means anything.
- **rubric too strict** — the answer is right but worded differently. Add the
  alternative to that required group.
- **wrong answer** — the content is confidently incorrect. This is the failure
  the suite exists to catch; do not widen the rubric to make it pass.

Tuning a pattern does not need another provider run. `rescore.mjs` re-applies
the current rubric to the answers of the last run and names every question whose
score moved:

```powershell
node tests/readme-qa/rescore.mjs
node tests/readme-qa/rescore.mjs --verbose   # print the stored answer for each miss
node tests/readme-qa/rescore.mjs --write     # rewrite report.json / report.md
```

Adding a question means adding one JSON entry — question, `sourceQuote` copied
from `README.md`, and the required/forbidden patterns. `npm test` then proves
the entry is answerable from the document before any model sees it.

Node tests cover:

- production memory capture using the real cognition tool and filesystem store;
- memory recall between conversations: a fact stated in one conversation reaching
  the next, sharing across every conversation in a workspace, and staying inside
  that workspace (`tests\memory-recall.test.mjs`);
- memory persistence after runtime recreation and isolation across workspace roots;
- production `dream_time` fact processing and run-record isolation;
- production memory-browser workspace switching and CAS conflict handling;
- before/after production-memory hashes to prevent test pollution;
- file-index storage and search;
- file-broker policy and write backups;
- hybrid KnowledgeIndex ranking/deduplication;
- expert-panel plugin behavior and isolated retrieval;
- workspace-rag runtime ingestion flow;
- end-to-end span capture, redaction, safe replay, deterministic and model-based
  scorers, model-cost accounting, workflow outcome linkage, and ROI arithmetic;
- harness tool-use runtime behavior — schema validation, loop budgets, parallel
  execution, doom-loop interception, orphaned tool-call finalization, output
  truncation, and permission gate flows (`tests\tool-use-runtime.test.mjs`,
  spec: [Tool Use Specification](tool-use-specification.md));
- the harness tools `read`/`write`/`edit`/`glob`/`grep`/`list`/`todowrite`
  end-to-end against temp-directory workspaces, including workspace confinement,
  read-before-edit enforcement, CRLF preservation, and result caps
  (`tests\tool-use-harness.test.mjs`);
- provider adapter error fidelity: `is_error` serialization on the
  OpenAI-compatible wire and degraded handling of truncated tool-call arguments
  (`tests\tool-use-adapters.test.mjs`).

Run only the evaluation and ROI backend coverage:

```powershell
node --test tests/evaluation-observability.test.mjs
```

Run only the cross-conversation memory coverage:

```powershell
node --test tests/memory-recall.test.mjs
```

Run only the workspace-switch handoff coverage:

```powershell
node --test tests/workspace-switch.test.mjs
```

## Guarded Docker and CUDA integration tests

The ordinary suite never starts Docker, rebuilds CUDA images, downloads an
embedding model, or deletes volumes. The guarded integration command creates a
generated `cortex-test-*` Compose project, an isolated temporary environment
file, and project-owned volumes; its cleanup removes only that generated
project.

Run it only on a disposable Docker host:

```powershell
$env:CORTEX_DOCKER_INTEGRATION = "1"
npm run test:integration:docker
```

The test checks Postgres/pgvector, Neo4j authentication, Mem0 API reachability,
and the documented password-rotation behaviour. Rotation intentionally uses
`down --volumes`, so the test proves fixture data is gone after recreation; it
does not and must not target a developer's existing Mem0 data.

CUDA checks require both Docker opt-in and an available NVIDIA Docker runtime:

```powershell
$env:CORTEX_DOCKER_INTEGRATION = "1"
$env:CORTEX_CUDA_INTEGRATION = "1"
npm run test:integration:cuda
```

This starts the MiniLM CUDA sidecar and polls its real health payload. To also
exercise the larger E5 model download, set `CORTEX_CUDA_E5_INTEGRATION=1`; it is
separate because a cold model cache materially increases run time.

The deterministic CUDA contract tests remain in `npm test`: they validate the
model, embedding dimensions, profile, normalization, and E5 prefixes against a
local fake sidecar without requiring a GPU.

That suite covers the two properties a switch depends on: shutdown releasing the
web port promptly even with a connection stuck mid-request, and the workspace
listing identifying the process that answered it — without which the WebUI cannot
tell a completed switch from the outgoing process still serving the previous
workspace's conversations.

Each recall scenario is reported as its own named subtest, so a regression names
the behavior that broke. The scenarios drive the real capture tool, recall hook,
and `contextual_search` over temp-directory stores — only the model is faked —
and the suite hashes every workspace's `remembered_facts` before and after to
prove it never touched real memory.
