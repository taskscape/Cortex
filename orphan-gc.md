# Workspace RAG — Orphan Garbage Collection (`orphan-gc`)

Implementation plan for durably reclaiming database and object-store state when
folders are removed from a workspace context (or an entire context is deleted).

Status: **implemented, including the separately gated managed object-store blob
GC phase.**

---

## 1. Problem statement (verified findings)

Removing one or more folders from **Workspace Settings → Save** behaves as follows today:

| Step | Where | Effect |
|---|---|---|
| Save persists folder list | `local-agent/matbot/packages/plugins/workspace-rag/src/index.ts:1047-1083` (`configureCurrent`) | Rewrites `cortex-rag.json` next to `matbot.yaml`. Pure JSON — always succeeds, no DB involved. |
| Watchers rebuilt | `index.ts:997-1038` (`refreshWatchers`) | Watcher on removed root is closed correctly. |
| Reconcile scheduled | `index.ts:1081` (`requestV2Reconcile(..., 'configuration', ...)`) | New ingestion generation is staged asynchronously in `v2/manager.ts` (`startIngestion`, lines ~1229-1451). |
| Membership pruned | `v2/postgres-repository.ts:843-858` (`reconcileGeneration`) | **Only** `publication_documents` rows for paths absent from the new scan are deleted. Retrieval is scoped to the active generation id, so content becomes invisible. |

### What is never deleted (the orphans)

1. **`documents` rows** (`document_version_id` PK) — nothing in the codebase ever
   deletes from `documents`. Cascades to `sections` / `passages`
   (`postgres-repository.ts:1311`, `:1348`) therefore never fire.
2. **`sections`** and **`passages`** rows (full chunk text lives in Postgres).
3. **Embedding vectors** in `unit_embeddings_<dims>` keyed by
   `(embedding_signature, level, unit_id)` with columns `document_version_id`,
   `workspace_id`, `context_id` (`postgres-repository.ts:1541-1554`). Passage
   eviction (`evictColdPassageEmbeddings`) only evicts *cold* vectors of the
   *active* generation by capacity — unrelated to removals.
4. **Retired generations**: `publishGeneration` (`postgres-repository.ts:327-356`)
   flips the prior publication to `active=FALSE, state='retired'`; retired
   publications and all their `publication_documents` / `collections` rows are
   kept forever. `HybridSearchBackend.deleteRetiredGeneration`
   (`v2/search-backend.ts:72`, implemented at `:226` no-op and `:359`) exists but
   **has no caller**.
5. **Object-store blobs**: content-addressed files under
   `<store-root>/objects/sha256/<h[0:2]>/<h[2:4]>/<sha256>/source.md` plus
   `lines.tsv` (and `manifest.json` in `manifest_only` mode)
   (`v2/object-store.ts:331-362`). Only staging temp files are ever cleaned.
6. **`routing_summaries`**, **`derivative_jobs`**, **`ingestion_jobs` /
   `ingestion_job_items`** history for removed paths.
7. **Whole-context deletion is worse**: `deleteContextCurrent`
   (`index.ts:1132-1147`) filters the JSON config and rewrites it. No reconcile,
   no DB purge of any kind.

Additional hazard: if any file failed during the reconcile run
(`job.failedFiles > 0`) or an unavailable configured root still had indexed
documents (`manager.ts:1258-1271`), even membership pruning is deferred
(`job.deletionsDeferred`, `manager.ts:1360-1368`) — so the active publication can
keep serving removed-folder content until a later clean run.

### Goal

After a folder is removed entirely from a context's path list (or a context is
deleted), all DB rows and managed object-store blobs belonging to that content
must be reclaimed automatically, without breaking:

- concurrent ingestion runs,
- resume-after-interrupt semantics (`resumableGeneration`),
- cross-generation document-version reuse (fingerprints),
- retrieval audit trails that reference old generations,
- multi-workspace sharing of one content-addressed blob store.

Non-goals: changing the ingestion pipeline shape, adding new persistence outside
the existing schema, purging audit tables beyond their existing TTL
(`pruneExpiredAuditRecords`, `postgres-repository.ts:195-216`).

---

## 2. Design overview

Three coordinated mechanisms:

1. **Orphan sweep (core)** — a repository-level `pruneOrphans(workspaceId, contextId)`
   that deletes `documents` (and via existing FK cascades, `sections`/`passages`)
   whose versions are referenced by **no live publication**, then deletes
   embeddings, routing summaries, and job history left dangling.
2. **Trigger wiring** — run the sweep automatically after a successful
   configuration-change publish, after a later successful run clears
   `deletionsDeferred`, periodically alongside the existing reconcile timer, and
   immediately (as a full purge) on context deletion.
