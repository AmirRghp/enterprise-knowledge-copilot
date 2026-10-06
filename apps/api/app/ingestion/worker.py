"""The durable ingestion worker: one claimed job, start to finish.

``process_next_job`` is the whole unit of work. It claims a job, reads the staging
text, parses it, chunks it, checks the quota, asks the provider for vectors,
writes the revision, and only then makes it current. Every failure is classified
as permanent or transient so the three-attempt budget is spent only on failures
that might actually clear (ARCHITECTURE.md section 6).

Two properties matter more than speed:

* A job that fails leaves ``documents.current_revision`` untouched, so the
  previously published revision stays searchable.
* A worker that lost its lease writes nothing. The store fences each write on the
  fencing token, so a slow worker cannot overwrite the work of the one that
  replaced it.
"""

import asyncio
import contextlib
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.documents.chunking import (
    MAX_CHARS,
    MAX_TOKENS,
    OVERLAP_CHARS,
    ChunkingError,
    ChunkRecord,
    chunk_sections,
)
from app.documents.parse import DocumentParseError, ParsedSection, parse_document
from app.documents.tokenizer import TokenCounter, TokenizerUnavailableError
from app.ingestion import store
from app.ingestion.contracts import (
    JOB_STATUS_FAILED,
    JOB_STATUS_INDEXING,
    JOB_STATUS_PENDING,
    JOB_STATUS_READY,
    PermanentIngestionError,
    TransientIngestionError,
)
from app.ingestion.store import (
    ClaimedJob,
    LeaseLostError,
    QuotaExceededError,
    RevisionContent,
    StagedChunk,
    StagedSection,
    StaleRevisionError,
)
from app.providers.base import (
    EmbeddingModelChangedError,
    EmbeddingProvider,
    EmbeddingProviderError,
    EmbeddingValidationError,
)
from app.providers.retry import RetryableError

# Safe codes written to ingestion_jobs.safe_error and shown to a manager. They
# name the class of failure and never describe the document, its text, or a
# provider response body.
PARSE_FAILED = "document could not be parsed"
CHUNKING_FAILED = "document could not be chunked"
QUOTA_EXCEEDED = "current chunk quota exceeded"
PROVIDER_UNREACHABLE = "embedding provider unavailable"
PROVIDER_REFUSED = "embedding provider refused the request"
VECTOR_REJECTED = "embedding vector rejected"
MODEL_CHANGED = "embedding model digest changed"
TOKENIZER_UNAVAILABLE = "tokenizer unavailable"
ACTIVATION_REJECTED = "activation rejected; current revision changed"
LEASE_LOST = "lease lost to another worker"

# How many chunks are sent to the provider in one call. Bounded so a large
# document cannot build a single unbounded request, and so the lease renewer gets
# a turn between batches.
EMBED_BATCH_SIZE = 16

# Terminal dispositions reported by JobOutcome.
OUTCOME_READY = "ready"
OUTCOME_FAILED = "failed"
OUTCOME_RETRY = "retry"
OUTCOME_ABANDONED = "abandoned"


class VectorProvider(EmbeddingProvider, Protocol):
    """An embedding provider that also reports its own identity.

    The identity travels into every chunk row so a later query can fail closed on
    a mixed or stale index (DATABASE.md section 5). It is a separate protocol
    rather than extra members on ``EmbeddingProvider`` because retrieval only
    needs the two embedding calls.
    """

    @property
    def provider_name(self) -> str:
        """The provider label persisted alongside each vector."""
        ...

    @property
    def model(self) -> str:
        """The model tag persisted alongside each vector."""
        ...

    @property
    def dimension(self) -> int:
        """The vector dimension persisted alongside each vector."""
        ...

    @property
    def last_digest(self) -> str | None:
        """The digest verified by the most recent embed, or ``None`` before it."""
        ...


def _require_vector_provider(provider: VectorProvider) -> VectorProvider:
    """Return ``provider`` typed as the protocol.

    The return type makes mypy verify structurally that the adapter still
    satisfies what ingestion persists, so a rename cannot silently drop the
    provenance columns.
    """
    return provider


@dataclass(frozen=True)
class JobOutcome:
    """What happened to one claimed job, for the CLI log and for tests."""

    job_id: uuid.UUID
    document_id: str
    revision: str
    attempt: int
    status: str
    safe_error: str | None
    #: ``retry`` means the job went back to the queue; ``abandoned`` means this
    #: worker no longer owned it and deliberately wrote nothing.
    outcome: str


