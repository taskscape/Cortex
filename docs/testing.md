# Testing

> Part of the [Cortex Local Agent documentation](../README.md).

The repository has three test layers:

- Node tests in `tests\*.test.mjs` for backend/runtime behavior.
- Matbot CLI tests for ephemeral-store and workspace-storage isolation.
- Playwright WebUI tests in `tests\webui\matbot-webui.spec.mjs` for browser
  interactions against the real static WebUI and a fake Matbot server.

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
  scorers, model-cost accounting, workflow outcome linkage, and ROI arithmetic.

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
