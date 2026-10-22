"""Tests for the evaluation runner.

The runner is the surface an operator and a reviewer read a Part 18 result through, so it
carries the same two obligations the earlier reports do, pulling in opposite directions:

*The report must be complete and honest.* It has to record configuration, retrieval ranks,
behaviour, leakage, latency and consumption, break results down by category, and say plainly
when a figure was not measured. A section dropped for convenience produces a report that
reads like a clean run.

*It must not become a leak.* Document text, quotes and the served answer are withheld
unless ``--show-text`` is passed. A report's output ends up in terminals, tickets and bug
reports, and generation has already sent that text outside the process once.

Every provider call here is routed to a canned transport and every database interaction goes
through a scripted scenario, so nothing reaches the network and no quota is spent. The
*shape* of the report is exercised; whether the free model answers correctly is Part 18's
subject matter and is measured by running it, not asserted here.

The leakage test does not check that a field named ``answer`` is absent. It searches the
serialized artifact for real document sentences, because the field name is a promise and the
sentences are the fact.
"""

import asyncio
import contextlib
import io
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from app.cli import eval_run
from app.eval.sets import EvaluationSet
from tests.test_retrieval import _actor as account_actor

# --- Fixtures --------------------------------------------------------------------------


def _usage(
    reported=True,
    attempts=1,
    prompt="100",
    completion="50",
    cost=None,
    currency=None,
    asked=None,
):
    # `asked` defaults to `reported`: a sample that got figures was necessarily asked. The
    # two separate only when a request was sent and the provider answered without figures,
    # which is the case the coverage denominator exists for.
    return {
        "reported": reported,
        "provider_was_called": reported if asked is None else asked,
        "attempts": attempts,
        "prompt_tokens": prompt if reported else None,
        "completion_tokens": completion if reported else None,
        "total_tokens": (
            str(int(prompt) + int(completion)) if reported and prompt and completion else None
        ),
        "cost": cost,
        "currency": currency if currency is not None else ("USD" if cost is not None else None),
    }


def _record(sample_id="D01", category="direct", role="employee", expected="answer", **kwargs):
    defaults: dict[str, Any] = {
        "sample_id": sample_id,
        "category": category,
        "role": role,
        "expected_behavior": expected,
        "latency_ms": 120.0,
        "retrieval_measured": True,
        "retrieval_ranks": [
            {
                "position": 1,
                "document_id": "HR-001",
                "section_id": "HR-001-S1",
                "revision": "11111111-1111-4111-8111-111111111111",
                "fused_score": 0.03,
                "lexical_rank": 1,
                "vector_rank": 1,
                "rerank_score": None,
            }
        ],
        "cited": [
            {
                "document_id": "HR-001",
                "section_id": "HR-001-S1",
                "revision": "11111111-1111-4111-8111-111111111111",
            }
        ],
        "abstained": False,
        "missing_parts": [],
        "claims_validated": 1,
        "leak": None,
        "usage": _usage(),
        "error": None,
        "answer": None,
        "quotes": [],
    }
    defaults.update(kwargs)
    return eval_run.SampleRecord(**defaults)


def _source():
    """The shape `AnswerResult.sources` carries: ids plus the revision served."""

    class _Source:
        document_id = "HR-001"
        section_id = "HR-001-S1"
        revision = "r"

    return _Source()


def _claim(quote: str):
    """A validated claim: the quote and the source it was found in."""

    class _Claim:
        pass

    claim = _Claim()
    claim.quote = quote
    claim.source = _source()
    return claim


def _sample(sample_id="D01", category="direct", role="employee", expected="answer", **kwargs):
    base = {
        "id": sample_id,
        "category": category,
        "role": role,
        "question": f"سؤال {sample_id}",
        "expected_behavior": expected,
        "expected_answer": "پاسخ",
        "required_facts": [" fact"],
        "gold_sources": [{"document_id": "HR-001", "section_id": "HR-001-S1"}],
        "forbidden_document_ids": [],
    }
    base.update(kwargs)
    return base


class _Secret:
    """The shape `Settings.openrouter_api_key` has: a value read through `get_secret_value`."""

    def __init__(self, value: str):
        self._value = value

    def get_secret_value(self) -> str:
        return self._value


class _Settings:
    """The settings fields the artifact's configuration block and the run read.

    Every field the code under test touches is declared here rather than left to a default,
    so a new setting the runner reads shows up as a missing attribute in this fixture
    instead of silently taking whatever the class happened to inherit.
    """

    embedding_provider = "ollama"
    ollama_embed_model = "nomic-embed-text-v2-moe:latest"
    ollama_embed_digest = "ff9c2f10ef5e"
    embedding_dimension = 768
    openrouter_rerank_model = "nvidia/llama-nemotron-rerank-vl-2b:free"
    openrouter_api_key = _Secret("key")
    rerank_enabled = False
    generation_max_tokens = 4096
    generation_request_timeout = 30.0
    ingestion_lease_seconds = 120.0

    @property
    def _provider_runtime(self):
        from app.settings import Settings
        from tests.provider_fixtures import panel_settings

        configured = panel_settings(
            Settings(
                openrouter_api_key=self.openrouter_api_key.get_secret_value(),
                rerank_enabled=self.rerank_enabled,
            )
        )
        return configured._provider_runtime


class _Generator:
    provider_name = "openrouter"
    model = "dots-studio/dots-3-note-preview:free"


def _actor():
    """An actor of any kind: the allowlist is applied by the caller's real actor, and the
    fingerprint tests only care about what comes back from the rows."""
    from app.domain.models import Actor

    return Actor(
        user_id="00000000-0000-4000-8000-000000000000",
        role="employee",
        session_id="00000000-0000-4000-8000-000000000001",
    )


def _roles_of(samples, roles=None):
    """The roles this run resolved, which is what the corpus fingerprint is taken over.

    Empty on purpose when the caller does not say otherwise: the fingerprint is read
    through a session, and most of these tests are about the report's arithmetic rather
    than about the corpus. An empty map produces a ``by_role: {}`` provenance block rather
    than a digest invented by the test, and the tests that care about the fingerprint pass
    their own roles and their own session factory.
    """
    return dict(roles) if roles else {}


class _StubFactory:
    """A session factory whose sessions are never used by the stubbed collaborators.

    The corpus fingerprint *is* read through it in a real run; here it is never reached
    because the role map is empty, and the fingerprint is reported as unreadable rather
    than fabricated.
    """

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self

    async def __aenter__(self) -> Any:
        return object()

    async def __aexit__(self, *exc: Any) -> bool:
        return False


def _artifact(records, samples, stopped_early=None, leaks_from=None, roles=None, sessions=None):
    """Build an artifact from records and samples, with a real ``EvaluationSet`` behind it.

    The set is constructed rather than stubbed because ``_build_artifact`` reads its shape
    through ``summary()`` - a stand-in would let a change to the header pass unnoticed.

    ``leaks_from`` runs the real leak check against the recorded retrieval pairs and
    attaches the result to each record, which is what ``_run_sample`` does through
    ``_attach_leak``. Seeding ``leak`` by hand instead would let the leakage figure be
    tested without the check that produces it ever running.
    """
    if leaks_from is not None:
        from app.eval.metrics import check_leak

        records = [
            replace(
                record,
                leak=(
                    finding.as_dict()
                    if (
                        finding := check_leak(
                            leaks_from[str(record.sample_id)],
                            [_Hit(row) for row in record.retrieval_ranks],
                        )
                    )
                    is not None
                    else None
                ),
            )
            for record in records
        ]
    evaluation_set = EvaluationSet(
        name="standard",
        path=Path(__file__).resolve(),
        samples=tuple(samples),
        digest="sha256:" + "0" * 64,
    )
    arguments = eval_run._parser().parse_args(["--limit", str(len(samples))])
    return asyncio.run(
        eval_run._build_artifact(
            arguments,
            _Settings(),
            evaluation_set,
            samples,
            records,
            stopped_early,
            _Generator(),
            (sessions if sessions is not None else (lambda engine: _StubFactory()))(None),
            _roles_of(samples) if roles is None else roles,
        )
    )


