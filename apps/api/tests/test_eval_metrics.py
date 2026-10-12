"""Tests for the evaluation metrics.

Every expected value here is worked out by hand from the fixture and written as a literal.
The alternative - asserting that the function agrees with another expression built from the
same helper - passes identically when both are wrong, which is the failure mode this
project has now hit repeatedly in its other parts.

The cases chosen are the ones that decide whether the numbers mean anything:

* a section reached by several chunks counts **once**;
* a gold pair the role cannot read is **not** a miss;
* a pair at position six is outside recall@5 but still inside MRR;
* recall of zero, a sample with nothing to find, and a sample that was never run are three
  different facts and must not print as one.
"""

from uuid import uuid4

import pytest

from app.documents.chunking import ChunkRecord
from app.eval.metrics import (
    Aggregate,
    Ratio,
    check_leak,
    is_eligible,
    leaks_in,
    percentile,
    ranked_pairs,
    score_mrr,
    score_recall,
)
from app.retrieval.contracts import SourceRef


def sample(**overrides):
    """A direct-answer sample with one gold pair, unless overridden."""
    base = {
        "id": "T1",
        "category": "direct",
        "role": "employee",
        "question": "سؤال",
        "expected_behavior": "answer",
        "expected_answer": "پاسخ",
        "required_facts": [" fact"],
        "gold_sources": [{"document_id": "HR-001", "section_id": "HR-001-S1"}],
        "forbidden_document_ids": [],
    }
    base.update(overrides)
    return base


class Hit:
    """A retrieval hit in the shape `retrieve` actually returns.

    Built from the real ``RetrievalHit``, not a stand-in. ``RetrievalHit`` carries no
    ``document_id`` of its own - the identifiers live under ``chunk``, and ``source`` is a
    property that builds a ``SourceRef`` from it. A hand-rolled object with a plain
    ``.source`` attribute would let these tests pass against a shape no real run produces,
    which is how a reader that forgot the ``.source`` hop survived in the first place.
    """

    def __init__(self, document_id, section_id):
        self.chunk = ChunkRecord(
            chunk_id=uuid4(),
            document_id=document_id,
            section_id=section_id,
            revision="00000000-0000-4000-8000-000000000000",
            ordinal=0,
            text="متن آزمون",
            access_role="employee",
        )

    @property
    def source(self):
        return SourceRef(
            document_id=self.chunk.document_id,
            section_id=self.chunk.section_id,
            revision=self.chunk.revision,
        )


# --- Recall -------------------------------------------------------------------------------


def test_recall_one_of_two_gold_pairs():
    # Gold: (HR-001, S1) and (HR-002, S1). One retrieved -> 1/2 = 0.5.
    subject = sample(
        gold_sources=[
            {"document_id": "HR-001", "section_id": "HR-001-S1"},
            {"document_id": "HR-002", "section_id": "HR-002-S1"},
        ]
    )
    result = score_recall(subject, [Hit("HR-001", "HR-001-S1")])
    assert result.eligible is True
    assert result.recall == pytest.approx(0.5)
    assert result.hit_pairs == (("HR-001", "HR-001-S1"),)


def test_recall_counts_a_pair_once_however_many_chunks_reached_it():
    # One gold pair, four chunks of that same section filling the whole top five. Counting
    # chunks rather than pairs would score this 4/4 - or, with a single gold pair, hide
    # behind any value of 1.0 and pass anyway. The fixture therefore has to make the
    # difference observable: the duplicates sit beside a *second* gold pair that is never
    # found, so a chunk-counting reader returns 4/2 = 2.0 and is capped out.
    subject = sample(
        gold_sources=[
            {"document_id": "HR-001", "section_id": "HR-001-S1"},
            {"document_id": "HR-009", "section_id": "HR-009-S1"},
        ]
    )
    result = score_recall(
        subject,
        [
            Hit("HR-001", "HR-001-S1"),
            Hit("HR-001", "HR-001-S1"),
            Hit("HR-001", "HR-001-S1"),
            Hit("HR-001", "HR-001-S1"),
        ],
    )
    # One of the two gold pairs was found, and it was found once.
    assert result.recall == pytest.approx(0.5)
    assert result.hit_pairs == (("HR-001", "HR-001-S1"),)


