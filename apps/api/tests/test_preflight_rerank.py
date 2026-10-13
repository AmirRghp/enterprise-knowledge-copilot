"""Tests for the rerank preflight command.

The preflight is the thing an operator runs before flipping ``RERANK_ENABLED`` on, so
what matters is that it refuses rather than reports success loosely. Its sample runs
against the real service, but these tests drive it with a transport so no test needs a
key, a network, or a corpus.

The property under test throughout is that the command prints no document text and no
question, on any path. Reranking sends both to a third party by necessity; the report
that an operator pastes into a ticket is where they would otherwise leak out again, and
a preflight is precisely the command whose output gets pasted into a ticket.
"""

import asyncio
import json
from collections.abc import Coroutine, Sequence
from typing import Any
from unittest import mock

import httpx
import pytest

from app.cli import preflight_rerank
from app.providers.rerank import RerankProviderError, RerankResponseError, build_rerank_provider
from app.settings import Settings
from tests.provider_fixtures import panel_settings

#: Captured before the autouse fixture patches ``_build``, so a test that is about the
#: builder itself can restore it.
_REAL_BUILD = preflight_rerank._build


def _raw_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "db_name": "enterprise_knowledge_copilot_test",
        "openrouter_api_key": "k" * 32,
        "openrouter_rerank_model": "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
    }
    values.update(overrides)
    return Settings(**values)


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    return asyncio.run(coroutine)


def _results(*pairs: tuple[int, float]) -> list[dict[str, Any]]:
    return [
        {"index": index, "relevance_score": score, "document": {"text": "echo"}}
        for index, score in pairs
    ]


def _transport(body: Any, status: int = 200) -> httpx.MockTransport:
    """A canned rerank answer, so no test reaches the network."""
    return httpx.MockTransport(lambda request: httpx.Response(status, json=body))


def _healthy(pairs: Sequence[tuple[int, float]] = ((1, 0.9), (0, 0.2))) -> dict[str, Any]:
    """The body a working provider returns for the two-sample request."""
    return {
        "results": [
            {
                "index": index,
                "relevance_score": score,
                "document": {"text": "echoed text the preflight ignores"},
            }
            for index, score in pairs
        ],
        "usage": {"total_tokens": 67, "cost": 0},
    }


@pytest.fixture(autouse=True)
def canned_provider(monkeypatch: Any) -> Any:
    """Point the preflight at a canned transport, and at the test database settings.

    Patched at the transport rather than at ``run_preflight``, so the adapter's own
    construction - including its API-key check and its response validation - is the real
    code rather than a stubbed-out return value.
    """
    transport_holder: dict[str, Any] = {"transport": _transport(_healthy())}

    def build(settings: Settings) -> Any:
        # The real ``_BuiltProvider``, so the fixture exercises the same ownership
        # shape production uses rather than a stub that hides it.
        client = httpx.AsyncClient(timeout=5.0, transport=transport_holder["transport"])
        return preflight_rerank._BuiltProvider(
            client,
            build_rerank_provider(
                settings, client=client, policy=preflight_rerank._PREFLIGHT_POLICY
            ),
        )

    monkeypatch.setattr(preflight_rerank, "load_settings", _settings)
    monkeypatch.setattr(preflight_rerank, "_build", build)
    return transport_holder


# --------------------------------------------------------------------------
# a healthy answer
# --------------------------------------------------------------------------


def test_a_well_formed_answer_passes_every_check() -> None:
    report = _run(preflight_rerank.run_preflight(_settings()))

    assert report["provider"] == "openrouter"
    assert report["model"] == "nvidia/llama-nemotron-rerank-vl-1b-v2:free"
    assert report["documents_sent"] == 2
    assert report["results_returned"] == 2
    assert report["index_mapping_ok"] is True
    assert report["scores_finite"] is True
    assert report["scores_descending"] is True
    assert report["verdict"] == preflight_rerank.EXIT_OK


def test_the_identifiers_returned_are_ones_that_were_sent() -> None:
    """The two halves cannot be checked in isolation, so they are checked together."""
    report = _run(preflight_rerank.run_preflight(_settings()))

    assert report["unknown_identifiers"] == 0
    assert report["duplicate_identifiers"] is False