class _Hit:
    """The minimum a recorded row needs to be re-checked for leakage."""

    def __init__(self, item):
        if isinstance(item, dict):
            document_id, section_id = item.get("document_id"), item.get("section_id")
        else:
            document_id, section_id = item[0], item[1]
        self.source = type("Source", (), {"document_id": document_id, "section_id": section_id})()


# --- Completeness of the report ------------------------------------------------------------


def test_the_artifact_records_every_section_the_guide_asks_for():
    artifact = _artifact([_record()], [_sample()])
    for key in (
        "run_id",
        "started_at",
        "set",
        "complete",
        "executed",
        "planned",
        "failed",
        "configuration",
        "figures",
        "usage",
        "limitations",
        "samples",
    ):
        assert key in artifact, f"{key} is missing from the report"
    figures = artifact["figures"]
    for key in ("retrieval", "behaviour", "leakage", "latency_ms"):
        assert key in figures, f"figures.{key} is missing"


def test_the_configuration_names_the_standard_the_run_measured():
    # Two runs are only comparable when these match, so the digest is in the report rather
    # than implied by the file that happens to be on disk today.
    artifact = _artifact([_record()], [_sample()])
    assert artifact["set"]["digest"].startswith("sha256:")
    assert artifact["configuration"]["embedding"]["model"] == "nomic-embed-text-v2-moe:latest"
    assert artifact["configuration"]["embedding"]["digest"] == "ff9c2f10ef5e"
    assert artifact["configuration"]["retrieval"]["final_top_k"] == 5


def test_results_are_broken_down_by_category_as_the_guide_asks():
    samples = [
        _sample("D1", category="direct"),
        _sample(
            "M1",
            category="multi_document",
            gold_sources=[
                {"document_id": "HR-001", "section_id": "HR-001-S1"},
                {"document_id": "HR-002", "section_id": "HR-002-S1"},
            ],
        ),
    ]
    records = [_record("D1", category="direct"), _record("M1", category="multi_document")]
    by_category = _artifact(records, samples)["figures"]["retrieval"]["recall_at_5"]["by_category"]
    assert set(by_category) == {"direct", "multi_document"}
    assert by_category["direct"]["mean"] == pytest.approx(1.0)
    # The multi-document sample only reached one of its two gold sections.
    assert by_category["multi_document"]["mean"] == pytest.approx(0.5)


def test_results_are_broken_down_by_role_as_well_as_by_category():
    # The two cuts answer different questions and a report carrying only one hides half of
    # what it measured. The role decides what may be retrieved at all, so a difference
    # between an employee's and a manager's recall is the first thing worth looking at.
    samples = [
        _sample("D1", role="employee"),
        _sample(
            "D2",
            role="manager",
            gold_sources=[{"document_id": "HR-009", "section_id": "HR-009-S1"}],
        ),
    ]
    records = [_record("D1", role="employee"), _record("D2", role="manager")]
    figures = _artifact(records, samples)["figures"]
    by_role = figures["retrieval"]["recall_at_5"]["by_role"]
    assert set(by_role) == {"employee", "manager"}
    assert by_role["employee"]["mean"] == pytest.approx(1.0)
    assert by_role["manager"]["mean"] == pytest.approx(0.0)
    # MRR and latency carry the same cut, or the reader has to guess which rows produced
    # which latency.
    assert set(figures["retrieval"]["mrr"]["by_role"]) == {"employee", "manager"}
    assert set(figures["latency_ms"]["by_role"]) == {"employee", "manager"}
    assert figures["latency_ms"]["by_role"]["employee"]["p50"] == pytest.approx(120.0)


def test_a_by_role_grouping_that_is_present_but_empty_is_not_a_grouping():
    # A key that exists and holds nothing satisfies a `in figures` assertion, so the test
    # above checks the contents rather than the key. This is the same failure in its
    # smallest form: the shape passes, the measurement is gone.
    samples = [_sample("D1", role="employee"), _sample("D2", role="manager")]
    records = [_record("D1", role="employee"), _record("D2", role="manager")]
    figures = _artifact(records, samples)["figures"]
    assert figures["retrieval"]["recall_at_5"]["by_role"]["employee"]["measured"] == 1
    assert figures["retrieval"]["mrr"]["by_role"]["manager"]["measured"] == 1
    assert figures["latency_ms"]["by_role"]["manager"]["p95"] == pytest.approx(120.0)


def test_each_row_carries_the_evaluation_metadata_a_rescore_needs():
    # The rows have to be re-scoreable by someone without the set file: the gold, the
    # facts and the forbidden ids are copied in, and the copy is compared, not just the
    # presence of a key.
    sample = _sample(
        "A1",
        category="access_security",
        forbidden_document_ids=["MGR-002", "MGR-003"],
        required_facts=["حق مرخصی", "مدت اعتبار"],
        gold_sources=[{"document_id": "HR-001", "section_id": "HR-001-S1"}],
    )
    row = _artifact([_record("A1", category="access_security")], [sample])["samples"][0]
    assert row["forbidden_document_ids"] == ["MGR-002", "MGR-003"]
    assert row["required_facts"] == ["حق مرخصی", "مدت اعتبار"]
    assert row["gold_sources"] == [["HR-001", "HR-001-S1"]]


def test_behaviour_counts_a_refusal_and_an_answer_separately():
    samples = [
        _sample("D1", expected="answer"),
        _sample("U1", category="unanswerable", expected="abstain", gold_sources=[]),
    ]
    records = [
        _record("D1", expected="answer", abstained=False),
        _record("U1", category="unanswerable", expected="abstain", abstained=True),
    ]
    behaviour = _artifact(records, samples)["figures"]["behaviour"]
    assert behaviour["checked"] == 2
    assert behaviour["answered_when_an_answer_was_expected"] == 1
    assert behaviour["abstained_when_a_refusal_was_expected"] == 1


def test_a_sample_that_errored_is_not_counted_as_behaviour():
    records = [_record(error="provider_error", abstained=None)]
    behaviour = _artifact(records, [_sample()])["figures"]["behaviour"]
    assert behaviour["checked"] == 0


# --- Honesty ------------------------------------------------------------------------------


def test_a_run_with_a_failed_sample_is_not_complete():
    artifact = _artifact([_record(error="provider_error")], [_sample()])
    assert artifact["complete"] is False
    assert artifact["failed"] == 1


def test_a_run_that_executed_everything_and_all_succeeded_is_complete():
    assert _artifact([_record()], [_sample()])["complete"] is True


def test_a_run_stopped_early_is_not_complete_and_says_why():
    artifact = _artifact(
        [_record()], [_sample()], stopped_early="three consecutive provider errors"
    )
    assert artifact["complete"] is False
    assert "three consecutive" in artifact["stopped_early_reason"]


