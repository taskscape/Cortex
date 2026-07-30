import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { runDreamTimePass } = await import("../local-agent/matbot/packages/plugins/cognition/src/dream/service.ts");
const { DREAM_SKILL_ERROR } = await import("../local-agent/matbot/packages/plugins/cognition/src/dream/types.ts");

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

  async cas(id, expectedVersion, next) {
    const current = this.docs.get(id) ?? null;
    if (current === null || current.version !== expectedVersion) return { ok: false, current };
    this.docs.set(id, { ...next, version: `${expectedVersion}:next` });
    return { ok: true, doc: this.docs.get(id) };
  }

  async query() {
    const now = Date.now();
    const items = [...this.docs.values()].filter(item => item.dreamSkill === undefined
      && (item.ignoreUntil === undefined || Date.parse(item.ignoreUntil) <= now));
    return { items, total: items.length, cursor: undefined };
  }
}

function fact(id, createdAt) {
  return {
    id,
    version: `${id}:v1`,
    fact: `Durable fact ${id}`,
    sessionId: `session-${id}`,
    messageId: `message-${id}`,
    createdAt,
  };
}

function createDreamServices({ facts, mergeMode = "normal" }) {
  const rememberedFacts = new MemoryStore(facts);
  const dreamRuns = new MemoryStore();
  const skill = {
    name: "Workspace Profile",
    content: "# Workspace Profile\n\nExisting durable context.",
    knowledge: { summary: "Workspace-specific durable facts", entities: ["workspace"], tags: ["memory"] },
  };
  const saves = [];
  const calls = [];
  let mergeNumber = 0;
  const services = {
    providers: new Map([["test-provider", {}]]),
    settings() {
      return { async get() { return undefined; } };
    },
    createStore(namespace) {
      if (namespace === "remembered_facts") return rememberedFacts;
      if (namespace === "dream_runs") return dreamRuns;
      throw new Error(`Unexpected store ${namespace}`);
    },
    SkillManager: {
      list() {
        return [{ name: skill.name }];
      },
      get(name) {
        return name === skill.name ? skill : undefined;
      },
      async save(name, content) {
        assert.equal(name, skill.name);
        saves.push(content);
        skill.content = content;
      },
    },
    async singleTurn(request) {
      calls.push(request);
      if (/ranking judge/i.test(request.system)) {
        return {
          text: JSON.stringify({ scores: [{ skill: skill.name, score: 97, why: "Strong workspace fit" }] }),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (/merge stage/i.test(request.system)) {
        mergeNumber++;
        const current = request.prompt.match(/---begin current skill markdown---\n([\s\S]*?)\n---end current skill markdown---/)?.[1];
        assert.notEqual(current, undefined);
        if (mergeMode === "short") {
          return { text: JSON.stringify({ content: "short", contradictions: [] }), usage: { inputTokens: 1, outputTokens: 1 } };
        }
        return {
          text: JSON.stringify({
            content: `${current}\n- Consolidated fact ${mergeNumber}`,
            contradictions: mergeNumber === 2 ? [{ location: "Workspace Profile", note: "Review the second fact against existing context." }] : [],
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      throw new Error("Unexpected dream-time model call");
    },
  };
  return { services, rememberedFacts, dreamRuns, saves, calls, skill };
}

test("dream-time merges a bounded fact cluster, records provenance, and keeps workspace stores isolated", async () => {
  const workspaceA = createDreamServices({
    facts: [
      fact("alpha", "2026-01-01T00:00:00.000Z"),
      fact("beta", "2026-01-02T00:00:00.000Z"),
    ],
  });
  const workspaceB = createDreamServices({ facts: [fact("other-workspace", "2026-01-01T00:00:00.000Z")] });

  const run = await runDreamTimePass(workspaceA.services, "test-provider", new AbortController().signal);

  assert.equal(run.outcome, "merged");
  assert.deepEqual(run.mergedFactIds, ["alpha", "beta"]);
  assert.equal(run.unassignedRemaining, 0);
  assert.deepEqual(run.contradictions, [{
    skill: "Workspace Profile",
    location: "Workspace Profile",
    note: "Review the second fact against existing context.",
  }]);
  assert.strictEqual(await workspaceA.dreamRuns.get(run.id), run, "the completed run is persisted for observability");
  assert.equal((await workspaceA.rememberedFacts.get("alpha")).dreamSkill, "Workspace Profile");
  assert.equal((await workspaceA.rememberedFacts.get("beta")).dreamSkill, "Workspace Profile");
  assert.equal(workspaceA.saves.length, 1, "cluster members are committed in one skill write");
  assert.match(workspaceA.saves[0], /Consolidated fact 1/);
  assert.match(workspaceA.saves[0], /Consolidated fact 2/);
  assert.equal(workspaceA.calls.filter(call => /ranking judge/i.test(call.system)).length, 2);
  assert.equal(workspaceA.calls.filter(call => /merge stage/i.test(call.system)).length, 2);
  assert.ok(workspaceA.calls.every(call => call.provider === "test-provider"));

  assert.equal((await workspaceB.rememberedFacts.get("other-workspace")).dreamSkill, undefined);
  assert.equal(workspaceB.dreamRuns.docs.size, 0, "a run in one workspace does not create records in another workspace store");
});

test("dream-time quarantines a durable merge failure without overwriting the skill", async () => {
  const workspace = createDreamServices({
    facts: [fact("bad-merge", "2026-01-01T00:00:00.000Z")],
    mergeMode: "short",
  });

  const run = await runDreamTimePass(workspace.services, "test-provider", new AbortController().signal);

  assert.equal(run.outcome, "error");
  assert.match(run.error, /shorter content/i);
  assert.equal((await workspace.rememberedFacts.get("bad-merge")).dreamSkill, DREAM_SKILL_ERROR);
  assert.equal(workspace.saves.length, 0, "the original skill remains untouched after a failed merge");
  assert.strictEqual(await workspace.dreamRuns.get(run.id), run);
});
