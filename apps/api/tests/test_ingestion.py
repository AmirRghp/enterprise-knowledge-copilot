"""Tests for validated upload, the durable queue, and the ingestion worker.

Runs against the isolated ``enterprise_knowledge_copilot_test`` database only,
matching ``test_auth.py``. The embedding provider is a deterministic fake, so no
test reaches Ollama and no vector depends on a live model.

The negative cases are the point of this file. A lease that expired mid-flight, a
reclaimed job, a provider that returns the wrong number of vectors, a permanent
parse failure, an exhausted retry budget, and a quota overflow must each leave the
database in the documented state - above all, a document that failed must never
become retrievable.
"""

import asyncio
import hashlib
import threading
import uuid
from collections.abc import Callable, Coroutine
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import delete, event, func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db import models as db_models
from app.db import url as db_url
from app.db.engine import create_engine, create_session_factory
from app.db.models import Document
from app.domain.models import Actor
from app.ingestion import store
from app.ingestion.contracts import (
    JOB_STATUS_FAILED,
    JOB_STATUS_INDEXING,
    JOB_STATUS_PENDING,
    JOB_STATUS_READY,
    UploadInput,
    UploadRejectedError,
)
from app.ingestion.limits import (
    decode_utf8,
    read_capped,
    read_upload_bytes,
    validate_suffix,
)
from app.ingestion.store import ClaimedJob, LeaseLostError, RevisionContent
from app.ingestion.worker import (
    ACTIVATION_REJECTED,
    MODEL_CHANGED,
    OUTCOME_ABANDONED,
    OUTCOME_FAILED,
    OUTCOME_READY,
    OUTCOME_RETRY,
    PARSE_FAILED,
    PROVIDER_REFUSED,
    PROVIDER_UNREACHABLE,
    QUOTA_EXCEEDED,
    VECTOR_REJECTED,
    IngestionWorker,
)
from app.providers.base import (
    EmbeddingModelChangedError,
    EmbeddingProviderError,
    EmbeddingValidationError,
)
from app.providers.retry import RetryableError
from app.settings import Settings

DIMENSION = 768
TEST_DIGEST = "ff9c2f10ef5e3722623a1b396e1e04efc27a93112c83e9b7b7b9ca1d05620965"
TEST_MODEL = "fake-embed-v1"
TEST_PROVIDER = "fake"

SAMPLE_DOCUMENT = """# سیاست بازپرداخت

هزینه سفر تا سقف روزانه بازپرداخت می‌شود.

## شرایط

رسید باید به نام کارمند صادر شود.
"""


def _settings() -> Settings:
    """Load the real environment but pin the database to the isolated one.

    ``_env_file`` is deliberately left at its default so the DB password comes
    from the root ``.env``; only ``db_name`` is overridden, and the autouse
    fixture asserts that override actually took effect.
    """
    return Settings(db_name="enterprise_knowledge_copilot_test")


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    """Run one coroutine on a single event loop.

    asyncpg binds a connection to the loop that created it, so every async step
    for one test has to share one ``asyncio.run``. That is also why the engine is
    built inside the scenario rather than in a module-scoped fixture.
    """
    return asyncio.run(coroutine)


@pytest.fixture(autouse=True)
def isolated_database() -> None:
    """Guard against ever pointing a test at the application database."""
    settings = _settings()
    assert settings.db_name == "enterprise_knowledge_copilot_test"
    assert db_url.PROJECT_DATABASES == {
        "enterprise_knowledge_copilot",
        "enterprise_knowledge_copilot_test",
    }


def _vector(text: str) -> list[float]:
    """Return a deterministic, finite, correctly sized vector for ``text``.

    Derived from a hash so the same text always produces the same vector and two
    different texts do not collide into one, which makes a misaligned batch
    visible in an assertion instead of invisible.
    """
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [digest[index % len(digest)] / 255.0 for index in range(DIMENSION)]


class FakeProvider:
    """A deterministic stand-in for the Ollama adapter.

    Records the calls it received so a test can prove that no provider request
    happened when a check was supposed to reject the document first.
    """

    def __init__(
        self,
        *,
        error: Exception | None = None,
        delay: float = 0.0,
        truncate_to: int | None = None,
    ) -> None:
        self._error = error
        self._delay = delay
        self._truncate_to = truncate_to
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
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._error is not None:
            raise self._error
        vectors = [_vector(text) for text in texts]
        if self._truncate_to is not None:
            vectors = [vector[: self._truncate_to] for vector in vectors]
        # The digest is verified before every real embed, so it is set here too.
        self._digest = TEST_DIGEST
        return vectors

    async def embed_query(self, text: str) -> list[float]:
        self.calls.append([text])
        return _vector(text)


class WordCounter:
    """A stand-in token counter, so no test downloads the real tokenizer."""

    def count(self, text: str) -> int:
        return len(text.split())


def _manager() -> Actor:
    return Actor(user_id=uuid.uuid4(), role="manager", session_id=uuid.uuid4())


def _employee() -> Actor:
    return Actor(user_id=uuid.uuid4(), role="employee", session_id=uuid.uuid4())


async def _wipe(engine: AsyncEngine) -> None:
    """Clear the ingestion tables so each test starts from an empty database."""
    async with engine.begin() as connection:
        await connection.execute(delete(db_models.Chunk))
        await connection.execute(delete(db_models.Section))
        await connection.execute(delete(db_models.IngestionJob))
        await connection.execute(delete(db_models.Document))


def _scenario[Result](
    body: Callable[[AsyncEngine, async_sessionmaker[AsyncSession]], Coroutine[Any, Any, Result]],
) -> Result:
    """Open an engine on the test database, run ``body``, then dispose it."""

    async def main() -> Result:
        engine = create_engine(_settings())
        try:
            await _wipe(engine)
            return await body(engine, create_session_factory(engine))
        finally:
            await engine.dispose()

    return _run(main())


