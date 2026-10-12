"""Tests for re-scoring a run from its artifact.

The separation being tested is the point of the command: ``eval_run`` spends provider quota
and touches the database, while ``eval_score`` does neither. So a figure in a report can be
checked by a reader who has neither.

Two things are asserted. The re-score must reproduce the run's own figures, and it must
**notice** when they disagree. The second is the one that matters: a re-scoring that always
agrees is worthless, and the way it usually always agrees is by not checking anything. Each
group of figures therefore gets its own tamper test, so a check that was quietly dropped
from one group is caught even while the others still pass.
"""

import json
from pathlib import Path

import pytest

from app.cli import eval_run, eval_score


def _artifact(rows, figures=None, failed=None):
    """A run report whose header is consistent with its rows unless a test says otherwise."""
    count = failed if failed is not None else sum(1 for row in rows if row.get("error"))
    return {
        "schema_version": eval_run.ARTIFACT_SCHEMA_VERSION,
        "run_id": "test",
        "executed": len(rows),
        "planned": len(rows),
        "failed": count,
        "complete": count == 0,
        "samples": list(rows),
        "figures": figures if figures is not None else {},
        "execution": {},
    }


def _row(
    sample_id="D01",
    category="direct",
    role="employee",
    expected="answer",
    gold=None,
    forbidden=None,
    **kwargs,
):
    row = {
        "sample_id": sample_id,
        "category": category,
        "role": role,
        "expected_behavior": expected,
        "gold_sources": gold if gold is not None else [["HR-001", "HR-001-S1"]],
        "forbidden_document_ids": forbidden if forbidden is not None else [],
        "latency_ms": 100.0,
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
            }
        ],
        "cited": [
            {
                "document_id": "HR-001",
                "section_id": "HR-001-S1",
                "revision": "11111111-1111-4111-8111-111111111111",
            }
        ],
        "abstained": False if expected == "answer" else True,
        "error": None,
        "leak": None,
        "usage": {
            "reported": True,
            "provider_was_called": True,
            "attempts": 1,
            "total_tokens": "150",
        },
    }
    row.update(kwargs)
    return row


def _figures_for(artifact):
    """The header a correct runner would have written for these rows."""
    recomputed = eval_score.rescore(artifact)
    recall = recomputed["recall_at_5"]
    leak = recomputed["leakage"]
    behaviour = recomputed["behaviour"]
    latency = recomputed["latency_ms"]
    return {
        "retrieval": {
            "recall_at_5": {
                "overall": recall["overall"],
                "by_category": recall["by_category"],
                "by_role": recall["by_role"],
            },
            "mrr": {
                "by_category": recomputed["mrr"]["by_category"],
                "by_role": recomputed["mrr"]["by_role"],
            },
        },
        "leakage": {
            "leaked_samples": leak["leaked_samples"],
            "confidential_samples": leak["confidential_samples"],
            "observed_leak_rate": leak["observed_leak_rate"],
        },
        "behaviour": behaviour,
        "latency_ms": latency,
        "consumption": recomputed["consumption"],
    }


def _agreeing(rows):
    artifact = _artifact(rows)
    artifact["figures"] = _figures_for(artifact)
    recomputed = eval_score.rescore(artifact)
    artifact["execution"] = {
        "executed": recomputed["execution"]["executed"],
        "failed": recomputed["execution"]["failed"],
        "by_category": recomputed["execution"]["by_category"],
        "by_role": recomputed["execution"]["by_role"],
    }
    return artifact


# --- Re-scoring reproduces the figures -----------------------------------------------------


def test_a_row_with_its_gold_pair_found_scores_one():
    recomputed = eval_score.rescore(_artifact([_row()]))
    assert recomputed["recall_at_5"]["by_category"]["direct"]["mean"] == pytest.approx(1.0)


def test_the_gold_is_read_from_the_artifact_not_a_file_on_disk():
    artifact = _artifact([_row(gold=[["HR-001", "HR-001-S1"], ["HR-002", "HR-002-S1"]])])
    recomputed = eval_score.rescore(artifact)
    # One of two found. A re-score reading the set file instead would see the file's
    # single-pair copy and report 1.0.
    assert recomputed["recall_at_5"]["by_category"]["direct"]["mean"] == pytest.approx(0.5)


