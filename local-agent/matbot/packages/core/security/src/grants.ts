import type { Principal } from '@matatbread/matbot-core';

/**
 * Convenience: the system principal — the origin for operations not driven by an external user.
 *
 * @param id - The principal id (defaults to `'system'`).
 * @returns The system principal.
 * @throws Never.
 */
export function systemPrincipal(id = 'system'): Principal {
  return { id, type: 'system' };
}