def _worker(
    factory: async_sessionmaker[AsyncSession],
    provider: FakeProvider,
    *,
    worker_id: str = "worker-test",
    renew_seconds: float = 0.01,
    lease_seconds: int = 120,
    max_attempts: int = 3,
    max_current_chunks: int = 2000,
) -> IngestionWorker:
    return IngestionWorker(
        session_factory=factory,
        provider=provider,
        worker_id=worker_id,
        lease_seconds=lease_seconds,
        renew_seconds=renew_seconds,
        max_attempts=max_attempts,
        max_current_chunks=max_current_chunks,
        counter=WordCounter(),
    )


async def _upload(
    factory: async_sessionmaker[AsyncSession],
    *,
    text: str = SAMPLE_DOCUMENT,
    title: str = "سیاست بازپرداخت",
    access_role: str = "employee",
    max_active_documents: int = 100,
) -> Any:
    """Stage one upload and return the resulting job view."""
    async with factory() as session:
        return await store.stage_upload(
            session,
            actor=_manager(),
            text_body=text,
            metadata=UploadInput(title=title, access_role=access_role),  # type: ignore[arg-type]
            max_active_documents=max_active_documents,
        )


# --------------------------------------------------------------------------
# upload limits, applied before any write
# --------------------------------------------------------------------------


@pytest.mark.parametrize("filename", [None, "", "notes", "report.pdf", "x.exe", "notes.md.sh"])
def test_only_markdown_and_plain_text_are_accepted(filename: str | None) -> None:
    with pytest.raises(UploadRejectedError):
        validate_suffix(filename)


@pytest.mark.parametrize(
    "filename",
    # archive.md.txt is accepted: the documented rule is the final extension, and
    # both allowed formats are inert text, so there is nothing to bypass.
    ["a.md", "a.txt", "REPORT.MD", "notes.Txt", "archive.md.txt"],
)
def test_allowed_suffixes_pass_in_any_case(filename: str) -> None:
    validate_suffix(filename)


def test_an_oversized_upload_is_rejected() -> None:
    with pytest.raises(UploadRejectedError):
        read_capped(b"x" * 11, max_bytes=10)


def test_a_size_exactly_at_the_ceiling_is_accepted() -> None:
    assert read_capped(b"x" * 10, max_bytes=10) == b"x" * 10


def test_invalid_utf8_is_rejected_rather_than_replaced() -> None:
    # A lenient decode would silently corrupt the stored staging text.
    with pytest.raises(UploadRejectedError):
        decode_utf8(b"\xff\xfe bad")


def test_a_blank_file_is_rejected() -> None:
    with pytest.raises(UploadRejectedError):
        decode_utf8(b"   \n\t ")


def test_the_extension_check_runs_before_the_size_check() -> None:
    with pytest.raises(UploadRejectedError) as caught:
        read_upload_bytes(b"x" * 100, filename="bad.pdf", max_bytes=10)
    assert "only .md and .txt" in caught.value.safe_code


# --------------------------------------------------------------------------
# staging
# --------------------------------------------------------------------------


def test_upload_stages_a_document_with_no_current_revision() -> None:
    """Nothing about a new document is retrievable until a worker activates it."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        assert job.status == JOB_STATUS_PENDING
        assert job.attempt == 0
        assert job.safe_error is None

        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None
            assert document.status == "active"
            assert document.content_version == "unpublished"
            assert document.access_role == "employee"
            # Server-generated, opaque, and distinct from the revision id.
            assert uuid.UUID(job.document_id)
            assert uuid.UUID(job.revision)
            assert job.document_id != job.revision
            # The staging text is kept so a retry needs no raw file again.
            stored = await session.get(db_models.IngestionJob, job.job_id)
            assert stored is not None
            assert stored.source_text == SAMPLE_DOCUMENT

    _scenario(body)


def test_access_role_comes_from_metadata_not_the_file() -> None:
    """A file claiming manager access must not escalate the document."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        hostile = "---\naccess_role: manager\n---\n\n# سند\n\nمتن.\n"
        job = await _upload(factory, text=hostile, access_role="employee")
        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.access_role == "employee"

    _scenario(body)


def test_a_non_manager_cannot_stage_an_upload() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        async with factory() as session:
            with pytest.raises(UploadRejectedError):
                await store.stage_upload(
                    session,
                    actor=_employee(),
                    text_body=SAMPLE_DOCUMENT,
                    metadata=UploadInput(title="x", access_role="employee"),
                    max_active_documents=100,
                )
        async with factory() as session:
            assert (await session.execute(select(db_models.Document))).all() == []

    _scenario(body)


@pytest.mark.parametrize("title", ["", "   ", "\t\n"])
def test_a_blank_title_is_rejected_before_staging(title: str) -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        async with factory() as session:
            with pytest.raises(UploadRejectedError):
                await store.stage_upload(
                    session,
                    actor=_manager(),
                    text_body=SAMPLE_DOCUMENT,
                    metadata=UploadInput(title=title, access_role="employee"),
                    max_active_documents=100,
                )

    _scenario(body)


def test_the_active_document_quota_is_enforced() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        await _upload(factory, max_active_documents=1)
        with pytest.raises(UploadRejectedError) as caught:
            await _upload(factory, title="دوم", max_active_documents=1)
        assert "limit" in caught.value.safe_code
        async with factory() as session:
            assert len((await session.execute(select(db_models.Document))).all()) == 1

    _scenario(body)


# --------------------------------------------------------------------------
# the happy path: upload to ready
# --------------------------------------------------------------------------


