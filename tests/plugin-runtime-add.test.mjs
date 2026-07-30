import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { pluginTool } = await import("../local-agent/matbot/packages/core/tool-plugin/src/tools/plugin.ts");
const { IncompatibleRuntimeError } = await import("../local-agent/matbot/packages/core/plugin-api/src/index.ts");

async function execute(input, ctx) {
  const events = [];
  for await (const event of pluginTool.executor.execute(input, ctx)) events.push(event);
  return events;
}

async function writePlugin(projectDir, directory, name) {
  const root = path.join(projectDir, "packages", "plugins", directory);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name,
    description: `Test plugin ${name}`,
    matbotRuntime: ["node"],
  }), "utf8");
}

test("plugin add persists and activates an approved local plugin, rejects missing paths, and rolls back incompatible plugins", async t => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cortex-plugin-runtime-"));
  const configPath = path.join(projectDir, "matbot.yaml");
  const localSpecifier = "./packages/plugins/local-test-plugin";
  const incompatibleSpecifier = "./packages/plugins/browser-only-test-plugin";
  const calls = { prompts: [], loads: [] };
  const baseContext = {
    configPath,
    signal: new AbortController().signal,
    vault: { async writeSecret() {} },
    async prompt(field) {
      calls.prompts.push(field);
      return "yes";
    },
    async unloadPlugin() { return false; },
  };
  t.after(() => rm(projectDir, { recursive: true, force: true }));

  await writeFile(configPath, "name: isolated-plugin-test\nproviders:\n  - module: fake\n", "utf8");
  await writePlugin(projectDir, "local-test-plugin", `cortex-local-test-plugin-${process.pid}`);
  await writePlugin(projectDir, "browser-only-test-plugin", `cortex-browser-only-test-plugin-${process.pid}`);

  const installed = await execute({ action: "add", specifier: localSpecifier }, {
    ...baseContext,
    async loadPlugin(specifier) {
      calls.loads.push(specifier);
      return { async installationMessage() { return "Local test plugin active."; } };
    },
  });
  assert.equal(installed.find(event => event.type === "error"), undefined);
  assert.match(installed.find(event => event.type === "result")?.value.message ?? "", /installed and is now active/);
  assert.deepEqual(calls.loads, [localSpecifier]);
  assert.equal(calls.prompts.length, 1, "a local plugin still requires a real confirmation prompt");
  assert.equal(calls.prompts[0].type, "confirm");
  const afterInstall = await readFile(configPath, "utf8");
  assert.match(afterInstall, new RegExp(`^  - ${localSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

  const alreadyConfigured = await execute({ action: "add", specifier: localSpecifier }, {
    ...baseContext,
    async loadPlugin() { throw new Error("a configured plugin must not activate twice"); },
  });
  assert.match(alreadyConfigured.find(event => event.type === "result")?.value.message ?? "", /already configured/);
  assert.equal(calls.prompts.length, 1, "the duplicate guard must run before confirmation");

  const missing = await execute({ action: "add", specifier: "./packages/plugins/does-not-exist" }, {
    ...baseContext,
    async loadPlugin() { throw new Error("a missing path must not be loaded"); },
  });
  assert.match(missing.find(event => event.type === "error")?.message ?? "", /looks like a local path but no package\.json/i);
  assert.equal(calls.prompts.length, 1, "a missing path must not reach the confirmation prompt");
  assert.doesNotMatch(await readFile(configPath, "utf8"), /does-not-exist/);

  const incompatible = await execute({ action: "add", specifier: incompatibleSpecifier }, {
    ...baseContext,
    async loadPlugin(specifier) {
      throw new IncompatibleRuntimeError(specifier, ["browser"], "node");
    },
  });
  assert.match(incompatible.find(event => event.type === "error")?.message ?? "", /host runtime is "node"/);
  assert.equal(calls.prompts.length, 2);
  const afterRollback = await readFile(configPath, "utf8");
  assert.doesNotMatch(afterRollback, new RegExp(incompatibleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "incompatible plugins must not remain configured for restart");
});
