import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
const VECTOR_DIMS = 384;
/**
 * Converts an unknown caught value into a message string.
 *
 * @param e - Value thrown by failing code; may be of any type.
 * @returns `e.message` for Error instances, otherwise the string form of the value.
 * @throws Never.
 */
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e);
const DEFAULT_CUDA_EMBEDDING_URL = 'http://localhost:8890';
const CUDA_EMBED_REQUEST_LIMIT = 256;
const CUDA_EMBED_TIMEOUT_MS = 120000;
const CUDA_EMBED_MAX_ATTEMPTS = 3;
const CPU_VECTOR_BACKEND = 'hash-cpu';
const CPU_VECTOR_MODEL = 'token-hash-v1';
/** Hardware target an embedding backend runs on. */
export type Accelerator = 'nvidia' | 'cpu';
/** Identifies which embedding implementation produced vectors. */
export type VectorizerBackend = 'hash-cpu' | 'cuda-http';
/** Whether text is embedded as a query or as indexed document content (some models use asymmetric prefixes). */
export type EmbeddingPurpose = 'query' | 'document';
/**
 * Static identity of an embedding backend: which implementation, model, and
 * preprocessing produced its vectors. Vectors are only mixable within one
 * {@link VectorizerMetadata.signature}.
 */
export interface VectorizerMetadata {
    backend: VectorizerBackend;
    model: string;
    dimensions: number;
    /** Pipeline identity reported by the backend; embeddings from different signatures must not be mixed. */
    signature: string;
}
/**
 * Runtime view of an active vectorizer: its static metadata plus acceleration
 * and capacity details used for diagnostics and request scheduling.
 */