def test_a_document_reaches_ready_with_sections_and_vectors() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        outcome = await _worker(factory, FakeProvider()).process_next_job()
        assert outcome is not None
        assert outcome.outcome == OUTCOME_READY
        assert outcome.attempt == 1

        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision == job.revision
            assert document.content_version == "1.0"

            sections = (
                (
                    await session.execute(
                        select(db_models.Section).where(db_models.Section.revision == job.revision)
                    )
                )
                .scalars()
                .all()
            )
            assert len(sections) >= 2

            chunks = (
                (
                    await session.execute(
                        select(db_models.Chunk).where(db_models.Chunk.revision == job.revision)
                    )
                )
                .scalars()
                .all()
            )
            assert chunks, "a ready document must have retrievable chunks"
            for chunk in chunks:
                assert chunk.embedding is not None
                assert len(chunk.embedding) == DIMENSION
                # Provenance travels with the vector so a stale index can fail closed.
                assert chunk.embedding_provider == TEST_PROVIDER
                assert chunk.embedding_model == TEST_MODEL
                assert chunk.embedding_digest == TEST_DIGEST
                assert chunk.embedding_dimension == DIMENSION
                assert len(chunk.chunk_text) <= 1200

            finished = await session.get(db_models.IngestionJob, job.job_id)
            assert finished is not None
            assert finished.status == JOB_STATUS_READY
            assert finished.safe_error is None
            assert finished.finished_at is not None
            # The CHECK constraint requires all three lease columns to be NULL
            # outside indexing, so a ready job must have released the lease.
            assert finished.lease_owner is None
            assert finished.lease_token is None
            assert finished.lease_expires_at is None

    _scenario(body)


def test_an_empty_queue_reports_no_work() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        assert await _worker(factory, FakeProvider()).process_next_job() is None

    _scenario(body)


def test_chunks_are_embedded_only_after_the_quota_check() -> None:
    """A quota rejection must not pay for a single embedding."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        provider = FakeProvider()
        worker = _worker(factory, provider, max_current_chunks=0)
        outcome = await worker.process_next_job()

        assert outcome is not None
        assert outcome.outcome == OUTCOME_FAILED
        assert outcome.safe_error == QUOTA_EXCEEDED
        assert provider.calls == [], "the provider must not be called for an over-quota job"

        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None, "a failed job must publish nothing"
            assert (
                await session.execute(select(func.count()).select_from(db_models.Chunk))
            ).scalar_one() == 0

    _scenario(body)


# --------------------------------------------------------------------------
# the queue: lease, reclaim, fencing, retry budget
# --------------------------------------------------------------------------


def test_a_claim_mints_a_fresh_fencing_token_each_time() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        async with factory() as session:
            first = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )
        assert isinstance(first, ClaimedJob)
        assert first.attempt == 1
        assert first.lease_token is not None
        assert first.access_role == "employee"
        assert first.expected_current_revision is None
        assert first.job_id == job.job_id

        # Expire the lease, then reclaim it as another worker.
        async with factory() as session:
            await session.execute(
                update(db_models.IngestionJob)
                .where(db_models.IngestionJob.job_id == job.job_id)
                .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
            )
            await session.commit()
        async with factory() as session:
            second = await store.claim_next_job(
                session, worker_id="worker-b", lease_seconds=120, max_attempts=3
            )
        assert isinstance(second, ClaimedJob)
        assert second.lease_token != first.lease_token, "a reclaim must rotate the token"
        assert second.attempt == 2

    _scenario(body)


def test_a_stale_lease_cannot_write_or_activate() -> None:
    """The fencing token is what stops a slow worker corrupting a reclaimed job."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        async with factory() as session:
            stale = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )
        assert isinstance(stale, ClaimedJob)

        # Another worker reclaims the job and installs its own token.
        async with factory() as session:
            await session.execute(
                update(db_models.IngestionJob)
                .where(db_models.IngestionJob.job_id == job.job_id)
                .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
            )
            await session.commit()
        async with factory() as session:
            fresh = await store.claim_next_job(
                session, worker_id="worker-b", lease_seconds=120, max_attempts=3
            )
        assert isinstance(fresh, ClaimedJob)

        content = _empty_content(stale)
        async with factory() as session:
            with pytest.raises(LeaseLostError):
                await store.write_revision(session, claim=stale, content=content)
        async with factory() as session:
            with pytest.raises(LeaseLostError):
                await store.activate_revision(
                    session, claim=stale, content_version="1.0", max_current_chunks=2000
                )

        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Chunk))
            ).scalar_one() == 0
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None

    _scenario(body)


def test_a_worker_that_lost_its_lease_abandons_without_writing() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        provider = FakeProvider(delay=0.05)
        worker = _worker(factory, provider)

        # Start the worker, then steal the lease while it is embedding.
        task = asyncio.create_task(worker.process_next_job())
        await asyncio.sleep(0.01)
        async with factory() as session:
            await session.execute(
                update(db_models.IngestionJob)
                .where(db_models.IngestionJob.job_id == job.job_id)
                .values(
                    status=JOB_STATUS_INDEXING,
                    lease_owner="thief",
                    lease_token=uuid.uuid4(),
                    lease_expires_at=datetime.now(UTC) + timedelta(seconds=300),
                )
            )
            await session.commit()
        outcome = await task

        assert outcome is not None
        assert outcome.outcome == OUTCOME_ABANDONED
        assert outcome.safe_error == "lease lost to another worker"
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Chunk))
            ).scalar_one() == 0
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None

    _scenario(body)


