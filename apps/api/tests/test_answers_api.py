"""Tests for ``POST /api/answers``.

Two things are being pinned here, and one of them is new to this project.

*The response shape.* ``technical-details.md`` fixes the keys at exactly
``{answer, claims, sources, abstained, request_id}``. That is asserted literally, because
this is the first endpoint whose body carries document text and the first whose shape a
browser depends on. A field added here is a contract the moment a client exists.

*The text, and where it is allowed to appear.* ``claims[].quote`` is document text, so this
route is the boundary that moves rather than disappears: the text crosses in the response
and must not cross in a log line or an error message. ``CODE_STYLE.md`` section 9 forbids
raw document text in logs, and the two failure paths below check it - a provider refusal and
a rejected citation - because an error handler is the easiest place in a codebase to leak
the very content the log rule is about.

The rate limiter is real but its window is shrunk so a burst is observable without waiting,
and every provider call goes through ``MockTransport`` so nothing reaches the network.
"""

import asyncio
import json
import logging
from collections.abc import Coroutine
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
from app.settings import Settings
from tests.test_manager_api import (
    TEST_PASSWORDS,
    VALID_ORIGIN,
    _login_as,
)
from tests.test_retrieval import (
    EMPLOYEE_DOCUMENT,
    EMPLOYEE_TEXT,
    MANAGER_DOCUMENT,
    MANAGER_TEXT,
    FakeProvider,
    _publish,
)

#: A span that really occurs in ``EMPLOYEE_TEXT``, so Part 14 accepts a claim built on it.
GOOD_QUOTE = "درخواست باید ظرف ۱۵ روز ثبت شود"
CLAIM_TEXT = "درخواست بازپرداخت سفر باید ظرف ۱۵ روز ثبت شود."
QUESTION = "مهلت ثبت درخواست بازپرداخت هزینه سفر چند روز است؟"


def _settings(**overrides: Any) -> Settings:
    """Test settings, with any override applied last.

    The defaults and the caller's arguments are merged into one mapping before ``Settings``
    is built, so a test that wants its own ``answer_rate_limit`` replaces the one here
    rather than colliding with it.
    """
    defaults: dict[str, Any] = {
        "db_name": "enterprise_knowledge_copilot_test",
        "seed_employee_password": TEST_PASSWORDS["employee"],
        "seed_manager_password": TEST_PASSWORDS["manager"],
        "openrouter_api_key": "test-key-not-a-real-secret",
        # High enough that the ordinary tests never reach the limiter; its own test file
        # pins the behaviour against a clock the limiter does not own.
        "answer_rate_limit": 1000,
    }
    return Settings(**{**defaults, **overrides})


@pytest.fixture(autouse=True)
def pinned_test_database() -> None:
    assert _settings().db_name == "enterprise_knowledge_copilot_test"


def _payload(
    *,
    claims: list[dict[str, str]] | None = None,
    abstained: bool = False,
    missing_parts: list[str] | None = None,
) -> str:
    return json.dumps(
        {
            "claims": (
                claims
                if claims is not None
                else [{"evidence_id": "E1", "quote": GOOD_QUOTE, "text": CLAIM_TEXT}]
            ),
            "abstained": abstained,
            "missing_parts": missing_parts or [],
            "answer": "نثر آزاد مدل که هرگز نباید سروشده شود.",
        },
        ensure_ascii=False,
    )


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
                "usage": {
                    "prompt_tokens": 1548,
                    "completion_tokens": 815,
                    "total_tokens": 2363,
                    "cost": 0,
                },
            },
        )

    return httpx.MockTransport(handler)


def _refusal(status: int = 429) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            json={
                "error": {
                    "code": status,
                    "message": "Rate limit exceeded: free-models-per-day",
                    "metadata": {"limit_source": "openrouter_free_tier_daily"},
                }
            },
        )

    return httpx.MockTransport(handler)


class _HttpxShim:
    """``httpx`` with ``AsyncClient`` pointed at a canned transport, and nothing else moved.

    A proxy rather than a patch on the module object, for the reason
    ``_AsyncioWithASleeper`` uses one in ``test_generation_report.py``: patching the real
    module changes it for the whole process, including this test's own ASGI client, whose
    transport was then overwritten and whose every response was a mocked generation.
    """

    def __init__(self, real: Any, holder: dict[str, Any]) -> None:
        self._real = real
        # Held by reference so a test that swaps ``holder["transport"]`` changes what the
        # next client is built with.
        self._holder = holder

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    def AsyncClient(self, **kwargs: Any) -> Any:  # noqa: N802 - mirrors the real name
        kwargs["transport"] = self._holder["transport"]
        return self._real.AsyncClient(**kwargs)


