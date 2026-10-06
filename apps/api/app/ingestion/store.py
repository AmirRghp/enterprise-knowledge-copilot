"""Database operations for the ingestion queue and document lifecycle.

Every function here takes an ``AsyncSession`` from the caller and does its own
transaction boundary, so the lease, the staged rows, and the activation can each
be proven atomic. CODE_STYLE.md section 4 keeps this module free of FastAPI and
of any provider type: the worker and the manager routes both go through it.

Two invariants shape the code:

* **The lease fences writers.** Every write that stages content or activates a
  revision re-reads the job row ``FOR UPDATE`` and compares the fencing token it
  was handed. A worker whose lease expired while it was blocked therefore cannot
  land data, even if another worker already reclaimed the job.
* **Nothing is searchable until activation.** ``documents.current_revision`` is
  the only pointer retrieval will follow, and it is moved in one transaction that
  also flips the job to ``ready``.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.db.models import Chunk, Document, IngestionJob, Section
from app.domain.models import Actor
from app.ingestion.contracts import (
    JOB_STATUS_FAILED,
    JOB_STATUS_INDEXING,
    JOB_STATUS_PENDING,
    JOB_STATUS_READY,
    OPERATION_CREATE,
    UNPUBLISHED_VERSION,
    DocumentSummary,
    UploadInput,
    UploadRejectedError,
)
from app.ingestion.contracts import (
    IngestionJob as IngestionJobView,
)

# A transaction-scoped advisory lock serialises staging so the active-document
# quota is exact under concurrent uploads instead of merely advisory.
STAGING_LOCK_KEY = 8_675_309

# Written to safe_error when a job exhausts its attempts. It names the class of
# failure without describing the document.
RETRY_BUDGET_EXHAUSTED = "retry budget exhausted"


@dataclass(frozen=True)
class ClaimedJob:
    """A job this worker now owns, together with its fencing token."""

    job_id: uuid.UUID
    document_id: str
    target_revision: str
    attempt: int
    lease_token: uuid.UUID
    lease_expires_at: datetime
    #: The manager-reviewed access policy. It comes from the documents row read
    #: in the same locking statement as the job, so it cannot change between the
    #: claim and the write, and the file's own front-matter claim is never here.
    access_role: str
    #: The revision that must still be current when this job activates.
    expected_current_revision: str | None


class StaleRevisionError(RuntimeError):
    """The document's current revision moved after this job was staged."""


class QuotaExceededError(RuntimeError):
    """Publishing this revision would push current chunks over the ceiling.

    Raised inside the activation transaction, so the rejection rolls the whole
    transaction back and the previously published revision stays in place.
    """


class LeaseLostError(RuntimeError):
    """This worker no longer holds the lease, so it must not write anything."""


def _now() -> datetime:
    return datetime.now(UTC)


def _owned_by(job_id: uuid.UUID, lease_token: uuid.UUID) -> ColumnElement[bool]:
    """Return the predicate that proves this worker still owns the job.

    All three conditions are required:

    * ``status = 'indexing'`` - the job was actually claimed.
    * ``lease_token`` matches - no newer claim has replaced this one.
    * ``lease_expires_at > clock_timestamp()`` - the claim has not run out.

    Two details make the time comparison mean what it looks like.

    The clock is the *database* clock, so a host with a skewed clock cannot widen
    its own lease, and it is read live rather than from the application.

    It is ``clock_timestamp()`` and not ``now()``. ``now()`` is frozen at the start
    of the transaction, so a transaction that begins, then blocks on a lock until
    after the lease has expired, would compare the expiry against its own stale
    start time and wrongly conclude the lease is still live (Part 8 review, P1).

    Even so, this predicate is evaluated when a statement begins, which for a
    blocking row lock is *before* the wait ends. :func:`_lock_owned_job` therefore
    re-checks against a freshly read clock once the lock is held; this predicate is
    the fast filter that finds the row, not the last word.
    """
    return and_(
        IngestionJob.job_id == job_id,
        IngestionJob.status == JOB_STATUS_INDEXING,
        IngestionJob.lease_token == lease_token,
        IngestionJob.lease_expires_at > func.clock_timestamp(),
    )