def test_the_lease_is_renewed_while_a_slow_job_runs() -> None:
    """A job slower than the renew interval keeps its claim."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        provider = FakeProvider(delay=0.2)
        # Renew ten times inside a 200 ms embed and watch the expiry move.
        worker = _worker(factory, provider, renew_seconds=0.02, lease_seconds=2)

        async def observe() -> list[datetime | None]:
            seen: list[datetime | None] = []
            for _ in range(3):
                await asyncio.sleep(0.05)
                async with factory() as session:
                    row = await session.get(db_models.IngestionJob, job.job_id)
                    seen.append(None if row is None else row.lease_expires_at)
            return seen

        watcher = asyncio.create_task(observe())
        outcome = await worker.process_next_job()
        seen = await watcher

        assert outcome is not None
        assert outcome.outcome == OUTCOME_READY
        # The expiry moved forward at least twice while the embed was running.
        distinct = {value for value in seen if value is not None}
        assert len(distinct) >= 2, f"the lease was never renewed: {seen}"

    _scenario(body)


def test_a_transient_failure_returns_the_job_to_the_queue() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        provider = FakeProvider(error=RetryableError("connection reset"))
        outcome = await _worker(factory, provider).process_next_job()

        assert outcome is not None
        assert outcome.outcome == OUTCOME_RETRY
        assert outcome.safe_error == PROVIDER_UNREACHABLE
        async with factory() as session:
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            assert row.status == JOB_STATUS_PENDING
            # The attempt was counted at claim time and is not refunded.
            assert row.attempt_count == 1
            assert row.lease_token is None
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None

    _scenario(body)


def test_a_permanent_parse_failure_is_not_retried() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory, text="   \n\n")
        provider = FakeProvider()
        outcome = await _worker(factory, provider).process_next_job()

        assert outcome is not None
        assert outcome.outcome == OUTCOME_FAILED
        assert outcome.safe_error == PARSE_FAILED
        assert provider.calls == []
        async with factory() as session:
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            assert row.status == JOB_STATUS_FAILED
            assert row.finished_at is not None
            # The safe code names the failure class and carries no document text.
            assert row.safe_error == PARSE_FAILED
            assert "   \n\n" not in row.safe_error

    _scenario(body)


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (RetryableError("x"), PROVIDER_UNREACHABLE),
        (EmbeddingValidationError("bad vector"), VECTOR_REJECTED),
        (EmbeddingModelChangedError("digest"), MODEL_CHANGED),
        (EmbeddingProviderError("unknown model"), PROVIDER_REFUSED),
    ],
)
def test_provider_failures_are_classified(error: Exception, expected: str) -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        outcome = await _worker(factory, FakeProvider(error=error)).process_next_job()

        assert outcome is not None
        assert outcome.safe_error == expected
        async with factory() as session:
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            expected_status = (
                JOB_STATUS_PENDING if expected == PROVIDER_UNREACHABLE else JOB_STATUS_FAILED
            )
            assert row.status == expected_status
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None
            assert (
                await session.execute(select(func.count()).select_from(db_models.Chunk))
            ).scalar_one() == 0, "a failed job must leave no chunk rows"

    _scenario(body)


def test_a_provider_that_returns_the_wrong_count_is_refused() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        await _upload(factory)
        provider = FakeProvider(truncate_to=7)
        outcome = await _worker(factory, provider).process_next_job()

        assert outcome is not None
        assert outcome.outcome == OUTCOME_FAILED
        assert outcome.safe_error == VECTOR_REJECTED

    _scenario(body)


def test_an_exhausted_retry_budget_fails_the_job() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        worker = _worker(factory, FakeProvider(error=RetryableError("down")))

        outcomes = [(await worker.process_next_job()) for _ in range(4)]

        # Three transient attempts, then the fourth claim finds an exhausted job,
        # marks it failed, and reports that the queue is now empty.
        assert [outcome.outcome if outcome else None for outcome in outcomes] == [
            OUTCOME_RETRY,
            OUTCOME_RETRY,
            OUTCOME_RETRY,
            None,
        ]
        async with factory() as session:
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            assert row.status == JOB_STATUS_FAILED
            assert row.attempt_count == 3, "the CHECK constraint caps attempts at three"
            assert row.safe_error == "retry budget exhausted"
            assert row.finished_at is not None

    _scenario(body)


def test_activation_is_rejected_when_the_current_revision_moved() -> None:
    """A compare-and-swap must not overwrite a revision that won the race."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        provider = FakeProvider(delay=0.05)
        worker = _worker(factory, provider)

        task = asyncio.create_task(worker.process_next_job())
        await asyncio.sleep(0.01)
        # Simulate another revision becoming current while this job was embedding.
        async with factory() as session:
            await session.execute(
                update(db_models.Document)
                .where(db_models.Document.document_id == job.document_id)
                .values(current_revision="someone-else")
            )
            await session.commit()
        outcome = await task

        assert outcome is not None
        assert outcome.outcome == OUTCOME_FAILED
        assert outcome.safe_error == ACTIVATION_REJECTED
        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision == "someone-else", (
                "a rejected activation must leave the live revision in place"
            )
            stored = await session.get(db_models.IngestionJob, job.job_id)
            assert stored is not None
            assert stored.status == JOB_STATUS_FAILED
            # The unpublished revision was discarded rather than left behind.
            assert (
                await session.execute(select(func.count()).select_from(db_models.Chunk))
            ).scalar_one() == 0

    _scenario(body)


