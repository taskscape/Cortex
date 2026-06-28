import fs from "node:fs/promises";
import path from "node:path";
import { canonicalPath, isPathInside } from "./path-normalization.js";

export interface WorkspaceRoot {
  path: string;
  mode: "read-only" | "read-write";
  type: string;
}

export interface WorkspaceConfig {
  roots: WorkspaceRoot[];
  excludedPatterns: string[];
}

export interface SecurityPolicy {
  deniedPathFragments: string[];
  highRiskExtensions: string[];
  maxReadBytes: number;
  backupRoot: string;
}

export interface AccessDecision {
  allowed: boolean;
  mode?: "read-only" | "read-write";
  reason?: string;
  highRisk?: boolean;
}

export async function loadWorkspaceConfig(configPath: string): Promise<WorkspaceConfig> {
  return JSON.parse(await fs.readFile(configPath, "utf8")) as WorkspaceConfig;
}

export async function loadSecurityPolicy(configPath: string): Promise<SecurityPolicy> {
  return JSON.parse(await fs.readFile(configPath, "utf8")) as SecurityPolicy;
}

export function evaluateAccess(
  targetPath: string,
  action: "read" | "write" | "delete" | "list",
  workspaces: WorkspaceConfig,
  policy: SecurityPolicy
): AccessDecision {
  const canonical = canonicalPath(targetPath);
  const deniedFragment = policy.deniedPathFragments.find(fragment => {
    return canonical.includes(fragment.toLowerCase());
  });

  if (deniedFragment) {
    return { allowed: false, reason: `Denied path fragment matched: ${deniedFragment}` };
  }

  const root = workspaces.roots.find(item => isPathInside(targetPath, item.path));

  if (!root) {
    return { allowed: false, reason: "Path is outside configured workspace roots." };
  }

  if ((action === "write" || action === "delete") && root.mode !== "read-write") {
    return { allowed: false, mode: root.mode, reason: "Workspace root is read-only." };
  }

  const extension = path.extname(targetPath).toLowerCase();
  const highRisk = policy.highRiskExtensions.includes(extension) || path.basename(targetPath).toLowerCase().startsWith(".env");

  if (action === "delete") {
    return { allowed: false, mode: root.mode, reason: "Delete requires explicit out-of-band approval.", highRisk: true };
  }

  return { allowed: true, mode: root.mode, highRisk };
}
