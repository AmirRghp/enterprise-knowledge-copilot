"""Tests for the optional OpenRouter rerank adapter.

Everything here is driven by ``httpx.MockTransport`` and an injected retry policy, so
no test reaches the network, no test waits on a real clock, and no test needs an API
key.

The negative cases are the point of this file. A rerank adapter's whole job is
converting a response nobody controls into a ranking the rest of the system will serve,
so the tests concentrate on the ways that conversion goes quietly wrong: an ``index``
that is a boolean, an index outside the request, a repeated index, a score that cannot
be ordered, the wrong number of results, and a body that is not shaped like a response
at all. Each of those has a plausible-looking wrong answer, which is why none of them is
merely asserted to raise but is checked to raise *instead of returning a ranking*.

The count check is deliberately exercised at several candidate counts, because the
expected size is ``min(top_n, len(candidates))`` and a constant 20 would pass every test
that used a full-size request.
"""

import asyncio
import json
import math
import uuid
from collections.abc import Coroutine
from decimal import Decimal
from typing import Any

import httpx
import pytest

from app.providers.base import (
    ProviderUsage,
    RerankCandidate,
    RerankProvider,
    ScoredCandidate,
)
from app.providers.rerank import (
    DEFAULT_RERANK_POLICY,
    OpenRouterRerankProvider,
    RerankProviderError,
    RerankResponseError,
    build_rerank_provider,
)
from app.providers.retry import RetryPolicy
from app.settings import Settings

MODEL = "nvidia/llama-nemotron-rerank-vl-1b-v2:free"
BASE_URL = "https://openrouter.test/api/v1"
API_KEY = "test-key-not-a-real-secret"

#: Bounded by the contract at twenty candidates, which is what ``rerank_top_k`` says.
MAX_CANDIDATES = 20


def _candidates(count: int) -> list[RerankCandidate]:
    return [
        RerankCandidate(chunk_id=uuid.uuid4(), text=f"متن نامزد شمارهٔ {index}")
        for index in range(count)
    ]


def _result(index: int, score: float = 0.5) -> dict[str, Any]:
    return {"index": index, "relevance_score": score, "document": {"text": "echoed"}}


def _provider(
    handler: Any, *, policy: RetryPolicy | None = None, api_key: str = API_KEY
) -> OpenRouterRerankProvider:
    client = httpx.AsyncClient(
        timeout=5.0,
        transport=httpx.MockTransport(handler),
    )
    return OpenRouterRerankProvider(
        client,
        base_url=BASE_URL,
        model=MODEL,
        api_key=api_key,
        policy=policy,
    )


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    return asyncio.run(coroutine)


def _timed[Result](thunk: Any) -> tuple[float, BaseException | None]:
    """Run ``thunk`` and report how long it took, plus any exception it raised.

    Returns rather than raising so a test can assert on the elapsed time in the same
    breath as the failure, which is the only way a deadline test can fail honestly: an
    assertion on the exception alone passes just as well for a hang.
    """
    loop = asyncio.new_event_loop()
    try:
        started = loop.time()
        try:
            loop.run_until_complete(thunk())
        except BaseException as error:  # noqa: BLE001 - reported, not swallowed
            return loop.time() - started, error
        return loop.time() - started, None
    finally:
        loop.close()


# --------------------------------------------------------------------------
# the request: what is sent, and to where
# --------------------------------------------------------------------------


def test_the_request_carries_the_model_query_and_documents_in_order() -> None:
    sent: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent.update(
            {
                "url": str(request.url),
                "method": request.method,
                "body": __import__("json").loads(request.content),
                "auth": request.headers.get("Authorization"),
            }
        )
        return httpx.Response(200, json={"results": [_result(1, 0.9), _result(0, 0.1)]})

    candidates = _candidates(2)
    scored = _run(_provider(handler).rerank("پرسش", candidates, top_n=2))

    assert sent["method"] == "POST"
    assert sent["url"] == f"{BASE_URL}/rerank"
    assert sent["auth"] == f"Bearer {API_KEY}"
    assert sent["body"]["model"] == MODEL
    assert sent["body"]["query"] == "پرسش"
    assert sent["body"]["top_n"] == 2
    assert sent["body"]["documents"] == [c.text for c in candidates]
    assert [s.chunk_id for s in scored] == [candidates[1].chunk_id, candidates[0].chunk_id]
    assert [s.score for s in scored] == [0.9, 0.1]


