"""Deliberate-revert verification for the Part 10 guards.

For each guard, revert it in place, run the test that is supposed to catch it, and
report whether that test failed. A guard whose test still passes when the guard is
removed is not being enforced, and the claim that it is would be false.

Run from ``apps/api``. Restores every file it touches, whatever the outcome.
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

API = pathlib.Path(__file__).resolve().parents[1]

# guard name -> (relative file, pytest node id, [(old, new), ...])
GUARDS: dict[str, tuple[str, str, list[tuple[str, str]]]] = {
    "a freed identifier below the mark is never filled": (
        "app/ingestion/sections.py",
        "tests/test_replacement.py::test_a_gap_below_the_mark_is_never_filled",
        [
            (
                "    high_water = max(\n"
                "        [historical_high_water]\n"
                "        + [_split(identifier)[1] for identifier, _ in previous]\n"
                "        + [_split(section.section_id)[1] for section in incoming]\n"
                "        + [-1]\n"
                "    )",
                "    # REVERT: hand out the smallest identifier not already taken.\n"
                "    taken = {_split(identifier)[1] for identifier, _ in previous}\n"
                "    taken |= {_split(section.section_id)[1] for section in incoming}\n"
                "    free = 0\n"
                "    while free in taken:\n"
                "        free += 1\n"
                "    high_water = free - 1",
            )
        ],
    ),
    "a narrowing applies before activation": (
        "app/ingestion/store.py",
        "tests/test_replacement.py::test_a_narrowing_applies_before_the_replacement_is_activated",
        [
            (
                "        if narrows_access(document.access_role, metadata.access_role):\n"
                "            document.access_role = metadata.access_role",
                "        # REVERT: defer every policy change to activation.",
            )
        ],
    ),
    "a second replacement in flight is refused": (
        "app/ingestion/store.py",
        (
            "tests/test_replacement.py::"
            "test_a_second_replacement_in_flight_is_refused_and_does_not_clobber_the_first"
        ),
        [
            (
                "        if await _has_open_job(session, document_id):\n"
                "            raise ReplacementConflictError("
                '"a job for this document is already in flight")',
                "        # REVERT: allow a second replacement over the first.",
            )
        ],
    ),
    "the pending title and policy apply at activation": (
        "app/ingestion/store.py",
        "tests/test_replacement.py::test_a_widening_applies_at_activation_and_the_staging_columns_are_cleared",
        [
            (
                "        if document.staged_title is not None:\n"
                "            document.title = document.staged_title\n"
                "        if document.staged_access_role is not None:\n"
                "            document.access_role = document.staged_access_role\n"
                "        document.staged_title = None\n"
                "        document.staged_access_role = None",
                "        # REVERT: never apply and never clear the staging columns.",
            )
        ],
    ),
    "the pending policy is what a claim carries": (
        "app/ingestion/store.py",
        (
            "tests/test_replacement.py::"
            "test_a_claim_carries_the_policy_that_will_be_in_force_when_it_activates"
        ),
        [
            (
                "        select(IngestionJob, "
                "func.coalesce(Document.staged_access_role, Document.access_role))",
                "        select(IngestionJob, Document.access_role)  # REVERT",
            )
        ],
    ),
    "an expired lease leaves nothing staged behind": (
        "app/ingestion/store.py",
        (
            "tests/test_replacement.py::"
            "test_deleting_drops_a_staged_revision_but_keeps_the_published_one"
        ),
        [
            (
                "        await _delete_unpublished_revision_rows(\n"
                "            session, document_id=document_id, "
                "keep_revision=document.current_revision\n"
                "        )",
                "        # REVERT: leave the staged rows in place.",
            )
        ],
    ),
    "delete fails the document's open jobs": (
        "app/ingestion/store.py",
        (
            "tests/test_manager_lifecycle_api.py::"
            "test_deleting_a_document_fails_its_open_replacement"
        ),
        [
            (
                "        if open_job_ids:\n"
                "            await session.execute(\n"
                "                update(IngestionJob)\n"
                "                .where(IngestionJob.job_id.in_(open_job_ids))\n"
                "                .values(\n"
                "                    status=JOB_STATUS_FAILED,\n"
                "                    safe_error=DOCUMENT_DELETED,\n"
                "                    lease_owner=None,\n"
                "                    lease_token=None,\n"
                "                    lease_expires_at=None,\n"
                "                    finished_at=now,\n"
                "                )\n"
                "            )",
                "        # REVERT: leave the open jobs alone.",
            )
        ],
    ),
    "activation refuses an inactive document": (
        "app/ingestion/store.py",
        (
            "tests/test_replacement.py::"
            "test_activation_refuses_a_document_that_was_deleted_mid_flight"
        ),
        [
            (
                '        if document.status != "active":\n'
                "            # Deleting fails every open job and clears its lease, so the ownership"
                "\n            # read above already refuses this document in practice."
                " The check is\n"
                '            # kept so "a deleted document is never published" is enforced here\n'
                "            # rather than left to be inferred from three other functions.\n"
                '            raise DocumentDeletedError("the document was deleted'
                ' during processing")',
                "        # REVERT: publish over a retired document.",
            )
        ],
    ),
    "a failed job drops the staging policy it owned": (
        "app/ingestion/store.py",
        "tests/test_replacement.py::test_a_narrowing_survives_a_failed_replacement",
        [
            (
                "        job.finished_at = _now()\n"
                "    await _release_staging_policy(session, document_id=document_id)",
                "        job.finished_at = _now()\n"
                "        # REVERT: leave the staging columns in place.",
            )
        ],
    ),
    "the ceiling reaches a replacement, not only a create": (
        "app/api/upload_guard.py",
        (
            "tests/test_manager_lifecycle_api.py::"
            "test_an_oversized_replacement_body_is_refused_before_it_is_parsed"
        ),
        [
            (
                'GUARDED_METHODS = frozenset({"POST", "PUT"})',
                'GUARDED_METHODS = frozenset({"POST"})  # REVERT',
            )
        ],
    ),
    "a delete decides its job set under the document lock": (
        "app/ingestion/store.py",
        "tests/test_replacement.py::test_a_job_staged_just_before_a_delete_is_not_left_open",
        [
            (
                "        document = (\n"
                "            await session.execute(\n"
                "                select(Document).where(Document.document_id == document_id)"
                ".with_for_update()\n"
                "            )\n"
                "        ).scalar_one_or_none()\n"
                '        if document is None or document.status == "inactive":\n'
                "            return\n"
                "\n"
                "        # Read while the document row is held",
                "        # REVERT: no document lock, so the snapshot is read with nothing held.\n"
                "        document = (\n"
                "            await session.execute(\n"
                "                select(Document).where(Document.document_id == document_id)\n"
                "            )\n"
                "        ).scalar_one_or_none()\n"
                '        if document is None or document.status == "inactive":\n'
                "            return\n"
                "\n"
                "        # Read while the document row is held",
            )
        ],
    ),
    "the worker terminalises a job whose document was deleted mid-run": (
        "app/ingestion/worker.py",
        (
            "tests/test_replacement.py::"
            "test_the_worker_terminalises_a_job_for_a_document_deleted_mid_flight"
        ),
        [
            (
                "            await self._discard_and_fail(claim, DOCUMENT_DELETED)",
                "            # REVERT: report the deletion without writing anything.",
            )
        ],
    ),
    "the identifier mark spans the document's whole history": (
        "app/ingestion/sections.py",
        (
            "tests/test_replacement.py::"
            "test_an_identifier_dropped_by_an_earlier_replacement_is_not_handed_out_again"
        ),
        [
            (
                "    high_water = max(\n        [historical_high_water]",
                "    # REVERT: trust the base revision alone.\n"
                "    historical_high_water = max(\n"
                "        [_split(identifier)[1] for identifier, _ in previous] + [-1]\n"
                "    )\n"
                "    high_water = max(\n"
                "        [historical_high_water]",
            )
        ],
    ),
    "an exhausted job is cleaned up even when a valid one is claimed": (
        "app/ingestion/store.py",
        (
            "tests/test_replacement.py::"
            "test_an_exhausted_job_is_terminalised_even_when_another_job_is_claimed"
        ),
        [
            (
                "            # Break rather than return: returning here skipped the cleanup below"
                " and\n"
                "            # left an exhausted job's staging columns behind (Part 10 review).\n"
                "            break",
                "            return claimed  # REVERT: skip the exhausted-job cleanup",
            )
        ],
    ),
    "a replacement keeps the identifiers its citations name": (
        "app/ingestion/worker.py",
        (
            "tests/test_replacement.py::"
            "test_a_replacement_reuses_the_identifiers_of_the_sections_it_keeps"
        ),
        [
            (
                "        if claim.operation == OPERATION_REPLACE:\n"
                "            parsed = await self._restate_section_ids(claim, parsed)",
                "        # REVERT: keep the parser's positional identifiers.",
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
    backup = pathlib.Path(tempfile.mkdtemp(prefix="part10-revert-"))
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
                caught = completed.returncode != 0
                tail = [line for line in completed.stdout.splitlines() if line.strip()][-1:]
                outcomes.append((name, caught, tail[0] if tail else ""))
            finally:
                shutil.copy2(saved, target)
    finally:
        shutil.rmtree(backup, ignore_errors=True)

    width = max(len(name) for name, _, _ in outcomes)
    unenforced = 0
    for name, caught, tail in outcomes:
        verdict = "caught" if caught else "NOT CAUGHT"
        print(f"{name.ljust(width)}  {verdict}  {tail}")
        if not caught:
            unenforced += 1

    print()
    print(f"{len(outcomes) - unenforced}/{len(outcomes)} guards proved by a failing test")
    return 1 if unenforced else 0


if __name__ == "__main__":
    raise SystemExit(main())
