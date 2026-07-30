/**
 * Memory recall scenarios, run under the Matbot TypeScript loader against the real capture tool
 * (`remember_fact`), the real recall hook (`createMemoryInjectionHook`), the real `contextual_search`
 * tool, and real filesystem-backed stores. Only the model is faked — a deterministic extractor stands
 * in for the one judgement call `remember_fact` makes.
 *
 * Every scenario runs in its own temp workspace tree, so nothing here can see or touch a production
 * `.data` directory (the parent test asserts that too).
 *
 * Each scenario reports one `##RESULT##` line, which the parent test turns into a named subtest, so a
 * failure names the behaviour that broke rather than "the memory runtime failed".
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const matbot = "../local-agent/matbot";
const { FilesystemStore } = await import(`${matbot}/packages/plugins/storage/filesystem/src/store.ts`);
const { createRememberFactTool } = await import(`${matbot}/packages/plugins/cognition/src/remember/tool.ts`);
const { createMemoryInjectionHook, createRumsfeldPlugin } = await import(`${matbot}/packages/plugins/rumsfeld/src/index.ts`);
const { createConstantPrincipalCarrier, installPrincipalCarrier } = await import(`${matbot}/packages/core/plugin-api/src/index.ts`);

installPrincipalCarrier(createConstantPrincipalCarrier({ id: "memory-recall-test", type: "user" }));

// Stands in for the extraction call `remember_fact` makes. Deliberately dumb: a question yields no
// fact, an explicit "remember/zapamietaj" yields what follows it, anything else yields the statement.
function fakeExtractor(prompt) {
  const text = prompt.trim();
  if (text.endsWith("?")) return [];
  const explicit = /(?:remember(?: this)?|zapamietaj)\s*[:,]?\s*(.+)$/is.exec(text)?.[1]?.trim();
  return [explicit ?? text];
}

function createWorkspace(workspaceDir) {
  const stores = new Map();
  let modelCalls = 0;
  const createStore = namespace => {
    let store = stores.get(namespace);
    if (!store) {
      store = new FilesystemStore(path.join(workspaceDir, ".data", namespace));
      stores.set(namespace, store);
    }
    return store;
  };
  const services = {
    configPath: path.join(workspaceDir, "matbot.yaml"),
    providers: new Map([["fake", { name: "fake" }]]),
    createStore,
    singleTurn: async req => {
      modelCalls += 1;
      return { text: JSON.stringify(fakeExtractor(req.prompt)), usage: { inputTokens: 1, outputTokens: 1 } };
    },
    modelCalls: () => modelCalls,
  };
  return services;
}

let sequence = 0;
function session(text, options = {}) {
  const id = options.id ?? `session-${++sequence}`;
  const timestamp = new Date().toISOString();
  return {
    id,
    version: "v1",
    status: "active",
    contexts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: text === undefined ? [] : [{
      id: `${id}-message`,
      traceId: `${id}-trace`,
      role: "user",
      createdAt: timestamp,
      content: [{ type: "text", text, ...(options.origin !== undefined ? { origin: options.origin } : {}) }],
    }],
  };
}

function toolContext(currentSession) {
  return {
    callId: `call-${currentSession.id}`,
    session: currentSession,
    provider: "fake",
    signal: new AbortController().signal,
    vault: {},
    prompt: async () => "",
    loadPlugin: async () => { throw new Error("not used"); },
    unloadPlugin: async () => false,
  };
}

async function drain(tool, input, context) {
  const events = [];
  for await (const event of tool.executor.execute(input, context)) events.push(event);
  return events;
}

/** Capture whatever durable fact the message holds, exactly as the trigger would fire it. */
async function say(services, text, options) {
  const conversation = session(text, options);
  await drain(createRememberFactTool(services), {}, toolContext(conversation));
  return conversation;
}

/** What the model would see prepended to its turn, when a NEW conversation asks `text`. */
async function ask(services, text, options) {
  const result = await createMemoryInjectionHook(services).handler({
    session: session(text, options),
    config: { provider: "fake" },
    signal: new AbortController().signal,
    removeHook: () => {},
  });
  return { injected: result?.ephemeral?.[0]?.text ?? "", markers: result?.markers ?? [] };
}