def test_top_n_is_capped_at_the_number_of_candidates_actually_sent() -> None:
    """Asking for more than was sent is the caller's error, not the provider's."""

    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(__import__("json").loads(request.content))
        # The provider answers with exactly what was asked for.
        return httpx.Response(
            200,
            json={"results": [_result(index) for index in range(seen["top_n"])]},
        )

    candidates = _candidates(3)
    _run(_provider(handler).rerank("پرسش", candidates, top_n=MAX_CANDIDATES))

    assert seen["top_n"] == 3, seen
    assert len(seen["documents"]) == 3


def test_the_model_and_base_url_come_from_settings() -> None:
    """A deployed model must be a configuration value, never a constant in code."""
    settings = Settings(
        db_name="enterprise_knowledge_copilot_test",
        openrouter_api_key="k" * 32,
        openrouter_base_url="https://example.test/v1",
        openrouter_rerank_model="someone/other-reranker:free",
    )
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"results": []}))
    )

    provider = build_rerank_provider(settings, client=client)

    assert provider.model == "someone/other-reranker:free"
    assert provider._base_url == "https://example.test/v1"  # noqa: SLF001
    assert provider.provider_name == "openrouter"


def test_an_empty_api_key_is_refused_before_any_request_is_possible() -> None:
    with pytest.raises(RerankProviderError, match="needs an API key"):
        _provider(lambda r: httpx.Response(200, json={}), api_key="")


def test_rerank_needs_at_least_one_candidate_and_a_positive_top_n() -> None:
    provider = _provider(lambda r: httpx.Response(200, json={"results": []}))
    with pytest.raises(ValueError, match="at least one candidate"):
        _run(provider.rerank("پرسش", [], top_n=5))
    with pytest.raises(ValueError, match="top_n must be at least 1"):
        _run(provider.rerank("پرسش", _candidates(2), top_n=0))


def test_the_adapter_satisfies_the_protocol() -> None:
    """The dependency is the protocol, so a two-method fake is enough in a caller."""
    provider = _provider(lambda r: httpx.Response(200, json={"results": []}))
    assert isinstance(provider, RerankProvider)


# --------------------------------------------------------------------------
# index: the one thing the response is trusted for
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("label", "results"),
    [
        ("index missing", [{"relevance_score": 0.5}]),
        ("index is a string", [{"index": "0", "relevance_score": 0.5}]),
        ("index is a float", [{"index": 0.0, "relevance_score": 0.5}]),
        ("index is null", [{"index": None, "relevance_score": 0.5}]),
        ("index is an object", [{"index": {}, "relevance_score": 0.5}]),
    ],
)
def test_a_non_integer_index_is_refused(label: str, results: list[dict[str, Any]]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": results})

    with pytest.raises(RerankResponseError, match="index was not an integer"):
        _run(_provider(handler).rerank("پرسش", _candidates(1), top_n=1))


def test_a_boolean_index_is_refused_even_though_it_is_an_integer_subclass() -> None:
    """The one that a naive ``isinstance`` check would wave through.

    JSON ``true`` decodes to Python ``bool``, and ``bool`` is a subclass of ``int``, so
    ``isinstance(True, int)`` is True. An ``isinstance`` check would read ``true`` as
    index 1 and attach a real score to a chunk that was never scored.
    """
    assert isinstance(True, int), "the trap this test guards is real in Python"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [{"index": True, "relevance_score": 0.9}]})

    with pytest.raises(RerankResponseError, match="index was not an integer"):
        _run(_provider(handler).rerank("پرسش", _candidates(2), top_n=1))


def test_a_false_index_is_refused_too() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [{"index": False, "relevance_score": 0.9}]})

    with pytest.raises(RerankResponseError, match="index was not an integer"):
        _run(_provider(handler).rerank("پرسش", _candidates(2), top_n=1))