def test_a_retry_replaces_its_own_partial_rows() -> None:
    """``(document_id, target_revision)`` is unique, so a retry must clear first."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        worker = _worker(factory, FakeProvider())

        async with factory() as session:
            claim = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )
        assert isinstance(claim, ClaimedJob)
        async with factory() as session:
            await store.write_revision(session, claim=claim, content=_empty_content(claim))
        # The first worker then crashed, so its lease must expire before another
        # worker is allowed to reclaim the job.
        async with factory() as session:
            await session.execute(
                update(db_models.IngestionJob)
                .where(db_models.IngestionJob.job_id == job.job_id)
                .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
            )
            await session.commit()
        async with factory() as session:
            rows = await session.execute(
                select(func.count())
                .select_from(db_models.Section)
                .where(db_models.Section.revision == job.revision)
            )
            assert rows.scalar_one() == 1

        outcome = await worker.process_next_job()
        assert outcome is not None
        assert outcome.outcome == OUTCOME_READY

        async with factory() as session:
            rows = await session.execute(
                select(func.count())
                .select_from(db_models.Section)
                .where(db_models.Section.revision == job.revision)
            )
            # The retry produced exactly the sections a clean parse would: the
            # partial row was replaced rather than accumulated alongside it.
            assert rows.scalar_one() == 2

            stale = (
                (
                    await session.execute(
                        select(db_models.Section.section_id).where(
                            db_models.Section.revision == job.revision,
                            db_models.Section.source_text == "متن",
                        )
                    )
                )
                .scalars()
                .all()
            )
            assert stale == [], "the earlier attempt's section must be gone"

    _scenario(body)


# --------------------------------------------------------------------------
# manager-facing reads
# --------------------------------------------------------------------------


def test_the_manager_list_separates_content_state_from_processing_state() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        await _upload(factory)
        await _upload(factory, title="دوم", access_role="manager")

        async with factory() as session:
            summaries = await store.list_documents(session, actor=_manager())
        assert len(summaries) == 2
        assert {summary.processing_status for summary in summaries} == {JOB_STATUS_PENDING}
        assert {summary.content_status for summary in summaries} == {"active"}
        assert all(summary.version == "unpublished" for summary in summaries)
        assert {summary.access_role for summary in summaries} == {"employee", "manager"}

        await _worker(factory, FakeProvider()).process_next_job()
        async with factory() as session:
            summaries = await store.list_documents(session, actor=_manager())
        assert sorted(summary.processing_status for summary in summaries) == [
            JOB_STATUS_PENDING,
            JOB_STATUS_READY,
        ]

    _scenario(body)


def test_an_employee_cannot_list_processing_state() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        async with factory() as session:
            with pytest.raises(UploadRejectedError):
                await store.list_documents(session, actor=_employee())

    _scenario(body)


def test_job_status_exposes_no_sensitive_detail() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        async with factory() as session:
            view = await store.read_job(session, actor=_manager(), job_id=job.job_id)
        assert view is not None
        assert view.document_id == job.document_id
        assert view.revision == job.revision
        assert view.safe_error is None
        # The staging text is never part of the job view.
        assert not hasattr(view, "source_text")

        async with factory() as session:
            assert await store.read_job(session, actor=_manager(), job_id=uuid.uuid4()) is None

    _scenario(body)


def test_the_worker_rejects_an_impossible_lease_renewal() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        with pytest.raises(ValueError, match="renew interval"):
            IngestionWorker(
                session_factory=factory,
                provider=FakeProvider(),
                worker_id="w",
                lease_seconds=10,
                renew_seconds=10,
            )

    _scenario(body)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _empty_content(claim: ClaimedJob) -> RevisionContent:
    """Build a one-section, zero-chunk revision, used by the fencing tests."""
    from app.ingestion.store import StagedSection

    return RevisionContent(
        sections=[
            StagedSection(
                section_id="S1",
                ordinal=0,
                title="بخش",
                heading_path=("بخش",),
                source_text="متن",
                search_text="متن",
            )
        ],
        chunks=[],
    )


# --------------------------------------------------------------------------
# regressions from the Part 8 review
# --------------------------------------------------------------------------


async def _expire_lease(factory: async_sessionmaker[AsyncSession], job_id: Any) -> None:
    """Push a job's lease into the past without anyone reclaiming it.

    This is the case a fencing token alone cannot catch: the row still carries the
    right token, because no newer claim replaced it.
    """
    async with factory() as session:
        await session.execute(
            update(db_models.IngestionJob)
            .where(db_models.IngestionJob.job_id == job_id)
            .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await session.commit()


def test_an_expired_lease_blocks_a_write_and_an_activation() -> None:
    """Part 8 review P1: an expired lease must be refused even with no reclaim."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        async with factory() as session:
            claim = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )
        assert isinstance(claim, ClaimedJob)
        await _expire_lease(factory, job.job_id)

        async with factory() as session:
            with pytest.raises(LeaseLostError):
                await store.write_revision(session, claim=claim, content=_empty_content(claim))
        async with factory() as session:
            with pytest.raises(LeaseLostError):
                await store.activate_revision(
                    session,
                    claim=claim,
                    content_version="1.0",
                    max_current_chunks=2000,
                )

        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None, "an expired lease must publish nothing"
            assert (
                await session.execute(select(func.count()).select_from(db_models.Chunk))
            ).scalar_one() == 0

    _scenario(body)


def test_a_renewal_cannot_revive_an_expired_lease() -> None:
    """Part 8 review P1: a late renewal must not resurrect a claim that ran out."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        async with factory() as session:
            claim = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )
        assert isinstance(claim, ClaimedJob)

        async with factory() as session:
            renewed = await store.renew_lease(
                session,
                job_id=job.job_id,
                lease_token=claim.lease_token,
                lease_seconds=120,
            )
            assert renewed is True, "a live lease may be renewed"

        await _expire_lease(factory, job.job_id)
        async with factory() as session:
            assert (
                await store.renew_lease(
                    session,
                    job_id=job.job_id,
                    lease_token=claim.lease_token,
                    lease_seconds=120,
                )
                is False
            )

        async with factory() as session:
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            assert row.lease_expires_at is not None
            assert row.lease_expires_at < datetime.now(UTC), "the expiry was extended"

    _scenario(body)


def test_a_live_lease_is_renewed_before_it_expires() -> None:
    """Part 8 review P1: a valid renewal in time still works."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        async with factory() as session:
            claim = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )
        assert isinstance(claim, ClaimedJob)
        # Nearly expired, but not yet: the renewal must be accepted.
        async with factory() as session:
            await session.execute(
                update(db_models.IngestionJob)
                .where(db_models.IngestionJob.job_id == job.job_id)
                .values(lease_expires_at=datetime.now(UTC) + timedelta(seconds=2))
            )
            await session.commit()
        async with factory() as session:
            assert await store.renew_lease(
                session,
                job_id=job.job_id,
                lease_token=claim.lease_token,
                lease_seconds=120,
            )

    _scenario(body)


