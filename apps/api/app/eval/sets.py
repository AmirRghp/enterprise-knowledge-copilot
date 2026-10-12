"""Reading and checking an evaluation set.

The fixed 40-sample set in ``eval/questions.jsonl`` is the project's standard, and the
guide is blunt about what may be done with it: not used for repeated tuning of prompts,
ranking, abstention thresholds or models, because tuning against it makes its own result
optimistic. Tuning happens on a **development** set instead - separate, non-overlapping, and
identifiable as such.

That is why a development set is refused here rather than merely discouraged. Two ways a
"development" set quietly stops being one are checked:

* a sample id already in the standard, which makes the two sets one set with two names;
* an identical question text, which makes the overlap invisible to anyone reading ids.

Neither check needs the standard to be loaded for the id case, but the question check
does, so a caller that wants the full check passes the standard's questions in. The
rejection is explicit rather than a warning: a dev set that overlaps the standard is not a
stale dev set, it is a way of tuning on the standard with an extra step.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.eval.metrics import Pair, pair_of

#: Fields a sample must carry to be scored at all. The guide names the fixed set's own
#: contents, and a sample missing one of these cannot be measured for the metric that needs
#: it - so it is refused at load rather than silently scoring as a miss.
REQUIRED_FIELDS = ("id", "category", "role", "question", "expected_behavior")

VALID_BEHAVIOURS = ("answer", "abstain")

VALID_CATEGORIES = ("direct", "multi_document", "unanswerable", "access_security")

VALID_ROLES = ("employee", "manager")


class EvaluationSetError(ValueError):
    """The set file is unusable. Carries a fixed reason; never the sample's text."""


