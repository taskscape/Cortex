import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const configRoot = path.join(process.cwd(), "local-agent", "config");

async function readJson(name) {
  return JSON.parse(await readFile(path.join(configRoot, name), "utf8"));
}

function assertStringList(value, name) {
  assert.ok(Array.isArray(value), `${name} must be an array`);
  assert.ok(value.length > 0, `${name} must not be empty`);
  assert.ok(value.every(item => typeof item === "string" && item.trim() !== ""), `${name} must contain non-empty strings`);
  assert.equal(new Set(value).size, value.length, `${name} must not contain duplicate entries`);
}

function translateWindowsPath(input, mapping, targetPrefix) {
  assert.ok(input.toLowerCase().startsWith(mapping.windowsPrefix.toLowerCase()), "input must use the mapping's Windows prefix");
  return `${targetPrefix}${input.slice(mapping.windowsPrefix.length).replaceAll("\\", "/")}`;
}

// These assets currently have no production reader in this repository. These assertions protect
// their documented on-disk contract; runtime policy enforcement and host path access need a
// production consumer before they can be exercised as integration behavior.
test("memory policy declares non-overlapping durable-memory safeguards", async () => {
  const policy = await readJson("memory-policy.json");
  assert.deepEqual(Object.keys(policy).sort(), ["doNotStoreInMemory", "durableMemoryKinds", "promotionRequires"]);
  assertStringList(policy.durableMemoryKinds, "durableMemoryKinds");
  assertStringList(policy.doNotStoreInMemory, "doNotStoreInMemory");
  assertStringList(policy.promotionRequires, "promotionRequires");

  const durable = new Set(policy.durableMemoryKinds);
  for (const forbidden of policy.doNotStoreInMemory) {
    assert.equal(durable.has(forbidden), false, `${forbidden} cannot be both durable and prohibited`);
  }
  assert.ok(policy.doNotStoreInMemory.includes("secret"), "secrets must remain explicitly excluded");
  assert.ok(policy.promotionRequires.includes("explicit-user-request"), "explicit user intent remains a promotion safeguard");
});

test("path mappings define complete Windows, WSL, and Docker prefixes for Cortex workspace files", async () => {
  const config = await readJson("path-mapping.json");
  assert.deepEqual(Object.keys(config), ["mappings"]);
  assert.ok(Array.isArray(config.mappings) && config.mappings.length > 0, "at least one path mapping is required");

  const seenWindowsPrefixes = new Set();
  for (const mapping of config.mappings) {
    for (const field of ["windowsPrefix", "wslPrefix", "dockerPrefix"]) {
      assert.equal(typeof mapping[field], "string", `${field} must be a string`);
      assert.ok(mapping[field].length > 0, `${field} must not be empty`);
    }
    assert.match(mapping.windowsPrefix, /[\\/]$/, "Windows prefixes must end at a directory boundary");
    assert.match(mapping.wslPrefix, /\/$/, "WSL prefixes must end at a directory boundary");
    assert.match(mapping.dockerPrefix, /\/$/, "Docker prefixes must end at a directory boundary");
    const key = mapping.windowsPrefix.toLowerCase();
    assert.equal(seenWindowsPrefixes.has(key), false, `duplicate Windows prefix ${mapping.windowsPrefix}`);
    seenWindowsPrefixes.add(key);
  }

  const cDrive = config.mappings.find(mapping => mapping.windowsPrefix.toLowerCase() === "c:\\");
  assert.ok(cDrive, "the checked-in Windows C: mapping is required for the default workspace");
  const source = "C:\\Projects\\Cortex\\docs\\memory-and-retrieval.md";
  assert.equal(
    translateWindowsPath(source, cDrive, cDrive.wslPrefix),
    "/mnt/c/Projects/Cortex/docs/memory-and-retrieval.md",
  );
  assert.equal(
    translateWindowsPath(source, cDrive, cDrive.dockerPrefix),
    "/workspace/c/Projects/Cortex/docs/memory-and-retrieval.md",
  );
});
