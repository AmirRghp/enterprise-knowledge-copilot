"""Operator CLI: recompute a run's figures from its artifact.

Separated from ``eval_run`` on purpose. A run's numbers are worth something only if a reader
can check them, and a reader checking them should not have to spend provider quota or touch
the database to do it. The artifact holds every row the figures were derived from, so
re-deriving them here is a second implementation of the same arithmetic over the same inputs.

**What this command checks, and what it does not.** Every figure the report claims that can
be computed from the recorded rows is recomputed and compared: recall overall and per
category and per role, MRR per category and per role, the leakage counts and rate recomputed
from the stored pairs and forbidden ids, the behaviour counts, the latency percentiles, the
execution counts, and the usage totals. Anything the rows cannot reproduce is listed by name
under ``not_rechecked`` rather than silently passed, because a check that reports agreement
while looking at a third of the numbers is worse than no check at all.

Latency is compared with a tolerance rather than exactly. The runner rounds each row to one
decimal place before serializing and computes its percentiles from the unrounded values, so
an exact comparison would report a difference on every run and train a reader to ignore the
output. The tolerance is one part in ten thousand of the value, which is far above the
rounding and far below any difference that would change a conclusion.

This verifies the *report*, not the system. Retrieval and generation have to be re-run to
learn anything new about them.

Usage::

    uv run --locked python -m app.cli.eval_score eval/runs/<run_id>.json
    uv run --locked python -m app.cli.eval_score eval/runs/<run_id>.json --json
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Final

from app.eval.metrics import Aggregate, check_leak, percentile, score_mrr, score_recall

EXIT_OK: Final = 0
EXIT_USAGE: Final = 2
EXIT_ARTIFACT: Final = 3
EXIT_MISMATCH: Final = 4

#: Relative tolerance for latency: one part in ten thousand of the value.
#:
#: The artifact rounds each row's latency to one decimal place before serializing, while the
#: runner computes its percentiles from the unrounded values, so the two differ by up to half
#: a unit in the last place. An absolute tolerance cannot cover that across the range a
#: latency spans - too tight for a hundred milliseconds and too loose for ten seconds - so the
#: comparison is relative, with a floor for a genuinely near-zero measurement.
LATENCY_RELATIVE_TOLERANCE = 1e-4
LATENCY_ABSOLUTE_FLOOR_MS = 0.05

#: Figures a reader might expect this command to check and it deliberately cannot, each with
#: the reason. Reported rather than omitted, because a check whose blind spots are invisible
#: reads as a clean bill of health.
NOT_RECHECKED: Final = {
    "usage": "provider-reported figures are copied into the artifact and cannot be "
    "re-derived without the provider's own response",
    "configuration": "the effective configuration is what the run recorded about itself; "
    "re-reading it here would compare the file against itself",
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="eval_score",
        description="Recompute a run's figures from its artifact and compare them.",
    )
    parser.add_argument("artifact", type=Path, help="the run artifact to re-score")
    parser.add_argument("--json", action="store_true", help="print the result as JSON")
    return parser


class _Hit:
    """A recorded pair or rank row, re-read as the shape the metrics expect."""

    def __init__(self, item: Any) -> None:
        if isinstance(item, dict):
            document_id = item.get("document_id")
            section_id = item.get("section_id")
        else:
            document_id, section_id = item[0], item[1]
        self.source = type("Source", (), {"document_id": document_id, "section_id": section_id})()


def _rank_hits(row: dict[str, Any]) -> list[_Hit]:
    """The retrieved hits in the rank order the run recorded.

    ``retrieval_ranks`` is preferred because it carries the position the retrieval assigned,
    which is what MRR reads; the flat pair list stays as a fallback for an artifact written
    before that field.
    """
    ranks = row.get("retrieval_ranks")
    if ranks:
        return [
            _Hit(entry) for entry in sorted(ranks, key=lambda entry: int(entry.get("position", 0)))
        ]
    return [_Hit(pair) for pair in row.get("retrieval_pairs") or ()]


def rescore(artifact: dict[str, Any]) -> dict[str, Any]:
    """The figures, recomputed from the artifact's own rows."""
    rows = artifact.get("samples") or []
    recall: dict[str, dict[str, Aggregate]] = {"category": {}, "role": {}}
    mrr: dict[str, dict[str, Aggregate]] = {"category": {}, "role": {}}
    latencies: dict[str, dict[str, list[float]]] = {"category": {}, "role": {}}
    every_latency: list[float] = []
    leaked = 0
    confidential = 0
    leak_rate = None
    behaviour_checked = 0
    abstained_when_expected = 0
    answered_when_expected = 0
    failed = 0
    unmeasured = 0

    # Behaviour and execution, cut the same way the runner cuts them. A partial check that
    # skipped these would let a header claim a clean behaviour count over rows that show
    # otherwise.
    behaviour_by: dict[str, dict[str, dict[str, int]]] = {"category": {}, "role": {}}
    execution_by: dict[str, dict[str, dict[str, int]]] = {"category": {}, "role": {}}
    consumption_by: dict[str, dict[str, dict[str, Any]]] = {"category": {}, "role": {}}

    def cell(store: dict[str, dict[str, dict[str, int]]], axis: str, name: str) -> dict[str, int]:
        """A counter block created empty.

        Seeded with ``{"samples": 0}`` it left every behaviour group reporting a sample
        count of zero beside real counts, because nothing but the execution store ever
        increments ``samples``. A key that is always zero is worse than an absent one.
        """
        return store[axis].setdefault(name, {})

    for row in rows:
        category = str(row.get("category", "unknown"))
        role = str(row.get("role", "unknown"))
        if row.get("error"):
            failed += 1
        if isinstance(row.get("latency_ms"), (int, float)):
            latency = float(row["latency_ms"])
            every_latency.append(latency)
            latencies["category"].setdefault(category, []).append(latency)
            latencies["role"].setdefault(role, []).append(latency)

        # The leak is recomputed from the stored pairs and the sample's own forbidden ids,
        # not read off the flag the run wrote. Reading the flag would compare the run's leak
        # arithmetic with itself.
        forbidden = [str(value) for value in row.get("forbidden_document_ids") or ()]
        if forbidden:
            confidential += 1
            finding = check_leak(
                {
                    "id": row.get("sample_id"),
                    "forbidden_document_ids": forbidden,
                },
                _rank_hits(row),
                [_Hit(item) for item in row.get("cited") or []],
            )
            if finding is not None and finding.leaked:
                leaked += 1

        for axis, name in (("category", category), ("role", role)):
            execution = execution_by[axis].setdefault(name, {"samples": 0})
            execution["samples"] += 1
            usage_row = row.get("usage") or {}
            consumption = consumption_by[axis].setdefault(name, {})
            if usage_row.get("provider_was_called"):
                consumption["asked"] = consumption.get("asked", 0) + 1
                if usage_row.get("reported"):
                    consumption["reporting_usage"] = consumption.get("reporting_usage", 0) + 1
                    consumption["attempts"] = consumption.get("attempts", 0) + (
                        usage_row.get("attempts") or 0
                    )
                    tokens = usage_row.get("total_tokens")
                    if tokens is not None:
                        consumption["tokens_known"] = consumption.get("tokens_known", 0) + int(
                            tokens
                        )
                        consumption["tokens_complete_samples"] = (
                            consumption.get("tokens_complete_samples", 0) + 1
                        )
                    if usage_row.get("cost") is not None:
                        consumption["cost_reported_samples"] = (
                            consumption.get("cost_reported_samples", 0) + 1
                        )
            else:
                consumption["not_asked"] = consumption.get("not_asked", 0) + 1
            if row.get("error"):
                execution["failed"] = execution.get("failed", 0) + 1
            if row.get("retrieval_measured"):
                execution["retrieval_measured"] = execution.get("retrieval_measured", 0) + 1

        measured = row.get("retrieval_measured", bool(row.get("retrieval_ranks")))
        if not measured:
            # Counted as **excluded** rather than dropped, so the category still appears in
            # the report. A category that vanished because its samples failed is a harder
            # thing to notice than one that reads "excluded", and the reader needs to see
            # that something was attempted and did not come back.
            unmeasured += 1
            for axis, name in (("category", category), ("role", role)):
                recall[axis].setdefault(name, Aggregate()).excluded += 1
                mrr[axis].setdefault(name, Aggregate()).excluded += 1
            continue

        sample = {
            "id": row.get("sample_id"),
            "category": category,
            "role": role,
            "expected_behavior": row.get("expected_behavior"),
            # Read from the artifact rather than the set file on disk. The copy inside the
            # artifact is what the run was scored against, so a re-score of a year-old run
            # measures what it measured then even if the standard has since been edited.
            "gold_sources": [
                {"document_id": str(pair[0]), "section_id": str(pair[1])}
                for pair in row.get("gold_sources") or ()
            ],
            "forbidden_document_ids": forbidden,
        }
        hits = _rank_hits(row)
        recall_result = score_recall(sample, hits)
        mrr_result = score_mrr(sample, hits)
        for axis, name in (("category", category), ("role", role)):
            recall[axis].setdefault(name, Aggregate()).add(
                recall_result.recall, recall_result.eligible, recall_result.excluded_reason
            )
            mrr[axis].setdefault(name, Aggregate()).add(
                mrr_result.reciprocal_rank, mrr_result.eligible, mrr_result.excluded_reason
            )

        if row.get("abstained") is not None and not row.get("error"):
            behaviour_checked += 1
            expects_answer = row.get("expected_behavior") == "answer"
            for axis, name in (("category", category), ("role", role)):
                entry = cell(behaviour_by, axis, name)
                entry["checked"] = entry.get("checked", 0) + 1
                entry["expected_answer" if expects_answer else "expected_abstain"] = (
                    entry.get("expected_answer" if expects_answer else "expected_abstain", 0) + 1
                )
                key = "abstained" if row.get("abstained") else "answered"
                entry[key] = entry.get(key, 0) + 1
            if row.get("abstained") and not expects_answer:
                abstained_when_expected += 1
            if not row.get("abstained") and expects_answer:
                answered_when_expected += 1

    if confidential:
        leak_rate = leaked / confidential

    entries = [agg for agg in recall["category"].values() if agg.measured > 0]
    overall = (
        sum(entry.total for entry in entries) / sum(entry.measured for entry in entries)
        if entries
        else None
    )

    def shape(bucket: dict[str, Aggregate]) -> dict[str, Any]:
        return {name: agg.as_dict() for name, agg in sorted(bucket.items())}

    return {
        "recall_at_5": {
            "overall": overall,
            "by_category": shape(recall["category"]),
            "by_role": shape(recall["role"]),
        },
        "mrr": {"by_category": shape(mrr["category"]), "by_role": shape(mrr["role"])},
        "leakage": {
            "leaked_samples": leaked,
            "confidential_samples": confidential,
            "observed_leak_rate": leak_rate,
        },
        "behaviour": {
            "checked": behaviour_checked,
            "abstained_when_a_refusal_was_expected": abstained_when_expected,
            "answered_when_an_answer_was_expected": answered_when_expected,
            "by_category": {
                name: dict(counts) for name, counts in sorted(behaviour_by["category"].items())
            },
            "by_role": {
                name: dict(counts) for name, counts in sorted(behaviour_by["role"].items())
            },
        },
        "consumption": {
            "by_category": {
                name: dict(counts) for name, counts in sorted(consumption_by["category"].items())
            },
            "by_role": {
                name: dict(counts) for name, counts in sorted(consumption_by["role"].items())
            },
        },
        "latency_ms": {
            "p50": percentile(every_latency, 0.5),
            "p95": percentile(every_latency, 0.95),
            "measured": len(every_latency),
        },
        "execution": {
            "executed": len(rows),
            "failed": failed,
            "retrieval_unmeasured": unmeasured,
            "by_category": {
                name: dict(counts) for name, counts in sorted(execution_by["category"].items())
            },
            "by_role": {
                name: dict(counts) for name, counts in sorted(execution_by["role"].items())
            },
        },
    }


