"""CUDA embedding sidecar exposing normalized sentence embeddings over HTTP.

The FastAPI application loads a pinned sentence-transformers model at startup,
reports its configuration through ``GET /health``, and encodes batches of texts
through ``POST /embed`` with query/document prefixes and CUDA OOM handling.
"""

import hashlib
import json
import os
import time
from typing import List

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer


MODEL_NAME = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
MODEL_REVISION = os.getenv("EMBEDDING_MODEL_REVISION", "").strip() or None
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "128"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Reduced-precision inference is the default: float16 roughly doubles
# throughput and halves GPU memory on tensor-core GPUs (all RTX cards). Set
# EMBEDDING_DTYPE=float32 to restore full-precision vectors. Changing the dtype
# changes embedding values, so it is folded into the preprocessing signature: a
# sidecar restarted with a different dtype can never mix vectors into an
# existing index; Cortex rebuilds affected derivatives on the next scan.
DTYPE_ENV = os.getenv("EMBEDDING_DTYPE", "float16").strip().lower()
TORCH_DTYPES = {
    "float32": None,
    "float16": torch.float16,
    "bfloat16": torch.bfloat16,
}
if DTYPE_ENV not in TORCH_DTYPES:
    raise RuntimeError(
        f"Unsupported EMBEDDING_DTYPE '{DTYPE_ENV}' "
        "(expected float32, float16, or bfloat16)."
    )
DTYPE = TORCH_DTYPES[DTYPE_ENV]


def resolve_profile(model_name: str) -> str:
    """Resolve the embedding profile for a model.

    Args:
        model_name: Hugging Face model identifier; E5-family names select the
            asymmetric E5 profile unless overridden via ``EMBEDDING_PROFILE``.

    Returns:
        The profile name, either the configured value or
        ``e5-asymmetric-v1``/``plain-v1`` based on the model name.
    """
    configured = os.getenv("EMBEDDING_PROFILE", "auto").strip().lower()
    if configured and configured != "auto":
        return configured
    normalized = model_name.lower().replace("_", "-")
    return "e5-asymmetric-v1" if "e5-" in normalized else "plain-v1"


PROFILE = resolve_profile(MODEL_NAME)
DEFAULT_QUERY_PREFIX = "query: " if PROFILE == "e5-asymmetric-v1" else ""
DEFAULT_DOCUMENT_PREFIX = "passage: " if PROFILE == "e5-asymmetric-v1" else ""
QUERY_PREFIX = os.getenv("EMBEDDING_QUERY_PREFIX", DEFAULT_QUERY_PREFIX)
DOCUMENT_PREFIX = os.getenv("EMBEDDING_DOCUMENT_PREFIX", DEFAULT_DOCUMENT_PREFIX)

app = FastAPI(title="Cortex workspace-rag CUDA embeddings")
model_options = {"device": DEVICE}
if MODEL_REVISION:
    model_options["revision"] = MODEL_REVISION
model = SentenceTransformer(MODEL_NAME, **model_options)
if DTYPE is not None:
    model = model.to(dtype=DTYPE)
    if DEVICE == "cuda":
        # TF32 matmuls pair with reduced-precision weights on Ampere+ GPUs.
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
dimensions = int(model.get_sentence_embedding_dimension() or 0)
max_tokens = int(model.max_seq_length or 0)
signature_payload = {
    "model": MODEL_NAME,
    "revision": MODEL_REVISION or "default",
    "profile": PROFILE,
    "queryPrefix": QUERY_PREFIX,
    "documentPrefix": DOCUMENT_PREFIX,
    "normalize": True,
    "maxTokens": max_tokens,
}
if DTYPE_ENV != "float32":
    signature_payload["dtype"] = DTYPE_ENV
signature = hashlib.sha256(
    json.dumps(signature_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
).hexdigest()


class EmbedRequest(BaseModel):
    """Request body for the ``POST /embed`` endpoint.

    Attributes:
        texts: Texts to embed (at most 256).
        inputType: Either ``"query"`` or ``"document"``, selecting the prefix.
    """

    texts: List[str] = Field(default_factory=list, max_length=256)
    inputType: str = Field(default="document", pattern="^(query|document)$")


@app.get("/health")
def health():
    """Report service health and the active embedding configuration.

    Returns:
        dict: Health payload including CUDA availability, device, model,
        revision, profile, signature, dimensions, limits, and prefixes.
    """
    cuda_available = torch.cuda.is_available()
    return {
        "ok": True,
        "cudaAvailable": cuda_available,
        "device": torch.cuda.get_device_name(0) if cuda_available else DEVICE,
        "model": MODEL_NAME,
        "revision": MODEL_REVISION,
        "profile": PROFILE,
        "signature": signature,
        "dimensions": dimensions,
        "maxTokens": max_tokens,
        "batchSize": BATCH_SIZE,
        "normalized": True,
        "queryPrefix": QUERY_PREFIX,
        "documentPrefix": DOCUMENT_PREFIX,
        "dtype": DTYPE_ENV,
        "message": "CUDA available." if cuda_available else "CUDA is not available to PyTorch.",
    }


@app.post("/embed")
def embed(request: EmbedRequest):
    """Encode texts into normalized embeddings on the GPU.

    Args:
        request: Parsed embed request containing the texts and input type.

    Returns:
        dict: Model/profile/signature metadata plus the embeddings; also
        includes timing and CUDA memory statistics for non-empty batches.

    Raises:
        HTTPException: 503 when CUDA is unavailable or encoding hits a CUDA
            out-of-memory error (after releasing cached blocks).
    """
    if not torch.cuda.is_available():
        raise HTTPException(status_code=503, detail="CUDA is not available to PyTorch.")
    if not request.texts:
        return {
            "model": MODEL_NAME,
            "profile": PROFILE,
            "signature": signature,
            "dimensions": dimensions,
            "inputType": request.inputType,
            "embeddings": [],
        }

    prefix = QUERY_PREFIX if request.inputType == "query" else DOCUMENT_PREFIX
    prepared_texts = [f"{prefix}{text}" for text in request.texts]
    try:
        torch.cuda.reset_peak_memory_stats()
        torch.cuda.synchronize()
        started_at = time.perf_counter()
        embeddings = model.encode(
            prepared_texts,
            batch_size=BATCH_SIZE,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        torch.cuda.synchronize()
        duration_ms = (time.perf_counter() - started_at) * 1000
        gpu_memory_allocated_bytes = int(torch.cuda.memory_allocated())
        gpu_memory_peak_bytes = int(torch.cuda.max_memory_allocated())
    except RuntimeError as error:
        # PyTorch reports CUDA allocation failures as RuntimeError subclasses across
        # supported releases.  Return a retryable HTTP response instead of letting
        # FastAPI turn an expected capacity problem into an opaque 500.
        if "out of memory" not in str(error).lower():
            raise
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        raise HTTPException(
            status_code=503,
            detail=(
                "CUDA embedding request ran out of memory. "
                "Reduce EMBEDDING_BATCH_SIZE and retry."
            ),
        ) from error
    return {
        "model": MODEL_NAME,
        "profile": PROFILE,
        "signature": signature,
        "dimensions": dimensions,
        "inputType": request.inputType,
        "durationMs": duration_ms,
        "gpuMemoryAllocatedBytes": gpu_memory_allocated_bytes,
        "gpuMemoryPeakBytes": gpu_memory_peak_bytes,
        "embeddings": embeddings.astype("float32").tolist(),
    }