async function storedFacts(services) {
  return (await services.createStore("remembered_facts").query({})).items;
}

async function seed(services, facts) {
  const store = services.createStore("remembered_facts");
  for (const [id, fact, overrides] of facts) {
    await store.set(id, {
      id, version: "v1", fact,
      sessionId: "seed", messageId: "seed", createdAt: new Date().toISOString(),
      ...overrides,
    });
  }
}

/**
 * Scenario 1: Recall in separate conversations
 *
 * Tests that a durable fact captured in one conversation is successfully
 * recalled in a later, separate conversation within the same workspace.
 *
 * Assumptions:
 * - Memory capture works correctly (fact is stored in the workspace's memory)
 * - Memory recall is triggered automatically when a new conversation starts
 * - The recalled fact is injected into the conversation context
 * - A memory-injection audit marker is left for observability
 */
const scenarios = [
  {
    name: "a fact stated in one conversation is recalled in a later, separate conversation",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await say(alpha, "Remember: my name is Maciej Zagozda.");

      const { injected, markers } = await ask(alpha, "What is my name?");
      assert.match(injected, /Maciej Zagozda/, "a new conversation should arrive knowing the stored name");
      assert.equal(markers[0]?.data?.event, "memory-inject", "a firing recall must leave an audit marker");
    },
  },

/**
 * Scenario 2: Process restart persistence
 *
 * Tests that memory persists across runtime restarts (simulated by creating
 * a new services object over the same data directory).
 *
 * Assumptions:
 * - Memory is persisted to disk in the workspace's .data directory
 * - A fresh services object over the same directory can access persisted memory
 * - The restart doesn't corrupt or lose any facts
 */
  {
    name: "recall survives a process restart",
    async run(workspace) {
      const dir = workspace("alpha");
      await say(createWorkspace(dir), "Remember: the production server is HELIOS-7.");

      // A fresh services object over the same directory is what a restarted process gets.
      const restarted = createWorkspace(dir);
      assert.match((await ask(restarted, "Which server is production?")).injected, /HELIOS-7/);
    },
  },

/**
 * Scenario 3: Global fact sharing
 *
 * Tests that a single captured fact is available to ALL conversations within
 * a workspace, not just the conversation where it was captured.
 *
 * Assumptions:
 * - Memory is workspace-scoped, not conversation-scoped
 * - Every new conversation in a workspace can access all previously captured facts
 * - Multiple questions about the same fact all succeed in recalling it
 */
  {
    name: "one fact is shared by every conversation in the workspace",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await say(alpha, "Remember: my name is Maciej Zagozda.");

      for (const question of ["What is my name?", "Remind me of my name", "who am I? state my name"]) {
        assert.match((await ask(alpha, question)).injected, /Maciej Zagozda/, `not recalled for: ${question}`);
      }
    },
  },

/**
 * Scenario 4: Workspace isolation (baseline)
 *
 * Tests that memory is properly isolated between different workspaces.
 * A fact captured in workspace A should NOT be available in workspace B.
 *
 * Assumptions:
 * - Each workspace has its own isolated memory store
 * - Memory capture in one workspace doesn't affect other workspaces
 * - Memory recall in one workspace doesn't access facts from other workspaces
 */
  {
    name: "facts do not leak from one workspace into another",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      const beta  = createWorkspace(workspace("beta"));

      await say(alpha, "Remember: my name is Maciej Zagozda.");

      assert.equal((await storedFacts(beta)).length, 0, "capture wrote outside its own workspace");
      assert.equal((await ask(beta, "What is my name?")).injected, "", "one workspace recalled another's facts");
      assert.match((await ask(alpha, "What is my name?")).injected, /Maciej Zagozda/);
    },
  },

