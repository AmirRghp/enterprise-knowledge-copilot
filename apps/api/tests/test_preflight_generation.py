"""Tests for the structured generation preflight command.

The preflight is the thing an operator runs before trusting this endpoint, so what
matters is that it refuses rather than reports success loosely, and that its output is
safe to paste into a ticket.

The property under test throughout is that the command prints no question, no evidence
text and no model prose on any path. Generation sends both of the first two to a third
party by necessity, and the model's prose is a rendering of them; a preflight is
precisely the command whose output gets pasted into a ticket, so this is where they would
otherwise leak out again.

Every test drives a transport, so none needs a key, a network, or the corpus.
"""

import asyncio
import json
from collections.abc import Coroutine
from typing import Any

import httpx
import pytest

from app.cli import preflight_generation
from app.providers.generation import (
    GenerationProviderError,
    GenerationResponseError,
    build_generation_provider,
)
from app.settings import Settings
from tests.provider_fixtures import panel_settings


def _raw_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "db_name": "enterprise_knowledge_copilot_test",
        "openrouter_api_key": "k" * 32,
        "openrouter_model": "test/model",
    }
    values.update(overrides)
    return Settings(**values)


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    return asyncio.run(coroutine)


def _claims(**overrides: Any) -> str:
    payload: dict[str, Any] = {
        "claims": [
            {"evidence_id": "E1", "quote": "پانزده روز", "text": "مهلت پانزده روز است."},
        ],
        "abstained": False,
        "missing_parts": [],
        "answer": "مهلت ثبت درخواست پانزده روز است.",
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


def _transport(content: str, *, finish: str = "stop", status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            json={
                "id": "gen-test",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": finish,
                        "message": {"role": "assistant", "content": content},
                    }
                ],
                "usage": {
                    "prompt_tokens": 405,
                    "completion_tokens": 293,
                    "total_tokens": 698,
                    "cost": 0,
                },
            },
        )

    return httpx.MockTransport(handler)


@pytest.fixture(autouse=True)
def canned_provider(monkeypatch: Any) -> Any:
    """Point the preflight at a canned transport and the test settings.

    Patched at the transport rather than at ``run_preflight``, so the adapter's own
    construction - including its schema request and its response validation - is the real
    code rather than a stubbed-out return value.
    """
    holder: dict[str, Any] = {"transport": _transport(_claims())}

    def build(settings: Settings) -> Any:
        # The real ``_BuiltProvider``, so the fixture exercises the same ownership shape
        # production uses rather than a stub that hides it.
        client = httpx.AsyncClient(timeout=5.0, transport=holder["transport"])
        return preflight_generation._BuiltProvider(
            client,
            build_generation_provider(
                settings, client=client, policy=preflight_generation._PREFLIGHT_POLICY
            ),
        )

    monkeypatch.setattr(preflight_generation, "load_settings", _settings)
    monkeypatch.setattr(preflight_generation, "_build", build)
    return holder


# --------------------------------------------------------------------------
# a healthy answer
# --------------------------------------------------------------------------


def test_a_schema_shaped_answer_passes() -> None:
    report = _run(preflight_generation.run_preflight(_settings()))

    assert report["provider"] == "openrouter"
    assert report["model"] == "test/model"
    assert report["evidence_sent"] == 2
    assert report["claims_returned"] == 1
    assert report["cited_evidence_ids"] == ["E1"]
    assert report["contradictory"] is False
    assert report["quotes_not_verbatim"] == []
    assert report["abstained"] is False
    assert report["missing_parts"] == []
    assert report["answer_present"] is True
    assert report["verdict"] == preflight_generation.EXIT_OK


def test_the_two_samples_use_distinct_handles() -> None:
    """Two passages under one handle would make a citation ambiguous."""
    assert preflight_generation._SAMPLE_EVIDENCE == (
        ("E1", "در سیاست نمونهٔ نگهبانی، مهلت ثبت درخواست بازپرداخت پانزده روز است."),
        ("E2", "در سیاست نمونهٔ نگهبانی، سقف پرداخت مدیران پانصد میلیون ریال است."),
    )