@pytest.mark.parametrize("index", [-1, 2, 99])
def test_an_index_outside_the_request_is_refused(index: int) -> None:
    """The published schema gives ``index`` no stated bounds, so this is defensive."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [_result(index)]})

    with pytest.raises(RerankResponseError, match="outside the request"):
        _run(_provider(handler).rerank("پرسش", _candidates(2), top_n=1))


def test_a_repeated_index_is_refused_rather_than_scoring_one_chunk_twice() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [_result(0, 0.9), _result(0, 0.2)]})

    with pytest.raises(RerankResponseError, match="repeated an index"):
        _run(_provider(handler).rerank("پرسش", _candidates(3), top_n=2))


# --------------------------------------------------------------------------
# score: has to be a number that can be ordered
# --------------------------------------------------------------------------


@pytest.mark.parametrize("score", [None, "0.5", {}, [], True, False])
def test_a_non_numeric_score_is_refused(score: object) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [{"index": 0, "relevance_score": score}]})

    with pytest.raises(RerankResponseError, match="score was not a number"):
        _run(_provider(handler).rerank("پرسش", _candidates(1), top_n=1))


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_a_non_finite_score_is_refused_because_it_cannot_be_ordered(literal: str) -> None:
    """A NaN would sort silently rather than raise, giving a wrong ranking."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = '{"results": [{"index": 0, "relevance_score": ' + literal + "}]}"
        return httpx.Response(
            200, content=body.encode(), headers={"Content-Type": "application/json"}
        )

    with pytest.raises(RerankResponseError, match="not finite"):
        _run(_provider(handler).rerank("پرسش", _candidates(1), top_n=1))


def test_a_zero_score_is_accepted_because_zero_is_a_real_measurement() -> None:
    """Only a *missing* figure is unknown; a reported zero is a fact."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [_result(0, 0.0)]})

    scored = _run(_provider(handler).rerank("پرسش", _candidates(1), top_n=1))

    assert scored[0].score == 0.0


def test_an_integer_score_is_accepted_and_narrowed_to_float() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [{"index": 0, "relevance_score": 1}]})

    scored = _run(_provider(handler).rerank("پرسش", _candidates(1), top_n=1))

    assert isinstance(scored[0].score, float)
    assert scored[0].score == 1.0


# --------------------------------------------------------------------------
# the response shape
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("candidates", "top_n", "results"),
    [
        (2, 2, []),  # fewer: something was dropped
        (2, 2, [_result(0), _result(1), _result(2)]),  # more: something was invented
        (5, 5, [_result(0)]),  # far fewer
        (1, 1, [_result(0), _result(1)]),
    ],
)
def test_a_wrong_number_of_results_is_refused(
    candidates: int, top_n: int, results: list[dict[str, Any]]
) -> None:
    """Fewer means something was dropped; more means something was invented.

    The expectation is the *effective* request size, not a constant twenty, so this is
    checked at several candidate counts and with both directions of mismatch.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": results})

    with pytest.raises(RerankResponseError, match="results for"):
        _run(_provider(handler).rerank("پرسش", _candidates(candidates), top_n=top_n))


def test_an_exactly_sized_response_is_accepted_at_several_sizes() -> None:
    """The other half of the previous test: the check must not simply always fail."""

    for count in (1, 3, 7, MAX_CANDIDATES):

        def handler(request: httpx.Request, count: int = count) -> httpx.Response:
            return httpx.Response(200, json={"results": [_result(i) for i in range(count)]})

        candidates = _candidates(count)
        scored = _run(_provider(handler).rerank("پرسش", candidates, top_n=count))
        assert len(scored) == count, (count, len(scored))


def test_a_missing_results_key_is_refused() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "x", "model": MODEL})

    with pytest.raises(RerankResponseError, match="no results list"):
        _run(_provider(handler).rerank("پرسش", _candidates(1), top_n=1))


def test_a_results_value_that_is_not_a_list_is_refused() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": {"index": 0}})

    with pytest.raises(RerankResponseError, match="no results list"):
        _run(_provider(handler).rerank("پرسش", _candidates(1), top_n=1))