/**
 * Scenario 5: Independent workspace memory
 *
 * Tests that each workspace maintains its own independent set of facts,
 * and that recall correctly returns only the facts from the current workspace.
 *
 * Assumptions:
 * - Each workspace can have its own unique facts
 * - Recall in workspace A returns only workspace A's facts
 * - Recall in workspace B returns only workspace B's facts
 * - No cross-contamination between workspaces
 */
  {
    name: "each workspace recalls only its own facts",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      const beta  = createWorkspace(workspace("beta"));

      await say(alpha, "Remember: the production server is HELIOS-7.");
      await say(beta,  "Remember: the production server is ORION-3.");

      const fromAlpha = (await ask(alpha, "Which server is production?")).injected;
      const fromBeta  = (await ask(beta,  "Which server is production?")).injected;

      assert.match(fromAlpha, /HELIOS-7/);
      assert.doesNotMatch(fromAlpha, /ORION-3/);
      assert.match(fromBeta, /ORION-3/);
      assert.doesNotMatch(fromBeta, /HELIOS-7/);
    },
  },

/**
 * Scenario 6: Zero-cost recall
 *
 * Tests that memory recall is an internal operation that doesn't require
 * an external model API call. This is important for cost and latency.
 *
 * Assumptions:
 * - Memory recall is performed locally by the system
 * - No external LLM API call is made for recall operations
 * - The modelCalls counter remains unchanged during recall
 */
  {
    name: "recall costs no model call",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await seed(alpha, [["name", "The user's name is Maciej Zagozda."]]);

      const before = alpha.modelCalls();
      assert.match((await ask(alpha, "What is my name?")).injected, /Maciej Zagozda/);
      assert.equal(alpha.modelCalls(), before, "recall must not reach a provider — it runs on every turn");
    },
  },

/**
 * Scenario 7: Provenance tracking
 *
 * Tests that each captured fact records its complete provenance: the session
 * ID, message ID, and timestamp when it was captured.
 *
 * Assumptions:
 * - Fact capture records the originating session and message
 * - The createdAt timestamp is a valid parseable date
 * - This provenance is used for debugging and audit purposes
 */
  {
    name: "capture records which session and message a fact came from",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      const conversation = await say(alpha, "Remember: my name is Maciej Zagozda.");

      const [fact] = await storedFacts(alpha);
      assert.equal(fact.sessionId, conversation.id);
      assert.equal(fact.messageId, conversation.messages[0].id);
      assert.ok(!Number.isNaN(Date.parse(fact.createdAt)), "createdAt must be a parseable timestamp");
    },
  },

/**
 * Scenario 8: Irrelevant question handling
 *
 * Tests that memory recall only triggers for relevant questions and doesn't
 * inject context for unrelated queries.
 *
 * Assumptions:
 * - Recall is context-aware and only triggers on relevant queries
 * - Unrelated questions don't trigger unnecessary recall
 * - Empty messages also don't trigger recall
 */
  {
    name: "an unrelated question recalls nothing",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await seed(alpha, [
        ["name", "The user's name is Maciej Zagozda."],
        ["server", "The production server is HELIOS-7."],
      ]);

      for (const question of ["What is the weather in Tokyo tomorrow?", "Write a haiku about autumn."]) {
        assert.equal((await ask(alpha, question)).injected, "", `should not have recalled for: ${question}`);
      }
      assert.equal((await ask(alpha, "")).injected, "", "an empty message must recall nothing");
    },
  },

/**
 * Scenario 9: Function word handling (Polish example)
 *
 * Tests that common words (like Polish function words "Jaka", "Jak", "Gdzie")
 * don't cause false-positive recall of unrelated facts that happen to contain
 * the same word. This tests the scoring algorithm's ability to distinguish
 * between meaningful and function words.
 *
 * Assumptions:
 * - Function words are not strong enough matches on their own
 * - The recall scoring algorithm requires more than just shared function words
 * - A fact with many words won't be recalled by a question containing just one shared word
 */
  {
    name: "a shared function word does not drag in an unrelated note",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      // A long note contains plenty of ordinary words. In a small store each appears in exactly one
      // fact, so rarity alone would rank a one-word coincidence as a perfect match — and an English
      // stopword list does not cover "jest"/"się".
      await seed(alpha, [["invoice", [
        "Podstawowe elementy faktury: dane kupujacego, numer NIP jesli jest podatnikiem VAT, opis",
        "zakupu, oraz oznaczenie ze faktura zostala wystawiona na zadanie jesli tak sie stalo.",
      ].join(" ")]]);

      for (const question of ["Jaka jest pogoda w Warszawie?", "Jak sie nazywam?", "Gdzie jest moj telefon?"]) {
        assert.equal((await ask(alpha, question)).injected, "", `a function word pulled in the note: ${question}`);
      }
    },
  },

