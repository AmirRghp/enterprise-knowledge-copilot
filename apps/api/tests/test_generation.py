"""Tests for the structured generation adapter.

Everything runs against ``httpx.MockTransport`` and an injected retry policy, so no
test reaches the network, no test waits on a real clock, and no test needs a key.

The negative cases are the point. A generator's job is turning an answer nobody controls
into claims the rest of the system will act on, and the ways that conversion goes
quietly wrong are mostly *not* "the JSON was malformed". They are the shapes a provider
produces when the call failed: a ``200`` whose body holds only an error, a truncated
generation, a content array because the endpoint ignored the schema, a boolean flag
answered with the number one. Each of those has a plausible-looking wrong reading, so
every one is asserted to raise *instead of* returning claims.

The traps are not invented. Each one is taken from the OpenRouter documentation this
adapter cites, and two of them - the ``200``-with-error body and the retryable
``error_type`` inside it - were confirmed against the live free endpoint while this was
being written, where roughly one call in eight returns ``502`` /
``provider_unavailable`` inside a ``200``.
"""

import asyncio
import json
from collections.abc import Coroutine
from decimal import Decimal
from typing import Any

import httpx
import pytest

from app.providers.base import ConversationSource, ConversationTurn, EvidenceItem
from app.providers.generation import (
    DAILY_QUOTA_REFUSAL,
    DEFAULT_GENERATION_POLICY,
    GENERATION_SCHEMA,
    RATE_LIMITED_REFUSAL,
    GenerationEvidenceError,
    GenerationProviderError,
    GenerationResponseError,
    OpenRouterGenerationProvider,
    build_generation_provider,
)
from app.providers.retry import RetryPolicy
from app.settings import Settings
from tests.provider_fixtures import panel_settings

MODEL = "dots-studio/dots-3-note-preview:free"
BASE_URL = "https://openrouter.test/api/v1"
API_KEY = "test-key-not-a-real-secret"

QUESTION = "مهلت ثبت درخواست بازپرداخت چند روز است؟"

EVIDENCE = (
    EvidenceItem(evidence_id="E1", text="مهلت ثبت درخواست بازپرداخت پانزده روز است."),
    EvidenceItem(evidence_id="E2", text="سقف پرداخت مدیران پانصد میلیون ریال است."),
)


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    return asyncio.run(coroutine)


def _object(**overrides: Any) -> dict[str, Any]:
    """A schema-shaped model answer, with fields overridden per test."""
    payload: dict[str, Any] = {
        "claims": [
            {"evidence_id": "E1", "quote": "پانزده روز", "text": "مهلت پانزده روز است."},
        ],
        "abstained": False,
        "missing_parts": [],
        "answer": "مهلت ثبت درخواست پانزده روز است.",
    }
    payload.update(overrides)
    return payload


def _completion(content: Any, *, finish: Any = "stop", status: int = 200) -> httpx.MockTransport:
    """A well-formed completion carrying ``content`` verbatim."""
    return httpx.MockTransport(
        lambda request: httpx.Response(
            status,
            json={
                "id": "gen-test",
                "object": "chat.completion",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": finish,
                        "message": {"role": "assistant", "content": content},
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            },
        )
    )


def _json_object(overrides: dict[str, Any] | None = None) -> str:
    return json.dumps(_object(**(overrides or {})), ensure_ascii=False)


def _provider(
    transport: httpx.MockTransport,
    *,
    policy: RetryPolicy | None = None,
    max_tokens: int | None = 1500,
) -> OpenRouterGenerationProvider:
    return OpenRouterGenerationProvider(
        httpx.AsyncClient(transport=transport),
        base_url=BASE_URL,
        model=MODEL,
        api_key=API_KEY,
        policy=policy,
        max_tokens=max_tokens,
    )


# --------------------------------------------------------------------------
# the answer path
# --------------------------------------------------------------------------


def test_a_schema_shaped_answer_becomes_a_result() -> None:
    result = _run(
        _provider(_completion(_json_object())).generate(question=QUESTION, evidence=EVIDENCE)
    )

    assert [(claim.evidence_id, claim.quote, claim.text) for claim in result.claims] == [
        ("E1", "پانزده روز", "مهلت پانزده روز است.")
    ]
    assert result.abstained is False
    assert result.missing_parts == []
    assert result.answer == "مهلت ثبت درخواست پانزده روز است."


def test_usage_is_recorded_and_absent_figures_stay_unknown() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": _json_object(),
                        },
                    }
                ],
                # No cost at all: the provider did not report one.
                "usage": {"prompt_tokens": 12, "completion_tokens": 7},
            },
        )
    )
    provider = _provider(transport)
    _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    usage = provider.last_usage
    assert usage is not None
    assert usage.input_tokens == 12
    assert usage.output_tokens == 7
    # A missing cost is unknown, not zero: zero reads as a claim about money.
    assert usage.cost is None
    # The published ChatUsage carries no currency, so none is invented.
    assert usage.currency is None


