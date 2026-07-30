import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { loadExpertConfig } = await import("../local-agent/matbot/plugins/expert-panel/src/config.ts");

async function withConfig(body, check) {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-expert-invalid-"));
  const configPath = path.join(root, "experts.json");
  await mkdir(path.join(root, "valid"));
  await writeFile(configPath, JSON.stringify(body), "utf8");
  const prior = process.env.EXPERT_PANEL_CONFIG;
  process.env.EXPERT_PANEL_CONFIG = configPath;
  try { await check(root); } finally {
    if (prior === undefined) delete process.env.EXPERT_PANEL_CONFIG; else process.env.EXPERT_PANEL_CONFIG = prior;
    await rm(root, { recursive: true, force: true });
  }
}

const expert = { id: "one", title: "One", description: "One", systemPrompt: "One", roots: ["valid"] };

/**
 * Validates that expert configuration correctly rejects duplicate expert IDs,
 * inaccessible knowledge roots, and malformed schema (e.g., empty roots array).
 *
 * This test ensures:
 * - Duplicate expert IDs are rejected
 * - Inaccessible knowledge roots are rejected
 * - Empty knowledge root arrays are rejected
 * - The configuration loader throws appropriate errors for invalid configurations
 *
 * Assumptions:
 * - The loadExpertConfig() function loads expert configuration from a JSON file
 * - The test creates temporary configurations with various invalid settings
 * - Success is indicated by the configuration loader throwing appropriate errors
 *   for each invalid configuration
 */
test("MISSING-04 expert configuration rejects duplicate ids, missing roots, and malformed schema", async () => {
  await withConfig({ experts: [{ ...expert }, { ...expert, id: "ONE" }] }, async () => {
    await assert.rejects(loadExpertConfig(), /duplicate expert id/i);
  });
  await withConfig({ experts: [{ ...expert, roots: ["missing"] }] }, async () => {
    await assert.rejects(loadExpertConfig(), /inaccessible knowledge root/i);
  });
  await withConfig({ experts: [{ ...expert, roots: [] }] }, async () => {
    await assert.rejects(loadExpertConfig(), /must define at least one knowledge root/i);
  });
});
