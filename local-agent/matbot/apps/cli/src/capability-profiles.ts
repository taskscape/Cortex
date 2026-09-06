/** Host composition only. Capabilities retain ownership of tools, state and presentation. */
export type CapabilityProfile = 'minimal' | 'standard' | 'compatibility';
/**
 * Normalize a raw capability-profile value (from `CORTEX_CAPABILITY_PROFILE` or the config's
 * `capabilityProfile` field) into a {@link CapabilityProfile}.
 * @param value - Raw value to validate; `undefined` or an empty string selects the default.
 * @returns The validated profile, defaulting to 'standard' when unset.
 * @throws Error - When the value is not one of the three known profiles.
 */
export function selectCapabilityProfile(value: unknown): CapabilityProfile { if (value === undefined || value === '')
    return 'standard'; if (value === 'minimal' || value === 'standard' || value === 'compatibility')
    return value; throw new Error('Unknown Cortex capability profile: ' + String(value)); }
/**
 * Compose the plugin specifier list for a capability profile: host composition only, since
 * capabilities retain ownership of tools, state and presentation.
 *
 * 'minimal' passes the configured list through unchanged. 'standard' and 'compatibility' expand
 * the Cortex default plugin set, add profile-appropriate file services, validate that at most one
 * explicit memory backend is configured (falling back to the profile's default memory plugin
 * otherwise), and append any configured non-memory plugins. The result is ordered (defaults
 * first, configured extras last) and deduplicated.
 *
 * @param profile - The selected capability profile.
 * @param configured - Plugin specifiers from the `plugins:` config entry.
 * @param hasWorkspace - Whether a workspace manager is active; adds `workspace-admin` when true.
 * @param local - Maps a short plugin name to a host-resolvable specifier (local path or package name).
 * @returns Deduplicated plugin specifiers in composition order.
 * @throws Error - When more than one explicit memory backend appears in `configured`.
 */
export function profilePlugins(profile: CapabilityProfile, configured: readonly string[], hasWorkspace: boolean, local: (name: string) => string): string[] {
    if (profile === 'minimal')
        return [...configured];
    const legacyMemory = configured.some(spec => /hybrid-knowledge-index/.test(spec));
    const explicitMemory = configured.filter(spec => /memory-(mem0|local)|persist-ki-bge/.test(spec));
    if (new Set(explicitMemory).size > 1)
        throw new Error('Select exactly one memory backend');
    const configuredOther = configured.filter(spec => !/hybrid-knowledge-index|memory-(mem0|local)|persist-ki-bge/.test(spec));
    const defaults = ['storage/high-cardinality', 'runtime-admin', 'model-consultation', ...(hasWorkspace ? ['workspace-admin'] : []), 'expert-panel-session', 'configuration-admin', 'runtime-diagnostics'];
    const fileServices = profile === 'standard' ? ['host-file-access', 'file-index'] : ['file-index-client'];
    const selected = [...defaults.map(local), ...fileServices.map(local), local('retrieval-federation'), ...explicitMemory, ...(explicitMemory.length ? [] : [local(legacyMemory ? 'memory-mem0' : 'memory-local')]), local('file-index-admin'), local('file-broker-tool'), ...['source-registry', 'connector-fabric', 'structured-data', 'workflow-governance', 'evaluation-observability', 'context-graph', 'workspace-rag'].map(local), ...configuredOther];
    return [...new Set(selected)];
}
