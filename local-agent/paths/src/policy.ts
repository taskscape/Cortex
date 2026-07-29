import fs from "node:fs/promises";
import path from "node:path";
import { canonicalPath, isPathInside, realCanonicalPath } from "./paths.js";

export interface WorkspaceRoot {
  path: string;
  mode: "read-only" | "read-write";
  type: string;
}

export interface WorkspaceConfig {
  roots: WorkspaceRoot[];
  /**
   * Indexing-only noise filters (build output, vendor trees). Deliberately NOT an access-control
   * boundary: the shipped patterns are .NET/Node build-artefact filters (`**\packages\**`,
   * `**\dist\**`, `**\bin\**`), so enforcing them in the broker would make ordinary source
   * unreadable. What gates broker access is {@link evaluateAccess} — roots, mode, and
   * `deniedPathFragments`.
   */
  indexExcludedPatterns?: string[];
  /** Former name for {@link indexExcludedPatterns}. Still honoured so existing configs keep working. */
  excludedPatterns?: string[];
}

/** The indexing exclusions in force, tolerating the pre-rename config key. */
export function indexExclusions(config: WorkspaceConfig): string[] {
  return config.indexExcludedPatterns ?? config.excludedPatterns ?? [];
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

/**
 * Apply the normal policy after resolving junctions, symlinks, and Windows
 * short-name aliases. The synchronous check remains useful for pure config
 * validation; filesystem operations must use this variant.
 */
export async function evaluateRealAccess(
  targetPath: string,
  action: "read" | "write" | "delete" | "list",
  workspaces: WorkspaceConfig,
  policy: SecurityPolicy
): Promise<AccessDecision> {
  const lexical = evaluateAccess(targetPath, action, workspaces, policy);
  if (!lexical.allowed) return lexical;

  const realTarget = await realCanonicalPath(targetPath);
  const deniedFragment = policy.deniedPathFragments.find(fragment => {
    return realTarget.includes(fragment.toLowerCase());
  });
  if (deniedFragment) {
    return { allowed: false, reason: `Denied path fragment matched after resolving links: ${deniedFragment}` };
  }

  for (const root of workspaces.roots) {
    const realRoot = await realCanonicalPath(root.path);
    if (isPathInside(realTarget, realRoot)) return lexical;
  }
  return { allowed: false, reason: "Resolved path is outside configured workspace roots." };
}
