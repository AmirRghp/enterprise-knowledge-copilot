"""Tests for the two store reads Part 15 adds.

Both are authorization surfaces, so most of these tests are about what they *refuse* to
return. A list endpoint that leaks one document, or a section read that answers for a
document the actor may not read, is the failure this whole project is organised around -
and a passing happy-path test would not notice either.

The three-way identity matters most: **absent, forbidden and stale must be the same
absence.** They arrive by different routes - the row does not exist, the allowlist excludes
it, or the revision asked for is no longer current - and a caller that can tell them apart
can enumerate the corpus one probe at a time. So the negative cases compare the results to
each other, not just to "falsy".

Section ids are discovered from the database rather than written down. The fixture's
``DOC-001`` gets bare ``S0``/``S1``/``S2`` while the corpus import preserves
``HR-001-S1``-style ids, so a hard-coded value would be testing ingestion's numbering
scheme instead of this function's access control.
"""

import uuid
from typing import Any

import pytest
from sqlalchemy import select

from app.db.models import Section
from app.domain.models import Actor, Role
from app.ingestion import store as ingestion_store
from app.retrieval import store as retrieval_store
from tests.test_retrieval import (
    EMPLOYEE_DOCUMENT,
    EMPLOYEE_TEXT,
    MANAGER_DOCUMENT,
    MANAGER_TEXT,
    FakeProvider,
    _publish,
    _scenario,
    _worker,
)

STALE_REVISION = "00000000-0000-0000-0000-000000000000"


def _actor(role: Role = "employee") -> Actor:
    return Actor(user_id=uuid.uuid4(), role=role, session_id=uuid.uuid4())


async def _documents(factory: Any) -> None:
    await _publish(
        factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
    )
    await _publish(factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager")


async def _revision_of(factory: Any, document_id: str) -> str:
    async with factory() as session:
        listed = await retrieval_store.list_retrievable_documents(session, _actor("manager"))
    return next(row.revision for row in listed if row.document_id == document_id)


async def _section_id_of(factory: Any, document_id: str) -> str:
    async with factory() as session:
        rows = (
            await session.execute(
                select(Section.section_id)
                .where(Section.document_id == document_id)
                .order_by(Section.ordinal)
            )
        ).all()
    assert rows, f"no sections exist for {document_id}"
    return str(rows[0][0])


async def _read(
    factory: Any,
    role: Role,
    *,
    document_id: str,
    section_id: str,
    revision: str,
) -> Any:
    async with factory() as session:
        return await retrieval_store.read_source_section(
            session,
            _actor(role),
            document_id=document_id,
            section_id=section_id,
            revision=revision,
        )


# --------------------------------------------------------------------------
# listing
# --------------------------------------------------------------------------


def test_an_employee_lists_only_employee_documents() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)

        async with factory() as session:
            listed = await retrieval_store.list_retrievable_documents(session, _actor())

        assert [row.document_id for row in listed] == [EMPLOYEE_DOCUMENT]
        assert all(row.access_role == "employee" for row in listed)

    _scenario(body)


def test_a_manager_lists_manager_and_employee_documents() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)

        async with factory() as session:
            listed = await retrieval_store.list_retrievable_documents(session, _actor("manager"))

        assert {row.document_id for row in listed} == {EMPLOYEE_DOCUMENT, MANAGER_DOCUMENT}

    _scenario(body)


def test_each_document_appears_once_however_many_chunks_it_has() -> None:
    """The allowlist predicate joins the chunk table, so without ``distinct`` this triples."""

    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)

        async with factory() as session:
            listed = await retrieval_store.list_retrievable_documents(session, _actor())

        ids = [row.document_id for row in listed]
        assert len(ids) == len(set(ids))

    _scenario(body)


