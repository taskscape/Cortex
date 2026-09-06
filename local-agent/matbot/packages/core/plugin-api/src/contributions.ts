/** Extension contracts are augmented by capability type packages, not by the runtime. */
export interface ContributionKinds {
}
/**
 * A single registered extension: one plugin's (`owner`'s) `value` under an extension `kind`,
 * identified by `id` and carrying an abort `signal` that fires when the contribution is
 * unregistered or its owner plugin is unloaded.
 */
export interface Contribution<K extends keyof ContributionKinds = keyof ContributionKinds> {
    id: string;
    owner: string;
    value: ContributionKinds[K];
    signal: AbortSignal;
}
/**
 * Loader-scoped registry of {@link Contribution}s, obtained per plugin (each registry only
 * registers contributions for its own plugin). Registrations are revoked wholesale when the
 * owning plugin fails setup or unloads.
 */
export interface ContributionRegistry {
    /**
     * Register one contribution under an extension kind.
     *
     * @typeParam K - The extension kind being contributed to.
     * @param kind - The extension kind key (the augmented `ContributionKinds` member).
     * @param id - Plugin-chosen identifier, unique per kind; restricted to `[a-zA-Z0-9._-]`.
     * @param value - The kind-specific extension payload.
     * @returns An unregister function that removes this contribution and aborts its `signal`.
     * @throws Error When `id` is malformed or already registered under this kind (and, for
     *                `http`-shaped kinds, when the route is malformed or duplicates another).
     */
    register<K extends keyof ContributionKinds>(kind: K, id: string, value: ContributionKinds[K]): () => void;
    /**
     * Enumerate the contributions registered under one kind.
     *
     * @typeParam K - The extension kind to list.
     * @param kind - The extension kind key.
     * @returns The matching contributions in registration order.
     */
    list<K extends keyof ContributionKinds>(kind: K): ReadonlyArray<Contribution<K>>;
}
