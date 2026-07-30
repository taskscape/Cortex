import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpertConfig, ExpertPanelConfig } from "./types.js";

export async function loadExpertConfig(): Promise<ExpertPanelConfig> {
  const configPath = expertConfigPath();
  const configDir = path.dirname(configPath);
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as ExpertPanelConfig;

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

function expertConfigPath(): string {
  if (process.env.EXPERT_PANEL_CONFIG) {
    return path.resolve(process.env.EXPERT_PANEL_CONFIG);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../config/experts.json");
}

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
