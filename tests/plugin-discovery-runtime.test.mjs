import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { pluginTool } = await import("../local-agent/matbot/packages/core/tool-plugin/src/tools/plugin.ts");

async function execute(input, configPath) {
  const events = [];
  for await (const event of pluginTool.executor.execute(input, {
    configPath,
    signal: new AbortController().signal,
    async prompt() { return "no"; },
    vault: { async writeSecret() {} },
  })) events.push(event);
  const error = events.find(event => event.type === "error");
  if (error) throw new Error(error.message);
  return events.find(event => event.type === "result")?.value;
}

/**
 * Validates that runtime plugin discovery correctly discovers local plugins, produces
 * stable results, deduplicates entries, and constrains discovery to local roots.
 *
 * This test ensures:
 * - The configured Matbot project exposes local plugins
 * - Discovery ordering is stable across multiple runs
 * - Discovery has no duplicate package/specifier pairs
 * - All discovered plugins are local (not remote)
 * - All discovered plugins have specifiers within the plugin roots
 *
 * Assumptions:
 * - The pluginTool.executor.execute({ action: "discover_local" }) call discovers
 *   local plugins
 * - The test creates two discovery calls and compares results
 * - Success is indicated by the discovery results meeting all the criteria
 */
test("MISSING-05 runtime plugin discovery is stable, deduplicated, and constrained to local roots", async () => {
  const projectDir = path.resolve("local-agent/matbot");
  const configPath = path.join(projectDir, "matbot.yaml");
  const first = await execute({ action: "discover_local" }, configPath);
  const second = await execute({ action: "discover_local" }, configPath);
  assert.ok(first.length > 0, "the configured Matbot project exposes local plugins");
  assert.deepEqual(second, first, "discovery ordering is stable");
  assert.equal(new Set(first.map(entry => `${entry.name}|${entry.specifier}`)).size, first.length, "discovery has no duplicate package/specifier pairs");
  const root = await realpath(path.join(projectDir, "packages", "plugins"));
  for (const entry of first) {
    assert.equal(entry.source.type, "local");
    assert.match(entry.specifier, /^\.\/packages\/plugins\//);
    const location = await realpath(path.resolve(projectDir, entry.specifier));
    assert.ok(location === root || location.startsWith(`${root}${path.sep}`), `discovery must not offer a path outside plugin roots: ${location}`);
  }
});