def test_a_non_object_entry_in_results_is_refused() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [_result(0), "spurious"]})

    with pytest.raises(RerankResponseError, match="non-object entry"):
        _run(_provider(handler).rerank("پرسش", _candidates(2), top_n=2))


def test_invalid_json_is_refused() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"{not json", headers={"Content-Type": "application/json"}
        )

    with pytest.raises(RerankResponseError, match="invalid JSON"):
        _run(_provider(handler).rerank("پرسش", _candidates(1), top_n=1))


def test_a_body_that_is_not_an_object_is_refused() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[_result(0)])

    with pytest.raises(RerankResponseError, match="unexpected payload"):
        _run(_provider(handler).rerank("پرسش", _candidates(1), top_n=1))


# --------------------------------------------------------------------------
# the echoed document is not trusted
# --------------------------------------------------------------------------


def test_the_echoed_document_does_not_decide_which_chunk_a_score_belongs_to() -> None:
    """A provider that rewrites the text must not be able to move a score.

    The response claims every document is the same unrelated string. If the mapping used
    the echo, all three scores would land on whichever chunk matched it. They must land
    on the positions instead.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "index": 2,
                        "relevance_score": 0.9,
                        "document": {"text": "چیزی کاملاً متفاوت"},
                    },
                    {
                        "index": 0,
                        "relevance_score": 0.5,
                        "document": {"text": "چیزی کاملاً متفاوت"},
                    },
                    {
                        "index": 1,
                        "relevance_score": 0.1,
                        "document": {"text": "چیزی کاملاً متفاوت"},
                    },
                ]
            },
        )

    candidates = _candidates(3)
    scored = _run(_provider(handler).rerank("پرسش", candidates, top_n=3))

    assert [s.chunk_id for s in scored] == [
        candidates[2].chunk_id,
        candidates[0].chunk_id,
        candidates[1].chunk_id,
    ]


def test_a_result_without_a_document_field_is_still_accepted() -> None:
    """Only position and score are required; the echo is not part of the contract."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [{"index": 0, "relevance_score": 0.5}]})

    candidates = _candidates(1)
    scored = _run(_provider(handler).rerank("پرسش", candidates, top_n=1))

    assert scored == [ScoredCandidate(chunk_id=candidates[0].chunk_id, score=0.5)]


# --------------------------------------------------------------------------
# usage: absence is reported as absence
# --------------------------------------------------------------------------


def test_reported_usage_is_recorded() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "results": [_result(0)],
                "usage": {"search_units": 1, "total_tokens": 150, "cost": 0.001},
            },
        )

    provider = _provider(handler)
    _run(provider.rerank("پرسش", _candidates(1), top_n=1))
    usage = provider.last_usage

    assert usage is not None
    assert usage.provider == "openrouter"
    assert usage.model == MODEL
    assert usage.billed_units == {"search_units": 1, "total_tokens": 150}
    assert usage.cost == Decimal("0.001")
    assert usage.currency == "credits"