def test_recall_ignores_a_pair_beyond_the_fifth():
    subject = sample()
    sixth = [Hit(f"D{i}", f"D{i}-S1") for i in range(5)] + [Hit("HR-001", "HR-001-S1")]
    result = score_recall(subject, sixth)
    assert len(sixth) == 6
    assert result.recall == pytest.approx(0.0)
    assert result.hit_pairs == ()


def test_recall_of_zero_is_not_the_same_as_unmeasured():
    # Eligible, with a gold pair, and nothing found: that is a retrieval miss, 0.0.
    miss = score_recall(sample(), [Hit("HR-009", "HR-009-S1")])
    assert miss.eligible is True
    assert miss.recall == pytest.approx(0.0)

    # Not eligible: the system is not being marked down for a refusal.
    refusal = score_recall(sample(expected_behavior="abstain"), [])
    assert refusal.eligible is False
    assert refusal.recall is None
    assert "abstain" in (refusal.excluded_reason or "")


def test_recall_excludes_a_gold_pair_the_role_cannot_read():
    # The pair is the gold answer, but this role may read nothing, so it cannot be found.
    subject = sample()
    result = score_recall(subject, [], allowed=[("HR-009", "HR-009-S1")])
    assert result.eligible is True
    # Nothing to look for: unmeasured, not a miss.
    assert result.recall is None
    assert result.excluded_reason is not None


def test_a_duplicated_gold_source_is_one_pair_not_two():
    # The same section listed twice in the gold file is one thing to find. Asserting only
    # on the ratio would not catch it: with a duplicated gold, both the numerator and the
    # denominator double and the ratio stays 1.0. The counts are therefore asserted too -
    # that is where the difference is actually visible.
    subject = sample(
        gold_sources=[
            {"document_id": "HR-001", "section_id": "HR-001-S1"},
            {"document_id": "HR-001", "section_id": "HR-001-S1"},
        ]
    )
    result = score_recall(subject, [Hit("HR-001", "HR-001-S1")])
    assert result.recall == pytest.approx(1.0)
    assert len(result.gold_pairs) == 1
    assert len(result.hit_pairs) == 1


def test_recall_ignores_an_abstention_with_gold_sources():
    # The guide is explicit: an abstention's gold sources explain the absence, so counting
    # them would score a refusal as a failure.
    subject = sample(expected_behavior="abstain")
    assert is_eligible(subject) is False
    assert score_recall(subject, []).recall is None


def test_recall_excludes_a_missing_gold_list_from_the_denominator():
    subject = sample(gold_sources=[])
    result = score_recall(subject, [Hit("HR-001", "HR-001-S1")])
    assert result.eligible is False
    assert result.recall is None


# --- MRR ---------------------------------------------------------------------------------


def test_mrr_first_place_is_one():
    subject = sample()
    result = score_mrr(subject, [Hit("HR-001", "HR-001-S1"), Hit("HR-009", "HR-009-S1")])
    assert result.reciprocal_rank == pytest.approx(1.0)
    assert result.rank == 1


def test_mrr_third_place_is_one_third():
    subject = sample()
    retrieved = [
        Hit("A", "A-S1"),
        Hit("B", "B-S1"),
        Hit("HR-001", "HR-001-S1"),
    ]
    result = score_mrr(subject, retrieved)
    assert result.reciprocal_rank == pytest.approx(1 / 3)
    assert result.rank == 3


def test_mrr_reaches_beyond_the_recall_depth():
    # Position six: outside recall@5, still the first right answer, so 1/6.
    subject = sample()
    retrieved = [Hit(f"D{i}", f"D{i}-S1") for i in range(5)] + [Hit("HR-001", "HR-001-S1")]
    assert score_recall(subject, retrieved).recall == pytest.approx(0.0)
    result = score_mrr(subject, retrieved)
    assert result.rank == 6
    assert result.reciprocal_rank == pytest.approx(1 / 6)


def test_mrr_of_a_nothing_found_eligible_sample_is_zero_not_none():
    result = score_mrr(sample(), [Hit("X", "X-S1")])
    assert result.eligible is True
    assert result.reciprocal_rank == pytest.approx(0.0)
    assert result.rank is None


def test_mrr_gives_a_duplicate_a_position_and_does_not_reuse_it():
    # Two chunks of the same section: the first is rank 1, and neither earns a second hit.
    subject = sample()
    result = score_mrr(subject, [Hit("HR-001", "HR-001-S1"), Hit("HR-001", "HR-001-S1")])
    assert result.rank == 1
    assert result.reciprocal_rank == pytest.approx(1.0)