3. **Blob GC (phase 2)** — conservative, optional reclamation of unreferenced
   content-addressed source objects; only in `managed` retention mode.

### Definition of "orphan" (must be implemented exactly)

A `documents` row `(workspace_id, context_id, document_version_id)` is an orphan
iff **no** row in `publication_documents` references its `document_version_id`
via a publication whose `state` is `'active'`-family (`active_lexical`,
`active_hybrid_partial`, `active_hybrid_complete`) **or** `'staging'`.

Rationale:

- `staging` must be in the keep-set because `beginGeneration`
  (`postgres-repository.ts:223-248`) seeds the staging generation's membership
  from the active publication and new documents are written into `documents`
  before publish; excluding staging would delete in-flight work mid-run.
- `'retired'` publications do **not** protect a version. This intentionally makes
  retired generations lossy once their data is superseded — see §5 for the
  companion retired-generation GC that removes the now-empty shells.
- A grace period (§4, Task 6) covers the window between job creation and
  `beginGeneration` where a staging row does not exist yet.

Everything else follows transitively:

| Artifact | Reclaimed by |
|---|---|
| `sections`, `passages` | Existing `ON DELETE CASCADE` from `documents.document_version_id` |
| passage embeddings (`unit_embeddings_*`, `level='passage'`) | Explicit delete on `document_version_id` (no FK exists) |
| collection embeddings | Explicit delete where the unit's `collections` row no longer exists (collections cascade with their publication) |
| `routing_summaries` | Explicit delete by orphaned `document_version_id` / dead `generation_id` |
| stale `ingestion_job_items` | Explicit delete for jobs older than the grace window |

---

## 3. Repository contract changes

All changes go through the shared interface so both backends stay in parity:
`v2/repository.ts:126` (`RagV2Repository`), implementations in
`v2/postgres-repository.ts` and `v2/memory-repository.ts`.

```ts
/** Result summary of one orphan sweep. */
export interface RagV2GcResult {
  documentsDeleted: number;
  passagesDeleted: number;      // reported even though cascaded
  sectionsDeleted: number;
  embeddingsDeleted: number;
  collectionsDeleted: number;   // via retired-publication GC
  routingSummariesDeleted: number;
  blobsDeleted: number;         // phase 2; 0 otherwise
  deletionsSkipped: boolean;    // true when safety gates prevented deletion
}

interface RagV2Repository {
  // existing members...

  /**
   * Deletes documents of the workspace/context that are referenced by no
   * active or staging publication and are older than the grace period,
   * plus their dependent embeddings, summaries, and job history.
   * Must be a no-op returning deletionsSkipped=true while any ingestion
   * job for this workspace/context is non-terminal.
   */
  pruneOrphans(
    workspaceId: string,
    contextId: string,
    olderThan: string, // ISO timestamp cutoff on documents.modified_at
  ): Promise<RagV2GcResult>;

  /** Deletes retired publications older than the cutoff (shells only; documents were already swept). */
  pruneRetiredGenerations(workspaceId: string, contextId: string, olderThan: string): Promise<number>;

  /** Deletes every row of every table scoped to the context. Used by delete_context. */
  purgeContext(workspaceId: string, contextId: string): Promise<void>;
}
```

---

## 4. Task list

### Task 1 — Postgres: implement `pruneOrphans`

File: `local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts`

Run inside `this.withWorkspace(workspaceId, ...)` (respects the existing RLS /
role setup from `enableRowSecurity` / `grantApplicationRole`). Use a parameterized
live-set CTE so the keep-set is computed once:

```sql
WITH live AS (
  SELECT DISTINCT pd.document_version_id
  FROM publication_documents pd
  JOIN publications p ON p.generation_id = pd.generation_id
  WHERE pd.workspace_id = $1 AND pd.context_id = $2
    AND (p.state LIKE 'active%' OR p.state = 'staging')
),
doomed AS (
  SELECT d.document_version_id, d.content_sha256
  FROM documents d
  WHERE d.workspace_id = $1 AND d.context_id = $2
    AND d.modified_at < $3::timestamptz          -- grace-period cutoff
    AND NOT EXISTS (
      SELECT 1 FROM live WHERE live.document_version_id = d.document_version_id
    )
  LIMIT $4                                        -- bounded batches (e.g. 2000)
)
DELETE FROM unit_embeddings_<dims> e              -- per-dims table name via getEmbeddingsTable()
WHERE e.level = 'passage'
  AND e.document_version_id IN (SELECT document_version_id FROM doomed);
-- then:
DELETE FROM documents WHERE document_version_id IN (SELECT document_version_id FROM doomed);
-- sections/passages follow via existing ON DELETE CASCADE
```