def test_an_empty_answer_string_becomes_none_rather_than_an_empty_string() -> None:
    """Empty prose is a real state, and it is not the same as prose the model chose."""

    result = _run(
        _provider(_completion(_json_object({"answer": ""}))).generate(
            question=QUESTION, evidence=EVIDENCE
        )
    )

    assert result.answer is None


def test_an_abstention_with_a_missing_part_is_accepted() -> None:
    result = _run(
        _provider(
            _completion(
                _json_object(
                    {"claims": [], "abstained": True, "missing_parts": ["insufficient_evidence"]}
                )
            )
        ).generate(question=QUESTION, evidence=EVIDENCE)
    )

    assert result.abstained is True
    assert result.missing_parts == ["insufficient_evidence"]
    assert result.claims == []


# --------------------------------------------------------------------------
# the request must make the schema a guarantee rather than a request
# --------------------------------------------------------------------------


def test_the_request_asks_for_a_strict_schema_and_requires_the_endpoint_to_support_it() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ]
            },
        )

    _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))

    schema = seen["response_format"]["json_schema"]
    assert seen["response_format"]["type"] == "json_schema"
    assert schema["strict"] is True
    assert schema["schema"] == dict(GENERATION_SCHEMA)
    # The setting that turns "we asked for a schema" into "the endpoint supports one".
    assert seen["provider"] == {"require_parameters": True}
    assert seen["stream"] is False
    assert seen["model"] == MODEL


def test_only_parameters_the_endpoint_must_support_are_sent() -> None:
    """``require_parameters`` disqualifies an endpoint that lacks any parameter sent.

    So the parameter list is a correctness concern rather than a style choice: every
    extra key is another way for a working endpoint to become unroutable.
    """
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ]
            },
        )

    _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))

    assert set(seen) == {"model", "messages", "response_format", "provider", "stream", "max_tokens"}


def test_the_max_token_ceiling_is_configurable_and_omitted_when_unset() -> None:
    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ]
            },
        )

    _run(
        _provider(httpx.MockTransport(handler), max_tokens=64).generate(
            question=QUESTION, evidence=EVIDENCE
        )
    )
    _run(
        _provider(httpx.MockTransport(handler), max_tokens=None).generate(
            question=QUESTION, evidence=EVIDENCE
        )
    )

    assert seen[0]["max_tokens"] == 64
    assert "max_tokens" not in seen[1]


def test_the_model_never_receives_a_document_identifier() -> None:
    """The model gets an opaque handle, so it cannot name a document it never saw."""
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ]
            },
        )

    _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))

    rendered = json.dumps(seen["messages"], ensure_ascii=False)
    assert "E1" in rendered and "E2" in rendered
    for forbidden in ("DOC-", "document_id", "section_id", "revision", "chunk"):
        assert forbidden not in rendered, forbidden


# --------------------------------------------------------------------------
# the shapes a failed call actually takes
# --------------------------------------------------------------------------


def test_a_200_carrying_only_an_error_is_refused_rather_than_reading_choices() -> None:
    """Documented: a non-streaming failure arrives as a 200 whose body is an error.

    Reading ``choices[0]`` first would raise an untyped ``IndexError`` on a provider
    failure, which no caller classifies against.
    """
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "id": "gen-1",
                "error": {"message": "provider disconnected", "code": 502},
            },
        )
    )

    with pytest.raises(GenerationProviderError):
        _run(_provider(transport).generate(question=QUESTION, evidence=EVIDENCE))


def test_a_retryable_error_type_inside_a_200_is_retried() -> None:
    """The live free endpoint returns this: 200, ``error.code`` 502, provider_unavailable.

    Classifying on the HTTP status alone would call it permanent and spend the whole
    request on the first blip, so the typed code is what decides.
    """
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(
                200,
                json={
                    "id": "gen-1",
                    "error": {
                        "message": "JSON error injected into SSE stream",
                        "code": 502,
                        "metadata": {"error_type": "provider_unavailable"},
                    },
                },
            )
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ]
            },
        )

    result = _run(
        _provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE)
    )

    assert len(result.claims) == 1
    assert len(calls) == 2, "the transient failure was not retried"


@pytest.mark.parametrize(
    "error_type",
    ["rate_limit_exceeded", "provider_overloaded", "provider_unavailable", "timeout"],
)
def test_every_documented_transient_type_is_retried(error_type: str) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(
                200,
                json={
                    "error": {
                        "message": "transient",
                        "code": 503,
                        "metadata": {"error_type": error_type},
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ]
            },
        )

    _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))

    assert len(calls) == 2, error_type


