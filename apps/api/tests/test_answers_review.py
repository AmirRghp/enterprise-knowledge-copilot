"""Tests for the four code findings of the Part 15 review.

**P1, the unbounded body.** ``AnswerRequest`` caps ``question`` at 2,000 characters, but that
is enforced *after* FastAPI parses the body, and pydantic ignores unknown fields - so a valid
question beside a large extra field was accepted, and a sender with no session could make the
server allocate before any dependency refused it. Asserted at the boundary: the refusal has to
be 413, and it has to arrive without the route ever running, which is what proves the guard
is in the ASGI layer rather than in a dependency.

**P1, the question reaching a traceback.** The embedding adapter keeps up to 200 characters of
Ollama's error message because that service may echo its input back. A sentinel planted in
that message must appear in neither the response nor the log - and the test checks the log,
because that is where the review said it would land.

**P2, the leaked connection pool.** ``build_provider`` opened a client nobody could close, once
per question. Asserted as closure on *both* the success and failure paths, because the defect
was precisely that no path closed it.

**P2, the ignored setting.** ``RERANK_ENABLED`` had no effect on the only path a user takes.
Both directions are pinned: zero provider work when off, and a visible failure - not a silent
unreranked answer - when on and broken.
"""

import asyncio
import json
import logging
from typing import Any

import httpx
import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.api import answers as answers_api
from app.auth import service as auth_service
from app.db import models as db_models
from app.db.engine import create_engine, create_session_factory
from app.main import create_app
from app.providers.base import EmbeddingProviderError, ScoredCandidate
from app.providers.generation import GenerationResponseError
from app.providers.retry import RetryableError
from app.settings import Settings
from tests.provider_fixtures import seed_panel
from tests.test_manager_api import TEST_PASSWORDS, VALID_ORIGIN, _login_as
from tests.test_retrieval import (
    EMPLOYEE_DOCUMENT,
    EMPLOYEE_TEXT,
    MANAGER_DOCUMENT,
    MANAGER_TEXT,
    FakeProvider,
    _publish,
)

GOOD_QUOTE = "درخواست باید ظرف ۱۵ روز ثبت شود"
CLAIM_TEXT = "درخواست بازپرداخت سفر باید ظرف ۱۵ روز ثبت شود."
QUESTION = "مهلت ثبت درخواست بازپرداخت هزینه سفر چند روز است؟"

#: Planted in a provider error to prove it does not travel to the caller or the log.
SENTINEL = "SENTINEL-9f3a-question-text-should-never-travel"

#: Planted in a *rerank* upstream body. Separate from ``SENTINEL`` because a leak from the
#: rerank adapter is a different defect from a leak from the embedding one, and one sentinel
#: shared by both would let a test pass on the other's fix.
RERANK_SENTINEL = "SENTINEL-7c1e-rerank-upstream-echo-should-never-travel"


def _settings(**overrides: Any) -> Settings:
    defaults: dict[str, Any] = {
        "db_name": "enterprise_knowledge_copilot_test",
        "seed_employee_password": TEST_PASSWORDS["employee"],
        "seed_manager_password": TEST_PASSWORDS["manager"],
        "openrouter_api_key": "test-key-not-a-real-secret",
        "answer_rate_limit": 1000,
    }
    return Settings(**{**defaults, **overrides})


@pytest.fixture(autouse=True)
def pinned_test_database() -> None:
    assert _settings().db_name == "enterprise_knowledge_copilot_test"


def _payload(**overrides: Any) -> str:
    body: dict[str, Any] = {
        "claims": [{"evidence_id": "E1", "quote": GOOD_QUOTE, "text": CLAIM_TEXT}],
        "abstained": False,
        "missing_parts": [],
        "answer": "نثر آزاد مدل.",
    }
    body.update(overrides)
    return json.dumps(body, ensure_ascii=False)


def _completion(content: str) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "gen-test",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": content},
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            },
        )

    return httpx.MockTransport(handler)


