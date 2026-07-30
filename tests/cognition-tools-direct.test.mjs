import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { plugin } = await import("../local-agent/matbot/packages/plugins/cognition/src/plugin.ts");
const { runOnce } = await import("../local-agent/matbot/packages/plugins/cognition/src/dream/runOnce.ts");
const { DREAM_SETTINGS_KEY } = await import("../local-agent/matbot/packages/plugins/cognition/src/dream/types.ts");

class MemoryStore {
  constructor(items = []) {
    this.docs = new Map(items.map(item => [item.id, item]));
  }

  async get(id) {
    return this.docs.get(id) ?? null;
  }

  async set(id, value) {
    this.docs.set(id, value);
  }

  async cas(id, expected, next) {
    const current = this.docs.get(id) ?? null;
    if (current === null || current.version !== expected) return { ok: false, current };
    this.docs.set(id, next);
    return { ok: true, doc: next };
  }

  async delete(id, expected) {
    const current = this.docs.get(id) ?? null;
    if (current === null || (expected !== undefined && current.version !== expected)) return false;
    return this.docs.delete(id);
  }

  async query() {
    const items = [...this.docs.values()];
    return { items, total: items.length };
  }
}

function createSettings() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

function createFixture() {
  const stores = new Map();
  const registeredTools = new Map();
  const settings = createSettings();
  const services = {
    providers: new Map([["turn-provider", {}], ["critic-provider", {}], ["dream-provider", {}]]),
    settings() {
      return settings;
    },
    createStore(namespace) {
      if (!stores.has(namespace)) stores.set(namespace, new MemoryStore());
      return stores.get(namespace);
    },
    tools: {
      register(tool) {
        registeredTools.set(tool.name, tool);
      },
      remove(name) {
        registeredTools.delete(name);
      },
    },
    mounted: {
      consume() {
        // Skill seeding is outside this direct-tool acceptance fixture.
      },
    },
  };
  return { services, settings, stores, registeredTools };
}

async function execute(tool, input) {
  const events = [];
  for await (const event of tool.executor.execute(input, {
    signal: new AbortController().signal,
    provider: "turn-provider",
  })) {
    events.push(event);
  }
  const error = events.find(event => event.type === "error");
  if (error !== undefined) throw new Error(error.message);
  return events.find(event => event.type === "result")?.value;
}

/**
 * CTA-4/5/6/7: Dream run inspection and cognition configuration use the direct tools
 *
 * Validates that the direct tools for cognition configuration and dream run inspection
 * work correctly, including get/set operations, validation, and storage/retrieval.
 *
 * This test ensures:
 * - The direct tools are correctly registered (cognition_config, dream_runs_action)
 * - Default configuration values are returned correctly
 * - Configuration can be updated with validation (threshold constraints, blocklist updates)
 * - Invalid configurations are rejected and don't persist valid fields
 * - Dream runs can be stored, queried, and retrieved correctly
 *
 * Assumptions:
 * - The cognition plugin registers the direct tools
 * - The test uses a mock fixture with isolated stores and settings
 * - Success is indicated by correct behavior for each tool operation
 */
