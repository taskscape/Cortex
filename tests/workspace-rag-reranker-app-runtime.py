"""Deterministic runtime coverage for the optional reranker service."""

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
    / "workspace-rag-reranker"
    / "app.py"
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
    """Minimal FastAPI double whose decorators pass handlers through unchanged."""

    def __init__(self, **_kwargs):
        """Accept and ignore FastAPI constructor arguments.

        Args:
            **_kwargs: Ignored keyword arguments.
        """
        pass

    def get(self, _path):
        """Return an identity decorator for a GET route.

        Args:
            _path: URL path; ignored.

        Returns:
            A decorator returning the handler as-is.
        """
        return lambda handler: handler

    def post(self, _path):
        """Return an identity decorator for a POST route.

        Args:
            _path: URL path; ignored.

        Returns:
            A decorator returning the handler as-is.
        """
        return lambda handler: handler


class FakeCuda:
    """In-memory ``torch.cuda`` double that always reports CUDA available."""

    def __init__(self):
        """Initialize the empty-cache call counter."""
        self.empty_cache_calls = 0

    def is_available(self):
        """Report CUDA availability.

        Returns:
            Always True.
        """
        return True

    def get_device_name(self, _index):
        """Return the fake device name.

        Args:
            _index: Device index; ignored.

        Returns:
            The fixed name ``"fake-gpu"``.
        """
        return "fake-gpu"

    def empty_cache(self):
        """Record an empty-cache call instead of releasing memory."""
        self.empty_cache_calls += 1


class FakeScores:
    """Iterable double standing in for the numpy score array."""

    def __init__(self, values):
        """Wrap score values.

        Args:
            values: Sequence of float scores to expose.
        """
        self.values = values

    def __iter__(self):
        """Iterate over the wrapped scores.

        Returns:
            An iterator over the stored values.
        """
        return iter(self.values)


class Recorder:
    """Captures model loads and predict calls made by the app under test."""

    def __init__(self, oom=False):
        """Create a recorder.

        Args:
            oom: When true, fake prediction raises a CUDA OOM error.
        """
        self.oom = oom
        self.loads = []
        self.calls = []


def load_app(*, oom=False):
    """Load a fresh copy of app.py with mocked third-party modules.

    Installs fake ``torch``, ``fastapi``, ``pydantic``, and
    ``sentence_transformers`` modules plus fixed reranker environment variables,
    then imports the real application module.

    Args:
        oom: When true, the fake cross-encoder raises CUDA OOM on predict.

    Returns:
        Tuple of (loaded module, recorder, FakeCuda instance).

    Raises:
        AssertionError: If the module spec cannot be created.
    """
    recorder = Recorder(oom)
    cuda = FakeCuda()

    class FakeCrossEncoder:
        """CrossEncoder double recording loads and predict calls."""

        def __init__(self, name, **options):
            """Record the requested model and options.

            Args:
                name: Model identifier requested by the app.
                **options: Keyword options forwarded by the app.
            """
            recorder.loads.append((name, options))

        def predict(self, pairs, **options):
            """Record the call and return deterministic scores.

            Args:
                pairs: Query/text pairs to score.
                **options: Prediction options such as batch size.

            Returns:
                A :class:`FakeScores` with one score per pair.

            Raises:
                RuntimeError: When the recorder is configured to simulate
                    CUDA out-of-memory failures.
            """
            recorder.calls.append((list(pairs), options))
            if recorder.oom:
                raise RuntimeError("CUDA out of memory")
            return FakeScores([float(index) for index, _pair in enumerate(pairs)])

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = cuda
    fake_fastapi = types.ModuleType("fastapi")
    fake_fastapi.FastAPI = FakeFastApi
    fake_fastapi.HTTPException = FakeHttpException
    fake_pydantic = types.ModuleType("pydantic")
    fake_pydantic.BaseModel = type("BaseModel", (), {})
    fake_pydantic.Field = lambda *args, **kwargs: kwargs.get("default_factory", lambda: kwargs.get("default"))()
    fake_sentence_transformers = types.ModuleType("sentence_transformers")
    fake_sentence_transformers.CrossEncoder = FakeCrossEncoder
    replacements = {
        "torch": fake_torch,
        "fastapi": fake_fastapi,
        "pydantic": fake_pydantic,
        "sentence_transformers": fake_sentence_transformers,
    }
    previous = {name: sys.modules.get(name) for name in replacements}
    env_names = [
        "RERANKER_MODEL",
        "RERANKER_MODEL_REVISION",
        "RERANKER_CODE_REVISION",
        "RERANKER_BATCH_SIZE",
        "RERANKER_MAX_TEXTS",
        "RERANKER_MAX_LENGTH",
    ]
    old_env = {name: os.environ.get(name) for name in env_names}
    try:
        sys.modules.update(replacements)
        os.environ.update({
            "RERANKER_MODEL": "test/multilingual-reranker",
            "RERANKER_MODEL_REVISION": "revision-1",
            "RERANKER_CODE_REVISION": "code-revision-1",
            "RERANKER_BATCH_SIZE": "2",
            "RERANKER_MAX_TEXTS": "3",
            "RERANKER_MAX_LENGTH": "256",
        })
        name = f"workspace_rag_reranker_{uuid.uuid4().hex}"
        spec = importlib.util.spec_from_file_location(name, APP_PATH)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module, recorder, cuda
    finally:
        sys.modules.pop(name, None)
        for key, value in previous.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def request(query, texts):
    """Build a request-like object for the rerank endpoint.

    Args:
        query: The query to score against.
        texts: Candidate texts.

    Returns:
        A namespace exposing ``query``, ``texts``, and ``truncate``.
    """
    return types.SimpleNamespace(query=query, texts=texts, truncate=True)


def main():
    """Run all reranker runtime assertions and print a success message."""
    module, recorder, _cuda = load_app()
    health = module.health()
    assert health["ok"] is True
    assert health["model"] == "test/multilingual-reranker"
    result = module.rerank(request("query", ["first", "second"]))
    assert result["scores"] == [0.0, 1.0]
    assert recorder.calls[0][0] == [("query", "first"), ("query", "second")]
    assert recorder.calls[0][1]["batch_size"] == 2
    assert recorder.loads[0][1]["max_length"] == 256
    assert recorder.loads[0][1]["revision"] == "revision-1"
    assert recorder.loads[0][1]["trust_remote_code"] is True
    assert recorder.loads[0][1]["config_args"]["code_revision"] == "code-revision-1"
    assert recorder.loads[0][1]["automodel_args"]["code_revision"] == "code-revision-1"
    try:
        module.rerank(request("query", ["1", "2", "3", "4"]))
    except FakeHttpException as error:
        assert error.status_code == 422
    else:
        raise AssertionError("candidate cap was not enforced")

    oom_module, _recorder, cuda = load_app(oom=True)
    try:
        oom_module.rerank(request("query", ["text"]))
    except FakeHttpException as error:
        assert error.status_code == 503
    else:
        raise AssertionError("OOM was not converted to a retryable response")
    assert cuda.empty_cache_calls == 1
    print("workspace-rag reranker app mock integration passes")


if __name__ == "__main__":
    main()