def test_unreported_consumption_stays_unreported_rather_than_becoming_zero():
    usage = _artifact([_record(usage=_usage(reported=False))], [_sample()])["usage"]
    assert usage["provider_was_called"] is False
    # No figure claims anything was spent, and none claims a zero either.
    assert usage["cost_subtotal"] is None
    assert usage["cost_complete"] is False
    assert usage["currency"] is None
    assert "zero would be a claim" in usage["note"]


def test_a_known_cost_is_not_offered_as_the_run_total_when_another_is_unknown():
    # The finding this replaces: a known cost plus an unreported one summed to the known
    # figure and printed it as the run's total. A subtotal covers only the samples that
    # reported, and the flag says so.
    records = [
        _record(usage=_usage(attempts=1, prompt="100", completion="50", cost="0.2")),
        _record(sample_id="D02", usage=_usage(reported=True, prompt=None, completion=None)),
    ]
    usage = _artifact(records, [_sample(), _sample("D02")])["usage"]
    assert usage["cost_subtotal"] == "0.2"
    assert usage["cost_complete"] is False


def test_a_fully_reported_cost_is_the_total():
    records = [
        _record(usage=_usage(prompt="100", completion="50", cost="0.2")),
        _record(sample_id="D02", usage=_usage(prompt="80", completion="20", cost="0.1")),
    ]
    usage = _artifact(records, [_sample(), _sample("D02")])["usage"]
    assert usage["cost_complete"] is True
    assert usage["currency"] == "USD"


def test_a_token_subtotal_is_not_reported_as_the_run_total():
    # The cost flag and the token flag are separate claims, and a mutation that pins one
    # while the other rots passes the first test. This is the tokens half: one sample
    # reported them, one did not, so the sum is a subtotal.
    records = [
        _record(usage=_usage(prompt="100", completion="50")),
        _record(sample_id="D02", usage=_usage(reported=True, prompt=None, completion=None)),
    ]
    usage = _artifact(records, [_sample(), _sample("D02")])["usage"]
    assert usage["tokens_subtotal"] == 150
    assert usage["tokens_complete"] is False


def test_a_fully_reported_token_count_is_the_total():
    records = [
        _record(usage=_usage(prompt="100", completion="50")),
        _record(sample_id="D02", usage=_usage(prompt="80", completion="20")),
    ]
    usage = _artifact(records, [_sample(), _sample("D02")])["usage"]
    assert usage["tokens_subtotal"] == 250
    assert usage["tokens_complete"] is True


def test_the_summary_says_when_no_provider_request_was_made():
    # A zero in the cost column reads as "it was free"; "nothing was asked" is a different
    # claim and the only one that is true when the provider never ran.
    arguments = eval_run._parser().parse_args(["--limit", "1"])
    artifact = _artifact([_record(usage=_usage(reported=False))], [_sample()])
    printed = _captured(artifact, arguments)
    assert "no provider request was made" in printed
    assert "attempts=1" not in printed


def test_the_summary_names_a_subtotal_when_only_some_samples_reported():
    arguments = eval_run._parser().parse_args(["--limit", "2"])
    records = [
        _record(usage=_usage(prompt="100", completion="50", cost="0.2")),
        _record(sample_id="D02", usage=_usage(reported=True, prompt=None, cost=None)),
    ]
    printed = _captured(_artifact(records, [_sample(), _sample("D02")]), arguments)
    assert "subtotal_tokens=150" in printed
    # "subtotal_tokens" contains "total_tokens", so the label is compared as a word.
    assert " total_tokens=" not in printed


def test_two_currencies_are_not_added_together():
    records = [
        _record(usage=_usage(prompt="1", completion="1", cost="0.2")),
        _record(
            sample_id="D02", usage=_usage(prompt="1", completion="1", cost="9", currency="EUR")
        ),
    ]
    usage = _artifact(records, [_sample(), _sample("D02")])["usage"]
    # A sum of unlike units is not an amount of anything, so the figure is dropped.
    assert usage["mixed_currencies"] is True
    assert usage["cost_subtotal"] is None
    assert usage["currency"] is None


def test_consumption_sums_across_attempts_including_failed_ones():
    # A retry that was billed is still money spent. Counting only the successful attempt
    # understates the run, which is the whole reason usage is recorded per sample.
    records = [
        _record(usage=_usage(attempts=2, prompt="100", completion="50")),
        _record(sample_id="D02", usage=_usage(attempts=1, prompt="80", completion="20")),
    ]
    usage = _artifact(records, [_sample(), _sample("D02")])["usage"]
    assert usage["attempts"] == 3
    assert usage["tokens_subtotal"] == 250
    assert usage["tokens_complete"] is True


def test_a_failed_samples_consumption_is_not_dropped(tmp_path, monkeypatch):
    # The other half of the same claim, and the one the previous test left open: it sums
    # attempts across records it built by hand, so it never reached the boundary where a
    # sample *fails* after being billed. An attempt that failed after the provider answered
    # still cost money, and a run that reports its totals without it understates itself.
    import asyncio

    from app.cli.eval_run import _GenerationObserver
    from app.providers.base import ProviderUsage as _PU
    from app.providers.generation import GenerationProviderError
    from tests.test_eval_run_loop import (
        _Engine,
        _FakeHttpx,
        _Roles,
        _write_set,
    )
    from tests.test_eval_run_loop import (
        _sample as loop_sample,
    )

    class _Provider:
        """A provider that is reached, bills the sample, and then fails to answer.

        A real ``generate`` rather than a canned ``last_usage``: the runner now decides
        whether a sample reached the provider by watching that call, so a provider without
        one reads as "nothing was sent" and the totals come out empty.
        """

        provider_name = "stub"
        model = "stub"
        last_usage = None

        async def generate(self, **kwargs: Any) -> Any:
            self.last_usage = _PU(
                attempts=2,
                provider="stub",
                model="stub",
                billed_units={
                    "prompt_tokens": 100,
                    "completion_tokens": 50,
                    "total_tokens": 150,
                },
                cost=0.2,
                currency="USD",
            )
            raise GenerationProviderError("stub")

    class _WithUsage(_GenerationObserver):
        """The runner's own wrapper, with the recording provider inside it."""

        def __init__(self) -> None:
            super().__init__(_Provider())

    async def failing_answer(factory, *, generator=None, **kwargs):
        # Reaches the real provider, which bills and then fails. That is the case the claim
        # is about: an attempt that cost money before the answer was rejected. An `answer`
        # that simply raised would never generate, so there would be nothing to record.
        await generator.generate(question="q", evidence=[], refresh=None)
        raise AssertionError("the provider call above already failed the sample")

    monkeypatch.setattr(eval_run, "create_engine", lambda settings: _Engine())
    monkeypatch.setattr(eval_run, "create_session_factory", _session_factory_for_roles)
    monkeypatch.setattr(
        eval_run, "effective_prompt", lambda session: asyncio.sleep(0, "system prompt")
    )
    monkeypatch.setattr(eval_run, "_actor_for", _Roles())
    monkeypatch.setattr(eval_run, "retrieve", lambda *a, **k: asyncio.sleep(0, []))
    monkeypatch.setattr(eval_run, "answer", failing_answer)
    monkeypatch.setattr(eval_run, "build_generation_provider", lambda *a, **k: _WithUsage())
    _stub_run_worker_provider(monkeypatch)
    monkeypatch.setattr(eval_run, "httpx", _FakeHttpx())

    arguments = eval_run._parser().parse_args(
        [
            "--set",
            str(_write_set(tmp_path, [loop_sample("D1")])),
            "--out",
            str(tmp_path / "run.json"),
        ]
    )
    asyncio.run(eval_run._run(arguments, _Settings()))
    artifact = json.loads((tmp_path / "run.json").read_text(encoding="utf-8"))
    assert artifact["samples"][0]["error"] == "provider_error"
    # Two billed attempts, one sample that produced no answer at all.
    assert artifact["usage"]["attempts"] == 2
    assert artifact["usage"]["tokens_subtotal"] == 150
    assert artifact["usage"]["cost_subtotal"] == "0.2"


