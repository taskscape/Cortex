# WebUI

> Part of the [Cortex Local Agent documentation](../README.md).

The WebUI is served by the frontend web plugin at `http://localhost:19778`.

Current UI capabilities include:

- conversation list and session controls;
- provider selector;
- main chat composer with send/stop behavior;
- token and elapsed-time summaries per turn;
- workspace file upload/list/delete;
- plugin catalog display;
- skill editor;
- workspace selector in the bottom-left corner;
- workspace creation, rename, confirmed deletion, and switch;
- full-page workspace settings editor for RAG context name and markdown folders;
- RAG ingestion progress, including current file;
- architecture source panels with freshness, sensitivity, citations, health
  findings, and limitations;
- governed SQL preview with row-cap warnings, approval, execution results, and
  query-result citations;
- Workflow Operations Center with operational counts, a governed compilation
  form, searchable workflow library, typed run inspection, event-ledger and
  evidence views, approval actions, shadow comparisons, and human outcome
  labeling;
- context graph entity panels with relationship evidence and confidence;
- durable expert review cards with recommendations, checklists, and risk
  registers;
- expert panel controls integrated into the main composer;
- mobile sidebar behavior.

The WebUI uses the same Matbot tool APIs as the model. When the UI says a plugin
is unavailable, the active Matbot process usually does not have that plugin
loaded. Restart with:

```powershell
.\scripts\run.ps1
```

Then hard-refresh the browser.