@pytest.fixture(autouse=True)
def canned_provider(monkeypatch: Any) -> Any:
    """Route every OpenRouter call to a canned transport and fake the embedding provider.

    Reranking is **forced off**, and that is the point of the line. This file previously
    stubbed ``answers_api.build_rerank_provider``, which stopped having any effect the moment
    the route began reaching the adapter through ``_rerank_builder`` - a dead patch that
    looked like coverage. Nothing here tests reranking, so a stub was never needed; what was
    needed was to refuse the branch, so that a scenario flipping ``rerank_enabled`` cannot
    quietly build the real adapter and call the real upstream. Asserted rather than assumed:
    every scenario here answers 200, and a live call would answer 502.
    """
    from app.cli import run_worker

    holder: dict[str, Any] = {"transport": _completion(_payload())}
    monkeypatch.setattr(answers_api, "httpx", _HttpxShim(httpx, holder))
    monkeypatch.setattr(
        run_worker,
        "build_provider",
        # ``client`` is the route's, borrowed rather than opened - see the review's P2.
        lambda settings, *, attempt_timeout, client=None: FakeProvider(),
    )

    def refuse(settings: Any, client: Any) -> Any:
        raise AssertionError(
            "this file does not test reranking; build the adapter in the scenario that does"
        )

    monkeypatch.setattr(answers_api, "_rerank_builder", refuse)
    return holder


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    return asyncio.run(coroutine)


def _client(engine: AsyncEngine, settings: Settings) -> httpx.AsyncClient:
    from app.api.answer_rate_limit import AnswerRateLimiter

    app = create_app()
    app.state.db_engine = engine
    app.state.db_session_factory = create_session_factory(engine)
    # ``create_app`` reads the environment, so the limiter it built would carry the
    # production default rather than the one this scenario asked for - and a burst test
    # quietly allowed six instead of three asserts nothing.
    app.state.settings = settings
    app.state.answer_rate_limiter = AnswerRateLimiter(
        settings.answer_rate_limit,
        settings.answer_rate_window_seconds,
        settings.answer_rate_max_keys,
    )
    # The route reads its settings through ``Depends(get_settings)``. ``create_app`` reads the
    # environment, so without this an override asked for by a scenario - a rerank flag, a
    # request budget - would not reach the route and the scenario would assert against the
    # production default while appearing to pass.
    app.dependency_overrides[answers_api.get_settings] = lambda: settings
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


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


def _scenario[Result](body: Any, **overrides: Any) -> Result:
    async def main() -> Result:
        settings = _settings(**overrides)
        engine = create_engine(settings)
        try:
            await _reset(engine)
            factory = create_session_factory(engine)
            await _seed(factory)
            async with _client(engine, settings) as client:
                return await body(engine, factory, client)
        finally:
            await engine.dispose()

    return _run(main())


async def _ask(
    client: httpx.AsyncClient, question: str = QUESTION, login: str = "employee", **kwargs: Any
) -> httpx.Response:
    token = await _login_as(client, login)
    return await client.post(
        "/api/answers",
        json={"question": question},
        cookies={"ekc_session": token},
        headers={"Origin": VALID_ORIGIN},
        **kwargs,
    )


# --------------------------------------------------------------------------
# the shape
# --------------------------------------------------------------------------


def test_the_response_carries_exactly_the_contract_keys() -> None:
    """``technical-details.md`` fixes five keys. Adding a sixth is a contract change."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)

        response = await _ask(client)

        assert response.status_code == 200, response.text
        assert set(response.json()) == {
            "answer",
            "claims",
            "sources",
            "abstained",
            "request_id",
        }

    _scenario(body)


def test_a_grounded_answer_is_served_with_its_citation() -> None:
    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)

        body_ = (await _ask(client)).json()

        assert body_["answer"] == CLAIM_TEXT
        assert body_["abstained"] is False
        assert body_["request_id"]
        assert body_["sources"] == [
            {
                "document_id": EMPLOYEE_DOCUMENT,
                "section_id": body_["sources"][0]["section_id"],
                "revision": body_["sources"][0]["revision"],
            }
        ]
        claim = body_["claims"][0]
        assert set(claim) == {"text", "quote", "source"}
        assert claim["quote"] == GOOD_QUOTE
        assert claim["source"]["document_id"] == EMPLOYEE_DOCUMENT

    _scenario(body)


def test_the_served_answer_is_never_the_models_own_prose() -> None:
    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)

        body_ = (await _ask(client)).json()

        assert "نثر آزاد مدل" not in body_["answer"]
        assert body_["answer"] == CLAIM_TEXT

    _scenario(body)


def test_the_models_internal_handle_never_crosses() -> None:
    """The handle exists so the model could not name a document; a reader must not see it."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)

        response = await _ask(client)

        assert "E1" not in response.text

    _scenario(body)