def _within_latency_tolerance(left: Any, right: Any) -> bool:
    """Whether two latency figures agree to within the serialization's rounding.

    Relative, with an absolute floor. The rounding the runner applies when it writes each row
    is a fixed 0.1 ms regardless of magnitude, so a purely relative tolerance is wrong for a
    sub-millisecond measurement and a purely absolute one is wrong for a slow run.
    """
    if left is None or right is None:
        return left is None and right is None
    try:
        difference = abs(float(left) - float(right))
    except (TypeError, ValueError):
        return _same(left, right)
    allowed = max(LATENCY_ABSOLUTE_FLOOR_MS, abs(float(right)) * LATENCY_RELATIVE_TOLERANCE)
    return difference <= allowed


def _same(left: Any, right: Any, tolerance: float = 0.0) -> bool:
    """Equality that treats "not measured" as distinct from zero.

    ``None`` and ``0.0`` are different facts and a check that collapsed them would pass a
    report that claimed a measured zero where nothing was measured.
    """
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, bool) or isinstance(right, bool):
        return bool(left) == bool(right)
    try:
        return abs(float(left) - float(right)) <= tolerance
    except (TypeError, ValueError):
        return bool(left == right)


def compare(recorded: dict[str, Any], recomputed: dict[str, Any]) -> list[str]:
    """Where the artifact's own figures disagree with the rows beneath them.

    Every group of claimed figures is checked. A disagreement means the header was computed
    from something other than the rows below it, which is the one failure a reader cannot
    see by reading the report - and a partial check hides it, because the figures that
    happen to agree say nothing about the ones that do not.
    """
    differences: list[str] = []
    figures = recorded.get("figures") or {}
    recorded_recall = (figures.get("retrieval") or {}).get("recall_at_5") or {}
    recorded_mrr = (figures.get("retrieval") or {}).get("mrr") or {}

    def note(path: str, left: Any, right: Any, *, latency: bool = False) -> None:
        agrees = _within_latency_tolerance(left, right) if latency else _same(left, right)
        if not agrees:
            differences.append(f"{path}: header {left!r} vs recomputed {right!r}")

    note("recall overall", recorded_recall.get("overall"), recomputed["recall_at_5"]["overall"])
    note(
        "recall by_category",
        _means(recorded_recall.get("by_category")),
        _means(recomputed["recall_at_5"]["by_category"]),
    )
    note(
        "recall by_role",
        _means(recorded_recall.get("by_role")),
        _means(recomputed["recall_at_5"]["by_role"]),
    )
    note(
        "recall measured/excluded by category",
        _counts(recorded_recall.get("by_category")),
        _counts(recomputed["recall_at_5"]["by_category"]),
    )
    note(
        "mrr by_category",
        _means(recorded_mrr.get("by_category")),
        _means(recomputed["mrr"]["by_category"]),
    )
    note(
        "mrr by_role",
        _means(recorded_mrr.get("by_role")),
        _means(recomputed["mrr"]["by_role"]),
    )

    recorded_leak = figures.get("leakage") or {}
    note(
        "leaked samples",
        recorded_leak.get("leaked_samples"),
        recomputed["leakage"]["leaked_samples"],
    )
    note(
        "confidential samples",
        recorded_leak.get("confidential_samples"),
        recomputed["leakage"]["confidential_samples"],
    )
    note(
        "observed leak rate",
        recorded_leak.get("observed_leak_rate"),
        recomputed["leakage"]["observed_leak_rate"],
    )

    recorded_behaviour = figures.get("behaviour") or {}
    for key in (
        "checked",
        "abstained_when_a_refusal_was_expected",
        "answered_when_an_answer_was_expected",
    ):
        note(f"behaviour.{key}", recorded_behaviour.get(key), recomputed["behaviour"][key])
    # The per-group cuts, not only the run-level totals. A group that silently stopped being
    # measured leaves the totals looking fine, and the aggregate is exactly what a reader
    # skims first.
    note(
        "behaviour by_category",
        _counters(recorded_behaviour.get("by_category")),
        _counters(recomputed["behaviour"]["by_category"]),
    )
    note(
        "behaviour by_role",
        _counters(recorded_behaviour.get("by_role")),
        _counters(recomputed["behaviour"]["by_role"]),
    )
    recorded_execution = recorded.get("execution") or {}
    note(
        "execution by_category",
        _counters(recorded_execution.get("by_category")),
        _counters(recomputed["execution"]["by_category"]),
    )
    note(
        "execution by_role",
        _counters(recorded_execution.get("by_role")),
        _counters(recomputed["execution"]["by_role"]),
    )
    recorded_consumption = figures.get("consumption") or {}
    note(
        "consumption by_category",
        _counters(recorded_consumption.get("by_category")),
        _counters(recomputed["consumption"]["by_category"]),
    )
    note(
        "consumption by_role",
        _counters(recorded_consumption.get("by_role")),
        _counters(recomputed["consumption"]["by_role"]),
    )

    recorded_latency = figures.get("latency_ms") or {}
    note(
        "latency p50",
        recorded_latency.get("p50"),
        recomputed["latency_ms"]["p50"],
        latency=True,
    )
    note(
        "latency p95",
        recorded_latency.get("p95"),
        recomputed["latency_ms"]["p95"],
        latency=True,
    )
    note("latency measured", recorded_latency.get("measured"), recomputed["latency_ms"]["measured"])

    note("executed", recorded.get("executed"), recomputed["execution"]["executed"])
    note("failed", recorded.get("failed"), recomputed["execution"]["failed"])
    planned = recorded.get("planned")
    execution = recomputed["execution"]
    implied_complete = execution["failed"] == 0 and planned == execution["executed"]
    if planned is not None and not _same(recorded.get("complete"), implied_complete):
        differences.append(
            f"complete: header {recorded.get('complete')!r} vs rows implying {implied_complete}"
        )
    return differences


