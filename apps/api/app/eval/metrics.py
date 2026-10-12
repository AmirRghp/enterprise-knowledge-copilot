"""The evaluation metrics, as pure functions over already-collected rows.

Every function here is total: it takes the rows a run recorded and returns numbers. None of
them opens a database, calls a provider, or reads a clock, which is what makes the same
numbers recomputable from an artifact after the run is over - and what lets each metric be
tested against a hand-computed fixture instead of against a run nobody can reproduce.

Three rules from `evaluation-guide.md` are load-bearing and are implemented literally:

* The unit is the ``(document_id, section_id)`` **pair**. Several chunks from one section
  count once, so a section that was chunked generously is not rewarded twice.
* Only a sample whose ``expected_behavior`` is ``answer`` and whose ``gold_sources`` is
  non-empty is eligible. Abstentions never enter recall, even when their gold sources
  explain the absence - and the count of excluded samples is reported rather than dropped.
* Recall of zero and recall that could not be computed are different facts. A sample with
  no eligible gold pair contributes ``None``, never ``0.0``; averaging it in would report a
  retrieval failure for a sample that had nothing to find.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

#: Recall is measured over this many ranked results, as the guide specifies.
RECALL_DEPTH = 5

#: The pair unit. Kept as a type alias rather than a class so a row can carry it directly.
Pair = tuple[str, str]


def pair_of(item: Any) -> Pair:
    """The ``(document_id, section_id)`` pair of a gold source or a retrieved hit.

    Accepts the shapes this module actually meets:

    * the evaluation file's ``{"document_id": …, "section_id": …}`` mappings,
    * a ``RetrievalHit``, whose identifiers live on ``.source`` and not on the hit itself,
    * a ``SourceRef``, or anything else already exposing both attributes.

    The ``.source`` hop is not optional convenience. ``RetrievalHit`` carries no
    ``document_id`` of its own, so a reader that only looked at the hit would find neither
    attribute and raise on every single retrieved row - which is every row a real run
    produces. A shape that is none of the above is a bug in the caller, and raising beats
    scoring it as a miss.
    """
    if isinstance(item, dict):
        try:
            return (str(item["document_id"]), str(item["section_id"]))
        except KeyError as error:
            raise ValueError(f"gold source is missing {error.args[0]!r}") from error

    document_id = getattr(item, "document_id", None)
    section_id = getattr(item, "section_id", None)
    if document_id is None or section_id is None:
        source = getattr(item, "source", None)
        if source is not None:
            return pair_of(source)
    if document_id is None or section_id is None:
        raise ValueError(f"cannot read a pair from {type(item).__name__}")
    return (str(document_id), str(section_id))


def ranked_pairs(hits: Sequence[Any]) -> list[Pair]:
    """The retrieved pairs in rank order, duplicates kept.

    Duplicates are kept because the guide is explicit that a repeated chunk still occupies
    a position: removing them would hand a sample extra places in the top five and inflate
    both recall and MRR. The *counting* of a pair is what ignores duplicates, not this.
    """
    return [pair_of(hit) for hit in hits]


def distinct(pairs: Iterable[Pair]) -> list[Pair]:
    """Distinct pairs, in first-seen order."""
    seen: set[Pair] = set()
    ordered: list[Pair] = []
    for pair in pairs:
        if pair not in seen:
            seen.add(pair)
            ordered.append(pair)
    return ordered


@dataclass(frozen=True, slots=True)
class RecallResult:
    """One sample's recall, with the denominator that produced it.

    ``eligible`` is false when the sample has no eligible gold pair. That is the case
    ``recall`` alone cannot express: ``0.0`` and ``None`` mean different things to whoever
    reads the report, and only one of them is a retrieval failure.
    """

    eligible: bool
    recall: float | None
    gold_pairs: tuple[Pair, ...]
    eligible_pairs: tuple[Pair, ...]
    hit_pairs: tuple[Pair, ...]
    excluded_reason: str | None = None


@dataclass(frozen=True, slots=True)
class MRRResult:
    """One sample's reciprocal rank.

    ``rank`` is the one-based position of the first eligible gold pair, or ``None`` when
    none was found - which scores ``0.0``, not "not applicable", because the sample was
    eligible and the system simply did not put the answer first.
    """

    eligible: bool
    reciprocal_rank: float | None
    rank: int | None
    excluded_reason: str | None = None


@dataclass(frozen=True, slots=True)
class Ratio:
    """A numerator over a denominator, where zero and unmeasured are different facts.

    ``denominator == 0`` yields ``None`` for the ratio, not ``0.0``: "no sample had this
    property" is not "no sample leaked". The guide asks for both the raw count and the
    rate, and this is the shape that keeps the two from being confused.
    """

    numerator: int
    denominator: int
    value: float | None

    @classmethod
    def of(cls, numerator: int, denominator: int) -> Ratio:
        return cls(
            numerator=numerator,
            denominator=denominator,
            value=(numerator / denominator) if denominator > 0 else None,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "numerator": self.numerator,
            "denominator": self.denominator,
            "rate": self.value,
        }


def eligible_gold_pairs(sample: dict[str, Any], allowed: Sequence[Pair] | None) -> tuple[Pair, ...]:
    """The gold pairs this sample asks for, restricted to what the role may read.

    ``allowed`` is the actor's authorized pair list, or ``None`` when it was not recorded.
    A gold pair the role cannot read cannot be found by a correct system, so counting it
    would penalise the system for the allowlist working. The guide requires the same rule
    for recall and states it for mixed public/confidential questions in particular.
    """
    gold = distinct(pair_of(item) for item in sample.get("gold_sources") or ())
    if allowed is None:
        return tuple(gold)
    permitted = set(allowed)
    return tuple(pair for pair in gold if pair in permitted)


def is_eligible(sample: dict[str, Any]) -> bool:
    """Whether a sample enters recall and MRR at all.

    Abstentions are excluded even when they carry gold sources naming the sections that
    explain the missing policy, because those sections are the *wrong* answer here.
    """
    return sample.get("expected_behavior") == "answer" and bool(sample.get("gold_sources"))


def score_recall(
    sample: dict[str, Any],
    retrieved: Sequence[Any],
    *,
    allowed: Sequence[Pair] | None = None,
    depth: int = RECALL_DEPTH,
) -> RecallResult:
    """Recall@``depth`` for one sample, over the pair unit."""
    if not is_eligible(sample):
        return RecallResult(
            eligible=False,
            recall=None,
            gold_pairs=(),
            eligible_pairs=(),
            hit_pairs=(),
            excluded_reason=_exclusion_reason(sample),
        )

    gold = eligible_gold_pairs(sample, allowed)
    if not gold:
        # Eligible by behaviour, but every gold pair is one this role cannot read. There is
        # nothing to find, so this is not a miss - it is an unmeasured sample.
        return RecallResult(
            eligible=True,
            recall=None,
            gold_pairs=tuple(distinct(pair_of(item) for item in sample["gold_sources"])),
            eligible_pairs=(),
            hit_pairs=(),
            excluded_reason="every gold pair is outside the role's authorized set",
        )

    pairs = ranked_pairs(retrieved)
    top = set(distinct(pairs[:depth]))
    hits = tuple(pair for pair in gold if pair in top)
    return RecallResult(
        eligible=True,
        recall=len(hits) / len(gold),
        gold_pairs=tuple(gold),
        eligible_pairs=tuple(gold),
        hit_pairs=hits,
    )


def score_mrr(
    sample: dict[str, Any],
    retrieved: Sequence[Any],
    *,
    allowed: Sequence[Pair] | None = None,
) -> MRRResult:
    """Reciprocal rank of the first eligible gold pair for one sample.

    Unlike recall this does not stop at the top five: the guide's MRR is over the whole
    ranked list, and a pair found at position seven is still the first right answer.
    """
    if not is_eligible(sample):
        return MRRResult(
            eligible=False,
            reciprocal_rank=None,
            rank=None,
            excluded_reason=_exclusion_reason(sample),
        )
    gold = set(eligible_gold_pairs(sample, allowed))
    if not gold:
        return MRRResult(
            eligible=True,
            reciprocal_rank=None,
            rank=None,
            excluded_reason="every gold pair is outside the role's authorized set",
        )
    for index, pair in enumerate(ranked_pairs(retrieved), start=1):
        if pair in gold:
            return MRRResult(eligible=True, reciprocal_rank=1.0 / index, rank=index)
    return MRRResult(eligible=True, reciprocal_rank=0.0, rank=None)


def _exclusion_reason(sample: dict[str, Any]) -> str:
    if sample.get("expected_behavior") != "answer":
        return f"expected_behavior is {sample.get('expected_behavior')!r}, not 'answer'"
    return "gold_sources is empty"


@dataclass(slots=True)
class Aggregate:
    """A mean over the samples that were actually measured.

    ``measured`` and ``excluded`` are both reported. A mean with no denominator is not a
    number anyone should read, so this refuses to produce one.
    """

    measured: int = 0
    excluded: int = 0
    total: float = 0.0

    def add(self, value: float | None, eligible: bool, excluded_reason: str | None = None) -> None:
        if value is None:
            self.excluded += 1
            return
        self.measured += 1
        self.total += value

    @property
    def mean(self) -> float | None:
        """The mean over measured samples, or ``None`` when nothing was measured."""
        if self.measured == 0:
            return None
        return self.total / self.measured

    def as_dict(self) -> dict[str, Any]:
        return {
            "measured": self.measured,
            "excluded": self.excluded,
            "mean": self.mean,
        }


def percentile(values: Sequence[float], fraction: float) -> float | None:
    """A percentile by linear interpolation over the sorted values.

    ``None`` for an empty input rather than ``0.0``: no request took a measurable time is
    not the same as every request being instant, and the guide asks for p50 and p95
    alongside the error count for exactly that reason.
    """
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = fraction * (len(ordered) - 1)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def forbidden_documents(sample: dict[str, Any]) -> tuple[str, ...]:
    """The document ids this sample marks as out of bounds for its role.

    ``forbidden_document_ids`` holds **document ids**, not ``(document, section)`` pairs -
    reading it as pairs would raise on every confidential sample, and matching only the
    expected pair would miss a leak into any other section of the same document, which is
    the likelier way one appears.
    """
    return tuple(distinct_ids(str(item) for item in sample.get("forbidden_document_ids") or ()))


def distinct_ids(values: Iterable[str]) -> list[str]:
    """Distinct identifiers, in first-seen order."""
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def leaks_in(retrieved: Sequence[Any], forbidden: Sequence[str]) -> tuple[Pair, ...]:
    """Forbidden **documents** that appear in the retrieved pairs.

    The comparison is on the document half: a leak is any section of a forbidden document,
    not only the one a sample happened to name as a pair.
    """
    forbidden_set = set(forbidden)
    return tuple(distinct(pair for pair in ranked_pairs(retrieved) if pair[0] in forbidden_set))


@dataclass(slots=True)
class LeakFinding:
    """One confidential sample's leak result, kept per sample.

    Per-sample rather than only a total: the guide asks for the count of samples that
    leaked *and* the rate, and an operator chasing a leak needs the sample ids, not a
    single number.
    """

    sample_id: str
    leaked: bool
    via: tuple[str, ...]
    retrieved: tuple[Pair, ...] = field(default=())
    cited: tuple[Pair, ...] = field(default=())

    def as_dict(self) -> dict[str, Any]:
        return {
            "sample_id": self.sample_id,
            "leaked": self.leaked,
            "via": list(self.via),
            "leaked_retrieval_pairs": [list(pair) for pair in self.retrieved],
            "leaked_citation_pairs": [list(pair) for pair in self.cited],
        }


def check_leak(
    sample: dict[str, Any],
    retrieved: Sequence[Any],
    cited: Sequence[Any] = (),
) -> LeakFinding | None:
    """One sample's leak check, or ``None`` when it carries nothing forbidden.

    Two channels are checked, because a system can pass one and fail the other. A document
    absent from the results but named in a citation is still a leak - the citation is what
    the reader sees - and the guide counts a source or endpoint that reveals existence as a
    leak even when the answer text looks safe.
    """
    forbidden = forbidden_documents(sample)
    if not forbidden:
        return None
    in_results = leaks_in(retrieved, forbidden)
    in_citations = leaks_in(cited, forbidden)
    via: list[str] = []
    if in_results:
        via.append("retrieval_results")
    if in_citations:
        via.append("citations")
    return LeakFinding(
        sample_id=str(sample.get("id", "")),
        leaked=bool(via),
        via=tuple(via),
        retrieved=in_results,
        cited=in_citations,
    )
