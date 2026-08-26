export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

/** Glob-style match: `*`/`**` span anything (including separators); `?` spans one character. */
export function wildcardMatch(pattern: string, subject: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[\\s\\S]*')
    .replace(/\u0000/g, '[\\s\\S]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(subject);
}

/**
 * Evaluate a flattened ruleset (configured rules followed by session-approved rules) for one
 * permission + subject pattern. Last matching rule wins; `fallback` applies when nothing matches.
 */
export function evaluatePermission(
  rules: readonly PermissionRule[],
  permission: string,
  subject: string,
  fallback: PermissionAction = 'allow',
): PermissionAction {
  let action: PermissionAction | undefined;
  for (const rule of rules) {
    if (!wildcardMatch(rule.permission, permission)) continue;
    if (!wildcardMatch(rule.pattern, subject)) continue;
    action = rule.action;
  }
  return action ?? fallback;
}

export function isToolHiddenByRules(rules: readonly PermissionRule[], toolName: string): boolean {
  return evaluatePermission(rules, toolName, '*', 'allow') === 'deny';
}
