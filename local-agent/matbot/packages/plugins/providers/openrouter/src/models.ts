/** Safe model metadata used for optional discovery hints; inference never depends on this cache. */
export interface OpenRouterModelMetadata {
  id: string;
  name?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  supportsTools?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  /** Informational public pricing only; missing values are deliberately left unknown. */
  pricing?: Record<string, string | number>;
}

export interface OpenRouterCatalogSnapshot {
  models: OpenRouterModelMetadata[];
  fetchedAt: string;
  /** True when refresh failed and the last verified result is being retained. */
  stale: boolean;
}

export interface OpenRouterCatalogServiceOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

const DEFAULT_CATALOG_TTL_MS = 10 * 60_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Normalize only stable, non-secret catalog fields; malformed rows are ignored. */
export function normalizeOpenRouterModel(value: unknown): OpenRouterModelMetadata | undefined {
  const raw = record(value);
  if (raw === undefined || typeof raw['id'] !== 'string' || !raw['id'].trim()) return undefined;
  const architecture = record(raw['architecture']);
  const modalities = Array.isArray(architecture?.['input_modalities']) ? architecture!['input_modalities'] : [];
  const outputModalities = Array.isArray(architecture?.['output_modalities']) ? architecture!['output_modalities'] : [];
  const topProvider = record(raw['top_provider']);
  const rawPricing = record(raw['pricing']);
  const pricing: Record<string, string | number> | undefined = rawPricing === undefined
    ? undefined
    : Object.fromEntries(Object.entries(rawPricing)
      .filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number' && Number.isFinite(entry[1])));
  const features = raw['supported_parameters'];
  const supports = (name: string): boolean | undefined => Array.isArray(features) ? features.includes(name) : undefined;
  const supportsTools = supports('tools');
  const supportsReasoning = supports('reasoning');
  return {
    id: raw['id'], ...(typeof raw['name'] === 'string' ? { name: raw['name'] } : {}),
    ...(typeof raw['context_length'] === 'number' && Number.isFinite(raw['context_length']) ? { contextLength: raw['context_length'] } : {}),
    ...(typeof topProvider?.['max_completion_tokens'] === 'number' && Number.isFinite(topProvider['max_completion_tokens']) ? { maxCompletionTokens: topProvider['max_completion_tokens'] } : {}),
    ...(modalities.every(value => typeof value === 'string') ? { inputModalities: modalities as string[] } : {}),
    ...(outputModalities.every(value => typeof value === 'string') ? { outputModalities: outputModalities as string[] } : {}),
    ...(supportsTools !== undefined ? { supportsTools } : {}),
    ...(modalities.includes('image') ? { supportsImages: true } : {}),
    ...(supportsReasoning !== undefined ? { supportsReasoning } : {}),
    ...(pricing !== undefined && Object.keys(pricing).length > 0 ? { pricing } : {}),
  };
}

/** Fetch the public catalog as an explicit discovery operation. Callers own caching and offline fallback. */
export async function fetchOpenRouterCatalog(fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<OpenRouterModelMetadata[]> {
  const response = await fetchImpl('https://openrouter.ai/api/v1/models', { headers: { accept: 'application/json' }, redirect: 'error', ...(signal !== undefined ? { signal } : {}) });
  if (!response.ok) throw new Error(`OpenRouter model catalog failed (${response.status}).`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 4 * 1024 * 1024) throw new Error('OpenRouter model catalog exceeds the 4 MiB safety limit.');
  const text = await response.text();
  if (text.length > 4 * 1024 * 1024) throw new Error('OpenRouter model catalog exceeds the 4 MiB safety limit.');
  let parsedValue: unknown;
  try { parsedValue = JSON.parse(text); }
  catch { throw new Error('OpenRouter model catalog returned invalid JSON.'); }
  const parsed = record(parsedValue);
  if (!Array.isArray(parsed?.['data'])) throw new Error('OpenRouter model catalog returned an invalid response.');
  return parsed!['data'].map(normalizeOpenRouterModel).filter((model): model is OpenRouterModelMetadata => model !== undefined);
}

/**
 * Process-local public catalog cache. It never carries credentials and it deliberately keeps the
 * most recent complete response on transient refresh failures, so manually configured profiles
 * and chats remain usable when discovery is offline.
 */
export class OpenRouterCatalogService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private snapshot: OpenRouterCatalogSnapshot | undefined;
  private fetchedAtMs = 0;
  private inFlight: Promise<OpenRouterCatalogSnapshot> | undefined;

  constructor(options: OpenRouterCatalogServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
  }

  async get(refresh = false): Promise<OpenRouterCatalogSnapshot> {
    if (!refresh && this.snapshot !== undefined && this.now() - this.fetchedAtMs < this.ttlMs) return this.snapshot;
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = this.refresh();
    try { return await this.inFlight; }
    finally { this.inFlight = undefined; }
  }

  private async refresh(): Promise<OpenRouterCatalogSnapshot> {
    try {
      const models = await fetchOpenRouterCatalog(this.fetchImpl, AbortSignal.timeout(this.timeoutMs));
      this.fetchedAtMs = this.now();
      this.snapshot = { models, fetchedAt: new Date(this.fetchedAtMs).toISOString(), stale: false };
      return this.snapshot;
    } catch (error) {
      if (this.snapshot !== undefined) {
        this.snapshot = { ...this.snapshot, stale: true };
        return this.snapshot;
      }
      throw error;
    }
  }
}