def test_usage_is_reported_and_missing_figures_are_null() -> None:
    report = _run(preflight_generation.run_preflight(_settings()))

    usage = report["usage"]
    assert usage["reported"] is True
    assert usage["prompt_tokens"] == "405"
    assert usage["completion_tokens"] == "293"
    assert usage["total_tokens"] == "698"
    # A reported zero is kept: this model really is free.
    assert usage["cost"] == "0"
    # The published ChatUsage has no currency field, so none is invented.
    assert usage["currency"] is None
    for key in ("prompt_tokens", "completion_tokens", "total_tokens", "cost"):
        assert usage[key] is None or isinstance(usage[key], str), key


def test_a_provided_zero_cost_is_kept_rather_than_read_as_unknown(canned_provider: Any) -> None:
    """Zero is a measurement when the provider made it, and unknown when it did not."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": _claims()},
                    }
                ],
                "usage": {"prompt_tokens": 1, "cost": 0},
            },
        )

    canned_provider["transport"] = httpx.MockTransport(handler)
    report = _run(preflight_generation.run_preflight(_settings()))

    assert report["usage"]["cost"] == "0"
    assert report["usage"]["completion_tokens"] is None


# --------------------------------------------------------------------------
# what makes the preflight fail
# --------------------------------------------------------------------------


def test_a_claim_citing_an_unknown_handle_is_refused_by_the_adapter(canned_provider: Any) -> None:
    """A claim naming a passage that was never sent is the failure this exists to catch.

    Refused by the adapter rather than counted by this command, and deliberately so: the
    adapter is the layer that still knows which handles it sent, so checking here would
    duplicate a boundary guarantee in a place that cannot reach it. The first version of
    this command checked it here, and the test proved the check could never fire.
    """
    canned_provider["transport"] = _transport(
        _claims(claims=[{"evidence_id": "E9", "quote": "x", "text": "y"}])
    )

    with pytest.raises(GenerationResponseError, match="unknown evidence id"):
        _run(preflight_generation.run_preflight(_settings()))


def test_the_command_reports_that_refusal_as_a_schema_failure(
    canned_provider: Any, capsys: Any
) -> None:
    canned_provider["transport"] = _transport(
        _claims(claims=[{"evidence_id": "E9", "quote": "x", "text": "y"}])
    )

    code = preflight_generation.main([])

    captured = capsys.readouterr()
    assert code == preflight_generation.EXIT_RESPONSE
    lines = [line for line in captured.err.strip().splitlines() if line]
    assert lines[0] == preflight_generation.EXIT_MESSAGES[preflight_generation.EXIT_RESPONSE]
    assert all(line.startswith("usage: ") for line in lines[1:]), lines


def test_abstaining_and_answering_at_once_fails_the_run(canned_provider: Any) -> None:
    """A caller cannot honour both flags, so the model has not followed the contract."""
    canned_provider["transport"] = _transport(
        _claims(abstained=True, missing_parts=["insufficient_evidence"])
    )

    report = _run(preflight_generation.run_preflight(_settings()))

    assert report["contradictory"] is True
    assert report["verdict"] == preflight_generation.EXIT_RESPONSE


def test_prose_instead_of_the_schema_fails_the_run(canned_provider: Any) -> None:
    """An endpoint that dropped ``response_format`` answers in fluent text."""
    canned_provider["transport"] = _transport("مهلت ثبت درخواست پانزده روز است.")

    with pytest.raises(GenerationResponseError):
        _run(preflight_generation.run_preflight(_settings()))


def test_a_truncated_generation_fails_the_run(canned_provider: Any) -> None:
    canned_provider["transport"] = _transport("", finish="length")

    with pytest.raises(GenerationResponseError):
        _run(preflight_generation.run_preflight(_settings()))


def test_an_abstention_is_not_itself_a_failure(canned_provider: Any) -> None:
    """Abstaining is a correct answer when the evidence does not support one.

    A preflight that failed on it would be testing the model's judgement rather than
    the endpoint's support for the schema.
    """
    canned_provider["transport"] = _transport(
        _claims(claims=[], abstained=True, missing_parts=["insufficient_evidence"], answer="")
    )

    report = _run(preflight_generation.run_preflight(_settings()))

    assert report["abstained"] is True
    assert report["missing_parts"] == ["insufficient_evidence"]
    assert report["answer_present"] is False
    assert report["verdict"] == preflight_generation.EXIT_OK


def test_a_quote_that_is_not_verbatim_is_reported_without_failing(canned_provider: Any) -> None:
    """A paraphrase is the model's rendering, and Part 14 is what refuses it."""
    canned_provider["transport"] = _transport(
        _claims(
            claims=[{"evidence_id": "E1", "quote": "چهارده روز", "text": "مهلت چهارده روز است."}]
        )
    )

    report = _run(preflight_generation.run_preflight(_settings()))

    assert report["quotes_not_verbatim"] == ["E1"]
    # Still a pass: refusing a paraphrase is Part 14's job, not this command's.
    assert report["verdict"] == preflight_generation.EXIT_OK