def test_a_missing_usage_block_is_unknown_not_zero() -> None:
    """A fabricated zero cost would be a claim about money nobody made."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [_result(0)]})

    provider = _provider(handler)
    _run(provider.rerank("پرسش", _candidates(1), top_n=1))
    usage = provider.last_usage

    assert usage is not None
    assert usage.billed_units is None
    assert usage.cost is None
    assert usage.currency is None
    assert usage.input_tokens is None


def test_a_partial_usage_block_keeps_the_parts_it_has() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [_result(0)], "usage": {"total_tokens": 150}})

    provider = _provider(handler)
    _run(provider.rerank("پرسش", _candidates(1), top_n=1))
    usage = provider.last_usage

    assert usage is not None
    assert usage.billed_units == {"total_tokens": 150}
    assert usage.cost is None


def test_an_unusable_usage_value_is_dropped_rather_than_coerced() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "results": [_result(0)],
                "usage": {"search_units": "one", "total_tokens": True, "cost": "free"},
            },
        )

    provider = _provider(handler)
    _run(provider.rerank("پرسش", _candidates(1), top_n=1))
    usage = provider.last_usage

    assert usage is not None
    assert usage.billed_units is None
    assert usage.cost is None


def test_usage_is_cleared_before_each_call_so_a_stale_figure_is_never_reported() -> None:
    """A failed call must not leave the previous call's cost looking current."""

    calls: list[httpx.Request] = []

    def counting(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(
                200,
                json={"results": [_result(0)], "usage": {"total_tokens": 150}},
            )
        return httpx.Response(500, json={"error": {"message": "boom"}})

    provider = _provider(counting, policy=RetryPolicy(attempts=1, attempt_timeout_seconds=5.0))
    _run(provider.rerank("پرسش", _candidates(1), top_n=1))
    assert provider.last_usage is not None
    assert provider.last_usage.billed_units == {"total_tokens": 150}

    with pytest.raises(RerankProviderError):
        _run(provider.rerank("پرسش", _candidates(1), top_n=1))
    assert provider.last_usage is None


# --------------------------------------------------------------------------
# failures: visible, bounded, and never carrying the question
# --------------------------------------------------------------------------


def test_a_transient_status_is_retried_and_then_reported() -> None:
    """Two attempts is the documented budget; exhaustion is a visible failure."""

    def handler(request: httpx.Request) -> httpx.Response:
        _seen.append(request)
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    _seen: list[httpx.Request] = []
    provider = _provider(handler, policy=RetryPolicy(attempts=2, attempt_timeout_seconds=5.0))

    with pytest.raises(RerankProviderError, match="did not answer within 2 attempts"):
        _run(provider.rerank("پرسش", _candidates(1), top_n=1))

    assert len(_seen) == 2, "the budget is two attempts"


def test_a_retry_that_succeeds_returns_the_ranking() -> None:
    """A retry is not a fallback: the answer still comes from the configured model."""

    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(503, json={"error": {"message": "unavailable"}})
        return httpx.Response(200, json={"results": [_result(0, 0.7)]})

    provider = _provider(handler, policy=RetryPolicy(attempts=2, attempt_timeout_seconds=5.0))

    scored = _run(provider.rerank("پرسش", _candidates(1), top_n=1))

    assert len(seen) == 2
    assert scored[0].score == 0.7


def test_a_permanent_status_is_not_retried() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        _seen.append(request)
        return httpx.Response(401, json={"error": {"message": "bad key"}})

    _seen: list[httpx.Request] = []
    provider = _provider(handler, policy=RetryPolicy(attempts=2, attempt_timeout_seconds=5.0))

    with pytest.raises(RerankProviderError, match="401"):
        _run(provider.rerank("پرسش", _candidates(1), top_n=1))

    assert len(_seen) == 1, "401 is not transient"


def test_an_echoing_error_body_is_bounded_and_the_question_is_not_echoed_by_us() -> None:
    """A gateway may quote the request; the adapter keeps only a bounded detail."""
    question = "پرسش محرمانه با عبارت یکتا"
    long_echo = question * 100

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"message": f"invalid input: {long_echo}"}})

    with pytest.raises(RerankProviderError) as raised:
        _run(_provider(handler).rerank(question, _candidates(1), top_n=1))

    detail = str(raised.value)
    assert long_echo not in detail
    assert len(detail) < 400, len(detail)


def test_a_transport_failure_is_reported_not_swallowed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    provider = _provider(handler, policy=RetryPolicy(attempts=1, attempt_timeout_seconds=5.0))

    with pytest.raises(RerankProviderError):
        _run(provider.rerank("پرسش", _candidates(1), top_n=1))


def test_a_timeout_is_reported_not_swallowed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow")

    provider = _provider(handler, policy=RetryPolicy(attempts=1, attempt_timeout_seconds=5.0))

    with pytest.raises(RerankProviderError):
        _run(provider.rerank("پرسش", _candidates(1), top_n=1))


# --------------------------------------------------------------------------
# the deadline
# --------------------------------------------------------------------------


