import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal, PrincipalCarrier } from '@matatbread/matbot-core';

/**
 * Node `PrincipalCarrier` backed by `AsyncLocalStorage`. Each `run`/`enter` scope is isolated per
 * async flow, so the many concurrent per-session `pump` loops (and per-request frontend handlers)
 * each carry their own principal without leaking into one another — the multi-user case ALS exists
 * for. The browser counterpart is `createConstantPrincipalCarrier` (single principal, no isolation).
 * @returns A {@link PrincipalCarrier} whose scopes are isolated per async flow.
 * @throws Never.
 */
export function createAlsPrincipalCarrier(): PrincipalCarrier {
  const als = new AsyncLocalStorage<Principal>();
  return {
    /**
     * Get the principal in force for the current async flow.
     * @returns The ambient principal.
     * @throws Error - When called outside any run/enter scope.
     */
    current(): Principal {
      const p = als.getStore();
      if (p === undefined) {
        throw new Error('No principal in context — currentPrincipal() called outside any runAs/enter scope.');
      }
      return p;
    },
    /**
     * Get the principal in force, if any.
     * @returns The ambient principal, or `undefined` outside any run/enter scope.
     * @throws Never.
     */
    tryCurrent: () => als.getStore(),
    /**
     * Establish `principal` for the async extent of `fn`; nested scopes are allowed and shadow outer ones.
     * @param principal - Principal to establish for the duration of `fn`.
     * @param fn - Callback to run under the principal.
     * @returns Whatever `fn` returns.
     * @throws Never - Errors thrown by `fn` propagate unchanged.
     */
    run: (principal, fn) => als.run(principal, fn),
    /**
     * Establish the boot principal for the remainder of the current async flow; entry points only.
     * @param principal - Principal to install; must be the first establishment on this flow.
     * @throws Error - When a principal is already established (use run for nested/delegated scopes).
     */
    enter(principal): void {
      if (als.getStore() !== undefined) {
        throw new Error('A principal is already established — enter() is for entry points; use runAs for nested/delegated scopes.');
      }
      als.enterWith(principal);
    },
  };
}
