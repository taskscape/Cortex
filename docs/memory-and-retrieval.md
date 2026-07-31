# Memory And Retrieval

> Part of the [Cortex Local Agent documentation](../README.md).

Cortex has several related but distinct retrieval layers.

## Memory ("remember my name")

The `cognition` plugin's `remember_fact` tool captures durable user facts into
the `remembered_facts` store. The automatic trigger for this lives in the
combination of `skills`, `triggers`, and `cognition`: the trigger notices
messages that look memory-worthy, then invokes `remember_fact` as a silent side
effect. The model does not need to reply with a tool result for the fact to be
stored.

Example user messages that should become durable facts:

```text
Memorize my name: Maciej Zagozda
Remember that I prefer PowerShell on Windows
My Siemens docs are in C:\Projects\Siemens\docs
```

For the name example, the intended path is:

1. The user asks Cortex to memorize the name.
2. `triggers` classifies the message as matching the memory trigger.
3. `remember_fact` extracts the actual fact: `The user's name is Maciej Zagozda.`
4. The fact is written to `remembered_facts` with session/message provenance.
5. A later conversation can retrieve it through `contextual_search`.

Recall and storage are separate. A fact can be correctly stored but not appear
in an answer if the model does not call retrieval or if the needed memory context
is not injected. This is why `contextual_search` now searches raw
`remembered_facts` directly instead of waiting for `dream_time`.

## Automatic recall (memory injection)

`contextual_search` can only retrieve a fact once the model has decided it is
missing context — which is exactly the judgement a model cannot make about a name
or a server it has no reason to suspect exists. So recall does not depend on the
model electing to call it.

The `rumsfeld` plugin registers a `screen` hook that scores every incoming user
message against `remembered_facts` and injects the matches as ephemeral context
for that turn, in the same way `workspace-rag` injects document snippets. This is
what makes a **new conversation** start out knowing what earlier ones in the same
workspace established. It is local scoring only — no LLM call, no added latency —
and a firing injection leaves a `rumsfeld` marker (`event: "memory-inject"`) on
the session, so a post-mortem can tell whether the model answered from memory or
in spite of it.

Matching is lexical, weighted so that rare tokens (a name, `HELIOS-7`) count for
much more than shared vocabulary (`user`, `name`), with diacritic folding and
five-character stemming so inflected languages match at all
(`serwerze`/`serwer`/`serwerowni` collapse together). Three rules keep it from
firing on coincidence:

- a fact must be explained by at least two query tokens, unless one of them is
  identifier-like (rare *and* full-length) — so a server name alone is enough,
  but a shared `jest` or `the` is not;
- query words that appear in no fact at all are ignored rather than counted
  against a fact, so recall does not depend on how much padding surrounds the
  word that matters;
- a fact is scored by the better of "how much of the fact the query explains"
  and "how much of the query the fact explains", so both a one-line fact and a
  long pasted note stay reachable.

Two consequences worth knowing:

- a fact stays reachable through a shared proper noun even when the question is
  asked in another language;