class _HttpxShim:
    """``httpx`` with ``AsyncClient`` pointed at a canned transport, and nothing else moved.

    A proxy rather than a patch on the module, for the reason ``test_generation_report.py``
    uses one: patching the real module replaces the client this file's own ASGI client is
    built from.
    """

    def __init__(self, real: Any, holder: dict[str, Any], on_close: list[str] | None = None):
        self._real = real
        self._holder = holder
        self._on_close = on_close

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    def AsyncClient(self, **kwargs: Any) -> Any:  # noqa: N802 - mirrors the real name
        kwargs["transport"] = self._holder["transport"]
        client = self._real.AsyncClient(**kwargs)
        if self._on_close is None:
            return client
        closed: list[str] = self._on_close
        inner = client.aclose

        async def tracking_close() -> None:
            closed.append("closed")
            await inner()

        client.aclose = tracking_close  # type: ignore[method-assign]
        return client


@pytest.fixture(autouse=True)
def canned_provider(monkeypatch: Any) -> Any:
    from app.cli import run_worker

    holder: dict[str, Any] = {"transport": _completion(_payload())}
    monkeypatch.setattr(answers_api, "httpx", _HttpxShim(httpx, holder))
    monkeypatch.setattr(
        "app.provider_config.transport.provider_client",
        lambda **kwargs: answers_api.httpx.AsyncClient(**kwargs),
    )
    monkeypatch.setattr(
        run_worker,
        "build_provider",
        lambda settings, *, attempt_timeout, client=None: FakeProvider(),
    )
    # Returns the real adapter unless a test asks for the counting stub instead. The rerank
    # error paths can only be proved with the real adapter - its message-building is the
    # thing under test - so stubbing it here by default would make those two tests assert
    # nothing at all while appearing to cover them.
    monkeypatch.setattr(answers_api, "_rerank_builder", _rerank_builder)
    return holder


#: Replaced with ``_RerankStub`` by the scenarios that count construction and calls.
_real_rerank_builder = answers_api.build_rerank_provider


def _rerank_builder(settings: Any, client: Any) -> Any:
    """The real adapter, or whatever a test installed, built with these arguments.

    ``override`` is a factory rather than a provider so a test can build *with* the route's
    client - which is how the rerank adapter is pointed at a refusing transport.
    """
    if _rerank_builder.override is not None:  # type: ignore[attr-defined]
        return _rerank_builder.override(settings, client)  # type: ignore[attr-defined]
    return _real_rerank_builder(settings, client=client)


_rerank_builder.override = None  # type: ignore[attr-defined]


class _RerankStub:
    """Records whether a rerank provider was built and asked anything.

    Implements the real protocol method rather than an invented one: an earlier version of
    this file defined ``rerank_hits``, which no caller calls, so the test that asked "was the
    provider used" would have passed while the code never touched it.
    """

    built = 0
    called = 0
    last_usage = None

    def __init__(self, settings: Any = None, client: Any = None) -> None:
        type(self).built += 1

    @property
    def provider_name(self) -> str:
        return "stub"

    @property
    def model(self) -> str:
        return "stub-v1"

    async def rerank(
        self,
        query: str,
        candidates: list[Any],
        *,
        top_n: int,
        refresh: Any = None,
    ) -> list[Any]:
        type(self).called += 1
        current = await refresh() if refresh is not None else candidates
        return [ScoredCandidate(chunk_id=item.chunk_id, score=1.0) for item in current][:top_n]


async def _reset(engine: AsyncEngine) -> None:
    async with engine.begin() as connection:
        await connection.execute(delete(db_models.Chunk))
        await connection.execute(delete(db_models.Section))
        await connection.execute(delete(db_models.IngestionJob))
        await connection.execute(delete(db_models.Document))
        await connection.execute(delete(db_models.Session))
        await connection.execute(delete(db_models.User))


