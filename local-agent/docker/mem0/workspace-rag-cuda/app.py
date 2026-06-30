import os
from typing import List

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer


MODEL_NAME = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "32"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

app = FastAPI(title="Cortex workspace-rag CUDA embeddings")
model = SentenceTransformer(MODEL_NAME, device=DEVICE)
dimensions = int(model.get_sentence_embedding_dimension() or 0)


class EmbedRequest(BaseModel):
    texts: List[str] = Field(default_factory=list, max_length=256)


@app.get("/health")
def health():
    cuda_available = torch.cuda.is_available()
    return {
        "ok": True,
        "cudaAvailable": cuda_available,
        "device": torch.cuda.get_device_name(0) if cuda_available else DEVICE,
        "model": MODEL_NAME,
        "dimensions": dimensions,
        "message": "CUDA available." if cuda_available else "CUDA is not available to PyTorch.",
    }


@app.post("/embed")
def embed(request: EmbedRequest):
    if not torch.cuda.is_available():
        raise HTTPException(status_code=503, detail="CUDA is not available to PyTorch.")
    if not request.texts:
        return {"model": MODEL_NAME, "dimensions": dimensions, "embeddings": []}

    embeddings = model.encode(
        request.texts,
        batch_size=BATCH_SIZE,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return {
        "model": MODEL_NAME,
        "dimensions": dimensions,
        "embeddings": embeddings.astype("float32").tolist(),
    }
