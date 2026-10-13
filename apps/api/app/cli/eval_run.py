"""Operator CLI: run the fixed evaluation set and record what happened.

Three obligations pull against each other here, and all three have to hold.

*The report has to be complete.* The guide asks for retrieval, answer behaviour, leakage,
latency and consumption, broken down by category and role, with the configuration recorded
so a later reader knows what was measured. Omitting a section because it was inconvenient
would produce a report that reads like a clean run.

*The report must not become a leak.* Generation sends document text outside the process and
the composed answer is that text re-rendered, and Parts 11 to 14 established that no report
prints any of it - a report's output ends up in terminals, tickets and bug reports. So
document text, quotes and the served answer are withheld unless ``--show-text`` is passed
by an operator who knows this deployment's corpus is synthetic. What is always recorded is
identifiers, ranks, scores, counts and flags.

*Every figure must be honest about what it is.* An unreported consumption is ``None``, not
zero: a zero cost is a claim that the provider charged nothing, which nobody established.
Recall of zero and a sample that was never measured are different facts and never share a
column. A run cut short by the provider's quota is marked incomplete rather than presented
as a finished evaluation.

Usage::

    uv run --locked python -m app.cli.eval_run --out eval/runs/<run_id>.json
    uv run --locked python -m app.cli.eval_run --limit 8
    uv run --locked python -m app.cli.eval_run --category access_security --role employee
    uv run --locked python -m app.cli.eval_run --show-text          # prints document text
    uv run --locked python -m app.cli.eval_run --dev eval/dev.jsonl
"""

import argparse
import asyncio
import hashlib
import json
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final
from uuid import uuid4

import httpx

from app.answer.schemas import AnswerConfig, InvalidGeneration
from app.answer.service import answer
from app.cli.answer_report import EXIT_MESSAGES as ANSWER_EXIT_MESSAGES
from app.cli.retrieval_report import EXIT_NO_ACCOUNT, _actor_for
from app.db.engine import create_engine, create_session_factory
from app.domain.models import Actor, Role
from app.eval.metrics import (
    RECALL_DEPTH,
    Aggregate,
    check_leak,
    percentile,
    score_mrr,
    score_recall,
)
from app.eval.sets import (
    EvaluationSet,
    check_separation,
    load_set,
    select,
    summary,
)
from app.provider_config.runtime import configured_run, get_runtime
from app.provider_config.transport import provider_client
from app.providers.base import EmbeddingProviderError, ProviderUsage
from app.providers.generation import (
    _SYSTEM_PROMPT,
    GENERATION_SCHEMA,
    GenerationProviderError,
    GenerationResponseError,
    build_generation_provider,
)
from app.providers.rerank import RerankProviderError
from app.providers.retry import RetryableError
from app.providers.usage import usage_record
from app.retrieval.contracts import RetrievalConfig
from app.retrieval.rerank import RerankUnavailableError
from app.retrieval.service import retrieve
from app.retrieval.store import (
    IndexProvenanceMismatchError,
    RetrievalDomainTooLargeError,
    read_domain_fingerprint,
)
from app.settings import Settings, load_settings

EXIT_OK: Final = 0
EXIT_USAGE: Final = 2
EXIT_SET: Final = 3
EXIT_NO_KEY: Final = 8
EXIT_PROVIDER: Final = 5

#: The fixed standard, at the repository root rather than inside the package.
STANDARD_PATH: Final = Path(__file__).resolve().parents[4] / "eval" / "questions.jsonl"

#: Where artifacts land unless ``--out`` says otherwise. Gitignored by the repository: with
#: ``--show-text`` these files carry document text, and an untracked artifact is not a
#: place to put it.
DEFAULT_RUNS_DIR: Final = Path(__file__).resolve().parents[4] / "eval" / "runs"

#: Ceiling on passages offered, matching ``AnswerConfig``'s own maximum and the citation
#: limit the product serves.
MAX_SOURCES: Final = 5

#: Bumped whenever the artifact's shape changes, so a re-score can refuse an artifact whose
#: rows it does not know how to read instead of reporting a figure computed from the wrong
#: fields.
ARTIFACT_SCHEMA_VERSION: Final = 3

#: How many provider errors **in a row** end a run early. Only provider errors count: a
#: retrieval outage, an index mismatch or a validation failure does not say the endpoint
#: refused anything, and stopping on those under that label points an operator at the wrong
#: service.
PROVIDER_ERROR_STOP_AFTER: Final = 3


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="eval_run",
        description=(
            "Run the fixed evaluation set and record retrieval, behaviour, leakage, "
            "latency and consumption."
        ),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="where to write the run artifact (default: eval/runs/<run_id>.json)",
    )
    parser.add_argument("--set", type=Path, default=STANDARD_PATH, help="the evaluation set")
    parser.add_argument(
        "--dev",
        type=Path,
        default=None,
        help=(
            "a development set to run instead; refused if it shares an id or a question "
            "with the fixed standard, because tuning on the standard makes its result optimistic"
        ),
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="run only the first N samples, in file order"
    )
    parser.add_argument(
        "--category", action="append", default=[], help="only this category; repeatable"
    )
    parser.add_argument("--role", action="append", default=[], help="only this role; repeatable")
    parser.add_argument(
        "--show-text",
        action="store_true",
        help="record the composed answer, quotes and claim text. Document text.",
    )
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    return parser


@dataclass(slots=True)
class SampleRecord:
    """One sample's outcome, in the shape it is written to the artifact.

    ``error`` is a fixed reason word. A provider's own message can quote the question and
    this corpus is document text, so it is never recorded here.
    """

    sample_id: str
    category: str
    role: str
    expected_behavior: str
    latency_ms: float
    retrieval_ranks: list[dict[str, Any]] = field(default_factory=list)
    #: False when retrieval never returned, so the row's recall is unmeasured rather than a
    #: miss. A retrieval that failed is not a retrieval that found nothing.
    retrieval_measured: bool = False
    cited: list[dict[str, Any]] = field(default_factory=list)
    abstained: bool | None = None
    missing_parts: list[str] = field(default_factory=list)
    claims_validated: int = 0
    leak: dict[str, Any] | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    answer: str | None = None
    quotes: list[dict[str, Any]] = field(default_factory=list)

    @property
    def retrieval_pairs(self) -> list[list[str]]:
        """The retrieved pairs, derived from the ranks so the two cannot disagree."""
        return [
            [str(row.get("document_id")), str(row.get("section_id"))]
            for row in self.retrieval_ranks
        ]

    @property
    def cited_pairs(self) -> list[list[str]]:
        """The cited pairs, derived from the cited sources."""
        return [
            [str(source.get("document_id")), str(source.get("section_id"))] for source in self.cited
        ]


def _usage_summary(usage: ProviderUsage | None, *, asked: bool = False) -> dict[str, Any]:
    """One sample's figures, every unit a string or ``None``.

    ``None`` means the provider did not report it. Printing a zero instead would be a
    claim that it cost nothing, which is a claim about money nobody spent.

    ``asked`` is a separate fact from ``reported``, and the two must not be merged. A
    sample that asked the provider and got no usage back is not a sample that asked
    nothing: only the first one belongs in the coverage denominator that decides whether a
    figure is a total or a subtotal, and only the second means there was no cost to know.
    """
    if usage is None:
        return {"reported": False, "provider_was_called": asked}
    billed = usage.billed_units or {}
    return {
        "reported": True,
        "provider_was_called": True,
        "attempts": usage.attempts,
        "prompt_tokens": str(billed["prompt_tokens"]) if "prompt_tokens" in billed else None,
        "completion_tokens": (
            str(billed["completion_tokens"]) if "completion_tokens" in billed else None
        ),
        "total_tokens": str(billed["total_tokens"]) if "total_tokens" in billed else None,
        "cost": str(usage.cost) if usage.cost is not None else None,
        "currency": usage.currency,
    }


def _unrequested_usage() -> dict[str, Any]:
    """The usage of a sample that never reached the provider."""
    return {"reported": False, "provider_was_called": False}