async def _seed(factory: async_sessionmaker) -> None:
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    async with factory() as session:
        for login, password, role in (
            ("employee", TEST_PASSWORDS["employee"], "employee"),
            ("manager", TEST_PASSWORDS["manager"], "manager"),
        ):
            session.add(
                db_models.User(
                    login=login,
                    password_hash=auth_service.hash_password(password),
                    role=role,
                    is_active=True,
                    created_at=now,
                    updated_at=now,
                )
            )
        await session.commit()


async def _documents(factory: async_sessionmaker) -> None:
    await _publish(
        factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
    )
    await _publish(factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager")


def _client(engine: AsyncEngine, settings: Settings) -> httpx.AsyncClient:
    from app.api.answer_rate_limit import AnswerRateLimiter

    app = create_app()
    app.state.db_engine = engine
    app.state.db_session_factory = create_session_factory(engine)
    app.state.settings = settings
    app.state.answer_rate_limiter = AnswerRateLimiter(
        settings.answer_rate_limit,
        settings.answer_rate_window_seconds,
        settings.answer_rate_max_keys,
    )
    # The route reads its settings through ``Depends(get_settings)``; this is the seam that
    # lets a test's overrides reach it.
    app.dependency_overrides[answers_api.get_settings] = lambda: settings
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def _scenario(body: Any, **overrides: Any) -> Any:
    async def main() -> Any:
        settings = _settings(**overrides)
        engine = create_engine(settings)
        try:
            await _reset(engine)
            await seed_panel(engine, settings)
            factory = create_session_factory(engine)
            await _seed(factory)
            async with _client(engine, settings) as client:
                return await body(engine, factory, client)
        finally:
            await engine.dispose()

    return asyncio.run(main())


async def _ask(client: httpx.AsyncClient, **payload: Any) -> httpx.Response:
    token = await _login_as(client, "employee")
    body: dict[str, Any] = {"question": QUESTION}
    body.update(payload)
    return await client.post(
        answers_api.ANSWERS_PATH,
        json=body,
        cookies={"ekc_session": token},
        headers={"Origin": VALID_ORIGIN},
    )


# --------------------------------------------------------------------------
# P1: the body ceiling
# --------------------------------------------------------------------------


def test_an_oversized_body_is_refused_before_the_route_runs() -> None:
    """Review P1. The 2,000-character field limit arrives too late to bound the body."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        # A valid question beside a field pydantic would ignore, large enough that
        # buffering it is the whole cost being avoided.
        response = await _ask(client, padding="ا" * 200_000)

        assert response.status_code == 413
        assert "padding" not in response.text

    _scenario(body)


def test_a_chunked_oversized_body_is_refused_too() -> None:
    """No ``Content-Length`` to trust, so the guard has to count the stream itself."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        token = await _login_as(client, "employee")
        app = client._transport.app  # type: ignore[attr-defined]
        payload = json.dumps({"question": QUESTION, "padding": "ا" * 200_000}).encode()
        chunks: list[dict[str, Any]] = [
            {
                "type": "http.request",
                "body": payload[start : start + 4096],
                "more_body": True,
            }
            for start in range(0, len(payload), 4096)
        ]
        chunks.append({"type": "http.request", "body": b"", "more_body": False})

        status = await _send_chunked(app, chunks, token)

        assert status == 413

    _scenario(body)


async def _send_chunked(app: Any, chunks: list[dict[str, Any]], token: str) -> int:
    """Drive the ASGI app with no ``content-length`` header at all."""
    status: dict[str, int] = {}
    pending = list(chunks)

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            status["code"] = message["status"]

    async def receive() -> dict[str, Any]:
        return pending.pop(0)

    await app(
        {
            "type": "http",
            "method": "POST",
            "path": answers_api.ANSWERS_PATH,
            "raw_path": answers_api.ANSWERS_PATH.encode(),
            "query_string": b"",
            "headers": [
                (b"host", b"test"),
                (b"origin", VALID_ORIGIN.encode()),
                (b"content-type", b"application/json"),
                (b"cookie", f"ekc_session={token}".encode()),
            ],
        },
        receive,
        send,
    )
    return status["code"]


def test_a_body_under_the_json_ceiling_is_served() -> None:
    """The guard must not refuse a legitimate answer."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)

        response = await _ask(client)

        assert response.status_code == 200, response.text

    _scenario(body)


def test_the_document_routes_are_not_given_a_body_ceiling() -> None:
    """A GET carries no body, so the guard must leave it alone."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        token = await _login_as(client, "employee")

        response = await client.get("/api/documents", cookies={"ekc_session": token})

        assert response.status_code == 200

    _scenario(body)


def test_an_oversized_body_is_refused_before_authentication() -> None:
    """No session, no Origin - the ceiling still applies, because it runs in the ASGI layer."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        response = await client.post(
            answers_api.ANSWERS_PATH,
            json={"question": QUESTION, "padding": "ا" * 200_000},
            headers={"Origin": VALID_ORIGIN},
        )

        assert response.status_code == 413

    _scenario(body)


# --------------------------------------------------------------------------
# P1: the question reaching a traceback
# --------------------------------------------------------------------------


def _patched_build(replacement: Any) -> Any:
    from app.cli import run_worker

    original = run_worker.build_provider
    run_worker.build_provider = replacement  # type: ignore[assignment]
    return run_worker, original


@pytest.mark.parametrize("error_type", [EmbeddingProviderError, RetryableError])
def test_an_embedding_failure_is_a_generic_502_and_carries_no_question(
    caplog: Any,
    error_type: type[Exception],
) -> None:
    """Review P1. Ollama may echo its input back; nothing of it may travel out."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)

        def exploding(settings: Any, *, attempt_timeout: float, client: Any = None) -> Any:
            provider = FakeProvider()

            async def embed_query(text: str) -> Any:
                raise error_type(f"embedding provider returned 400: {SENTINEL}")

            provider.embed_query = embed_query  # type: ignore[method-assign]
            return provider

        worker, original = _patched_build(exploding)
        try:
            with caplog.at_level(logging.WARNING):
                response = await _ask(client)
        finally:
            worker.build_provider = original  # type: ignore[assignment]

        assert response.status_code == 502
        assert response.json() == {"detail": answers_api.UPSTREAM_UNAVAILABLE}
        assert SENTINEL not in response.text
        assert SENTINEL not in caplog.text
        assert QUESTION not in caplog.text
        # The type is recorded; the message is not.
        refusals = [record for record in caplog.records if record.msg == "answer refused"]
        assert refusals
        assert refusals[0].reason == f"retrieval:{error_type.__name__}"

    _scenario(body)


def test_a_genuine_bug_is_not_flattened_into_a_generic_502() -> None:
    """The catch is narrow on purpose; a blanket one would hide real defects."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)

        def exploding(settings: Any, *, attempt_timeout: float, client: Any = None) -> Any:
            provider = FakeProvider()

            async def embed_query(text: str) -> Any:
                raise ZeroDivisionError("a real bug, not a provider failure")

            provider.embed_query = embed_query  # type: ignore[method-assign]
            return provider

        worker, original = _patched_build(exploding)
        try:
            with pytest.raises(ZeroDivisionError):
                await _ask(client)
        finally:
            worker.build_provider = original  # type: ignore[assignment]

    _scenario(body)


# --------------------------------------------------------------------------
# P2: the leaked pool and the ignored setting
# --------------------------------------------------------------------------


def test_the_embedding_provider_borrows_the_client_the_route_closes() -> None:
    """Review P2. A pool the route has no reference to is a pool nobody closes."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        borrowed: list[Any] = []

        def recording(settings: Any, *, attempt_timeout: float, client: Any = None) -> Any:
            borrowed.append(client)
            return FakeProvider()

        worker, original = _patched_build(recording)
        try:
            response = await _ask(client)
        finally:
            worker.build_provider = original  # type: ignore[assignment]

        assert response.status_code == 200, response.text
        assert len(borrowed) == 1
        assert borrowed[0] is not None, "the provider opened its own client again"

    _scenario(body)


def test_the_httpx_clients_are_closed_on_success() -> None:
    """One client now serves embedding and generation; one close disposes both."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        closed: list[str] = []
        answers_api.httpx = _HttpxShim(  # type: ignore[assignment]
            httpx, {"transport": _completion(_payload())}, on_close=closed
        )

        response = await _ask(client)

        assert response.status_code == 200, response.text
        assert len(closed) == 1

    _scenario(body)


def test_the_client_is_closed_when_the_call_fails() -> None:
    """The failure path is the one that leaked before, so it is the one that must be pinned."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        closed: list[str] = []
        answers_api.httpx = _HttpxShim(  # type: ignore[assignment]
            httpx, {"transport": _completion(_payload())}, on_close=closed
        )

        def failing(settings: Any, *, client: Any) -> Any:
            raise GenerationResponseError("the provider returned nothing usable")

        from app.providers import generation as generation_module

        original = generation_module.build_generation_provider
        answers_api.build_generation_provider = failing  # type: ignore[assignment]
        try:
            response = await _ask(client)
        finally:
            answers_api.build_generation_provider = original  # type: ignore[assignment]

        assert response.status_code == 502
        assert len(closed) == 1

    _scenario(body)


def test_a_disabled_rerank_performs_zero_provider_work() -> None:
    """Review P2. Part 12's rule: no client, no adapter, no request."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        _RerankStub.built = 0
        _RerankStub.called = 0
        _rerank_builder.override = _RerankStub  # type: ignore[attr-defined]
        try:
            response = await _ask(client)
        finally:
            _rerank_builder.override = None  # type: ignore[attr-defined]

        assert response.status_code == 200, response.text
        assert _RerankStub.built == 0
        assert _RerankStub.called == 0

    _scenario(body, rerank_enabled=False)


def test_an_enabled_rerank_is_built_and_used() -> None:
    """Review P2. The setting now has an effect on the path a user actually takes."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        _RerankStub.built = 0
        _RerankStub.called = 0
        _rerank_builder.override = _RerankStub  # type: ignore[attr-defined]
        try:
            response = await _ask(client)
        finally:
            _rerank_builder.override = None  # type: ignore[attr-defined]

        assert response.status_code == 200, response.text
        assert _RerankStub.built == 1
        assert _RerankStub.called == 1

    _scenario(body, rerank_enabled=True)


def test_a_rerank_provider_failure_is_a_generic_502_and_carries_no_upstream_text(
    caplog: Any,
) -> None:
    """Review P1. A non-retryable upstream body reaches the adapter's message.

    The real adapter, not a stub: ``_safe_detail`` keeps up to 200 characters of the
    provider's error body because that text explains the failure, and a gateway that echoes
    the request puts authorized document text in there. The route must convert that to the
    fixed 502 and keep both the message and the body out of the response and the log.

    ``422`` is chosen because it is non-retryable - a retryable status is converted by
    ``arun_with_retry`` into a message naming only the attempt count, so a ``429`` here would
    pass without the handler doing anything.
    """

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        closed: list[str] = []
        real_client = httpx.AsyncClient
        generation = _completion(_payload())

        def split(**kwargs: Any) -> Any:
            # Both providers share this shim, so the generation client gets the canned
            # transport and only the rerank adapter is given a refusing one below.
            kwargs["transport"] = generation
            built = real_client(**kwargs)
            inner = built.aclose

            async def tracking() -> None:
                closed.append("closed")
                await inner()

            built.aclose = tracking  # type: ignore[method-assign]
            return built

        answers_api.httpx = type(
            "S",
            (),
            {
                "__getattr__": lambda self, n: getattr(httpx, n),
                "AsyncClient": staticmethod(split),
            },
        )

        def refusing_builder(settings: Any, rerank_client: Any) -> Any:
            def refusing(request: httpx.Request) -> httpx.Response:
                return httpx.Response(422, json={"error": f"bad input: {RERANK_SENTINEL}"})

            rerank_client._transport = httpx.MockTransport(refusing)
            return _real_rerank_builder(settings, client=rerank_client)

        _rerank_builder.override = refusing_builder  # type: ignore[attr-defined]
        try:
            with caplog.at_level(logging.WARNING):
                response = await _ask(client)
        finally:
            _rerank_builder.override = None  # type: ignore[attr-defined]

        assert response.status_code == 502
        assert response.json() == {"detail": answers_api.UPSTREAM_UNAVAILABLE}
        assert RERANK_SENTINEL not in response.text
        assert RERANK_SENTINEL not in caplog.text
        refusals = [record for record in caplog.records if record.msg == "answer refused"]
        assert refusals
        assert refusals[0].reason == "rerank:RerankProviderError"
        # The rerank client is disposed on this path too.
        assert len(closed) == 2

    _scenario(body, rerank_enabled=True)


def test_a_misconfigured_rerank_key_is_a_502_not_a_traceback() -> None:
    """The other way the same type escapes: the adapter refuses an empty key at construction.

    That happens per request, inside the route's ``try``, so a deployment with reranking
    enabled and no key would otherwise answer 500 with a traceback to the user asking a
    question. It is a wiring error, and the review is explicit that a wiring error should stay
    visible in the log - which the fixed 502 plus the recorded type does.
    """

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        # No stubbing: the real ``build_rerank_provider`` refuses an empty key itself.
        response = await _ask(client)

        assert response.status_code == 502
        assert response.json() == {"detail": answers_api.UPSTREAM_UNAVAILABLE}

    _scenario(body, rerank_enabled=True, openrouter_api_key="")


def test_a_genuine_rerank_bug_is_not_flattened_into_a_generic_502() -> None:
    """The review is explicit: a programming error stays visible.

    The rerank catch is typed, not ``Exception``, so a ``TypeError`` in the adapter must still
    reach the developer as a traceback. Without this the narrow catch could be widened to
    ``Exception`` - which would still satisfy every other test in this file, since they all
    raise real provider errors - and a real defect would start answering 502.
    """

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)

        def broken(settings: Any, rerank_client: Any) -> Any:
            raise TypeError("the adapter was called with the wrong arity")

        _rerank_builder.override = broken  # type: ignore[attr-defined]
        try:
            with pytest.raises(TypeError):
                await _ask(client)
        finally:
            _rerank_builder.override = None  # type: ignore[attr-defined]

    _scenario(body, rerank_enabled=True)


