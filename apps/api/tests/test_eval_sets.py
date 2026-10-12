"""Tests for reading and checking evaluation sets.

Two things are being checked here, and only one of them is about this module's code.

The first is the loader's behaviour on hand-built sets: a malformed file is refused with a
fixed reason rather than being half-loaded, and a development set that overlaps the
standard is rejected.

The second is a check on the *shipped* 40-sample standard itself. The guide makes several
claims about that file - the 14/10/8/8 split, the eligibility rule, the seven confidential
samples - and this module's whole reporting rests on them. If the file and the guide have
drifted apart, every number the runner produces is measured against the wrong contract.
Those tests read the real file, so they fail the moment someone edits a sample without
updating the guide.
"""

import json
from pathlib import Path

import pytest

from app.eval.sets import (
    EvaluationSetError,
    check_separation,
    load_set,
    select,
    summary,
)

# The standard set lives in the repository, not in the package: `eval/questions.jsonl` at
# the project root. Counted from this file rather than from `app/`, which is where
# `app.ingestion.corpus` counts to find the corpus directory - same repository root, one
# level apart, and the difference is exactly the kind of thing that silently points a test
# at a path that does not exist.
STANDARD = Path(__file__).resolve().parents[3] / "eval" / "questions.jsonl"


def write_set(tmp_path, rows, name="questions.jsonl"):
    path = tmp_path / name
    path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )
    return path


def row(**overrides):
    base = {
        "id": "X1",
        "category": "direct",
        "role": "employee",
        "question": "سؤال نمونه",
        "expected_behavior": "answer",
        "expected_answer": "پاسخ",
        "required_facts": [" fact"],
        "gold_sources": [{"document_id": "HR-001", "section_id": "HR-001-S1"}],
        "forbidden_document_ids": [],
    }
    base.update(overrides)
    return base


# --- Loading ------------------------------------------------------------------------------


def test_a_well_formed_set_loads(tmp_path):
    path = write_set(tmp_path, [row(), row(id="X2", question="سؤال دوم")])
    loaded = load_set(path)
    assert len(loaded) == 2
    assert loaded.digest.startswith("sha256:")