def test_an_expired_worker_reads_no_document_text() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job = await _upload(factory)
        async with factory() as session:
            claim = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )
        assert isinstance(claim, ClaimedJob)
        async with factory() as session:
            assert (
                await store.read_staging_text(
                    session, job_id=job.job_id, lease_token=claim.lease_token
                )
                == SAMPLE_DOCUMENT
            )
        await _expire_lease(factory, job.job_id)
        async with factory() as session:
            assert (
                await store.read_staging_text(
                    session, job_id=job.job_id, lease_token=claim.lease_token
                )
                is None
            )

    _scenario(body)


def test_only_one_of_two_concurrent_publishers_may_take_the_last_room() -> None:
    """Part 8 review P1: the final quota check must be an atomic reservation.

    The early check before the provider call is not enough: both jobs read the same
    current count and both proceed. The binding check runs inside activation, under
    the same publisher lock every activation takes.
    """

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        two_chunk_document = "# a\n\nمتن یک.\n\n## b\n\nمتن دو.\n"
        for _ in range(2):
            await _upload(factory, text=two_chunk_document, title="سند")

        # A ceiling of two chunks admits exactly one of these two-chunk documents.
        async def run(worker_id: str) -> Any:
            return await _worker(
                factory, FakeProvider(), worker_id=worker_id, max_current_chunks=2
            ).process_next_job()

        outcomes = await asyncio.gather(run("worker-a"), run("worker-b"))
        results = [outcome.outcome for outcome in outcomes if outcome is not None]
        assert results.count(OUTCOME_READY) == 1, results
        assert results.count(OUTCOME_FAILED) == 1, results
        loser = next(o for o in outcomes if o is not None and o.outcome == OUTCOME_FAILED)
        assert loser.safe_error == QUOTA_EXCEEDED

        async with factory() as session:
            current = await store.count_current_chunks(session)
            published_count = (
                await session.execute(
                    select(func.count())
                    .select_from(Document)
                    .where(Document.current_revision.isnot(None))
                )
            ).scalar_one()
            left_over = (
                await session.execute(select(func.count()).select_from(db_models.Chunk))
            ).scalar_one()

        assert current == 2, f"the ceiling was exceeded: {current}"
        assert published_count == 1
        assert left_over == 2, "the rejected revision's rows must be discarded"

    _scenario(body)


def test_a_quota_rejection_leaves_the_live_revision_serving() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        first = await _upload(factory, title="اول")
        published = await _worker(factory, FakeProvider()).process_next_job()
        assert published is not None
        assert published.outcome == OUTCOME_READY

        async with factory() as session:
            before = await store.count_current_chunks(session)

        await _upload(factory, title="دوم", text="# a\n\nمتن.\n\n## b\n\nمتن دو.\n")
        # No room for two more chunks on top of what is already published.
        outcome = await _worker(
            factory, FakeProvider(), max_current_chunks=before
        ).process_next_job()

        assert outcome is not None
        assert outcome.outcome == OUTCOME_FAILED
        assert outcome.safe_error == QUOTA_EXCEEDED

        async with factory() as session:
            assert await store.count_current_chunks(session) == before
            still_live = await session.get(db_models.Document, first.document_id)
            assert still_live is not None
            assert still_live.current_revision == first.revision, (
                "a rejected publish must leave the live revision in place"
            )

    _scenario(body)


def test_activation_holds_the_publisher_lock_across_the_quota_check() -> None:
    """Part 8 review P1: the reservation must be serialised, not merely re-read.

    The concurrency test above catches removing the reservation outright, but it
    cannot reliably catch removing only the lock, because whether two transactions
    interleave badly is a matter of scheduling. This one pins the property itself:
    while an activation holds its transaction open, a competing session cannot take
    the publisher lock.

    A cursor hook fires inside the activation transaction and probes the lock from a
    separate thread, so the observation happens at a point where activation is
    provably mid-transaction rather than racing against it.
    """

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        await _upload(factory)
        async with factory() as session:
            claim = await store.claim_next_job(
                session, worker_id="worker-a", lease_seconds=120, max_attempts=3
            )
        assert isinstance(claim, ClaimedJob)

        probe_result: dict[str, bool] = {}

        def probe_lock_acquired() -> None:
            """Ask a separate session, on its own loop, for the publisher lock."""
            probe_engine = create_engine(_settings())

            async def attempt() -> None:
                try:
                    async with probe_engine.connect() as connection:
                        got = await connection.execute(
                            select(func.pg_try_advisory_xact_lock(store.STAGING_LOCK_KEY))
                        )
                        probe_result["acquired"] = bool(got.scalar_one())
                finally:
                    await probe_engine.dispose()

            asyncio.run(attempt())

        executions = 0

        def after_cursor_execute(*args: object, **kwargs: object) -> None:
            # Probe only once activation has taken the lock and moved past it, so the
            # answer describes the lock as activation actually holds it rather than
            # as it was before the activation started.
            nonlocal executions
            executions += 1
            if executions < 2 or probe_result:
                return
            worker = threading.Thread(target=probe_lock_acquired)
            worker.start()
            worker.join(timeout=15)
            probe_result["finished"] = not worker.is_alive()

        async with factory() as session:
            await store.write_revision(session, claim=claim, content=_empty_content(claim))

        # The listener is scoped to the activation alone: write_revision takes no
        # publisher lock, so probing there would prove nothing.
        event.listen(engine.sync_engine, "after_cursor_execute", after_cursor_execute)
        try:
            async with factory() as session:
                await store.activate_revision(
                    session,
                    claim=claim,
                    content_version="1.0",
                    max_current_chunks=2000,
                )
        finally:
            event.remove(engine.sync_engine, "after_cursor_execute", after_cursor_execute)

        assert probe_result.get("finished") is True, "the probe hung"
        assert probe_result.get("acquired") is False, (
            "a competing session took the publisher lock while an activation held its "
            "transaction open, so the quota check is not a reservation"
        )

        async with factory() as session:
            document = await session.get(db_models.Document, claim.document_id)
            assert document is not None
            assert document.current_revision == claim.target_revision

    _scenario(body)