def _counters(bucket: Any) -> dict[str, Any] | None:
    """Each group's counters, so a tampered per-group figure is compared as that figure."""
    if not isinstance(bucket, dict):
        return None
    return {
        name: (dict(sorted(entry.items())) if isinstance(entry, dict) else None)
        for name, entry in sorted(bucket.items())
    }


def _means(bucket: Any) -> dict[str, Any] | None:
    """The mean of each entry, so a tampered mean is compared as a mean."""
    if not isinstance(bucket, dict):
        return None
    return {
        name: (entry.get("mean") if isinstance(entry, dict) else None)
        for name, entry in sorted(bucket.items())
    }


def _counts(bucket: Any) -> dict[str, Any] | None:
    """The measured and excluded counts, which are figures a report can also get wrong."""
    if not isinstance(bucket, dict):
        return None
    return {
        name: ([entry.get("measured"), entry.get("excluded")] if isinstance(entry, dict) else None)
        for name, entry in sorted(bucket.items())
    }


def main(argv: list[str] | None = None) -> int:
    try:
        arguments = _parser().parse_args(argv)
    except SystemExit as exit_code:
        return int(exit_code.code or EXIT_USAGE)
    try:
        artifact = json.loads(arguments.artifact.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"the artifact could not be read: {type(error).__name__}", file=sys.stderr)
        return EXIT_ARTIFACT
    if not isinstance(artifact, dict) or "samples" not in artifact:
        print("the artifact is not a run report", file=sys.stderr)
        return EXIT_ARTIFACT

    recomputed = rescore(artifact)
    differences = compare(artifact, recomputed)

    if arguments.json:
        print(
            json.dumps(
                {
                    "artifact": str(arguments.artifact),
                    "run_id": artifact.get("run_id"),
                    "schema_version": artifact.get("schema_version"),
                    "recomputed": recomputed,
                    "differences": differences,
                    "checked": [
                        "recall overall, by category, by role",
                        "recall measured/excluded counts",
                        "mrr by category, by role",
                        "leakage counts and rate, recomputed from stored pairs",
                        "behaviour counts",
                        "latency p50/p95 and measured count",
                        "executed, failed, complete",
                    ],
                    "not_rechecked": NOT_RECHECKED,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return EXIT_MISMATCH if differences else EXIT_OK

    print(f"run id: {artifact.get('run_id')}")
    print(f"artifact: {arguments.artifact}")
    recall = recomputed["recall_at_5"]
    print(
        f"recall@{5}: overall={_number(recall['overall'])} "
        + " ".join(
            f"{name}={_number(entry.get('mean'))}" for name, entry in recall["by_category"].items()
        )
    )
    if recall["by_role"]:
        print(
            "  by role: "
            + " ".join(
                f"{name}={_number(entry.get('mean'))}" for name, entry in recall["by_role"].items()
            )
        )
    leak = recomputed["leakage"]
    print(
        f"leakage: {leak['leaked_samples']} of {leak['confidential_samples']}, "
        f"rate={_number(leak['observed_leak_rate'])}"
    )
    print(
        f"latency ms: p50={_number(recomputed['latency_ms']['p50'])} "
        f"p95={_number(recomputed['latency_ms']['p95'])}"
    )
    if differences:
        print(f"the artifact's figures disagree with its rows ({len(differences)}):")
        for line in differences:
            print(f"  {line}")
    else:
        print("the artifact's figures agree with its rows")
    print(f"not rechecked: {', '.join(sorted(NOT_RECHECKED))}")
    return EXIT_MISMATCH if differences else EXIT_OK


def _number(value: Any) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