def _session_factory_for_roles(engine: Any) -> Any:
    """A factory whose sessions answer only the corpus fingerprint.

    The fingerprint is read after the loop, so a real run needs a session here; this one
    answers that query and nothing else, and says so rather than pretending to be a
    database.
    """

    class _Session:
        async def execute(self, statement: Any) -> Any:
            return _Rows()

        async def __aenter__(self) -> Any:
            return self

        async def __aexit__(self, *exc: Any) -> bool:
            return False

    class _Rows:
        def all(self) -> list[Any]:
            return []

    class _Factory:
        def __call__(self, *args: Any, **kwargs: Any) -> Any:
            return _Session()

    return _Factory()


def _stub_run_worker_provider(monkeypatch):
    """Replace the embedding provider where the runner imports it from at call time."""
    import app.cli.run_worker as worker

    monkeypatch.setattr(worker, "build_provider", lambda settings, **kw: object())


def test_latency_reports_p50_and_p95_and_says_when_nothing_was_measured():
    assert _artifact([_record()], [_sample()])["figures"]["latency_ms"]["p50"] == pytest.approx(
        120.0
    )
    empty = _artifact([], [])["figures"]["latency_ms"]
    assert empty["p50"] is None
    assert empty["measured"] == 0


def test_a_zero_leak_rate_is_a_rate_and_a_missing_one_is_not():
    samples = [_sample("A1", category="access_security", forbidden_document_ids=["MGR-002"])]
    clean = _artifact(
        [_record("A1", category="access_security")], samples, leaks_from={"A1": samples[0]}
    )
    # The leak check runs over what was recorded, so the fixture's own leak field is what
    # the figure is read from.
    assert clean["figures"]["leakage"]["observed_leak_rate"] == pytest.approx(0.0)
    assert clean["figures"]["leakage"]["confidential_samples"] == 1

    # No confidential sample ran: no rate at all, which is not the same as a clean one.
    nothing = _artifact([_record()], [_sample()], leaks_from={"D01": _sample()})["figures"][
        "leakage"
    ]
    assert nothing["confidential_samples"] == 0
    assert nothing["observed_leak_rate"] is None


def test_a_leak_is_reported_with_the_sample_id():
    samples = [_sample("A1", category="access_security", forbidden_document_ids=["MGR-002"])]
    leaked = _record(
        "A1",
        category="access_security",
        retrieval_ranks=[
            {
                "position": 1,
                "document_id": "MGR-002",
                "section_id": "MGR-002-S1",
                "revision": "r",
                "fused_score": 0.03,
                "lexical_rank": 1,
                "vector_rank": 1,
                "rerank_score": None,
            }
        ],
        leak={
            "sample_id": "A1",
            "leaked": True,
            "via": ["retrieval_results"],
            "leaked_retrieval_pairs": [["MGR-002", "MGR-002-S1"]],
            "leaked_citation_pairs": [],
        },
    )
    figures = _artifact([leaked], samples)["figures"]["leakage"]
    assert figures["leaked_samples"] == 1
    assert figures["findings"][0]["sample_id"] == "A1"


def test_the_limitations_say_what_the_numbers_are_not():
    limitations = _artifact([_record()], [_sample()])["limitations"]
    lowered = limitations.lower()
    assert "human review" in lowered
    assert "not a confidentiality guarantee" in lowered or "no leak was seen" in lowered
    assert "required_facts" in lowered


def test_a_row_whose_retrieval_never_ran_is_excluded_rather_than_scored_as_a_miss():
    # The review's first finding, downstream consequence: a retrieval that failed is not a
    # retrieval that found nothing. Scoring it as zero turns a dead embedding server into a
    # total retrieval failure - the opposite of what happened.
    errored = _record(error="retrieval_error:EmbeddingProviderError", retrieval_measured=False)
    figures = _artifact([errored], [_sample()])["figures"]["retrieval"]["recall_at_5"]
    assert figures["overall"] is None
    assert figures["by_category"]["direct"]["measured"] == 0
    assert figures["by_category"]["direct"]["excluded"] == 1

    # A row whose retrieval ran and then failed generation is a different case: retrieval
    # worked, so its recall is real and is measured.
    mixed = _artifact([_record(error="provider_error")], [_sample()])["figures"]["retrieval"][
        "recall_at_5"
    ]
    assert mixed["overall"] == pytest.approx(1.0)
    assert mixed["by_category"]["direct"]["measured"] == 1


# --- Document text must not escape ----------------------------------------------------------


def test_no_document_text_is_written_without_the_flag():
    # The record *has* text - a runner always does, because `AnswerResult` carries it - and
    # the flag is what withholds it. A fixture with `answer=None` would pass against a
    # runner that wrote every answer unconditionally, because there would be nothing to
    # write. That version of this test was the first one written and it was worthless.
    records = [_record(answer="پاسخ ترکیبی از متن سند", quotes=["نقل‌قولی از سند"])]
    artifact = _artifact(records, [_sample()])
    serialized = json.dumps(artifact, ensure_ascii=False)
    assert "پاسخ ترکیبی از متن سند" not in serialized
    assert "نقل‌قولی از سند" not in serialized
    assert artifact["show_text"] is False
    # The text was on the record the whole time; only its serialization was withheld.
    assert records[0].answer == "پاسخ ترکیبی از متن سند"


def test_the_flag_writes_the_text_the_reviewer_needs():
    # The other half of the obligation: a report that cannot show a human the served text
    # cannot have that human judge whether a citation supports its claim.
    artifact = _artifact_show_text(
        [
            _record(
                answer="پاسخ ترکیبی از متن سند",
                quotes=[
                    {
                        "quote": "نقل‌قولی از سند",
                        "document_id": "HR-001",
                        "section_id": "HR-001-S1",
                        "revision": "r",
                    }
                ],
            )
        ],
        [_sample()],
    )
    assert artifact["show_text"] is True
    assert artifact["samples"][0]["answer"] == "پاسخ ترکیبی از متن سند"
    # A quote without its source is not reviewable: the reviewer has to open that exact
    # section of that exact revision to judge whether it supports the claim. A bare list of
    # strings was the first shape here and it was exactly the thing that made the report
    # unusable for the job it exists for.
    quote = artifact["samples"][0]["quotes"][0]
    assert quote["quote"] == "نقل‌قولی از سند"
    assert quote["document_id"] == "HR-001"
    assert quote["section_id"] == "HR-001-S1"
    assert quote["revision"] == "r"


