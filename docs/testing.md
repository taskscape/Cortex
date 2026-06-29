# Testing

> Part of the [Cortex Local Agent documentation](../README.md).

The repository has two test layers:

- Node tests in `tests\*.test.mjs` for backend/runtime behavior.
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
- compatible plugin activation/deactivation and incompatible plugin display;
- workspace selector create/rename/switch;
- workspace RAG settings save and ingestion progress display;
- remembered facts persisting across conversations;
- `contextual_search` retrieval from remembered facts plus workspace RAG context;
- workspace RAG retrieval during conversation;
- expert panel all-expert and selected-expert composer flows;
- streaming output, tools, usage, and elapsed-time summary;
- interactive prompt controls;
- workspace file upload/delete;
- skill editor metadata and trigger controls;
- session rename/hide/mark controls;
- send/stop busy behavior;
- mobile sidebar behavior.

Node tests cover:

- file-index storage and search;
- file-broker policy and write backups;
- hybrid KnowledgeIndex ranking/deduplication;
- expert-panel plugin behavior and isolated retrieval;
- workspace-rag runtime ingestion flow.
