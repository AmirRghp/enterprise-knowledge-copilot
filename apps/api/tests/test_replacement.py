"""Tests for section-identifier stability, replacement, and logical delete.

Runs against the isolated ``enterprise_knowledge_copilot_test`` database only, with
a deterministic fake embedding provider, so no test reaches Ollama and no vector
depends on a live model.

The negative cases are the point. An unknown document, a second replacement while
one is already in flight, a replacement of a deleted document, a replacement whose
document is deleted mid-flight, and an activation of an inactive document must each
be refused, and each refusal must leave the previously published revision in place
and searchable.

The access rules are asserted in both directions because they are the easiest thing
in this part of the design to get backwards: a *narrowing* has to be in force while
the replacement is still running, and a *widening* must not be.
"""

import asyncio
import hashlib
import uuid
from collections.abc import Callable, Coroutine, Sequence
from typing import Any

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db import models as db_models
from app.db import url as db_url
from app.db.engine import create_engine, create_session_factory
from app.db.models import Document
from app.documents.parse import parse_document
from app.domain.models import Actor
from app.ingestion import store
from app.ingestion.contracts import (
    JOB_STATUS_FAILED,
    OPERATION_REPLACE,
    UploadInput,
    UploadRejectedError,
)
from app.ingestion.sections import stable_section_ids
from app.ingestion.store import (
    DocumentDeletedError,
    DocumentNotFoundError,
    LeaseLostError,
    ReplacementConflictError,
    StaleRevisionError,
)
from app.ingestion.worker import OUTCOME_FAILED, OUTCOME_READY, IngestionWorker
from app.settings import Settings

DIMENSION = 768
TEST_DIGEST = "0f6a1c2b3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f"
TEST_MODEL = "fake-embed-v1"
TEST_PROVIDER = "fake"

# Four revisions of one document. They are shaped so the identifier rules are
# observable, and so that after v3 the highest identifier is *spent and also dropped
# from the base revision* - the only shape in which the document's history, rather
# than its current revision, is what stops a new section from taking an identifier
# that already belonged to a removed section.
#
#   v1 -> S0 S1 S2   مقدمه, شرایط, استثنا
#   v2 -> S0 S2 S3   مقدمه, استثنا, مهلت        شرایط/S1 is spent
#   v3 -> S0 S2      مقدمه, استثنا               مهلت/S3 is spent and now dropped too
#   v4 -> S0 S2 S4   مقدمه, استثنا, بازپرداخت    the new one has to clear S3
VERSION_1 = """# سیاست بازپرداخت

مقدمه‌ای کوتاه.

## شرایط

شرط اول.

## استثنا

استثنای اول.
"""

VERSION_2 = """# سیاست بازپرداخت

مقدمه‌ای کوتاه.

## استثنا

استثنای اول.

## مهلت

مهلت اول.
"""

VERSION_3 = """# سیاست بازپرداخت

مقدمه‌ای کوتاه.

## استثنا

استثنای اول.
"""

VERSION_4 = """# سیاست بازپرداخت

مقدمه‌ای کوتاه.

## استثنا

استثنای اول.

## بازپرداخت

بازپرداخت اول.
"""

# A body the parser cannot turn into a citable document. An unterminated
# front-matter block fails deterministically, which is the permanent failure
# class ARCHITECTURE.md section 12 describes.
UNPARSEABLE = "---\ntitle: x\nkey: y\n\nمتن بدنه\n"
TITLE_1 = "سیاست بازپرداخت"
TITLE_2 = "سیاست بازپرداخت (ویرایش دوم)"
TITLE_3 = "سیاست بازپرداخت (ویرایش سوم)"


def _settings() -> Settings:
    """Load the real environment but pin the database to the isolated one."""
    return Settings(db_name="enterprise_knowledge_copilot_test")


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    """Run one coroutine on a single event loop; asyncpg binds a connection to it."""
    return asyncio.run(coroutine)


@pytest.fixture(autouse=True)
def isolated_database() -> None:
    """Guard against ever pointing a test at the application database."""
    settings = _settings()
    assert settings.db_name == "enterprise_knowledge_copilot_test"
    assert db_url.PROJECT_DATABASES == {
        "enterprise_knowledge_copilot",
        "enterprise_knowledge_copilot_test",
        "enterprise-pgvector",
    }


def _vector(text: str) -> list[float]:
    """A deterministic, finite, correctly sized vector derived from ``text``."""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [digest[index % len(digest)] / 255.0 for index in range(DIMENSION)]


class FakeProvider:
    """A deterministic stand-in for the Ollama adapter."""

    def __init__(self) -> None:
        self._digest: str | None = None
        self.calls: list[list[str]] = []

    @property
    def provider_name(self) -> str:
        return TEST_PROVIDER

    @property
    def model(self) -> str:
        return TEST_MODEL

    @property
    def dimension(self) -> int:
        return DIMENSION

    @property
    def last_digest(self) -> str | None:
        return self._digest

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        self._digest = TEST_DIGEST
        return [_vector(text) for text in texts]

    async def embed_query(self, text: str) -> list[float]:
        return [_vector(text)]