@dataclass(frozen=True, slots=True)
class EvaluationSet:
    """One loaded set, with the hash that identifies its contents.

    The hash goes into every report. Two runs that recorded the same set hash measured the
    same questions, and a run whose hash nobody can match to a file is not reproducible in
    the sense the guide means.
    """

    name: str
    path: Path
    samples: tuple[dict[str, Any], ...]
    digest: str

    def __len__(self) -> int:
        return len(self.samples)

    def __iter__(self) -> Iterator[dict[str, Any]]:
        return iter(self.samples)

    def categories(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for sample in self.samples:
            key = str(sample.get("category", "unknown"))
            counts[key] = counts.get(key, 0) + 1
        return counts

    def by_id(self, sample_id: str) -> dict[str, Any] | None:
        for sample in self.samples:
            if sample.get("id") == sample_id:
                return sample
        return None


def digest_of(path: Path) -> str:
    """The content hash of a set file, stable across runs and machines."""
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def load_set(path: Path, *, name: str | None = None) -> EvaluationSet:
    """Load and validate one evaluation set.

    Validation is on structure, not on judgement. A sample whose role is unknown, whose
    behaviour is neither answering nor abstaining, or whose gold sources are malformed
    cannot be scored, and finding that out here means the run fails on a file problem
    rather than midway through spending provider quota.
    """
    if not path.is_file():
        raise EvaluationSetError(f"no evaluation set at {path.name}")
    samples: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            sample = json.loads(stripped)
        except json.JSONDecodeError as error:
            raise EvaluationSetError(f"line {number} is not valid JSON") from error
        if not isinstance(sample, dict):
            raise EvaluationSetError(f"line {number} is not a JSON object")
        missing = [field for field in REQUIRED_FIELDS if field not in sample]
        if missing:
            # The field names, not the sample: a malformed set is a file problem and its
            # contents are not echoed into an error that may end up in a terminal.
            raise EvaluationSetError(f"line {number} is missing {', '.join(missing)}")
        sample_id = str(sample["id"])
        if sample_id in seen_ids:
            raise EvaluationSetError(f"line {number} repeats sample id {sample_id}")
        seen_ids.add(sample_id)
        if sample["expected_behavior"] not in VALID_BEHAVIOURS:
            raise EvaluationSetError(f"sample {sample_id} has an unknown expected_behavior")
        if sample["category"] not in VALID_CATEGORIES:
            raise EvaluationSetError(f"sample {sample_id} has an unknown category")
        if sample["role"] not in VALID_ROLES:
            raise EvaluationSetError(f"sample {sample_id} has an unknown role")
        for gold in sample.get("gold_sources") or ():
            pair_of(gold)  # raises with the offending shape
        samples.append(sample)
    if not samples:
        raise EvaluationSetError("the evaluation set is empty")
    return EvaluationSet(
        name=name or path.stem,
        path=path,
        samples=tuple(samples),
        digest=digest_of(path),
    )


@dataclass(frozen=True, slots=True)
class SeparationReport:
    """How a development set relates to the fixed standard."""

    checked: bool
    overlapping_ids: tuple[str, ...]
    overlapping_questions: tuple[str, ...]

    @property
    def separated(self) -> bool:
        return not self.overlapping_ids and not self.overlapping_questions


def check_separation(
    development: EvaluationSet, standard: EvaluationSet | None = None
) -> SeparationReport:
    """Whether a development set can be used for tuning without touching the standard.

    Ids alone are not enough. Two sets can use disjoint ids and still ask the same question,
    in which case tuning on the second still moves the first's result - the id check would
    pass and the overlap would be invisible. Questions are compared after the same
    whitespace normalization a reader would apply, so a trailing space is not a difference
    and a genuine rewording is.
    """
    if standard is None:
        return SeparationReport(checked=False, overlapping_ids=(), overlapping_questions=())

    standard_ids = {str(sample["id"]) for sample in standard}
    standard_questions = {_normalise(str(sample["question"])) for sample in standard}

    overlapping_ids = tuple(
        sorted({str(s["id"]) for s in development if str(s["id"]) in standard_ids})
    )
    overlapping_questions = tuple(
        sorted(
            {
                str(s["id"])
                for s in development
                if _normalise(str(s["question"])) in standard_questions
            }
        )
    )
    return SeparationReport(
        checked=True,
        overlapping_ids=overlapping_ids,
        overlapping_questions=overlapping_questions,
    )


def _normalise(question: str) -> str:
    return " ".join(question.split())


def gold_pairs(sample: dict[str, Any]) -> tuple[Pair, ...]:
    """The distinct gold pairs of one sample, in file order."""
    seen: set[Pair] = set()
    ordered: list[Pair] = []
    for gold in sample.get("gold_sources") or ():
        pair = pair_of(gold)
        if pair not in seen:
            seen.add(pair)
            ordered.append(pair)
    return tuple(ordered)


def summary(evaluation_set: EvaluationSet) -> dict[str, Any]:
    """Shape counts for a set, for the run header.

    Reported per category and per role rather than only as a total, because the guide asks
    for results broken out that way and a run header that cannot show them makes the split
    impossible to check later.
    """
    behaviours: dict[str, int] = {}
    roles: dict[str, int] = {}
    for sample in evaluation_set:
        behaviour = str(sample["expected_behavior"])
        role = str(sample["role"])
        behaviours[behaviour] = behaviours.get(behaviour, 0) + 1
        roles[role] = roles.get(role, 0) + 1
    return {
        "name": evaluation_set.name,
        "digest": evaluation_set.digest,
        "samples": len(evaluation_set),
        "categories": evaluation_set.categories(),
        "behaviours": behaviours,
        "roles": roles,
    }


def select(
    evaluation_set: EvaluationSet,
    *,
    categories: Sequence[str] = (),
    roles: Sequence[str] = (),
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """The samples a run should execute, in file order.

    Order is the file's own, not a shuffle: a run that is resumed, compared or read
    alongside another one is only comparable if both went through the samples in the same
    order. ``limit`` then takes a prefix, which is why a limited run is comparable to the
    full one it was cut from.
    """
    chosen = [
        sample
        for sample in evaluation_set
        if (not categories or sample["category"] in categories)
        and (not roles or sample["role"] in roles)
    ]
    if limit is not None:
        chosen = chosen[: max(0, limit)]
    return chosen
