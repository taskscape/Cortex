/** Host composition only. Capabilities retain ownership of tools, state and presentation. */
export type CapabilityProfile = 'minimal' | 'standard' | 'compatibility';
export function selectCapabilityProfile(value: unknown): CapabilityProfile { if (value === undefined || value === '')
    return 'standard'; if (value === 'minimal' || value === 'standard' || value === 'compatibility')
    return value; throw new Error('Unknown Cortex capability profile: ' + String(value)); }
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