@dataclass(slots=True)
class RunTotals:
    """Consumption accumulated across every sample that made a request.

    Tokens accumulate across attempts, which is what makes a retry visible: an attempt that
    failed after being billed still cost something, and dropping it would understate the run.
    A cost the provider did not report stays ``None`` for the whole run rather than
    becoming a sum of the parts that happened to be known.
    """

    samples_with_usage: int = 0
    attempts: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost: float | None = None
    currency: str | None = None
    #: How many samples reported *each* unit. A total is only a total when it covers all of
    #: them; a subtotal over the ones that happened to be known is a different number and
    #: is reported under its own name.
    samples_reporting_cost: int = 0
    samples_reporting_tokens: int = 0
    #: How many samples reached the provider at all, reported or not. This is the coverage
    #: denominator, and it is *not* the number of samples that reported figures: a request
    #: that was sent and billed without a usage reply is still a request, and dropping it
    #: from the denominator is what let a partial run report itself as complete.
    samples_asked: int = 0
    #: Set when two samples reported costs in different currencies. The figure is dropped
    #: rather than merged, because a sum of unlike units is not an amount of anything.
    mixed_currencies: bool = False

    def add(self, summary: dict[str, Any]) -> None:
        # Whether the provider was asked, and what it answered, are two separate facts. The
        # first is recorded for every sample that reached the provider; only the second can
        # be absent while the first is true.
        if summary.get("provider_was_called"):
            self.samples_asked += 1
        if not summary.get("reported"):
            return
        self.samples_with_usage += 1
        self.attempts += summary.get("attempts") or 0
        tokens_known = True
        for unit in ("prompt_tokens", "completion_tokens", "total_tokens"):
            value = summary.get(unit)
            if value is None:
                tokens_known = False
                continue
            setattr(self, unit, getattr(self, unit) + int(value))
        if tokens_known:
            self.samples_reporting_tokens += 1
        if summary.get("cost") is not None:
            # A run-level cost needs one currency; a mix would be a sum of unlike things, so
            # a currency change drops the accumulated figure rather than merging unlike ones.
            incoming = str(summary.get("currency"))
            if self.currency is not None and incoming != self.currency:
                self.mixed_currencies = True
                self.cost = None
            else:
                self.currency = incoming
                self.cost = round((self.cost or 0.0) + float(summary["cost"]), 12)
            self.samples_reporting_cost += 1

    def as_dict(self) -> dict[str, Any]:
        """The run's consumption, and exactly what each figure covers.

        Three things have to stay apart, and collapsing any two misstates money:

        * a **total** is a total only when every request that was sent also reported the
          unit - a request that was billed without a usage reply makes the run's figure a
          subtotal, however complete the samples that did answer look;
        * a **subtotal** covers only the samples whose numbers are known;
        * **zero** is a zero only when the provider asked was made and nothing was charged.
          A run that never asked anything and a run that asked and was not told are both
          "no cost is known", and they are different facts with different causes.
        """
        asked = self.samples_asked
        # With no request at all there is nothing to cover, and the answer is "no" rather
        # than a vacuous yes: a vacuous yes is what a reader would take as "the cost is
        # known".
        tokens_complete = asked > 0 and self.samples_reporting_tokens == asked
        cost_complete = (
            asked > 0 and self.samples_reporting_cost == asked and not self.mixed_currencies
        )
        no_provider_work = asked == 0
        return {
            "scope": "generation only; embedding and rerank are reported separately below",
            "samples_asked": asked,
            "samples_reporting_usage": self.samples_with_usage,
            "samples_reporting_nothing": asked - self.samples_with_usage,
            "attempts": self.attempts,
            "tokens_complete": tokens_complete,
            "tokens_subtotal": self.total_tokens,
            "completion_tokens": self.completion_tokens,
            "cost_complete": cost_complete,
            "cost_subtotal": str(self.cost) if self.cost is not None else None,
            "mixed_currencies": self.mixed_currencies,
            "currency": self.currency if not self.mixed_currencies else None,
            "provider_was_called": not no_provider_work,
            "note": (
                "a *_complete figure covers every request that was sent; a subtotal covers "
                "only the ones whose figures are known. None means unreported, zero would be "
                "a claim that the provider charged nothing, and provider_was_called says "
                "whether anything was sent at all."
            ),
        }