Then in the same transaction:

```sql
-- collection embeddings whose collection row vanished with a deleted publication
DELETE FROM unit_embeddings_<dims> e
WHERE e.workspace_id = $1 AND e.context_id = $2 AND e.level = 'collection'
  AND NOT EXISTS (
    SELECT 1 FROM collections c WHERE c.collection_version_id = e.unit_id
  );

-- routing summaries pointing at swept documents or dead generations
DELETE FROM routing_summaries r
WHERE r.workspace_id = $1 AND r.context_id = $2
  AND (
    (r.document_version_id IS NOT NULL AND r.document_version_id IN (
       SELECT d.document_version_id FROM documents d
       WHERE d.workspace_id = $1 AND d.context_id = $2
         AND d.modified_at < $3::timestamptz
         AND NOT EXISTS (SELECT 1 FROM live WHERE live.document_version_id = d.document_version_id)))
    OR NOT EXISTS (
      SELECT 1 FROM publications p WHERE p.generation_id = r.generation_id
        AND (p.state LIKE 'active%' OR p.state = 'staging'))
  );
```

Notes:

- Table names must go through `this.table(...)` and `getEmbeddingsTable()` —
  schema-qualified, identifier-quoted (see `postgres-repository.ts:1205-1212`).
- The `state LIKE 'active%'` predicate matches how publication states are
  written in `publishGeneration` (`active_lexical` | `active_hybrid_partial` |
  `active_hybrid_complete`). Prefer an explicit `IN (...)` list over `LIKE`.
- Batch with `LIMIT` + loop (or keyset pagination) to avoid long transactions on
  large corpora; return aggregate counts.
- Wrap the whole sweep in one transaction per batch so a crash cannot leave
  embeddings deleted without their documents (or vice versa). Deleting the
  embeddings first inside the same transaction keeps the invariant trivially.

### Task 2 — Postgres: implement `pruneRetiredGenerations`

Same file. Mirrors `pruneStagingGenerations` (`postgres-repository.ts:284-295`):

```sql
DELETE FROM publications
WHERE workspace_id = $1 AND context_id = $2
  AND state = 'retired' AND published_at < $3::timestamptz
```

Cascade removes `publication_documents` and `collections` for those shells.
Call `deleteRetiredGeneration(generationId)` on the search backend for each
removed generation when one is configured (finally giving
`search-backend.ts:72` its first caller; the Postgres backend implementation at
`:359` and memory no-op at `:226` already exist).

Ordering constraint: **run after `pruneOrphans`** in the same cycle, and only
delete a retired shell once none of its document versions can still be needed —
since retired publications are excluded from the live-set by design, the safe
sequence per GC cycle is: `pruneOrphans` → `pruneRetiredGenerations`.
(Alternative considered and rejected: keeping retired publications in the
live-set forever, which reintroduces unbounded growth.)

### Task 3 — Memory backend parity

File: `local-agent/matbot/packages/plugins/workspace-rag/src/v2/memory-repository.ts`

Implement the same three methods over the in-memory maps using the identical
orphan predicate (documents not referenced by any active/staging generation's
membership and older than the cutoff). The memory backend is used in fallback
mode and tests; exact semantic parity matters because tests assert against it.
Return zeroed-but-valid `RagV2GcResult` fields where N/A.

### Task 4 — Manager integration: post-publish sweep

File: `local-agent/matbot/packages/plugins/workspace-rag/src/v2/manager.ts`

In `startIngestion`'s success path (after `publishGeneration` at
`manager.ts:1413` and the `sourceBridge.markRemoved` call at `:1414-1418`):

1. If `job.removedFiles > 0` or the previous job for the context had
   `deletionsDeferred === true` (clearable here — check via
   `currentJob`/a stored flag), schedule the sweep.
2. Never sweep inline on the ingestion hot path — enqueue onto a low-priority
   async task guarded by a per-(workspace, context) mutex so it cannot overlap
   another ingestion. Reuse/adapt the lazy-worker pattern
   (`startLazyWorker` / `runLazyWorker`, `manager.ts:1985-2058`).
3. Safety gate inside the sweep: if `currentJob(workspaceId, contextId)` returns
   a job in a non-terminal state, set `deletionsSkipped = true` and reschedule
   (exponential backoff, max ~1 h).
4. Record the result on the job message / plugin log (`this.log(...)`) and
   console, following the existing `[workspace-rag-v2]` prefix conventions.

