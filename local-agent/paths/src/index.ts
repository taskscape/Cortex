/**
 * Public entry point for `@local-agent/paths`: canonical path normalisation and
 * containment checks, plus workspace/security-policy access evaluation.
 * Re-exports from `./paths.js` and `./policy.js`.
 */

export {
  canonicalPath,
  isPathInside,
  isRealPathInside,
  normalizeWindowsPath,
  realCanonicalPath,
  type NormalizedPath
} from "./paths.js";

export {
  evaluateAccess,
  evaluateRealAccess,
  indexExclusions,
  loadSecurityPolicy,
  loadWorkspaceConfig,
  type AccessDecision,
  type SecurityPolicy,
  type WorkspaceConfig,
  type WorkspaceRoot
} from "./policy.js";