export interface VectorizerRuntime extends VectorizerMetadata {
    accelerated: boolean;
    accelerator: Accelerator;
    profile: string;
    /** Maximum input tokens per text accepted by the backend, when it reports one. */
    maxTokens?: number;
    /** Maximum number of texts accepted per embed request, when it reports one. */
    batchSize?: number;
}
/** Embeds texts for retrieval, returning one vector per input in input order. */
export interface TextVectorizer {
    readonly info: VectorizerRuntime;
    embed(texts: readonly string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<number[][]>;
}
/**
 * Splits text into lowercase word tokens for hash-based vectorization.
 *
 * @param text - Arbitrary input text, matched case-insensitively after lowercasing.
 * @returns Tokens of two or more Latin letters or digits, in occurrence order; empty when nothing matches.
 * @throws Never.
 */
function tokenize(text: string): string[] {
    return text.toLowerCase().match(/[a-z0-9\u00c0-\u024f]{2,}/g) ?? [];
}
/**
 * Embeds text deterministically on the CPU via the hashing trick: each token
 * is SHA-1 hashed into one of {@link VECTOR_DIMS} buckets, token counts are
 * accumulated, and the vector is L2-normalized. No model is involved.
 *
 * @param text - Text to embed; may be empty.
 * @returns A {@link VECTOR_DIMS}-dimensional unit-length vector, or all zeros when the text has no tokens.
 * @throws Never.
 */
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
/**
 * Builds the static runtime descriptor advertised by {@link HashCpuVectorizer}.
 *
 * @returns A fresh {@link VectorizerRuntime} describing the CPU hash backend.
 * @throws Never.
 */
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
/**
 * Fallback {@link TextVectorizer} that embeds text locally with the SHA-1
 * token-hashing trick ({@link vectorize}). Needs no service, GPU, or network,
 * and treats query and document purposes identically.
 */
export class HashCpuVectorizer implements TextVectorizer {
    readonly info = cpuVectorizerInfo();
    /**
     * Vectorizes each text locally; `_purpose` exists for the
     * {@link TextVectorizer} contract but is ignored because hashing is symmetric.
     *
     * @param texts - Texts to embed; may be empty.
     * @param _purpose - Unused; accepted to satisfy {@link TextVectorizer.embed}.
     * @returns One vector per input, in input order.
     * @throws Never.
     */
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
 *
 * @param health - Health payload as reported by the sidecar; missing fields count as violations.
 * @returns A human-readable description of the first contract violation, or undefined when the payload is acceptable.
 * @throws Never.
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
/**
 * Outcome of vectorizer startup: the chosen backend plus an explanation of
 * why GPU acceleration was or was not enabled.
 */
export interface VectorizerLaunchState {
    vectorizer: TextVectorizer;
    /** True when an NVIDIA GPU was detected via nvidia-smi, independent of sidecar availability. */
    nvidiaAvailable: boolean;
    /** True when the CUDA sidecar answered with a payload that passed health validation. */
    cudaAvailable: boolean;
    /** Normalized sidecar base URL; undefined when CPU mode was forced before any probe. */
    cudaServiceUrl?: string;
    /** Human-readable explanation of the acceleration decision, meant for logs and status UI. */
    accelerationMessage: string;
}
/**
 * Interprets an environment variable as a boolean switch.
 *
 * @param value - Raw environment value; undefined or unrecognized text counts as false.
 * @returns True for "1", "true", "yes", or "on" in any casing.
 * @throws Never.
 */
function isTruthyEnv(value: string | undefined): boolean {
    return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}
/**
 * Normalizes a configured sidecar URL for request building.
 *
 * @param value - Raw configured URL; undefined or blank selects the default localhost URL.
 * @returns The trimmed URL without trailing slashes.
 * @throws Never.
 */
function normalizeBaseUrl(value: string | undefined): string {
    return (value?.trim() || DEFAULT_CUDA_EMBEDDING_URL).replace(/\/+$/, '');
}
/**
 * Performs an HTTP GET that is aborted once the timeout elapses.
 *
 * @param url - Absolute URL to request.
 * @param timeoutMs - Milliseconds to wait before the request is aborted.
 * @returns The response for whatever HTTP status was received; non-2xx is not treated as failure here.
 * @throws {DOMException} "AbortError" when timeoutMs elapses before the response headers arrive.
 * @throws {TypeError} When the network request fails (DNS, connection refused, and similar).
 */
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
/**
 * Probes the sidecar's /health endpoint with a 1.5-second timeout and
 * validates the payload via {@link validateCudaEmbeddingHealth}. Never
 * rejects: transport and validation failures are reported as an unhealthy
 * payload carrying a `message` instead.
 *
 * @param baseUrl - Normalized sidecar base URL without trailing slash.
 * @returns A sanitized health payload; `ok` is false with a `message` when the probe or validation failed.
 * @throws Never.
 */
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
/**
 * {@link TextVectorizer} backed by a CUDA sidecar over HTTP. Startup health
 * metadata is captured and every embed response is re-validated against it so
 * silent sidecar changes (model, preprocessing, dimensions) fail fast instead
 * of writing incompatible vectors into the index.
 */
class CudaHttpVectorizer implements TextVectorizer {
    readonly info: VectorizerRuntime;
    private readonly baseUrl: string;
    /**
     * Captures the sidecar endpoint and the health-probe metadata that later
     * embed responses must match.
     *
     * @param baseUrl - Normalized sidecar base URL without trailing slash.
     * @param health - Validated startup health values as produced by {@link probeCudaEmbeddingService}.
     * @throws Never.
     */
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
    /**
     * Embeds all texts, splitting them into sidecar-sized batches of at most
     * {@link CUDA_EMBED_REQUEST_LIMIT} texts that are sent sequentially.
     *
     * @param texts - Texts to embed; may be empty.
     * @param purpose - Forwarded to the sidecar as `inputType` (asymmetric models prefix differently per purpose).
     * @param signal - Optional abort signal; aborting cancels the remaining batches.
     * @returns One vector per input, in input order.
     * @throws {Error} When any batch fails after retries or a response fails validation; see {@link CudaHttpVectorizer.embedBatch}.
     */
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
    /**
     * Sends one batch to the sidecar's /embed endpoint. Transient failures
     * (429, 5xx, network errors) are retried with exponential backoff (1s
     * doubling, capped at 10s) up to {@link CUDA_EMBED_MAX_ATTEMPTS} attempts;
     * an abort stops retrying immediately. Each response is validated against
     * the startup metadata and each vector's shape before it is returned.
     *
     * @param texts - Batch of texts for this request; at most {@link CUDA_EMBED_REQUEST_LIMIT} entries.
     * @param purpose - Expected `inputType` that the response must echo.
     * @param offset - Index of this batch's first text within the overall embed call; used for error messages.
     * @param signal - Optional caller abort signal, combined with the per-attempt timeout.
     * @returns One finite vector per input, in input order, each with the startup dimensionality.
     * @throws {DOMException} "AbortError" when the caller's signal aborts the request.
     * @throws {Error} When all attempts fail, when the HTTP status is not ok, when model, signature, dimensions, or inputType no longer match the startup metadata, when the embeddings array is missing or its length differs, or when any vector is malformed or non-finite.
     * @throws {SyntaxError} When the response body is not valid JSON.
     */
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
/**
 * Selects and constructs the embedding backend at startup. Reads
 * `CORTEX_RAG_EMBEDDING_BACKEND` (`auto`, `cpu`, or `cuda`), honors
 * `CORTEX_RAG_DISABLE_CUDA`, resolves the sidecar URL from
 * `CORTEX_RAG_CUDA_EMBEDDING_URL` or `CORTEX_RAG_EMBEDDING_URL`, detects an
 * NVIDIA GPU, and probes the sidecar's health. Falls back to
 * {@link HashCpuVectorizer} unless the `cuda` backend was explicitly required.
 *
 * @returns The launch state holding the active vectorizer and a human-readable reason for the decision.
 * @throws {Error} When the configured backend name is unknown, or when backend `cuda` is required but the sidecar is unhealthy.
 */
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
/**
 * Detects an NVIDIA GPU by running `nvidia-smi -L` with a 2-second timeout.
 *
 * @returns True when nvidia-smi exits successfully; false when it is missing, times out, or fails.
 * @throws Never.
 */
async function detectNvidia(): Promise<boolean> {
    return new Promise(resolve => {
        const child = execFile('nvidia-smi', ['-L'], { timeout: 2000 }, error => resolve(!error));
        child.on('error', () => resolve(false));
    });
}
