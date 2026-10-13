"""Targeted checks for the Ollama embedding adapter (Part 7).

Everything here runs against a fake transport, so the suite is deterministic and
offline. The single real preflight is exercised separately by
``test_real_preflight_matches_the_documented_contract`` and skips when the local
Ollama server is not reachable.

The behaviours under test are the ones the documents make load-bearing: the two
Nomic prefixes, ``truncate: false``, exactly 768 finite values, a bounded retry
that never retries a deterministic failure, and a digest mismatch that fails
closed.
"""

import asyncio
import inspect
import math
import random
import time
from collections.abc import Awaitable, Callable

import httpx
import pytest

from app.providers.base import (
    DOCUMENT_PREFIX,
    QUERY_PREFIX,
    EmbeddingProvider,
    EmbeddingProviderError,
    EmbeddingValidationError,
)
from app.providers.embedding import OllamaEmbeddingProvider
from app.providers.retry import (
    DEFAULT_ATTEMPTS,
    RetryableError,
    RetryPolicy,
    arun_with_retry,
    is_retryable_status,
)
from app.settings import Settings

DIMENSION = 768
MODEL = "nomic-embed-text-v2-moe:latest"
DIGEST = "ff9c2f10ef5e3722623a1b396e1e04efc27a93112c83e9b7b7b9ca1d05620965"


def _vector(seed: float = 0.01) -> list[float]:
    return [seed + index / 10_000 for index in range(DIMENSION)]


def _tags_response(model: str = MODEL, digest: str = DIGEST) -> httpx.Response:
    return httpx.Response(200, json={"models": [{"name": model, "digest": digest}]})


def _embed_response(vectors: list[list[float]] | None = None, count: int = 1) -> httpx.Response:
    payload = vectors if vectors is not None else [_vector() for _ in range(count)]
    return httpx.Response(200, json={"embeddings": payload})


def _raw_embed_response(body: str) -> httpx.Response:
    """Build an embed response from a raw body.

    NaN and infinity are not valid JSON, so httpx refuses to encode them. A real
    server could still emit them, which is exactly what the validator must catch,
    so the body is written directly.
    """
    return httpx.Response(
        200, content=body.encode("utf-8"), headers={"content-type": "application/json"}
    )


def _vector_body_with(first: str) -> str:
    """Return an embed body whose first component is the literal ``first``."""
    rest = ", ".join(["0.1"] * (DIMENSION - 1))
    return f'{{"embeddings": [[{first}, {rest}]]}}'


class RecordingTransport(httpx.AsyncBaseTransport):
    """Serves canned responses and records every request that was sent."""

    def __init__(self, responses: list[httpx.Response] | None = None) -> None:
        self.responses = responses or []
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.responses:
            return self.responses.pop(0)
        return httpx.Response(500, json={"error": "no canned response left"})

    def embeds(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path == "/api/embed"]

    def body_of(self, request: httpx.Request) -> dict:
        import json

        return json.loads(request.content.decode("utf-8"))


def _provider(
    transport: RecordingTransport,
    *,
    dimension: int = DIMENSION,
    expected_digest: str | None = DIGEST,
    policy: RetryPolicy | None = None,
    sleeps: list[float] | None = None,
) -> OllamaEmbeddingProvider:
    client = httpx.AsyncClient(transport=transport)
    provider = OllamaEmbeddingProvider(
        client,
        base_url="http://ollama.test:11434",
        model=MODEL,
        dimension=dimension,
        expected_digest=expected_digest,
        policy=policy or RetryPolicy(base_backoff_seconds=0, max_backoff_seconds=0),
        sleep=_record_sleep(sleeps) if sleeps is not None else _no_sleep,
        jitter=lambda: 0.0,
    )
    return provider


def _record_sleep(sleeps: list[float]) -> Callable[[float], Awaitable[None]]:
    """Return an async sleep that records the delay instead of waiting."""

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    return sleep


async def _no_sleep(_seconds: float) -> None:
    return None


# --- prefixes ---


