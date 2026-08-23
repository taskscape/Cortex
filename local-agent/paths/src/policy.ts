import fs from "node:fs/promises";
import path from "node:path";
import { canonicalPath, isPathInside, realCanonicalPath } from "./paths.js";

/** One workspace directory registered with the broker/indexer and its access mode. */
export interface WorkspaceRoot {
  /** Absolute path of the root directory. */
  path: string;
  /** Whether writes/deletes are permitted under this root. */
  mode: "read-only" | "read-write";
  /** Free-form label describing what the workspace contains. */
  type: string;
}

/** Workspace roots and indexing exclusions loaded from `workspaces.json`. */
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

/** Security constraints loaded from `security-policy.json`. */
export interface SecurityPolicy {
  /** Lowercased path fragments that are always denied. */
  deniedPathFragments: string[];
  /** File extensions requiring explicit approval for writes (`.env`, `.pem`, ...). */
  highRiskExtensions: string[];
  /** Upper bound in bytes for a single broker read. */
  maxReadBytes: number;
  /** Directory under which pre-write backups are stored. */
  backupRoot: string;
}

/** The outcome of an access check against a workspace and security policy. */
export interface AccessDecision {
  /** Whether the action may proceed. */
  allowed: boolean;
  /** Mode of the matched root, present when a root was matched. */
  mode?: "read-only" | "read-write";
  /** Human-readable explanation, present when denied (or for deletes). */
  reason?: string;
  /** True when the target is high-risk (.env-like) or requires approval to delete. */
  highRisk?: boolean;
}

/**
 * Reads and parses the workspace configuration JSON file.
 *
 * @param configPath - Path to `workspaces.json`.
 * @returns The parsed workspace configuration.
 * @throws Any error from reading the file (ENOENT, EACCES, ...).
 * @throws SyntaxError if the file is not valid JSON.
 */
export async function loadWorkspaceConfig(configPath: string): Promise<WorkspaceConfig> {
  return JSON.parse(await fs.readFile(configPath, "utf8")) as WorkspaceConfig;
}

/**
 * Reads and parses the security policy JSON file.
 *
 * @param configPath - Path to `security-policy.json`.
 * @returns The parsed security policy.
 * @throws Any error from reading the file (ENOENT, EACCES, ...).
 * @throws SyntaxError if the file is not valid JSON.
 */
export async function loadSecurityPolicy(configPath: string): Promise<SecurityPolicy> {
  return JSON.parse(await fs.readFile(configPath, "utf8")) as SecurityPolicy;
}

/**
 * Lexically evaluates whether an action on a path is permitted: checks denied
 * fragments, workspace-root containment and mode, high-risk classification,
 * and the delete-requires-approval rule. Does not resolve symlinks — use
 * {@link evaluateRealAccess} before filesystem operations.
 *
 * @param targetPath - The path being accessed.
 * @param action - The operation to perform.
 * @param workspaces - Configured workspace roots and exclusions.
 * @param policy - Security constraints (denied fragments, high-risk extensions).
 * @returns The access decision with reason/mode/highRisk details.
 */
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
 *
 * @param targetPath - The path being accessed.
 * @param action - The operation to perform.
 * @param workspaces - Configured workspace roots and exclusions.
 * @param policy - Security constraints.
 * @returns The access decision; denied if the resolved real path falls outside
 * every configured root or matches a denied fragment after link resolution.
 * @throws Any filesystem error other than ENOENT while resolving links
 * (e.g. EACCES on an ancestor).
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