def test_rank_order_is_read_from_the_positions_the_run_recorded():
    row = _row()
    row["retrieval_ranks"] = [
        {
            "position": 2,
            "document_id": "HR-001",
            "section_id": "HR-001-S1",
            "fused_score": 0.02,
            "lexical_rank": 2,
            "vector_rank": 2,
        },
        {
            "position": 1,
            "document_id": "HR-009",
            "section_id": "HR-009-S1",
            "fused_score": 0.03,
            "lexical_rank": 1,
            "vector_rank": 1,
        },
    ]
    recomputed = eval_score.rescore(_artifact([row]))
    assert recomputed["recall_at_5"]["by_category"]["direct"]["mean"] == pytest.approx(1.0)
    assert recomputed["mrr"]["by_category"]["direct"]["mean"] == pytest.approx(0.5)


def test_results_are_grouped_by_role_as_well_as_by_category():
    rows = [
        _row("D1", role="employee"),
        _row("D2", role="manager", gold=[["HR-009", "HR-009-S1"]]),
    ]
    recomputed = eval_score.rescore(_artifact(rows))
    by_role = recomputed["recall_at_5"]["by_role"]
    assert by_role["employee"]["mean"] == pytest.approx(1.0)
    # The manager's sample asked for a section retrieval never returned.
    assert by_role["manager"]["mean"] == pytest.approx(0.0)


def test_a_row_with_no_gold_is_not_scored():
    row = _row(expected="abstain", gold=[])
    recomputed = eval_score.rescore(_artifact([row]))
    assert recomputed["recall_at_5"]["by_category"]["direct"]["mean"] is None


def test_a_row_whose_retrieval_never_ran_is_counted_as_executed_not_measured():
    row = _row(error="retrieval_error:EmbeddingProviderError", retrieval_measured=False)
    recomputed = eval_score.rescore(_artifact([row]))
    assert recomputed["recall_at_5"]["by_category"]["direct"]["measured"] == 0
    assert recomputed["recall_at_5"]["by_category"]["direct"]["excluded"] == 1
    assert recomputed["execution"]["retrieval_unmeasured"] == 1


def test_leak_is_recomputed_from_the_stored_pairs_not_the_flags():
    # The leak rows are read back from the pairs and the forbidden ids, not off the flag the
    # run wrote. Reading the flag would compare the run's leak arithmetic with itself.
    row = _row(
        "A1",
        category="access_security",
        forbidden=["MGR-002"],
        retrieval_ranks=[
            {
                "position": 1,
                "document_id": "MGR-002",
                "section_id": "MGR-002-S1",
                "revision": "r",
                "fused_score": 0.03,
                "lexical_rank": 1,
                "vector_rank": 1,
            }
        ],
        # The flag says it did not leak. The pairs say otherwise, and the pairs win.
        leak={"sample_id": "A1", "leaked": False, "via": []},
    )
    recomputed = eval_score.rescore(_artifact([row]))
    assert recomputed["leakage"]["leaked_samples"] == 1
    assert recomputed["leakage"]["confidential_samples"] == 1


def test_a_cited_forbidden_document_counts_even_when_retrieval_was_clean():
    row = _row(
        "A1",
        category="access_security",
        forbidden=["MGR-002"],
        cited=[{"document_id": "MGR-002", "section_id": "MGR-002-S9", "revision": "r"}],
        leak={"sample_id": "A1", "leaked": False, "via": []},
    )
    recomputed = eval_score.rescore(_artifact([row]))
    assert recomputed["leakage"]["leaked_samples"] == 1


def test_behaviour_counts_are_recomputed_from_the_rows():
    rows = [
        _row("D1", expected="answer", abstained=False),
        _row("U1", category="unanswerable", expected="abstain", gold=[], abstained=True),
    ]
    behaviour = eval_score.rescore(_artifact(rows))["behaviour"]
    assert behaviour["checked"] == 2
    assert behaviour["answered_when_an_answer_was_expected"] == 1
    assert behaviour["abstained_when_a_refusal_was_expected"] == 1


# --- Disagreement is noticed, one group at a time -------------------------------------------


def test_a_correct_artifact_reports_no_differences():
    artifact = _agreeing([_row()])
    assert eval_score.compare(artifact, eval_score.rescore(artifact)) == []