def test_the_sample_actually_contrasts_so_a_pass_is_meaningful() -> None:
    """Two near-identical samples would let a broken model pass by luck."""
    assert len(preflight_rerank._SAMPLE_DOCUMENTS) == 2
    assert len(set(preflight_rerank._SAMPLE_DOCUMENTS)) == 2
    # One is about the deadline and one about the cap, so only one answers the question.
    assert "پانزده" in preflight_rerank._SAMPLE_DOCUMENTS[0]
    assert "پانزده" not in preflight_rerank._SAMPLE_DOCUMENTS[1]


# --------------------------------------------------------------------------
# what the preflight refuses
# --------------------------------------------------------------------------


def test_a_response_with_the_wrong_count_is_a_failure() -> None:
    report = _run(preflight_rerank.run_preflight(_settings()))

    assert report["results_returned"] == report["documents_sent"]


def test_an_index_outside_the_sample_is_reported_as_a_failure(canned_provider: Any) -> None:
    """A provider that answered for a document it never saw must not pass."""
    canned_provider["transport"] = _transport(_healthy([(0, 0.5), (7, 0.9)]))

    with pytest.raises(RerankResponseError, match="outside the request"):
        _run(preflight_rerank.run_preflight(_settings()))


def test_a_repeated_index_is_reported_as_a_failure(canned_provider: Any) -> None:
    canned_provider["transport"] = _transport(_healthy([(0, 0.5), (0, 0.9)]))

    with pytest.raises(RerankResponseError, match="repeated an index"):
        _run(preflight_rerank.run_preflight(_settings()))


def test_a_boolean_index_is_reported_as_a_failure(canned_provider: Any) -> None:
    canned_provider["transport"] = _transport(
        {"results": [{"index": True, "relevance_score": 0.9}, {"index": 1, "relevance_score": 0.5}]}
    )

    with pytest.raises(RerankResponseError, match="index was not an integer"):
        _run(preflight_rerank.run_preflight(_settings()))


def test_a_non_finite_score_is_reported_as_a_failure(canned_provider: Any) -> None:
    canned_provider["transport"] = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            content=b'{"results": [{"index": 0, "relevance_score": NaN},'
            b' {"index": 1, "relevance_score": 0.5}]}',
            headers={"Content-Type": "application/json"},
        )
    )

    with pytest.raises(RerankResponseError, match="not finite"):
        _run(preflight_rerank.run_preflight(_settings()))


def test_a_provider_error_is_not_swallowed(canned_provider: Any) -> None:
    canned_provider["transport"] = _transport({"error": {"message": "refused"}}, status=401)

    with pytest.raises(RerankProviderError):
        _run(preflight_rerank.run_preflight(_settings()))


# --------------------------------------------------------------------------
# the usage report
# --------------------------------------------------------------------------


def test_a_reported_usage_block_is_rendered() -> None:
    report = _run(preflight_rerank.run_preflight(_settings()))

    assert report["usage"]["reported"] is True
    assert report["usage"]["total_tokens"] == "67"
    assert report["usage"]["currency"] == "credits"
    # Every figure is a string or null; a fabricated number would claim knowledge.
    for key in ("search_units", "total_tokens", "cost"):
        value = report["usage"][key]
        assert value is None or isinstance(value, str), (key, value)


def test_a_missing_usage_block_is_unknown_not_zero() -> None:
    rendered = preflight_rerank._usage_report(None)

    assert rendered["reported"] is False
    assert rendered.get("total_tokens") is None
    assert rendered.get("cost") is None


def test_a_reported_zero_cost_is_kept_because_it_is_a_measurement() -> None:
    from decimal import Decimal

    from app.providers.base import ProviderUsage

    rendered = preflight_rerank._usage_report(
        ProviderUsage(
            provider="openrouter",
            model="m",
            billed_units={"total_tokens": 67},
            cost=Decimal("0"),
            currency="credits",
        )
    )

    assert rendered["cost"] == "0", "a real zero is not the same as an absent figure"
    assert rendered["total_tokens"] == "67"
    assert rendered["currency"] == "credits"


# --------------------------------------------------------------------------
# the output contract: no text, ever
# --------------------------------------------------------------------------


