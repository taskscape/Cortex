import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpertConfig, ExpertPanelConfig } from "./types.js";

/**
 * Load and validate the expert panel configuration (experts.json or the file named by
 * `EXPERT_PANEL_CONFIG`): normalizes each expert, resolves knowledge roots against the
 * config directory, and verifies they are accessible.
 * @param snapshot Optional in-memory override; when provided, its `text` is parsed
 *        instead of reading `configPath` from disk.
 * @returns The validated panel config with absolutized roots.
 * @throws Error when the config cannot be read or parsed, is missing required fields,
 *         defines no experts, contains duplicate expert ids (case-insensitive), or a
 *         knowledge root is inaccessible.
 */
export async function loadExpertConfig(snapshot?: { configPath: string; text: string }): Promise<ExpertPanelConfig> {
  const configPath = snapshot?.configPath ?? expertConfigPath();
  const configDir = path.dirname(configPath);
  const parsed = JSON.parse(snapshot?.text ?? await readFile(configPath, "utf8")) as ExpertPanelConfig;

  if (!Array.isArray(parsed.experts) || parsed.experts.length === 0) {
    throw new Error(`Expert panel config must define at least one expert: ${configPath}`);
  }

  const experts = await Promise.all(parsed.experts.map(expert => normalizeExpert(expert, configDir)));
  const ids = new Set<string>();
  for (const expert of experts) {
    const key = expert.id.toLowerCase();
    if (ids.has(key)) throw new Error(`Expert panel config contains duplicate expert id "${expert.id}".`);
    ids.add(key);
  }
  return {
    ...parsed,
    experts
  };
}

/**
 * Resolve the experts.json path: the absolute `EXPERT_PANEL_CONFIG` env override when
 * set, otherwise a default `config/experts.json` resolved four directory levels above
 * this module's directory.
 * @returns Absolute config file path.
 * @throws Never.
 */
export function expertConfigPath(): string {
  if (process.env.EXPERT_PANEL_CONFIG) {
    return path.resolve(process.env.EXPERT_PANEL_CONFIG);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../config/experts.json");
}

/**
 * Validate and normalize one expert entry: require non-empty id/title/description/
 * systemPrompt, require at least one knowledge root, resolve roots against the config
 * directory, and verify each root exists as a file or directory.
 * @param expert Raw expert entry from the parsed config.
 * @param configDir Directory containing the config file; relative roots resolve against it.
 * @returns A trimmed copy of the expert with absolutized roots.
 * @throws Error when a required field is missing or empty, no roots are defined, or a
 *         root is inaccessible.
 */
async function normalizeExpert(expert: ExpertConfig, configDir: string): Promise<ExpertConfig> {
  for (const key of ["id", "title", "description", "systemPrompt"] as const) {
    if (typeof expert[key] !== "string" || expert[key].trim() === "") {
      throw new Error(`Expert "${expert.id ?? "(unknown)"}" is missing required field "${key}".`);
    }
  }

  if (!Array.isArray(expert.roots) || expert.roots.length === 0) {
    throw new Error(`Expert "${expert.id}" must define at least one knowledge root.`);
  }

  const roots = expert.roots.map(root => path.resolve(configDir, root));
  for (const root of roots) {
    try {
      const info = await stat(root);
      if (!info.isDirectory() && !info.isFile()) throw new Error('not a directory or file');
    } catch {
      throw new Error(`Expert "${expert.id}" has an inaccessible knowledge root: ${root}`);
    }
  }
  return {
    ...expert,
    id: expert.id.trim(),
    title: expert.title.trim(),
    description: expert.description.trim(),
    systemPrompt: expert.systemPrompt.trim(),
    roots
  };
}