# --- Leakage -----------------------------------------------------------------------------


def test_leak_is_found_in_results_and_in_citations():
    subject = sample(forbidden_document_ids=["MGR-002"])
    finding = check_leak(subject, [Hit("MGR-002", "MGR-002-S1")])
    assert finding is not None
    assert finding.leaked is True
    assert finding.via == ("retrieval_results",)


def test_leak_in_citations_alone_still_counts():
    # The document never reached retrieval but a citation names it: the reader still learns
    # it exists, which the guide counts even when the answer text looks safe.
    subject = sample(forbidden_document_ids=["MGR-002"])
    finding = check_leak(subject, [], cited=[Hit("MGR-002", "MGR-002-S9")])
    assert finding.leaked is True
    assert finding.via == ("citations",)


def test_leak_matches_on_the_document_not_the_pair():
    # Any section of a forbidden document is a leak, not only the pair that was expected.
    subject = sample(forbidden_document_ids=["MGR-002"])
    finding = check_leak(subject, [Hit("MGR-002", "MGR-002-S7")])
    assert finding.leaked is True


def test_no_leak_when_the_forbidden_document_is_absent():
    subject = sample(forbidden_document_ids=["MGR-002"])
    finding = check_leak(subject, [Hit("HR-001", "HR-001-S1")])
    assert finding.leaked is False
    assert finding.via == ()


def test_a_sample_with_nothing_forbidden_is_not_a_leak_check():
    assert check_leak(sample(), [Hit("MGR-002", "MGR-002-S1")]) is None


def test_leaks_in_reports_each_forbidden_pair_once():
    found = leaks_in(
        [Hit("MGR-002", "MGR-002-S1"), Hit("MGR-002", "MGR-002-S2")],
        ["MGR-002"],
    )
    assert len(found) == 2
    assert found == (("MGR-002", "MGR-002-S1"), ("MGR-002", "MGR-002-S2"))


# --- Aggregation -------------------------------------------------------------------------


def test_aggregate_mean_ignores_unmeasured_samples():
    aggregate = Aggregate()
    aggregate.add(1.0, eligible=True)
    aggregate.add(0.5, eligible=True)
    aggregate.add(None, eligible=True, excluded_reason="no eligible gold pair")
    assert aggregate.measured == 2
    assert aggregate.excluded == 1
    assert aggregate.mean == pytest.approx(0.75)


def test_aggregate_with_nothing_measured_has_no_mean():
    aggregate = Aggregate()
    aggregate.add(None, eligible=True, excluded_reason="reason")
    assert aggregate.mean is None
    assert aggregate.measured == 0


def test_ratio_distinguishes_zero_of_nothing_from_zero_of_something():
    assert Ratio.of(0, 7).value == pytest.approx(0.0)
    assert Ratio.of(0, 7).denominator == 7
    # No sample had the property at all: not a rate of zero.
    assert Ratio.of(0, 0).value is None


# --- Percentiles -------------------------------------------------------------------------


def test_percentile_of_nothing_is_none_not_zero():
    assert percentile([], 0.5) is None


def test_p50_and_p95_of_a_known_list():
    values = [1.0, 2.0, 3.0, 4.0, 100.0]
    # p50: position 0.5 * 4 = 2.0, exactly the middle element.
    assert percentile(values, 0.5) == pytest.approx(3.0)
    # p95: position 0.95 * 4 = 3.8, so 4 + 0.8 * (100 - 4) = 80.8.
    # Worked out here rather than read off the implementation: the first version of this
    # expectation said 96.4, which assumed a weight of 0.95 across the whole span instead
    # of 0.8 of the way along a four-step range - the test was wrong, the code was not.
    assert percentile(values, 0.95) == pytest.approx(80.8)


def test_percentile_of_one_value():
    assert percentile([7.5], 0.95) == pytest.approx(7.5)


# --- Pair handling -----------------------------------------------------------------------


def test_ranked_pairs_keeps_duplicates_because_a_position_is_occupied():
    pairs = ranked_pairs([Hit("A", "A-S1"), Hit("A", "A-S1"), Hit("B", "B-S1")])
    assert pairs == [("A", "A-S1"), ("A", "A-S1"), ("B", "B-S1")]


def test_a_malformed_gold_source_is_refused_rather_than_scored_as_a_miss():
    with pytest.raises(ValueError):
        from app.eval.metrics import pair_of

        pair_of({"document_id": "HR-001"})