/**
 * Scenario 10: Distinctive identifier matching
 *
 * Tests that a unique identifier (like "HELIOS-7") can be sufficient to trigger
 * recall even when the rest of the question doesn't contain other matching words.
 *
 * Assumptions:
 * - Distinctive identifiers are strong match signals
 * - A single unique term can be enough to retrieve the associated fact
 * - The recalled fact should not include unrelated content
 */
  {
    name: "a distinctive identifier carries its fact when nothing else in the question matches",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await seed(alpha, [
        ["server", "Nasz serwer produkcyjny nazywa sie HELIOS-7 i stoi w serwerowni w Poznaniu."],
        ["name", "The user's name is Maciej Zagozda."],
      ]);

      const { injected } = await ask(alpha, "Is HELIOS-7 behind the VPN?");
      assert.match(injected, /HELIOS-7/);
      assert.doesNotMatch(injected, /Maciej/, "an unrelated fact rode along");
    },
  },

/**
 * Scenario 11: Inflection handling (Polish example)
 *
 * Tests that the recall system can match facts even when the question uses
 * different inflections of the same root words. This is critical for Polish
 * and other highly inflected languages where the same concept can appear in
 * many different grammatical forms.
 *
 * Assumptions:
 * - Token equality alone is not required for matches
 * - The system can match different inflections of the same root
 * - "serwerze" (locative) and "serwer" (nominative) should match
 * - "produkcyjnym" and "produkcyjny" should match
 */
  {
    name: "an inflected question recalls a fact stored in another word form",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await seed(alpha, [["server", "Nasz serwer produkcyjny stoi w serwerowni w Poznaniu."]]);

      // serwerze/serwer/serwerowni and produkcyjnym/produkcyjny differ only by inflection: token
      // equality alone never matches them, which made memory unusable in Polish.
      assert.match((await ask(alpha, "Na jakim serwerze produkcyjnym to stoi?")).injected, /serwerowni/);
    },
  },

/**
 * Scenario 12: Long document recall from short query
 *
 * Tests that a long fact (60+ tokens) can be recalled from a short question
 * (4-5 tokens). This tests the scoring algorithm's ability to find partial
 * matches in long documents, rather than requiring full coverage.
 *
 * Assumptions:
 * - A long fact can be retrieved from a short query
 * - Scoring doesn't require full document coverage
 * - The key information from the long document is retrieved
 */
  {
    name: "a long pasted note stays recallable from a short question",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await seed(alpha, [["invoice", [
        "Podstawowe elementy faktury: oznaczenie 'Faktura', data wystawienia, data dostarczenia towarow",
        "lub wykonania uslugi, dane sprzedawcy, nazwa firmy, adres, numer NIP, dane kupujacego, opis",
        "zakupu, ilosc i jednostka miary, cena jednostkowa netto, podstawa opodatkowania, stawka VAT,",
        "kwota podatku VAT, kwota calkowita do zaplaty brutto, oznaczenie numeru faktury.",
      ].join(" ")]]);

      // Scoring purely by how much of the FACT a query covers can never clear a threshold here: a
      // four-word question cannot "cover" a sixty-token note.
      assert.match((await ask(alpha, "Jakie sa elementy faktury?")).injected, /Podstawowe elementy faktury/);
    },
  },

/**
 * Scenario 13: Context dilution prevention
 *
 * Tests that adding irrelevant context to a question doesn't dilute the
 * match score for the actual relevant terms. A perfect match should still
 * succeed even with extra filler text.
 *
 * Assumptions:
 * - Extra context doesn't reduce the match score below threshold
 * - A perfect match on relevant terms is not diluted by irrelevant context
 * - The system can identify and prioritize the relevant query terms
 */
  {
    name: "extra context in a query does not lose a match",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await seed(alpha, [["name", "The user's name is Maciej Zagozda."]]);

      const bare = await ask(alpha, "What is my name?");
      const padded = await ask(alpha, "I am filling in a long conference registration form for a " +
        "workshop next spring and it wants the attendee details. What is my name?");

      assert.match(bare.injected, /Maciej Zagozda/);
      assert.match(padded.injected, /Maciej Zagozda/, "a longer question must not dilute a perfect match away");
    },
  },