def test_the_default_policy_is_the_documented_budget() -> None:
    """Two attempts of at most ten seconds each, per ``technical-details.md``."""
    assert DEFAULT_RERANK_POLICY.attempts == 2
    assert DEFAULT_RERANK_POLICY.attempt_timeout_seconds == 10.0


def test_the_http_timeout_and_the_per_attempt_deadline_are_the_same_figure() -> None:
    """Part 8's review finding, applied here: one deadline, passed to both layers.

    The client's own timeout only covers connect/read/write phases, so a handler that
    stalls between them is bounded solely by the policy. If the two disagreed, a
    stalled request would run longer than the documented budget.
    """
    policy = RetryPolicy(attempts=2, attempt_timeout_seconds=7.5)
    seen: list[float | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.extensions.get("timeout", {}).get("read"))
        return httpx.Response(200, json={"results": [_result(0)]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = OpenRouterRerankProvider(
        client, base_url=BASE_URL, model=MODEL, api_key=API_KEY, policy=policy
    )
    _run(provider.rerank("پرسش", _candidates(1), top_n=1))

    assert seen and all(value == 7.5 for value in seen), seen


def test_a_stalled_handler_still_costs_only_the_attempt_budget() -> None:
    """The wall-clock deadline is real, so a hang cannot become an unbounded wait."""

    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return httpx.Response(200, json={"results": [_result(0)]})

    policy = RetryPolicy(attempts=1, attempt_timeout_seconds=0.25)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = OpenRouterRerankProvider(
        client, base_url=BASE_URL, model=MODEL, api_key=API_KEY, policy=policy
    )

    elapsed = _timed(lambda: provider.rerank("پرسش", _candidates(1), top_n=1))
    elapsed_seconds, error = elapsed

    # The handler asked for thirty seconds; the deadline must cut it far short. Without
    # the measured time this test would pass for any error, including a hang.
    assert elapsed_seconds < 5.0, elapsed_seconds
    assert isinstance(error, RerankProviderError)


# --------------------------------------------------------------------------
# the boundary of what leaves the process
# --------------------------------------------------------------------------


def test_the_candidate_repr_carries_no_document_text() -> None:
    """A repr ends up in tracebacks and test failures, so it must not hold text."""
    secret = "متن محرمانه‌ای که نباید در repr بیاید"
    candidate = RerankCandidate(chunk_id=uuid.uuid4(), text=secret)

    assert secret not in repr(candidate)
    assert str(candidate.chunk_id) in repr(candidate)


def test_the_module_source_does_not_print_the_query_or_the_text() -> None:
    """The guarantee is structural: the adapter has no logging call at all."""
    import pathlib

    source = pathlib.Path(
        OpenRouterRerankProvider.__module__.replace(
            "app.providers.rerank", "app/providers/rerank.py"
        )
    )
    # Resolve via the package instead of guessing a path.
    import app.providers.rerank as module

    text = pathlib.Path(module.__file__).read_text(encoding="utf-8")

    assert "import logging" not in text
    assert "logger" not in text
    assert "print(" not in text
    assert source is not None


def test_no_free_form_text_reaches_a_usage_record() -> None:
    """Usage is the record evaluation keeps; it must hold no document text."""
    secret = "متن محرمانه"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [_result(0)], "usage": {"total_tokens": 1}})

    provider = _provider(handler)
    _run(provider.rerank(secret, _candidates(1), top_n=1))
    usage = provider.last_usage

    assert isinstance(usage, ProviderUsage)
    assert secret not in str(usage)


