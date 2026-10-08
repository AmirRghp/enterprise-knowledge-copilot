"""Tests for the answer report command.

This is the surface a user reviews Part 14 through, so it carries two obligations that
pull in opposite directions and both have to hold.

*The review needs text.* ``plans.md`` asks for a documented answer sample and an
abstention sample, and neither can be judged from counts and handles - the whole question
is whether the served text is right. So ``--show-text`` prints the composed answer, the
citations and the validated quotes.

*Everything else must not.* Generation is the second stage that sends document text
outside the process, and the composed answer is that text re-rendered. Parts 11 to 13
established that no report prints any of it, precisely because a report's output ends up
in a ticket, a terminal scrollback and a bug report. So text is **off by default** and
reaching for it is a deliberate act by an operator who already knows the corpus is
synthetic.

The other obligation is that an invalid claim is never displayed. ``plans.md`` says so
directly. A report that printed a rejected claim's text would be showing a fabrication
next to real citations, and an operator comparing them would be reviewing a model
assertion while believing they were reviewing an answer.

Every provider call is routed to a canned transport and every database interaction goes
through ``_scenario``, so nothing reaches the network and a failure cannot leak a
connection.
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.answer.schemas import AnswerConfig
from app.cli import answer_report, run_worker
from app.settings import Settings, load_settings
from tests.test_retrieval import (
    EMPLOYEE_DOCUMENT,
    EMPLOYEE_TEXT,
    FakeProvider,
    _publish,
    _scenario,
)

ROOT = Path(__file__).resolve().parents[1]

QUESTION = "مهلت ثبت درخواست بازپرداخت سفر چند روز است؟"

#: A span that really occurs in ``EMPLOYEE_TEXT``, so validation accepts the claim.
GOOD_QUOTE = "درخواست باید ظرف ۱۵ روز ثبت شود"
CLAIM_TEXT = "درخواست بازپرداخت سفر باید ظرف ۱۵ روز ثبت شود."

#: Never shown, whether the generation is accepted or rejected.
MODEL_PROSE = "پاسخ آزاد مدل که هرگز نباید نمایش داده شود."
FABRICATED = "درخواست باید ظرف ۹۰ روز ثبت شود"


def _settings(key: str = "k" * 32) -> Settings:
    values = load_settings().model_dump()
    return load_settings().__class__(
        **{**values, "db_name": "enterprise_knowledge_copilot_test", "openrouter_api_key": key}
    )


def _arguments(login: str = "employee", **overrides: Any) -> Any:
    values: dict[str, Any] = {
        "login": login,
        "question": QUESTION,
        "json": False,
        "show_text": False,
    }
    values.update(overrides)
    return type("Args", (), values)()


def _payload(
    *,
    claims: list[dict[str, str]] | None = None,
    abstained: bool = False,
    missing_parts: list[str] | None = None,
) -> str:
    return json.dumps(
        {
            "claims": claims
            if claims is not None
            else [{"evidence_id": "E1", "quote": GOOD_QUOTE, "text": CLAIM_TEXT}],
            "abstained": abstained,
            "missing_parts": missing_parts or [],
            "answer": MODEL_PROSE,
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
                    "prompt_tokens": 1569,
                    "completion_tokens": 1157,
                    "total_tokens": 2726,
                    "cost": 0,
                },
            },
        )

    return httpx.MockTransport(handler)


#: Captured at import, because the autouse fixture below replaces
#: ``httpx.AsyncClient`` with a factory and a test that wants the real class - to subclass
#: it, or to reach it without recursing into the replacement - needs the original.
_REAL_CLIENT = httpx.AsyncClient


@pytest.fixture(autouse=True)
def canned_generation(monkeypatch: Any) -> Any:
    """Route every OpenRouter call to a canned transport and fake the embedding provider."""
    holder: dict[str, Any] = {"transport": _completion(_payload())}
    real_client = httpx.AsyncClient

    def make_client(**kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = holder["transport"]
        return real_client(**kwargs)

    monkeypatch.setattr(answer_report.httpx, "AsyncClient", make_client)
    # ``answer_report`` imports ``build_provider`` inside ``_report``, so it is a local
    # name there; patching the module attribute would raise AttributeError.
    monkeypatch.setattr(
        run_worker, "build_provider", lambda settings, *, attempt_timeout: FakeProvider()
    )
    return holder


async def _employee_document(factory: Any) -> None:
    await _publish(
        factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
    )


# --------------------------------------------------------------------------
# the default prints no text
# --------------------------------------------------------------------------


def test_the_default_report_prints_no_document_text(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        code = await answer_report._report(_arguments(), _settings())

        assert code == answer_report.EXIT_OK
        printed = capsys.readouterr().out + capsys.readouterr().err
        assert CLAIM_TEXT not in printed
        assert GOOD_QUOTE not in printed
        assert MODEL_PROSE not in printed
        # The document *id* is expected here: ``SourceRef.citation`` is already the
        # user-facing reference Part 15's API returns, so identifiers are safe without the
        # flag. It is the passage text that is not.

    _scenario(body)


def test_the_default_report_prints_counts_and_citations_only(capsys: Any) -> None:
    """Identifiers are safe: they are already the user-facing citation handle."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        await answer_report._report(_arguments(), _settings())

        printed = capsys.readouterr().out
        assert "claims validated:" in printed
        assert "abstained:" in printed
        assert EMPLOYEE_DOCUMENT in printed
        assert "sources:" in printed

    _scenario(body)