/**
 * Scenario 14: Duplicate deduplication
 *
 * Tests that if the same fact is captured multiple times with slight variations
 * (same content, different capitalization/punctuation), it's deduplicated in
 * the recall results.
 *
 * Assumptions:
 * - Multiple captures of the same fact are deduplicated in recall
 * - Variations in capitalization or punctuation don't create separate entries
 * - The recalled context contains only one instance of the fact
 */
  {
    name: "repeated facts are collapsed to one line of recalled context",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await seed(alpha, [
        ["one",   "The user's name is Maciej Zagozda."],
        ["two",   "The user's name is Maciej Zagozda"],
        ["three", "the user's name is maciej zagozda!"],
      ]);

      const { injected } = await ask(alpha, "What is my name?");
      const lines = injected.split("\n").filter(line => /maciej/i.test(line));
      assert.equal(lines.length, 1, `repetition should not be injected three times, got:\n${lines.join("\n")}`);
    },
  },

/**
 * Scenario 15: Provenance resilience
 *
 * Tests that facts captured with minimal or
      const alpha = createWorkspace(workspace("alpha"));
      // The shape hand-written entries arrive in through `remembered_facts_action`.
      await seed(alpha, [
        ["handwritten", "The user's name is Maciej Zagozda.", { createdAt: "now", sessionId: "current", messageId: "latest" }],
        ["normal", "The production server is HELIOS-7."],
      ]);

      assert.match((await ask(alpha, "What is my name?")).injected, /Maciej Zagozda/);
      assert.match((await ask(alpha, "Which server is production?")).injected, /HELIOS-7/);
    },
  },

  {
    name: "a system-authored turn does not trigger recall",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await seed(alpha, [["name", "The user's name is Maciej Zagozda."]]);

      assert.equal((await ask(alpha, "What is my name?", { origin: "robo" })).injected, "",
        "recall should judge the user's own message, not a machine-authored one");
    },
  },

  {
    name: "contextual_search finds a fact captured in an earlier conversation",
    async run(workspace) {
      const alpha = createWorkspace(workspace("alpha"));
      await say(alpha, "Remember: the production server is HELIOS-7.");

      const tools = new Map();
      const hooks = [];
      await createRumsfeldPlugin().setup({
        ...alpha,
        tools: { register: tool => tools.set(tool.name, tool) },
        hooks: { register: hook => hooks.push(hook) },
        get: () => undefined,
        KnowledgeIndex: { search: async () => [] },
      });

      assert.ok(tools.has("contextual_search"), "the retrieval tool must stay registered");
      assert.ok(hooks.some(hook => hook.on === "screen"), "the recall hook must be wired at setup");

      const events = await drain(tools.get("contextual_search"), { terms: [{ term: "HELIOS-7", context: "the production server" }] }, toolContext(session("q")));
      const result = events.find(event => event.type === "result")?.value;
      assert.equal(result?.name, "remembered_facts");
      assert.match(result?.content ?? "", /HELIOS-7/);
    },
  },
];

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-memory-recall-"));
  let failed = 0;
  try {
    for (const [index, scenario] of scenarios.entries()) {
      const workspace = name => {
        const dir = path.join(root, `scenario-${index}`, "workspaces", name);
        return dir;
      };
      // Each scenario gets its own tree; the workspace dirs are created lazily by the stores, but the
      // config path has to exist for anything that resolves a workspace id from it.
      await mkdir(path.join(root, `scenario-${index}`, "workspaces"), { recursive: true });
      for (const name of ["alpha", "beta"]) {
        await mkdir(workspace(name), { recursive: true });
        await writeFile(path.join(workspace(name), "matbot.yaml"), "plugins: []\n", "utf8");
      }

      try {
        await scenario.run(workspace);
        console.log(`##RESULT## ${JSON.stringify({ name: scenario.name, ok: true })}`);
      } catch (error) {
        failed += 1;
        console.log(`##RESULT## ${JSON.stringify({ name: scenario.name, ok: false, error: error?.message ?? String(error) })}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  if (failed > 0) process.exitCode = 1;
}

await main();