class RetiringProvider(FakeProvider):
    """Retires its document on the first embed, so the delete lands mid-run.

    Retiring the document from inside the provider is what puts the worker between a
    live lease and its activation with the job still open: nothing but
    ``DocumentDeletedError`` can stop that run.
    """

    def __init__(self, *, document_id: str, factory: async_sessionmaker[AsyncSession]) -> None:
        super().__init__()
        self._document_id = document_id
        self._factory = factory
        self._retired = False

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not self._retired:
            self._retired = True
            async with self._factory() as session:
                await session.execute(
                    update(Document)
                    .where(Document.document_id == self._document_id)
                    .values(status="inactive")
                )
                await session.commit()
        return await super().embed_documents(texts)


class WordCounter:
    """A stand-in token counter, so no test downloads the real tokenizer."""

    def count(self, text: str) -> int:
        return len(text.split())


def _manager() -> Actor:
    return Actor(user_id=uuid.uuid4(), role="manager", session_id=uuid.uuid4())


def _employee() -> Actor:
    return Actor(user_id=uuid.uuid4(), role="employee", session_id=uuid.uuid4())


async def _wipe(engine: AsyncEngine) -> None:
    async with engine.begin() as connection:
        await connection.execute(delete(db_models.Chunk))
        await connection.execute(delete(db_models.Section))
        await connection.execute(delete(db_models.IngestionJob))
        await connection.execute(delete(db_models.Document))


def _scenario[Result](
    body: Callable[[AsyncEngine, async_sessionmaker[AsyncSession]], Coroutine[Any, Any, Result]],
) -> Result:
    async def main() -> Result:
        engine = create_engine(_settings())
        try:
            await _wipe(engine)
            return await body(engine, create_session_factory(engine))
        finally:
            await engine.dispose()

    return _run(main())


def _worker(
    factory: async_sessionmaker[AsyncSession], provider: FakeProvider, **overrides: Any
) -> IngestionWorker:
    defaults: dict[str, Any] = {
        "worker_id": "worker-replacement",
        "lease_seconds": 120,
        "renew_seconds": 0.01,
        "max_attempts": 3,
        "max_current_chunks": 2000,
        "counter": WordCounter(),
    }
    return IngestionWorker(session_factory=factory, provider=provider, **{**defaults, **overrides})


async def _publish(
    factory: async_sessionmaker[AsyncSession],
    provider: FakeProvider,
    *,
    text: str = VERSION_1,
    title: str = TITLE_1,
    access_role: str = "employee",
) -> str:
    """Stage a create, run it to ``ready``, and return the document id."""
    async with factory() as session:
        job = await store.stage_upload(
            session,
            actor=_manager(),
            text_body=text,
            metadata=UploadInput(title=title, access_role=access_role),  # type: ignore[arg-type]
            max_active_documents=100,
        )
    outcome = await _worker(factory, provider).process_next_job()
    assert outcome is not None
    assert outcome.outcome == OUTCOME_READY, outcome.safe_error
    assert outcome.job_id == job.job_id
    return job.document_id


async def _replace(
    factory: async_sessionmaker[AsyncSession],
    *,
    document_id: str,
    text: str = VERSION_2,
    title: str = TITLE_2,
    access_role: str = "employee",
) -> Any:
    async with factory() as session:
        return await store.stage_replace(
            session,
            actor=_manager(),
            document_id=document_id,
            text_body=text,
            metadata=UploadInput(title=title, access_role=access_role),  # type: ignore[arg-type]
        )


async def _document(factory: async_sessionmaker[AsyncSession], document_id: str) -> Document | None:
    async with factory() as session:
        return await session.get(Document, document_id)


async def _published_section_ids(
    factory: async_sessionmaker[AsyncSession], document_id: str
) -> list[str]:
    """Return the current revision's section ids, in ordinal order."""
    async with factory() as session:
        document = await session.get(Document, document_id)
        assert document is not None
        pairs, _ = await store.read_section_identity(
            session, document_id=document_id, base_revision=document.current_revision
        )
    return [section_id for section_id, _ in pairs]


async def _replace_and_run(
    factory: async_sessionmaker[AsyncSession],
    provider: FakeProvider,
    document_id: str,
    text: str,
) -> None:
    """Stage one replacement and run it to ``ready``."""
    await _replace(factory, document_id=document_id, text=text)
    outcome = await _worker(factory, provider).process_next_job()
    assert outcome is not None and outcome.outcome == OUTCOME_READY, outcome.safe_error