Also handle the deferred-deletion recovery path: when a run completes cleanly
after a previous `deletionsDeferred` run, `reconcileGeneration` already prunes
membership; the sweep then reclaims the underlying rows. No special casing
beyond reading the previous job's flag.

### Task 5 — Index integration: triggers

File: `local-agent/matbot/packages/plugins/workspace-rag/src/index.ts`

1. **Periodic sweep** — extend the existing interval loop built around
   `CORTEX_RAG_RECONCILE_INTERVAL_MS` (`index.ts:827-841`, `reconcileAll` at
   `:951-970`) with an independent, slower GC timer (default: 6 h, jittered).
   Iterate `listWorkspaces()` × `config.contexts` exactly like `reconcileAll`.
2. **Post-configure hook** — in `requestV2Reconcile` completion for trigger
   `'configuration'` (already invoked from `configureCurrent`, `index.ts:1081`)
   the manager-side Task 4 hook fires; no additional index change needed beyond
   config plumbing (Task 8).
3. **Manual action** — add `action: 'gc'` to the `workspace_rag` tool input
   union (dispatch around `index.ts:1996-2018`, action handlers near
   `:2059-2063` where `embedding_evict` lives). Accept optional
   `{ contextId?: string }`, default to the current context; return the
   `RagV2GcResult`. Update the tool description's discriminated-union contract
   accordingly (multi-action tool convention from matbot CLAUDE.md).

### Task 6 — Context deletion purge

Files: `index.ts` (`deleteContextCurrent`, lines 1132-1147) and both repositories.

Change `deleteContextCurrent` to call `repository.purgeContext(workspace.id, context.id)`
after rewriting `cortex-rag.json`. Implementation (Postgres):

```sql
DELETE FROM publications        WHERE workspace_id = $1 AND context_id = $2;  -- cascades pub_documents + collections
DELETE FROM documents           WHERE workspace_id = $1 AND context_id = $2;  -- cascades sections + passages
DELETE FROM unit_embeddings_<dims> WHERE workspace_id = $1 AND context_id = $2;
DELETE FROM routing_summaries   WHERE workspace_id = $1 AND context_id = $2;
DELETE FROM derivative_jobs     WHERE workspace_id = $1 AND context_id = $2;
DELETE FROM ingestion_job_items WHERE workspace_id = $1 AND context_id = $2;
DELETE FROM ingestion_jobs      WHERE workspace_id = $1 AND context_id = $2;
```

Deliberately retained: `retrieval_runs` / `regex_runs` / evaluation tables
(audit trail; already TTL-managed). If the search backend is OpenSearch,
iterate remaining generation ids for the context and call
`deleteRetiredGeneration` before dropping the Postgres rows.

Guard: refuse to purge while a job for the context is non-terminal (mirror the
Task 4 gate); if one is running, cancel it first via the existing cancel path
(`cancelRequested`) and wait, or defer the purge to the periodic sweep with a
tombstone note in the plugin log. Choose the simpler option (defer) unless the
cancel path is already safe to await.

### Task 7 — Blob GC (phase 2, separate PR)

File: `v2/object-store.ts` (+ a small registry of known hashes).

Only meaningful when `retentionMode === 'managed'` (`object-store.ts:87-97`);
skip silently otherwise (`external_immutable` files are owned externally;
`manifest_only` retains no bytes).

Algorithm (conservative, cross-workspace safe because the store is
content-addressed across everything sharing the root):

1. Collect the referenced-hash set: `SELECT DISTINCT content_sha256 FROM documents`
   **across all workspaces/contexts** served by this store root (one query; add
   a repository method `listReferencedContentHashes(): Promise<Set<string>>`).
2. Walk `<root>/objects/sha256/*/*/*/source.md`, derive each hash from the path,
   and delete the hash directory (source.md, lines.tsv, manifest.json) when
   unreferenced **and** its file mtime is older than the grace period.
3. Rate-limit deletions and cap per-cycle deletions (e.g. 500 dirs) to bound IO.
4. Wire behind its own env flag (Task 8), off by default initially.

Race safety: a concurrent ingestion may `putFile` a blob before its `documents`
row exists. The mtime grace period closes this window (blobs younger than the
grace period are never collected), which is why the same grace constant guards
both DB and blob phases.

### Task 8 — Configuration & environment

Follow the existing env-var style (`CORTEX_RAG_*`, parsed near
`postgres-repository.ts:114` / `index.ts:827`):