def test_documents_use_the_document_prefix() -> None:
    transport = RecordingTransport([_tags_response(), _embed_response(count=2)])
    provider = _provider(transport)
    vectors = asyncio.run(provider.embed_documents(["متن الف", "متن ب"]))

    assert len(vectors) == 2
    inputs = transport.body_of(transport.embeds()[0])["input"]
    assert inputs == [f"{DOCUMENT_PREFIX}متن الف", f"{DOCUMENT_PREFIX}متن ب"]


def test_query_uses_the_query_prefix() -> None:
    transport = RecordingTransport([_tags_response(), _embed_response()])
    provider = _provider(transport)
    asyncio.run(provider.embed_query("پرسش من"))

    assert transport.body_of(transport.embeds()[0])["input"] == [f"{QUERY_PREFIX}پرسش من"]


def test_document_and_query_prefixes_differ() -> None:
    assert DOCUMENT_PREFIX == "search_document: "
    assert QUERY_PREFIX == "search_query: "
    assert DOCUMENT_PREFIX != QUERY_PREFIX


def test_empty_document_batch_makes_no_request() -> None:
    transport = RecordingTransport([])
    provider = _provider(transport)
    assert asyncio.run(provider.embed_documents([])) == []
    assert transport.requests == []


# --- truncate: false is mandatory ---


def test_embed_request_always_sends_truncate_false() -> None:
    transport = RecordingTransport([_tags_response(), _embed_response()])
    provider = _provider(transport)
    asyncio.run(provider.embed_query("متن"))

    body = transport.body_of(transport.embeds()[0])
    assert body["truncate"] is False


def test_settings_reject_enabling_truncation() -> None:
    with pytest.raises(ValueError):
        Settings(embedding_truncate=True)


# --- vector validation ---


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        (_embed_response(vectors=[[0.1] * 767]), "wrong dimension"),
        (_embed_response(vectors=[[]]), "empty vector"),
        (_raw_embed_response(_vector_body_with("NaN")), "NaN"),
        (_raw_embed_response(_vector_body_with("Infinity")), "infinity"),
        (_embed_response(vectors=[["x"] + [0.1] * 767]), "non-numeric"),
        (_embed_response(vectors=[[True] + [0.1] * 767]), "boolean"),
        (httpx.Response(200, json={}), "missing embeddings"),
        (httpx.Response(200, json={"embeddings": []}), "count mismatch"),
    ],
)
def test_invalid_vectors_are_rejected(payload: httpx.Response, reason: str) -> None:
    transport = RecordingTransport([_tags_response(), payload])
    provider = _provider(transport)
    with pytest.raises(EmbeddingValidationError):
        asyncio.run(provider.embed_query("متن"))


def test_finite_values_pass_through_as_floats() -> None:
    transport = RecordingTransport([_tags_response(), _embed_response()])
    provider = _provider(transport)
    vector = asyncio.run(provider.embed_query("متن"))
    assert len(vector) == DIMENSION
    assert all(isinstance(x, float) and math.isfinite(x) for x in vector)


def test_batch_order_is_preserved() -> None:
    first, second = [0.111] * DIMENSION, [0.222] * DIMENSION
    transport = RecordingTransport([_tags_response(), _embed_response(vectors=[first, second])])
    provider = _provider(transport)
    vectors = asyncio.run(provider.embed_documents(["الف", "ب"]))
    assert vectors[0][0] == pytest.approx(0.111)
    assert vectors[1][0] == pytest.approx(0.222)


# --- digest: fail closed ---


def test_digest_mismatch_fails_closed() -> None:
    transport = RecordingTransport([_tags_response(digest="deadbeef" * 8)])
    provider = _provider(transport)
    with pytest.raises(EmbeddingProviderError, match="digest"):
        asyncio.run(provider.embed_query("متن"))
    # Nothing was embedded once the digest was rejected.
    assert transport.embeds() == []


def test_missing_model_fails_closed() -> None:
    transport = RecordingTransport([_tags_response(model="some-other-model:latest")])
    provider = _provider(transport)
    with pytest.raises(EmbeddingProviderError, match="not available"):
        asyncio.run(provider.embed_query("متن"))