async def _open_job_count(factory: async_sessionmaker[AsyncSession], document_id: str) -> int:
    """Count this document's jobs that are not yet terminal."""
    async with factory() as session:
        return int(
            (
                await session.execute(
                    select(func.count())
                    .select_from(db_models.IngestionJob)
                    .where(
                        db_models.IngestionJob.document_id == document_id,
                        db_models.IngestionJob.status.in_(("pending", "indexing")),
                    )
                )
            ).scalar_one()
        )


async def _claim(factory: async_sessionmaker[AsyncSession]) -> Any:
    """Claim the next job, so a test can act with a real fencing token."""
    async with factory() as session:
        claim = await store.claim_next_job(
            session, worker_id="worker-a", lease_seconds=120, max_attempts=3
        )
    assert claim is not None
    return claim


async def _stage_one_chunk(factory: async_sessionmaker[AsyncSession]) -> None:
    """Write one real section and chunk for the currently claimed job.

    Stands in for the middle of an ingestion run, so a test can act on a document
    that genuinely has staged rows on top of its published ones.
    """
    claim = await _claim(factory)
    async with factory() as session:
        await store.write_revision(
            session,
            claim=claim,
            content=store.RevisionContent(
                sections=[
                    store.StagedSection(
                        section_id="S9",
                        ordinal=0,
                        title="مرحله‌ای",
                        heading_path=("مرحله‌ای",),
                        source_text="متن مرحله‌ای",
                        search_text="متن مرحله‌ای",
                    )
                ],
                chunks=[
                    store.StagedChunk(
                        section_id="S9",
                        ordinal=0,
                        chunk_text="متن مرحله‌ای",
                        search_text="متن مرحله‌ای",
                        embedding=_vector("متن مرحله‌ای"),
                        provider=TEST_PROVIDER,
                        model=TEST_MODEL,
                        digest=TEST_DIGEST,
                        dimension=DIMENSION,
                    )
                ],
            ),
        )