- a question whose *general vocabulary* is in a different language from the fact
  will not match ("Jak sie nazywam?" does not retrieve "The user's name is
  Maciej Zagozda"). Cross-language semantic recall is the `KnowledgeIndex`'s job,
  and needs Mem0 reachable.

`contextual_search` remains registered for deliberate mid-turn lookups over the
knowledge index and workspace RAG.

`dream_time` is slower consolidation, not immediate recall. It processes
unassigned remembered facts and, when a fact strongly matches a skill, merges it
into skill markdown so it becomes part of the long-term skills/knowledge layer.

The default provider was changed to `gpt-4o` because weaker models previously
produced spurious refusals such as "I can't store personal information" even
when the user explicitly asked Cortex to remember a harmless name. The extraction
prompt in `packages/plugins/cognition/src/remember/tool.ts` is tuned so explicit
"remember" or "memorize" requests store the fact, not the instruction.

If name recall fails, inspect the store directly with
`remembered_facts_action`. If the fact exists there, the storage side worked and
the issue is retrieval/injection/model behavior. If it does not exist, check
that `skills`, `triggers`, and `cognition` are loaded in the active workspace.

## `remembered_facts`

`remembered_facts` is the raw durable memory store written by `remember_fact`.
It is best for facts explicitly worth remembering, such as names, stable
preferences, decisions, project facts, and reusable troubleshooting outcomes.

Document shape:

```ts
interface RememberedFact {
  id: string;
  version: string;
  fact: string;
  sessionId: string;
  messageId: string;
  createdAt: string;
  dreamSkill?: string;
  ignoreUntil?: string;
}
```

Explore remembered facts from PowerShell:

```powershell
$body = @{
  action = "query"
  query = @{
    limit = 50
    sort = @(@{ field = "createdAt"; dir = "desc" })
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:19778/tools/remembered_facts_action `
  -ContentType "application/json" `
  -Body $body |
  ConvertTo-Json -Depth 8
```

Search by substring:

```json
{
  "action": "query",
  "query": {
    "where": {
      "op": "stringContains",
      "field": "fact",
      "value": "Maciej"
    },
    "limit": 10
  }
}
```

Read one fact:

```json
{
  "action": "get",
  "id": "remembered-fact-id"
}
```

Create or replace manually:

```json
{
  "action": "set",
  "data": {
    "fact": "The user's preferred shell on Windows is PowerShell.",
    "sessionId": "manual",
    "messageId": "manual",
    "createdAt": "2026-06-28T00:00:00.000Z"
  }
}
```

Correct safely with compare-and-swap:

```json
{
  "action": "cas",
  "id": "remembered-fact-id",
  "expected": "version-from-get",
  "data": {
    "fact": "The user's name is Maciej Zagozda.",
    "sessionId": "original-session-id",
    "messageId": "original-message-id",
    "createdAt": "2026-06-28T06:12:37.262Z"
  }
}
```

Delete:

```json
{
  "action": "delete",
  "id": "remembered-fact-id",
  "expected": "version-from-get"
}
```

Omit `expected` only when you intentionally want an unconditional delete.

## `KnowledgeIndex`

`KnowledgeIndex` is the runtime retrieval service interface used by plugins.
In this repository, `hybrid-knowledge-index` registers an implementation that
queries Mem0 and file-index, ranks results, and deduplicates them.

Mem0 memory is strictly workspace-scoped. Every workspace, including default,
uses `<MEM0_USER_ID>:workspace:<workspace-id>`. Legacy records stored under the
old unscoped id are left intact but are no longer queried, preventing historical
cross-workspace entries from polluting current recall. Local cognition stores such as
`remembered_facts` and `dream_runs` are also physically separated under the
active workspace's own `.data` directory.

Ephemeral CLI runs use in-memory stores for every document namespace, including
remembered facts, dream runs, settings, skills, triggers, and store-tool data.
They cannot write to a workspace's persistent memory backend.

Skills also mirror saved skill content into the active `KnowledgeIndex`.
`KnowledgeIndex` is not the same as `remembered_facts`: facts are stored raw in
`remembered_facts`; skills and indexed entries are searched through
`KnowledgeIndex`; `contextual_search` bridges both.

## Workspace RAG Retrieval

Workspace RAG is scoped to the active Cortex workspace and its active RAG
context. It is file-backed markdown retrieval with per-workspace persistence.
It injects relevant snippets automatically before each model turn and can also
be queried by `workspace_rag` and `contextual_search`. In normal Docker-backed
startup, Postgres/pgvector stores vectors, document hashes, chunk text, and
metadata in the `workspace_rag` schema. The older
`.data\workspace-rag\index.json` file is retained only as a fallback or
diagnostic storage mode.

The proposed successor architecture for million-document and multi-gigabyte
sources is described in
[`hybrid-retrieval-architecture.md`](hybrid-retrieval-architecture.md). It adds
streaming ingestion, immutable versions, document/section/passage hierarchy,
lexical plus dense retrieval, reranking, and deterministic range citations.

## `contextual_search` Retrieval

Use `contextual_search` when the model needs local context before answering. It
searches remembered facts, the active `KnowledgeIndex`, and workspace RAG. This
is why a remembered name can be found before `dream_time` has merged that fact
into a skill.

## `memory-policy.json`

`local-agent\config\memory-policy.json` documents what Cortex should treat as
durable memory:

- durable kinds: `preference`, `decision`, `project-fact`,
  `troubleshooting-outcome`, `domain-term`, `implementation-note`;
- do not store: raw file content, secrets, temporary command output, large logs,
  duplicate index content;
- promotion requires: explicit user request, stable fact, reusable decision, or
  confirmed recurring solution.

It is a policy file for humans and future automation. The active memory tools
still enforce their own schemas and prompts.