def test_the_flag_writes_the_real_quote_shape_the_runner_builds(monkeypatch):
    # The fixture above is hand-built, so it would pass against a runner that wrote
    # something else entirely. This one drives `_run_sample` with a real `AnswerResult` and
    # reads what the runner actually put on the record - the shape, not the promise.
    import asyncio

    from app.answer.schemas import AnswerResult
    from app.retrieval.contracts import RetrievalHit

    class _Chunk:
        document_id = "HR-001"
        section_id = "HR-001-S1"
        revision = "r"

    hit = RetrievalHit(chunk=_Chunk(), lexical_rank=1, vector_rank=1, fused_score=0.03)

    async def fake_retrieve(session, **kwargs):
        return [hit]

    async def fake_answer(factory, **kwargs):
        return AnswerResult(
            answer="پاسخ",
            claims=[_claim("نقل‌قولی از سند")],
            sources=[_source()],
            abstained=False,
            missing_parts=[],
            usage=None,
        )

    class _Generator:
        provider_name = "stub"
        model = "stub"
        last_usage = None

    monkeypatch.setattr(eval_run, "retrieve", fake_retrieve)
    monkeypatch.setattr(eval_run, "answer", fake_answer)

    class _Factory:
        """A session factory whose session neither collaborator uses."""

        def __call__(self) -> Any:
            return self

        async def __aenter__(self) -> Any:
            return object()

        async def __aexit__(self, *exc: Any) -> bool:
            return False

    record = asyncio.run(
        eval_run._run_sample(
            _Factory(),
            _actor(),
            _sample(),
            object(),
            _Generator(),
            True,
            retrieval_config=eval_run.effective_retrieval_config(_Settings()),
        )
    )
    # A quote without its source cannot be reviewed: the reviewer has to open that exact
    # section of that exact revision to judge whether it supports the claim. A bare list of
    # strings was the shape this part started with, and it made the report unusable for the
    # job it exists for.
    assert record.quotes[0] == {
        "quote": "نقل‌قولی از سند",
        "document_id": "HR-001",
        "section_id": "HR-001-S1",
        "revision": "r",
    }
    assert record.cited == [{"document_id": "HR-001", "section_id": "HR-001-S1", "revision": "r"}]


