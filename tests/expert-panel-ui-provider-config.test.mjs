import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repositoryRoot, "local-agent", "config", "experts.json");

test("expert panel configuration does not override the UI-selected provider", async () => {
  const config = JSON.parse(await readFile(configPath, "utf8"));

  assert.equal(config.defaultProvider, undefined);
  for (const expert of config.experts) {
    assert.equal(expert.provider, undefined, `Expert ${expert.id} must not pin a provider.`);
  }
});
