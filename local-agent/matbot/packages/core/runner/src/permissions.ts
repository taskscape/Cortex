/** The decision a permission rule can produce: unconditionally permit, require approval, or block. */
export type PermissionAction = 'allow' | 'ask' | 'deny';

/**
 * One permission rule: a glob pattern over the permission name plus a glob pattern over the
 * subject (e.g. a tool argument), mapped to an action. Within a ruleset, later rules override
 * earlier ones.
 */
export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

/**
 * Glob-style match: `*`/`**` span anything (including separators); `?` spans one character.
 *
 * Implemented by escaping the pattern's regex metacharacters (so they match literally) and
 * translating the wildcards; the match is anchored to the whole subject.
 *
 * @param pattern - Glob pattern; regex metacharacters in it are treated literally.
 * @param subject - String tested against the pattern.
 * @returns True when the whole subject matches the pattern.
 * @throws Never.
 */
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
 *
 * @param rules - Rules in evaluation order; the last match wins.
 * @param permission - Permission name to test, matched against each rule's `permission` glob.
 * @param subject - Subject string to test, matched against each rule's `pattern` glob.
 * @param fallback - Action returned when no rule matches; defaults to `'allow'`.
 * @returns The winning action, or `fallback` when nothing matched.
 * @throws Never.
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

/**
 * Decide whether a tool should be hidden outright under a ruleset.
 *
 * Tests the tool name as the permission with a wildcard subject, so only rules targeting the
 * tool itself (not specific arguments) apply: an explicit `'deny'` hides; `'ask'` and unmatched
 * tools stay visible.
 *
 * @param rules - Ruleset to evaluate.
 * @param toolName - Name of the tool in question.
 * @returns True when the ruleset denies the tool.
 * @throws Never.
 */
export function isToolHiddenByRules(rules: readonly PermissionRule[], toolName: string): boolean {
  return evaluatePermission(rules, toolName, '*', 'allow') === 'deny';
}