class IngestionWorker:
    """Runs jobs one at a time against a durable queue.

    The session factory, provider, and token counter are injected, so a test
    drives the whole flow with a deterministic fake and no network. Each phase
    opens its own session, which keeps the fencing transactions independent
    instead of nesting them inside one long-lived transaction.
    """

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        provider: VectorProvider,
        worker_id: str,
        lease_seconds: int = 120,
        # A float so a test can renew faster than a second and observe it; the
        # configured value stays an integer number of seconds.
        renew_seconds: float = 30.0,
        max_attempts: int = 3,
        max_current_chunks: int = 2000,
        max_chars: int = MAX_CHARS,
        max_tokens: int = MAX_TOKENS,
        overlap: int = OVERLAP_CHARS,
        counter: TokenCounter | None = None,
    ) -> None:
        if lease_seconds <= 0 or max_attempts <= 0:
            raise ValueError("lease and attempt budget must be positive")
        if renew_seconds >= lease_seconds:
            # A renewal that cannot land inside the lease would let a healthy
            # worker lose its claim while it is still writing.
            raise ValueError("the renew interval must be shorter than the lease")
        self._factory = session_factory
        self._provider = _require_vector_provider(provider)
        self._worker_id = worker_id
        self._lease_seconds = lease_seconds
        self._renew_seconds = renew_seconds
        self._max_attempts = max_attempts
        self._max_current_chunks = max_current_chunks
        self._max_chars = max_chars
        self._max_tokens = max_tokens
        self._overlap = overlap
        self._counter = counter

    async def process_next_job(self) -> JobOutcome | None:
        """Claim and process one job, or return ``None`` when the queue is empty."""
        async with self._factory() as session:
            claim = await store.claim_next_job(
                session,
                worker_id=self._worker_id,
                lease_seconds=self._lease_seconds,
                max_attempts=self._max_attempts,
            )
        if claim is None:
            return None

        renewer = asyncio.create_task(self._renew_lease(claim))
        try:
            return await self._run(claim)
        finally:
            # The lease is released by the terminal transition itself, so renewal
            # must stop before the outcome is returned.
            renewer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await renewer

    async def _renew_lease(self, claim: ClaimedJob) -> None:
        """Extend this worker's lease every ``renew_seconds`` until cancelled.

        Losing the lease simply ends this task. The worker finds out at its next
        fenced write, which is the only place it actually matters.
        """
        while True:
            await asyncio.sleep(self._renew_seconds)
            try:
                async with self._factory() as session:
                    renewed = await store.renew_lease(
                        session,
                        job_id=claim.job_id,
                        lease_token=claim.lease_token,
                        lease_seconds=self._lease_seconds,
                    )
            except Exception:
                # Losing the database is not this task's error to report; the
                # fenced write that follows will fail loudly if it matters.
                return
            if not renewed:
                return

    async def _run(self, claim: ClaimedJob) -> JobOutcome:
        """Execute the pipeline for one claimed job."""
        try:
            content, content_version = await self._build(claim)
        except TransientIngestionError as error:
            await self._release(claim)
            return self._outcome(claim, JOB_STATUS_PENDING, error.safe_code, outcome=OUTCOME_RETRY)
        except PermanentIngestionError as error:
            await self._discard_and_fail(claim, error.safe_code)
            return self._outcome(claim, JOB_STATUS_FAILED, error.safe_code, outcome=OUTCOME_FAILED)

        try:
            async with self._factory() as session:
                await store.write_revision(session, claim=claim, content=content)
        except LeaseLostError:
            return self._abandoned(claim)

        try:
            async with self._factory() as session:
                await store.activate_revision(
                    session,
                    claim=claim,
                    content_version=content_version,
                    max_current_chunks=self._max_current_chunks,
                )
        except LeaseLostError:
            return self._abandoned(claim)
        except QuotaExceededError:
            # Another publisher took the last room between the early check and this
            # commit. The activation rolled back, so the previously published
            # revision still serves users; discard this one and fail the job.
            await self._discard_and_fail(claim, QUOTA_EXCEEDED)
            return self._outcome(claim, JOB_STATUS_FAILED, QUOTA_EXCEEDED, outcome=OUTCOME_FAILED)
        except StaleRevisionError:
            # Another revision became current while this one was being built, so
            # this revision must not be published. current_revision is untouched,
            # which means the version already live keeps serving users.
            await self._discard_and_fail(claim, ACTIVATION_REJECTED)
            return self._outcome(
                claim,
                JOB_STATUS_FAILED,
                ACTIVATION_REJECTED,
                outcome=OUTCOME_FAILED,
            )

        return self._outcome(claim, JOB_STATUS_READY, None, outcome=OUTCOME_READY)

    async def _build(self, claim: ClaimedJob) -> tuple[RevisionContent, str]:
        """Parse, chunk, quota-check, and embed; return the rows to stage."""
        async with self._factory() as session:
            source_text = await store.read_staging_text(
                session, job_id=claim.job_id, lease_token=claim.lease_token
            )
        if source_text is None:
            # The lease is already gone, so nothing downstream may write.
            raise TransientIngestionError(LEASE_LOST)

        try:
            parsed = parse_document(source_text)
        except DocumentParseError as error:
            raise PermanentIngestionError(PARSE_FAILED) from error

        try:
            records = chunk_sections(
                parsed,
                document_id=claim.document_id,
                revision=claim.target_revision,
                access_role=claim.access_role,
                max_chars=self._max_chars,
                max_tokens=self._max_tokens,
                overlap=self._overlap,
                counter=self._counter,
            )
        except TokenizerUnavailableError as error:
            raise TransientIngestionError(TOKENIZER_UNAVAILABLE) from error
        except ChunkingError as error:
            raise PermanentIngestionError(CHUNKING_FAILED) from error

        await self._enforce_chunk_quota(claim, len(records))

        vectors = await self._embed_batches([record.text for record in records])
        return self._content(claim, parsed.sections, records, vectors), parsed.version

    async def _enforce_chunk_quota(self, claim: ClaimedJob, added: int) -> None:
        """Reject the job early when the chunk quota already looks full.

        This runs after chunking, because only then is the chunk count known, and
        before the provider call, so no embedding is paid for a document that will
        be discarded (SECURITY.md section 8).

        It is deliberately not authoritative. Two jobs can both read the same
        current count here and both proceed; the binding check is the reservation
        inside ``activate_revision``, which runs under the publisher lock.
        """
        async with self._factory() as session:
            current = await store.count_current_chunks(session)
            superseded = await store.count_chunks_of_revision(
                session,
                document_id=claim.document_id,
                revision=claim.expected_current_revision,
            )
        if current - superseded + added > self._max_current_chunks:
            raise PermanentIngestionError(QUOTA_EXCEEDED)

    async def _embed_batches(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed in bounded batches, classifying provider failures as they come."""
        vectors: list[list[float]] = []
        for start in range(0, len(texts), EMBED_BATCH_SIZE):
            batch = list(texts[start : start + EMBED_BATCH_SIZE])
            try:
                vectors.extend(await self._provider.embed_documents(batch))
            except RetryableError as error:
                raise TransientIngestionError(PROVIDER_UNREACHABLE) from error
            except EmbeddingValidationError as error:
                raise PermanentIngestionError(VECTOR_REJECTED) from error
            except EmbeddingModelChangedError as error:
                raise PermanentIngestionError(MODEL_CHANGED) from error
            except EmbeddingProviderError as error:
                raise PermanentIngestionError(PROVIDER_REFUSED) from error

        if len(vectors) != len(texts):
            # A provider that dropped or added rows would misalign vectors with
            # their chunks, so the result is refused rather than stored.
            raise PermanentIngestionError(VECTOR_REJECTED)
        return vectors

    def _content(
        self,
        claim: ClaimedJob,
        sections: Sequence[ParsedSection],
        records: Sequence[ChunkRecord],
        vectors: Sequence[list[float]],
    ) -> RevisionContent:
        """Pair each chunk with its vector and identity, and build the section rows."""
        digest = self._provider.last_digest
        if digest is None:
            # No embed has verified a digest yet, so the provenance columns would
            # be blank and the index could not be checked later.
            raise PermanentIngestionError(MODEL_CHANGED)

        staged_sections = [
            StagedSection(
                section_id=section.section_id,
                ordinal=section.ordinal,
                title=section.title,
                heading_path=section.heading_path,
                source_text=section.text,
                search_text=section.search_text,
            )
            for section in sections
        ]

        staged_chunks: list[StagedChunk] = []
        for record, vector in zip(records, vectors, strict=True):
            if len(vector) != self._provider.dimension:
                raise PermanentIngestionError(VECTOR_REJECTED)
            staged_chunks.append(
                StagedChunk(
                    section_id=record.section_id,
                    ordinal=record.ordinal,
                    chunk_text=record.text,
                    search_text=record.search_text,
                    embedding=list(vector),
                    provider=self._provider.provider_name,
                    model=self._provider.model,
                    digest=digest,
                    dimension=self._provider.dimension,
                )
            )
        return RevisionContent(sections=staged_sections, chunks=staged_chunks)

    async def _release(self, claim: ClaimedJob) -> None:
        """Return a transiently failed job to the queue, keeping its attempt count."""
        async with self._factory() as session:
            with contextlib.suppress(LeaseLostError):
                await store.release_for_retry(
                    session, job_id=claim.job_id, lease_token=claim.lease_token
                )

    async def _discard_and_fail(self, claim: ClaimedJob, safe_error: str) -> None:
        """Drop any staged rows and mark the job permanently failed.

        The staged revision is removed so a half-written revision does not occupy
        the tables. ``current_revision`` is never touched, so the previously
        published revision stays searchable.
        """
        async with self._factory() as session:
            with contextlib.suppress(LeaseLostError):
                await store.discard_staged_revision(session, claim=claim)
        async with self._factory() as session:
            with contextlib.suppress(LeaseLostError):
                await store.fail_job(
                    session,
                    job_id=claim.job_id,
                    lease_token=claim.lease_token,
                    safe_error=safe_error,
                )

    def _abandoned(self, claim: ClaimedJob) -> JobOutcome:
        """Report a job this worker no longer owns, having written nothing."""
        return self._outcome(claim, JOB_STATUS_INDEXING, LEASE_LOST, outcome=OUTCOME_ABANDONED)

    def _outcome(
        self, claim: ClaimedJob, status: str, safe_error: str | None, *, outcome: str
    ) -> JobOutcome:
        return JobOutcome(
            job_id=claim.job_id,
            document_id=claim.document_id,
            revision=claim.target_revision,
            attempt=claim.attempt,
            status=status,
            safe_error=safe_error,
            outcome=outcome,
        )