class _CountingReranker:
    """Counts rerank calls so the artifact can say whether the reranked path really ran.

    Same reasoning as the embedder: the question a report has to answer is not "what did it
    cost" but "was the configured path the one that executed". A configuration block that
    says ``rerank_enabled: true`` and a report whose rankings came from the un-reranked
    path look identical unless something counts.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.calls = 0
        self.usages: list[ProviderUsage] = []

    async def rerank(self, *args: Any, **kwargs: Any) -> Any:
        self.calls += 1
        try:
            return await self._inner.rerank(*args, **kwargs)
        finally:
            usage = getattr(self._inner, "last_usage", None)
            self.usages.extend(
                getattr(self._inner, "last_usages", None) or ([usage] if usage else [])
            )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


class _GenerationObserver:
    """Sees the real ``generate`` call, which is the only thing that can answer "did this
    sample ask the provider anything?".

    The runner cannot infer it from where it sits in the control flow. ``answer`` runs its
    own retrieval, re-checks authorization, and may abstain for want of evidence or fail in
    that second retrieval - all **before** any generation happens, and all after the point
    where a flag set at the start of ``answer`` would already read ``True``. Only wrapping
    the provider method itself distinguishes "we called the provider" from "we called a
    function that would have called the provider".

    The counter is monotonic across the run, so a sample reads it before and after its own
    ``answer`` call; a difference means generation happened somewhere inside, which is the
    fact being asked about. It is compared, not reset: a reset here would race with the
    provider and turn "someone generated" into "I generated".
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.generations = 0

    async def generate(self, *args: Any, **kwargs: Any) -> Any:
        self.generations += 1
        return await self._inner.generate(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


class _CountingEmbedder:
    """Wraps the embedding adapter to count what the run asked of it.

    Local and unbilled, so the only honest figure is a count: the local server reports no
    usage, and inventing a token figure for it would be a claim about money nobody spent.
    The point of the count is that ``usage`` in the artifact is otherwise a
    generation-only total, and a reader who sees a token number has no way to know that a
    whole other provider was also called.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.calls = 0

    async def embed_query(self, text: str) -> Any:
        # Named after the adapter's real method. Wrapping ``embed`` instead would have
        # looked correct and counted nothing: the attribute the retrieval layer calls is
        # ``embed_query``, and everything else falls through to the inner adapter, so a
        # wrapper that counts the wrong name reports zero and looks measured.
        self.calls += 1
        return await self._inner.embed_query(text)

    async def embed_documents(self, texts: list[str]) -> Any:
        self.calls += 1
        return await self._inner.embed_documents(texts)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _generations_so_far(generator: Any) -> int:
    """How many times this run has called the provider, as far as the generator knows.

    Zero for a provider that does not carry the observer, so an unwrapped generator is
    treated as "no evidence of generation" rather than as "generation happened": the first
    reading is the safe one, because it can undercount a charge but cannot invent one.
    """
    return int(getattr(generator, "generations", 0))


async def _run_sample(
    factory: Any,
    role: Role,
    sample: dict[str, Any],
    vector_provider: Any,
    generator: Any,
    show_text: bool,
    *,
    retrieval_config: RetrievalConfig,
    rerank_provider: Any | None = None,
) -> SampleRecord:
    """One sample: retrieval for the metrics, then the answer for the behaviour.

    Retrieval runs separately from ``answer`` because recall and MRR need a rank, and
    ``AnswerResult`` carries only the sources it chose - no rank, no score. The cost is a
    second retrieval per sample and is recorded as part of the sample's latency, since a
    reader comparing two runs should be comparing like with like.

    The whole sample is inside one error boundary. A dead embedding server, an index whose
    digest no longer matches, or a provider outage is an ordinary outcome of an evaluation,
    not a crash of the command: with the boundary here, one such sample is recorded as a
    failed row, the run keeps going, and the artifact still holds every sample that came
    before it. With the boundary around only ``answer``, an Ollama restart halfway through
    discarded the results and the consumption of the samples that had already run, and let
    an exception whose message can quote the evaluation's own question reach stderr.

    The same ``retrieval_config`` is given to both retrievals and is the one built from the
    deployment's settings, so a run measures the product's configured path rather than a
    default that happens to be what the library defaults to.
    """
    record = SampleRecord(
        sample_id=str(sample["id"]),
        category=str(sample["category"]),
        role=str(sample["role"]),
        expected_behavior=str(sample["expected_behavior"]),
        latency_ms=0.0,
    )
    question = str(sample["question"])
    started = time.perf_counter()
    #: The provider call count *before* this sample's ``answer``. Read again afterwards, and
    #: a difference is the only honest evidence that generation happened for this sample:
    #: ``answer`` can abstain, or fail in its own retrieval, before reaching the provider,
    #: and a flag set at the start of ``answer`` would already read ``True``.
    generations_before = _generations_so_far(generator)
    rerank_before = len(getattr(rerank_provider, "usages", []))

    def _finish() -> SampleRecord:
        record.latency_ms = (time.perf_counter() - started) * 1000.0
        # Only a sample that actually reached the provider may claim that provider's
        # accounting. The generator is shared across the run and its ``last_usage`` is only
        # reset when a new generation starts, so without this gate a sample that failed in
        # retrieval, or that abstained for want of evidence without generating, repeats the
        # previous sample's attempts and tokens: a run reporting money it did not spend.
        generated_here = _generations_so_far(generator) > generations_before
        if generated_here:
            if not record.usage.get("reported"):
                record.usage = _usage_summary(getattr(generator, "last_usage", None), asked=True)
            else:
                record.usage.setdefault("provider_was_called", True)
        else:
            record.usage = _unrequested_usage()
        generation_usage = getattr(generator, "last_usage", None) if generated_here else None
        usages = (
            list(
                getattr(generator, "last_usages", None)
                or ([generation_usage] if generation_usage else [])
            )
            if generated_here
            else []
        )
        usages += getattr(rerank_provider, "usages", [])[rerank_before:]
        record.usage["provider_usages"] = [usage_record(u) for u in usages]
        return record

    try:
        # A fresh identity per sample. The guide requires it: sharing a session or a
        # retrieval history across samples would let one question's results leak into the
        # next, and the role-switch scenario is specifically about starting each run with an
        # independent identity.
        actor = Actor(user_id=uuid4(), role=role, session_id=uuid4())
        async with factory() as session:
            hits = await retrieve(
                session,
                actor=actor,
                question=question,
                config=retrieval_config,
                provider=vector_provider,
                rerank_provider=rerank_provider,
            )

        record.retrieval_ranks = [
            {
                "position": position,
                "document_id": hit.source.document_id,
                "section_id": hit.source.section_id,
                # The revision is part of the evidence's identity. Without it, a document
                # that has since been replaced is the same pair pointing at different text,
                # and a reviewer cannot tell which one this run saw.
                "revision": hit.source.revision,
                "fused_score": hit.fused_score,
                "lexical_rank": hit.lexical_rank,
                "vector_rank": hit.vector_rank,
                "rerank_score": hit.rerank_score,
            }
            for position, hit in enumerate(hits, start=1)
        ]
        # Settled now, not at the end: everything below can fail without invalidating it.
        # A generation failure must not delete a measurement that already happened, and the
        # retrieval half of the leakage check must run for a sample that never got as far
        # as an answer - otherwise a forbidden document in the retrieved set is only
        # noticed when the model happened to cite it.
        record.retrieval_measured = True
        _attach_leak(record, sample, record.retrieval_ranks, ())

        result = await answer(
            factory,
            actor=Actor(user_id=uuid4(), role=role, session_id=uuid4()),
            question=question,
            config=AnswerConfig(retrieval=retrieval_config, max_sources=MAX_SOURCES),
            vector_provider=vector_provider,
            generator=generator,
            rerank_provider=rerank_provider,
        )
    except InvalidGeneration as error:
        record.error = f"invalid_generation:{error.reason.value}"
        return _finish()
    except GenerationResponseError:
        record.error = "unusable_response"
        return _finish()
    except GenerationProviderError:
        # The adapter's own wording is not recorded: a provider's message can quote the
        # question back, and the question is the operator's evaluation content.
        record.error = "provider_error"
        return _finish()
    except (
        EmbeddingProviderError,
        RetryableError,
        RerankUnavailableError,
        # The adapter's own typed errors, not just the wrapper `retrieval/rerank.py` raises.
        # The wrapper is not the only thing on this path: an HTTP failure inside
        # `providers/rerank.py` surfaces as `RerankProviderError`, which is a `RuntimeError`
        # nothing here caught, so a rerank outage escaped the sample boundary and took the
        # whole run's artifact with it. `RerankResponseError` is a subclass, so it is
        # covered by naming the parent.
        RerankProviderError,
        RetrievalDomainTooLargeError,
    ) as error:
        # Retrieval failed before any generation was attempted. Recorded as its own reason
        # because it is a different failure: the answer never had a chance to run, and the
        # row has no retrieval to score, so its recall must stay unmeasured rather than
        # counting as a miss. The type name is kept because these are operational causes an
        # operator acts on differently - a dead embedding server, a reranker that would not
        # answer, or a corpus past the lexical ceiling - and none of them carries the
        # question.
        record.error = f"retrieval_error:{type(error).__name__}"
        return _finish()
    except TimeoutError:
        record.error = (
            "provider_error"
            if _generations_so_far(generator) > generations_before
            else "retrieval_error:TimeoutError"
        )
        return _finish()
    except IndexProvenanceMismatchError:
        # The index's metadata no longer matches the live embedding model. The retrieval
        # layer fails closed here rather than ranking over rows from a different model, so
        # a run that hits this has measured nothing about retrieval quality.
        record.error = "index_inconsistent"
        return _finish()
    except Exception as error:  # noqa: BLE001 - the reason is spelled out below
        # The last resort, and the reason it is last rather than first: every failure with a
        # known operational cause is named above, because a named cause tells an operator
        # which service to look at. This clause exists for the ones nobody enumerated - a
        # KeyError from a column, a TypeError from an adapter, a third-party exception.
        #
        # Without it any of those ends the whole run: the exception unwinds past the loop,
        # the ``finally`` closes the clients, and the artifact is never written - so forty
        # measured samples and their consumption vanish, and a traceback reaches a terminal
        # carrying a message that can quote the evaluation's own question or a passage.
        #
        # Only the **type** is recorded. The message is not, for the same reason the
        # provider's own wording is not: it is untrusted text about a run whose content is
        # the operator's evaluation material.
        #
        # Control signals need no clause of their own: `asyncio.CancelledError`,
        # `KeyboardInterrupt` and `SystemExit` are all `BaseException` rather than
        # `Exception`, so this one does not match them and they reach the caller. An
        # earlier version spelled that out with an explicit `raise`, and a mutation proved
        # the clause did nothing - the guarantee is in the base class, not in the code.
        record.error = f"unexpected_error:{type(error).__name__}"
        return _finish()

    record.abstained = result.abstained
    record.missing_parts = [str(part) for part in result.missing_parts]
    record.claims_validated = len(result.claims)
    # The figure the adapter attached to the answer that was served, which is the one the
    # run's totals should be built from rather than the generator's last reading.
    record.usage = _usage_summary(result.usage)
    record.cited = [
        {
            "document_id": source.document_id,
            "section_id": source.section_id,
            "revision": source.revision,
        }
        for source in result.sources
    ]
    if show_text:
        # The only place document text is written, and only when an operator asked for it.
        record.answer = result.answer
        record.quotes = [
            {
                "quote": claim.quote,
                "document_id": claim.source.document_id,
                "section_id": claim.source.section_id,
                "revision": claim.source.revision,
            }
            for claim in result.claims
        ]
    # Re-checked with the citations included. The retrieval half already ran above; a second
    # full check keeps the finding whole rather than half-rewritten.
    _attach_leak(record, sample, record.retrieval_ranks, record.cited)
    return _finish()


def _attach_leak(record: SampleRecord, sample: dict[str, Any], hits: Any, sources: Any) -> None:
    finding = check_leak(sample, hits, sources)
    if finding is not None:
        record.leak = finding.as_dict()


def _errors_by_reason(records: list[SampleRecord]) -> dict[str, int]:
    """How many samples failed for each reason. A run's error profile in one line."""
    counts: dict[str, int] = {}
    for record in records:
        if record.error:
            # The reason family, not the full string: a reason that carries an exception type
            # would fragment the count across names that mean the same operationally.
            family = str(record.error).split(":", 1)[0]
            counts[family] = counts.get(family, 0) + 1
    return counts


def _score(records: list[SampleRecord], samples: list[dict[str, Any]]) -> dict[str, Any]:
    """The report's figures, computed from the recorded rows.

    Metrics are recomputed from the artifact rather than accumulated during the run, so a
    later reader can reproduce every number from the same rows with no provider and no
    database. Two implementations of the same metric is the risk this avoids: the run
    records what happened, and this is the only place a figure is derived from it.

    Every figure is grouped **by role as well as by category**. The guide asks for both, and
    the two are not the same cut: the role decides what may be retrieved at all, so a
    difference between an employee's and a manager's numbers is the first thing worth
    looking at, and a report with only per-category rows hides it.
    """
    by_id = {record.sample_id: record for record in records}
    leaks: list[dict[str, Any]] = []
    leak_samples = 0
    behaviour_checked = 0
    abstained_when_expected = 0
    answered_when_expected = 0
    # Behaviour, leakage, execution and consumption are cut by role and category too. The
    # guide asks for results on both axes, and an aggregate hides exactly the failure worth
    # finding: an employee abstaining where an answer was expected and a manager answering
    # the same way balance out to a clean run-level number.
    behaviour_by: dict[str, dict[str, dict[str, int]]] = {"category": {}, "role": {}}
    leaks_by: dict[str, dict[str, dict[str, int]]] = {"category": {}, "role": {}}
    execution_by: dict[str, dict[str, dict[str, int]]] = {"category": {}, "role": {}}
    usage_by: dict[str, dict[str, dict[str, Any]]] = {"category": {}, "role": {}}

    recall_agg: dict[str, dict[str, Aggregate]] = {"category": {}, "role": {}}
    mrr_agg: dict[str, dict[str, Aggregate]] = {"category": {}, "role": {}}
    latencies: dict[str, dict[str, list[float]]] = {"category": {}, "role": {}}
    every_latency: list[float] = []

    def grouped(bucket: dict[str, Aggregate]) -> dict[str, Any]:
        return {name: agg.as_dict() for name, agg in sorted(bucket.items())}

    def cell(store: dict[str, dict[str, dict[str, Any]]], axis: str, name: str) -> dict[str, Any]:
        """The counter block for one group, created on first use.

        Created empty, not seeded with a count. A store that counts samples already carries
        its own ``samples`` counter, and seeding this one too left every behaviour and
        leakage group reporting ``samples: 0`` beside real ``checked: 36`` - a number that
        looks measured and is not.
        """
        return store[axis].setdefault(name, {})

    def cut(store: dict[str, dict[str, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
        """Both axes of one counter store, as ``{"category": {...}, "role": {...}}``."""
        return {
            axis: {name: dict(counts) for name, counts in sorted(store[axis].items())}
            for axis in ("category", "role")
        }

    for sample in samples:
        record = by_id.get(str(sample["id"]))
        if record is None:
            continue
        every_latency.append(record.latency_ms)
        axes = (("category", record.category), ("role", record.role))
        for axis, name in axes:
            latencies[axis].setdefault(name, []).append(record.latency_ms)

        # Execution and consumption, per group. A failed sample is not only a run-level
        # number: which group it failed in decides whether the failure is about the system
        # or about that role's slice of it.
        for axis, name in axes:
            execution = execution_by[axis].setdefault(name, {"samples": 0})
            execution["samples"] += 1
            if record.error:
                execution["failed"] = execution.get("failed", 0) + 1
            if record.retrieval_measured:
                execution["retrieval_measured"] = execution.get("retrieval_measured", 0) + 1
            usage = cell(usage_by, axis, name)
            if record.usage.get("provider_was_called"):
                usage["asked"] = usage.get("asked", 0) + 1
                if record.usage.get("reported"):
                    usage["reporting_usage"] = usage.get("reporting_usage", 0) + 1
                    usage["attempts"] = usage.get("attempts", 0) + (
                        record.usage.get("attempts") or 0
                    )
                    tokens = record.usage.get("total_tokens")
                    if tokens is not None:
                        usage["tokens_known"] = usage.get("tokens_known", 0) + int(tokens)
                        usage["tokens_complete_samples"] = (
                            usage.get("tokens_complete_samples", 0) + 1
                        )
                    if record.usage.get("cost") is not None:
                        usage["cost_reported_samples"] = usage.get("cost_reported_samples", 0) + 1
            else:
                usage["not_asked"] = usage.get("not_asked", 0) + 1

        if record.leak is not None:
            leak_samples += 1
            leaked = bool(record.leak.get("leaked"))
            if leaked:
                leaks.append(record.leak)
            for axis, name in axes:
                entry = cell(leaks_by, axis, name)
                entry["confidential_samples"] = entry.get("confidential_samples", 0) + 1
                if leaked:
                    entry["leaked_samples"] = entry.get("leaked_samples", 0) + 1

        hits = [_Hit(pair) for pair in record.retrieval_pairs]
        # A row whose retrieval never returned is not scored. Counting an absence of
        # measurement as an absence of results would turn a dead embedding server into a
        # total retrieval failure, which is the opposite of what happened.
        if not record.retrieval_measured:
            for axis, name in axes:
                recall_agg[axis].setdefault(name, Aggregate()).excluded += 1
                mrr_agg[axis].setdefault(name, Aggregate()).excluded += 1
            continue

        recall_result = score_recall(sample, hits)
        mrr_result = score_mrr(sample, hits)
        for axis, name in axes:
            recall_agg[axis].setdefault(name, Aggregate()).add(
                recall_result.recall, recall_result.eligible, recall_result.excluded_reason
            )
            mrr_agg[axis].setdefault(name, Aggregate()).add(
                mrr_result.reciprocal_rank, mrr_result.eligible, mrr_result.excluded_reason
            )

        if record.abstained is not None and not record.error:
            behaviour_checked += 1
            expected_answer = record.expected_behavior == "answer"
            # Both the outcome and the expectation, because a group's error rate is only
            # readable next to what that group was asked to do.
            for axis, name in axes:
                entry = cell(behaviour_by, axis, name)
                entry["checked"] = entry.get("checked", 0) + 1
                entry["expected_answer" if expected_answer else "expected_abstain"] = (
                    entry.get("expected_answer" if expected_answer else "expected_abstain", 0) + 1
                )
                if record.abstained:
                    entry["abstained"] = entry.get("abstained", 0) + 1
                else:
                    entry["answered"] = entry.get("answered", 0) + 1
            if record.abstained and not expected_answer:
                abstained_when_expected += 1
            if not record.abstained and expected_answer:
                answered_when_expected += 1

    def overall(bucket: dict[str, Aggregate]) -> float | None:
        """The mean over every measured sample, not the mean of category means.

        The guide's "overall" is one number over the eligible samples; averaging the
        categories would weight a ten-sample category like a three-sample one and quietly
        change what the figure is about.
        """
        entries = [agg for agg in bucket.values() if agg.measured > 0]
        if not entries:
            return None
        return sum(entry.total for entry in entries) / sum(entry.measured for entry in entries)

    return {
        "retrieval": {
            "recall_depth": RECALL_DEPTH,
            "measured_over": (
                "the retrieval this run performed. Rows whose retrieval failed are excluded "
                "rather than scored as misses, and excluded is reported beside measured."
            ),
            "recall_at_5": {
                "overall": overall(recall_agg["category"]),
                "by_category": grouped(recall_agg["category"]),
                "by_role": grouped(recall_agg["role"]),
            },
            "mrr": {
                "by_category": grouped(mrr_agg["category"]),
                "by_role": grouped(mrr_agg["role"]),
            },
        },
        "behaviour": {
            "checked": behaviour_checked,
            "abstained_when_a_refusal_was_expected": abstained_when_expected,
            "answered_when_an_answer_was_expected": answered_when_expected,
            "by_category": cut(behaviour_by)["category"],
            "by_role": cut(behaviour_by)["role"],
            "note": (
                "counts samples whose observed behaviour matched expected_behavior. Each "
                "group carries its own checked/expected/abstained/answered counts, because "
                "an aggregate hides a group that abstains where an answer was expected. "
                "Whether the answer covered required_facts is a human review and is not "
                "scored here."
            ),
        },
        "leakage": {
            "confidential_samples": leak_samples,
            "leaked_samples": len(leaks),
            "observed_leak_rate": (len(leaks) / leak_samples if leak_samples else None),
            "by_category": cut(leaks_by)["category"],
            "by_role": cut(leaks_by)["role"],
            "note": (
                "observed in this run only. Zero observed leaks is not a confidentiality "
                "guarantee and does not generalise to attacks outside this set."
            ),
            "findings": leaks,
        },
        "execution": {
            "note": (
                "per group: samples run, how many failed, and how many of them actually "
                "produced a retrieval. A group's recall is computed over the measured ones "
                "only, so this is where a group that silently stopped being measured is "
                "visible."
            ),
            "by_category": cut(execution_by)["category"],
            "by_role": cut(execution_by)["role"],
        },
        "consumption": {
            "note": (
                "per group: how many samples asked the provider, how many got figures back, "
                "and what those figures summed to. A group where asked exceeds "
                "reporting_usage is a group whose total is a subtotal."
            ),
            "by_category": cut(usage_by)["category"],
            "by_role": cut(usage_by)["role"],
        },
        "latency_ms": {
            "p50": percentile(every_latency, 0.5),
            "p95": percentile(every_latency, 0.95),
            "measured": len(every_latency),
            "by_category": {
                name: {"p50": percentile(values, 0.5), "p95": percentile(values, 0.95)}
                for name, values in sorted(latencies["category"].items())
                if values
            },
            "by_role": {
                name: {"p50": percentile(values, 0.5), "p95": percentile(values, 0.95)}
                for name, values in sorted(latencies["role"].items())
                if values
            },
        },
    }


class _Hit:
    """The minimum a recorded pair needs to be scored again from an artifact."""

    def __init__(self, pair: Any) -> None:
        if isinstance(pair, (list, tuple)):
            document_id, section_id = pair[0], pair[1]
        else:
            document_id = pair.get("document_id")
            section_id = pair.get("section_id")
        self.source = type("Source", (), {"document_id": document_id, "section_id": section_id})()


#: Files whose content decides what a run measures. Hashed together so a change to the
#: metrics, the ranking, the answer gate or the artifact itself changes the provenance.
#: A schema version number says what shape the file has; it says nothing about the
#: arithmetic inside it.
PROVENANCE_FILES: Final = (
    "app/cli/eval_run.py",
    "app/cli/eval_score.py",
    "app/eval/metrics.py",
    "app/eval/sets.py",
    "app/retrieval/service.py",
    "app/retrieval/store.py",
    "app/retrieval/rerank.py",
    "app/retrieval/lexical.py",
    "app/retrieval/fusion.py",
    "app/answer/service.py",
    "app/answer/validate.py",
    "app/answer/quotes.py",
)


def code_provenance() -> dict[str, Any]:
    """A digest of the code that produced the numbers.

    Both a schema version and a content digest, and the digest is computed from the working
    tree rather than from a release: an evaluation run is usually a developer running against
    uncommitted changes, so a digest of the last commit would describe code that was not
    measured. A file that cannot be read is named as missing rather than omitted, because an
    absent file in that list would otherwise silently drop out of the digest.
    """
    digests: dict[str, str] = {}
    unreadable: list[str] = []
    root = Path(__file__).resolve().parents[2]
    for relative in PROVENANCE_FILES:
        path = root / relative
        try:
            digests[relative] = _digest_of_text(path.read_text(encoding="utf-8"))
        except OSError:
            unreadable.append(relative)
    combined = _digest_of_text(
        "\n".join(f"{name}:{value}" for name, value in sorted(digests.items()))
    )
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "module": "app.cli.eval_run",
        "combined_sha256": combined,
        "files": dict(sorted(digests.items())),
        "files_not_read": sorted(unreadable),
        "note": (
            "digests are of the working tree as it was when the run started, which is not "
            "necessarily the last commit. A run whose combined digest differs from another's "
            "was produced by different code, whatever the schema version says."
        ),
    }


async def _corpus_provenance(factory: Any, roles: dict[str, Role]) -> dict[str, Any]:
    """What this role could search over, as a version.

    The recorded evidence rows are not a version of the corpus. A document that never
    reached the top five still changes BM25's IDF, the eligible-domain size, and every
    rank around it, so two runs with identical configurations, identical evidence rows and
    different corpora would otherwise be indistinguishable. The digest is taken over the
    identity of what this actor could read - document, revision and section count - and over
    nothing else: no title, no text, no document an unauthorized actor can see.
    """
    per_role: dict[str, Any] = {}
    for login, role in sorted(roles.items()):
        # A fresh identity, as every sample gets: the fingerprint must describe what this
        # role can read, not reuse some earlier session's view of it.
        actor = Actor(user_id=uuid4(), role=role, session_id=uuid4())
        try:
            async with factory() as session:
                snapshot = await read_domain_fingerprint(session, actor)
        except Exception:  # noqa: BLE001 - see the comment below
            # A domain this actor cannot even enumerate is a fact about the run, and it is
            # recorded as such rather than left to look like an empty corpus. The catch is
            # deliberately broad: this block runs after every measurement is already
            # recorded, so letting a connection error escape would discard the whole run
            # for a provenance field. The status says the figure is missing rather than
            # the run being incomplete.
            per_role[login] = {"status": "unreadable"}
            continue
        per_role[login] = {
            "status": "ok",
            "documents": snapshot["documents"],
            "sections": snapshot["sections"],
            "chunks": snapshot["chunks"],
            "sha256": _digest_of_text(snapshot["fingerprint"]),
        }
    return {
        "by_role": per_role,
        "scope": (
            "counts and a digest of the identity of what each role could search over; no "
            "title, no text, and nothing belonging to another role"
        ),
        "note": (
            "not a document manifest. It answers 'was this run searching the same corpus?' "
            "which the evidence rows alone cannot, because a document outside the top five "
            "still moves the ranks inside it."
        ),
    }


async def _snapshot_provenance(
    settings: Settings,
    generator: Any | None,
    retrieval_config: RetrievalConfig,
    factory: Any,
    roles: dict[str, Role],
    *,
    set_path: Path,
    set_name: str,
    rerank_built: bool,
) -> dict[str, Any]:
    """Everything a reader needs to decide whether two runs are comparable.

    Taken once, at a named moment, and carried into the artifact unchanged. A figure read at
    the end of a run describes the end of the run: if ingestion replaced a document while
    the run was in flight, the end-state corpus is attributed to results that were partly
    produced against the previous one, and a document that never reached the top-k leaves no
    trace in the evidence rows to contradict it. The same applies to code edited on disk
    mid-run - the imported code was already in memory, so a digest of the working tree at the
    end describes files that never ran.
    """
    return await _configuration(
        settings,
        generator,
        retrieval_config,
        factory,
        roles,
        set_path=set_path,
        set_name=set_name,
        rerank_built=rerank_built,
    )


def _snapshot_coverage(block: dict[str, Any]) -> tuple[bool, list[str]]:
    """What this snapshot could actually measure, and what it could not.

    A snapshot that was taken is not the same as a snapshot that measured something. The
    two failure shapes are easy to confuse with a clean result because they both produce a
    dictionary rather than a missing key:

    * a corpus entry the run could not read, recorded as ``{"status": "unreadable"}``;
    * a code file that could not be hashed, listed in ``files_not_read``.

    Both leave a hole, and a hole on both sides compares equal to a hole on both sides -
    two unmeasured fingerprints are identical, which says nothing about whether the corpus
    held still. Reporting that as ``unchanged`` turns a missing measurement into a clean
    bill of health, which is the one thing this block exists to prevent.
    """
    gaps: list[str] = []
    code = block.get("code") or {}
    unreadable_files = code.get("files_not_read") or []
    if unreadable_files:
        gaps.append("code_files_unreadable:" + ",".join(sorted(unreadable_files)))
    if code.get("combined_sha256") is None:
        gaps.append("code_digest_missing")

    corpus = block.get("corpus")
    if corpus is None:
        gaps.append("corpus_block_missing")
    else:
        by_role = corpus.get("by_role") or {}
        for login in sorted(by_role):
            entry = by_role[login] or {}
            if entry.get("status") != "ok":
                gaps.append(f"corpus_unreadable:{login}")
            elif not entry.get("sha256"):
                gaps.append(f"corpus_fingerprint_missing:{login}")
    return (not gaps), gaps


def _provenance_drift(start: dict[str, Any], end: dict[str, Any]) -> dict[str, Any]:
    """Whether the world the run measured in is the world it recorded as.

    Every axis is judged **on its own**, and a partial snapshot is not allowed to discard
    what another axis proved. The bug this replaces did exactly that: when one role could
    not be read, the whole comparison was reported as `unmeasured` and a code edit plus a
    moved employee corpus - both plainly visible in the two snapshots - were thrown away
    because the manager's row was a hole. A gap in one axis is a gap in that axis.

    Three independent verdicts, each `True`, `False` or `None`:

    * **code** - compared between two digests. A digest over a *partial* file set is
      comparable only against another partial set covering the same files: two digests over
      different subsets can be equal by coincidence, and different ones need not mean the
      shared files changed. So unreadable files make the code axis unknown unless both
      sides name the same ones.
    * **corpus** - compared per role, across the roles both sides actually read. A role
      readable on one side only, or unreadable on either, is unknown for itself and does not
      speak for any other role.
    * **nothing comparable at all** - `unmeasured`, which is the one status that means no
      observation was made.

    A proven change on any axis is reported as a change even while another axis is unknown:
    reporting `incomplete` alone would bury an edit the run really did hit.
    """
    code_verdict, code_note = _compare_code(start, end)
    corpus_verdict, corpus_by_role = _compare_corpus(start, end)

    verdicts = [code_verdict, *corpus_verdict.values()]
    proven_change = any(verdict is True for verdict in verdicts)
    comparable = any(verdict is not None for verdict in verdicts)

    if not comparable:
        status = "unmeasured"
    elif proven_change:
        status = "changed"
    elif all(verdict is False for verdict in verdicts):
        # Every axis was readable on both sides and agreed. That is the only condition
        # under which "nothing moved" is a measurement rather than an absence.
        status = "unchanged"
    else:
        # Nothing moved where it could be measured, and something could not be measured at
        # all. Reporting this as `unchanged` would claim a stability nobody established.
        status = "incomplete"

    unknown = [
        name
        for name, verdict in [("code", code_verdict), *corpus_verdict.items()]
        if verdict is None
    ]
    return {
        "status": status,
        # `None` means "not measured", which is a different claim from `False`.
        "code_changed": code_verdict,
        "corpus_changed": (
            None
            if any(verdict is None for verdict in corpus_verdict.values())
            else any(corpus_verdict.values())
        ),
        "corpus_by_role": corpus_by_role,
        "unknown": sorted(unknown),
        "note": code_note,
    }


def _compare_code(start: dict[str, Any], end: dict[str, Any]) -> tuple[bool | None, str]:
    """The code digest verdict, or ``None`` when the two digests are not comparable.

    A digest over a partial file set is a digest of something smaller than it appears to be.
    Two such digests over *different* subsets can differ because the subsets differ, or be
    equal by coincidence while a shared file changed. So the unreadable-file lists have to
    match before the digests can be read as "these files are the same".
    """
    start_code = start.get("code") or {}
    end_code = end.get("code") or {}
    start_digest = start_code.get("combined_sha256")
    end_digest = end_code.get("combined_sha256")
    if start_digest is None or end_digest is None:
        return None, "the code digest could not be read on one or both sides"
    start_missing = set(start_code.get("files_not_read") or [])
    end_missing = set(end_code.get("files_not_read") or [])
    if start_missing or end_missing:
        if start_missing != end_missing:
            return (
                None,
                "the code digest was computed over different file sets on the two sides, so "
                "a difference between them says nothing about the files they share",
            )
        return (
            None,
            "the code digest omits "
            + ", ".join(sorted(start_missing))
            + " on both sides; a run can still be compared against another with the same "
            "omission, but that omission is not measured here",
        )
    return (start_digest != end_digest), (
        "measured by comparing a snapshot taken before the first sample with one taken after "
        "the last, per axis and per role. Each axis is reported only where both sides "
        "measured it; `null` means not measured, never 'nothing changed'."
    )


def _compare_corpus(
    start: dict[str, Any], end: dict[str, Any]
) -> tuple[dict[str, bool | None], dict[str, Any]]:
    """The corpus verdict for each role, judged separately.

    A role unreadable on either side is unknown for itself. It says nothing about any other
    role, and letting it decide the whole comparison is what hid a real change in the last
    round: the manager's hole erased a moved employee corpus and a changed code digest.
    """
    start_roles = (start.get("corpus") or {}).get("by_role") or {}
    end_roles = (end.get("corpus") or {}).get("by_role") or {}
    verdicts: dict[str, bool | None] = {}
    detail: dict[str, Any] = {}

    for login in sorted(set(start_roles) | set(end_roles)):
        # `None` when absent, an empty dict when present but empty; both mean "no reading
        # to compare", as does a status that is not `ok` or a missing digest.
        left = start_roles.get(login) or {}
        right = end_roles.get(login) or {}
        left_read = left.get("status") == "ok" and bool(left.get("sha256"))
        right_read = right.get("status") == "ok" and bool(right.get("sha256"))
        if not left_read or not right_read:
            verdicts[login] = None
            detail[login] = {
                "status": "unreadable",
                "note": (
                    "this role was not read on both sides, so its corpus is unknown; it says "
                    "nothing about the roles that were"
                ),
            }
            continue
        # Compared on the identity of what was readable, not on chunk counts alone: a
        # document that never reached the top-k changes the fingerprint without changing
        # any count a reader would notice.
        verdict = (
            left.get("sha256") != right.get("sha256")
            or left.get("documents") != right.get("documents")
            or left.get("sections") != right.get("sections")
            or left.get("chunks") != right.get("chunks")
        )
        verdicts[login] = bool(verdict)
        detail[login] = {
            "status": "compared",
            "start": {
                "sha256": left.get("sha256"),
                "documents": left.get("documents"),
                "sections": left.get("sections"),
                "chunks": left.get("chunks"),
            },
            "end": {
                "sha256": right.get("sha256"),
                "documents": right.get("documents"),
                "sections": right.get("sections"),
                "chunks": right.get("chunks"),
            },
        }
    return verdicts, detail


async def _configuration(
    settings: Settings,
    generator: Any | None,
    retrieval_config: RetrievalConfig,
    factory: Any,
    roles: dict[str, Role],
    *,
    set_path: Path,
    set_name: str,
    rerank_built: bool,
) -> dict[str, Any]:
    """Everything needed to say what was measured, and to compare two runs.

    The guide asks for the metric version, the model, the prompt, the generation settings,
    the embedding and its version, the search settings and top-k, the ranker and its
    version, the abstention threshold, and every access filter. Most are configuration; two
    are facts a reader cannot otherwise recover, and they are the ones worth care:

    * **The set that actually ran.** A fixed ``eval/questions.jsonl`` here would be a lie the
      moment ``--dev`` or ``--set`` pointed elsewhere, and the digest of the wrong file makes
      two unrelated runs look comparable.
    * **The prompt.** The system prompt and the response schema are hashed rather than
      pasted: a report's output ends up in tickets, and a prompt is the operator's own
      configuration. The hash is enough to tell two runs apart, which is what the guide asks
      for.

    ``generation_max_tokens`` is recorded because a change to it changes what the model can
    produce and is otherwise invisible - two artifacts that differ only in that field would
    otherwise look like the same measurement.
    """
    return {
        "set": {"path": str(set_path), "name": set_name},
        "provider_chains": {
            purpose: [
                {
                    "id": str(c.id),
                    "version": c.version,
                    "kind": c.kind,
                    "model": c.model,
                    "digest": c.digest,
                }
                for c in connections
            ]
            for purpose, connections in getattr(
                getattr(settings, "_provider_runtime", None), "connections", {}
            ).items()
        },
        "generation": {
            "provider": getattr(generator, "provider_name", None),
            "model": getattr(generator, "model", None),
            "max_tokens": settings.generation_max_tokens,
            "request_timeout": settings.generation_request_timeout,
            "system_prompt_sha256": _digest_of_text(_SYSTEM_PROMPT),
            "schema_sha256": _digest_of_text(_json_dumps(GENERATION_SCHEMA)),
        },
        "retrieval": {
            "lexical_top_k": retrieval_config.lexical_top_k,
            "vector_top_k": retrieval_config.vector_top_k,
            "rrf_k": retrieval_config.rrf_k,
            "rerank_enabled": retrieval_config.rerank_enabled,
            "rerank_top_k": retrieval_config.rerank_top_k,
            "final_top_k": retrieval_config.final_top_k,
            # Whether a reranker was actually constructed. ``rerank_enabled`` alone would
            # claim a configuration whose adapter may never have been built.
            "rerank_provider_built": rerank_built,
        },
        "answer": {"max_sources": MAX_SOURCES},
        "embedding": {
            "provider": settings.embedding_provider,
            "model": settings.ollama_embed_model,
            "digest": settings.ollama_embed_digest,
            "dimension": settings.embedding_dimension,
        },
        "rerank_model": (
            settings.openrouter_rerank_model if retrieval_config.rerank_enabled else None
        ),
        "code": code_provenance(),
        "corpus": await _corpus_provenance(factory, roles),
    }


def _digest_of_text(value: str) -> str:
    """A short content hash: enough to tell two configurations apart, short enough to read."""
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _json_dumps(value: Any) -> str:
    """Stable JSON, so a schema's hash does not depend on dictionary ordering."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


LIMITATIONS: Final = (
    "Forty questions over twenty synthetic documents. No production figure follows from it: "
    "not a general error rate, not a confidentiality guarantee, not a productivity claim. "
    "A zero observed leak rate means no leak was seen in these samples in this run. "
    "Whether a claim is supported by its citation, and whether the answer covered "
    "required_facts, are scored by human review and are not measured here. "
    "The generation model is a free tier endpoint with a daily quota; consumption figures "
    "are the provider's own reported usage and not an invoice."
)


async def _run(arguments: argparse.Namespace, settings: Settings) -> int:
    if not get_runtime(settings).connections["chat"]:
        print(ANSWER_EXIT_MESSAGES[EXIT_NO_KEY], file=sys.stderr)
        return EXIT_NO_KEY
    try:
        standard = load_set(STANDARD_PATH, name="standard")
        target = load_set(
            arguments.set if arguments.dev is None else arguments.dev,
            name="development" if arguments.dev else "standard",
        )
    except ValueError as error:
        print(f"the evaluation set is unusable: {error}", file=sys.stderr)
        return EXIT_SET

    if arguments.dev is not None:
        separation = check_separation(target, standard)
        if not separation.separated:
            print(
                "the development set overlaps the fixed standard and is refused",
                file=sys.stderr,
            )
            return EXIT_SET

    samples = select(
        target, categories=arguments.category, roles=arguments.role, limit=arguments.limit
    )
    if not samples:
        print("no samples matched the given filters", file=sys.stderr)
        return EXIT_SET

    from app.cli.run_worker import attempt_timeout_seconds, build_provider

    engine = create_engine(settings)
    generation_client: httpx.AsyncClient | None = None
    records: list[SampleRecord] = []
    stopped_early: str | None = None
    generator: Any = None
    consecutive_provider_errors = 0
    #: Declared here rather than inside the ``try`` so the artifact builder can report the
    #: call count even when the run stopped before building a provider, or failed while
    #: building one. A count read from a name that may not exist is a count of zero that
    #: looks measured.
    vector_provider: Any = None
    # The effective retrieval shape, built from the deployment's settings rather than from
    # the library's defaults. With rerank enabled but a default config, a run would measure
    # a path the product does not serve and would not be comparable with a product run at
    # all.
    retrieval_config = effective_retrieval_config(settings)
    rerank_provider: Any | None = None

    try:
        factory = create_session_factory(engine)
        # One role lookup per role actually used, not one per sample: the seeded accounts
        # do not change mid-run, and a role's authority is the same whoever is asking.
        roles: dict[str, Role] = {}
        for sample in samples:
            login = str(sample["role"])
            if login not in roles:
                resolved = await _actor_for(factory, login)
                if resolved is None:
                    print(ANSWER_EXIT_MESSAGES[EXIT_NO_ACCOUNT], file=sys.stderr)
                    return EXIT_NO_ACCOUNT
                roles[login] = resolved

        vector_provider = _CountingEmbedder(
            build_provider(
                settings,
                attempt_timeout=attempt_timeout_seconds(settings.ingestion_lease_seconds),
            )
        )
        generation_client = provider_client(timeout=30.0)
        # Wrapped so the runner can tell a sample that reached the provider from one that
        # only reached `answer`. The wrapper counts the calls it forwards; nothing else
        # about the provider changes.
        generator = _GenerationObserver(
            build_generation_provider(settings, client=generation_client)
        )
        # Built after the client, and only when the deployment asks for one. A rerank
        # adapter that fails to construct is a wiring error and stops the run, rather than
        # silently evaluating the un-reranked path under a configuration that claims
        # otherwise.
        built_reranker = _build_rerank_provider(settings, retrieval_config, generation_client)
        rerank_provider = _CountingReranker(built_reranker) if built_reranker else None

        # The starting snapshot, taken **before the first sample runs**. Read at the end it
        # would describe the world after the run: an ingestion job that replaced or deleted
        # a document mid-run would have the artifact attribute its end state to results that
        # were partly produced against the previous one - and a document outside the top-k
        # leaves no trace in the recorded evidence rows to reveal it. Code changed on disk
        # during a long run is the same problem: the digest would describe files the run
        # never executed.
        start_provenance = await _snapshot_provenance(
            settings,
            generator,
            retrieval_config,
            factory,
            roles,
            rerank_built=bool(rerank_provider),
            set_path=target.path,
            set_name=target.name,
        )

        for sample in samples:
            record = await _run_sample(
                factory,
                roles[str(sample["role"])],
                sample,
                vector_provider,
                generator,
                arguments.show_text,
                retrieval_config=retrieval_config,
                rerank_provider=rerank_provider,
            )
            records.append(record)
            # Only a **provider** error counts here, and only while it keeps running. A
            # provider error three times running is the quota or the endpoint refusing, not
            # one bad sample - but three consecutive *validation* errors say nothing about
            # the endpoint at all, and stopping there under a "the endpoint refused" label
            # sends an operator to look at the wrong service. The counter resets on any
            # other outcome, so scattered errors - which mean the endpoint answered in
            # between - keep the run going.
            consecutive_provider_errors = (
                consecutive_provider_errors + 1 if record.error == "provider_error" else 0
            )
            if consecutive_provider_errors >= PROVIDER_ERROR_STOP_AFTER:
                stopped_early = (
                    f"{PROVIDER_ERROR_STOP_AFTER} consecutive provider errors; "
                    "the endpoint refused the run"
                )
                break
    finally:
        if generation_client is not None:
            await generation_client.aclose()
        await engine.dispose()

    # The end-of-run snapshot, taken after the last sample and **before** the engine is
    # torn down further, so a change during the run is detectable rather than silent. A
    # failure here yields ``unmeasured``, which is reported as such and never as "nothing
    # changed".
    end_provenance = await _snapshot_provenance(
        settings,
        generator,
        retrieval_config,
        factory,
        roles,
        rerank_built=rerank_provider is not None,
        set_path=target.path,
        set_name=target.name,
    )

    artifact = await _build_artifact(
        arguments,
        settings,
        target,
        samples,
        records,
        stopped_early,
        generator,
        factory,
        roles,
        retrieval_config=retrieval_config,
        rerank_built=rerank_provider is not None,
        embedding_calls=getattr(vector_provider, "calls", 0),
        rerank_called=rerank_provider is not None and getattr(rerank_provider, "calls", 0) > 0,
        configuration=start_provenance or end_provenance,
        provenance_drift=_provenance_drift(start_provenance, end_provenance),
    )
    path = _write(artifact, arguments)
    _print_summary(artifact, arguments, path)
    return EXIT_OK


def effective_retrieval_config(settings: Settings) -> RetrievalConfig:
    """The retrieval shape this deployment actually serves.

    Built from settings rather than from the dataclass defaults, so an evaluation run
    measures the configured product rather than whatever the library happens to default to.
    """
    return RetrievalConfig(rerank_enabled=settings.rerank_enabled)


def _build_rerank_provider(
    settings: Settings, config: RetrievalConfig, client: httpx.AsyncClient
) -> Any | None:
    """A reranker only when the deployment asks for one.

    ``None`` when rerank is off is not a convenience: Part 12 established that a disabled
    rerank must perform **zero** provider work, so no client, no adapter and no request. When
    it is on, a missing key is a wiring error and raised here rather than discovered as a
    silent quality difference between two runs.

    The provider takes the same client as generation: both are OpenRouter calls in one run,
    and a second client is a second thing to close on the way out.
    """
    if not config.rerank_enabled:
        return None
    if not get_runtime(settings).connections["rerank"]:
        raise RerankUnavailableError("configure rerank in the manager panel")
    from app.providers.rerank import build_rerank_provider

    return build_rerank_provider(settings, client=client)


async def _build_artifact(
    arguments: argparse.Namespace,
    settings: Settings,
    target: EvaluationSet,
    samples: list[dict[str, Any]],
    records: list[SampleRecord],
    stopped_early: str | None,
    generator: Any | None,
    factory: Any,
    roles: dict[str, Role],
    *,
    retrieval_config: RetrievalConfig | None = None,
    rerank_built: bool = False,
    embedding_calls: int = 0,
    rerank_called: bool = False,
    configuration: dict[str, Any] | None = None,
    provenance_drift: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The run artifact: configuration, rows, figures, and what the figures are not."""
    retrieval_config = retrieval_config or effective_retrieval_config(settings)
    totals = RunTotals()
    for record in records:
        totals.add(record.usage)
    usage_totals = totals.as_dict()
    usage_totals["other_providers"] = {
        "embedding": {
            "host": "local",
            "billed": False,
            "calls": embedding_calls,
            "note": (
                "local Ollama; it reports no usage, so a count is the only figure that can "
                "be honest here. This block exists so a reader of the generation totals "
                "knows another provider was called too."
            ),
        },
        "rerank": {
            "called": rerank_called,
            "billed": bool(rerank_called),
            "note": (
                "generation summary totals are separate from rerank. Each sample's "
                "provider_usages records both ranking calls, including failed attempts; "
                "unknown figures and currency remain unknown."
            ),
        },
    }

    # Gold pairs and required facts are read once here, keyed by sample id, so each row of
    # the artifact carries what a re-scoring needs. Copied rather than referenced: the set
    # file may be edited between the run and the re-score, and a report that changed its
    # figures because someone fixed a typo is not a report anyone can check.
    gold_sources = {
        str(sample["id"]): [
            [str(gold["document_id"]), str(gold["section_id"])]
            for gold in sample.get("gold_sources") or ()
        ]
        for sample in samples
    }
    required_facts = {
        str(sample["id"]): [str(fact) for fact in sample.get("required_facts") or ()]
        for sample in samples
    }
    forbidden_documents = {
        str(sample["id"]): [str(value) for value in sample.get("forbidden_document_ids") or ()]
        for sample in samples
    }

    figures = _score(records, samples)
    failed = sum(1 for record in records if record.error)
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "run_id": _run_id(target.digest),
        "started_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "set": summary(target),
        # A run that executed every planned sample but failed some of them has not measured
        # what it set out to measure, and calling it complete would let a figure computed
        # over the survivors be read as the result. All three conditions have to hold.
        "complete": stopped_early is None and len(records) == len(samples) and failed == 0,
        "stopped_early_reason": stopped_early,
        "executed": len(records),
        "planned": len(samples),
        "failed": failed,
        "errors_by_reason": _errors_by_reason(records),
        "samples_with_a_usable_answer": sum(
            1 for record in records if record.error is None and record.abstained is not None
        ),
        # The snapshot taken **before the first sample**, not one taken here. Reading it
        # now would describe the world after the run and attribute it to results that were
        # partly produced against a different one.
        "configuration": configuration
        if configuration is not None
        else await _configuration(
            settings,
            generator,
            retrieval_config,
            factory,
            roles,
            set_path=target.path,
            set_name=target.name,
            rerank_built=rerank_built,
        ),
        "provenance_during_run": provenance_drift
        or {"status": "unmeasured", "note": "no comparison was taken for this run"},
        "show_text": bool(arguments.show_text),
        "figures": figures,
        # The execution cut is at the top level too, not only inside `figures`, because
        # `eval_score` reads it as a property of the run rather than of a metric - and
        # `compare` checks it against the rows like everything else it looks at.
        "execution": figures["execution"],
        "usage": usage_totals,
        "usage_note": (
            "provider-reported usage over every attempt, including attempts that failed "
            "after being billed. A *_complete figure covers every sample that reported it; "
            "a subtotal covers only those. Cost is the provider's figure, not an invoice."
        ),
        "limitations": LIMITATIONS,
        "samples": [
            {
                "sample_id": record.sample_id,
                "category": record.category,
                "role": record.role,
                "expected_behavior": record.expected_behavior,
                # The gold, the facts and the forbidden ids are copied in from the set file.
                # Without them the rows below cannot be re-scored by anyone, and
                # "reproducible" would mean only that the runner is deterministic - a much
                # smaller claim. They are the evaluation's own metadata, not document text:
                # section ids, document ids and short fact phrases, never a passage.
                "gold_sources": gold_sources.get(record.sample_id, []),
                "required_facts": required_facts.get(record.sample_id, []),
                "forbidden_document_ids": forbidden_documents.get(record.sample_id, []),
                "latency_ms": round(record.latency_ms, 1),
                "retrieval_measured": record.retrieval_measured,
                "retrieval_ranks": record.retrieval_ranks,
                "cited": record.cited,
                "abstained": record.abstained,
                "missing_parts": record.missing_parts,
                "claims_validated": record.claims_validated,
                "leak": record.leak,
                "usage": record.usage,
                "error": record.error,
                **(
                    {"answer": record.answer, "quotes": record.quotes}
                    if arguments.show_text
                    else {}
                ),
            }
            for record in records
        ],
    }


def _run_id(digest: str) -> str:
    """A run id that says which standard it measured.

    The digest is the standard's content hash, so two runs with the same id measured the
    same questions - which is the condition the guide sets before comparing two runs.
    """
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
    return f"{stamp}-{digest.split(':')[1][:12]}"


def _write(artifact: dict[str, Any], arguments: argparse.Namespace) -> Path:
    path = arguments.out or (DEFAULT_RUNS_DIR / f"{artifact['run_id']}.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    return path


def _print_summary(artifact: dict[str, Any], arguments: argparse.Namespace, path: Path) -> None:
    figures = artifact["figures"]
    retrieval = figures["retrieval"]
    if arguments.json:
        print(
            json.dumps(
                {
                    "run_id": artifact["run_id"],
                    "complete": artifact["complete"],
                    "executed": artifact["executed"],
                    "planned": artifact["planned"],
                    "failed": artifact["failed"],
                    "artifact": str(path),
                    "figures": figures,
                    "usage": artifact["usage"],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    print(f"run id: {artifact['run_id']}")
    print(
        f"set: {artifact['set']['name']} ({artifact['set']['samples']} samples, "
        f"digest {artifact['set']['digest'][:19]}…)"
    )
    # The first line, before any number, because a partial run read further down looks
    # like a complete one.
    print(f"complete: {artifact['complete']}")
    if artifact["stopped_early_reason"]:
        print(f"  stopped early: {artifact['stopped_early_reason']}")
    print(f"executed: {artifact['executed']} of {artifact['planned']}, {artifact['failed']} failed")
    recall = retrieval["recall_at_5"]
    by_category = recall.get("by_category") or {}
    print(
        f"recall@{RECALL_DEPTH}: overall={_number(recall.get('overall'))} "
        + " ".join(
            f"{name}={_number((entry or {}).get('mean'))}"
            for name, entry in sorted(by_category.items())
        )
    )
    by_role = recall.get("by_role") or {}
    if by_role:
        print(
            "  by role: "
            + " ".join(
                f"{name}={_number((entry or {}).get('mean'))}"
                for name, entry in sorted(by_role.items())
            )
        )
    # Printed beside the figure, because a recall of 1.0 next to a run where every sample
    # errored is the single most misleading thing this report could show. Retrieval really
    # did work in that run, and the number says nothing about whether the system answered.
    unmeasured = sum(
        1
        for record in (artifact.get("samples") or [])
        if not record.get("retrieval_measured", True)
    )
    if unmeasured:
        print(
            f"  note: {unmeasured} sample(s) had no retrieval and are excluded, not scored "
            "as misses"
        )
    errors = artifact.get("errors_by_reason") or {}
    if errors:
        print("  errors: " + ", ".join(f"{name}={count}" for name, count in sorted(errors.items())))
    # Printed beside the figures because it changes what they mean. A corpus that moved
    # mid-run leaves every number in this report describing a world that no longer exists,
    # and the recorded evidence cannot reveal it: a document that never reached the top-k
    # left no trace in the rows.
    drift = artifact.get("provenance_during_run") or {}
    unknown = drift.get("unknown") or []
    # What moved, named per axis and per role. A role whose corpus could not be read is
    # listed as unknown rather than folded into the moved set: its gap says nothing about
    # the roles that were read.
    moved: list[str] = []
    if drift.get("code_changed"):
        moved.append("code")
    by_role = drift.get("corpus_by_role") or {}
    changed_roles = sorted(
        login
        for login, entry in by_role.items()
        if entry.get("status") == "compared" and _role_moved(entry)
    )
    if changed_roles:
        moved.append("corpus(" + ", ".join(changed_roles) + ")")

    if drift.get("status") == "changed":
        print(
            f"  WARNING: {' and '.join(moved) or 'something'} changed while this run was in "
            "flight; the corpus and code blocks describe the run's starting point, so these "
            "figures are not comparable with another run"
        )
    elif drift.get("status") == "incomplete":
        print(
            "  WARNING: nothing moved among the axes that could be compared, but not every "
            "axis could be compared"
        )
    if unknown:
        # Printed whatever the status, because a proven change on one axis says nothing
        # about an axis that was never measured - and silence there reads as "unchanged".
        print(
            f"  note: {' and '.join(unknown)} could not be compared at all; for those, "
            "'not listed as changed' means unknown, not unchanged"
        )
    elif drift.get("status") == "unmeasured":
        print("  note: a change during the run could not be ruled out; nothing was compared")
    latency = figures["latency_ms"]
    print(f"latency ms: p50={_number(latency['p50'])} p95={_number(latency['p95'])}")
    leakage = figures["leakage"]
    print(
        f"leakage: {leakage['leaked_samples']} of {leakage['confidential_samples']} "
        f"confidential samples, rate={_number(leakage['observed_leak_rate'])}"
    )
    behaviour = figures["behaviour"]
    print(
        f"behaviour: {behaviour['checked']} checked, "
        f"{behaviour['abstained_when_a_refusal_was_expected']} refused as expected, "
        f"{behaviour['answered_when_an_answer_was_expected']} answered as expected"
    )
    usage = artifact["usage"]
    # The word matters here: a figure that covers every sample and one that covers only the
    # samples which happened to report are both consumption, and printing them the same way
    # is how a subtotal gets read as a total.
    tokens_label = "total" if usage["tokens_complete"] else "subtotal"
    cost_label = "cost" if usage["cost_complete"] else "cost-subtotal"
    if not usage["provider_was_called"]:
        print("usage: no provider request was made")
    else:
        print(
            f"usage: attempts={usage['attempts']} "
            f"{tokens_label}_tokens={usage['tokens_subtotal']} "
            f"{cost_label}={usage['cost_subtotal']} currency={usage['currency']}"
        )
    print(f"artifact: {path}")
    if arguments.show_text:
        print("note: this artifact contains document text (--show-text)")
    print(
        "limitations: claim support and required_facts coverage are human review, not scored here"
    )


def _role_moved(entry: dict[str, Any]) -> bool:
    """Whether one role's corpus differs between the two snapshots.

    Read from the recorded pair rather than from a stored verdict, so the printed warning
    and the artifact's own numbers are the same statement.
    """
    start, end = entry.get("start") or {}, entry.get("end") or {}
    return any(
        start.get(key) != end.get(key) for key in ("sha256", "documents", "sections", "chunks")
    )


def _number(value: Any) -> str:
    """A figure, or the word that says it was not measured."""
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def main(argv: list[str] | None = None) -> int:
    try:
        arguments = _parser().parse_args(argv)
    except SystemExit as exit_code:
        return int(exit_code.code or EXIT_USAGE)
    try:
        return asyncio.run(configured_run(_run, arguments, load_settings()))
    except KeyboardInterrupt:
        print("eval run interrupted", file=sys.stderr)
        return EXIT_PROVIDER
    except OSError as error:
        print(f"eval run failed: {type(error).__name__}", file=sys.stderr)
        return EXIT_PROVIDER


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