def test_finite_scores_round_trip_exactly() -> None:
    """Scores are compared and sorted, so they must survive without surprises."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [_result(0, 0.123456789), _result(1, 1.0)]})

    scored = _run(_provider(handler).rerank("پرسش", _candidates(2), top_n=2))

    assert math.isclose(scored[0].score, 0.123456789)
    assert scored[1].score == 1.0


# --------------------------------------------------------------------------
# the review findings: retry re-sends, provenance before egress, overflow
# --------------------------------------------------------------------------


def test_a_retry_rebuilds_the_request_rather_than_replaying_the_first_body() -> None:
    """Review P1, at the adapter layer.

    The body used to be built once in front of the retry loop, so the second attempt
    transmitted the first attempt's text. Building it inside the attempt is what makes
    the "re-check before every send" guarantee hold for retries and not only for the
    first try.
    """
    sent: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content)["documents"])
        if len(sent) == 1:
            return httpx.Response(503, json={"error": {"message": "unavailable"}})
        return httpx.Response(200, json={"results": [_result(0)]})

    versions = iter([["متن نسخهٔ اول"], ["متن نسخهٔ دوم"]])
    provider = _provider(handler, policy=RetryPolicy(attempts=2, attempt_timeout_seconds=5.0))

    async def refresh() -> list[Any]:
        from app.providers.base import RerankCandidate

        return [RerankCandidate(chunk_id=uuid.uuid4(), text=next(versions))]

    candidates = _candidates(1)
    _run(provider.rerank("پرسش", candidates, top_n=1, refresh=refresh))

    assert len(sent) == 2, sent
    assert sent[0] == [["متن نسخهٔ اول"]], sent
    assert sent[1] == [["متن نسخهٔ دوم"]], "the retry replayed the first body"
    assert sent[0] != sent[1], "both attempts carried the same text"


def test_without_a_refresh_the_retry_sends_the_same_candidates_as_before() -> None:
    """The ordinary path is unchanged: no caller means no re-read, same body each time."""
    sent: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content)["documents"])
        if len(sent) == 1:
            return httpx.Response(503, json={"error": {"message": "unavailable"}})
        return httpx.Response(200, json={"results": [_result(0)]})

    provider = _provider(handler, policy=RetryPolicy(attempts=2, attempt_timeout_seconds=5.0))
    candidates = _candidates(1)

    _run(provider.rerank("پرسش", candidates, top_n=1))

    assert len(sent) == 2
    assert sent[0] == sent[1]
    assert sent[0] == [candidate.text for candidate in candidates]


def test_a_refresh_that_empties_the_candidate_list_fails_closed_on_the_retry() -> None:
    """Every candidate revoked during the backoff must stop the request, not shrink it.

    Sending a shorter list than the response will be validated against would be worse
    than refusing: the count check would then compare against the wrong figure and the
    refusal would be silent.
    """
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(len(json.loads(request.content)["documents"]))
        return httpx.Response(503, json={"error": {"message": "unavailable"}})

    provider = _provider(handler, policy=RetryPolicy(attempts=2, attempt_timeout_seconds=5.0))
    batches = iter([_candidates(2), []])

    async def refresh() -> list[Any]:
        return next(batches)

    with pytest.raises(RerankResponseError, match="no candidate remained"):
        _run(provider.rerank("پرسش", _candidates(2), top_n=2, refresh=refresh))

    assert seen == [2], seen


@pytest.mark.parametrize("digits", [400, 500])
def test_a_huge_json_integer_score_is_refused_rather_than_overflowing(digits: int) -> None:
    """Review P2: ``float(10**400)`` raises OverflowError, not infinity.

    Left uncaught that is an untyped exception no caller classifies against, so it would
    reach the CLI as a traceback instead of a safe exit.
    """
    literal = "1" + "0" * digits

    def handler(request: httpx.Request) -> httpx.Response:
        body = (
            '{"results": [{"index": 0, "relevance_score": ' + literal + "},"
            ' {"index": 1, "relevance_score": 0.5}]}'
        )
        return httpx.Response(
            200, content=body.encode(), headers={"Content-Type": "application/json"}
        )

    with pytest.raises(RerankResponseError, match="out of range"):
        _run(_provider(handler).rerank("پرسش", _candidates(2), top_n=2))


def test_a_huge_integer_cost_is_reported_as_unknown_rather_than_raising() -> None:
    """Usage is metadata, so an unusable figure becomes unknown - which is already a
    state this adapter reports - rather than an exception."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = (
            '{"results": [{"index": 0, "relevance_score": 0.5}], "usage": {"cost": '
            + "1" * 400
            + "}}"
        )
        return httpx.Response(
            200, content=body.encode(), headers={"Content-Type": "application/json"}
        )

    provider = _provider(handler)
    scored = _run(provider.rerank("پرسش", _candidates(1), top_n=1))

    assert scored[0].score == 0.5, "the ranking still succeeded"
    assert provider.last_usage is not None
    assert provider.last_usage.cost is None