def test_an_exhausted_job_is_terminalised_even_when_another_job_is_claimed() -> None:
    """Part 10 review: the cleanup must run before a successful claim returns.

    A ran out of retries and is failed; B is claimable. A's staging columns have to
    be dropped even though B is returned, while B's own staging columns and the
    policy B is carrying must both survive.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        provider = FakeProvider()
        # Both documents are published before either replacement is staged, so the
        # worker running a create never picks up a replacement the test is still
        # setting up.
        exhausted_document = await _publish(factory, provider, access_role="employee")
        claimed_document = await _publish(factory, provider, access_role="manager")
        job_a = await _replace(
            factory, document_id=exhausted_document, title=TITLE_2, access_role="manager"
        )
        job_b = await _replace(
            factory, document_id=claimed_document, title=TITLE_3, access_role="employee"
        )

        async with factory() as session:
            await session.execute(
                update(db_models.IngestionJob)
                .where(db_models.IngestionJob.job_id == job_a.job_id)
                .values(attempt_count=3)
            )
            await session.commit()

        async with factory() as session:
            claim = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )

        assert claim is not None, "the valid job must still be claimable"
        assert claim.job_id == job_b.job_id, "the exhausted job sorts first and is skipped"
        async with factory() as session:
            row = await session.get(db_models.IngestionJob, job_a.job_id)
        assert row is not None
        assert row.status == JOB_STATUS_FAILED
        assert row.safe_error == store.RETRY_BUDGET_EXHAUSTED

        # A's staging is gone.
        document = await _document(factory, exhausted_document)
        assert document is not None
        assert document.staged_title is None
        assert document.staged_access_role is None
        # ...but the narrowing it already applied is not.
        assert document.access_role == "manager"

        # B's staging survives, and so does the policy it is carrying.
        document = await _document(factory, claimed_document)
        assert document is not None
        assert document.staged_title == TITLE_3
        assert document.staged_access_role == "employee"
        assert document.access_role == "manager", "B widens nothing until it activates"

    _scenario(body)


# --------------------------------------------------------------------------
# section identifier stability, with no database at all
# --------------------------------------------------------------------------


def assign(
    previous: list[tuple[str, str]],
    incoming: str | Sequence[Any],
    *,
    high_water: int = -1,
) -> list[str]:
    """Assign identifiers, with ``high_water`` defaulting to the base revision's own.

    Tests that are about the mapping itself pass the default; the ones about the
    mark pass it explicitly.
    """
    sections = parse_document(incoming).sections if isinstance(incoming, str) else incoming
    return stable_section_ids(previous, sections, historical_high_water=high_water)


def test_the_first_revision_keeps_the_parsers_identifiers() -> None:
    """With nothing published yet there is no citation to protect."""
    assert assign([], VERSION_1) == [
        section.section_id for section in parse_document(VERSION_1).sections
    ]


def test_a_preserved_section_keeps_its_identifier_through_a_reorder() -> None:
    """Position moves when a section is removed; the citation handle must not."""
    previous = [
        (section.section_id, section.title) for section in parse_document(VERSION_1).sections
    ]
    incoming = parse_document(VERSION_2).sections

    assigned = assign(previous, VERSION_2)

    by_title = {
        section.title: identifier for section, identifier in zip(incoming, assigned, strict=True)
    }
    assert by_title == {"مقدمه": "S0", "استثنا": "S2", "مهلت": "S3"}


def test_a_removed_sections_identifier_is_never_recycled() -> None:
    """Handing a freed id to a different section would silently repoint citations."""
    previous = [
        (section.section_id, section.title) for section in parse_document(VERSION_1).sections
    ]
    assigned = assign(previous, VERSION_2)

    assert "S1" not in assigned, assigned
    assert assigned == ["S0", "S2", "S3"]


def test_a_gap_below_the_mark_is_never_filled() -> None:
    """The discriminating case for "above the mark".

    This ``previous`` is what a document actually reaches once earlier replacements
    have left holes in its identifiers. The incoming document's own identifiers are
    positional and contiguous, so a freed gap is only visible here, and filling it
    would hand an old citation's identifier to a section that never existed under it.
    """
    previous = [("S2", "شرط"), ("S3", "مهلت")]

    assert assign(previous, "# a\n\n## تازه\n\nیک\n", high_water=3) == ["S4"]


def test_a_spent_identifier_survives_a_dropped_highest_section() -> None:
    """Part 10 review: the mark is the whole history, not the base revision.

    This document once had ``A:S1`` and ``B:S3`` - ``S2`` was spent in an earlier
    revision and is not in the base. Reading the mark from the base alone would hand
    ``S3`` to the new section ``C``, repointing every citation that referenced ``B``.
    """
    base = [("S1", "الف")]

    assert assign(base, "# a\n\n## الف\n\nیک\n\n## ج\n\nدو\n", high_water=3) == [
        "S1",
        "S4",
    ]


def test_a_stale_mark_cannot_hand_out_a_spent_identifier() -> None:
    """A caller passing too low a mark can only make ids higher, never collide.

    The incoming document's own provisional ids raise the mark as well, so even a
    mark of zero cannot make the function allocate ``S2`` when ``S2`` is already in
    the incoming set.
    """
    incoming = parse_document("# a\n\n## الف\n\nیک\n\n## ج\n\nدو\n").sections

    assigned = assign([("S1", "الف")], incoming, high_water=0)

    assert assigned == ["S1", "S3"]
    assert len(set(assigned)) == len(assigned)
    assert not set(assigned) & {section.section_id for section in incoming[1:]}


def test_a_missing_base_with_a_real_history_falls_back_to_the_general_rule() -> None:
    """Parser ids are only trusted for a document that has never been published."""
    incoming = parse_document("# a\n\n## الف\n\nیک\n\n## ج\n\nدو\n").sections

    assigned = assign([], incoming, high_water=3)

    assert assigned == ["S4", "S5"]


def test_a_retitled_section_is_a_new_section() -> None:
    """A rename changes what the section cites, so it earns a new identifier."""
    assert assign([("S1", "شرایط")], "# a\n\n## شرایط و استثنا\n\nمتن\n") == ["S2"]


def test_a_document_identifier_prefix_is_kept_for_new_sections() -> None:
    """Corpus documents number their sections DOC-001-S1; a replacement stays in style."""
    previous = [("DOC-001-S1", "شرایط"), ("DOC-001-S2", "استثنا")]

    assert assign(previous, "# a\n\n## استثنا\n\nیک\n\n## مهلت\n\nدو\n") == [
        "DOC-001-S2",
        "DOC-001-S3",
    ]


def test_mixed_prefixes_fall_back_to_the_bare_form() -> None:
    """A document whose ids disagree has no single prefix to extend."""
    previous = [("DOC-001-S1", "شرایط"), ("S4", "استثنا")]

    assert assign(previous, "# a\n\n## تازه\n\nیک\n") == ["S5"]


def test_two_incoming_sections_with_the_same_title_stay_distinct() -> None:
    """The identifier is a primary key, so a duplicate title cannot collapse into one."""
    previous = [("S1", "شرایط"), ("S2", "شرایط")]

    assigned = assign(previous, "# a\n\n## شرایط\n\nیک\n\n## شرایط\n\nدو\n")

    assert assigned == ["S1", "S2"]
    assert len(set(assigned)) == len(assigned)


def test_an_incoming_identifier_above_the_mark_is_not_handed_out_twice() -> None:
    """The incoming document's own ids raise the mark, so nothing collides."""
    assigned = assign([("S1", "شرایط")], "DOC-009-S7: شرایط\n\nمتن\n\n## تازه\n\nیک\n")

    assert len(set(assigned)) == len(assigned)


# --------------------------------------------------------------------------
# who may replace and delete
# --------------------------------------------------------------------------


