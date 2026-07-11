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
workspace RAG. It validates WebUI behavior without calling real providers,
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
- memory persistence after runtime recreation and isolation across workspace roots;
- production `dream_time` fact processing and run-record isolation;
- production memory-browser workspace switching and CAS conflict handling;
- before/after production-memory hashes to prevent test pollution;
- file-index storage and search;
- file-broker policy and write backups;
- hybrid KnowledgeIndex ranking/deduplication;
- expert-panel plugin behavior and isolated retrieval;
- workspace-rag runtime ingestion flow.