async def _require_live_lease(session: AsyncSession, job: IngestionJob) -> None:
    """Raise unless the locked job still holds an unexpired lease.

    For use at the end of a sequence of lock waits, once nothing further can block.
    Every lock taken along the way is a chance for the lease to run out while this
    transaction waits, and a statement's own qualification was evaluated before its
    wait. Activation takes three locks - the publisher advisory lock, the job row, and
    the document row - so the expiry has to be re-read once more after the last of
    them, immediately before anything is mutated (Part 8 review, P1).

    The job row is already held ``FOR UPDATE`` by the caller, so its status and token
    cannot have changed underneath us; only the clock moves.
    """
    live_now = await _live_clock(session)
    if job.lease_expires_at is None or job.lease_expires_at <= live_now:
        raise LeaseLostError("the lease expired while waiting on a lock")


async def _live_clock(session: AsyncSession) -> datetime:
    """Return the database's current wall-clock time.

    ``clock_timestamp()`` rather than ``now()``: ``now()`` is frozen at the start of
    the transaction, so it cannot tell us whether a lease is live *now*.
    """
    live: datetime = (await session.execute(select(func.clock_timestamp()))).scalar_one()
    return live


async def _lock_owned_job(
    session: AsyncSession, job_id: uuid.UUID, lease_token: uuid.UUID
) -> IngestionJob | None:
    """Lock the job row and return it only if this worker still owns the job.

    Two steps, because a lock wait can outlast the lease. The locking select finds
    the row and takes the lock, which may block for as long as another transaction
    holds it. Only once the lock is held is the database's live clock read and the
    expiry re-checked, so a lease that expired during the wait is refused. Relying on
    the statement's own predicate would evaluate it before the wait
    (Part 8 review, P1).

    Another worker reclaiming the job either committed before this lock - in which
    case the token no longer matches - or it waits for this transaction to finish.
    """
    job = (
        await session.execute(
            select(IngestionJob).where(_owned_by(job_id, lease_token)).with_for_update()
        )
    ).scalar_one_or_none()
    if job is None:
        return None

    live_now = await _live_clock(session)
    if job.lease_expires_at is None or job.lease_expires_at <= live_now:
        return None
    return job


async def count_active_documents(session: AsyncSession) -> int:
    """Return the number of active documents, which the upload quota bounds."""
    result = await session.execute(
        select(func.count()).select_from(Document).where(Document.status == "active")
    )
    return int(result.scalar_one())


async def count_current_chunks(session: AsyncSession) -> int:
    """Return the number of chunks that belong to a current revision.

    Staging rows and rows of a superseded revision are excluded, so the quota
    measures what is actually searchable.
    """
    result = await session.execute(
        select(func.count())
        .select_from(Chunk)
        .join(Document, Document.document_id == Chunk.document_id)
        .where(
            Chunk.revision == Document.current_revision,
            Document.status == "active",
        )
    )
    return int(result.scalar_one())


async def read_staging_text(
    session: AsyncSession, *, job_id: uuid.UUID, lease_token: uuid.UUID
) -> str | None:
    """Return the staging text while this worker still holds the lease.

    Ownership is part of the predicate, so a worker that lost its claim - or whose
    lease merely ran out - reads ``None`` instead of the document text and stops
    before doing any work.
    """
    result = await session.execute(
        select(IngestionJob.source_text).where(_owned_by(job_id, lease_token))
    )
    return result.scalar_one_or_none()


async def count_chunks_of_revision(
    session: AsyncSession, *, document_id: str, revision: str | None
) -> int:
    """Return the chunk count of one specific revision of one document.

    The quota check subtracts this from the current total: a replacement that
    succeeds drops the old revision, so counting it would reject a document that
    would actually fit.
    """
    if revision is None:
        return 0
    result = await session.execute(
        select(func.count())
        .select_from(Chunk)
        .where(Chunk.document_id == document_id, Chunk.revision == revision)
    )
    return int(result.scalar_one())


async def _reserve_chunk_quota(
    session: AsyncSession,
    *,
    document_id: str,
    target_revision: str,
    superseded_revision: str | None,
    max_current_chunks: int,
) -> None:
    """Raise unless publishing ``target_revision`` keeps chunks under the ceiling.

    Called with the publisher lock held, so the count it reads cannot change
    between the check and the commit. The revision this job will replace is
    discounted, because a successful replacement drops it from the current set.

    The whole activation transaction unwinds on :class:`QuotaExceededError`, which
    leaves the previously published revision serving users and leaves no partial
    state behind.
    """
    current = await count_current_chunks(session)
    superseded = await count_chunks_of_revision(
        session, document_id=document_id, revision=superseded_revision
    )
    added = await count_chunks_of_revision(
        session, document_id=document_id, revision=target_revision
    )
    if current - superseded + added > max_current_chunks:
        raise QuotaExceededError("publishing this revision would exceed the chunk ceiling")