def test_an_employee_cannot_replace_a_document() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        with pytest.raises(UploadRejectedError):
            async with factory() as session:
                await store.stage_replace(
                    session,
                    actor=_employee(),
                    document_id=document_id,
                    text_body=VERSION_2,
                    metadata=UploadInput(title=TITLE_2, access_role="employee"),  # type: ignore[arg-type]
                )

    _scenario(body)


def test_an_employee_cannot_delete_a_document() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        with pytest.raises(UploadRejectedError):
            async with factory() as session:
                await store.soft_delete_document(
                    session, actor=_employee(), document_id=document_id
                )
        document = await _document(factory, document_id)
        assert document is not None and document.status == "active"

    _scenario(body)


def test_replacing_an_unknown_document_is_refused() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        with pytest.raises(DocumentNotFoundError):
            async with factory() as session:
                await store.stage_replace(
                    session,
                    actor=_manager(),
                    document_id="DOC-404",
                    text_body=VERSION_2,
                    metadata=UploadInput(title=TITLE_2, access_role="employee"),  # type: ignore[arg-type]
                )
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.IngestionJob))
            ).scalar_one() == 0

    _scenario(body)


def test_a_second_replacement_in_flight_is_refused_and_does_not_clobber_the_first() -> None:
    """Two live jobs would overwrite each other's staged policy."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        await _replace(factory, document_id=document_id, title=TITLE_2, access_role="manager")

        with pytest.raises(ReplacementConflictError):
            async with factory() as session:
                await store.stage_replace(
                    session,
                    actor=_manager(),
                    document_id=document_id,
                    text_body=VERSION_2,
                    metadata=UploadInput(title="تهاجمی", access_role="employee"),  # type: ignore[arg-type]
                )

        document = await _document(factory, document_id)
        assert document is not None
        # The refused request changed nothing, least of all the first one's policy.
        assert document.staged_title == TITLE_2
        assert document.staged_access_role == "manager"
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.IngestionJob))
            ).scalar_one() == 2

    _scenario(body)


def test_replacing_a_deleted_document_is_refused() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        async with factory() as session:
            await store.soft_delete_document(session, actor=_manager(), document_id=document_id)

        with pytest.raises(ReplacementConflictError):
            async with factory() as session:
                await store.stage_replace(
                    session,
                    actor=_manager(),
                    document_id=document_id,
                    text_body=VERSION_2,
                    metadata=UploadInput(title=TITLE_2, access_role="employee"),  # type: ignore[arg-type]
                )

    _scenario(body)


# --------------------------------------------------------------------------
# access: a narrowing is immediate, a widening waits for activation
# --------------------------------------------------------------------------


def test_a_narrowing_applies_before_the_replacement_is_activated() -> None:
    """Withdrawing access must not wait on an ingestion run."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider(), access_role="employee")
        before = await _published_section_ids(factory, document_id)
        assert before

        await _replace(factory, document_id=document_id, access_role="manager")

        document = await _document(factory, document_id)
        assert document is not None
        assert document.access_role == "manager"
        assert document.staged_access_role == "manager"
        # Still the old revision, unchanged, until the job activates.
        assert await _published_section_ids(factory, document_id) == before

    _scenario(body)


def test_a_widening_does_not_apply_before_activation() -> None:
    """A newly permitted reader must not reach the old revision early."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider(), access_role="manager")

        await _replace(factory, document_id=document_id, access_role="employee")

        document = await _document(factory, document_id)
        assert document is not None
        assert document.access_role == "manager"
        assert document.staged_access_role == "employee"

    _scenario(body)


def test_a_widening_applies_at_activation_and_the_staging_columns_are_cleared() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider(), access_role="manager")
        job = await _replace(factory, document_id=document_id, access_role="employee")

        outcome = await _worker(factory, FakeProvider()).process_next_job()

        assert outcome is not None and outcome.job_id == job.job_id
        assert outcome.outcome == OUTCOME_READY, outcome.safe_error
        document = await _document(factory, document_id)
        assert document is not None
        assert document.access_role == "employee"
        assert document.staged_access_role is None
        assert document.staged_title is None

    _scenario(body)


def test_the_title_applies_at_activation_not_at_staging() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider(), title=TITLE_1)

        await _replace(factory, document_id=document_id, title=TITLE_2)
        document = await _document(factory, document_id)
        assert document is not None
        assert document.title == TITLE_1, "a staged title must not label the old text"

        await _worker(factory, FakeProvider()).process_next_job()
        document = await _document(factory, document_id)
        assert document is not None
        assert document.title == TITLE_2

    _scenario(body)


def test_a_narrowing_survives_a_failed_replacement() -> None:
    """The alternative keeps a withdrawn policy in force for one processing run."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider(), access_role="employee")
        job = await _replace(
            factory, document_id=document_id, text=UNPARSEABLE, access_role="manager"
        )

        outcome = await _worker(factory, FakeProvider()).process_next_job()

        assert outcome is not None and outcome.job_id == job.job_id
        assert outcome.outcome == OUTCOME_FAILED
        document = await _document(factory, document_id)
        assert document is not None
        assert document.access_role == "manager", "the narrowing must not be rolled back"
        # Nothing that was only pending is left behind.
        assert document.staged_access_role is None
        assert document.staged_title is None
        assert document.current_revision is not None

    _scenario(body)