def test_a_permanent_error_type_inside_a_200_is_not_retried() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(
            200,
            json={
                "error": {
                    "message": "blocked",
                    "code": 403,
                    "metadata": {"error_type": "permission_denied"},
                }
            },
        )

    with pytest.raises(GenerationProviderError):
        _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))

    assert len(calls) == 1, "a permanent refusal spent the retry budget"


@pytest.mark.parametrize("finish", ["error", "content_filter", "tool_calls", None])
def test_a_finish_reason_that_is_not_stop_is_refused(finish: Any) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": finish,
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ]
            },
        )

    with pytest.raises(GenerationResponseError):
        _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))

    assert len(calls) == 1, "an unfinished generation was retried"


def test_a_truncated_generation_is_refused_and_not_retried() -> None:
    """Documented: a ``length`` finish is fixed by a larger token budget, not by asking again."""
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "length",
                        "message": {"role": "assistant", "content": ""},
                    }
                ]
            },
        )

    with pytest.raises(GenerationResponseError, match="token limit"):
        _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))

    assert len(calls) == 1, "a truncation was retried, spending money for the same result"


def test_an_empty_completion_is_refused_rather_than_parsed() -> None:
    """Documented shape of a cold start: 200, no content, nothing to read."""
    with pytest.raises(GenerationResponseError, match="no content"):
        _run(_provider(_completion("")).generate(question=QUESTION, evidence=EVIDENCE))


def test_content_as_an_array_means_the_endpoint_ignored_the_schema() -> None:
    """The schema promises a string; an array means ``response_format`` was dropped."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "متن آزاد"}],
                        },
                    }
                ]
            },
        )

    calls: list[int] = []

    def counting(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return handler(request)

    with pytest.raises(GenerationResponseError):
        _run(
            _provider(httpx.MockTransport(counting)).generate(question=QUESTION, evidence=EVIDENCE)
        )

    assert len(calls) == 2, "the repair was not attempted for a dropped schema"


def test_two_choices_are_refused_rather_than_picking_the_first() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    },
                    {
                        "index": 1,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    },
                ]
            },
        )
    )

    with pytest.raises(GenerationResponseError):
        _run(_provider(transport).generate(question=QUESTION, evidence=EVIDENCE))


# --------------------------------------------------------------------------
# the payload is checked against the schema, not merely parsed
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"claims": "many"}, "claims were not a list"),
        (
            {"claims": [{"evidence_id": "E1", "quote": "x", "text": 7}]},
            "claim text was not a string",
        ),
        (
            {"claims": [{"evidence_id": "E1", "quote": "x"}]},
            "claim text was not a string",
        ),
        (
            {"claims": [{"evidence_id": "E1", "text": "x"}]},
            "claim quote was not a string",
        ),
        (
            {"claims": [{"evidence_id": 1, "quote": "x", "text": "y"}]},
            "claim evidence_id was not a string",
        ),
        ({"claims": ["متن"]}, "claim was not an object"),
        (
            {"claims": [{"evidence_id": "E9", "quote": "x", "text": "y"}]},
            "unknown evidence id",
        ),
        ({"abstained": 1}, "abstained flag was not a boolean"),
        ({"abstained": "true"}, "abstained flag was not a boolean"),
        ({"missing_parts": "conflict"}, "missing_parts was not a list"),
        ({"missing_parts": ["because"]}, "unknown value"),
        ({"missing_parts": [3]}, "non-string value"),
        ({"answer": 12}, "answer was not a string"),
    ],
)
def test_an_answer_that_breaks_the_schema_is_refused_instead_of_returned(
    overrides: dict[str, Any], message: str
) -> None:
    with pytest.raises(GenerationResponseError, match=message):
        _run(
            _provider(_completion(_json_object(overrides))).generate(
                question=QUESTION, evidence=EVIDENCE
            )
        )


def test_a_claim_citing_an_unknown_evidence_handle_is_refused() -> None:
    """The one claim-level check the adapter can make.

    Whether the quote appears in the cited passage is a question about the corpus, and
    belongs to Part 14. But a handle that was never sent is the model inventing a
    citation, and that is knowable right here.
    """
    with pytest.raises(GenerationResponseError, match="unknown evidence id"):
        _run(
            _provider(
                _completion(
                    _json_object({"claims": [{"evidence_id": "E404", "quote": "x", "text": "y"}]})
                )
            ).generate(question=QUESTION, evidence=EVIDENCE)
        )


def test_a_json_body_that_is_not_an_object_is_refused() -> None:
    with pytest.raises(GenerationResponseError):
        _run(_provider(_completion("[1, 2, 3]")).generate(question=QUESTION, evidence=EVIDENCE))


# --------------------------------------------------------------------------
# the attempt budget: two attempts, shared by the retry and the one repair
# --------------------------------------------------------------------------


def test_a_repair_is_attempted_once_after_an_unusable_answer() -> None:
    messages: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        messages.append(len(json.loads(request.content)["messages"]))
        if len(messages) == 1:
            return _completion("متن آزاد بدون JSON").handle_request(request)
        return _completion(_json_object()).handle_request(request)

    result = _run(
        _provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE)
    )

    assert len(result.claims) == 1
    assert messages == [2, 3], "the repair did not add a turn"


def test_a_second_repair_is_not_attempted() -> None:
    """The repair shares the two-attempt budget, so it cannot double it."""
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return _completion("باز هم متن آزاد").handle_request(request)

    with pytest.raises(GenerationResponseError, match="not JSON"):
        _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))

    assert len(calls) == 2, "the repair budget was doubled"


def test_a_repair_message_does_not_quote_the_broken_answer_back() -> None:
    """Repeating the model's own bad output would only spend tokens on it."""
    broken = "متن آزادِ خیلی طولانی که نباید بازفرستاده شود"
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        for message in json.loads(request.content)["messages"]:
            seen.append(message["content"])
        if len(seen) <= 2:
            return _completion(broken).handle_request(request)
        return _completion(_json_object()).handle_request(request)

    _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))

    assert not any(broken in message for message in seen)