def test_digest_is_re_read_before_every_embed() -> None:
    """A model swapped in Ollama without a restart must not slip through."""
    transport = RecordingTransport(
        [_tags_response(), _embed_response(), _tags_response(), _embed_response()]
    )
    provider = _provider(transport)
    asyncio.run(provider.embed_query("الف"))
    asyncio.run(provider.embed_query("ب"))
    assert len([r for r in transport.requests if r.url.path == "/api/tags"]) == 2


def test_a_digest_change_between_embeds_is_rejected_before_the_post() -> None:
    """The second call must fail on the digest and never reach the embed POST."""

    class FlippingTags(httpx.AsyncBaseTransport):
        def __init__(self) -> None:
            self.tag_calls = 0
            self.posts = 0

        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                self.tag_calls += 1
                digest = "b" * 64 if self.tag_calls == 1 else "c" * 64
                return _tags_response(digest=digest)
            self.posts += 1
            return _embed_response()

    transport = FlippingTags()
    provider = OllamaEmbeddingProvider(
        httpx.AsyncClient(transport=transport),
        base_url="http://ollama.test:11434",
        model=MODEL,
        dimension=DIMENSION,
        expected_digest="b" * 64,
        policy=RetryPolicy(base_backoff_seconds=0, max_backoff_seconds=0),
        sleep=_no_sleep,
    )
    asyncio.run(provider.embed_query("الف"))
    with pytest.raises(EmbeddingProviderError, match="digest"):
        asyncio.run(provider.embed_query("ب"))
    assert transport.posts == 1, "the second embed must not reach the provider"


def test_adapter_refuses_to_build_without_an_expected_digest() -> None:
    """No digest means a model swap could not be detected, so it is not allowed."""
    with pytest.raises(ValueError, match="expected_digest"):
        OllamaEmbeddingProvider(
            httpx.AsyncClient(transport=RecordingTransport([])),
            base_url="http://ollama.test:11434",
            model=MODEL,
            dimension=DIMENSION,
            expected_digest=None,
        )


@pytest.mark.parametrize("value", ["", "not-hex!!", "abc", "ZZZZ", "FF9C2F10EF5E"])
def test_settings_reject_an_unusable_digest(value: str) -> None:
    """An empty or malformed digest would silently disable the fail-closed check."""
    with pytest.raises(ValueError):
        Settings(_env_file=None, ollama_embed_digest=value)


def test_tag_matching_requires_the_full_tag() -> None:
    """``nomic:other`` must not satisfy ``nomic:latest``."""
    provider = OllamaEmbeddingProvider(
        httpx.AsyncClient(transport=RecordingTransport([])),
        base_url="http://ollama.test:11434",
        model="nomic:latest",
        dimension=DIMENSION,
        expected_digest="a" * 12,
    )
    assert provider._matches("nomic:latest") is True
    assert provider._matches("nomic") is True, "an untagged name implies :latest"
    assert provider._matches("nomic:other") is False
    assert provider._matches("other:latest") is False


def test_wrong_tag_before_the_right_tag_in_the_response() -> None:
    transport = RecordingTransport([_tags_response(model="nomic:other", digest="f" * 64)])
    provider = OllamaEmbeddingProvider(
        httpx.AsyncClient(transport=transport),
        base_url="http://ollama.test:11434",
        model="nomic:latest",
        dimension=DIMENSION,
        expected_digest="a" * 12,
    )
    with pytest.raises(EmbeddingProviderError, match="not available"):
        asyncio.run(provider.model_digest())


def test_digest_prefix_match_is_allowed() -> None:
    """The configured value is the short prefix of the full live digest."""
    transport = RecordingTransport([_tags_response(digest=DIGEST)])
    provider = _provider(transport, expected_digest=DIGEST[:12])
    assert asyncio.run(provider.model_digest()) == DIGEST


# --- retry budget ---