def test_blank_lines_are_skipped(tmp_path):
    path = tmp_path / "q.jsonl"
    path.write_text(
        json.dumps(row(), ensure_ascii=False)
        + "\n\n"
        + json.dumps(row(id="X2"), ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )
    assert len(load_set(path)) == 2


@pytest.mark.parametrize(
    "mutation, reason",
    [
        ({"expected_behavior": "shrug"}, "unknown expected_behavior"),
        ({"category": "mystery"}, "unknown category"),
        ({"role": "root"}, "unknown role"),
    ],
)
def test_an_unknown_enumerated_value_is_refused(tmp_path, mutation, reason):
    path = write_set(tmp_path, [row(**mutation)])
    with pytest.raises(EvaluationSetError, match=reason):
        load_set(path)


@pytest.mark.parametrize("field", ["id", "category", "role", "question", "expected_behavior"])
def test_a_missing_required_field_is_refused(tmp_path, field):
    broken = row()
    del broken[field]
    path = write_set(tmp_path, [broken])
    with pytest.raises(EvaluationSetError, match=field):
        load_set(path)


def test_a_duplicate_id_is_refused(tmp_path):
    path = write_set(tmp_path, [row(), row()])
    with pytest.raises(EvaluationSetError, match="repeats sample id"):
        load_set(path)


def test_a_malformed_gold_source_is_refused_not_scored_later(tmp_path):
    path = write_set(tmp_path, [row(gold_sources=[{"document_id": "HR-001"}])])
    with pytest.raises(ValueError):
        load_set(path)


def test_an_empty_set_is_refused(tmp_path):
    path = tmp_path / "empty.jsonl"
    path.write_text("\n", encoding="utf-8")
    with pytest.raises(EvaluationSetError, match="empty"):
        load_set(path)


def test_a_missing_file_is_refused(tmp_path):
    with pytest.raises(EvaluationSetError, match="no evaluation set"):
        load_set(tmp_path / "nope.jsonl")


def test_the_refusal_message_never_echoes_the_sample_text(tmp_path):
    # A set file is operator input, but its questions are the evaluation's own content and
    # an error that quotes one would put it in a terminal and a bug report.
    path = write_set(tmp_path, [row(expected_behavior="shrug", question="متن محرمانهٔ نمونه")])
    with pytest.raises(EvaluationSetError) as caught:
        load_set(path)
    assert "متن محرمانهٔ نمونه" not in str(caught.value)


# --- Selection ----------------------------------------------------------------------------


def test_select_filters_by_category_and_role(tmp_path):
    rows = [
        row(id="A", category="direct", role="employee"),
        row(id="B", category="access_security", role="manager"),
        row(id="C", category="direct", role="manager"),
    ]
    loaded = load_set(write_set(tmp_path, rows))
    assert [s["id"] for s in select(loaded, categories=["direct"])] == ["A", "C"]
    assert [s["id"] for s in select(loaded, roles=["manager"])] == ["B", "C"]
    assert [s["id"] for s in select(loaded, categories=["direct"], roles=["manager"])] == ["C"]


def test_select_keeps_file_order_so_two_runs_are_comparable(tmp_path):
    rows = [row(id=name, question=f"سؤال {name}") for name in ("C", "A", "B")]
    loaded = load_set(write_set(tmp_path, rows))
    assert [s["id"] for s in select(loaded)] == ["C", "A", "B"]


def test_limit_takes_a_prefix_not_a_shuffle(tmp_path):
    rows = [row(id=f"S{n:02d}") for n in range(1, 6)]
    loaded = load_set(write_set(tmp_path, rows))
    assert [s["id"] for s in select(loaded, limit=3)] == ["S01", "S02", "S03"]


# --- Separation ----------------------------------------------------------------------------


def _set_from(path, name):
    return load_set(path, name=name)


def test_a_disjoint_development_set_is_separated(tmp_path):
    standard = load_set(write_set(tmp_path, [row(id="A", question="الف")], name="std.jsonl"))
    development = load_set(
        write_set(tmp_path, [row(id="D", question="ب")], name="dev.jsonl"), name="dev"
    )
    report = check_separation(development, standard)
    assert report.checked is True
    assert report.separated is True


def test_a_shared_id_is_detected(tmp_path):
    standard = load_set(write_set(tmp_path, [row(id="A", question="الف")], name="std.jsonl"))
    development = load_set(
        write_set(tmp_path, [row(id="A", question="ب")], name="dev.jsonl"), name="dev"
    )
    report = check_separation(development, standard)
    assert report.separated is False
    assert report.overlapping_ids == ("A",)


def test_a_shared_question_is_detected_even_with_a_different_id(tmp_path):
    # The case an id-only check would miss: the two sets ask the same thing under different
    # names, so tuning on the second still moves the first's result and the overlap is
    # invisible to anyone reading ids.
    standard = load_set(write_set(tmp_path, [row(id="A", question="همین سؤال")], name="std.jsonl"))
    development = load_set(
        write_set(tmp_path, [row(id="D99", question="همین سؤال")], name="dev.jsonl"), name="dev"
    )
    report = check_separation(development, standard)
    assert report.separated is False
    assert report.overlapping_questions == ("D99",)


def test_whitespace_differences_are_not_an_overlap(tmp_path):
    # A run of spaces and a trailing space are not a different question: normalized, the
    # two are the same string, so the overlap **is** reported. The normalization exists to
    # catch exactly this - a question that differs only in spacing is the same question,
    # and letting it into a development set would tune on the standard through a typo.
    standard = load_set(
        write_set(tmp_path, [row(id="A", question="دو کلمه اینجا")], name="std.jsonl")
    )
    development = load_set(
        write_set(tmp_path, [row(id="D", question="  دو  کلمه   اینجا ")], name="dev.jsonl"),
        name="dev",
    )
    report = check_separation(development, standard)
    assert report.separated is False
    assert report.overlapping_questions == ("D",)


def test_a_genuine_rewording_is_not_an_overlap(tmp_path):
    # The other half: normalization must not collapse distinct questions into one, or a
    # development set would refuse samples that are legitimately its own.
    standard = load_set(
        write_set(tmp_path, [row(id="A", question="دو کلمه اینجا")], name="std.jsonl")
    )
    development = load_set(
        write_set(tmp_path, [row(id="D", question="سه کلمه آنجا")], name="dev.jsonl"),
        name="dev",
    )
    assert check_separation(development, standard).separated is True


def test_separation_is_skipped_when_there_is_no_standard_to_compare(tmp_path):
    development = load_set(write_set(tmp_path, [row(id="D")], name="dev.jsonl"))
    report = check_separation(development, None)
    assert report.checked is False
    assert report.separated is True


# --- The shipped standard ------------------------------------------------------------------


def test_the_shipped_standard_is_forty_samples():
    assert len(load_set(STANDARD)) == 40


def test_the_shipped_standard_has_the_split_the_guide_describes():
    # The guide states 14 direct, 10 multi-document, 8 unanswerable, 8 access/security.
    assert load_set(STANDARD).categories() == {
        "direct": 14,
        "multi_document": 10,
        "unanswerable": 8,
        "access_security": 8,
    }


def test_the_shipped_standard_has_the_confidential_samples_the_guide_counts():
    assert sum(1 for s in load_set(STANDARD) if s["forbidden_document_ids"]) == 7


def test_the_shipped_standard_yields_the_eligible_count_the_metrics_expect():
    from app.eval.metrics import is_eligible

    loaded = load_set(STANDARD)
    eligible = [s for s in loaded if is_eligible(s)]
    # 27 answer samples; every one of them carries gold sources, so none is excluded for
    # that reason. If a future edit drops a sample's gold list, this fails rather than
    # quietly shrinking the denominator.
    assert len(eligible) == 27
    assert all(s["gold_sources"] for s in eligible)


def test_multi_document_samples_are_recall_eligible_and_separately_countable():
    # The breakdown the guide asks for is per category, and it needs the multi-document
    # samples to be measured rather than folded in.
    #
    # An earlier reading of this set - recorded in the Part 18 plan - held that every
    # multi-document sample abstained and therefore that the per-category recall breakdown
    # would have no multi-document row. That was wrong: all ten answer, and they carry two
    # or three gold sources each. The measurement below is what the report must produce,
    # and the assertion is on the count so a future edit that changes the set's shape
    # fails here rather than quietly shrinking a reported category.
    from app.eval.metrics import is_eligible

    loaded = load_set(STANDARD)
    eligible_by_category: dict[str, int] = {}
    for sample in loaded:
        if is_eligible(sample):
            key = str(sample["category"])
            eligible_by_category[key] = eligible_by_category.get(key, 0) + 1
    assert eligible_by_category == {"direct": 14, "multi_document": 10, "access_security": 3}

    multi = [s for s in loaded if s["category"] == "multi_document"]
    assert len(multi) == 10
    assert all(s["expected_behavior"] == "answer" for s in multi)
    # Each needs more than one section, which is what makes it a multi-document question
    # rather than a direct one with a longer answer.
    assert all(len(s["gold_sources"]) >= 2 for s in multi)


def test_summary_reports_the_shapes_the_guide_asks_to_break_results_down_by():
    shape = summary(load_set(STANDARD))
    assert shape["samples"] == 40
    assert shape["behaviours"] == {"answer": 27, "abstain": 13}
    assert shape["roles"] == {"employee": 36, "manager": 4}
    assert shape["digest"].startswith("sha256:")