| Variable | Default | Meaning |
|---|---|---|
| `CORTEX_RAG_V2_GC_ENABLED` | `true` | Master switch for automatic sweeps |
| `CORTEX_RAG_V2_GC_INTERVAL_MS` | `21600000` (6 h) | Periodic sweep cadence |
| `CORTEX_RAG_V2_GC_GRACE_MS` | `3600000` (1 h) | Min age of orphaned rows/blobs before deletion |
| `CORTEX_RAG_V2_GC_BATCH_SIZE` | `2000` | Per-transaction delete batch |
| `CORTEX_RAG_V2_RETIRED_GENERATION_TTL_MS` | `604800000` (7 d) | Age before retired shells are dropped |
| `CORTEX_RAG_V2_BLOB_GC_ENABLED` | `false` | Phase-2 blob collection |

Invalid values must fall back to defaults with a `[workspace-rag-v2]` warning,
matching existing env parsing behavior.

### Task 9 — Observability

- Log each sweep at warn/info level with the `RagV2GcResult` counts and
  duration; log skips (`deletionsSkipped`) with reason.
- Add last-GC info (timestamp + counts) to `v2StatusCurrent` output
  (`index.ts:1149+`) so the UI can show "last cleanup".
- Extend the plugin `log()` audit entries with a `'gc'` kind alongside
  `'configure'`, `'delete_context'`, etc.

---

## 5. Correctness & concurrency checklist (implementation gates)

Every task above must satisfy these invariants; call them out in review:

- [ ] A document version reachable from **any** active or staging publication is
      never deleted — including versions seeded into a staging generation by
      `beginGeneration` before any file was processed.
- [ ] Sweeps never run concurrently with a non-terminal ingestion job for the
      same (workspace, context). Gate checked inside the repository method, not
      only at the call site.
- [ ] Embedding deletes and their document deletes share a transaction.
- [ ] Grace period applied to both DB rows and blobs (covers the putFile-before-
      documents-row race and the createJob-before-beginGeneration gap).
- [ ] Resume-after-interrupt unaffected: `resumableGeneration` fingerprints come
      from `publication_documents` of the staging generation, which the sweep
      treats as live.
- [ ] Cross-workspace hash sharing respected by blob GC (global reference set).
- [ ] Memory and Postgres backends pass the same test suite (parity).
- [ ] `purgeContext` leaves audit tables intact and is idempotent (safe to
      retry; `DELETE` on missing rows is naturally a no-op).
- [ ] No new tables required; migration 8 in `runMigrations`
      (`postgres-repository.ts:1653+`) is only needed if indexes are added
      (candidate: partial index on `publications(state) WHERE state='retired'`).

## 6. Testing plan

The package currently ships no test suite (only `typecheck` script in
`package.json`); add tests under `packages/plugins/workspace-rag/test/` using
the repo's chosen runner (check `apps/cli` / sibling packages for the vitest
convention before writing):

1. **Unit (memory backend)** — ingest two folders; remove one from paths;
   simulate reconcile; run sweep; assert documents/passages/embeddings for the
   removed folder are gone and the surviving folder untouched.
2. **Staging protection** — start a job (staging generation created, new docs
   written), run sweep mid-flight, assert no in-flight version is deleted.
3. **Grace period** — orphaned rows younger than cutoff survive; older ones go.
4. **Busy gate** — non-terminal job ⇒ `deletionsSkipped = true`, no deletes.
5. **Retired shells** — publish twice, age the first generation past TTL, sweep,
   assert publication + membership + collections gone, documents swept.
6. **purgeContext** — delete context; assert zero rows remain in all
   context-scoped tables except audit tables.
7. **Blob GC (phase 2)** — temp-dir store; remove folder; sweep with blob GC
   enabled; assert unreferenced hash dir removed, referenced one retained,
   fresh blob retained despite being unreferenced.
8. **Integration (optional, env-gated)** — against real Postgres + pgvector when
   `CORTEX_RAG_TEST_POSTGRES_URL` is set; skipped otherwise.

Typecheck gate: `pnpm --filter @matatbread/matbot-workspace-rag typecheck`.

## 7. Rollout

1. **PR 1**: Tasks 1–4, 6, 8–9 (DB sweep, purge-on-delete, triggers, config) —
   blob GC off, retired-TTL default 7 days. This alone fixes the reported leak.
2. **PR 2**: Task 5 tool action polish + status surface (if not already in PR 1).
3. **PR 3**: Task 7 blob GC behind `CORTEX_RAG_V2_BLOB_GC_ENABLED`.
4. CHANGELOG entry under `## Unreleased` → **Bug fixes** ("Workspace RAG V2:
   removing a folder or deleting a context now reclaims orphaned documents,
   passages, embeddings, and objects") — functional change, per repo changelog
   rules.
