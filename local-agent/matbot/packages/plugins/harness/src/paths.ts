import { isAbsolute, resolve, sep } from 'node:path';

/** A harness failure surfaced as an `is_error` tool result. */
export class HarnessError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'HarnessError';
  }
}

export interface Rooted {
  workdir?: string;
}

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