def test_a_failed_replacement_leaves_the_published_revision_searchable() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        before = await _published_section_ids(factory, document_id)

        await _replace(factory, document_id=document_id, text=UNPARSEABLE)
        await _worker(factory, FakeProvider()).process_next_job()

        document = await _document(factory, document_id)
        assert document is not None
        assert document.title == TITLE_1
        assert await _published_section_ids(factory, document_id) == before
        async with factory() as session:
            published = await session.execute(
                select(func.count())
                .select_from(db_models.Chunk)
                .where(db_models.Chunk.revision == document.current_revision)
            )
            assert published.scalar_one() > 0

    _scenario(body)


def test_releasing_a_staging_policy_leaves_a_newer_replacement_alone() -> None:
    """The clear is skipped while any job still needs it, which is what closes the race."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        await _replace(factory, document_id=document_id, title=TITLE_2)

        async with factory() as session:
            await store._release_staging_policy(session, document_id=document_id)

        document = await _document(factory, document_id)
        assert document is not None
        assert document.staged_title == TITLE_2

    _scenario(body)


# --------------------------------------------------------------------------
# identifiers survive an actual replacement
# --------------------------------------------------------------------------


def test_a_replacement_reuses_the_identifiers_of_the_sections_it_keeps() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        first = await _published_section_ids(factory, document_id)
        assert first == ["S0", "S1", "S2"]

        await _replace(factory, document_id=document_id, text=VERSION_2)
        outcome = await _worker(factory, FakeProvider()).process_next_job()

        assert outcome is not None and outcome.outcome == OUTCOME_READY, outcome.safe_error
        assert await _published_section_ids(factory, document_id) == ["S0", "S2", "S3"]
        # The removed section's id is gone for good.
        assert "S1" not in await _published_section_ids(factory, document_id)

    _scenario(body)


def test_an_identifier_dropped_by_an_earlier_replacement_is_not_handed_out_again() -> None:
    """Part 10 review: the mark spans the whole history, not the base revision.

    v1 publishes S0..S2; v2 drops شرایط and gets S3; v3 then drops مهلت, so the base
    revision's highest identifier is S2 while S3 is spent. v4 adds a section and it
    has to clear S3: reading the mark from the base revision alone would hand S3 out
    again, even though it already belonged to the section v3 removed.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        provider = FakeProvider()
        document_id = await _publish(factory, provider)
        assert await _published_section_ids(factory, document_id) == ["S0", "S1", "S2"]

        await _replace_and_run(factory, provider, document_id, VERSION_2)
        assert await _published_section_ids(factory, document_id) == ["S0", "S2", "S3"]

        await _replace_and_run(factory, provider, document_id, VERSION_3)
        base = await _published_section_ids(factory, document_id)
        assert base == ["S0", "S2"], base
        assert "S3" not in base, base

        await _replace_and_run(factory, provider, document_id, VERSION_4)
        final = await _published_section_ids(factory, document_id)

        assert final == ["S0", "S2", "S4"], final
        assert "S1" not in final and "S3" not in final, final

    _scenario(body)


def test_a_replacement_rewrites_every_chunk_to_the_surviving_identifier() -> None:
    """A chunk left pointing at a removed id would be uncitable and unjoinable."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        await _replace(factory, document_id=document_id, text=VERSION_2)
        await _worker(factory, FakeProvider()).process_next_job()

        document = await _document(factory, document_id)
        assert document is not None
        async with factory() as session:
            sections = (
                await session.execute(
                    select(db_models.Section.section_id).where(
                        db_models.Section.revision == document.current_revision
                    )
                )
            ).scalars()
            chunks = (
                await session.execute(
                    select(db_models.Chunk.section_id).where(
                        db_models.Chunk.revision == document.current_revision
                    )
                )
            ).scalars()
            assert set(chunks) <= set(sections), (set(chunks), set(sections))

    _scenario(body)


def test_a_claim_carries_the_policy_that_will_be_in_force_when_it_activates() -> None:
    """The new revision is built for the pending policy, not for the one it replaces."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider(), access_role="manager")
        published = await _document(factory, document_id)
        assert published is not None and published.current_revision is not None
        job = await _replace(factory, document_id=document_id, access_role="employee")

        claim = await _claim(factory)

        assert claim.operation == "replace"
        assert claim.job_id == job.job_id
        # The base the compare-and-swap will check is the revision that was current
        # when the replacement was staged.
        assert claim.expected_current_revision == published.current_revision
        assert claim.access_role == "employee"
        # Which is not the policy in force yet.
        document = await _document(factory, document_id)
        assert document is not None and document.access_role == "manager"

    _scenario(body)


