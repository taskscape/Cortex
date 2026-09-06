import { isAbsolute, resolve, sep } from 'node:path';

/**
 * A harness failure surfaced as an `is_error` tool result.
 *
 * Carries a machine-readable `code` (e.g. `invalid_input`, `not_found`, `conflict`,
 * `permission_denied`, `internal`) so failures can be categorized; `name` is fixed
 * to `HarnessError` for detection.
 */
export class HarnessError extends Error {
  readonly code: string;
  /**
   * Creates a harness error.
   *
   * @param message Human-readable explanation shown to the model.
   * @param code Machine-readable failure category.
   */
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'HarnessError';
  }
}

/**
 * Minimal context shape carrying the session's workspace root; `workdir` is the
 * absolute directory all harness file operations are confined to.
 */
export interface Rooted {
  workdir?: string;
}

/**
 * Resolves the workspace root for a tool context, requiring a configured `workdir`.
 *
 * @param ctx Tool context (or any {@link Rooted}) whose `workdir` supplies the root.
 * @returns The absolute, resolved workspace root path.
 * @throws HarnessError - With code `internal` when `workdir` is missing or empty.
 */
export function requireRoot(ctx: Rooted): string {
  if (ctx.workdir === undefined || ctx.workdir === '') {
    throw new HarnessError('No workspace root is configured for this session (workdir missing).', 'internal');
  }
  return resolve(ctx.workdir);
}

/**
 * Confine a requested path under the workspace root. With `{ absolute: true }` (read/edit/write),
 * relative paths are refused outright; search tools accept workspace-relative convenience paths.
 * Anything resolving outside the root — including sibling prefixes like `/root-x` vs `/root` —
 * is refused either way.
 *
 * @param root Absolute workspace root as returned by {@link requireRoot}.
 * @param requested Requested path; `undefined` resolves to the root itself.
 * @param opts `absolute: true` additionally refuses relative inputs.
 * @returns The resolved absolute path, guaranteed to equal or lie under `root`.
 * @throws HarnessError - With code `invalid_input` when a relative path is passed while `absolute` is set, or code `permission_denied` when the resolved path escapes the root.
 */
export function confine(
  root: string,
  requested: string | undefined,
  opts: { absolute?: boolean } = {},
): string {
  const target = requested ?? '.';
  const resolved = isAbsolute(target) ? resolve(target) : resolve(root, target);
  if (opts.absolute && !isAbsolute(target)) {
    throw new HarnessError(
      `"${target}" is not an absolute path. Always pass absolute file paths resolved against the workspace root "${root}".`,
      'invalid_input',
    );
  }
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new HarnessError(
      `Path "${target}" resolves outside the workspace root "${root}". All file operations are confined to the workspace.`,
      'permission_denied',
    );
  }
  return resolved;
}