def test_the_list_carries_the_revision_a_citation_needs() -> None:
    """A list without the current revision is a list a caller cannot cite from."""

    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)

        async with factory() as session:
            listed = await retrieval_store.list_retrievable_documents(session, _actor())

        assert listed[0].revision
        assert listed[0].title

    _scenario(body)


def test_a_deleted_document_leaves_the_list() -> None:
    """The allowlist requires an active document, so a soft delete removes it."""

    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)
        async with factory() as session:
            await ingestion_store.soft_delete_document(
                session, actor=_actor("manager"), document_id=EMPLOYEE_DOCUMENT
            )

        async with factory() as session:
            listed = await retrieval_store.list_retrievable_documents(session, _actor())

        assert listed == []

    _scenario(body)


def test_a_document_that_is_not_published_yet_is_not_listed() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text=EMPLOYEE_TEXT,
            access_role="employee",
            publish=False,
        )

        async with factory() as session:
            listed = await retrieval_store.list_retrievable_documents(session, _actor())

        assert listed == []

    _scenario(body)


def test_the_list_is_ordered_so_it_works_as_a_catalogue() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)

        async with factory() as session:
            listed = await retrieval_store.list_retrievable_documents(session, _actor("manager"))

        ids = [row.document_id for row in listed]
        assert ids == sorted(ids)

    _scenario(body)


# --------------------------------------------------------------------------
# reading one section
# --------------------------------------------------------------------------


def test_the_current_revision_reads_the_section_verbatim() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)
        section = await _read(
            factory,
            "employee",
            document_id=EMPLOYEE_DOCUMENT,
            section_id=await _section_id_of(factory, EMPLOYEE_DOCUMENT),
            revision=await _revision_of(factory, EMPLOYEE_DOCUMENT),
        )

        assert section is not None
        # Verbatim: what a reader compares a claim's quote against must be the ingested
        # text, not the normalized derivation retrieval searches with.
        assert section.source_text in EMPLOYEE_TEXT
        assert section.title
        assert section.revision

    _scenario(body)


def test_a_manager_reads_a_manager_section() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)
        section = await _read(
            factory,
            "manager",
            document_id=MANAGER_DOCUMENT,
            section_id=await _section_id_of(factory, MANAGER_DOCUMENT),
            revision=await _revision_of(factory, MANAGER_DOCUMENT),
        )

        assert section is not None
        assert "مدیران" in section.source_text

    _scenario(body)


def test_the_three_refusals_are_indistinguishable() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)
        manager_revision = await _revision_of(factory, MANAGER_DOCUMENT)
        manager_section = await _section_id_of(factory, MANAGER_DOCUMENT)
        employee_section = await _section_id_of(factory, EMPLOYEE_DOCUMENT)

        absent = await _read(
            factory,
            "employee",
            document_id="NO-SUCH-DOC",
            section_id="NO-SUCH-SECTION",
            revision=manager_revision,
        )
        forbidden = await _read(
            factory,
            "employee",
            document_id=MANAGER_DOCUMENT,
            section_id=manager_section,
            revision=manager_revision,
        )
        stale = await _read(
            factory,
            "employee",
            document_id=EMPLOYEE_DOCUMENT,
            section_id=employee_section,
            revision=STALE_REVISION,
        )

        assert absent is forbidden is None
        assert stale is None
        # And the readable one is genuinely different, so the assertions above are not
        # passing because the store returns None for everything.
        readable = await _read(
            factory,
            "employee",
            document_id=EMPLOYEE_DOCUMENT,
            section_id=employee_section,
            revision=await _revision_of(factory, EMPLOYEE_DOCUMENT),
        )
        assert readable is not None

    _scenario(body)


def test_a_forbidden_section_reads_as_absent() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)

        section = await _read(
            factory,
            "employee",
            document_id=MANAGER_DOCUMENT,
            section_id=await _section_id_of(factory, MANAGER_DOCUMENT),
            revision=await _revision_of(factory, MANAGER_DOCUMENT),
        )

        assert section is None

    _scenario(body)