def add_document_job(
    session: AsyncSession, *, document_id: str, text_body: str, metadata: UploadInput
) -> IngestionJob:
    """Add a create-only document/job pair inside the caller's quota transaction."""
    now = _now()
    session.add(
        Document(
            document_id=document_id,
            title=metadata.normalized_title(),
            content_version=UNPUBLISHED_VERSION,
            access_role=metadata.access_role,
            current_revision=None,
            status="active",
            created_at=now,
            updated_at=now,
        )
    )

    job = IngestionJob(
        job_id=uuid.uuid4(),
        document_id=document_id,
        target_revision=str(uuid.uuid4()),
        operation=OPERATION_CREATE,
        status=JOB_STATUS_PENDING,
        attempt_count=0,
        # SECURITY.md section 8 keeps the staging text in the database so a
        # retry or a post-restart resume does not need the raw file again.
        source_text=text_body,
        expected_current_revision=None,
        lease_owner=None,
        lease_token=None,
        lease_expires_at=None,
        safe_error=None,
        created_at=now,
        started_at=None,
        finished_at=None,
    )
    session.add(job)
    return job


async def stage_upload(
    session: AsyncSession,
    *,
    actor: Actor,
    text_body: str,
    metadata: UploadInput,
    max_active_documents: int,
) -> IngestionJobView:
    """Create the document and its first job in one transaction.

    The document starts with ``current_revision = NULL``, so nothing about it can
    be retrieved until a worker activates a revision. ``content_version`` is the
    documented ``unpublished`` sentinel for that window because the column is NOT
    NULL; the declared version replaces it at activation.

    ``access_role`` is taken from the manager's metadata alone. The document has
    no current revision yet, so setting the policy now cannot expose an older
    version to anyone.
    """
    if actor.role != "manager":
        # Defence in depth: the route already refuses a non-manager, and
        # CODE_STYLE.md section 6 requires the check in the service too.
        raise UploadRejectedError("only a manager may upload a document")

    metadata.normalized_title()

    async with session.begin():
        # Quota and insert must be serialised, or two concurrent uploads would
        # both observe room for the last slot.
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": STAGING_LOCK_KEY})
        if await count_active_documents(session) >= max_active_documents:
            raise UploadRejectedError("active document limit reached")

        job = add_document_job(
            session, document_id=str(uuid.uuid4()), text_body=text_body, metadata=metadata
        )

    return IngestionJobView(
        job_id=job.job_id,
        document_id=job.document_id,
        revision=job.target_revision,
        status=job.status,
        attempt=job.attempt_count,
        safe_error=job.safe_error,
        created_at=job.created_at,
        finished_at=job.finished_at,
    )


async def list_documents(session: AsyncSession, *, actor: Actor) -> list[DocumentSummary]:
    """Return every document with the state of its most recent job.

    The job status arrives as a correlated scalar subquery rather than a join, so
    the result is exactly one row per document by construction. A lateral join was
    tried first and returned duplicate rows for documents with more than one job.
    ``content_status`` and ``processing_status`` stay separate so an unprocessed
    document is never presented as content.
    """
    if actor.role != "manager":
        raise UploadRejectedError("only a manager may list processing state")

    latest_job_status = (
        select(IngestionJob.status)
        .where(IngestionJob.document_id == Document.document_id)
        .order_by(IngestionJob.created_at.desc(), IngestionJob.job_id.desc())
        .limit(1)
        .correlate(Document)
        .scalar_subquery()
    )

    latest_job_id = (
        select(IngestionJob.job_id)
        .where(IngestionJob.document_id == Document.document_id)
        .order_by(IngestionJob.created_at.desc(), IngestionJob.job_id.desc())
        .limit(1)
        .correlate(Document)
        .scalar_subquery()
    )
    latest_safe_error = (
        select(IngestionJob.safe_error)
        .where(IngestionJob.document_id == Document.document_id)
        .order_by(IngestionJob.created_at.desc(), IngestionJob.job_id.desc())
        .limit(1)
        .correlate(Document)
        .scalar_subquery()
    )

    statement = (
        select(
            Document.document_id,
            Document.title,
            Document.access_role,
            Document.content_version,
            Document.status,
            Document.updated_at,
            latest_job_status.label("processing_status"),
            latest_job_id.label("job_id"),
            latest_safe_error.label("safe_error"),
        )
        .select_from(Document)
        .order_by(Document.created_at)
    )
    rows = (await session.execute(statement)).all()
    return [
        DocumentSummary(
            document_id=row[0],
            title=row[1],
            access_role=row[2],
            version=row[3],
            content_status=row[4],
            # A document whose job row is absent has never been processed.
            processing_status=row[6] or JOB_STATUS_PENDING,
            updated_at=row[5],
            job_id=row[7],
            safe_error=row[8],
        )
        for row in rows
    ]