def test_an_abstention_is_served_rather_than_failing(canned_provider: Any) -> None:
    """Refusing is a product answer, so it is a 200 with a reason and no citations.

    "Did it abstain" and "did it abstain cleanly" are different questions, and the second is
    the one that would leak: an abstention still carrying claims would be a refusal with the
    answer attached.
    """

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        from app.answer.compose import REFUSAL_BY_PART

        await _documents(factory)
        canned_provider["transport"] = _completion(
            _payload(claims=[], abstained=True, missing_parts=["insufficient_evidence"])
        )

        response = await _ask(client)

        assert response.status_code == 200, response.text
        served = response.json()
        assert served["abstained"] is True
        assert served["claims"] == []
        assert served["sources"] == []
        assert served["answer"] == REFUSAL_BY_PART["insufficient_evidence"]

    _scenario(body)


def test_a_mixed_answer_serves_the_claim_and_the_refusal(canned_provider: Any) -> None:
    """The public half answered, the restricted half refused, with nothing added."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        from app.answer.compose import REFUSAL_BY_PART

        await _documents(factory)
        canned_provider["transport"] = _completion(
            _payload(abstained=True, missing_parts=["insufficient_evidence"])
        )

        served = (await _ask(client)).json()

        assert served["abstained"] is True
        assert len(served["claims"]) == 1
        lines = served["answer"].split("\n")
        assert lines[0] == CLAIM_TEXT
        assert lines[1] == REFUSAL_BY_PART["insufficient_evidence"]

    _scenario(body)


def test_an_empty_question_is_refused_before_any_provider_work() -> None:
    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        token = await _login_as(client, "employee")

        response = await client.post(
            "/api/answers",
            json={"question": ""},
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )

        assert response.status_code == 422

    _scenario(body)


def test_an_oversized_question_is_refused() -> None:
    """The ceiling is from the technical contract; it belongs on the request model."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        token = await _login_as(client, "employee")

        response = await client.post(
            "/api/answers",
            json={"question": "ا" * 2001},
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )

        assert response.status_code == 422

    _scenario(body)


def test_a_question_at_the_ceiling_is_accepted() -> None:
    """At the ceiling is accepted; one over it is not. The boundary is inclusive."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        token = await _login_as(client, "employee")
        # Padded to the ceiling rather than replaced with filler: a question of one repeated
        # letter retrieves nothing, so the canned claim could not validate and the route
        # refused for a reason that had nothing to do with the length.
        padded = QUESTION + " " + "ا" * (2000 - len(QUESTION) - 1)
        assert len(padded) == 2000

        response = await client.post(
            "/api/answers",
            json={"question": padded},
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )

        assert response.status_code == 200, response.text

    _scenario(body)


def test_an_unauthenticated_question_is_refused() -> None:
    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        response = await client.post(
            "/api/answers",
            json={"question": QUESTION},
            headers={"Origin": VALID_ORIGIN},
        )

        assert response.status_code == 401

    _scenario(body)


def test_a_question_cannot_claim_a_role_or_a_document(canned_provider: Any) -> None:
    """Nothing in the body reaches the authorization decision, which is what matters.

    Asserted as the manager document never appearing rather than as a particular status:
    the question retrieves the employee's own passage and the canned claim may or may not
    validate against it, and neither outcome is the subject here. What must hold either way
    is that naming a role, a document id and an access role in the body changed nothing.
    """

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        token = await _login_as(client, "employee")

        response = await client.post(
            "/api/answers",
            json={
                "question": f"{QUESTION} {MANAGER_DOCUMENT} سقف پرداخت مدیران چقدر است؟",
                "role": "manager",
                "document_id": MANAGER_DOCUMENT,
                "access_role": "manager",
            },
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )

        assert MANAGER_DOCUMENT not in response.text
        assert "مدیران" not in response.text

    _scenario(body)


def test_the_answer_is_not_cacheable() -> None:
    """Per-user content: an intermediary cache would hand it to the next reader."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)

        response = await _ask(client)

        assert "no-store" in response.headers.get("cache-control", "")

    _scenario(body)


