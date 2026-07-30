import hashlib
import json
import os
from typing import List

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer


MODEL_NAME = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
MODEL_REVISION = os.getenv("EMBEDDING_MODEL_REVISION", "").strip() or None
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "32"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def resolve_profile(model_name: str) -> str:
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
signature = hashlib.sha256(
    json.dumps(signature_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
).hexdigest()


class EmbedRequest(BaseModel):
    texts: List[str] = Field(default_factory=list, max_length=256)
    inputType: str = Field(default="document", pattern="^(query|document)$")


@app.get("/health")
def health():
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
        "message": "CUDA available." if cuda_available else "CUDA is not available to PyTorch.",
    }


@app.post("/embed")
def embed(request: EmbedRequest):
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
    embeddings = model.encode(
        prepared_texts,
        batch_size=BATCH_SIZE,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return {
        "model": MODEL_NAME,
        "profile": PROFILE,
        "signature": signature,
        "dimensions": dimensions,
        "inputType": request.inputType,
        "embeddings": embeddings.astype("float32").tolist(),
    }
