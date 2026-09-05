/** Extension contracts are augmented by capability type packages, not by the runtime. */
export interface ContributionKinds {
}
export interface Contribution<K extends keyof ContributionKinds = keyof ContributionKinds> {
    id: string;
    owner: string;
    value: ContributionKinds[K];
    signal: AbortSignal;
}
export interface ContributionRegistry {
    register<K extends keyof ContributionKinds>(kind: K, id: string, value: ContributionKinds[K]): () => void;
    list<K extends keyof ContributionKinds>(kind: K): ReadonlyArray<Contribution<K>>;
}
