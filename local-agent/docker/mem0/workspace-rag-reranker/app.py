"""Multilingual cross-encoder reranker sidecar exposed over HTTP.

The FastAPI application loads a revision-pinned CrossEncoder model at startup
and serves ``GET /health`` plus ``POST /rerank``, scoring query/candidate pairs
with CUDA out-of-memory handling and a configurable candidate cap.
"""

import hashlib
import json
import os
from typing import List

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder


MODEL_NAME = os.getenv(
    "RERANKER_MODEL",
    "Alibaba-NLP/gte-multilingual-reranker-base",
)
MODEL_REVISION = os.getenv(
    "RERANKER_MODEL_REVISION",
    "8215cf04918ba6f7b6a62bb44238ce2953d8831c",
).strip()
if not MODEL_REVISION:
    raise RuntimeError("RERANKER_MODEL_REVISION must pin an immutable model revision")
CODE_REVISION = os.getenv(
    "RERANKER_CODE_REVISION",
    "40ced75c3017eb27626c9d4ea981bde21a2662f4",
).strip()
if not CODE_REVISION:
    raise RuntimeError("RERANKER_CODE_REVISION must pin immutable repository code")
BATCH_SIZE = int(os.getenv("RERANKER_BATCH_SIZE", "16"))
MAX_TEXTS = int(os.getenv("RERANKER_MAX_TEXTS", "100"))
MAX_LENGTH = int(os.getenv("RERANKER_MAX_LENGTH", "1024"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

model_options = {
    "device": DEVICE,
    "max_length": MAX_LENGTH,
    # This model uses repository code. The mandatory immutable revision makes
    # that code reproducible instead of trusting a moving branch.
    "trust_remote_code": True,
    "revision": MODEL_REVISION,
    "config_args": {"code_revision": CODE_REVISION},
    "automodel_args": {"code_revision": CODE_REVISION},
}

model = CrossEncoder(MODEL_NAME, **model_options)
signature = hashlib.sha256(
    json.dumps(
        {
            "model": MODEL_NAME,
            "revision": MODEL_REVISION,
            "codeRevision": CODE_REVISION,
            "maxLength": MAX_LENGTH,
        },
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")
).hexdigest()

app = FastAPI(title="Cortex workspace-rag multilingual reranker")


class RerankRequest(BaseModel):
    """Request body for the ``POST /rerank`` endpoint.

    Attributes:
        query: The query to score against (1-16384 characters).
        texts: Candidate texts; may be empty.
        truncate: Whether the model may truncate long inputs.
    """
    query: str = Field(min_length=1, max_length=16_384)
    texts: List[str] = Field(default_factory=list)
    truncate: bool = True


@app.get("/health")
def health():
    """Report service health and the active reranker configuration.

    Returns:
        dict: Health payload including CUDA availability, device, model,
        revisions, signature, and batching/length limits.
    """
    cuda_available = torch.cuda.is_available()
    return {
        "ok": True,
        "cudaAvailable": cuda_available,
        "device": torch.cuda.get_device_name(0) if cuda_available else DEVICE,
        "model": MODEL_NAME,
        "revision": MODEL_REVISION,
        "codeRevision": CODE_REVISION,
        "signature": signature,
        "batchSize": BATCH_SIZE,
        "maxTexts": MAX_TEXTS,
        "maxLength": MAX_LENGTH,
    }


@app.post("/rerank")
def rerank(request: RerankRequest):
    """Score each candidate text against the query with the cross-encoder.

    Args:
        request: Parsed rerank request containing the query and candidate texts.

    Returns:
        dict: Model name, signature, and relevance scores (one float per text,
        in input order).

    Raises:
        HTTPException: 422 when the number of texts exceeds ``MAX_TEXTS``, or
            503 when prediction fails with a CUDA out-of-memory error.
    """
    if len(request.texts) > MAX_TEXTS:
        raise HTTPException(
            status_code=422,
            detail=f"Reranking is limited to {MAX_TEXTS} candidate texts.",
        )
    if not request.texts:
        return {"model": MODEL_NAME, "signature": signature, "scores": []}
    pairs = [(request.query, text) for text in request.texts]
    try:
        scores = model.predict(
            pairs,
            batch_size=BATCH_SIZE,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
    except RuntimeError as error:
        if "out of memory" not in str(error).lower():
            raise
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        raise HTTPException(
            status_code=503,
            detail=(
                "Reranking ran out of memory. Reduce RERANKER_BATCH_SIZE or "
                "RERANKER_MAX_LENGTH and retry."
            ),
        ) from error
    return {
        "model": MODEL_NAME,
        "signature": signature,
        "scores": [float(score) for score in scores],
    }