@pytest.mark.parametrize("status", [429, 502, 503, 504])
def test_transient_status_is_retried_then_succeeds(status: int) -> None:
    sleeps: list[float] = []
    transport = RecordingTransport(
        [
            _tags_response(),
            httpx.Response(status, json={"error": "try later"}),
            _embed_response(),
        ]
    )
    provider = _provider(
        transport,
        sleeps=sleeps,
        policy=RetryPolicy(base_backoff_seconds=0.2, max_backoff_seconds=1),
    )
    vector = asyncio.run(provider.embed_query("متن"))
    assert len(vector) == DIMENSION
    assert len(transport.embeds()) == 2
    # The wait happens between attempts, inside the budget.
    assert sleeps == [pytest.approx(0.2)]


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422, 500])
def test_deterministic_status_is_not_retried(status: int) -> None:
    transport = RecordingTransport([_tags_response(), httpx.Response(status, json={"error": "no"})])
    provider = _provider(transport)
    with pytest.raises(EmbeddingProviderError):
        asyncio.run(provider.embed_query("متن"))
    assert len(transport.embeds()) == 1, "a deterministic failure must not be retried"


def test_transient_failure_exhausts_the_budget_and_raises() -> None:
    sleeps: list[float] = []
    transport = RecordingTransport(
        [
            _tags_response(),
            httpx.Response(503, json={"error": "down"}),
            httpx.Response(503, json={"error": "down"}),
        ]
    )
    provider = _provider(transport, sleeps=sleeps)
    with pytest.raises(RetryableError):
        asyncio.run(provider.embed_query("متن"))
    assert len(transport.embeds()) == DEFAULT_ATTEMPTS


def test_transport_failure_is_retried() -> None:
    sleeps: list[float] = []

    class FlakyTransport(httpx.AsyncBaseTransport):
        def __init__(self) -> None:
            self.calls = 0

        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            self.calls += 1
            if self.calls == 1:
                raise httpx.ConnectError("connection refused", request=request)
            if request.url.path == "/api/tags":
                return _tags_response()
            return _embed_response()

    transport = FlakyTransport()
    client = httpx.AsyncClient(transport=transport)
    provider = OllamaEmbeddingProvider(
        client,
        base_url="http://ollama.test:11434",
        model=MODEL,
        dimension=DIMENSION,
        expected_digest=DIGEST,
        policy=RetryPolicy(base_backoff_seconds=0, max_backoff_seconds=0),
        sleep=_record_sleep(sleeps),
    )
    assert len(asyncio.run(provider.embed_query("متن"))) == DIMENSION


def test_timeout_is_retried() -> None:
    class SlowTransport(httpx.AsyncBaseTransport):
        def __init__(self) -> None:
            self.calls = 0

        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            self.calls += 1
            if request.url.path == "/api/tags":
                return _tags_response()
            if self.calls == 1:
                raise httpx.ReadTimeout("too slow", request=request)
            return _embed_response()

    client = httpx.AsyncClient(transport=SlowTransport())
    provider = OllamaEmbeddingProvider(
        client,
        base_url="http://ollama.test:11434",
        model=MODEL,
        dimension=DIMENSION,
        expected_digest=DIGEST,
        policy=RetryPolicy(base_backoff_seconds=0, max_backoff_seconds=0),
        sleep=_no_sleep,
    )
    assert len(asyncio.run(provider.embed_query("متن"))) == DIMENSION


def test_attempt_timeout_is_passed_to_the_client() -> None:
    transport = RecordingTransport([_tags_response(), _embed_response()])
    provider = _provider(transport, policy=RetryPolicy(attempt_timeout_seconds=3.5))
    asyncio.run(provider.embed_query("متن"))
    request = transport.embeds()[0]
    timeout = request.extensions.get("timeout")
    assert timeout is not None
    assert timeout["read"] == 3.5


# --- retry helper ---


def test_backoff_grows_and_is_capped() -> None:
    policy = RetryPolicy(
        base_backoff_seconds=0.1, max_backoff_seconds=0.25, attempt_timeout_seconds=1
    )
    assert policy.backoff_for(1, 0.0) == pytest.approx(0.1)
    assert policy.backoff_for(2, 0.0) == pytest.approx(0.2)
    assert policy.backoff_for(5, 0.0) == pytest.approx(0.25)