# --------------------------------------------------------------------------
# failures
# --------------------------------------------------------------------------


def test_a_provider_refusal_is_a_fixed_error_with_no_detail(canned_provider: Any) -> None:
    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        canned_provider["transport"] = _refusal()

        response = await _ask(client)

        assert response.status_code == 502
        assert response.json() == {"detail": answers_api.UPSTREAM_UNAVAILABLE}
        # Never the provider's own wording: it can quote the request back.
        assert "free-models-per-day" not in response.text
        assert "rate limit" not in response.text.lower()

    _scenario(body)


def test_a_rejected_citation_is_an_error_not_a_silent_guess(canned_provider: Any) -> None:
    """An invalid generation is a failure. Answering anyway would be a fabrication."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        canned_provider["transport"] = _completion(
            _payload(
                claims=[
                    {
                        "evidence_id": "E1",
                        "quote": "درخواست باید ظرف ۹۰ روز ثبت شود",
                        "text": "درخواست باید ظرف ۹۰ روز ثبت شود",
                    }
                ]
            )
        )

        response = await _ask(client)

        assert response.status_code == 502
        assert response.json() == {"detail": answers_api.UPSTREAM_UNAVAILABLE}
        assert "۹۰ روز" not in response.text

    _scenario(body)


def test_a_failure_never_leaks_document_text_into_the_response(canned_provider: Any) -> None:
    """The whole reason this route needs a stated rule: the failure path is where leaks go."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        canned_provider["transport"] = _completion(
            _payload(
                claims=[
                    {
                        "evidence_id": "E1",
                        "quote": "درخواست باید ظرف ۹۰ روز ثبت شود",
                        "text": "متنی که هرگز نباید بیرون بیاید",
                    }
                ]
            )
        )

        response = await _ask(client)

        for forbidden in ("متنی که", "۹۰ روز", "درخواست باید", "Traceback", "sqlalchemy"):
            assert forbidden not in response.text, forbidden

    _scenario(body)


def test_a_failure_logs_a_request_id_and_no_text(
    canned_provider: Any, monkeypatch: Any, caplog: Any
) -> None:
    """The operator gets the reason; the log gets the id. Neither gets the document.

    Asserted on the records rather than on ``caplog.text``: the reason travels in ``extra``,
    so it was never in the rendered message, and checking the record is also what proves it
    is structured data an aggregator can index instead of prose.
    """

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        canned_provider["transport"] = _completion(
            _payload(
                claims=[
                    {
                        "evidence_id": "E1",
                        "quote": "درخواست باید ظرف ۹۰ روز ثبت شود",
                        "text": "متنی که نباید ثبت شود",
                    }
                ]
            )
        )

        with caplog.at_level(logging.WARNING):
            response = await _ask(client)

        assert response.status_code == 502
        refusals = [record for record in caplog.records if record.msg == "answer refused"]
        assert refusals, [record.msg for record in caplog.records]
        assert refusals[0].reason == "invalid_generation:quote_not_found"
        assert refusals[0].request_id
        assert refusals[0].role == "employee"

        rendered = caplog.text
        for forbidden in ("متنی که", "۹۰ روز", "درخواست باید", QUESTION):
            assert forbidden not in rendered, forbidden

    _scenario(body)


def test_a_success_logs_counts_and_never_the_answer(caplog: Any) -> None:
    """The success path logs the shape of the run and none of its content."""

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)

        with caplog.at_level(logging.INFO):
            response = await _ask(client)

        assert response.status_code == 200
        served = [record for record in caplog.records if record.msg == "answer served"]
        assert served, [record.msg for record in caplog.records]
        assert served[0].claims == 1
        assert served[0].abstained is False
        assert served[0].request_id

        rendered = caplog.text
        for forbidden in (CLAIM_TEXT, GOOD_QUOTE, QUESTION, EMPLOYEE_DOCUMENT):
            assert forbidden not in rendered, forbidden

    _scenario(body)


def test_no_authorized_document_refuses_without_a_provider_call(canned_provider: Any) -> None:
    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        canned_provider["transport"] = _refusal()  # would fail loudly if called

        response = await _ask(client)

        assert response.status_code == 200
        body_ = response.json()
        assert body_["abstained"] is True
        assert body_["claims"] == []
        assert body_["sources"] == []

    _scenario(body)


# --------------------------------------------------------------------------
# the rate limiter, at the boundary
# --------------------------------------------------------------------------


