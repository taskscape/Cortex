import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
const VECTOR_DIMS = 384;
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e);
const DEFAULT_CUDA_EMBEDDING_URL = 'http://localhost:8890';
const CUDA_EMBED_REQUEST_LIMIT = 256;
const CUDA_EMBED_TIMEOUT_MS = 120000;
const CUDA_EMBED_MAX_ATTEMPTS = 3;
const CPU_VECTOR_BACKEND = 'hash-cpu';
const CPU_VECTOR_MODEL = 'token-hash-v1';
export type Accelerator = 'nvidia' | 'cpu';
export type VectorizerBackend = 'hash-cpu' | 'cuda-http';
export type EmbeddingPurpose = 'query' | 'document';
export interface VectorizerMetadata {
    backend: VectorizerBackend;
    model: string;
    dimensions: number;
    signature: string;
}
export interface VectorizerRuntime extends VectorizerMetadata {
    accelerated: boolean;
    accelerator: Accelerator;
    profile: string;
    maxTokens?: number;
    batchSize?: number;
}
export interface TextVectorizer {
    readonly info: VectorizerRuntime;
    embed(texts: readonly string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<number[][]>;
}
function tokenize(text: string): string[] {
    return text.toLowerCase().match(/[a-z0-9\u00c0-\u024f]{2,}/g) ?? [];
}
function vectorize(text: string): number[] {
    const vector = new Array<number>(VECTOR_DIMS).fill(0);
    for (const token of tokenize(text)) {
        const hash = createHash('sha1').update(token).digest();
        const idx = hash.readUInt32BE(0) % VECTOR_DIMS;
        vector[idx] = (vector[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? vector.map(value => value / norm) : vector;
}
function cpuVectorizerInfo(): VectorizerRuntime {
    return {
        backend: CPU_VECTOR_BACKEND,
        model: CPU_VECTOR_MODEL,
        dimensions: VECTOR_DIMS,
        signature: 'hash-cpu-token-hash-v1',
        accelerated: false,
        accelerator: 'cpu',
        profile: 'token-hash-v1',
    };
}
export class HashCpuVectorizer implements TextVectorizer {
    readonly info = cpuVectorizerInfo();
    async embed(texts: readonly string[], _purpose: EmbeddingPurpose): Promise<number[][]> {
        return texts.map(text => vectorize(text));
    }
}
/**
 * Health payload reported by the CUDA embedding sidecar.
 */
export interface CudaHealthResponse {
    ok?: boolean;
    cudaAvailable?: boolean;
    device?: string;
    model?: string;
    dimensions?: number;
    profile?: string;
    signature?: string;
    maxTokens?: number;
    batchSize?: number;
    normalized?: boolean;
    queryPrefix?: string;
    documentPrefix?: string;
    message?: string;
    dtype?: string;
}
/**
 * Keep the CUDA sidecar contract in one testable place.  A status code alone is
 * not enough: vectors from a changed model or preprocessing profile cannot be
 * mixed safely with an existing Workspace RAG index.
 */
export function validateCudaEmbeddingHealth(health: CudaHealthResponse): string | undefined {
    if (health.ok !== true)
        return 'Embedding service did not report ok=true.';
    if (typeof health.model !== 'string' || !health.model.trim())
        return 'Embedding service did not report a model.';
    if (!Number.isInteger(health.dimensions) || health.dimensions! <= 0)
        return 'Embedding service reported invalid dimensions.';
    if (typeof health.profile !== 'string' || !health.profile.trim())
        return 'Embedding service did not report a profile.';
    if (typeof health.signature !== 'string' || !health.signature.trim())
        return 'Embedding service did not report a preprocessing signature.';
    if (health.normalized !== true)
        return 'Embedding service must report normalized output.';
    if (!Number.isInteger(health.batchSize) || health.batchSize! <= 0 || health.batchSize! > CUDA_EMBED_REQUEST_LIMIT) {
        return `Embedding service reported invalid batch size (expected 1-${CUDA_EMBED_REQUEST_LIMIT}).`;
    }
    if (health.profile === 'e5-asymmetric-v1') {
        if (health.queryPrefix !== 'query: ' || health.documentPrefix !== 'passage: ') {
            return 'E5 embedding service must report query: and passage: preprocessing prefixes.';
        }
        if (health.model === 'intfloat/multilingual-e5-base' && health.dimensions !== 768) {
            return 'intfloat/multilingual-e5-base must report 768 dimensions.';
        }
    }
    if (health.profile === 'plain-v1') {
        if (health.queryPrefix !== '' || health.documentPrefix !== '') {
            return 'plain-v1 embedding service must not report asymmetric preprocessing prefixes.';
        }
        if (health.model === 'sentence-transformers/all-MiniLM-L6-v2' && health.dimensions !== 384) {
            return 'sentence-transformers/all-MiniLM-L6-v2 must report 384 dimensions.';
        }
    }
    return undefined;
}
export interface VectorizerLaunchState {
    vectorizer: TextVectorizer;
    nvidiaAvailable: boolean;
    cudaAvailable: boolean;
    cudaServiceUrl?: string;
    accelerationMessage: string;
}
function isTruthyEnv(value: string | undefined): boolean {
    return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}
function normalizeBaseUrl(value: string | undefined): string {
    return (value?.trim() || DEFAULT_CUDA_EMBEDDING_URL).replace(/\/+$/, '');
}
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
async function probeCudaEmbeddingService(baseUrl: string): Promise<CudaHealthResponse> {
    try {
        const response = await fetchWithTimeout(`${baseUrl}/health`, 1500);
        if (!response.ok) {
            return { ok: false, cudaAvailable: false, message: `Embedding service returned HTTP ${response.status}.` };
        }
        const body = await response.json() as CudaHealthResponse;
        const result: CudaHealthResponse = {
            ok: body.ok === true,
            cudaAvailable: body.cudaAvailable === true,
        };
        if (typeof body.device === 'string')
            result.device = body.device;
        if (typeof body.model === 'string')
            result.model = body.model;
        if (typeof body.dimensions === 'number' && Number.isFinite(body.dimensions))
            result.dimensions = body.dimensions;
        if (typeof body.profile === 'string')
            result.profile = body.profile;
        if (typeof body.signature === 'string')
            result.signature = body.signature;
        if (typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens))
            result.maxTokens = body.maxTokens;
        if (typeof body.batchSize === 'number' && Number.isFinite(body.batchSize))
            result.batchSize = body.batchSize;
        if (typeof body.normalized === 'boolean')
            result.normalized = body.normalized;
        if (typeof body.queryPrefix === 'string')
            result.queryPrefix = body.queryPrefix;
        if (typeof body.documentPrefix === 'string')
            result.documentPrefix = body.documentPrefix;
        if (typeof body.message === 'string')
            result.message = body.message;
        if (typeof body.dtype === 'string')
            result.dtype = body.dtype;
        const validationError = validateCudaEmbeddingHealth(result);
        if (validationError !== undefined)
            return { ...result, ok: false, message: validationError };
        return result;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, cudaAvailable: false, message: `Embedding service unavailable: ${message}` };
    }
}
class CudaHttpVectorizer implements TextVectorizer {
    readonly info: VectorizerRuntime;
    private readonly baseUrl: string;
    constructor(baseUrl: string, health: Required<Pick<CudaHealthResponse, 'model' | 'dimensions' | 'profile' | 'signature' | 'batchSize'>> & Pick<CudaHealthResponse, 'maxTokens'>) {
        this.baseUrl = baseUrl;
        this.info = {
            backend: 'cuda-http',
            model: health.model,
            dimensions: health.dimensions,
            signature: health.signature,
            accelerated: true,
            accelerator: 'nvidia',
            profile: health.profile,
            batchSize: health.batchSize,
            ...(health.maxTokens !== undefined ? { maxTokens: health.maxTokens } : {}),
        };
    }
    async embed(texts: readonly string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<number[][]> {
        if (texts.length === 0)
            return [];
        const embeddings: number[][] = [];
        for (let start = 0; start < texts.length; start += CUDA_EMBED_REQUEST_LIMIT) {
            const batch = texts.slice(start, start + CUDA_EMBED_REQUEST_LIMIT);
            embeddings.push(...await this.embedBatch(batch, purpose, start, signal));
        }
        return embeddings;
    }
    private async embedBatch(texts: readonly string[], purpose: EmbeddingPurpose, offset: number, signal?: AbortSignal): Promise<number[][]> {
        const body = JSON.stringify({ texts, inputType: purpose });
        let response: Response | undefined;
        for (let attempt = 1;; attempt++) {
            const timeout = AbortSignal.timeout(CUDA_EMBED_TIMEOUT_MS);
            try {
                response = await fetch(`${this.baseUrl}/embed`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                });
            }
            catch (e) {
                if (attempt >= CUDA_EMBED_MAX_ATTEMPTS || signal?.aborted)
                    throw e;
            }
            if (response !== undefined
                && response.status !== 429 && response.status < 500)
                break;
            // Transient sidecar failure (429/5xx/network): back off and retry the batch.
            if (signal?.aborted || attempt >= CUDA_EMBED_MAX_ATTEMPTS)
                break;
            await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 10000)));
        }
        if (response === undefined)
            throw new Error('CUDA embedding service request failed.');
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`CUDA embedding service HTTP ${response.status}: ${detail.slice(0, 300)}`);
        }
        const parsed = await response.json() as {
            embeddings?: unknown;
            dimensions?: unknown;
            model?: unknown;
            signature?: unknown;
            inputType?: unknown;
        };
        if (parsed.model !== this.info.model) {
            throw new Error(`CUDA embedding service model changed from "${this.info.model}" to "${String(parsed.model)}". Restart Matbot after the sidecar is stable.`);
        }
        if (parsed.signature !== this.info.signature) {
            throw new Error('CUDA embedding service preprocessing signature changed. Restart Matbot and reindex before searching.');
        }
        if (parsed.dimensions !== this.info.dimensions) {
            throw new Error(`CUDA embedding service dimensions changed from ${this.info.dimensions} to ${String(parsed.dimensions)}.`);
        }
        if (parsed.inputType !== purpose) {
            throw new Error(`CUDA embedding service returned inputType="${String(parsed.inputType)}"; expected "${purpose}".`);
        }
        if (!Array.isArray(parsed.embeddings))
            throw new Error('CUDA embedding service returned no embeddings array.');
        if (parsed.embeddings.length !== texts.length) {
            throw new Error(`CUDA embedding service returned ${parsed.embeddings.length} embeddings for ${texts.length} text(s).`);
        }
        return parsed.embeddings.map((embedding, index) => {
            const embeddingIndex = offset + index;
            if (!Array.isArray(embedding))
                throw new Error(`CUDA embedding ${embeddingIndex} is not an array.`);
            const vector = embedding.map(value => Number(value));
            if (vector.length !== this.info.dimensions) {
                throw new Error(`CUDA embedding ${embeddingIndex} has ${vector.length} dimensions; expected ${this.info.dimensions}.`);
            }
            if (vector.some(value => !Number.isFinite(value))) {
                throw new Error(`CUDA embedding ${embeddingIndex} contains a non-finite value.`);
            }
            return vector;
        });
    }
}
export async function createLaunchVectorizer(): Promise<VectorizerLaunchState> {
    const backend = process.env.CORTEX_RAG_EMBEDDING_BACKEND ?? 'auto';
    if (!['auto', 'cpu', 'cuda'].includes(backend))
        throw new Error('Unknown RAG embedding backend: ' + backend);
    const nvidiaAvailable = await detectNvidia();
    if (backend === 'cpu' || (backend === 'auto' && isTruthyEnv(process.env['CORTEX_RAG_DISABLE_CUDA']))) {
        return {
            vectorizer: new HashCpuVectorizer(),
            nvidiaAvailable,
            cudaAvailable: false,
            accelerationMessage: 'CUDA ingestion disabled by CORTEX_RAG_DISABLE_CUDA.',
        };
    }
    const cudaServiceUrl = normalizeBaseUrl(process.env['CORTEX_RAG_CUDA_EMBEDDING_URL'] ?? process.env['CORTEX_RAG_EMBEDDING_URL']);
    const probe = await probeCudaEmbeddingService(cudaServiceUrl);
    if (probe.ok
        && probe.cudaAvailable
        && probe.model
        && probe.dimensions
        && probe.dimensions > 0
        && probe.profile
        && probe.signature
        && probe.batchSize) {
        const device = probe.device ? ` on ${probe.device}` : '';
        return {
            vectorizer: new CudaHttpVectorizer(cudaServiceUrl, {
                model: probe.model,
                dimensions: probe.dimensions,
                profile: probe.profile,
                signature: probe.signature,
                batchSize: probe.batchSize,
                ...(probe.maxTokens !== undefined ? { maxTokens: probe.maxTokens } : {}),
            }),
            nvidiaAvailable,
            cudaAvailable: true,
            cudaServiceUrl,
            accelerationMessage: `CUDA embedding backend active${device}.`,
        };
    }
    if (backend === 'cuda')
        throw new Error('Required CUDA embedding backend unavailable: ' + (probe.message ?? 'health validation failed'));
    const reason = probe.message ?? (nvidiaAvailable
        ? 'CUDA embedding service is not ready.'
        : 'NVIDIA GPU was not detected by nvidia-smi.');
    return {
        vectorizer: new HashCpuVectorizer(),
        nvidiaAvailable,
        cudaAvailable: false,
        cudaServiceUrl,
        accelerationMessage: `Using CPU hash vectorizer. ${reason}`,
    };
}
async function detectNvidia(): Promise<boolean> {
    return new Promise(resolve => {
        const child = execFile('nvidia-smi', ['-L'], { timeout: 2000 }, error => resolve(!error));
        child.on('error', () => resolve(false));
    });
}