# --------------------------------------------------------------------------
# regression from the second Part 8 review
# --------------------------------------------------------------------------
#
# PostgreSQL's ``now()`` is frozen at transaction start, so a transaction that
# begins, then blocks on a lock until after the lease has expired, compares the
# expiry against its own stale start time and concludes the lease is still live.
# The ownership check must read a live clock, and must re-check it after any wait.


async def _set_lease_expiry(
    factory: async_sessionmaker[AsyncSession], job_id: Any, *, in_seconds: float
) -> None:
    async with factory() as session:
        await session.execute(
            update(db_models.IngestionJob)
            .where(db_models.IngestionJob.job_id == job_id)
            .values(lease_expires_at=datetime.now(UTC) + timedelta(seconds=in_seconds))
        )
        await session.commit()


async def _hold_publisher_lock_for(
    factory: async_sessionmaker[AsyncSession], seconds: float
) -> None:
    """Hold the publisher lock for ``seconds``, then release it.

    Runs as a background task on the same loop, so the caller can block on the lock
    and be released when this finishes - which is exactly what the test needs.
    """

    async def holder() -> None:
        async with factory() as session:
            async with session.begin():
                await session.execute(select(func.pg_advisory_xact_lock(store.STAGING_LOCK_KEY)))
                await asyncio.sleep(seconds)

    await holder()


async def _hold_job_row_for(
    factory: async_sessionmaker[AsyncSession], job_id: Any, seconds: float
) -> None:
    """Hold the job row lock for ``seconds``, forcing a ``FOR UPDATE`` to wait."""

    async def holder() -> None:
        async with factory() as session:
            async with session.begin():
                await session.execute(
                    select(db_models.IngestionJob)
                    .where(db_models.IngestionJob.job_id == job_id)
                    .with_for_update()
                )
                await asyncio.sleep(seconds)

    await holder()


async def _claimed(factory: async_sessionmaker[AsyncSession]) -> Any:
    """Upload and claim one job, returning ``(job_view, claim)``."""
    job = await _upload(factory)
    async with factory() as session:
        claim = await store.claim_next_job(
            session, worker_id="worker-a", lease_seconds=1, max_attempts=3
        )
    assert isinstance(claim, ClaimedJob)
    return job, claim


def test_activation_behind_the_publisher_lock_still_checks_a_live_lease() -> None:
    """Part 8 review P1: a lock wait must not freeze the clock at transaction start.

    ``now()`` is the transaction start time, so blocking on the publisher lock until
    after the lease expired would still have looked live. The review's reproduction,
    turned into a regression test.
    """

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job, claim = await _claimed(factory)
        await _set_lease_expiry(factory, job.job_id, in_seconds=0.3)

        async with factory() as session:
            await store.write_revision(session, claim=claim, content=_empty_content(claim))

        holder = asyncio.create_task(_hold_publisher_lock_for(factory, 1.0))
        await asyncio.sleep(0.1)  # let the holder take the lock first
        with pytest.raises(LeaseLostError):
            async with factory() as session:
                await store.activate_revision(
                    session,
                    claim=claim,
                    content_version="1.0",
                    max_current_chunks=2000,
                )
        await holder

        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None, "an expired lease must publish nothing"
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            assert row.status != JOB_STATUS_READY, "the job must not be marked ready"
            assert row.status == JOB_STATUS_INDEXING, "it keeps its lease columns for a reclaim"

    _scenario(body)


def test_a_write_behind_the_job_row_lock_still_checks_a_live_lease() -> None:
    """The same defect on the row-lock path, which has no advisory lock at all."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job, claim = await _claimed(factory)
        await _set_lease_expiry(factory, job.job_id, in_seconds=0.3)

        holder = asyncio.create_task(_hold_job_row_for(factory, job.job_id, 1.0))
        await asyncio.sleep(0.1)
        with pytest.raises(LeaseLostError):
            async with factory() as session:
                await store.write_revision(session, claim=claim, content=_empty_content(claim))
        await holder

        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Section))
            ).scalar_one() == 0
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None

    _scenario(body)


def test_a_live_lease_still_activates_after_waiting_on_the_publisher_lock() -> None:
    """The fix must not refuse a worker that is merely slow."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job, claim = await _claimed(factory)
        await _set_lease_expiry(factory, job.job_id, in_seconds=30)

        async with factory() as session:
            await store.write_revision(session, claim=claim, content=_empty_content(claim))

        holder = asyncio.create_task(_hold_publisher_lock_for(factory, 0.3))
        await asyncio.sleep(0.1)
        async with factory() as session:
            await store.activate_revision(
                session,
                claim=claim,
                content_version="1.0",
                max_current_chunks=2000,
            )
        await holder

        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision == claim.target_revision
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            assert row.status == JOB_STATUS_READY

    _scenario(body)