def test_a_transient_status_is_retried_within_the_same_budget() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(503, json={"error": {"code": 503, "message": "unavailable"}})
        return _completion(_json_object()).handle_request(request)

    result = _run(
        _provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE)
    )

    assert len(result.claims) == 1
    assert len(calls) == 2


@pytest.mark.parametrize("status", [401, 402, 403, 404, 413, 422, 500])
def test_a_permanent_status_is_not_retried(status: int) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(status, json={"error": {"code": status, "message": "no"}})

    with pytest.raises(GenerationProviderError):
        _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))

    assert len(calls) == 1, status


def test_an_exhausted_budget_fails_visibly_rather_than_returning_claims() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"error": {"code": 502, "message": "down"}})

    with pytest.raises(GenerationProviderError, match="within 2 attempts"):
        _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))


def test_an_unknown_exception_keeps_its_own_type() -> None:
    """No catch-all: an exception this code has never seen must keep its traceback.

    Reporting it as "the provider did not answer" would turn a future bug into a
    provider outage, which is exactly the silent degradation the project forbids.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("باگ ناشناخته")

    with pytest.raises(RuntimeError, match="باگ ناشناخته"):
        _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))


def test_an_attempt_that_overruns_its_deadline_becomes_a_retryable_failure() -> None:
    async def stall(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200, json={})

    policy = RetryPolicy(attempts=1, attempt_timeout_seconds=0.05)
    client = httpx.AsyncClient(transport=httpx.MockTransport(stall))
    provider = OpenRouterGenerationProvider(
        client, base_url=BASE_URL, model=MODEL, api_key=API_KEY, policy=policy
    )

    with pytest.raises(GenerationProviderError, match="within 1 attempts"):
        _run(provider.generate(question=QUESTION, evidence=EVIDENCE))


def test_a_transport_failure_becomes_a_retryable_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    with pytest.raises(GenerationProviderError, match="within 2 attempts"):
        _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))


def test_a_timeout_becomes_a_retryable_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    with pytest.raises(GenerationProviderError, match="within 2 attempts"):
        _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))


def test_a_body_that_is_not_json_is_refused_rather_than_crashing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"<html>gateway</html>", headers={"Content-Type": "text/html"}
        )

    with pytest.raises(GenerationResponseError):
        _run(_provider(httpx.MockTransport(handler)).generate(question=QUESTION, evidence=EVIDENCE))


def test_a_json_array_body_is_refused() -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=[1, 2, 3]))

    with pytest.raises(GenerationResponseError):
        _run(_provider(transport).generate(question=QUESTION, evidence=EVIDENCE))


# --------------------------------------------------------------------------
# usage figures
# --------------------------------------------------------------------------


def test_an_unusable_cost_is_reported_as_unknown_rather_than_raising() -> None:
    """Usage is metadata: a missing or unusable figure is a state already handled."""
    literal = "1" + "0" * 400
    body = json.dumps(
        {
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": _json_object()},
                }
            ],
            "usage": {"prompt_tokens": 3, "cost": literal},
        }
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=body.encode(), headers={"Content-Type": "application/json"}
        )

    provider = _provider(httpx.MockTransport(handler))
    result = _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    assert len(result.claims) == 1
    assert provider.last_usage is not None
    assert provider.last_usage.cost is None
    assert provider.last_usage.input_tokens == 3


def test_a_provider_reported_zero_cost_is_kept_rather_than_dropped() -> None:
    """Zero is a measurement when the provider made it, and unknown when it did not.

    Both states exist and they are not the same: this free model really does report a
    zero cost, and dropping that zero would lose a fact the provider stated. The
    neighbouring test covers the absent case, which must stay ``None``.
    """
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ],
                "usage": {"prompt_tokens": 405, "completion_tokens": 293, "cost": 0},
            },
        )
    )
    provider = _provider(transport)
    _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    usage = provider.last_usage
    assert usage is not None
    assert usage.cost is not None, "a reported zero was dropped as if it were absent"
    assert usage.cost == 0


def test_usage_is_absent_before_any_call_and_reported_after_one() -> None:
    provider = _provider(_completion(_json_object()))
    assert provider.last_usage is None

    _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    assert provider.last_usage is not None


# --------------------------------------------------------------------------
# input the adapter refuses before spending anything
# --------------------------------------------------------------------------


def test_an_empty_question_is_refused() -> None:
    with pytest.raises(ValueError, match="question must not be empty"):
        _run(_provider(_completion(_json_object())).generate(question="   ", evidence=EVIDENCE))


def test_no_evidence_is_refused() -> None:
    with pytest.raises(ValueError, match="at least one evidence"):
        _run(_provider(_completion(_json_object())).generate(question=QUESTION, evidence=[]))


def test_a_blank_evidence_handle_is_refused() -> None:
    evidence = (EvidenceItem(evidence_id="  ", text="متن"),)

    with pytest.raises(ValueError, match="must not be empty"):
        _run(_provider(_completion(_json_object())).generate(question=QUESTION, evidence=evidence))


def test_duplicate_evidence_handles_are_refused() -> None:
    """Two passages under one handle would make a citation ambiguous."""
    evidence = (
        EvidenceItem(evidence_id="E1", text="متن یک"),
        EvidenceItem(evidence_id="E1", text="متن دو"),
    )

    with pytest.raises(ValueError, match="unique"):
        _run(_provider(_completion(_json_object())).generate(question=QUESTION, evidence=evidence))


# --------------------------------------------------------------------------
# construction from settings
# --------------------------------------------------------------------------


def test_the_adapter_is_built_from_settings_rather_than_constants() -> None:
    settings = Settings(
        db_name="enterprise_knowledge_copilot_test",
        openrouter_api_key="k" * 32,
        openrouter_base_url="https://openrouter.test/api/v1",
        openrouter_model="some/other-model",
        generation_max_tokens=99,
    )
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200)))

    provider = build_generation_provider(panel_settings(settings), client=client)

    assert provider.model == "some/other-model"
    assert provider.provider_name == "openrouter"


def test_the_default_policy_matches_the_documented_generation_budget() -> None:
    """``technical-details.md`` subject 6: two attempts of thirty seconds each."""
    assert DEFAULT_GENERATION_POLICY.attempts == 2
    assert DEFAULT_GENERATION_POLICY.attempt_timeout_seconds == 30.0


def test_a_boolean_in_the_usage_block_is_not_counted_as_a_token_number() -> None:
    """``bool`` subclasses ``int``, so ``True`` would otherwise read as a token count.

    This is the direction where the subclassing actually bites: a usage block claiming
    ``"prompt_tokens": true`` would otherwise report one token.
    """
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ],
                "usage": {"prompt_tokens": True, "completion_tokens": 7, "total_tokens": True},
            },
        )
    )
    provider = _provider(transport)
    _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    usage = provider.last_usage
    assert usage is not None
    assert usage.input_tokens is None
    assert "prompt_tokens" not in (usage.billed_units or {})
    assert "total_tokens" not in (usage.billed_units or {})
    # A real number in the same block is still recorded.
    assert usage.output_tokens == 7


def test_a_boolean_cost_is_not_counted_as_a_price() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ],
                "usage": {"cost": True},
            },
        )
    )
    provider = _provider(transport)
    _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    assert provider.last_usage is not None
    assert provider.last_usage.cost is None, "a boolean was read as a price"


def test_repeated_reasons_are_collapsed_into_a_set() -> None:
    """``missing_parts`` is a set of reasons, and the model does repeat them.

    One real run returned ``insufficient_evidence`` four times, so keeping the duplicates
    would make a composed refusal state the same reason four times. Collapsing loses
    nothing, because the value was already present.
    """
    result = _run(
        _provider(
            _completion(
                _json_object(
                    {
                        "claims": [],
                        "abstained": True,
                        "missing_parts": [
                            "insufficient_evidence",
                            "insufficient_evidence",
                            "ambiguous",
                            "insufficient_evidence",
                        ],
                    }
                )
            )
        ).generate(question=QUESTION, evidence=EVIDENCE)
    )

    assert result.missing_parts == ["insufficient_evidence", "ambiguous"]


def test_the_default_token_ceiling_leaves_headroom_over_the_measured_worst() -> None:
    """Sized from measurement: five chunks of this model completed in 291-2118 tokens.

    A ceiling near the average truncated runs into ``finish_reason: "length"``, which the
    error reference says is fixed by raising the ceiling and not by retrying.
    """
    settings = Settings(db_name="enterprise_knowledge_copilot_test")

    assert settings.generation_max_tokens >= 2048


# --------------------------------------------------------------------------
# naming a refusal so an operator knows whether to wait
# --------------------------------------------------------------------------


def _refusal_transport(source: str | None, status: int = 429) -> httpx.MockTransport:
    """A rate-limited response carrying the documented ``limit_source`` metadata."""

    def handler(request: httpx.Request) -> httpx.Response:
        metadata: dict[str, Any] = {}
        if source is not None:
            metadata["limit_source"] = source
        return httpx.Response(
            status,
            json={
                "error": {
                    "code": status,
                    "message": "Rate limit exceeded: free-models-per-day",
                    "metadata": metadata,
                }
            },
        )

    return httpx.MockTransport(handler)


def test_an_exhausted_daily_quota_is_named_rather_than_reported_as_an_outage() -> None:
    """Measured: the free endpoint allows fifty requests a day and answers 429.

    An operator told only "the provider could not answer" goes looking for an outage. This
    is the one refusal of the three that is worth naming precisely.
    """
    provider = _provider(
        _refusal_transport("openrouter_free_tier_daily"),
        policy=RetryPolicy(attempts=1, attempt_timeout_seconds=5.0),
    )

    with pytest.raises(GenerationProviderError):
        _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    assert provider.last_refusal == DAILY_QUOTA_REFUSAL


def test_an_ordinary_rate_limit_is_named_separately_from_the_daily_quota() -> None:
    provider = _provider(
        _refusal_transport(None), policy=RetryPolicy(attempts=1, attempt_timeout_seconds=5.0)
    )

    with pytest.raises(GenerationProviderError):
        _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    assert provider.last_refusal == RATE_LIMITED_REFUSAL


def test_no_refusal_is_named_when_the_call_succeeds() -> None:
    provider = _provider(_completion(_json_object()))

    _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    assert provider.last_refusal is None


def test_the_refusal_is_cleared_by_a_later_successful_call() -> None:
    """A stale refusal would blame an outage for a request that has since worked."""
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return _refusal_transport("openrouter_free_tier_daily").handle_request(request)
        return _completion(_json_object()).handle_request(request)

    provider = _provider(httpx.MockTransport(handler))

    _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    assert len(calls) == 2
    assert provider.last_refusal is None


def test_a_non_rate_limited_failure_names_no_refusal() -> None:
    provider = _provider(
        _completion("{}", status=401), policy=RetryPolicy(attempts=1, attempt_timeout_seconds=5.0)
    )

    with pytest.raises(GenerationProviderError):
        _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    assert provider.last_refusal is None


# --------------------------------------------------------------------------
# the review: every attempt's usage, and the evidence gate before every send
# --------------------------------------------------------------------------


def test_usage_covers_every_attempt_including_the_unusable_one() -> None:
    """Review P2: an unusable answer was still generated and still billed.

    The first attempt answers with free text and reports usage A; the repair answers
    correctly and reports usage B. Recording only the success reported B and dropped the
    cost of a call that really happened.
    """
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        usage = (
            {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120, "cost": 0.5}
            if attempts == 1
            else {"prompt_tokens": 40, "completion_tokens": 8, "total_tokens": 48, "cost": 0.25}
        )
        content = "متن آزاد" if attempts == 1 else _json_object()
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": content},
                    }
                ],
                "usage": usage,
            },
        )

    provider = _provider(httpx.MockTransport(handler))
    _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    usage = provider.last_usage
    assert usage is not None
    assert attempts == 2
    assert usage.attempts == 2
    # The sum, not the last attempt's figures.
    assert usage.input_tokens == 140
    assert usage.output_tokens == 28
    billed = usage.billed_units or {}
    assert billed["prompt_tokens"] == 140
    assert billed["completion_tokens"] == 28
    assert billed["total_tokens"] == 168
    assert usage.cost == Decimal("0.75")


def test_usage_covers_attempts_that_failed_transiently() -> None:
    """A rate-limited attempt is billed too, even though it produced nothing."""
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(
                429,
                json={
                    "error": {
                        "code": 429,
                        "message": "slow down",
                        "metadata": {"limit_source": "openrouter_free_tier_daily"},
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _json_object()},
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
            },
        )

    provider = _provider(httpx.MockTransport(handler))
    _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    usage = provider.last_usage
    assert usage is not None
    # The 429 reported no usage, so the total is unknown rather than the success's alone.
    assert usage.attempts == 2
    assert usage.input_tokens is None
    assert "prompt_tokens" not in (usage.billed_units or {})


def test_usage_is_reported_even_when_every_attempt_fails() -> None:
    """The budget can be spent and still have cost the account something."""
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(
            200,
            json={
                "error": {
                    "code": 502,
                    "message": "down",
                    "metadata": {"error_type": "provider_unavailable"},
                },
                "usage": {"prompt_tokens": 9, "completion_tokens": 1, "total_tokens": 10},
            },
        )

    provider = _provider(httpx.MockTransport(handler))
    with pytest.raises(GenerationProviderError):
        _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    usage = provider.last_usage
    assert usage is not None
    assert usage.attempts == 2
    assert usage.input_tokens == 18


def test_the_user_turn_is_rebuilt_from_the_refreshed_evidence() -> None:
    """A refresh that changes the evidence must change what the request carries.

    The user turn is composed per attempt from that attempt's evidence. Composing it once
    would make the retry send the withdrawn passage's text while the mapping described
    only the surviving one - the two disagreeing in the direction that leaks.
    """
    bodies: list[dict[str, Any]] = []
    first, second = list(EVIDENCE)
    batches = iter([[first, second], [second]])

    async def refresh() -> list[EvidenceItem]:
        return next(batches)

    # The canned answer cites E2, the handle the *retry* actually sent. Citing E1 there
    # would be refused, because the handle check runs against the attempt's own list -
    # which is what the next test makes directly.
    retry_answer = _json_object({"claims": [{"evidence_id": "E2", "quote": "x", "text": "y"}]})

    def recording(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        if len(bodies) == 1:
            # Free text, so the attempt is repaired and the evidence refreshed.
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": "متن آزاد"},
                        }
                    ]
                },
            )
        return _completion(retry_answer).handle_request(request)

    provider = _provider(httpx.MockTransport(recording))
    result = _run(provider.generate(question=QUESTION, evidence=list(EVIDENCE), refresh=refresh))

    assert len(result.claims) == 1
    assert result.claims[0].evidence_id == "E2"
    assert len(bodies) == 2
    first_body = bodies[0]["messages"][1]["content"]
    second_body = bodies[1]["messages"][1]["content"]
    assert first.text in first_body
    assert first_body.count("<evidence id=") == 2
    # The withdrawn passage is gone from the retry, not merely absent from the mapping.
    assert first.text not in second_body
    assert second.text in second_body
    assert second_body.count("<evidence id=") == 1


def test_conversation_history_is_refreshed_before_each_retry() -> None:
    bodies: list[dict[str, Any]] = []
    source = ConversationSource("HR-001", "HR-001-S1", "00000000-0000-0000-0000-000000000001")
    old_turn = ConversationTurn("پرسش قبلی", "پاسخ قبلی", (source,))
    current_turn = ConversationTurn("پرسش قبلی", "پاسخی که هنوز مجاز است", (source,))
    batches = iter([[old_turn], [current_turn]])
    refresh_calls = 0

    async def refresh_history() -> list[ConversationTurn]:
        nonlocal refresh_calls
        refresh_calls += 1
        return next(batches)

    def recording(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        if len(bodies) == 1:
            return httpx.Response(
                200,
                json={"error": {"code": 502, "metadata": {"error_type": "provider_unavailable"}}},
            )
        return _completion(_json_object()).handle_request(request)

    result = _run(
        _provider(
            httpx.MockTransport(recording),
            policy=RetryPolicy(attempts=2, attempt_timeout_seconds=1, base_backoff_seconds=0),
        ).generate(
            question=QUESTION,
            evidence=EVIDENCE,
            history=[old_turn],
            refresh_history=refresh_history,
        )
    )

    assert result.answer == "مهلت ثبت درخواست پانزده روز است."
    assert refresh_calls == 2
    first_history = bodies[0]["messages"][1:3]
    second_history = bodies[1]["messages"][1:3]
    assert first_history == [
        {"role": "user", "content": "پرسش قبلی"},
        {"role": "assistant", "content": "پاسخ قبلی"},
    ]
    assert second_history == [
        {"role": "user", "content": "پرسش قبلی"},
        {"role": "assistant", "content": "پاسخی که هنوز مجاز است"},
    ]


def test_an_empty_refresh_on_the_first_attempt_never_reaches_the_provider() -> None:
    """Review regression: an empty first refresh must send nothing at all.

    The gate is read twice: once by the caller before calling ``generate``, and once by
    the adapter's per-attempt refresh. The second read is where a change lands in that
    window. Nothing has been sent at that point, so there is no answer and no schema
    anyone ignored.
    """
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return _completion(_json_object()).handle_request(request)

    async def refresh() -> list[EvidenceItem]:
        return []

    with pytest.raises(GenerationEvidenceError, match="no authorized evidence"):
        _run(
            _provider(httpx.MockTransport(handler)).generate(
                question=QUESTION, evidence=list(EVIDENCE), refresh=refresh
            )
        )

    assert calls == [], "a request went out with no evidence to put in it"


def test_an_empty_refresh_on_a_retry_sends_nothing_more_and_skips_the_repair() -> None:
    """Review regression: a transient answer, then an empty refresh on the retry.

    Only the first request may have happened, and no repair turn may be appended: a
    repair would ask the model again with evidence the caller may no longer send, so
    spending an attempt on it would reach the same refusal for nothing.
    """
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(503, json={"error": {"code": 503, "message": "unavailable"}})

    batches = iter([list(EVIDENCE), []])

    async def refresh() -> list[EvidenceItem]:
        return next(batches)

    with pytest.raises(GenerationEvidenceError):
        _run(
            _provider(httpx.MockTransport(handler)).generate(
                question=QUESTION, evidence=list(EVIDENCE), refresh=refresh
            )
        )

    assert len(bodies) == 1, bodies
    # Two messages: the system turn and the user turn carrying the evidence. A repair
    # would have made three.
    assert len(bodies[0]["messages"]) == 2
    assert bodies[0]["messages"][1]["content"].count("<evidence id=") == 2


def test_a_claim_citing_a_handle_the_refresh_dropped_is_refused() -> None:
    """The handles that may be cited are the ones this attempt actually sent."""
    content = _json_object({"claims": [{"evidence_id": "E1", "quote": "x", "text": "y"}]})

    async def refresh() -> list[EvidenceItem]:
        return [EVIDENCE[1]]

    with pytest.raises(GenerationResponseError, match="unknown evidence id"):
        _run(
            _provider(_completion(content)).generate(
                question=QUESTION, evidence=list(EVIDENCE), refresh=refresh
            )
        )


def test_usage_survives_an_evidence_lost_after_a_billed_response() -> None:
    """Review P3: the response was billed, so its usage is reported even though the call
    then failed for a reason that has nothing to do with the provider.

    A 503 carrying usage, then a refresh that finds nothing. The evidence error is the
    right exception, but the tokens behind the first response still happened and someone
    is being charged for them. This path never reached either of the two places the usage
    used to be finalized, so it was reported as nothing at all.
    """
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(
            503,
            json={
                "error": {"code": 503, "message": "unavailable"},
                "usage": {
                    "prompt_tokens": 9,
                    "completion_tokens": 1,
                    "total_tokens": 10,
                    "cost": 0.1,
                },
            },
        )

    batches = iter([list(EVIDENCE), []])

    async def refresh() -> list[EvidenceItem]:
        return next(batches)

    provider = _provider(httpx.MockTransport(handler))
    with pytest.raises(GenerationEvidenceError):
        _run(provider.generate(question=QUESTION, evidence=list(EVIDENCE), refresh=refresh))

    # The error still stands and nothing extra was sent.
    assert len(calls) == 1, calls
    usage = provider.last_usage
    assert usage is not None, "a billed response was reported as costing nothing"
    assert usage.attempts == 1
    assert usage.input_tokens == 9
    assert usage.output_tokens == 1
    billed = usage.billed_units or {}
    assert billed["total_tokens"] == 10
    assert usage.cost == Decimal("0.1")


def test_usage_survives_a_permanent_refusal_that_carries_it() -> None:
    """The same reasoning on a path nobody has reported yet.

    A rejected request can carry a usage block, and it raises straight out of the loop
    without reaching either of the places the usage used to be finalized. Finalizing in a
    ``finally`` covers it without anyone having to remember to add a line per exit.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={
                "error": {"code": 403, "message": "blocked"},
                "usage": {"prompt_tokens": 4, "completion_tokens": 0, "total_tokens": 4},
            },
        )

    provider = _provider(httpx.MockTransport(handler))
    with pytest.raises(GenerationProviderError):
        _run(provider.generate(question=QUESTION, evidence=EVIDENCE))

    usage = provider.last_usage
    assert usage is not None
    assert usage.attempts == 1
    assert usage.input_tokens == 4


def test_usage_is_absent_when_the_call_was_refused_before_any_request() -> None:
    """A refusal that never reached the provider has nothing to attribute a cost to."""
    provider = _provider(_completion(_json_object()))

    with pytest.raises(ValueError):
        _run(provider.generate(question="   ", evidence=EVIDENCE))

    assert provider.last_usage is None