def test_nothing_in_the_report_is_the_question_or_a_document(capsys: Any) -> None:
    """The whole point of this command's output contract."""
    report = _run(preflight_rerank.run_preflight(_settings()))
    preflight_rerank._print_text(report)

    printed = capsys.readouterr().out

    assert preflight_rerank._SAMPLE_QUESTION not in printed
    for document in preflight_rerank._SAMPLE_DOCUMENTS:
        assert document not in printed
    for word in ("درخواست", "بازپرداخت", "پانزده", "پانصد"):
        assert word not in printed, word


def test_the_json_report_carries_no_text(capsys: Any) -> None:
    report = _run(preflight_rerank.run_preflight(_settings()))

    rendered = json.dumps(report, ensure_ascii=False)

    assert preflight_rerank._SAMPLE_QUESTION not in rendered
    for document in preflight_rerank._SAMPLE_DOCUMENTS:
        assert document not in rendered


def test_the_report_carries_no_chunk_identifier() -> None:
    """The sample chunks get synthetic ids; a real one would be an internal detail."""
    report = _run(preflight_rerank.run_preflight(_settings()))

    assert "chunk_ids" not in report
    assert "candidates" not in report


def test_the_module_never_logs_or_prints(capsys: Any) -> None:
    """The guarantee is structural: there is no logging call to add by accident."""
    import pathlib

    import app.cli.preflight_rerank as module

    source = pathlib.Path(module.__file__).read_text(encoding="utf-8")

    assert "import logging" not in source
    assert "logger" not in source


def test_the_printed_line_for_a_failure_is_fixed_not_the_providers() -> None:
    """A gateway may quote the request; the preflight must not pass that on."""
    assert preflight_rerank.EXIT_MESSAGES[preflight_rerank.EXIT_PROVIDER] == (
        "the rerank provider could not answer"
    )
    assert preflight_rerank.EXIT_MESSAGES[preflight_rerank.EXIT_RESPONSE] == (
        "the rerank provider answered with something unusable"
    )


# --------------------------------------------------------------------------
# the command line
# --------------------------------------------------------------------------


def test_without_a_key_the_preflight_refuses_before_any_request(monkeypatch: Any) -> None:
    """No reranker may be built and no request attempted without a key.

    ``_build`` is replaced with a stub that fails the test if it is called, so the
    refusal is proved to happen before the adapter exists rather than merely before the
    request is sent.
    """
    monkeypatch.setattr(preflight_rerank, "load_settings", lambda: _settings(openrouter_api_key=""))

    def must_not_build(settings: Settings) -> Any:
        raise AssertionError("no reranker may be built without a key")

    # A client that must never be created, since the adapter must not be built either.

    monkeypatch.setattr(preflight_rerank, "_build", must_not_build)

    assert preflight_rerank.main([]) == preflight_rerank.EXIT_NO_KEY


def test_an_empty_key_is_refused_rather_than_tried(capsys: Any, monkeypatch: Any) -> None:
    monkeypatch.setattr(preflight_rerank, "load_settings", lambda: _settings(openrouter_api_key=""))

    code = preflight_rerank.main([])

    assert code == preflight_rerank.EXIT_NO_KEY
    assert "manager panel" in capsys.readouterr().err


def test_a_bad_response_exits_with_the_response_code(capsys: Any, monkeypatch: Any) -> None:

    async def refusing(settings: Settings) -> dict[str, Any]:
        raise RerankResponseError("rerank response carried no results list")

    monkeypatch.setattr(preflight_rerank, "run_preflight", refusing)

    code = preflight_rerank.main([])

    assert code == preflight_rerank.EXIT_RESPONSE
    assert "unusable" in capsys.readouterr().err


def test_a_provider_failure_exits_with_the_provider_code(capsys: Any, monkeypatch: Any) -> None:

    async def refusing(settings: Settings) -> dict[str, Any]:
        raise RerankProviderError("refused: the question and the documents")

    monkeypatch.setattr(preflight_rerank, "run_preflight", refusing)

    code = preflight_rerank.main([])

    captured = capsys.readouterr()
    assert code == preflight_rerank.EXIT_PROVIDER
    assert "the question and the documents" not in captured.err
    assert "RerankProviderError" in captured.err