def test_the_usage_of_the_served_answer_wins_over_the_generators_last_reading(monkeypatch):
    # Two figures exist at the end of a successful sample: the one the adapter attached to
    # the answer that was served, and the generator's most recent reading. They are the same
    # when nothing odd happened, which is why the bug where the second overwrote the first
    # survived every test built around hand-made records: it needs a live sample where the
    # two disagree. Here they do - a repair attempt billed more than the served answer.
    import asyncio

    from app.answer.schemas import AnswerResult
    from app.providers.base import ProviderUsage
    from app.retrieval.contracts import RetrievalHit

    class _Chunk:
        document_id = "HR-001"
        section_id = "HR-001-S1"
        revision = "r"

    hit = RetrievalHit(chunk=_Chunk(), lexical_rank=1, vector_rank=1, fused_score=0.03)

    served = ProviderUsage(
        attempts=1,
        provider="stub",
        model="stub",
        billed_units={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
        cost=0.2,
        currency="USD",
    )
    later_reading = ProviderUsage(
        attempts=2,
        provider="stub",
        model="stub",
        billed_units={"prompt_tokens": 300, "completion_tokens": 90, "total_tokens": 390},
        cost=0.9,
        currency="USD",
    )

    class _Generator:
        """The provider the runner wraps: it must have a real ``generate`` or the runner
        reads "nothing was sent" and the sample's own figures never reach the record."""

        provider_name = "stub"
        model = "stub"
        last_usage = later_reading

        async def generate(self, **kwargs: Any) -> Any:
            raise AssertionError("this test stubs `answer`, which never calls generate")

    async def fake_retrieve(session, **kwargs):
        return [hit]

    async def answering(factory, *, generator=None, **kwargs):
        # The real provider call happens, so the run can tell this sample reached it; the
        # answer's own figure is what the record is expected to carry.
        generator.generations = getattr(generator, "generations", 0) + 1
        return AnswerResult(
            answer="پاسخ",
            claims=[],
            sources=[],
            abstained=False,
            missing_parts=[],
            usage=served,
        )

    class _Factory:
        def __call__(self) -> Any:
            return self

        async def __aenter__(self) -> Any:
            return object()

        async def __aexit__(self, *exc: Any) -> bool:
            return False

    monkeypatch.setattr(eval_run, "retrieve", fake_retrieve)
    monkeypatch.setattr(eval_run, "answer", answering)
    record = asyncio.run(
        eval_run._run_sample(
            _Factory(),
            _actor(),
            _sample(),
            object(),
            _Generator(),
            False,
            retrieval_config=eval_run.effective_retrieval_config(_Settings()),
        )
    )
    assert record.usage["total_tokens"] == "150"
    assert record.usage["attempts"] == 1


def test_a_quote_never_appears_without_its_source(monkeypatch):
    # A check on what the runner builds, not on one hard-coded shape: whatever the record
    # ends up holding, a quote without the section it came from fails here. The test above
    # compares an exact dictionary, which is a promise about one implementation; this one is
    # a promise about the report.
    import asyncio

    from app.answer.schemas import AnswerResult
    from app.retrieval.contracts import RetrievalHit

    class _Chunk:
        document_id = "HR-001"
        section_id = "HR-001-S1"
        revision = "r"

    hit = RetrievalHit(chunk=_Chunk(), lexical_rank=1, vector_rank=1, fused_score=0.03)

    async def fake_retrieve(session, **kwargs):
        return [hit]

    async def quoting_answer(factory, **kwargs):
        return AnswerResult(
            answer="پاسخ",
            claims=[_claim("نقل‌قولی از سند")],
            sources=[_source()],
            abstained=False,
            missing_parts=[],
            usage=None,
        )

    class _Generator:
        provider_name = "stub"
        model = "stub"
        last_usage = None

    monkeypatch.setattr(eval_run, "retrieve", fake_retrieve)
    monkeypatch.setattr(eval_run, "answer", quoting_answer)

    class _Factory:
        def __call__(self) -> Any:
            return self

        async def __aenter__(self) -> Any:
            return object()

        async def __aexit__(self, *exc: Any) -> bool:
            return False

    record = asyncio.run(
        eval_run._run_sample(
            _Factory(),
            _actor(),
            _sample(),
            object(),
            _Generator(),
            True,
            retrieval_config=eval_run.effective_retrieval_config(_Settings()),
        )
    )
    for quote in record.quotes:
        assert quote["document_id"], "a quote without a document id cannot be reviewed"
        assert quote["section_id"], "a quote without a section id cannot be reviewed"
        assert quote["revision"], "a quote without a revision cannot be reviewed after a replace"


def test_a_real_corpus_sentence_cannot_appear_in_a_report_without_the_flag():
    # The field name is a promise; this is the fact. Long real sentences are taken from the
    # repository corpus, so a report that started echoing passage text fails here rather
    # than in someone's terminal scrollback.
    corpus = Path(__file__).resolve().parents[3] / "corpus"
    documents = sorted(corpus.glob("*.md"))[:8]
    if not documents:
        # ``corpus/`` is deliberately outside the repository (``.gitignore``). The property
        # is still asserted wherever the real document text is on disk.
        pytest.skip("the corpus is not part of the checkout")
    sentences = []
    for path in documents:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if len(stripped) > 80 and not stripped.startswith("#"):
                sentences.append(stripped[:80])
                break
    assert sentences, "the corpus yielded no sentence to search for"

    records = [_record(answer=" ".join(sentences))]
    artifact = _artifact(records, [_sample()])
    serialized = json.dumps(artifact, ensure_ascii=False)
    for sentence in sentences:
        assert sentence not in serialized


def test_the_summary_states_that_show_text_was_used():
    arguments = eval_run._parser().parse_args(["--show-text", "--limit", "1"])
    artifact = _artifact_show_text([_record(answer="متن")], [_sample()])
    printed = _captured(artifact, arguments)
    assert "document text" in printed


def _artifact_show_text(records, samples):
    """The same artifact, built with the operator's ``--show-text`` flag set."""
    evaluation_set = EvaluationSet(
        name="standard",
        path=Path(__file__).resolve(),
        samples=tuple(samples),
        digest="sha256:" + "0" * 64,
    )
    arguments = eval_run._parser().parse_args(["--show-text", "--limit", str(len(samples))])
    return asyncio.run(
        eval_run._build_artifact(
            arguments,
            _Settings(),
            evaluation_set,
            samples,
            records,
            None,
            _Generator(),
            _StubFactory(),
            {},
        )
    )


# --- Selection and refusals -----------------------------------------------------------------


def test_a_filter_that_matches_nothing_yields_no_samples(tmp_path):
    # An operator who filters to a category this run does not contain should get a refusal
    # from the command, not an artifact that looks like a complete evaluation of nothing.
    from app.eval.sets import select

    evaluation_set = EvaluationSet(
        name="standard", path=tmp_path, samples=(_sample(),), digest="sha256:x"
    )
    assert select(evaluation_set, categories=["access_security"]) == []
    assert select(evaluation_set, categories=["direct"]) == [_sample()]


def test_the_summary_separates_a_measured_recall_from_an_excluded_one():
    # A recall of 1.0 beside a run where nothing was retrieved is the single most misleading
    # thing this report could show, and the note beside it is the only thing that prevents it.
    arguments = eval_run._parser().parse_args(["--limit", "1"])
    artifact = _artifact(
        [_record(error="retrieval_error:EmbeddingProviderError", retrieval_measured=False)],
        [_sample()],
    )
    printed = _captured(artifact, arguments)
    assert "excluded, not scored" in printed
    assert "1 sample(s) had no retrieval" in printed
    # The error reason is printed as a family, so an operator sees what failed.
    assert "retrieval_error=1" in printed


def test_a_clean_recall_carries_no_exclusion_note():
    arguments = eval_run._parser().parse_args(["--limit", "1"])
    printed = _captured(_artifact([_record()], [_sample()]), arguments)
    assert "had no retrieval" not in printed


def test_captured_summary_reports_incomplete_runs_first():
    arguments = eval_run._parser().parse_args(["--limit", "1"])
    artifact = _artifact([_record(error="provider_error")], [_sample()])
    printed = _captured(artifact, arguments)
    lines = [line for line in printed.splitlines() if line.strip()]
    # "complete" appears before any figure, so a partial run cannot be mistaken for a
    # finished one by reading the first few lines.
    complete_line = next(i for i, line in enumerate(lines) if line.startswith("complete:"))
    recall_line = next(i for i, line in enumerate(lines) if line.startswith("recall@"))
    assert complete_line < recall_line
    assert "complete: False" in printed


def _captured(artifact, arguments) -> str:
    """The summary as printed, without needing the runner to execute."""
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        eval_run._print_summary(artifact, arguments, Path("/tmp/artifact.json"))
    return buffer.getvalue()


# --- Coverage is measured against requests sent, not against replies received ------------


def test_an_asked_but_unreported_request_makes_every_figure_a_subtotal():
    # The review's fourth finding. A request that was sent and billed without a usage
    # reply used to leave the coverage denominator untouched, so a run with one unreported
    # request reported its known figure as the total.
    records = [
        _record(usage=_usage(prompt="8", completion="4", cost="0.2")),
        _record(sample_id="D02", usage=_usage(reported=False, asked=True)),
    ]
    usage = _artifact(records, [_sample(), _sample("D02")])["usage"]
    assert usage["samples_asked"] == 2
    assert usage["samples_reporting_usage"] == 1
    assert usage["samples_reporting_nothing"] == 1
    assert usage["tokens_complete"] is False
    assert usage["cost_complete"] is False
    # The subtotal is still there and still honest about being one.
    assert usage["tokens_subtotal"] == 12
    assert usage["cost_subtotal"] == "0.2"
    # The provider was called, which is not the same claim as "nothing was spent".
    assert usage["provider_was_called"] is True


def test_every_request_unreported_is_not_reported_as_a_complete_zero():
    records = [
        _record(usage=_usage(reported=False, asked=True)),
        _record(sample_id="D02", usage=_usage(reported=False, asked=True)),
    ]
    usage = _artifact(records, [_sample(), _sample("D02")])["usage"]
    assert usage["samples_asked"] == 2
    assert usage["tokens_complete"] is False
    assert usage["cost_complete"] is False
    assert usage["cost_subtotal"] is None


def test_a_run_that_asked_nothing_and_a_run_that_was_not_told_stay_distinct():
    # Two different causes, two different figures, and conflating them is how "it was free"
    # gets reported for a run that was actually billed.
    silent = _artifact([_record(usage=_usage(reported=False, asked=True))], [_sample()])["usage"]
    never_asked = _artifact([_record(usage=_usage(reported=False, asked=False))], [_sample()])[
        "usage"
    ]
    assert silent["provider_was_called"] is True
    assert silent["samples_asked"] == 1
    assert never_asked["provider_was_called"] is False
    assert never_asked["samples_asked"] == 0


def test_the_usage_scope_names_the_providers_it_does_not_cover():
    usage = _artifact([_record()], [_sample()])["usage"]
    # A token figure with no mention of the embedding server reads as the whole bill.
    assert "embedding" in usage["scope"]
    assert "embedding" in usage["other_providers"]
    assert "rerank" in usage["other_providers"]


# --- Every figure cut by role as well as category ---------------------------------------


def test_behaviour_is_cut_by_role_so_a_wrong_abstention_is_visible():
    # An employee abstaining where an answer was expected and a manager answering correctly
    # sum to a clean run-level number. That aggregate is exactly what a reader skims first.
    samples = [
        _sample("D1", role="employee", expected="answer"),
        _sample("D2", role="manager", expected="answer"),
    ]
    records = [
        _record("D1", role="employee", expected="answer", abstained=True),
        _record("D2", role="manager", expected="answer", abstained=False),
    ]
    figures = _artifact(records, samples)["figures"]["behaviour"]
    assert figures["by_role"]["employee"]["abstained"] == 1
    assert figures["by_role"]["employee"]["expected_answer"] == 1
    assert figures["by_role"]["manager"]["answered"] == 1
    assert figures["by_category"]["direct"]["abstained"] == 1
    # A group that never answered must not inherit another's counts.
    assert "samples" not in figures["by_role"]["employee"]


def test_execution_counts_are_cut_by_role_and_name_the_failures():
    samples = [_sample("D1", role="employee"), _sample("D2", role="manager")]
    records = [
        _record("D1", role="employee"),
        _record("D2", role="manager", error="provider_error", retrieval_measured=False),
    ]
    execution = _artifact(records, samples)["execution"]
    assert execution["by_role"]["employee"] == {"samples": 1, "retrieval_measured": 1}
    assert execution["by_role"]["manager"]["failed"] == 1
    assert execution["by_role"]["manager"].get("retrieval_measured") is None
    assert execution["by_category"]["direct"]["samples"] == 2


def test_leakage_is_cut_by_role():
    samples = [
        _sample(
            "A1", category="access_security", role="employee", forbidden_document_ids=["MGR-002"]
        ),
        _sample(
            "A2", category="access_security", role="manager", forbidden_document_ids=["MGR-002"]
        ),
    ]
    records = [
        _record("A1", category="access_security", role="employee"),
        _record("A2", category="access_security", role="manager"),
    ]
    figures = _artifact(
        records,
        samples,
        leaks_from={
            "A1": samples[0],
            "A2": samples[1],
        },
    )["figures"]["leakage"]
    assert figures["by_role"]["employee"]["confidential_samples"] == 1
    assert figures["by_role"]["manager"]["confidential_samples"] == 1
    assert figures["by_category"]["access_security"]["confidential_samples"] == 2


def test_consumption_coverage_is_cut_by_role():
    samples = [_sample("D1", role="employee"), _sample("D2", role="manager")]
    records = [
        _record("D1", role="employee"),
        _record("D2", role="manager", usage=_usage(reported=False, asked=True)),
    ]
    usage = _artifact(records, samples)["figures"]["consumption"]
    assert usage["by_role"]["employee"]["asked"] == 1
    assert usage["by_role"]["employee"]["reporting_usage"] == 1
    assert usage["by_role"]["manager"]["asked"] == 1
    assert usage["by_role"]["manager"].get("reporting_usage") is None
    assert usage["by_role"]["manager"].get("tokens_known") is None


# --- Provenance of the code and the corpus -------------------------------------------------


def test_the_code_digest_changes_when_a_measured_file_changes():
    before = eval_run.code_provenance()
    assert before["combined_sha256"].startswith("sha256:")
    assert before["schema_version"] == eval_run.ARTIFACT_SCHEMA_VERSION
    # Every file that decides what a number means is named, so "the digest differs" has a
    # diagnosis attached rather than being an opaque mismatch.
    assert "app/eval/metrics.py" in before["files"]
    assert "app/retrieval/service.py" in before["files"]
    assert "app/cli/eval_run.py" in before["files"]

    original = (eval_run.PROVENANCE_FILES[0], before["files"])
    del original
    tampered = dict(before)
    tampered["files"] = dict(before["files"])
    tampered["files"]["app/eval/metrics.py"] = "sha256:" + "0" * 16
    assert (
        eval_run._digest_of_text(
            "\n".join(f"{name}:{value}" for name, value in sorted(tampered["files"].items()))
        )
        != before["combined_sha256"]
    )


def test_the_code_digest_is_derived_from_the_files_it_names():
    # The version of this test that only asserted `startswith("sha256:")` accepted any
    # constant at all, including the placeholder the mutation writes. A digest that does not
    # move when its inputs move is a label, not a version.
    provenance = eval_run.code_provenance()
    recomputed = eval_run._digest_of_text(
        "\n".join(f"{name}:{value}" for name, value in sorted(provenance["files"].items()))
    )
    assert provenance["combined_sha256"] == recomputed

    # Changing any one named file's digest changes the combined one.
    for name in list(provenance["files"])[:3]:
        altered = dict(provenance["files"])
        altered[name] = "sha256:" + "0" * 16
        assert (
            eval_run._digest_of_text(
                "\n".join(f"{key}:{value}" for key, value in sorted(altered.items()))
            )
            != provenance["combined_sha256"]
        ), f"changing {name} did not move the combined digest"


def test_the_schema_version_is_recorded_on_the_artifact_itself():
    # Not only inside the code block: the top-level field is what a reader's tooling sees
    # first, and a header that omits it cannot be version-checked at a glance.
    artifact = _artifact([_record()], [_sample()])
    assert artifact["schema_version"] == eval_run.ARTIFACT_SCHEMA_VERSION


def test_the_corpus_block_reports_every_role_it_was_given(monkeypatch):
    # An empty map is the shape when no role was passed, which proves nothing about a run
    # that had two. The loop has to visit each one, and a slice would quietly report the
    # employee's domain under a heading that says "by role".
    #
    # The spy sits on the store, not on `_corpus_provenance`: patching the function under
    # test replaces the loop being measured, which is how this test stayed green while the
    # loop took only the first role.
    from app.retrieval.store import read_domain_fingerprint

    seen: list[str] = []

    async def spy(session, actor):
        seen.append(actor.role)
        return await read_domain_fingerprint(session, actor)

    # Patched where the runner looks it up. Patching the store module instead would miss,
    # because the runner binds the name at import time.
    monkeypatch.setattr(eval_run, "read_domain_fingerprint", spy)

    class _Rows:
        def all(self):
            return [
                type(
                    "R",
                    (),
                    {
                        "document_id": "HR-001",
                        "revision": "r1",
                        "section_id": "S1",
                    },
                )()
            ]

    class _Session:
        async def execute(self, statement):
            return _Rows()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    artifact = _artifact(
        [_record()],
        [_sample()],
        roles={"employee": account_actor("employee"), "manager": account_actor("manager")},
        sessions=lambda engine: _Session,
    )
    corpus = artifact["configuration"]["corpus"]
    assert set(corpus["by_role"]) == {"employee", "manager"}
    # Both roles visited, and in a stable order so two runs produce the same block.
    assert seen == ["employee", "manager"]
    # Each role gets its own entry, computed from its own domain rather than copied from
    # the other: a single figure reused under two headings would make a manager's run look
    # like it searched what an employee can search.
    assert corpus["by_role"]["employee"]["status"] == "ok"
    assert corpus["by_role"]["manager"]["status"] == "ok"
    assert corpus["by_role"]["employee"]["sha256"].startswith("sha256:")

    # The spy answers with the same rows for both roles here, so the digests match - what
    # this asserts is that both were *computed*, not that one was copied over the other.
    assert len(corpus["by_role"]) == 2


def test_each_roles_digest_comes_from_its_own_domain(monkeypatch):
    # The two roles see different corpora in this deployment, and the block has to say so.
    # Answering both queries with the same figure would report a manager's run as having
    # searched what an employee can search - the one thing the allowlist exists to prevent.
    from app.retrieval.store import read_domain_fingerprint

    domains = {
        "employee": [
            type(
                "R",
                (),
                {
                    "document_id": "HR-001",
                    "revision": "r1",
                    "section_id": "S1",
                },
            )()
        ],
        "manager": [
            type(
                "R",
                (),
                {
                    "document_id": "HR-001",
                    "revision": "r1",
                    "section_id": "S1",
                },
            )(),
            type(
                "R",
                (),
                {
                    "document_id": "MGR-002",
                    "revision": "r2",
                    "section_id": "S1",
                },
            )(),
        ],
    }

    async def spy(session, actor):
        class _Rows:
            def all(self):
                return domains[actor.role]

        class _S:
            async def execute(self, statement):
                return _Rows()

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

        return await read_domain_fingerprint(_S(), actor)

    monkeypatch.setattr(eval_run, "read_domain_fingerprint", spy)

    class _Session:
        async def execute(self, statement):
            raise AssertionError("the spy supplies its own session")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    artifact = _artifact(
        [_record()],
        [_sample()],
        roles={"employee": account_actor("employee"), "manager": account_actor("manager")},
        sessions=lambda engine: _Session,
    )
    corpus = artifact["configuration"]["corpus"]["by_role"]
    assert corpus["employee"]["documents"] == 1
    assert corpus["manager"]["documents"] == 2
    assert corpus["employee"]["sha256"] != corpus["manager"]["sha256"]
    # And nothing about the manager-only document leaks into what the employee's row says.
    assert corpus["employee"]["chunks"] == 1


def test_the_corpus_fingerprint_in_the_artifact_moves_with_the_domain(monkeypatch):
    # The digest written into the artifact has to be the domain's own, not a constant. Two
    # runs over different corpora are otherwise indistinguishable, which is the whole
    # reason the block exists.
    rows = [
        type("R", (), {"document_id": "HR-001", "revision": "r1", "section_id": "S1"})(),
    ]

    class _Rows:
        def all(self):
            return list(rows)

    class _Session:
        async def execute(self, statement):
            return _Rows()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    artifact = _artifact(
        [_record()],
        [_sample()],
        roles={"employee": account_actor("employee")},
        sessions=lambda engine: _Session,
    )
    first = artifact["configuration"]["corpus"]["by_role"]["employee"]["sha256"]

    import hashlib

    expected = hashlib.sha256(b"HR-001|r1|S1").hexdigest()
    assert first == eval_run._digest_of_text(expected)
    assert artifact["configuration"]["corpus"]["by_role"]["employee"]["documents"] == 1

    rows.append(type("R", (), {"document_id": "HR-009", "revision": "r9", "section_id": "S1"})())
    second = _artifact(
        [_record()],
        [_sample()],
        roles={"employee": account_actor("employee")},
        sessions=lambda engine: _Session,
    )["configuration"]["corpus"]["by_role"]["employee"]["sha256"]
    # A document that never reached the top five still moves the fingerprint, which is the
    # only reason this block exists.
    assert second != first


def test_the_code_digest_is_not_the_same_as_a_schema_version():
    # A schema version says what shape the file has; the digest says what it computes.
    provenance = eval_run.code_provenance()
    assert provenance["combined_sha256"] != f"sha256:{provenance['schema_version']:016d}"


def test_a_file_that_cannot_be_read_is_named_rather_than_silently_dropped(monkeypatch):
    # An unreadable file that quietly left the digest would make two different runs look
    # identical because the difference was not being measured.
    from pathlib import Path

    real_read = Path.read_text

    def failing(self, *args, **kwargs):
        if self.name == "metrics.py":
            raise OSError("gone")
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", failing)
    provenance = eval_run.code_provenance()
    assert "app/eval/metrics.py" in provenance["files_not_read"]
    assert "app/eval/metrics.py" not in provenance["files"]


def test_a_corpus_fingerprint_is_built_from_identity_alone():
    # The digest answers "was this the same corpus?" and must not become a document
    # manifest, which for an unauthorized actor would be a list of what exists.
    from app.retrieval.store import read_domain_fingerprint

    rows = [
        type("R", (), {"document_id": "HR-001", "revision": "r1", "section_id": "S1"})(),
        type("R", (), {"document_id": "HR-001", "revision": "r1", "section_id": "S2"})(),
        type("R", (), {"document_id": "HR-002", "revision": "r2", "section_id": "S1"})(),
    ]

    class _Rows:
        def all(self):
            return rows

    class _Session:
        async def execute(self, statement):
            return _Rows()

    import asyncio

    snapshot = asyncio.run(read_domain_fingerprint(_Session(), _actor()))
    assert snapshot["documents"] == 2
    assert snapshot["sections"] == 3
    assert snapshot["chunks"] == 3
    assert "HR-001" not in snapshot["fingerprint"]
    assert len(snapshot["fingerprint"]) == 64


def test_a_document_outside_the_results_still_changes_the_corpus_fingerprint():
    # The reason the fingerprint exists: a document that never reached the top five still
    # moves IDF and the ranks around it, so two runs whose evidence rows are identical can
    # still have searched different corpora.
    from app.retrieval.store import read_domain_fingerprint

    def fingerprint_for(rows):
        class _Rows:
            def all(self):
                return rows

        class _Session:
            async def execute(self, statement):
                return _Rows()

        import asyncio

        return asyncio.run(read_domain_fingerprint(_Session(), _actor()))["fingerprint"]

    def row(document_id, revision, section_id):
        return type(
            "R",
            (),
            {
                "document_id": document_id,
                "revision": revision,
                "section_id": section_id,
            },
        )()

    base = [row("HR-001", "r1", "S1")]
    same = [row("HR-001", "r1", "S1")]
    extra = [row("HR-001", "r1", "S1"), row("HR-009", "r9", "S1")]
    assert fingerprint_for(base) == fingerprint_for(same)
    assert fingerprint_for(base) != fingerprint_for(extra)


def test_a_replaced_document_changes_the_fingerprint():
    from app.retrieval.store import read_domain_fingerprint

    def fingerprint_for(rows):
        class _Rows:
            def all(self):
                return rows

        class _Session:
            async def execute(self, statement):
                return _Rows()

        import asyncio

        return asyncio.run(read_domain_fingerprint(_Session(), _actor()))["fingerprint"]

    def row(document_id, revision, section_id):
        return type(
            "R",
            (),
            {
                "document_id": document_id,
                "revision": revision,
                "section_id": section_id,
            },
        )()

    assert fingerprint_for([row("HR-001", "r1", "S1")]) != fingerprint_for(
        [row("HR-001", "r2", "S1")]
    )


def test_the_corpus_block_is_per_role_and_says_what_it_is_not():
    artifact = _artifact([_record()], [_sample()])
    corpus = artifact["configuration"]["corpus"]
    assert corpus["by_role"] == {}
    assert "not a document manifest" in corpus["note"]
    assert "no title, no text" in corpus["scope"]


# --- Only provider errors stop the run ----------------------------------------------------


def test_validation_errors_do_not_stop_a_run_under_a_provider_label():
    # Three unusable responses say the endpoint is answering and the schema is wrong. A
    # report that says "the endpoint refused the run" sends an operator to the wrong service.
    records = [_record(error="unusable_response") for _ in range(5)]
    samples = [_sample(f"D{n}") for n in range(1, 6)]
    artifact = _artifact(records, samples)
    assert artifact["errors_by_reason"] == {"unusable_response": 5}


def test_a_corpus_the_run_cannot_enumerate_is_reported_unreadable_not_fatal():
    # The fingerprint is read after every measurement is recorded. Letting a connection
    # error escape would discard the whole run - 40 measured samples - for a provenance
    # field, which is the exact failure the whole sample-boundary work was about.

    class _Broken:
        async def execute(self, statement):
            raise RuntimeError("db down")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    artifact = _artifact(
        [_record()],
        [_sample()],
        roles={"employee": account_actor("employee")},
        sessions=lambda engine: _Broken,
    )
    corpus = artifact["configuration"]["corpus"]["by_role"]["employee"]
    # The figures are still there; only the provenance says it could not be read.
    assert corpus["status"] == "unreadable"
    assert artifact["complete"] is True
    assert artifact["figures"]["retrieval"]["recall_at_5"]["overall"] == pytest.approx(1.0)