def test_a_create_claim_carries_the_effective_policy_and_says_it_is_a_create() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        # Staged but not yet run, so there is a claim to make.
        async with factory() as session:
            job = await store.stage_upload(
                session,
                actor=_manager(),
                text_body=VERSION_1,
                metadata=UploadInput(title=TITLE_1, access_role="manager"),  # type: ignore[arg-type]
                max_active_documents=100,
            )

        claim = await _claim(factory)

        assert claim.operation == "create"
        assert claim.job_id == job.job_id
        assert claim.access_role == "manager"
        assert claim.expected_current_revision is None

    _scenario(body)


# --------------------------------------------------------------------------
# logical delete
# --------------------------------------------------------------------------


def test_deleting_retires_the_document_and_keeps_the_published_revision() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())

        async with factory() as session:
            await store.soft_delete_document(session, actor=_manager(), document_id=document_id)

        document = await _document(factory, document_id)
        assert document is not None
        assert document.status == "inactive"
        # Logical, not physical: the pointer and the text are still there.
        assert document.current_revision is not None
        async with factory() as session:
            assert (
                await session.execute(
                    select(func.count())
                    .select_from(db_models.Chunk)
                    .where(db_models.Chunk.revision == document.current_revision)
                )
            ).scalar_one() > 0

    _scenario(body)


def test_deleting_twice_is_a_no_op() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        for _ in range(2):
            async with factory() as session:
                await store.soft_delete_document(session, actor=_manager(), document_id=document_id)
        document = await _document(factory, document_id)
        assert document is not None and document.status == "inactive"

    _scenario(body)


def test_deleting_an_unknown_document_is_a_no_op() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        async with factory() as session:
            await store.soft_delete_document(session, actor=_manager(), document_id="DOC-404")
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)


def test_deleting_fails_an_open_replacement_and_a_worker_cannot_resurrect_it() -> None:
    """The lease is cleared, so the in-flight worker stops at its next fenced write."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        provider = FakeProvider()
        document_id = await _publish(factory, provider)
        job = await _replace(factory, document_id=document_id)

        async with factory() as session:
            claim = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )
        assert claim is not None

        async with factory() as session:
            await store.soft_delete_document(session, actor=_manager(), document_id=document_id)

        async with factory() as session:
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            assert row.status == JOB_STATUS_FAILED
            assert row.safe_error == store.DOCUMENT_DELETED
            assert row.lease_token is None and row.lease_expires_at is None

        # The replaced worker still thinks it owns the job; its writes must be refused.
        async with factory() as session:
            with pytest.raises(LeaseLostError):
                await store.write_revision(
                    session,
                    claim=claim,
                    content=store.RevisionContent(sections=(), chunks=()),
                )

        document = await _document(factory, document_id)
        assert document is not None and document.status == "inactive"
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Chunk))
            ).scalar_one() > 0

    _scenario(body)


def test_deleting_drops_a_staged_revision_but_keeps_the_published_one() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        staged = await _replace(factory, document_id=document_id)
        await _stage_one_chunk(factory)

        async with factory() as session:
            await store.soft_delete_document(session, actor=_manager(), document_id=document_id)

        document = await _document(factory, document_id)
        assert document is not None
        async with factory() as session:
            for model in (db_models.Section, db_models.Chunk):
                assert (
                    await session.execute(
                        select(func.count())
                        .select_from(model)
                        .where(model.revision == staged.revision)
                    )
                ).scalar_one() == 0, model
                assert (
                    await session.execute(
                        select(func.count())
                        .select_from(model)
                        .where(model.revision == document.current_revision)
                    )
                ).scalar_one() > 0, model

    _scenario(body)


def test_a_job_staged_just_before_a_delete_is_not_left_open() -> None:
    """Part 10 review: the delete must decide its job set *under* the document lock.

    The holder below stands in for a staging transaction that has taken the document
    row and has not inserted its job yet - the interleaving the report reproduced.
    With the job snapshot read before the document lock, the delete sees an empty
    set, commits, and the new job stays ``pending`` forever on a deleted document.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())

        async with factory() as holder:
            await holder.begin()
            # Exactly the lock a staging transaction holds across its whole decision.
            await holder.execute(
                select(Document).where(Document.document_id == document_id).with_for_update()
            )

            async def delete() -> None:
                async with factory() as session:
                    await store.soft_delete_document(
                        session, actor=_manager(), document_id=document_id
                    )

            deleting = asyncio.create_task(delete())
            # Long enough for the delete to reach and block on the document row.
            await asyncio.sleep(0.3)
            assert not deleting.done()

            published = await _document(factory, document_id)
            assert published is not None
            staged = store._add_job(
                holder,
                document_id=document_id,
                text_body=VERSION_2,
                operation=OPERATION_REPLACE,
                expected_current_revision=published.current_revision,
            )
            await holder.commit()
            await deleting

        document = await _document(factory, document_id)
        assert document is not None and document.status == "inactive"
        async with factory() as session:
            row = await session.get(db_models.IngestionJob, staged.job_id)
        assert row is not None, "the job staged during the delete must exist"
        assert row.status == JOB_STATUS_FAILED
        assert row.lease_token is None and row.lease_expires_at is None
        assert await _open_job_count(factory, document_id) == 0

    _scenario(body)