@pytest.mark.parametrize(
    "mutate, expected",
    [
        (
            lambda f: f["retrieval"]["recall_at_5"].__setitem__("overall", 0.123),
            "recall overall",
        ),
        (
            lambda f: f["retrieval"]["recall_at_5"]["by_category"]["direct"].__setitem__(
                "mean", 0.123
            ),
            "recall by_category",
        ),
        (
            lambda f: f["retrieval"]["recall_at_5"]["by_role"]["employee"].__setitem__("mean", 0.4),
            "recall by_role",
        ),
        (
            lambda f: f["retrieval"]["recall_at_5"]["by_category"]["direct"].__setitem__(
                "measured", 99
            ),
            "recall measured/excluded",
        ),
        (
            lambda f: f["retrieval"]["recall_at_5"]["by_category"]["direct"].__setitem__(
                "excluded", 99
            ),
            "recall measured/excluded",
        ),
        (
            lambda f: f["retrieval"]["mrr"]["by_category"]["direct"].__setitem__("mean", 0.9),
            "mrr by_category",
        ),
        (
            lambda f: f["retrieval"]["mrr"]["by_role"]["employee"].__setitem__("mean", 0.9),
            "mrr by_role",
        ),
        (lambda f: f["leakage"].__setitem__("leaked_samples", 3), "leaked samples"),
        (
            lambda f: f["leakage"].__setitem__("confidential_samples", 9),
            "confidential samples",
        ),
        (lambda f: f["leakage"].__setitem__("observed_leak_rate", 0.9), "observed leak rate"),
        (lambda f: f["behaviour"].__setitem__("checked", 999), "behaviour.checked"),
        (
            lambda f: f["behaviour"].__setitem__("answered_when_an_answer_was_expected", 7),
            "behaviour.answered_when_an_answer_was_expected",
        ),
        (lambda f: f["latency_ms"].__setitem__("p95", 999999.0), "latency p95"),
        (lambda f: f["latency_ms"].__setitem__("p50", 999999.0), "latency p50"),
        (lambda f: f["latency_ms"].__setitem__("measured", 42), "latency measured"),
        (
            lambda f: f["consumption"]["by_role"]["employee"].__setitem__("asked", 99),
            "consumption by_role",
        ),
        (
            lambda f: f["consumption"]["by_category"]["direct"].__setitem__("reporting_usage", 0),
            "consumption by_category",
        ),
        (
            lambda f: f["behaviour"]["by_role"]["employee"].__setitem__("abstained", 99),
            "behaviour by_role",
        ),
        (
            lambda f: f["behaviour"]["by_category"]["direct"].__setitem__("answered", 99),
            "behaviour by_category",
        ),
    ],
)
def test_each_group_of_figures_is_checked(mutate, expected):
    # One test per group, because a partial check hides exactly what it stopped looking at:
    # the figures that happen to agree say nothing about the ones that do not.
    artifact = _agreeing([_row()])
    mutate(artifact["figures"])
    differences = eval_score.compare(artifact, eval_score.rescore(artifact))
    assert any(expected in line for line in differences), differences


def test_the_execution_counts_are_checked():
    # The header's `failed` is compared against the rows, so a report that hid a failure in
    # its summary is caught even though every metric beneath it is honest.
    artifact = _agreeing([_row()])
    artifact["failed"] = 5
    assert any(
        "failed" in line for line in eval_score.compare(artifact, eval_score.rescore(artifact))
    )


def test_a_complete_flag_over_a_failed_sample_is_caught():
    # The rows carry one failure and the header still says the run completed. `complete` is
    # compared against what the rows imply, so this cannot pass.
    artifact = _agreeing([_row(error="provider_error"), _row("D02")])
    artifact["failed"] = 1
    artifact["complete"] = True
    differences = eval_score.compare(artifact, eval_score.rescore(artifact))
    assert any("complete" in line for line in differences)


def test_a_recall_that_was_not_measured_is_not_confused_with_zero():
    artifact = _agreeing([_row(expected="abstain", gold=[])])
    artifact["figures"]["retrieval"]["recall_at_5"]["overall"] = 0.0
    differences = eval_score.compare(artifact, eval_score.rescore(artifact))
    assert any("recall overall" in line for line in differences)