# --------------------------------------------------------------------------
# the second review: an index is a position in the list that was actually sent
# --------------------------------------------------------------------------


def test_a_result_is_mapped_against_the_list_that_was_sent_not_the_original() -> None:
    """Review finding: the mapping used the caller's original list.

    ``arun_with_retry`` calls the per-attempt factory, so a retry can send a different
    list. An ``index`` in the response still means a position in the list this attempt
    actually sent, so mapping it against the original candidates attaches a real score
    to the wrong chunk - here ``A`` scored a result that belonged to ``B``.
    """
    first = RerankCandidate(chunk_id=uuid.UUID(int=1), text="A")
    second = RerankCandidate(chunk_id=uuid.UUID(int=2), text="B")
    sent: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content)["documents"])
        return httpx.Response(200, json={"results": [_result(0, 0.9)]})

    async def refresh() -> list[RerankCandidate]:
        return [second, first]

    scored = _run(_provider(handler).rerank("پرسش", [first, second], top_n=1, refresh=refresh))

    assert sent == [["B", "A"]], sent
    assert [item.chunk_id for item in scored] == [second.chunk_id], (
        "the score was attached to the chunk that was never sent at that position"
    )


def test_a_retry_that_sends_fewer_documents_is_checked_against_what_it_sent() -> None:
    """The expected count follows the successful attempt, not the original request.

    After the 503 the refresh leaves one candidate, so that attempt sent one document
    and asked for one result. A provider answering with two results is reporting
    documents it was never given and must be refused; answering with one must map to
    the survivor, and the identifier that fell out must not appear anywhere.
    """
    first = RerankCandidate(chunk_id=uuid.UUID(int=1), text="A")
    second = RerankCandidate(chunk_id=uuid.UUID(int=2), text="B")
    attempts = 0
    sent: list[tuple[list[str], int]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        body = json.loads(request.content)
        sent.append((body["documents"], body["top_n"]))
        if attempts == 1:
            return httpx.Response(503, json={"error": {"message": "unavailable"}})
        return httpx.Response(200, json={"results": [_result(0, 0.9)]})

    batches = iter([[first, second], [second]])

    async def refresh() -> list[RerankCandidate]:
        return next(batches)

    policy = RetryPolicy(attempts=2, attempt_timeout_seconds=5.0)
    scored = _run(
        _provider(handler, policy=policy).rerank("پرسش", [first, second], top_n=2, refresh=refresh)
    )

    assert sent == [(["A", "B"], 2), (["B"], 1)], sent
    assert [item.chunk_id for item in scored] == [second.chunk_id], scored
    returned = {item.chunk_id for item in scored}
    assert first.chunk_id not in returned, "an identifier that was never sent came back"


def test_a_retry_that_sends_fewer_documents_rejects_an_oversized_answer() -> None:
    """The count guard is measured against the attempt, so this must not slip through.

    Two results for a one-document request is the shape a provider produces when it
    answers for the list it was given first. Under the old mapping the expected count
    was still two, so the answer was accepted and both positions were resolved against
    candidates that were never sent.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request is not None and len(sent) == 0:
            sent.append(1)
            return httpx.Response(503, json={"error": {"message": "unavailable"}})
        return httpx.Response(200, json={"results": [_result(0, 0.9), _result(1, 0.1)]})

    sent: list[int] = []
    only = _candidates(1)
    batches = iter([_candidates(2), only])

    async def refresh() -> list[RerankCandidate]:
        return next(batches)

    policy = RetryPolicy(attempts=2, attempt_timeout_seconds=5.0)

    with pytest.raises(RerankResponseError, match="returned 2 results for 1 requested"):
        _run(
            _provider(handler, policy=policy).rerank(
                "پرسش", _candidates(2), top_n=2, refresh=refresh
            )
        )