# --------------------------------------------------------------------------
# nothing sensitive comes back out
# --------------------------------------------------------------------------


def test_the_report_carries_the_question_or_the_evidence_text(capsys: Any) -> None:
    report = _run(preflight_generation.run_preflight(_settings()))
    preflight_generation._print_text(report)
    printed = capsys.readouterr()

    assert preflight_generation._SAMPLE_QUESTION not in printed.out
    for _, text in preflight_generation._SAMPLE_EVIDENCE:
        assert text not in printed.out
    # Nor any part of the model's prose, which is a rendering of the evidence.
    assert "مهلت پانزده روز است" not in printed.out


def test_the_json_report_carries_no_text(capsys: Any, canned_provider: Any) -> None:
    report = _run(preflight_generation.run_preflight(_settings()))

    assert preflight_generation._SAMPLE_QUESTION not in json.dumps(report, ensure_ascii=False)
    for _, text in preflight_generation._SAMPLE_EVIDENCE:
        assert text not in json.dumps(report, ensure_ascii=False)


def test_nothing_in_a_printed_report_is_the_question_or_a_claim(capsys: Any) -> None:
    """Even the claim's ``text`` stays out: it is unvalidated model output."""
    report = _run(preflight_generation.run_preflight(_settings()))
    preflight_generation._print_text(report)
    printed = capsys.readouterr()

    assert "مهلت ثبت درخواست پانزده روز است." not in printed.out
    assert "پانزده روز" not in printed.out


def test_the_report_carries_no_chunk_identifier(capsys: Any) -> None:
    report = _run(preflight_generation.run_preflight(_settings()))
    preflight_generation._print_text(report)
    printed = capsys.readouterr()

    for forbidden in ("chunk", "document_id", "section_id", "revision"):
        assert forbidden not in printed.out


# --------------------------------------------------------------------------
# the command's exits
# --------------------------------------------------------------------------


def test_a_provider_error_is_not_swallowed(canned_provider: Any) -> None:
    canned_provider["transport"] = _transport("", status=401)

    with pytest.raises(GenerationProviderError):
        _run(preflight_generation.run_preflight(_settings()))


def test_the_command_exits_with_a_fixed_message_and_no_traceback(
    canned_provider: Any, capsys: Any
) -> None:
    """The provider's own message can quote the request, which is the evidence text."""
    canned_provider["transport"] = httpx.MockTransport(
        lambda request: httpx.Response(
            401, json={"error": {"code": 401, "message": "پیام حاوی متن سند"}}
        )
    )

    code = preflight_generation.main([])

    captured = capsys.readouterr()
    assert code == preflight_generation.EXIT_PROVIDER
    assert "Traceback" not in captured.err
    assert "پیام حاوی متن سند" not in captured.err
    assert "پیام حاوی متن سند" not in captured.out