def test_a_live_lease_is_still_renewable_and_the_stale_token_guard_holds() -> None:
    """Part 8 review P1: the live-clock change must not weaken the other guards."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job, claim = await _claimed(factory)
        await _set_lease_expiry(factory, job.job_id, in_seconds=30)

        # Renewal of a live lease still works.
        async with factory() as session:
            assert await store.renew_lease(
                session,
                job_id=job.job_id,
                lease_token=claim.lease_token,
                lease_seconds=120,
            )

        # A reclaim rotates the token, so the old one stays refused.
        await _expire_lease(factory, job.job_id)
        async with factory() as session:
            fresh = await store.claim_next_job(
                session, worker_id="worker-b", lease_seconds=120, max_attempts=3
            )
        assert isinstance(fresh, ClaimedJob)
        assert fresh.lease_token != claim.lease_token

        async with factory() as session:
            assert (
                await store.renew_lease(
                    session,
                    job_id=job.job_id,
                    lease_token=claim.lease_token,
                    lease_seconds=120,
                )
                is False
            )
        async with factory() as session:
            with pytest.raises(LeaseLostError):
                await store.write_revision(session, claim=claim, content=_empty_content(claim))

    _scenario(body)


def test_a_renewal_behind_the_job_row_lock_does_not_revive_an_expired_lease() -> None:
    """Part 8 review P1: the SQL clock matters where there is no Python re-check.

    ``_lock_owned_job`` re-reads a live clock after its wait, which covers the paths
    that go through it. ``renew_lease`` is a single UPDATE, so the predicate is the
    only check it has - and a predicate built on ``now()`` would compare the expiry
    against the transaction's own start time and wrongly revive a lease that expired
    while the statement waited for the row lock.
    """

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job, claim = await _claimed(factory)
        await _set_lease_expiry(factory, job.job_id, in_seconds=0.3)

        holder = asyncio.create_task(_hold_job_row_for(factory, job.job_id, 1.0))
        await asyncio.sleep(0.1)
        async with factory() as session:
            renewed = await store.renew_lease(
                session,
                job_id=job.job_id,
                lease_token=claim.lease_token,
                lease_seconds=120,
            )
        await holder

        assert renewed is False, "a renewal must not revive a lease that expired while waiting"

        async with factory() as session:
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            assert row.lease_expires_at is not None
            assert row.lease_expires_at < datetime.now(UTC) + timedelta(seconds=1), (
                "the expiry was pushed into the future"
            )

    _scenario(body)


# --------------------------------------------------------------------------
# regression from the third Part 8 review
# --------------------------------------------------------------------------
#
# Activation takes three locks in a row: the publisher advisory lock, the job row,
# and the document row. Each is a chance for the lease to run out while this
# transaction waits, so the expiry has to be re-read after the last of them, not
# only when the job row was locked.


async def _hold_document_row_for(
    factory: async_sessionmaker[AsyncSession], document_id: str, seconds: float
) -> None:
    """Hold the document row lock, forcing an activation's ``FOR UPDATE`` to wait."""

    async def holder() -> None:
        async with factory() as session:
            async with session.begin():
                await session.execute(
                    select(db_models.Document)
                    .where(db_models.Document.document_id == document_id)
                    .with_for_update()
                )
                await asyncio.sleep(seconds)

    await holder()


def test_activation_behind_the_document_row_lock_rechecks_the_lease() -> None:
    """Part 8 review P1: the review's reproduction, as a regression test.

    Activation locks the job row, and the lease is verified there. The document row
    is locked *after* that, so a wait on it can outlast the lease. Without a final
    check the activation proceeded and published anyway.
    """

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job, claim = await _claimed(factory)
        await _set_lease_expiry(factory, job.job_id, in_seconds=0.3)

        async with factory() as session:
            await store.write_revision(session, claim=claim, content=_empty_content(claim))

        holder = asyncio.create_task(_hold_document_row_for(factory, job.document_id, 1.0))
        await asyncio.sleep(0.1)
        with pytest.raises(LeaseLostError):
            async with factory() as session:
                await store.activate_revision(
                    session,
                    claim=claim,
                    content_version="1.0",
                    max_current_chunks=2000,
                )
        await holder

        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None, (
                "an activation whose lease expired must not publish"
            )
            assert document.content_version == "unpublished"
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            assert row.status != JOB_STATUS_READY
            assert row.status == JOB_STATUS_INDEXING
            assert row.finished_at is None

    _scenario(body)


def test_a_live_lease_still_activates_after_waiting_on_the_document_row_lock() -> None:
    """The final check must not refuse a worker that is merely slow."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job, claim = await _claimed(factory)
        await _set_lease_expiry(factory, job.job_id, in_seconds=30)

        async with factory() as session:
            await store.write_revision(session, claim=claim, content=_empty_content(claim))

        holder = asyncio.create_task(_hold_document_row_for(factory, job.document_id, 0.3))
        await asyncio.sleep(0.1)
        async with factory() as session:
            await store.activate_revision(
                session,
                claim=claim,
                content_version="1.0",
                max_current_chunks=2000,
            )
        await holder

        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision == claim.target_revision
            row = await session.get(db_models.IngestionJob, job.job_id)
            assert row is not None
            assert row.status == JOB_STATUS_READY

    _scenario(body)


def test_the_document_lock_wait_tests_stay_in_place() -> None:
    """The advisory-lock and job-row waits keep their own coverage."""

    async def body(engine: AsyncEngine, factory: async_sessionmaker[AsyncSession]) -> None:
        job, claim = await _claimed(factory)
        await _set_lease_expiry(factory, job.job_id, in_seconds=0.3)

        async with factory() as session:
            await store.write_revision(session, claim=claim, content=_empty_content(claim))

        # Advisory lock: the wait happens before the job row is locked.
        holder = asyncio.create_task(_hold_publisher_lock_for(factory, 1.0))
        await asyncio.sleep(0.1)
        with pytest.raises(LeaseLostError):
            async with factory() as session:
                await store.activate_revision(
                    session,
                    claim=claim,
                    content_version="1.0",
                    max_current_chunks=2000,
                )
        await holder

        # Job row lock: the wait happens on the ownership read itself.
        await _set_lease_expiry(factory, job.job_id, in_seconds=0.3)
        holder = asyncio.create_task(_hold_job_row_for(factory, job.job_id, 1.0))
        await asyncio.sleep(0.1)
        with pytest.raises(LeaseLostError):
            async with factory() as session:
                await store.activate_revision(
                    session,
                    claim=claim,
                    content_version="1.0",
                    max_current_chunks=2000,
                )
        await holder

        async with factory() as session:
            document = await session.get(db_models.Document, job.document_id)
            assert document is not None
            assert document.current_revision is None

    _scenario(body)
