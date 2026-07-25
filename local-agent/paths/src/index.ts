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
  indexExclusions,
  loadSecurityPolicy,
  loadWorkspaceConfig,
  type AccessDecision,
  type SecurityPolicy,
  type WorkspaceConfig,
  type WorkspaceRoot
} from "./policy.js";