def test_a_schema_violation_exits_with_the_schema_message(
    canned_provider: Any, capsys: Any
) -> None:
    canned_provider["transport"] = _transport("متن آزاد")

    code = preflight_generation.main([])

    captured = capsys.readouterr()
    assert code == preflight_generation.EXIT_RESPONSE
    lines = [line for line in captured.err.strip().splitlines() if line]
    assert lines[0] == preflight_generation.EXIT_MESSAGES[preflight_generation.EXIT_RESPONSE]
    assert all(line.startswith("usage: ") for line in lines[1:]), lines
    assert "متن آزاد" not in captured.err + captured.out


def test_a_missing_key_is_refused_before_any_request(monkeypatch: Any, capsys: Any) -> None:
    def must_not_build(settings: Settings) -> Any:
        raise AssertionError("no generator may be built without a key")

    monkeypatch.setattr(
        preflight_generation, "load_settings", lambda: _settings(openrouter_api_key="")
    )
    monkeypatch.setattr(preflight_generation, "_build", must_not_build)

    code = preflight_generation.main([])

    assert code == preflight_generation.EXIT_NO_KEY
    assert (
        preflight_generation.EXIT_MESSAGES[preflight_generation.EXIT_NO_KEY]
        in capsys.readouterr().err
    )


def test_the_command_closes_the_client_it_opened(monkeypatch: Any) -> None:
    """A client that outlives its adapter is never closed: the process exits first."""
    opened: list[httpx.AsyncClient] = []
    real_client = httpx.AsyncClient

    def make_client(**kwargs: Any) -> httpx.AsyncClient:
        client = real_client(**kwargs)
        opened.append(client)
        return client

    with pytest.MonkeyPatch.context() as inner:
        inner.setattr(preflight_generation.httpx, "AsyncClient", make_client)
        assert preflight_generation.main([]) == preflight_generation.EXIT_OK

    assert opened, "no client was opened, so nothing was checked"
    assert all(client.is_closed for client in opened), "a client was left open"


def test_the_verdict_travels_inside_the_report(capsys: Any) -> None:
    """A JSON reader should not have to re-implement the verdict to know the result."""
    assert preflight_generation.main(["--json"]) == preflight_generation.EXIT_OK

    report = json.loads(capsys.readouterr().out)
    assert report["verdict"] == preflight_generation.EXIT_OK


def test_a_failed_preflight_reports_what_it_cost(canned_provider: Any, capsys: Any) -> None:
    """The free endpoint allows fifty requests a day, so a failed run's cost matters most.

    Same reason as the report's failure path: the adapter keeps the figure, and without a
    line on stderr it left the process with the operator.
    """

    def always_bad(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "gen-test",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "متن آزاد"},
                    }
                ],
                "usage": {"prompt_tokens": 405, "completion_tokens": 12, "total_tokens": 417},
            },
        )

    canned_provider["transport"] = httpx.MockTransport(always_bad)

    code = preflight_generation.main([])

    captured = capsys.readouterr()
    assert code == preflight_generation.EXIT_RESPONSE
    lines = [line for line in captured.err.strip().splitlines() if line]
    assert lines[0] == preflight_generation.EXIT_MESSAGES[preflight_generation.EXIT_RESPONSE]
    assert len(lines) == 2, lines
    usage = lines[1]
    assert usage.startswith("usage: ")
    # Both attempts spent, summed rather than only the last one.
    assert "attempts=2" in usage
    assert "total=834" in usage, usage
    # And nothing that could carry a passage or the question.
    assert "متن آزاد" not in captured.err + captured.out
    assert "مهلت" not in captured.err + captured.out


def test_a_preflight_refusal_before_any_call_prints_no_usage_line(
    monkeypatch: Any, capsys: Any
) -> None:
    """A missing key stops before a provider exists, so there is nothing to report."""
    monkeypatch.setattr(
        preflight_generation, "load_settings", lambda: _settings(openrouter_api_key="")
    )

    code = preflight_generation.main([])

    captured = capsys.readouterr()
    assert code == preflight_generation.EXIT_NO_KEY
    assert "usage: " not in captured.err


def _settings(*args, **kwargs):
    return panel_settings(_raw_settings(*args, **kwargs))