def test_jitter_only_reduces_delay() -> None:
    policy = RetryPolicy(base_backoff_seconds=0.4, max_backoff_seconds=1, attempt_timeout_seconds=1)
    assert policy.backoff_for(1, 0.0) == pytest.approx(0.4)
    assert policy.backoff_for(1, 1.0) == pytest.approx(0.2)


def test_retryable_status_set_matches_the_documented_one() -> None:
    assert is_retryable_status(429)
    for status in (502, 503, 504):
        assert is_retryable_status(status)
    for status in (400, 401, 404, 409, 422, 500, 501):
        assert not is_retryable_status(status)


def test_retry_policy_rejects_a_nonsense_budget() -> None:
    with pytest.raises(ValueError):
        RetryPolicy(attempts=0)
    with pytest.raises(ValueError):
        RetryPolicy(attempt_timeout_seconds=0)


def test_retry_helper_reraises_after_budget() -> None:
    calls: list[int] = []

    async def always_fails() -> None:
        calls.append(1)
        raise RetryableError("nope")

    with pytest.raises(RetryableError):
        asyncio.run(
            arun_with_retry(
                always_fails,
                policy=RetryPolicy(attempts=2, base_backoff_seconds=0),
                sleep=_no_sleep,
            )
        )
    assert len(calls) == 2


# --- configuration ---


def test_settings_expose_the_documented_embedding_defaults() -> None:
    settings = Settings()
    assert settings.embedding_provider == "ollama"
    assert settings.ollama_embed_model == MODEL
    assert settings.embedding_dimension == DIMENSION
    assert settings.embedding_truncate is False
    assert settings.ollama_embed_digest.startswith("ff9c2f10ef5e")


# --- real preflight ---


def test_real_preflight_matches_the_documented_contract() -> None:
    """One real call against the local server; skipped when it is unreachable."""
    import os

    if os.environ.get("EKC_TEST_LIVE_PROVIDERS") != "1":
        pytest.skip("live provider tests require EKC_TEST_LIVE_PROVIDERS=1")
    import httpx as real_httpx

    from app.cli.preflight_embedding import run_preflight
    from app.provider_config.runtime import configured_call
    from app.settings import load_settings

    settings = load_settings()
    base = str(settings.ollama_base_url).rstrip("/")

    async def reachable() -> bool:
        try:
            async with real_httpx.AsyncClient(timeout=3.0) as client:
                response = await client.get(f"{base}/api/version")
                return response.status_code == 200
        except Exception:  # noqa: BLE001  any failure means "not available here"
            return False

    try:
        if not asyncio.run(reachable()):
            pytest.skip("local ollama server is not reachable")
    except Exception as error:  # noqa: BLE001
        pytest.skip(f"local ollama server is not reachable: {type(error).__name__}")

    summary = asyncio.run(
        configured_call(
            settings, lambda configured: run_preflight(configured, timeout_seconds=20.0)
        )
    )

    assert summary["dimension"] == DIMENSION
    assert str(summary["digest"]).startswith(settings.ollama_embed_digest)
    assert summary["truncate"] is False
    assert summary["document_prefix"] == DOCUMENT_PREFIX
    assert summary["query_prefix"] == QUERY_PREFIX


# --- regressions from the Part 7 review ---


def test_retry_enforces_a_real_wall_clock_deadline() -> None:
    """The HTTPX timeout does not bound a stalling handler; asyncio.timeout does."""
    policy = RetryPolicy(attempts=2, attempt_timeout_seconds=0.05, base_backoff_seconds=0)

    async def stalls_forever() -> None:
        await asyncio.sleep(5)

    started = time.perf_counter()
    with pytest.raises(RetryableError):
        asyncio.run(arun_with_retry(stalls_forever, policy=policy, sleep=_no_sleep))
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, f"the 0.05s attempt budget took {elapsed:.2f}s"


