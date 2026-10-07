"""Deliberate-revert verification for the Part 11 guards.

For each guard, revert it in place, run the test that is supposed to catch it, and
report whether that test failed. A guard whose test still passes when the guard is
removed is not being enforced, and the claim that it is would be false.

Anchors are checked up front, so a stale anchor is reported as a stale anchor rather
than as a guard that appears to pass. Every file is restored whatever the outcome.

Run from ``apps/api``: ``uv run --locked python scripts/verify_part11_guards.py``
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

API = pathlib.Path(__file__).resolve().parents[1]

# Long test ids live in constants rather than inline, because ruff's formatter
# collapses a parenthesized concatenation onto one line and the line then exceeds the
# project's limit. A named constant keeps the id readable and the file lint-clean.
_RETRIEVAL = "tests/test_retrieval.py::"
_REPORT = "tests/test_retrieval_report.py::"

_EMPTY_QUESTION = _RETRIEVAL + "test_an_empty_question_returns_no_hits_without_calling_the_provider"
_VECTORLESS_CHUNK = _RETRIEVAL + "test_a_chunk_without_a_vector_is_not_retrievable_by_either_path"
_MID_REQUEST = _RETRIEVAL + "test_a_document_narrowed_to_manager_mid_request_is_not_returned"
_LEXICAL_OVERLAP = (
    _RETRIEVAL + "test_the_lexical_path_matches_on_overlap_even_when_scores_are_negative"
)
_NEAREST_VECTOR = (
    _RETRIEVAL + "test_the_nearest_vector_ranks_first_even_when_its_chunk_id_is_largest"
)
_NORMALIZED_QUERY = (
    _RETRIEVAL + "test_the_provider_is_given_the_normalized_question_not_the_raw_one"
)
_STALE_DIGEST = _RETRIEVAL + "test_an_index_built_by_a_different_digest_fails_closed"
_REPORT_PROVIDER_FAILURE = _REPORT + "test_a_provider_failure_never_prints_the_question"

GUARDS: dict[str, tuple[str, str, list[tuple[str, str]]]] = {
    "the role allowlist is part of the SQL predicate": (
        "app/retrieval/store.py",
        "tests/test_retrieval.py::test_an_employee_never_receives_a_manager_only_document",
        [
            (
                "        & (Document.access_role.in_(VISIBLE_ROLES[actor.role]))\n",
                "        # REVERT: drop the role allowlist from the predicate.\n",
            )
        ],
    ),
    "the active-status allowlist is part of the SQL predicate": (
        "app/retrieval/store.py",
        "tests/test_retrieval.py::test_a_deleted_document_is_not_retrievable",
        [
            (
                '        (Document.status == "active")\n',
                "        # REVERT: accept deleted documents as well.\n"
                '        (Document.status.in_(("active", "inactive")))\n',
            )
        ],
    ),
    "only the current revision is in the domain": (
        "app/retrieval/store.py",
        "tests/test_retrieval.py::test_a_superseded_revision_is_not_retrievable",
        [
            (
                "        & (Chunk.revision == Document.current_revision)\n",
                "        # REVERT: also rank superseded and staged revisions.\n",
            )
        ],
    ),
    "the current revision must have a ready job": (
        "app/retrieval/store.py",
        (
            "tests/test_retrieval.py::"
            "test_a_current_revision_whose_job_is_no_longer_ready_is_not_retrievable"
        ),
        [
            (
                "        & ready_job\n",
                "        # REVERT: trust current_revision without the ready job.\n",
            )
        ],
    ),
    "a chunk without a vector is out of the shared predicate, so BM25 cannot reach it": (
        "app/retrieval/store.py",
        _VECTORLESS_CHUNK,
        [
            (
                "        & (Chunk.embedding.is_not(None))\n",
                "        # REVERT: let a chunk with no vector into both paths.\n"
                "        & (Chunk.revision.is_not(None))\n",
            )
        ],
    ),
    "the vector path sorts by distance before it sorts by chunk_id": (
        "app/retrieval/store.py",
        _NEAREST_VECTOR,
        [
            (
                "        _eligible_query(actor).add_columns(distance)"
                ".order_by(distance, Chunk.chunk_id).limit(top_k)",
                "        # REVERT: let the identifier outrank the distance.\n"
                "        _eligible_query(actor).add_columns(distance)"
                ".order_by(Chunk.chunk_id, distance).limit(top_k)",
            )
        ],
    ),
    "the index is checked against the provider before anything is ranked": (
        "app/retrieval/service.py",
        _STALE_DIGEST,
        [
            (
                "    await store.assert_index_consistent(session, actor, expected=expected)\n",
                "    # REVERT: rank an index of unknown provenance.\n    _ = expected\n",
            ),
        ],
    ),
    "the fused candidates are re-checked against the allowlist before returning": (
        "app/retrieval/service.py",
        _MID_REQUEST,
        [
            (
                "    fresh = await store.read_ranked_chunks(\n"
                "        session, actor, chunk_ids=[chunk_id for chunk_id, _ in ordered]\n"
                "    )",
                "    # REVERT: serve the ranking read's snapshot instead.\n"
                "    fresh = {\n"
                "        chunk.chunk_id: chunk for chunk in chunks if chunk.chunk_id in\n"
                "        {chunk_id for chunk_id, _ in ordered}\n"
                "    }",
            )
        ],
    ),
    "the provider is given the normalized question": (
        "app/retrieval/service.py",
        _NORMALIZED_QUERY,
        [
            (
                "    chunks, embedding = await _read_domain_and_embed("
                "session, actor, provider, search_text)",
                "    # REVERT: embed the caller's text.\n"
                "    chunks, embedding = await _read_domain_and_embed(\n"
                "        session, actor, provider, question\n"
                "    )",
            )
        ],
    ),
    "a provider failure is reported without printing its message": (
        "app/cli/retrieval_report.py",
        _REPORT_PROVIDER_FAILURE,
        [
            (
                "        # wording changes.\n"
                '        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]} '
                '({type(error).__name__})", file=sys.stderr)',
                "        # wording changes.\n"
                '        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]} ({error})", file=sys.stderr)',
            )
        ],
    ),
    "a question that normalizes to nothing never reaches the provider": (
        "app/retrieval/service.py",
        _EMPTY_QUESTION,
        [
            (
                "    search_text = normalize_for_search(question)\n"
                "    if not search_text:\n"
                "        return []\n",
                "    # REVERT: embed whatever arrived, normalized or not.\n"
                "    search_text = normalize_for_search(question)\n",
            )
        ],
    ),
}


def _check_anchors() -> None:
    """Fail loudly before patching if any anchor has drifted from its file."""
    problems = []
    for name, (relative, _, patches) in GUARDS.items():
        text = (API / relative).read_text(encoding="utf-8")
        for old, _ in patches:
            matches = text.count(old)
            if matches != 1:
                problems.append(f"{name!r}: anchor matched {matches} times in {relative}")
    if problems:
        raise SystemExit("stale anchors:\n  " + "\n  ".join(problems))


def main() -> int:
    _check_anchors()
    backup = pathlib.Path(tempfile.mkdtemp(prefix="part11-revert-"))
    outcomes: list[tuple[str, bool, str]] = []
    try:
        for name, (relative, node, patches) in GUARDS.items():
            target = API / relative
            saved = backup / relative.replace("/", "__")
            shutil.copy2(target, saved)
            try:
                text = target.read_text(encoding="utf-8")
                for old, new in patches:
                    if text.count(old) != 1:
                        raise SystemExit(f"anchor for {name!r} matched {text.count(old)} times")
                    text = text.replace(old, new, 1)
                target.write_text(text, encoding="utf-8")
                completed = subprocess.run(
                    [sys.executable, "-m", "pytest", node, "-q", "-x"],
                    cwd=API,
                    capture_output=True,
                    text=True,
                    timeout=300,
                )
                # Exit 1 is a failing test; exit 5 means nothing was collected, which
                # a revert that broke the file produces and a real guard never does.
                # Counting that as "caught" would let a broken patch masquerade as
                # evidence, which is the exact failure this script exists to prevent.
                caught = completed.returncode == 1
                if completed.returncode not in (0, 1):
                    caught = False
                lines = [line for line in completed.stdout.splitlines() if line.strip()]
                outcomes.append((name, caught, lines[-1] if lines else ""))
            finally:
                shutil.copy2(saved, target)
    finally:
        shutil.rmtree(backup, ignore_errors=True)

    width = max(len(name) for name, _, _ in outcomes)
    unenforced = 0
    for name, caught, tail in outcomes:
        print(f"{name.ljust(width)}  {'caught' if caught else 'NOT CAUGHT'}  {tail}")
        if not caught:
            unenforced += 1

    print()
    print(f"{len(outcomes) - unenforced}/{len(outcomes)} guards proved by a failing test")
    return 1 if unenforced else 0


if __name__ == "__main__":
    raise SystemExit(main())