async def read_job(
    session: AsyncSession, *, actor: Actor, job_id: uuid.UUID
) -> IngestionJobView | None:
    """Return one job's non-sensitive processing state."""
    if actor.role != "manager":
        raise UploadRejectedError("only a manager may read a job")

    job = await session.get(IngestionJob, job_id)
    if job is None:
        return None
    return IngestionJobView(
        job_id=job.job_id,
        document_id=job.document_id,
        revision=job.target_revision,
        status=job.status,
        attempt=job.attempt_count,
        safe_error=job.safe_error,
        created_at=job.created_at,
        finished_at=job.finished_at,
    )


async def _candidate_job(
    session: AsyncSession,
) -> tuple[IngestionJob, str] | None:
    """Return the next claimable job and its access policy.

    A job is claimable when it is ``pending``, or when it is ``indexing`` with an
    expired lease - that second case is how a worker recovers a job after a crash
    or a restart. ``SKIP LOCKED`` lets several workers claim different jobs
    instead of serialising on the head of the queue.
    """
    statement = (
        select(IngestionJob, Document.access_role)
        .join(Document, Document.document_id == IngestionJob.document_id)
        .where(
            (IngestionJob.status == JOB_STATUS_PENDING)
            | (
                (IngestionJob.status == JOB_STATUS_INDEXING)
                & (IngestionJob.lease_expires_at <= func.clock_timestamp())
            )
        )
        .order_by(IngestionJob.created_at)
        # Only the job row is locked. Leaving the documents row unlocked keeps a
        # claim from blocking unrelated document writes, and correctness does not
        # depend on it: two jobs for the same document may then be processed
        # concurrently, and the compare-and-swap in ``activate_revision`` decides
        # which one becomes current.
        .with_for_update(skip_locked=True, of=IngestionJob)
        .limit(1)
    )
    row = (await session.execute(statement)).one_or_none()
    return row


async def claim_next_job(
    session: AsyncSession,
    *,
    worker_id: str,
    lease_seconds: int,
    max_attempts: int,
) -> ClaimedJob | None:
    """Take ownership of one job, or return ``None`` when the queue is empty.

    Each claim and each reclaim mints a fresh ``lease_token``. That token is the
    fencing value every later write must present, so a worker that was paused past
    its lease cannot corrupt the work of the worker that replaced it.
    """
    async with session.begin():
        # A job that exhausted its attempts is made terminal instead of being
        # reclaimed forever, so the loop moves on to real work.
        for _ in range(50):
            candidate = await _candidate_job(session)
            if candidate is None:
                return None
            job, access_role = candidate

            if job.attempt_count >= max_attempts:
                job.status = JOB_STATUS_FAILED
                job.safe_error = RETRY_BUDGET_EXHAUSTED
                job.lease_owner = None
                job.lease_token = None
                job.lease_expires_at = None
                job.finished_at = _now()
                await session.flush()
                continue

            token = uuid.uuid4()
            expires_at = _now() + timedelta(seconds=lease_seconds)
            job.status = JOB_STATUS_INDEXING
            job.attempt_count = job.attempt_count + 1
            job.lease_owner = worker_id
            job.lease_token = token
            job.lease_expires_at = expires_at
            job.started_at = job.started_at or _now()
            job.safe_error = None
            await session.flush()

            return ClaimedJob(
                job_id=job.job_id,
                document_id=job.document_id,
                target_revision=job.target_revision,
                attempt=job.attempt_count,
                lease_token=token,
                lease_expires_at=expires_at,
                access_role=access_role,
                expected_current_revision=job.expected_current_revision,
            )
    return None


