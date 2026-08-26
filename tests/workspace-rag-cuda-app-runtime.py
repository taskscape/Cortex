"""Deterministic behavioral coverage for the CUDA sidecar without PyTorch or a GPU.

The test replaces the sidecar's external imports with tiny in-memory doubles, then
loads the real app module.  That keeps CUDA-only packages and model downloads out
of the ordinary Node test lane while exercising the actual health and embed code.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
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
    "EMBEDDING_DTYPE",
)


class FakeHttpException(Exception):
    """Stand-in for ``fastapi.HTTPException`` carrying status code and detail."""

    def __init__(self, *, status_code: int, detail: str):
        """Store the response status and human-readable detail.

        Args:
            status_code: HTTP status code the exception represents.
            detail: Error message exposed to clients.
        """
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeFastApi:
    """Minimal FastAPI double that records route handlers by method and path."""

    def __init__(self, **_kwargs):
        """Create an empty route registry.

        Args:
            **_kwargs: Ignored constructor arguments accepted by FastAPI.
        """
        self.routes: dict[tuple[str, str], object] = {}

    def get(self, path: str):
        """Build a decorator registering a GET handler.

        Args:
            path: URL path of the route.

        Returns:
            A decorator that registers the handler under (GET, path).
        """
        def register(handler):
            self.routes[("GET", path)] = handler
            return handler

        return register

    def post(self, path: str):
        """Build a decorator registering a POST handler.

        Args:
            path: URL path of the route.

        Returns:
            A decorator that registers the handler under (POST, path).
        """
        def register(handler):
            self.routes[("POST", path)] = handler
            return handler

        return register


class FakeCuda:
    """In-memory ``torch.cuda`` double with a configurable availability flag."""

    def __init__(self, available: bool):
        """Configure fake CUDA availability.

        Args:
            available: Value returned by :meth:`is_available`.
        """
        self.available = available
        self.empty_cache_calls = 0

    def is_available(self) -> bool:
        """Report whether CUDA is (faked as) available.

        Returns:
            The availability flag passed to the constructor.
        """
        return self.available

    def get_device_name(self, _index: int) -> str:
        """Return the fake device name.

        Args:
            _index: Device index; ignored.

        Returns:
            A fixed GPU name when available, otherwise ``"cpu"``.
        """
        return "fake-nvidia" if self.available else "cpu"

    def empty_cache(self) -> None:
        """Record an empty-cache call instead of releasing memory."""
        self.empty_cache_calls += 1

    def reset_peak_memory_stats(self) -> None:
        """No-op replacement for resetting peak memory statistics."""
        pass

    def synchronize(self) -> None:
        """No-op replacement for device synchronization."""
        pass

    def memory_allocated(self) -> int:
        """Return a fixed allocated-memory figure.

        Returns:
            Always 1024 bytes.
        """
        return 1024

    def max_memory_allocated(self) -> int:
        """Return a fixed peak-memory figure.

        Returns:
            Always 2048 bytes.
        """
        return 2048


class FakeMatrix:
    """Numpy-array double exposing only ``astype`` and ``tolist``."""

    def __init__(self, vectors: list[list[float]]):
        """Wrap precomputed embedding vectors.

        Args:
            vectors: Embedding rows to expose.
        """
        self.vectors = vectors

    def astype(self, _dtype: str) -> "FakeMatrix":
        """Pretend to convert the matrix dtype.

        Args:
            _dtype: Requested dtype; ignored.

        Returns:
            The same instance.
        """
        return self

    def tolist(self) -> list[list[float]]:
        """Convert the wrapped vectors to nested lists.

        Returns:
            The stored embedding rows.
        """
        return self.vectors


class FakeBackends:
    """In-memory ``torch.backends`` double recording TF32 toggles."""

    def __init__(self) -> None:
        self.cuda = types.SimpleNamespace(matmul=types.SimpleNamespace(allow_tf32=False))
        self.cudnn = types.SimpleNamespace(allow_tf32=False)


class Recorder:
    """Captures model loads and encode calls made by the app under test."""

    def __init__(self, *, raise_oom: bool):
        """Create a recorder.

        Args:
            raise_oom: When true, fake encoding raises a CUDA OOM error.
        """
        self.raise_oom = raise_oom
        self.loads: list[tuple[str, dict[str, object]]] = []
        self.encode_calls: list[dict[str, object]] = []
        self.dtype_calls: list[object] = []
        self.backends = FakeBackends()


def make_sentence_transformer(recorder: Recorder):
    """Build a SentenceTransformer double wired to a recorder.

    Args:
        recorder: Sink for load and encode events.

    Returns:
        A fake model class that records constructor options and either
        produces deterministic embeddings or raises a CUDA OOM error.
    """
    class FakeSentenceTransformer:
        """SentenceTransformer double with deterministic dimensions."""

        def __init__(self, name: str, **options: object):
            """Record the requested model and options.

            Args:
                name: Model identifier requested by the app.
                **options: Keyword options forwarded by the app.
            """
            self.name = name
            self.max_seq_length = 512
            recorder.loads.append((name, options))

        def to(self, *, dtype: object = None, **_kwargs: object) -> "FakeSentenceTransformer":
            """Record a dtype conversion instead of moving parameters.

            Args:
                dtype: Torch dtype requested by the app.
                **_kwargs: Ignored keyword arguments accepted by ``Module.to``.

            Returns:
                The same instance, mirroring ``Module.to`` semantics.
            """
            recorder.dtype_calls.append(dtype)
            return self

        def get_sentence_embedding_dimension(self) -> int:
            """Derive the embedding dimension from the model name.

            Returns:
                768 for E5-family models, otherwise 384.
            """
            return 768 if "e5-" in self.name.lower().replace("_", "-") else 384

        def encode(self, texts, **options: object) -> FakeMatrix:
            """Record the call and return deterministic embeddings.

            Args:
                texts: Prefixed texts to encode.
                **options: Encode options such as batch size.

            Returns:
                A :class:`FakeMatrix` with one row per text.

            Raises:
                RuntimeError: When the recorder is configured to simulate
                    CUDA out-of-memory failures.
            """
            recorder.encode_calls.append({"texts": list(texts), **options})
            if recorder.raise_oom:
                raise RuntimeError("CUDA out of memory while encoding fixture")
            dimensions = self.get_sentence_embedding_dimension()
            return FakeMatrix([[float(index + 1)] * dimensions for index, _text in enumerate(texts)])

    return FakeSentenceTransformer


def field(*_args, **kwargs):
    """Stand-in for ``pydantic.Field`` usable with the plain BaseModel double.

    Args:
        *_args: Positional arguments; ignored.
        **kwargs: May contain ``default`` or ``default_factory``.

    Returns:
        The default value, or the factory result when a factory is given.
    """
    factory = kwargs.get("default_factory")
    return factory() if factory is not None else kwargs.get("default")


def load_app(*, env: dict[str, str], cuda_available: bool, raise_oom: bool = False):
    """Load a fresh copy of app.py with mocked third-party modules."""

    recorder = Recorder(raise_oom=raise_oom)
    fake_cuda = FakeCuda(cuda_available)
    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = fake_cuda
    fake_torch.backends = recorder.backends
    fake_torch.float16 = "torch.float16"
    fake_torch.bfloat16 = "torch.bfloat16"
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
    """Build a request-like object for the embed endpoint.

    Args:
        texts: Texts to embed.
        input_type: Either ``"query"`` or ``"document"``.

    Returns:
        A namespace exposing ``texts`` and ``inputType``.
    """
    return types.SimpleNamespace(texts=texts, inputType=input_type)


def expect_http_exception(action, *, status: int, detail: str) -> None:
    """Assert that an action raises the expected fake HTTP exception.

    Args:
        action: Zero-argument callable expected to raise ``FakeHttpException``.
        status: Expected status code.
        detail: Substring required in the exception detail.

    Raises:
        AssertionError: When no exception is raised or fields do not match.
    """
    try:
        action()
    except FakeHttpException as error:
        assert error.status_code == status, error.status_code
        assert detail in error.detail, error.detail
    else:
        raise AssertionError("Expected FakeHttpException")


def test_cuda_detection_failure() -> None:
    """Verify CPU-only mode reports health without encoding and rejects embeds."""
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
    """Verify E5 profile prefixes, pinned revision, and cached model reuse."""
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
    """Verify CUDA OOM becomes a retryable 503 and frees cached GPU blocks."""
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


def test_default_dtype_is_float16_with_conversion_and_signature() -> None:
    """Verify reduced precision is on by default for every workspace."""
    module, recorder, _cuda = load_app(
        env={"EMBEDDING_BATCH_SIZE": "2"},
        cuda_available=True,
    )
    assert module.DTYPE_ENV == "float16"
    assert recorder.dtype_calls == ["torch.float16"]
    assert recorder.backends.cuda.matmul.allow_tf32 is True
    assert recorder.backends.cudnn.allow_tf32 is True
    fp16_payload = {
        "model": "sentence-transformers/all-MiniLM-L6-v2",
        "revision": "default",
        "profile": "plain-v1",
        "queryPrefix": "",
        "documentPrefix": "",
        "normalize": True,
        "maxTokens": 512,
        "dtype": "float16",
    }
    expected = hashlib.sha256(
        json.dumps(fp16_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    assert module.signature == expected
    assert module.health()["dtype"] == "float16"


def test_float32_keeps_legacy_signature_and_skips_conversion() -> None:
    """Verify opting out of fp16 restores byte-identical float32 signatures."""
    module, recorder, _cuda = load_app(
        env={"EMBEDDING_BATCH_SIZE": "2", "EMBEDDING_DTYPE": "float32"},
        cuda_available=True,
    )
    legacy_payload = {
        "model": "sentence-transformers/all-MiniLM-L6-v2",
        "revision": "default",
        "profile": "plain-v1",
        "queryPrefix": "",
        "documentPrefix": "",
        "normalize": True,
        "maxTokens": 512,
    }
    expected = hashlib.sha256(
        json.dumps(legacy_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    assert module.DTYPE_ENV == "float32"
    assert recorder.dtype_calls == []
    assert module.signature == expected
    assert module.health()["dtype"] == "float32"


def test_invalid_dtype_fails_fast_at_startup() -> None:
    """Verify an unsupported dtype refuses to start instead of mis-signing vectors."""
    try:
        load_app(env={"EMBEDDING_DTYPE": "int8"}, cuda_available=True)
    except RuntimeError as error:
        assert "EMBEDDING_DTYPE" in str(error)
    else:
        raise AssertionError("expected unsupported EMBEDDING_DTYPE rejection")


if __name__ == "__main__":
    test_cuda_detection_failure()
    test_e5_prefixes_revision_and_single_model_load()
    test_cuda_oom_is_retryable_and_releases_cached_blocks()
    test_default_dtype_is_float16_with_conversion_and_signature()
    test_float32_keeps_legacy_signature_and_skips_conversion()
    test_invalid_dtype_fails_fast_at_startup()
    print("workspace-rag CUDA app mock integration passes")
