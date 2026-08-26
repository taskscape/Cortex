import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";

await import("../local-agent/matbot/apps/cli/register.js");

const bashMod = await import("../local-agent/matbot/packages/plugins/bash/src/index.ts");
const powershellMod = await import("../local-agent/matbot/packages/plugins/powershell/src/index.ts");
const dockerBashMod = await import("../local-agent/matbot/packages/plugins/docker-bash/src/index.ts");

async function makeTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

test("minimal env exposes PATH-style keys but not unrelated process secrets", () => {
  process.env.MATBOT_CANARY_SECRET = "hunter2";
  try {
    for (const safeDefaultEnv of [bashMod.safeDefaultEnv, powershellMod.safeDefaultEnv]) {
      const env = safeDefaultEnv();
      assert.ok(env.PATH || env.Path || env.path, "PATH must be present for commands to work");
      assert.equal(env.MATBOT_CANARY_SECRET, undefined, "unrelated process env must not leak");
      const keys = Object.keys(env);
      assert.ok(
        keys.every(key =>
          ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "SYSTEMROOT", "WINDIR",
            "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES"].includes(key),
        ),
        `unexpected key(s) in safe env: ${keys.join(", ")}`,
      );
    }
  } finally {
    delete process.env.MATBOT_CANARY_SECRET;
  }
});

test("cwd confinement allows paths inside the base directory", () => {
  const base = os.tmpdir();
  assert.equal(bashMod.confineWorkspaceCwd(undefined, base), path.resolve(base));
  assert.equal(bashMod.confineWorkspaceCwd(".", base), path.resolve(base));
  assert.equal(
    path.resolve(bashMod.confineWorkspaceCwd(path.join("nested", "deep"), base)),
    path.resolve(base, "nested", "deep"),
  );
  assert.equal(
    path.resolve(bashMod.confineWorkspaceCwd("./sibling/../inside", base)),
    path.resolve(base, "inside"),
  );
});

test("cwd confinement rejects escapes, absolute foreign paths, and sibling-prefix tricks", () => {
  const base = path.join(os.tmpdir(), "confinement-base");
  assert.throws(() => bashMod.confineWorkspaceCwd("../outside", base), /workspace/);
  assert.throws(() => bashMod.confineWorkspaceCwd(path.resolve(os.tmpdir(), "elsewhere"), base), /workspace/);
  assert.throws(() => bashMod.confineWorkspaceCwd(`${base}-sibling`, base), /workspace/);
  assert.throws(() => bashMod.confineWorkspaceCwd("..", base), /workspace/);
  // same contract for the powershell copy
  assert.throws(() => powershellMod.confineWorkspaceCwd("../outside", base), /workspace/);
});