def test_the_other_commit_order_leaves_no_job_either() -> None:
    """Delete first: the staging that follows is refused, so nothing is created."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        async with factory() as session:
            await store.soft_delete_document(session, actor=_manager(), document_id=document_id)

        with pytest.raises(ReplacementConflictError):
            await _replace(factory, document_id=document_id)

        assert await _open_job_count(factory, document_id) == 0

    _scenario(body)


def test_the_worker_terminalises_a_job_for_a_document_deleted_mid_flight() -> None:
    """Part 10 review, second half: the worker must not leave its own job open."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        job = await _replace(factory, document_id=document_id)

        # The document is retired from inside the provider, so the worker is between a
        # live lease and its activation with the job still open. Nothing but
        # ``DocumentDeletedError`` can stop that run, so only the worker's own handling
        # can clean up after it.
        provider = RetiringProvider(document_id=document_id, factory=factory)

        outcome = await _worker(factory, provider).process_next_job()

        assert outcome is not None and outcome.job_id == job.job_id
        assert outcome.outcome == OUTCOME_FAILED
        async with factory() as session:
            row = await session.get(db_models.IngestionJob, job.job_id)
            staged_rows = (
                await session.execute(
                    select(func.count())
                    .select_from(db_models.Chunk)
                    .where(db_models.Chunk.revision == job.revision)
                )
            ).scalar_one()
        assert row is not None
        assert row.status == JOB_STATUS_FAILED
        assert row.safe_error == store.DOCUMENT_DELETED
        assert row.lease_token is None and row.lease_expires_at is None
        assert staged_rows == 0, "the discarded revision must not stay in the tables"

    _scenario(body)


def test_deleting_clears_the_pending_policy() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider(), access_role="manager")
        await _replace(factory, document_id=document_id, access_role="employee")

        async with factory() as session:
            await store.soft_delete_document(session, actor=_manager(), document_id=document_id)

        document = await _document(factory, document_id)
        assert document is not None
        assert document.staged_title is None
        assert document.staged_access_role is None
        # The widening never happened and never will.
        assert document.access_role == "manager"

    _scenario(body)


def test_activation_refuses_a_document_that_was_deleted_mid_flight() -> None:
    """Reached when the document is retired without the job being failed with it."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        provider = FakeProvider()
        document_id = await _publish(factory, provider)
        await _replace(factory, document_id=document_id)

        async with factory() as session:
            claim = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )
        assert claim is not None

        # Retire the document but leave the job and its lease intact, so the guard in
        # ``activate_revision`` is what refuses rather than the fencing read.
        async with factory() as session:
            await session.execute(
                update(Document)
                .where(Document.document_id == document_id)
                .values(status="inactive")
            )
            await session.commit()

        async with factory() as session:
            with pytest.raises(DocumentDeletedError):
                await store.activate_revision(
                    session,
                    claim=claim,
                    content_version="v2",
                    max_current_chunks=2000,
                )

        document = await _document(factory, document_id)
        assert document is not None
        assert document.current_revision != claim.target_revision

    _scenario(body)


def test_a_replacement_whose_base_revision_moved_does_not_publish() -> None:
    """The compare-and-swap is what decides when a base revision moves mid-run."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        document_id = await _publish(factory, FakeProvider())
        await _worker(factory, FakeProvider()).process_next_job()
        job = await _replace(factory, document_id=document_id, title=TITLE_3, access_role="manager")
        claim = await _claim(factory)

        # A revision became current behind this job's back, which is what a
        # concurrent activation of the same document looks like to it.
        async with factory() as session:
            await session.execute(
                update(Document)
                .where(Document.document_id == document_id)
                .values(current_revision="a-newer-revision", content_version="v9")
            )
            await session.commit()

        async with factory() as session:
            with pytest.raises(StaleRevisionError):
                await store.activate_revision(
                    session, claim=claim, content_version="v3", max_current_chunks=2000
                )

        document = await _document(factory, document_id)
        assert document is not None
        assert document.current_revision == "a-newer-revision"
        # The rejected activation unwound whole, so the pending policy is still there
        # for the job to be failed or retried with.
        assert document.staged_title == TITLE_3
        assert document.staged_access_role == "manager"
        assert job.document_id == document_id

    _scenario(body)