async def renew_lease(
    session: AsyncSession,
    *,
    job_id: uuid.UUID,
    lease_token: uuid.UUID,
    lease_seconds: int,
) -> bool:
    """Extend this worker's lease, or return ``False`` when the lease is gone.

    ``False`` means the worker should abandon the job rather than write under a
    claim another worker now owns.

    This locks the row and re-checks the expiry against a live clock rather than
    issuing one ``UPDATE ... WHERE``. A statement's qualification is evaluated when
    the statement begins, which for a row lock is *before* the wait, so an
    ``UPDATE`` alone would happily extend a lease that expired while it was queued -
    waking a stalled worker back up with a claim nobody else was allowed to take.
    :func:`_lock_owned_job` performs the post-wait check, and the row is already
    locked when the new expiry is written, so nothing can change underneath it.
    """
    async with session.begin():
        job = await _lock_owned_job(session, job_id, lease_token)
        if job is None:
            return False
        job.lease_expires_at = await _live_clock(session) + timedelta(seconds=lease_seconds)
        return True


async def _delete_revision_rows(session: AsyncSession, document_id: str, revision: str) -> None:
    """Remove any rows already staged for ``revision``.

    A crashed attempt can leave partial rows behind. Clearing them keeps the
    write idempotent, because ``(document_id, target_revision)`` is unique and a
    retry must not collide with its own earlier partial write.
    """
    await session.execute(
        delete(Chunk).where(Chunk.document_id == document_id, Chunk.revision == revision)
    )
    await session.execute(
        delete(Section).where(Section.document_id == document_id, Section.revision == revision)
    )


@dataclass(frozen=True)
class StagedSection:
    """One citable section of a staged revision."""

    section_id: str
    ordinal: int
    title: str
    heading_path: tuple[str, ...]
    source_text: str
    search_text: str


@dataclass(frozen=True)
class StagedChunk:
    """One retrieval unit of a staged revision, with the vector it must keep.

    The provider label, model tag, digest, and dimension travel with the vector so
    DATABASE.md section 5 can fail closed on a mixed or stale index later.
    """

    section_id: str
    ordinal: int
    chunk_text: str
    search_text: str
    embedding: list[float]
    provider: str
    model: str
    digest: str
    dimension: int


@dataclass(frozen=True)
class RevisionContent:
    """The staged rows for one revision, ready to be written."""

    sections: Sequence[StagedSection]
    chunks: Sequence[StagedChunk]


async def write_revision(
    session: AsyncSession,
    *,
    claim: ClaimedJob,
    content: RevisionContent,
) -> None:
    """Write one revision's sections and chunks while still holding the lease.

    The job row is re-read ``FOR UPDATE`` inside the same transaction and the
    fencing token compared, so a reclaimed lease stops the write. Losing that race
    raises :class:`LeaseLostError` and nothing is committed.
    """
    async with session.begin():
        job = await _lock_owned_job(session, claim.job_id, claim.lease_token)
        if job is None:
            raise LeaseLostError("this worker no longer holds a live lease on the job")

        await _delete_revision_rows(session, claim.document_id, claim.target_revision)

        now = _now()
        for section in content.sections:
            session.add(
                Section(
                    document_id=claim.document_id,
                    revision=claim.target_revision,
                    section_id=section.section_id,
                    ordinal=section.ordinal,
                    title=section.title,
                    heading_path=list(section.heading_path),
                    source_text=section.source_text,
                    search_text=section.search_text,
                )
            )
        await session.flush()

        for chunk in content.chunks:
            session.add(
                Chunk(
                    chunk_id=uuid.uuid4(),
                    document_id=claim.document_id,
                    revision=claim.target_revision,
                    section_id=chunk.section_id,
                    ordinal=chunk.ordinal,
                    chunk_text=chunk.chunk_text,
                    search_text=chunk.search_text,
                    embedding=chunk.embedding,
                    embedding_provider=chunk.provider,
                    embedding_model=chunk.model,
                    embedding_digest=chunk.digest,
                    embedding_dimension=chunk.dimension,
                    created_at=now,
                )
            )