def test_the_default_report_prints_the_question_no_where(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        await answer_report._report(_arguments(), _settings())

        assert QUESTION not in capsys.readouterr().out

    _scenario(body)


def test_json_output_carries_no_text_by_default(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        await answer_report._report(_arguments(json=True), _settings())

        report = json.loads(capsys.readouterr().out)
        assert "claims" in report
        assert report["claims"][0] == {"evidence_id": "E1"}
        assert "text" not in json.dumps(report, ensure_ascii=False)
        assert GOOD_QUOTE not in json.dumps(report, ensure_ascii=False)

    _scenario(body)


# --------------------------------------------------------------------------
# --show-text: the review surface
# --------------------------------------------------------------------------


def test_show_text_prints_the_composed_answer_and_the_citation(capsys: Any) -> None:
    """The sample ``plans.md`` asks the user to review."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        code = await answer_report._report(_arguments(show_text=True), _settings())

        assert code == answer_report.EXIT_OK
        printed = capsys.readouterr().out
        assert CLAIM_TEXT in printed
        assert GOOD_QUOTE in printed
        assert EMPLOYEE_DOCUMENT in printed

    _scenario(body)


def test_show_text_never_prints_the_models_own_prose(capsys: Any) -> None:
    """The retained prose is for an operator reading the adapter, not the answer path."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        await answer_report._report(_arguments(show_text=True), _settings())

        assert MODEL_PROSE not in capsys.readouterr().out

    _scenario(body)


def test_show_text_prints_an_abstention_sample(canned_generation: Any, capsys: Any) -> None:
    from app.answer.compose import REFUSAL_BY_PART

    canned_generation["transport"] = _completion(
        _payload(claims=[], abstained=True, missing_parts=["insufficient_evidence"])
    )

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        code = await answer_report._report(_arguments(show_text=True), _settings())

        assert code == answer_report.EXIT_OK
        printed = capsys.readouterr().out
        assert REFUSAL_BY_PART["insufficient_evidence"] in printed
        assert "abstained: True" in printed

    _scenario(body)


# --------------------------------------------------------------------------
# an invalid generation is never displayed
# --------------------------------------------------------------------------


def test_a_fabricated_quote_exits_with_its_reason_and_shows_nothing(
    canned_generation: Any, capsys: Any
) -> None:
    canned_generation["transport"] = _completion(
        _payload(
            claims=[
                {"evidence_id": "E1", "quote": GOOD_QUOTE, "text": CLAIM_TEXT},
                {"evidence_id": "E1", "quote": FABRICATED, "text": FABRICATED},
            ]
        )
    )

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        code = await answer_report._report(_arguments(show_text=True), _settings())

        assert code == answer_report.EXIT_INVALID
        captured = capsys.readouterr()
        printed = captured.out + captured.err
        # The reason is visible...
        assert "quote_not_found" in printed
        assert "E1" in printed
        # ...and nothing about the generation's content is.
        assert FABRICATED not in printed
        assert CLAIM_TEXT not in printed
        assert GOOD_QUOTE not in printed
        assert MODEL_PROSE not in printed

    _scenario(body)


def test_an_invented_handle_is_never_reported_as_a_revocation(
    canned_generation: Any, capsys: Any
) -> None:
    """An invented citation must not be reported as an access change.

    The adapter rejects an unknown handle before the answer layer sees it - it is the one
    claim-level check that adapter can make, since only it knows which handles it sent. So
    the report exits as an unusable response rather than as ``evidence_revoked``, which is
    the property worth asserting: an operator must never be pointed at the access-control
    log for a citation the model made up.
    """
    canned_generation["transport"] = _completion(
        _payload(
            claims=[
                {"evidence_id": "E1", "quote": GOOD_QUOTE, "text": CLAIM_TEXT},
                {"evidence_id": "E9", "quote": GOOD_QUOTE, "text": CLAIM_TEXT},
            ]
        )
    )

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        code = await answer_report._report(_arguments(), _settings())

        assert code == answer_report.EXIT_UNUSABLE_RESPONSE
        err = capsys.readouterr().err
        assert "evidence_revoked" not in err
        assert "claims could not be validated" not in err
        # And the report does not claim the schema was ignored: the body was compliant.
        assert "did not honour the response schema" not in err

    _scenario(body)


def test_the_usage_of_a_rejected_generation_is_still_reported(
    canned_generation: Any, capsys: Any
) -> None:
    """Part 13's finding, carried to the surface: a billed attempt is billable."""
    canned_generation["transport"] = _completion(
        _payload(claims=[{"evidence_id": "E1", "quote": FABRICATED, "text": FABRICATED}])
    )

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        code = await answer_report._report(_arguments(), _settings())

        assert code == answer_report.EXIT_INVALID
        err = capsys.readouterr().err
        assert "usage: " in err
        assert "total=2726" in err
        assert FABRICATED not in err

    _scenario(body)


# --------------------------------------------------------------------------
# refusals and failures
# --------------------------------------------------------------------------


def test_no_hits_is_a_refusal_not_a_failed_report(capsys: Any) -> None:
    """Exits ``0``: refusing is one of this command's two outcomes.

    ``generation_report`` exits non-zero for no hits because it reports on an adapter, where
    nothing was produced. This reports on the answer path, where a safe refusal *is* the
    answer - so the run succeeded and says so through ``abstained``. A non-zero code would
    make a correct refusal read as a broken system to whatever runs this.
    """

    async def body(engine: Any, factory: Any) -> None:
        code = await answer_report._report(_arguments(show_text=True), _settings())

        assert code == answer_report.EXIT_OK
        captured = capsys.readouterr()
        printed = captured.out + captured.err
        assert "abstained: True" in printed
        assert "claims validated: 0" in printed
        # Nothing was sent, so there is no usage to report and no error to explain.
        assert "usage: not reported" in captured.out
        assert "usage: " not in captured.err
        assert QUESTION not in printed

    _scenario(body)


def test_a_provider_failure_exits_with_its_code_and_no_prose(
    canned_generation: Any, capsys: Any
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={
                "error": {
                    "code": 429,
                    "message": "Rate limit exceeded: free-models-per-day",
                    "metadata": {"limit_source": "openrouter_free_tier_daily"},
                }
            },
        )

    canned_generation["transport"] = httpx.MockTransport(handler)

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        code = await answer_report._report(_arguments(show_text=True), _settings())

        assert code == answer_report.EXIT_PROVIDER
        captured = capsys.readouterr()
        assert "daily free-tier quota" in captured.err
        assert "free-models-per-day" not in captured.err + captured.out
        assert "Traceback" not in captured.err

    _scenario(body)


def test_a_missing_key_stops_before_any_provider_work(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        code = await answer_report._report(_arguments(), _settings(key=""))

        assert code == answer_report.EXIT_NO_KEY
        captured = capsys.readouterr()
        assert "usage: " not in captured.err
        assert QUESTION not in captured.out + captured.err

    _scenario(body)


def test_the_report_never_reports_more_sources_than_it_asked_for(capsys: Any) -> None:
    """The cap is enforced by the service; the report must not imply it was exceeded."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        arguments = _arguments(show_text=True)
        arguments.config = AnswerConfig(max_sources=1)

        await answer_report._report(arguments, _settings())

        printed = capsys.readouterr().out
        sources_line = next(line for line in printed.splitlines() if line.startswith("sources:"))
        assert sources_line == "sources: 1"

    _scenario(body)


def test_the_module_runs_as_a_command() -> None:
    """The one thing an operator types, run as a real subprocess.

    Without the ``__main__`` guard this printed nothing and exited 0 - a command that
    silently does nothing - and the rest of the suite stayed green, because every other
    test here calls ``main`` or ``_report`` directly and never goes near the entry point.
    That is why this one is a subprocess: an in-process stand-in can be mocked into
    behaving like the entry point ran, which is the very thing that had gone missing.

    The key is emptied so the run stops at the missing-key check. What is under test is the
    wiring, not the provider, and a wired entry point should be provable for free.
    """
    completed = subprocess.run(
        [sys.executable, "-m", "app.cli.answer_report", "--question", "آزمون"],
        cwd=ROOT,
        env={**os.environ, "OPENROUTER_API_KEY": ""},
        capture_output=True,
        text=True,
        timeout=300,
    )

    assert completed.returncode == answer_report.EXIT_NO_KEY, (
        completed.returncode,
        completed.stdout,
        completed.stderr,
    )
    assert answer_report.EXIT_MESSAGES[answer_report.EXIT_NO_KEY] in completed.stderr
    # It reported, rather than exiting quietly.
    assert completed.stdout == "" and completed.stderr


def test_a_closed_client_is_not_left_behind(monkeypatch: Any) -> None:
    """A one-shot command exits first, so a client never closed is never closed at all."""
    closed: list[bool] = []

    class _TrackingClient(_REAL_CLIENT):
        async def aclose(self) -> None:
            closed.append(True)
            await super().aclose()

    def make_client(**kwargs: Any) -> Any:
        kwargs["transport"] = _completion(_payload())
        return _TrackingClient(**kwargs)

    monkeypatch.setattr(answer_report.httpx, "AsyncClient", make_client)

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        await answer_report._report(_arguments(), _settings())

    _scenario(body)
    assert closed == [True]