def test_a_stale_revision_reads_as_absent() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)
        current = await _revision_of(factory, EMPLOYEE_DOCUMENT)

        section = await _read(
            factory,
            "employee",
            document_id=EMPLOYEE_DOCUMENT,
            section_id=await _section_id_of(factory, EMPLOYEE_DOCUMENT),
            revision=STALE_REVISION,
        )

        assert section is None
        # The current revision did resolve, so the absence is about the revision asked for.
        assert current != STALE_REVISION

    _scenario(body)


def test_an_unknown_section_of_a_readable_document_reads_as_absent() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)

        section = await _read(
            factory,
            "employee",
            document_id=EMPLOYEE_DOCUMENT,
            section_id="NO-SUCH-SECTION",
            revision=await _revision_of(factory, EMPLOYEE_DOCUMENT),
        )

        assert section is None

    _scenario(body)


def test_a_replaced_document_answers_only_at_the_new_revision() -> None:
    """A citation handed out before a replacement must fail, not show text that moved on."""
    from app.ingestion.contracts import UploadInput

    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)
        old_revision = await _revision_of(factory, EMPLOYEE_DOCUMENT)
        section_id = await _section_id_of(factory, EMPLOYEE_DOCUMENT)

        before = await _read(
            factory,
            "employee",
            document_id=EMPLOYEE_DOCUMENT,
            section_id=section_id,
            revision=old_revision,
        )
        assert before is not None

        async with factory() as session:
            await ingestion_store.stage_replace(
                session,
                actor=_actor("manager"),
                document_id=EMPLOYEE_DOCUMENT,
                text_body=EMPLOYEE_TEXT + "\n## افزوده\n\nمتن تازه.\n",
                metadata=UploadInput(title="سند تازه", access_role="employee"),  # type: ignore[arg-type]
            )
        for _ in range(8):
            if await _worker(factory, FakeProvider()).process_next_job() is None:
                break

        after = await _read(
            factory,
            "employee",
            document_id=EMPLOYEE_DOCUMENT,
            section_id=section_id,
            revision=old_revision,
        )
        new_revision = await _revision_of(factory, EMPLOYEE_DOCUMENT)

        assert after is None
        assert new_revision != old_revision

    _scenario(body)


@pytest.mark.parametrize(("role", "expected"), [("employee", 1), ("manager", 2)])
def test_each_role_sees_exactly_its_own_share(role: Role, expected: int) -> None:
    """Neither role gets a count that reveals the other role's total beyond its own."""

    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)

        async with factory() as session:
            listed = await retrieval_store.list_retrievable_documents(session, _actor(role))

        assert len(listed) == expected

    _scenario(body)


class _FailingSession:
    """A session whose ``execute`` always raises, standing in for a broken connection."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    async def execute(self, *args: Any, **kwargs: Any) -> Any:
        raise self._error


def test_a_database_fault_propagates_rather_than_reading_as_absent() -> None:
    """Fail loudly. A 404 here would be a lie about a document that does exist."""

    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)
        broken = _FailingSession(RuntimeError("the connection went away"))

        with pytest.raises(RuntimeError, match="connection went away"):
            await retrieval_store.read_source_section(
                broken,  # type: ignore[arg-type]
                _actor(),
                document_id=EMPLOYEE_DOCUMENT,
                section_id="S0",
                revision=STALE_REVISION,
            )

    _scenario(body)


def test_the_list_also_propagates_a_fault() -> None:
    """The same rule on the other new read, so the two cannot drift apart."""

    async def body(engine: Any, factory: Any) -> None:
        await _documents(factory)
        broken = _FailingSession(RuntimeError("the connection went away"))

        with pytest.raises(RuntimeError, match="connection went away"):
            await retrieval_store.list_retrievable_documents(
                broken,  # type: ignore[arg-type]
                _actor(),
            )

    _scenario(body)
