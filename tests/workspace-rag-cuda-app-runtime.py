"""Deterministic behavioral coverage for the CUDA sidecar without PyTorch or a GPU.

The test replaces the sidecar's external imports with tiny in-memory doubles, then
loads the real app module.  That keeps CUDA-only packages and model downloads out
of the ordinary Node test lane while exercising the actual health and embed code.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import types
import uuid


APP_PATH = (
    Path(__file__).resolve().parents[1]
    / "local-agent"
    / "docker"
    / "mem0"
    / "workspace-rag-cuda"
    / "app.py"
)
APP_ENV = (
    "EMBEDDING_MODEL",
    "EMBEDDING_MODEL_REVISION",
    "EMBEDDING_PROFILE",
    "EMBEDDING_BATCH_SIZE",
    "EMBEDDING_QUERY_PREFIX",
    "EMBEDDING_DOCUMENT_PREFIX",
)


class FakeHttpException(Exception):
    def __init__(self, *, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeFastApi:
    def __init__(self, **_kwargs):
        self.routes: dict[tuple[str, str], object] = {}

    def get(self, path: str):
        def register(handler):
            self.routes[("GET", path)] = handler
            return handler

        return register

    def post(self, path: str):
        def register(handler):
            self.routes[("POST", path)] = handler
            return handler

        return register


class FakeCuda:
    def __init__(self, available: bool):
        self.available = available
        self.empty_cache_calls = 0

    def is_available(self) -> bool:
        return self.available

    def get_device_name(self, _index: int) -> str:
        return "fake-nvidia" if self.available else "cpu"

    def empty_cache(self) -> None:
        self.empty_cache_calls += 1

    def reset_peak_memory_stats(self) -> None:
        pass

    def synchronize(self) -> None:
        pass

    def memory_allocated(self) -> int:
        return 1024

    def max_memory_allocated(self) -> int:
        return 2048


class FakeMatrix:
    def __init__(self, vectors: list[list[float]]):
        self.vectors = vectors

    def astype(self, _dtype: str) -> "FakeMatrix":
        return self

    def tolist(self) -> list[list[float]]:
        return self.vectors


class Recorder:
    def __init__(self, *, raise_oom: bool):
        self.raise_oom = raise_oom
        self.loads: list[tuple[str, dict[str, object]]] = []
        self.encode_calls: list[dict[str, object]] = []


def make_sentence_transformer(recorder: Recorder):
    class FakeSentenceTransformer:
        def __init__(self, name: str, **options: object):
            self.name = name
            self.max_seq_length = 512
            recorder.loads.append((name, options))

        def get_sentence_embedding_dimension(self) -> int:
            return 768 if "e5-" in self.name.lower().replace("_", "-") else 384

        def encode(self, texts, **options: object) -> FakeMatrix:
            recorder.encode_calls.append({"texts": list(texts), **options})
            if recorder.raise_oom:
                raise RuntimeError("CUDA out of memory while encoding fixture")
            dimensions = self.get_sentence_embedding_dimension()
            return FakeMatrix([[float(index + 1)] * dimensions for index, _text in enumerate(texts)])

    return FakeSentenceTransformer


def field(*_args, **kwargs):
    factory = kwargs.get("default_factory")
    return factory() if factory is not None else kwargs.get("default")


def load_app(*, env: dict[str, str], cuda_available: bool, raise_oom: bool = False):
    """Load a fresh copy of app.py with mocked third-party modules."""

    recorder = Recorder(raise_oom=raise_oom)
    fake_cuda = FakeCuda(cuda_available)
    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = fake_cuda
    fake_fastapi = types.ModuleType("fastapi")
    fake_fastapi.FastAPI = FakeFastApi
    fake_fastapi.HTTPException = FakeHttpException
    fake_pydantic = types.ModuleType("pydantic")
    fake_pydantic.BaseModel = type("BaseModel", (), {})
    fake_pydantic.Field = field
    fake_sentence_transformers = types.ModuleType("sentence_transformers")
    fake_sentence_transformers.SentenceTransformer = make_sentence_transformer(recorder)
    replacements = {
        "torch": fake_torch,
        "fastapi": fake_fastapi,
        "pydantic": fake_pydantic,
        "sentence_transformers": fake_sentence_transformers,
    }
    previous_modules = {name: sys.modules.get(name) for name in replacements}
    previous_env = {name: os.environ.get(name) for name in APP_ENV}
    module_name = f"workspace_rag_cuda_test_{uuid.uuid4().hex}"
    try:
        sys.modules.update(replacements)
        for name in APP_ENV:
            os.environ.pop(name, None)
        os.environ.update(env)
        spec = importlib.util.spec_from_file_location(module_name, APP_PATH)
        if spec is None or spec.loader is None:
            raise AssertionError(f"Could not load {APP_PATH}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module, recorder, fake_cuda
    finally:
        sys.modules.pop(module_name, None)
        for name, old_module in previous_modules.items():
            if old_module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old_module
        for name, old_value in previous_env.items():
            if old_value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = old_value


def request(texts: list[str], input_type: str):
    return types.SimpleNamespace(texts=texts, inputType=input_type)


def expect_http_exception(action, *, status: int, detail: str) -> None:
    try:
        action()
    except FakeHttpException as error:
        assert error.status_code == status, error.status_code
        assert detail in error.detail, error.detail
    else:
        raise AssertionError("Expected FakeHttpException")


def test_cuda_detection_failure() -> None:
    module, recorder, _cuda = load_app(
        env={"EMBEDDING_MODEL": "sentence-transformers/all-MiniLM-L6-v2"},
        cuda_available=False,
    )
    health = module.health()
    assert health["ok"] is True
    assert health["cudaAvailable"] is False
    assert health["device"] == "cpu"
    assert health["dimensions"] == 384
    expect_http_exception(
        lambda: module.embed(request(["do not encode on CPU"], "document")),
        status=503,
        detail="CUDA is not available",
    )
    assert recorder.encode_calls == []
    assert recorder.loads == [("sentence-transformers/all-MiniLM-L6-v2", {"device": "cpu"})]


def test_e5_prefixes_revision_and_single_model_load() -> None:
    module, recorder, _cuda = load_app(
        env={
            "EMBEDDING_MODEL": "intfloat/multilingual-e5-base",
            "EMBEDDING_MODEL_REVISION": "fixture-revision",
            "EMBEDDING_PROFILE": "auto",
            "EMBEDDING_BATCH_SIZE": "3",
        },
        cuda_available=True,
    )
    health = module.health()
    assert health["cudaAvailable"] is True
    assert health["model"] == "intfloat/multilingual-e5-base"
    assert health["profile"] == "e5-asymmetric-v1"
    assert health["dimensions"] == 768
    assert health["queryPrefix"] == "query: "
    assert health["documentPrefix"] == "passage: "
    assert recorder.loads == [
        ("intfloat/multilingual-e5-base", {"device": "cuda", "revision": "fixture-revision"})
    ]

    query = module.embed(request(["find Aurora"], "query"))
    document = module.embed(request(["Aurora is cobalt"], "document"))
    assert query["inputType"] == "query"
    assert document["inputType"] == "document"
    assert len(query["embeddings"][0]) == 768
    assert query["durationMs"] >= 0
    assert query["gpuMemoryAllocatedBytes"] == 1024
    assert query["gpuMemoryPeakBytes"] == 2048
    assert recorder.encode_calls[0]["texts"] == ["query: find Aurora"]
    assert recorder.encode_calls[1]["texts"] == ["passage: Aurora is cobalt"]
    assert recorder.encode_calls[0]["batch_size"] == 3
    assert recorder.encode_calls[0]["normalize_embeddings"] is True
    assert len(recorder.loads) == 1, "requests must reuse the startup-loaded cached model"


def test_cuda_oom_is_retryable_and_releases_cached_blocks() -> None:
    module, recorder, cuda = load_app(
        env={"EMBEDDING_BATCH_SIZE": "2"},
        cuda_available=True,
        raise_oom=True,
    )
    expect_http_exception(
        lambda: module.embed(request(["large request"], "document")),
        status=503,
        detail="Reduce EMBEDDING_BATCH_SIZE and retry",
    )
    assert len(recorder.encode_calls) == 1
    assert cuda.empty_cache_calls == 1


if __name__ == "__main__":
    test_cuda_detection_failure()
    test_e5_prefixes_revision_and_single_model_load()
    test_cuda_oom_is_retryable_and_releases_cached_blocks()
    print("workspace-rag CUDA app mock integration passes")
