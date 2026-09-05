/** An adapter type the startup wizard can offer (baked from matbot.web.json's providerModules). */
export interface AvailableProvider {
    label: string;
    module: string; // importable specifier of the adapter plugin
    endpointHint?: string;
    modelHint?: string;
    /** A provider that needs no endpoint/model/API key (e.g. a self-contained local adapter). The
     *  wizard hides those fields and submits with just a name; `modelHint` (if any) is used as model. */
    selfContained?: boolean;
}
/** Everything the user supplies for one provider — the browser equivalent of the CLI setup wizard. */
export interface ProviderDraft {
    name: string;
    module: string;
    endpoint: string;
    model: string;
    apiKey: string;
    /** Generation parameters (maxTokens, temperature, thinking, …) — wizard never sets this; the
     *  `provider` tool's `add` action does, mirroring the node tool's `parameters` input. */
    parameters?: Record<string, unknown>;
}