test("CTA-4/5/6/7 dream run inspection and cognition configuration use the direct tools", async () => {
  const { services, settings, registeredTools } = createFixture();
  await plugin.setup(services);

  const cognitionConfig = registeredTools.get("cognition_config");
  const dreamRuns = registeredTools.get("dream_runs_action");
  assert.ok(cognitionConfig, "cognition_config should be registered");
  assert.ok(dreamRuns, "dream_runs_action should be generated");

  const defaults = await execute(cognitionConfig, { action: "get" });
  assert.deepEqual(defaults, {
    innerVoiceProvider: null,
    dreamRankerProvider: null,
    dreamMergerProvider: null,
    strongThreshold: 0.75,
    weakThreshold: 0.5,
    maxClusterSize: 5,
    blocklist: ["Inner voice"],
    weakDeferralMs: 36 * 60 * 60 * 1000,
    available: ["turn-provider", "critic-provider", "dream-provider"],
  });

  const configured = await execute(cognitionConfig, {
    action: "set",
    innerVoiceProvider: "critic-provider",
    dreamRankerProvider: "dream-provider",
    dreamMergerProvider: "dream-provider",
    strongThreshold: 0.9,
    weakThreshold: 0.6,
    maxClusterSize: 3,
    blocklist: ["Inner voice", "Private Notes"],
    weakDeferralMs: 60_000,
  });
  assert.deepEqual(configured, {
    innerVoiceProvider: "critic-provider",
    dreamRankerProvider: "dream-provider",
    dreamMergerProvider: "dream-provider",
    strongThreshold: 0.9,
    weakThreshold: 0.6,
    maxClusterSize: 3,
    blocklist: ["Inner voice", "Private Notes"],
    weakDeferralMs: 60_000,
    available: ["turn-provider", "critic-provider", "dream-provider"],
  });
  assert.deepEqual(settings.values.get(DREAM_SETTINGS_KEY), {
    strongThreshold: 0.9,
    weakThreshold: 0.6,
    maxClusterSize: 3,
    blocklist: ["Inner voice", "Private Notes"],
    weakDeferralMs: 60_000,
  });

  const beforeInvalidPatch = new Map(settings.values);
  const invalidEvents = [];
  for await (const event of cognitionConfig.executor.execute({
    action: "set",
    innerVoiceProvider: "turn-provider",
    weakThreshold: 0.95,
  }, { signal: new AbortController().signal })) {
    invalidEvents.push(event);
  }
  assert.match(invalidEvents.find(event => event.type === "error")?.message ?? "", /weakThreshold.*must be <= strongThreshold/);
  assert.deepEqual(settings.values, beforeInvalidPatch, "an invalid mixed patch must not persist its valid fields");

  const stored = await execute(dreamRuns, {
    action: "set",
    id: "dream-run:direct-tool-test",
    data: {
      startedAt: "2026-07-30T09:00:00.000Z",
      endedAt: "2026-07-30T09:00:01.000Z",
      outcome: "merged",
      mergedFactIds: ["fact:one"],
      contradictions: [],
      unassignedRemaining: 0,
      judgementCalls: [],
    },
  });
  const queried = await execute(dreamRuns, { action: "query", query: {} });
  assert.equal(queried.total, 1);
  assert.equal(queried.items[0].id, stored.id);
  assert.equal(queried.items[0].outcome, "merged");
});

/**
 * CTA-8: Cognition blocklist excludes matching skills from dream-time routing
 *
 * Validates that the cognition blocklist correctly excludes matching skills
 * from dream-time routing, preventing them from being ranked or merged.
 *
 * This test ensures:
 * - Blocklisted skills are excluded from ranking and merging
 * - Facts that would match blocklisted skills are not routed
 * - The blocklist configuration is applied to dream-time routing
 *
 * Assumptions:
 * - The runOnce() function applies the blocklist to skill routing
 * - The test creates a fact that would match a blocklisted skill
 * - Success is indicated by the fact not being routed to the blocklisted skill
 */
test("CTA-8 cognition blocklist excludes matching skills from dream-time routing", async () => {
  const factStore = new MemoryStore([{
    id: "fact:blocklist-canary",
    version: "fact-version",
    fact: "This fact must not be routed to the blocked skill.",
    sessionId: "session:blocklist-canary",
    messageId: "message:blocklist-canary",
    createdAt: "2026-07-30T09:00:00.000Z",
  }]);
  const services = {
    settings() {
      return {
        async get(key) {
          return key === DREAM_SETTINGS_KEY ? { blocklist: ["Private Notes"] } : undefined;
        },
      };
    },
    createStore(namespace) {
      assert.equal(namespace, "remembered_facts");
      return factStore;
    },
    SkillManager: {
      list() {
        return [{ name: "Private Notes" }];
      },
      get() {
        return {
          name: "Private Notes",
          content: "# Private Notes",
          knowledge: { summary: "Blocked knowledge", entities: [], tags: [] },
        };
      },
    },
  };
  const neverRank = {
    async rank() {
      throw new Error("the ranker must not receive blocklisted skills");
    },
  };
  const neverMerge = {
    async merge() {
      throw new Error("the merger must not receive blocklisted skills");
    },
  };

  const run = await runOnce(services, neverRank, neverMerge, new AbortController().signal);

  assert.equal(run.outcome, "no-match");
  assert.equal(run.primaryFact.id, "fact:blocklist-canary");
  assert.equal(run.routedTo.reasoning, "no candidate skills are configured at all");
  assert.equal(run.judgementCalls.length, 0);
  assert.equal((await factStore.get("fact:blocklist-canary")).dreamSkill, undefined);
});