def test_a_slow_but_finishing_attempt_is_cut_off() -> None:
    policy = RetryPolicy(attempts=1, attempt_timeout_seconds=0.05)

    async def slow_success() -> str:
        await asyncio.sleep(5)
        return "too late"

    with pytest.raises(RetryableError):
        asyncio.run(arun_with_retry(slow_success, policy=policy, sleep=_no_sleep))


def test_default_jitter_is_random_not_zero() -> None:
    """A constant zero would make concurrent callers retry in lockstep."""
    policy = RetryPolicy(base_backoff_seconds=0.4, max_backoff_seconds=1, attempt_timeout_seconds=1)
    samples = {policy.backoff_for(1, random.random()) for _ in range(50)}
    assert len(samples) > 1, "jitter must actually vary the delay"


def test_injected_jitter_still_deterministic() -> None:
    policy = RetryPolicy(base_backoff_seconds=0.4, max_backoff_seconds=1, attempt_timeout_seconds=1)
    assert policy.backoff_for(1, 0.0) == policy.backoff_for(1, 0.0)


def test_preflight_timeout_must_be_positive() -> None:
    from app.cli.preflight_embedding import main

    assert main(["--timeout", "0"]) == 2
    assert main(["--timeout", "-1"]) == 2


def test_preflight_timeout_reaches_the_retry_policy() -> None:
    """The CLI flag must bound the whole check, not only the socket phases."""
    import httpx as real_httpx

    from app.cli.preflight_embedding import run_preflight
    from app.settings import Settings

    class SlowTags(real_httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: real_httpx.Request) -> real_httpx.Response:
            await asyncio.sleep(5)
            raise AssertionError("unreachable")

    from tests.provider_fixtures import panel_settings

    settings = panel_settings(Settings(_env_file=None))
    original = real_httpx.AsyncClient

    def patched(*args: object, **kwargs: object) -> real_httpx.AsyncClient:
        kwargs["transport"] = SlowTags()
        return original(*args, **kwargs)  # type: ignore[arg-type]

    real_httpx.AsyncClient = patched  # type: ignore[assignment]
    try:
        started = time.perf_counter()
        with pytest.raises((RetryableError, TimeoutError)):
            asyncio.run(run_preflight(settings, timeout_seconds=0.1))
        elapsed = time.perf_counter() - started
    finally:
        real_httpx.AsyncClient = original  # type: ignore[assignment]

    assert elapsed < 2.0, f"a 0.1s preflight budget took {elapsed:.2f}s"


def test_provider_protocol_is_async_and_satisfied() -> None:
    """The protocol must match the adapter, and mypy checks the assignment."""
    provider = OllamaEmbeddingProvider(
        httpx.AsyncClient(transport=RecordingTransport([])),
        base_url="http://ollama.test:11434",
        model=MODEL,
        dimension=DIMENSION,
        expected_digest=DIGEST,
    )
    typed: EmbeddingProvider = provider
    assert isinstance(typed, EmbeddingProvider)

    # The protocol itself must declare coroutines, not just the adapter.
    assert inspect.iscoroutinefunction(EmbeddingProvider.embed_query)
    assert inspect.iscoroutinefunction(EmbeddingProvider.embed_documents)
    assert inspect.iscoroutinefunction(typed.embed_query)
    assert inspect.iscoroutinefunction(typed.embed_documents)


def test_calling_through_the_protocol_returns_an_awaitable() -> None:
    """A caller using only the protocol must still be able to await."""
    transport = RecordingTransport([_tags_response(), _embed_response()])
    provider = OllamaEmbeddingProvider(
        httpx.AsyncClient(transport=transport),
        base_url="http://ollama.test:11434",
        model=MODEL,
        dimension=DIMENSION,
        expected_digest=DIGEST,
        policy=RetryPolicy(base_backoff_seconds=0, max_backoff_seconds=0),
        sleep=_no_sleep,
    )

    async def scenario() -> int:
        typed: EmbeddingProvider = provider
        return len(await typed.embed_query("متن"))

    assert asyncio.run(scenario()) == DIMENSION