async def activate_revision(
    session: AsyncSession,
    *,
    claim: ClaimedJob,
    content_version: str,
    max_current_chunks: int,
) -> None:
    """Make the staged revision current, in one transaction with the job flip.

    Three guards run here, in order, and each is decided under the same
    transaction-scoped advisory lock that every publisher takes, so concurrent
    activations of different documents serialise against each other:

    1. the caller still holds a live lease, proven by the locked ownership read;
    2. the compare-and-swap on ``expected_current_revision``, which stops two
       replacements of one document from both succeeding - the loser sees a moved
       pointer and aborts, leaving the winner's revision in place;
    3. the final chunk-quota reservation. The worker's earlier check exists only to
       avoid paying for embeddings that will be discarded; it is not authoritative,
       because two jobs can read the same count before either publishes. This check
       is authoritative, and raising it rolls back the whole transaction.

    Clearing the lease columns is not cosmetic; the ``ingestion_jobs`` CHECK
    constraint requires all three to be NULL outside ``indexing``.
    """
    async with session.begin():
        # Serialises every activation and every upload, so the quota below is a
        # real reservation rather than another racing read.
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": STAGING_LOCK_KEY})

        job = await _lock_owned_job(session, claim.job_id, claim.lease_token)
        if job is None:
            raise LeaseLostError("this worker no longer holds a live lease on the job")

        document = (
            await session.execute(
                select(Document).where(Document.document_id == claim.document_id).with_for_update()
            )
        ).scalar_one_or_none()
        if document is None:
            raise LeaseLostError("the document no longer exists")
        if document.current_revision != job.expected_current_revision:
            raise StaleRevisionError("the current revision changed during processing")

        await _reserve_chunk_quota(
            session,
            document_id=claim.document_id,
            target_revision=claim.target_revision,
            superseded_revision=job.expected_current_revision,
            max_current_chunks=max_current_chunks,
        )

        # The last thing before mutating anything, and now that no lock remains to
        # wait on: re-read the live clock and refuse an expired lease. Raising here
        # unwinds the whole transaction, so the document keeps its old revision and
        # the job is not marked ready.
        await _require_live_lease(session, job)

        now = _now()
        document.current_revision = claim.target_revision
        document.content_version = content_version
        document.updated_at = now

        job.status = JOB_STATUS_READY
        job.lease_owner = None
        job.lease_token = None
        job.lease_expires_at = None
        job.safe_error = None
        job.finished_at = now


async def fail_job(
    session: AsyncSession,
    *,
    job_id: uuid.UUID,
    lease_token: uuid.UUID,
    safe_error: str,
) -> None:
    """Mark a job permanently failed and release the lease.

    ``current_revision`` is deliberately untouched: a failed replacement must
    leave the previously published revision searchable.
    """
    async with session.begin():
        job = await _lock_owned_job(session, job_id, lease_token)
        if job is None:
            raise LeaseLostError("this worker no longer holds a live lease on the job")
        job.status = JOB_STATUS_FAILED
        job.safe_error = safe_error
        job.lease_owner = None
        job.lease_token = None
        job.lease_expires_at = None
        job.finished_at = _now()


async def release_for_retry(
    session: AsyncSession,
    *,
    job_id: uuid.UUID,
    lease_token: uuid.UUID,
) -> None:
    """Return a transiently failed job to the queue, keeping its attempt count.

    The attempt was already counted at claim time, so a job that keeps failing
    reaches ``ingestion_max_attempts`` and is failed by the next claim rather
    than looping forever.
    """
    async with session.begin():
        job = await _lock_owned_job(session, job_id, lease_token)
        if job is None:
            raise LeaseLostError("this worker no longer holds a live lease on the job")
        job.status = JOB_STATUS_PENDING
        job.lease_owner = None
        job.lease_token = None
        job.lease_expires_at = None


async def discard_staged_revision(
    session: AsyncSession,
    *,
    claim: ClaimedJob,
) -> None:
    """Drop the staged rows of a revision that will not be activated.

    Called when a job fails permanently, so a half-written revision is not left
    occupying the tables. It is fenced on the lease token exactly like the write
    and the activation.
    """
    async with session.begin():
        job = await _lock_owned_job(session, claim.job_id, claim.lease_token)
        if job is None:
            raise LeaseLostError("this worker no longer holds a live lease on the job")
        await _delete_revision_rows(session, claim.document_id, claim.target_revision)