def test_latency_within_the_rounding_is_not_a_difference():
    # The runner rounds each row to one decimal place before serializing and computes its
    # percentiles from unrounded values, so the two differ by up to half a unit in the last
    # place. An exact comparison reports that on every run and trains a reader to ignore
    # the output; the tolerance is relative so it holds across the range latency spans.
    artifact = _agreeing([_row(latency_ms=100.0), _row("D02", latency_ms=100.0)])
    artifact["figures"]["latency_ms"]["p50"] += 0.04  # under the 0.05ms floor
    assert eval_score.compare(artifact, eval_score.rescore(artifact)) == []


def test_a_tiny_latency_is_compared_against_the_absolute_floor():
    # A relative tolerance alone would accept anything at all on a sub-millisecond
    # measurement, which is the one range where a wrong figure is hardest to see.
    assert eval_score._within_latency_tolerance(0.2, 0.24) is True
    assert eval_score._within_latency_tolerance(0.2, 0.9) is False


def test_a_relative_latency_difference_is_caught():
    artifact = _agreeing([_row(latency_ms=100.0)])
    artifact["figures"]["latency_ms"]["p50"] = 999.0
    assert any(
        "latency p50" in line for line in eval_score.compare(artifact, eval_score.rescore(artifact))
    )


# --- Blind spots are declared ---------------------------------------------------------------


def test_what_this_command_cannot_recheck_is_named():
    # A check that reports agreement while looking at a third of the numbers is worse than
    # no check, so the blind spots are part of the output rather than an omission from it.
    assert "usage" in eval_score.NOT_RECHECKED
    assert "configuration" in eval_score.NOT_RECHECKED
    for reason in eval_score.NOT_RECHECKED.values():
        assert reason


# --- The command ---------------------------------------------------------------------------


def test_the_command_exits_non_zero_on_a_mismatch(tmp_path):
    artifact = _agreeing([_row()])
    artifact["figures"]["retrieval"]["recall_at_5"]["overall"] = 0.0
    path = tmp_path / "run.json"
    path.write_text(json.dumps(artifact, ensure_ascii=False), encoding="utf-8")
    assert eval_score.main([str(path)]) == eval_score.EXIT_MISMATCH


def test_the_command_exits_zero_when_the_figures_agree(tmp_path):
    path = tmp_path / "run.json"
    path.write_text(json.dumps(_agreeing([_row()]), ensure_ascii=False), encoding="utf-8")
    assert eval_score.main([str(path)]) == eval_score.EXIT_OK


def test_the_command_names_what_it_did_not_recheck(tmp_path):
    path = tmp_path / "run.json"
    path.write_text(json.dumps(_agreeing([_row()]), ensure_ascii=False), encoding="utf-8")
    output = _printed(path)
    assert "not rechecked" in output
    assert "usage" in output


def test_an_unreadable_artifact_is_refused(tmp_path):
    path = tmp_path / "run.json"
    path.write_text("{not json", encoding="utf-8")
    assert eval_score.main([str(path)]) == eval_score.EXIT_ARTIFACT


def test_a_missing_artifact_is_refused(tmp_path):
    assert eval_score.main([str(tmp_path / "nope.json")]) == eval_score.EXIT_ARTIFACT


def test_a_json_file_that_is_not_a_run_report_is_refused(tmp_path):
    path = tmp_path / "run.json"
    path.write_text('{"hello": 1}', encoding="utf-8")
    assert eval_score.main([str(path)]) == eval_score.EXIT_ARTIFACT


def test_rescoring_a_real_artifact_agrees_with_its_header():
    # The end-to-end check, against an artifact the runner actually wrote rather than one
    # built here. Without it, every test above could pass against shapes the runner never
    # produces.
    runs = sorted(Path(eval_run.DEFAULT_RUNS_DIR).glob("*.json"))
    if not runs:
        pytest.skip("no run artifact on disk")
    artifact = json.loads(runs[-1].read_text(encoding="utf-8"))
    recomputed = eval_score.rescore(artifact)
    recorded = artifact["figures"]["retrieval"]["recall_at_5"]["overall"]
    if recorded is None:
        pytest.skip("the newest run measured no eligible sample")
    assert recomputed["recall_at_5"]["overall"] == pytest.approx(recorded)
    assert eval_score.compare(artifact, recomputed) == []


def _printed(path):
    import contextlib
    import io

    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        eval_score.main([str(path)])
    return buffer.getvalue()