async function collectPowerShell(input, workdir) {
  const events = [];
  for await (const event of powershellMod.powershellTool.executor.execute(input, {
    callId: "executors-hardening-test",
    signal: new AbortController().signal,
    ...(workdir !== undefined ? { workdir } : {}),
    session: {
      id: "s",
      version: "v",
      status: "active",
      contexts: [],
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })) {
    events.push(event);
  }
  return events;
}

test("powershell tool passes a canary-free environment with explicit vars through", { skip: process.platform !== "win32" }, async () => {
  const workdir = await makeTempDir("executors-hardening-ps");
  process.env.MATBOT_CANARY_SECRET = "hunter2";
  try {
    const events = await collectPowerShell({
      script: [
        'Write-Output "canary=[$env:MATBOT_CANARY_SECRET]"',
        'Write-Output "allowed=[$env:MATBOT_ALLOWED]"',
        'Write-Output "pathlen=$($env:PATH.Length)"',
      ].join("\n"),
      env: { MATBOT_ALLOWED: "yes" },
      timeout: 15_000,
    }, workdir);

    const result = events.find(event => event.type === "result");
    assert.ok(result, `expected success result, got ${JSON.stringify(events)}`);
    assert.equal(result.value.exitCode, 0);
    assert.match(result.value.stdout, /canary=\[\]/, "process secrets must not reach the child");
    assert.match(result.value.stdout, /allowed=\[yes\]/);
    assert.match(result.value.stdout, /pathlen=[1-9]/, "PATH must be present in the child env");
  } finally {
    delete process.env.MATBOT_CANARY_SECRET;
    await rm(workdir, { recursive: true, force: true });
  }
});

test("powershell tool honors cwd inside the workspace and refuses escapes", { skip: process.platform !== "win32" }, async () => {
  const workdir = await makeTempDir("executors-hardening-ps-cwd");
  try {
    const inside = path.join(workdir, "sub", "dir");
    const insideEvents = await collectPowerShell({
      script: 'Write-Output "cwd=$((Get-Location).Path)"',
      cwd: inside,
      timeout: 15_000,
    }, workdir);
    const insideResult = insideEvents.find(event => event.type === "result");
    assert.ok(insideResult, `expected success result, got ${JSON.stringify(insideEvents)}`);
    assert.match(insideResult.value.stdout, new RegExp(`cwd=${inside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
      "an in-workspace cwd must be auto-created and honored");

    const outsideEvents = await collectPowerShell({
      script: 'Write-Output "should not run"',
      cwd: path.join(workdir, "..", "outside"),
      timeout: 15_000,
    }, workdir);
    assert.equal(outsideEvents.some(event => event.type === "result"), false,
      "an escaping cwd must never execute");
    const error = outsideEvents.find(event => event.type === "error");
    assert.ok(error, `expected a confinement error, got ${JSON.stringify(outsideEvents)}`);
    assert.match(error.message, /workspace/);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

function makeDockerBashHarness() {
  const settingsStore = new Map();
  const registered = [];
  const services = {
    settings: () => ({
      get: async key => (settingsStore.has(key) ? structuredClone(settingsStore.get(key)) : undefined),
      set: async (key, value) => { settingsStore.set(key, structuredClone(value)); },
      delete: async key => { settingsStore.delete(key); },
    }),
    tools: { register: tool => registered.push(tool) },
  };
  return { services, registered, settingsStore };
}

async function collectConfigTool(configTool, input) {
  const events = [];
  for await (const event of configTool.executor.execute(input, {
    callId: "executors-hardening-config-test",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

test("bash_config validates input shapes with descriptive errors and ignores unknown fields", async () => {
  const { services, registered } = makeDockerBashHarness();
  await dockerBashMod.plugin.setup(services);
  const configTool = registered.find(tool => tool.name === "bash_config");
  assert.ok(configTool, "bash_config tool must be registered");

  const badInputs = [
    [{}, /"action" must be/],
    [{ action: "destroy" }, /"action" must be/],
    [{ action: "set", dns: "1.1.1.1" }, /"dns" must be an array of non-empty strings/],
    [{ action: "set", dns: ["1.1.1.1", 42] }, /"dns" must be an array of non-empty strings/],
    [{ action: "set", name: "" }, /"name" must start with a letter or digit/],
    [{ action: "set", name: "bad name!" }, /"name" must start with a letter or digit/],
    [{ action: "set", name: "-leading" }, /"name" must start with a letter or digit/],
    [{ action: "set", maxOutputBytes: 0 }, /"maxOutputBytes" must be an integer >= 1/],
    [{ action: "set", maxOutputBytes: Number.NaN }, /"maxOutputBytes" must be an integer >= 1/],
    [{ action: "set", maxOutputBytes: 1.5 }, /"maxOutputBytes" must be an integer >= 1/],
    [{ action: "set" }, /At least one of "dns", "name", or "maxOutputBytes"/],
  ];
  for (const [input, pattern] of badInputs) {
    const events = await collectConfigTool(configTool, input);
    const error = events.find(event => event.type === "error");
    assert.ok(error, `expected a validation error for ${JSON.stringify(input)}, got ${JSON.stringify(events)}`);
    assert.match(error.message, pattern);
    assert.equal(events.some(event => event.type === "result"), false,
      `invalid input ${JSON.stringify(input)} must not produce a result`);
  }

  // Unknown fields are ignored; a valid set still succeeds.
  const goodEvents = await collectConfigTool(configTool, {
    action: "set",
    maxOutputBytes: 4096,
    totallyUnknown: { nested: ["junk"] },
  });
  const result = goodEvents.find(event => event.type === "result");
  assert.ok(result, `expected success result, got ${JSON.stringify(goodEvents)}`);
  assert.deepEqual(result.value.overrides, { maxOutputBytes: 4096 });
});

test("container provision lock serializes per name and survives failures", async () => {
  const { withContainerLock } = dockerBashMod;

  let active = 0;
  let maxActive = 0;
  const order = [];
  const task = id => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    order.push(id);
  };

  await Promise.all([1, 2, 3].map(id => withContainerLock("same-container", task(id))));
  assert.equal(maxActive, 1, "tasks under one lock key must never overlap");
  assert.equal(order.length, 3);

  // A rejecting task must not poison the chain for later callers.
  await assert.rejects(
    withContainerLock("same-container", async () => { throw new Error("boom"); }),
    /boom/,
  );
  order.length = 0;
  await withContainerLock("same-container", task("after-failure"));
  assert.deepEqual(order, ["after-failure"]);

  // Distinct names do not block each other.
  active = 0;
  maxActive = 0;
  await Promise.all([
    withContainerLock("a", task("a")),
    withContainerLock("b", task("b")),
  ]);
  assert.equal(maxActive, 2, "different lock keys must run concurrently");
});