def test_an_unusable_verdict_exits_non_zero_despite_printing_a_report(
    capsys: Any, monkeypatch: Any
) -> None:
    """A report that reads as a success must not exit zero."""

    async def odd(settings: Settings) -> dict[str, Any]:
        return {
            "provider": "openrouter",
            "model": "m",
            "documents_sent": 2,
            "results_returned": 2,
            "index_mapping_ok": False,
            "unknown_identifiers": 1,
            "duplicate_identifiers": False,
            "scores_finite": True,
            "scores_descending": True,
            "scores_distinct": True,
            "verdict": preflight_rerank.EXIT_RESPONSE,
            "usage": {"reported": False, "search_units": None, "total_tokens": None, "cost": None},
        }

    monkeypatch.setattr(preflight_rerank, "run_preflight", odd)

    code = preflight_rerank.main(["--json"])

    assert code == preflight_rerank.EXIT_RESPONSE
    assert json.loads(capsys.readouterr().out)["index_mapping_ok"] is False


def test_the_parser_defaults_to_the_plain_text_form() -> None:
    assert preflight_rerank._parser().parse_args([]).json is False


# --------------------------------------------------------------------------
# the review findings: the CLI path for an overflowing score, and client lifetime
# --------------------------------------------------------------------------


def _huge_score_transport() -> httpx.MockTransport:
    """A score that cannot become a float: ``float(10**400)`` raises, not returns."""

    def handler(request: httpx.Request) -> httpx.Response:
        literal = "1" + "0" * 400
        body = (
            '{"results": [{"index": 1, "relevance_score": '
            + literal
            + '}, {"index": 0, "relevance_score": 0.2}], "usage": {"cost": '
            + literal
            + "}}"
        )
        return httpx.Response(
            200, content=body.encode(), headers={"Content-Type": "application/json"}
        )

    return httpx.MockTransport(handler)


def test_an_overflowing_score_exits_the_command_without_a_traceback(
    canned_provider: Any, capsys: Any
) -> None:
    """Review P2: an untyped ``OverflowError`` must not reach the command line.

    The command catches its own error types and prints a fixed message with a non-zero
    code. An exception it does not know would print a traceback instead, and the
    provider's own text can quote the request - which is the question and the document
    texts - so a traceback here is a leak as well as an ugly exit.
    """
    canned_provider["transport"] = _huge_score_transport()

    code = preflight_rerank.main([])

    captured = capsys.readouterr()
    assert code == preflight_rerank.EXIT_RESPONSE, code
    assert "Traceback" not in captured.err
    assert "OverflowError" not in captured.err
    # The fixed message only: nothing from the request, which is the question and the
    # two document texts.
    assert (
        captured.err.strip().splitlines()[-1]
        == preflight_rerank.EXIT_MESSAGES[preflight_rerank.EXIT_RESPONSE]
    ), captured.err
    usage = json.loads(captured.err.splitlines()[0].removeprefix("provider usage: "))
    assert usage["cost"] is None and usage["attempts"] == 1
    assert preflight_rerank._SAMPLE_QUESTION not in captured.out


def test_the_command_closes_the_client_it_opened(monkeypatch: Any) -> None:
    """Review P3: a client that outlives its adapter is never closed at all.

    The command exits right after the checks, so an unclosed client is not a slow leak
    but a guaranteed one: nothing in the process would ever close it.

    The real ``_build`` is restored first, because the fixture's replacement is where
    the client is created and closed - testing the fixture would prove only that the
    fixture is tidy. The transport is injected instead of the builder, so the only
    thing stubbed is the network.
    """
    opened: list[httpx.AsyncClient] = []
    # Captured before the patch: inside ``make_client`` the name ``httpx.AsyncClient``
    # already resolves to the replacement, so using it there would recurse.
    real_client = httpx.AsyncClient

    def make_client(**kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = _transport(_healthy())
        client = real_client(**kwargs)
        opened.append(client)
        return client

    monkeypatch.setattr(preflight_rerank, "_build", _REAL_BUILD)
    with mock.patch.object(preflight_rerank.httpx, "AsyncClient", make_client):
        assert preflight_rerank.main([]) == preflight_rerank.EXIT_OK

    assert opened, "no client was opened, so nothing was checked"
    assert all(client.is_closed for client in opened), "a client was left open"


def _settings(*args, **kwargs):
    return panel_settings(_raw_settings(*args, **kwargs))