def test_the_rerank_client_is_closed_on_the_failure_path() -> None:
    """A client that is only closed when the call succeeds is the P2 defect again.

    Driven by a real ``RerankProviderError`` rather than a bare ``RuntimeError``: a generic
    exception is deliberately *not* caught at the boundary, so it would propagate and prove
    nothing about which clients get disposed on the path that matters.
    """

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        closed: list[str] = []
        real_client = httpx.AsyncClient
        generation = _completion(_payload())

        def split(**kwargs: Any) -> Any:
            kwargs["transport"] = generation
            built = real_client(**kwargs)
            inner = built.aclose

            async def tracking() -> None:
                closed.append("closed")
                await inner()

            built.aclose = tracking  # type: ignore[method-assign]
            return built

        answers_api.httpx = type(
            "S",
            (),
            {
                "__getattr__": lambda self, n: getattr(httpx, n),
                "AsyncClient": staticmethod(split),
            },
        )

        def refusing_builder(settings: Any, client: Any) -> Any:
            def refusing(request: httpx.Request) -> httpx.Response:
                return httpx.Response(422, json={"error": RERANK_SENTINEL})

            client._transport = httpx.MockTransport(refusing)
            return _real_rerank_builder(settings, client=client)

        _rerank_builder.override = refusing_builder  # type: ignore[attr-defined]
        try:
            response = await _ask(client)
        finally:
            _rerank_builder.override = None  # type: ignore[attr-defined]

        assert response.status_code == 502
        # The generation client and the rerank client, both disposed.
        assert len(closed) == 2

    _scenario(body, rerank_enabled=True)
