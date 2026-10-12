"""Evaluation of retrieval quality, answer behaviour, latency and consumption.

Split into three modules rather than one, because the three have different dependencies
and different failure modes:

* ``metrics`` is pure. It turns collected rows into numbers and touches nothing else, so a
  report's figures can be recomputed from an artifact after the fact and each metric can
  be tested against a hand-computed answer.
* ``sets`` reads and checks evaluation files, including the separation of a development
  set from the fixed standard.
* The runner lives in ``app.cli.eval_run`` because it is an operator command with
  provider and database dependencies, not part of the library.
"""

from app.eval.metrics import (
    RECALL_DEPTH,
    Aggregate,
    LeakFinding,
    MRRResult,
    Ratio,
    RecallResult,
    check_leak,
    eligible_gold_pairs,
    is_eligible,
    leaks_in,
    pair_of,
    percentile,
    ranked_pairs,
    score_mrr,
    score_recall,
)
from app.eval.sets import (
    EvaluationSet,
    EvaluationSetError,
    SeparationReport,
    check_separation,
    digest_of,
    gold_pairs,
    load_set,
    select,
    summary,
)

__all__ = [
    "RECALL_DEPTH",
    "Aggregate",
    "EvaluationSet",
    "EvaluationSetError",
    "LeakFinding",
    "MRRResult",
    "Ratio",
    "RecallResult",
    "SeparationReport",
    "check_leak",
    "check_separation",
    "digest_of",
    "eligible_gold_pairs",
    "gold_pairs",
    "is_eligible",
    "leaks_in",
    "load_set",
    "pair_of",
    "percentile",
    "ranked_pairs",
    "score_mrr",
    "score_recall",
    "select",
    "summary",
]