class _StallingTransport(httpx.AsyncBaseTransport):
    """Accepts a request and then never answers.

    Async on purpose: ``httpx.MockTransport`` runs its handler synchronously on the event
    loop, so a blocking sleep there stops ``wait_for`` from ever firing and the test observes
    the stall finishing rather than the deadline arriving.
    """

    def __init__(self, delay: float = 5.0) -> None:
        self._delay = delay
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        await asyncio.sleep(self._delay)
        return httpx.Response(500)


def test_a_stalled_provider_is_given_up_on_at_the_deadline(
    canned_provider: Any, monkeypatch: Any
) -> None:
    """The request budget, which no other test could observe.

    Everything else here answers instantly through a canned transport, so removing the
    deadline left the suite green - the guard existed and nothing proved it. This transport
    never answers, and the budget is shortened through the module constant so the test takes
    a second rather than a minute.
    """

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        monkeypatch.setattr(answers_api, "REQUEST_BUDGET_SECONDS", 0.25)

        canned_provider["transport"] = _StallingTransport()

        response = await _ask(client)

        assert response.status_code == 504
        assert response.json() == {"detail": answers_api.DEADLINE_EXCEEDED}
        # A deadline must not leak what it was waiting on, and must not leave the failure
        # looking like an outage it was not.
        assert "unavailable" not in response.text

    _scenario(body)


def test_the_deadline_is_logged_with_its_reason_and_no_text(
    canned_provider: Any, monkeypatch: Any, caplog: Any
) -> None:
    """A deadline that hid the attempt's usage would be the silent loss Part 13 found."""
    import logging

    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        monkeypatch.setattr(answers_api, "REQUEST_BUDGET_SECONDS", 0.25)

        canned_provider["transport"] = _StallingTransport()

        with caplog.at_level(logging.WARNING):
            response = await _ask(client)

        assert response.status_code == 504
        refusals = [record for record in caplog.records if record.msg == "answer refused"]
        assert refusals, [record.msg for record in caplog.records]
        assert refusals[0].reason == "deadline_exceeded"

    _scenario(body)


def test_the_window_refuses_a_burst_and_says_when_to_retry() -> None:
    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        token = await _login_as(client, "employee")

        for _ in range(3):
            allowed = await client.post(
                "/api/answers",
                json={"question": QUESTION},
                cookies={"ekc_session": token},
                headers={"Origin": VALID_ORIGIN},
            )
            assert allowed.status_code == 200, allowed.text

        refused = await client.post(
            "/api/answers",
            json={"question": QUESTION},
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )

        assert refused.status_code == 429
        assert refused.json() == {"detail": answers_api.RATE_LIMITED}
        assert int(refused.headers["retry-after"]) >= 1

    _scenario(body, answer_rate_limit=3)


def test_one_role_exhausting_its_window_does_not_lock_the_other_out() -> None:
    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        employee = await _login_as(client, "employee")
        headers = {"Origin": VALID_ORIGIN}

        for _ in range(4):
            await client.post(
                "/api/answers",
                json={"question": QUESTION},
                cookies={"ekc_session": employee},
                headers=headers,
            )

        refused_employee = await client.post(
            "/api/answers",
            json={"question": QUESTION},
            cookies={"ekc_session": employee},
            headers=headers,
        )
        assert refused_employee.status_code == 429

        manager = await _login_as(client, "manager")
        allowed_manager = await client.post(
            "/api/answers",
            json={"question": QUESTION},
            cookies={"ekc_session": manager},
            headers=headers,
        )
        assert allowed_manager.status_code == 200, allowed_manager.text

    _scenario(body, answer_rate_limit=3)


def test_a_refused_request_reaches_no_provider(canned_provider: Any) -> None:
    async def body(engine: Any, factory: Any, client: httpx.AsyncClient) -> None:
        await _documents(factory)
        token = await _login_as(client, "employee")
        calls = {"n": 0}

        def counting(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return _completion(_payload()).handle_request(request)

        canned_provider["transport"] = httpx.MockTransport(counting)
        headers = {"Origin": VALID_ORIGIN}

        for _ in range(3):
            await client.post(
                "/api/answers",
                json={"question": QUESTION},
                cookies={"ekc_session": token},
                headers=headers,
            )
        reached = calls["n"]
        assert reached == 3

        refused = await client.post(
            "/api/answers",
            json={"question": QUESTION},
            cookies={"ekc_session": token},
            headers=headers,
        )

        assert refused.status_code == 429
        assert calls["n"] == reached  # refused before any provider work

    _scenario(body, answer_rate_limit=3)
