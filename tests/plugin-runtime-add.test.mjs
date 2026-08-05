import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const output = [];
    const child = spawn(command, args, { cwd, shell: process.platform === "win32" });
    child.stdout.on("data", chunk => output.push(chunk.toString()));
    child.stderr.on("data", chunk => output.push(chunk.toString()));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(output.join(""));
      else reject(new Error(`${command} exited with code ${code}\n${output.join("")}`));
    });
  });
}

async function packPluginWithBundledDependency(root) {
  const pluginName = `cortex-pdr-plugin-${process.pid}`;
  const helperName = `cortex-pdr-helper-${process.pid}`;
  const pluginRoot = path.join(root, "package-source");
  const helperRoot = path.join(pluginRoot, "node_modules", helperName);
  const packRoot = path.join(root, "packed");
  await mkdir(helperRoot, { recursive: true });
  await mkdir(packRoot, { recursive: true });
  await writeFile(path.join(helperRoot, "package.json"), JSON.stringify({
    name: helperName,
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
  }), "utf8");
  await writeFile(path.join(helperRoot, "index.js"), "export const dependencyValue = 'dependency-ready';\n", "utf8");
  await writeFile(path.join(pluginRoot, "package.json"), JSON.stringify({
    name: pluginName,
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
    matbotRuntime: ["node"],
    dependencies: { [helperName]: "1.0.0" },
    bundledDependencies: [helperName],
  }), "utf8");
  await writeFile(path.join(pluginRoot, "index.js"), [
    `import { dependencyValue } from ${JSON.stringify(helperName)};`,
    `export const plugin = { name: ${JSON.stringify(pluginName)}, apiVersion: 1 };`,
    "export const installedDependencyValue = dependencyValue;",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(pluginRoot, ".npmrc"), "node-linker=hoisted\n", "utf8");

  await run("pnpm", ["pack", "--pack-destination", packRoot], pluginRoot);
  const tarball = (await readdir(packRoot)).find(entry => entry.endsWith(".tgz"));
  assert.ok(tarball, "pnpm pack must produce a plugin tarball");
  return { pluginName, helperName, tarballPath: path.join(packRoot, tarball) };
}

/**
 * T3-E2E-034: Plugin add with persistence, duplicate guard, and rollback for incompatible plugins
 *
 * Validates that the plugin add operation correctly persists and activates approved
 * local plugins, rejects missing paths, and rolls back incompatible plugins.
 *
 * This test ensures:
 * - Approved local plugins are persisted to matbot.yaml and activated
 * - Duplicate plugin additions are rejected before prompting for confirmation
 * - Missing paths are rejected with appropriate error messages
 * - Incompatible plugins (wrong runtime) are rolled back from configuration
 *
 * Assumptions:
 * - The plugin add tool correctly validates and installs plugins
 * - The test creates temporary plugins and configures the plugin system
 * - Success is indicated by the plugin system correctly handling each scenario
 */
test("T3-E2E-034 plugin add persists and activates an approved local plugin, rejects missing paths, and rolls back incompatible plugins", async t => {
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

test("PDR-3/PDR-7 plugin add installs an npm tarball with pnpm and preserves its dependency graph", async t => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "cortex-plugin-pnpm-"));
  const configPath = path.join(projectDir, "matbot.yaml");
  const { pluginName, helperName, tarballPath } = await packPluginWithBundledDependency(projectDir);
  const tarball = await readFile(tarballPath);
  const server = createServer((request, response) => {
    if (request.url !== "/plugin.tgz") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(tarball.length),
    });
    response.end(tarball);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
    await rm(projectDir, { recursive: true, force: true });
  });

  await writeFile(configPath, "name: isolated-pnpm-plugin-test\n", "utf8");
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    name: "cortex-plugin-test-host",
    version: "1.0.0",
    private: true,
  }), "utf8");
  await writeFile(path.join(projectDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n", "utf8");

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const specifier = `http://127.0.0.1:${address.port}/plugin.tgz`;
  const loaded = [];
  const events = await execute({ action: "add", specifier }, {
    configPath,
    signal: new AbortController().signal,
    vault: { async writeSecret() {} },
    async prompt() { return "yes"; },
    async loadPlugin(installedSpecifier) {
      loaded.push(installedSpecifier);
      return {};
    },
    async unloadPlugin() { return false; },
  });

  assert.equal(events.find(event => event.type === "error"), undefined);
  assert.match(events.find(event => event.type === "stdout")?.chunk ?? "", /Installing .* with pnpm/);
  assert.deepEqual(loaded, [pluginName], "the durable config and loader use the installed package name");
  assert.match(await readFile(configPath, "utf8"), new RegExp(`^  - ${pluginName}$`, "m"));

  const hostPackage = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
  assert.ok(hostPackage.dependencies?.[pluginName], "pnpm records the installed plugin dependency");
  const installedPlugin = await import(pathToFileURL(path.join(projectDir, "node_modules", pluginName, "index.js")).href);
  assert.equal(installedPlugin.installedDependencyValue, "dependency-ready");
  const installedHelper = JSON.parse(await readFile(
    path.join(projectDir, "node_modules", pluginName, "node_modules", helperName, "package.json"),
    "utf8",
  ));
  assert.equal(installedHelper.name, helperName, "the plugin's bundled dependency remains installed and resolvable");
});
